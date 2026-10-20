/**
 * 打卡地图记录：云端同步（MQTT 独立主题，版本守卫防回退，与 farm/tree 同方案）。
 * 按市 adcode 存记录列表；省的颜色深度 = 该省所有市的记录总数。
 *
 * 照片同步方案（2026-08-04 修复"传3张照片对方就看不见记录"）：
 * 照片本体不再塞进记录状态包，而是每张一条独立的 retained 消息
 * （主题 map/photo/<id>），记录里只存照片 id。状态包保持极小（<50KB），
 * 永远不会触到公共 broker 的单条消息体积上限；照片按需订阅、到一张显示一张。
 * 旧数据里的内联 base64 照片兼容显示，保存/发布超限时自动转成 id 形式。
 */
import { sharedPublish, sharedSubscribe, onSharedConnect, onSharedResync, onSharedStatus } from './mqttClient'
import { isGuestSession } from './guest'
import { provinceOf } from './geo'
import { isPairMember, membersKnown } from './space'

/** 清理混入的外组账号数据：打卡记录只保留当前空间成员创建的 */
function scrubForeign(parsed: Record<string, unknown>): number {
  if (!membersKnown() || !parsed?.places || typeof parsed.places !== 'object') return 0
  let removed = 0
  const places = parsed.places as Record<string, Array<{ by?: string }>>
  for (const city of Object.keys(places)) {
    const list = places[city]
    if (!Array.isArray(list)) continue
    const before = list.length
    places[city] = list.filter((r) => isPairMember(String(r?.by ?? '')))
    removed += before - places[city].length
    if (places[city].length === 0) delete places[city]
  }
  return removed
}

const TOPIC = 'lovesite/map/state'
const PHOTO_PREFIX = 'lovesite/map/photo/'
const LS_KEY = 'lovesite-map-backup'
const MAX_PAYLOAD = 700_000 // retained 消息体积保护（公共 broker 约 1MB 上限）

export type PlaceRecord = {
  id: string
  /** 地点名，如「张三烧烤」 */
  title: string
  /** 评价长文 */
  text: string
  /** 照片 id 列表（≤3 张）；旧数据可能是内联 dataURL，兼容显示 */
  photos: string[]
  /** 游玩日期 YYYY-MM-DD（补记时可改，默认当天） */
  visitDate?: string
  by: string
  updatedAt: number
}

type State = { places: Record<string, PlaceRecord[]>; deleted?: Record<string, number>; v: number }

let initialized = false
let places: Record<string, PlaceRecord[]> = {}
/** 删除墓碑：记录 id -> 删除时间，防止合并时旧云端状态复活已删记录 */
let deleted: Record<string, number> = {}
let stateReceived = false
let cloudReady = false
let lastV = 0
let subscribers: Array<(p: Record<string, PlaceRecord[]>) => void> = []
let errorListeners: Array<(msg: string) => void> = []

/* ---------- 照片独立通道：每张一条 retained 消息，记录里只存 id ---------- */
const photoCache = new Map<string, string>() // photoId -> dataURL
const photoPending = new Set<string>() // 已发起订阅、还没拿到的 id
const NEED_TOPIC = 'lovesite/map/need' // 照片求援频道
const REPUSH_KEY = 'lovesite-photo-repush' // 上次全量回补日期（localStorage）

/** 把一张照片发布为独立 retained 消息，返回照片 id */
function storePhoto(dataUrl: string): string {
  const id = `ph${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  photoCache.set(id, dataUrl)
  void idbPut(id, dataUrl) // 自己传的也持久化，本机秒开
  sharedPublish(PHOTO_PREFIX + id, dataUrl)
  return id
}

/* ---------- 照片本地持久缓存（IndexedDB）：看过一次就永久秒开，只有新照片才下载 ---------- */
const IDB_NAME = 'lovesite-photos'
const IDB_STORE = 'photos'
let idbPromise: Promise<IDBDatabase | null> | null = null

function idb(): Promise<IDBDatabase | null> {
  if (!idbPromise) {
    idbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(IDB_NAME, 1)
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(IDB_STORE)) {
            req.result.createObjectStore(IDB_STORE)
          }
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  }
  return idbPromise
}

async function idbGet(id: string): Promise<string | null> {
  const db = await idb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const rq = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(id)
      rq.onsuccess = () => resolve(typeof rq.result === 'string' ? rq.result : null)
      rq.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function idbPut(id: string, dataUrl: string): Promise<void> {
  const db = await idb()
  if (!db) return
  try {
    db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(dataUrl, id)
  } catch {
    /* ignore */
  }
}

async function idbKeys(): Promise<string[]> {
  const db = await idb()
  if (!db) return []
  return new Promise((resolve) => {
    try {
      const rq = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).getAllKeys()
      rq.onsuccess = () => resolve((rq.result as IDBValidKey[]).map(String))
      rq.onerror = () => resolve([])
    } catch {
      resolve([])
    }
  })
}

/**
 * 照片自愈：公共 broker 的 retained 照片可能被清理（2026-08-05 实际发生）。
 * 每台设备每天首次连接后，把本地相册里的照片全部回补到云端（retained 幂等覆盖）。
 * 任何一台存有照片的设备都能把云救活。
 */
async function republishPhotos(force = false): Promise<void> {
  const today = new Date().toDateString()
  try {
    if (!force && localStorage.getItem(REPUSH_KEY) === today) return
    localStorage.setItem(REPUSH_KEY, today)
  } catch {
    /* ignore */
  }
  const keys = await idbKeys()
  for (const id of keys) {
    const data = photoCache.get(id) ?? (await idbGet(id))
    if (data) {
      photoCache.set(id, data)
      sharedPublish(PHOTO_PREFIX + id, data)
    }
  }
}

/** 求援应答：有人缺某张照片而我本地有，立即补发 */
function answerNeed(id: string): void {
  const cached = photoCache.get(id)
  if (cached) {
    sharedPublish(PHOTO_PREFIX + id, cached)
    return
  }
  void idbGet(id).then((d) => {
    if (d) {
      photoCache.set(id, d)
      sharedPublish(PHOTO_PREFIX + id, d)
    }
  })
}

/** 2026-10-09：求援信号改成非 retained（见 ensurePhoto），但历史上用 retain 发过
 *  的求援 id 还躺在 broker 上——任何新会话订阅都会收到它并触发一次多余的照片补发。
 *  发一条空 retained 把它抹掉，只跑一次 */
function clearLegacyNeedRetained(): void {
  try {
    if (localStorage.getItem('lovesite-need-retained-cleared')) return
    localStorage.setItem('lovesite-need-retained-cleared', '1')
  } catch {
    /* 存不了就每次都发一次空包，代价几十字节 */
  }
  sharedPublish(NEED_TOPIC, '')
}

/** 确保拿到某张照片：内存 → 本地缓存 → 云端订阅（retained），先到先显示；
 *  8 秒还没等到就发求援，持有该照片的设备会立刻补发 */
function ensurePhoto(id: string): void {
  if (photoCache.has(id)) return
  if (photoPending.has(id)) return
  photoPending.add(id)
  // 本地持久缓存命中：秒开，不再走网络
  void idbGet(id).then((cached) => {
    if (cached) {
      photoCache.set(id, cached)
      notify()
      return
    }
    // 本地没有才订阅云端
    sharedSubscribe(PHOTO_PREFIX + id, (payload) => {
      const s = payload.toString()
      if (!s) return
      photoCache.set(id, s)
      void idbPut(id, s) // 拉到的照片持久化，下次打开秒看
      notify() // 照片到了，刷新显示
    })
    // 云端可能已丢失（broker 清 retained）：超时求援，在线的持有者补发。
    // retain=false：求援是瞬时信令，retained 会让它永久留在 broker 上，
    // 新会话每次订阅都收一条旧求援再触发一次照片全量发布（无用数据堆积）
    setTimeout(() => {
      if (!photoCache.has(id)) sharedPublish(NEED_TOPIC, id, false)
    }, 8000)
  })
}

/** 扫描所有记录，把缺失的照片都拉起来 */
function scanPhotos(): void {
  for (const list of Object.values(places)) {
    for (const r of list) {
      for (const p of r.photos) {
        if (!p.startsWith('data:')) ensurePhoto(p)
      }
    }
  }
}

/** 取单张照片的 dataURL（id 或内联旧数据都支持）；没拉到返回 undefined */
export function photoUrl(p: string): string | undefined {
  if (p.startsWith('data:')) return p
  return photoCache.get(p)
}

/** 解析一条记录当前能显示的照片（没拉到的先不显示，到了自动出现） */
export function resolvePhotos(r: PlaceRecord): string[] {
  const out: string[] = []
  for (const p of r.photos) {
    const u = photoUrl(p)
    if (u) out.push(u)
  }
  return out
}

/** 体积超限自愈：把内联 base64 照片全部转成独立 retained 消息，状态包只留 id */
function slimInlinePhotos(): void {
  for (const city of Object.keys(places)) {
    places[city] = places[city].map((r) =>
      r.photos.some((p) => p.startsWith('data:'))
        ? { ...r, photos: r.photos.map((p) => (p.startsWith('data:') ? storePhoto(p) : p)) }
        : r,
    )
  }
}

function loadBackup(): State | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as State
    if (!parsed.places || typeof parsed.places !== 'object') return null
    scrubForeign(parsed as unknown as Record<string, unknown>) // 本地备份也清掉外组数据
    return { places: parsed.places, deleted: parsed.deleted ?? {}, v: parsed.v ?? 0 }
  } catch {
    return null
  }
}

function saveBackup() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ places, deleted, v: lastV }))
  } catch {
    /* ignore */
  }
}

function notify() {
  const snapshot = { ...places }
  subscribers.forEach((cb) => cb(snapshot))
}

function emitError(msg: string) {
  errorListeners.forEach((cb) => cb(msg))
}

/** 按记录 id 合并两地的打卡数据：同 id 取 updatedAt 较新的 */
function mergePlaces(
  local: Record<string, PlaceRecord[]>,
  remote: Record<string, PlaceRecord[]>,
): Record<string, PlaceRecord[]> {
  const out: Record<string, PlaceRecord[]> = {}
  for (const [city, list] of Object.entries(local)) out[city] = [...list]
  for (const [city, list] of Object.entries(remote)) {
    const cur = out[city] ?? []
    for (const rec of list) {
      const idx = cur.findIndex((r) => r.id === rec.id)
      if (idx < 0) cur.push(rec)
      else if (rec.updatedAt > cur[idx].updatedAt) cur[idx] = rec
    }
    out[city] = cur
  }
  return out
}

/** local 是否有 remote 缺的记录（用于判断要不要回发合并结果） */
function hasRecordsNotIn(
  local: Record<string, PlaceRecord[]>,
  remote: Record<string, PlaceRecord[]>,
): boolean {
  for (const [city, list] of Object.entries(local)) {
    const rlist = remote[city] ?? []
    for (const rec of list) {
      if (!rlist.some((r) => r.id === rec.id)) return true
    }
  }
  return false
}

/** 应用删除墓碑：删掉更新时间早于删除时间的记录 */
function applyTombstones() {
  for (const city of Object.keys(places)) {
    places[city] = places[city].filter((r) => (deleted[r.id] ?? 0) < r.updatedAt)
  }
  // 墓碑最多保留 200 条，防膨胀
  const ids = Object.keys(deleted)
  if (ids.length > 200) {
    const sorted = ids.sort((a, b) => deleted[b] - deleted[a])
    deleted = Object.fromEntries(sorted.slice(0, 200).map((id) => [id, deleted[id]]))
  }
}

function ensureClient() {
  if (initialized) return
  initialized = true

  if (!stateReceived && Object.keys(places).length === 0) {
    const backup = loadBackup()
    if (backup) {
      places = backup.places
      deleted = backup.deleted ?? {}
      lastV = backup.v ?? 0
    }
  }

  sharedSubscribe(TOPIC, (payload) => {
    if (payload.length === 0) return
    try {
      const state = JSON.parse(payload.toString()) as State
      if (!state.places || typeof state.places !== 'object') return
      const removedForeign = scrubForeign(state as unknown as Record<string, unknown>) // 外组打卡入口清掉
      stateReceived = true
      cloudReady = true
      const pv = state.v ?? 0
      if (pv <= lastV) {
        // 时钟偏差兜底：旧版本号里若夹着本地没有的打卡记录，照样合并进来
        if (hasRecordsNotIn(state.places, places)) {
          places = mergePlaces(places, state.places)
          for (const [id, ts] of Object.entries(state.deleted ?? {})) {
            if (ts > (deleted[id] ?? 0)) deleted[id] = ts
          }
          applyTombstones()
          saveBackup()
          scanPhotos()
          notify()
        }
        if (removedForeign > 0) publishState() // 回发清理后的状态
        return
      }
      lastV = pv
      // 合并而非覆盖：按记录 id 求并集（更新者优先），防止两人同时编辑互相抹掉
      const merged = mergePlaces(places, state.places)
      const cloudMissing = hasRecordsNotIn(places, state.places)
      places = merged
      // 合并删除墓碑（取较大时间）
      for (const [id, ts] of Object.entries(state.deleted ?? {})) {
        if (ts > (deleted[id] ?? 0)) deleted[id] = ts
      }
      applyTombstones()
      saveBackup()
      scanPhotos()
      notify()
      // 反熵：云端缺我们已有的记录时回发合并结果，双方最终一致；清掉外组数据后也要回发
      if (cloudMissing || removedForeign > 0) publishState()
    } catch {
      /* ignore */
    }
  })

  // 求援应答频道：有人缺照片而我本地有就补发。
  // 必须在模块初始化时订阅一次——旧实现写在 onSharedConnect 里，每次重连都
  // set.add 一个新箭头函数，重连 N 次就有 N 个并联回调，每条求援触发 N×2 次
  // 照片全量发布（全库唯一的 connect 内 subscribe 泄漏点）
  sharedSubscribe(NEED_TOPIC, (payload) => {
    const id = payload.toString()
    if (id) answerNeed(id)
  })
  clearLegacyNeedRetained()

  onSharedConnect(() => {
    setTimeout(() => {
      if (!stateReceived) {
        const backup = loadBackup()
        cloudReady = true
        if (backup && Object.keys(backup.places).length > 0) {
          places = mergePlaces(places, backup.places)
          deleted = { ...deleted, ...(backup.deleted ?? {}) }
          lastV = Math.max(lastV, backup.v ?? 0)
          applyTombstones()
          // 不发布旧备份上云，仅本地展示
        }
        scanPhotos()
        notify()
      }
    }, 3000)
  })

  // 相册回补走门控通道：每天首次连接/掉线超时/切 broker 才跑（函数内还有当日去重）。
  // 50 张照片一次 2~6MB 上行，放进每次重连等于把抖动放大成照片风暴
  onSharedResync(() => {
    setTimeout(() => void republishPhotos(), 2000)
  })

  onSharedStatus((status, msg) => {
    if (status === 'error') emitError(`连接消息服务器失败：${msg}`)
    else if (status === 'offline') emitError('消息服务器连接中断，正在自动重连…')
    else if (status === 'reconnect') emitError('')
  })
}

function publishState(): boolean {
  const v = Date.now()
  let payload = JSON.stringify({ places, deleted, v } satisfies State)
  if (payload.length > MAX_PAYLOAD) {
    // 状态包超限（旧内联照片堆积）：转成照片 id 独立通道后重试
    slimInlinePhotos()
    payload = JSON.stringify({ places, deleted, v } satisfies State)
    if (payload.length > MAX_PAYLOAD) return false
    saveBackup() // 瘦身后的结构也落盘，避免下次重复转换
  }
  lastV = v
  sharedPublish(TOPIC, payload)
  return true
}

export function subscribeMap(
  onData: (p: Record<string, PlaceRecord[]>) => void,
  onError?: (msg: string) => void,
): () => void {
  subscribers.push(onData)
  if (onError) errorListeners.push(onError)
  ensureClient()
  onData({ ...places })
  return () => {
    subscribers = subscribers.filter((cb) => cb !== onData)
    if (onError) errorListeners = errorListeners.filter((cb) => cb !== onError)
  }
}

export const recordsFor = (p: Record<string, PlaceRecord[]>, cityAdcode: number) =>
  p[String(cityAdcode)] ?? []

/** 每个省的记录总数（省地图颜色深度 + 角标数字） */
export function countsByProvince(p: Record<string, PlaceRecord[]>): Record<number, number> {
  const out: Record<number, number> = {}
  for (const [city, list] of Object.entries(p)) {
    const prov = provinceOf(Number(city))
    out[prov] = (out[prov] ?? 0) + list.length
  }
  return out
}

/** 每个市的记录数 */
export function countsByCity(p: Record<string, PlaceRecord[]>): Record<number, number> {
  const out: Record<number, number> = {}
  for (const [city, list] of Object.entries(p)) {
    out[Number(city)] = list.length
  }
  return out
}

export type SaveResult = { ok: boolean; msg: string }

/** 新增或更新一条打卡记录（双方都可编辑） */
export function saveRecord(who: string, cityAdcode: number, record: PlaceRecord): SaveResult {
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' }
  ensureClient()
  if (!cloudReady) return { ok: false, msg: '同步中，请稍后再试' }
  const key = String(cityAdcode)
  const list = [...(places[key] ?? [])]
  const idx = list.findIndex((r) => r.id === record.id)
  // 新上传的 dataURL 照片转成独立 retained 消息，记录里只存 id（旧记录的内联照片保持不变，超限时会统一瘦身）
  const photos = record.photos.map((p) => (p.startsWith('data:') ? storePhoto(p) : p))
  const stamped = { ...record, photos, by: record.by || who, updatedAt: Date.now() }
  if (idx >= 0) list[idx] = stamped
  else list.unshift(stamped)
  places = { ...places, [key]: list }
  if (!publishState()) {
    // 体积超限：回滚
    places = { ...places, [key]: places[key] ?? [] }
    return { ok: false, msg: '数据太大了，请稍后再试' }
  }
  saveBackup()
  scanPhotos()
  notify()
  return { ok: true, msg: idx >= 0 ? '已保存修改' : '打卡成功！' }
}

/** 删除一条记录 */
export function deleteRecord(cityAdcode: number, recordId: string): SaveResult {
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' }
  ensureClient()
  if (!cloudReady) return { ok: false, msg: '同步中，请稍后再试' }
  const key = String(cityAdcode)
  places = { ...places, [key]: (places[key] ?? []).filter((r) => r.id !== recordId) }
  deleted = { ...deleted, [recordId]: Date.now() } // 墓碑：防止旧云端状态把它合并回来
  if (!publishState()) return { ok: false, msg: '同步失败，请稍后再试' }
  saveBackup()
  notify()
  return { ok: true, msg: '已删除' }
}
