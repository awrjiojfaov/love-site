/**
 * 全量数据云同步（通用 KV 镜像层）：任何浏览器登录账号，数据都从云端落回本地。
 *
 * 背景：钱包/农场/爱情树等模块早已各自走 MQTT retained 同步，但剧情工坊存档、
 * AI 生成标记、各模块本地备份等只存在浏览器 localStorage——换浏览器/换手机登录，
 * 这些 key 就是空的，看起来像「数据被初始化了」。
 *
 * 做法：不改动 40 个模块各自的存储逻辑，在 localStorage 外面套一层镜像：
 * - 跟踪范围内每个 key 一条 retained 消息（主题 kv/<base64url(key)>），
 *   单 key 单包，天然避开「全量快照超 broker 1MB 包上限」的问题；
 * - 本地 setItem/removeItem 打补丁，防抖 800ms 增量上云（删除发墓碑 val:null）；
 * - 新浏览器登录：通配订阅 kv/+，retained 消息逐条落回本地，按 ts 新盖旧；
 * - 冲突语义 = 按 key 的 LWW（last-write-wins by ts）。首次扫描给存量 key 盖
 *   「扫描戳」并推迟 10 秒上云：期间若收到云端同 key 旧消息，说明云端是扫描前的
 *   真相，采纳云端（老设备本地过期数据不会顶掉云端）；期间本地有真实写入则以本地
 *   为准。10 秒后无冲突的扫描戳照常上云（老设备一次性迁移）；
 * - 重连回补：连上即重发全部小 key（≤64KB，原 ts 保留），broker 清了 retained 也能自愈；
 * - 恢复写入 localStorage 时置 applyingRemote 守卫，不会回声再发布；
 * - 每恢复一个 key 广播 window 事件 'lovesite-kv-applied'，剧情页等监听后重读。
 *
 * 跟踪范围（之外的一律不同步）：
 * - lovesite-* 全部（space.ts 已按空间命名空间；含各模块备份键）
 * - 剧情工坊个人存档 story-books-<我> / story-plugins-<我> / story-collab
 * 明确排除：
 * - AI 密钥（deepseek/doubao/gemini key、endpoint 等）：按项目铁律只存本机，
 *   上公共 broker 等于把密钥广播给所有订阅者，绝不同步——换浏览器需重新填一次；
 * - lovesite-kv-meta（本模块元数据）、lovesite-binding*（全局绑定信令）、
 *   lovesite-space-id / lovesite-registry-cache（全局键，registry.ts 自己云同步）；
 * - lovesite-*-backup（2026-10-05 起）：各模块本地备份键。这些模块全都有自己的
 *   MQTT 状态主题（wallet/state、jade/state…），同一份数据原先经 kv 镜像被同步
 *   两遍（jade-backup 311KB 与 jade/state 272KB 同时躺在 broker 上），白白占用
 *   broker 内存、每次新会话全量收 retained 还要白下载一遍。备份键的唯一职责是
 *   持有者回补时的本地数据源，不需要跨设备镜像——模块状态主题才是数据源；
 * - IndexedDB（地图照片/玉雕图片缓存）：模块自带云端回补机制，不动。
 */
import { sharedPublish, sharedSubscribe, onSharedConnect, onSharedResync } from './mqttClient'
import { getSpaceId } from './space'

/** 每个 key 一条 retained 消息的主题前缀（经 space.ts resolveTopic 按空间隔离） */
const TOPIC_PREFIX = 'lovesite/kv/'
const TOPIC_WILDCARD = TOPIC_PREFIX + '+'
/** 本地元数据：logicalKey → ts（每个 key 最近一次写入的时间戳，LWW 判据） */
const META_KEY = 'lovesite-kv-meta'
/** 单次写入防抖，避免连续 setItem 刷爆发布 */
const FLUSH_DELAY = 800
/** 扫描戳推迟上云的时间：等云端 retained 到达后再裁决（毫秒） */
const SCAN_PUBLISH_DELAY = 10_000
/** 上云单 key 体积上限（EMQX 公共 broker 单包约 1MB，留余量） */
const MAX_VAL_SIZE = 900_000
/** 重连回补只重发小 key：大 key 基本都是各模块自同步的备份/头像，模块自己有回补机制 */
const CONNECT_REPUBLISH_MAX = 64_000

/** 恢复落地后广播的事件名；detail = { key } */
export const KV_APPLIED_EVENT = 'lovesite-kv-applied'

/* ---------- base64url（key 可能含 CJK/@，进主题前必须编码） ---------- */
function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  bytes.forEach((c) => {
    bin += String.fromCharCode(c)
  })
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/* ---------- 跟踪范围判定 ---------- */
function isTrackedKey(key: string, me: string): boolean {
  if (key.startsWith('lovesite-kv-meta')) return false // 自身元数据
  if (key.startsWith('lovesite-binding')) return false // 全局绑定信令
  if (key === 'lovesite-space-id' || key === 'lovesite-registry-cache') return false // 全局键
  // 模块本地备份键：模块有自己的 MQTT 状态主题，镜像备份 = 同一份数据同步两遍
  if (key.startsWith('lovesite-') && key.endsWith('-backup')) return false
  // 2026-10-10：地图边界缓存（lovesite-geo-v2-<adcode>，单条 25~65KB、实测共约 460KB）。
  // 这是**纯派生数据**——部署站点的 /geo/<adcode>.json 就是同一份，离线时也能按需重下，
  // 每次进地图页只用到 1~2 个城市。把它当用户数据镜像上云有两个害处：
  // ① 新设备首登要额外下载 460KB，直接排在关键状态消息前面，让它们在 3.9 秒后才到；
  // ② broker retained 白占体积。地图模块自带 localStorage 缓存 + 站点回退，
  // 不需要跨设备镜像（换设备后进地图页首帧会重新下载一次，属可接受代价）
  if (key.startsWith('lovesite-geo-')) return false
  if (key.startsWith('lovesite-')) return true
  if (me && (key === `story-books-${me}` || key === `story-plugins-${me}`)) return true
  if (key === 'story-collab') return true
  return false
}

/* ---------- 模块状态 ---------- */
let initialized = false
let applyingRemote = false // 恢复写入守卫：置位期间不产生脏标记、不回发
let me = '' // 当前登录用户名（剧情存档按人分键）
/** logicalKey → 最近写入 ts */
let meta: Record<string, number> = {}
/** 本次启动扫描时给存量 key 盖的统一时间戳；0 = 本机不是首次扫描 */
let scanTime = 0
/** 扫描戳待裁决：等云端 retained 到达（或 10 秒超时）再决定上云与否 */
const scanPending = new Set<string>()
/** 已知的跟踪 key（含已被本地删除、云端要发墓碑的） */
const trackedKeys = new Set<string>()
/** 待上云的 key（setItem 触发）与待发墓碑的 key（removeItem 触发） */
const dirtyKeys = new Set<string>()
const removedKeys = new Set<string>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

/** 原始存储键 → 逻辑键：非默认空间下 space.ts 补丁会把 key 落成 key@spaceId */
function rawToLogical(rawKey: string): string {
  const id = getSpaceId()
  if (id && rawKey.endsWith(`@${id}`)) return rawKey.slice(0, -id.length - 1)
  return rawKey
}

function readRaw(logicalKey: string): string | null {
  try {
    return localStorage.getItem(logicalKey)
  } catch {
    return null
  }
}

function loadMeta(): void {
  try {
    const raw = localStorage.getItem(META_KEY)
    const parsed = raw ? (JSON.parse(raw) as Record<string, number>) : {}
    meta = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number' && v > 0) meta[k] = v
    }
  } catch {
    meta = {}
  }
}

function saveMeta(): void {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta))
  } catch {
    /* 元数据写失败不阻塞同步 */
  }
}

/** 上云一个 key：带本地守卫，供补丁与回补共用 */
function publishKey(logicalKey: string, tombstone: boolean): void {
  const ts = meta[logicalKey] ?? Date.now()
  const topic = TOPIC_PREFIX + b64urlEncode(logicalKey)
  if (tombstone) {
    sharedPublish(topic, JSON.stringify({ ts, val: null }))
    return
  }
  const val = readRaw(logicalKey)
  if (val === null) return // 本地已不存在（墓碑已在别处发过）
  if (val.length > MAX_VAL_SIZE) return // 超限 key 跳过：基本是大图缓存，模块自带回补
  sharedPublish(topic, JSON.stringify({ ts, val }))
}

/** 防抖批量上云 */
function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushDirty()
  }, FLUSH_DELAY)
}

function flushDirty(): void {
  if (dirtyKeys.size === 0 && removedKeys.size === 0) return
  const dirt = [...dirtyKeys]
  const removed = [...removedKeys]
  dirtyKeys.clear()
  removedKeys.clear()
  for (const k of dirt) {
    if (isTrackedKey(k, me)) publishKey(k, false)
  }
  for (const k of removed) {
    if (isTrackedKey(k, me)) publishKey(k, true)
  }
}

/** 安装 localStorage 补丁：挂在 space.ts 补丁外层，拿到的是逻辑键 */
function installStoragePatch(): void {
  try {
    const proto = Storage.prototype
    const origSet = proto.setItem
    const origRemove = proto.removeItem
    proto.setItem = function (key: string, value: string) {
      if (!applyingRemote && initialized && isTrackedKey(key, me)) {
        // 扫描戳 key 发生真实写入：以本地为准，戳失效（稍后不会被云端旧值顶掉）
        scanPending.delete(key)
        meta[key] = Date.now()
        saveMeta()
        dirtyKeys.add(key)
        removedKeys.delete(key)
        scheduleFlush()
      }
      return origSet.call(this, key, value)
    }
    proto.removeItem = function (key: string) {
      if (!applyingRemote && initialized && isTrackedKey(key, me) && trackedKeys.has(key)) {
        scanPending.delete(key)
        meta[key] = Date.now()
        saveMeta()
        removedKeys.add(key)
        dirtyKeys.delete(key)
        scheduleFlush()
      }
      return origRemove.call(this, key)
    }
  } catch {
    /* 非浏览器环境跳过 */
  }
}

/** 把云端值落到本地（调用方已判定该采纳） */
function adoptRemote(logicalKey: string, rt: number, val: string | null): void {
  applyingRemote = true
  try {
    if (val === null) {
      localStorage.removeItem(logicalKey)
    } else {
      localStorage.setItem(logicalKey, val)
    }
    meta[logicalKey] = rt
    saveMeta()
  } catch {
    /* 存储满等异常：放弃本次落地 */
  } finally {
    applyingRemote = false
  }
  try {
    window.dispatchEvent(new CustomEvent(KV_APPLIED_EVENT, { detail: { key: logicalKey } }))
  } catch {
    /* ignore */
  }
}

/** 云端一条 retained 消息裁决：ts 新盖旧；本地更新则反熵回发；扫描戳让位云端真相 */
function applyRemote(logicalKey: string, entry: { ts?: number; val?: string | null }): void {
  if (!isTrackedKey(logicalKey, me)) return
  const rt = typeof entry.ts === 'number' && entry.ts > 0 ? entry.ts : 0
  const lt = meta[logicalKey] ?? 0
  trackedKeys.add(logicalKey)
  if (rt > 0 && rt < lt) {
    if (scanPending.has(logicalKey)) {
      // 本地只有扫描戳（无真实写入），云端是扫描前的真相：采纳云端，阻止过期本地上云
      scanPending.delete(logicalKey)
      if (typeof entry.val === 'string' || entry.val === null) adoptRemote(logicalKey, rt, entry.val)
      return
    }
    // 本地真实更新：回发本地值纠云（反熵）
    if (lt > 0) publishKey(logicalKey, false)
    return
  }
  if (rt > 0 && rt === lt) {
    scanPending.delete(logicalKey) // 可能是自己扫描上云的回声，裁决结束
    return
  }
  // rt > lt 或首次见到（lt=0）：采纳云端
  scanPending.delete(logicalKey)
  if (typeof entry.val !== 'string' && entry.val !== null) return
  adoptRemote(logicalKey, rt, entry.val)
}

/** 2026-10-05 一次性迁移：排除备份键之前，它们的 retained 副本已躺在 broker 上
 *  （jade-backup 311KB / avatar-backup 88KB / wallet-backup 84KB 等）。给每个旧副本
 *  发一条墓碑（val:null 几十字节），把 broker retained 降下来，新设备全量收 retained
 *  也不再白下载它们。运行旧代码的设备收到墓碑只会短暂清掉本地备份，模块状态主题
 *  随后下发，备份自动重建——可安全混布。按空间各跑一次；标志键不带 lovesite- 前缀
 *  （cloudSync 不跟踪、space.ts 不改写）。 */
const LEGACY_BACKUP_KEYS = [
  'lovesite-ask-backup',
  'lovesite-auction-backup',
  'lovesite-avatar-backup',
  'lovesite-blindbox-backup',
  'lovesite-dorate-backup',
  'lovesite-drawguess-canvas-backup',
  'lovesite-drawguess-state-backup',
  'lovesite-farm-backup',
  'lovesite-fishing-backup',
  'lovesite-frames-backup',
  'lovesite-jade-backup',
  'lovesite-jar-backup',
  'lovesite-lockdown-backup',
  'lovesite-map-backup',
  'lovesite-memoir-backup',
  'lovesite-quiz-backup',
  'lovesite-ratings-backup',
  'lovesite-stock-backup',
  'lovesite-storyboard-backup',
  'lovesite-timer-backup',
  'lovesite-tree-backup',
  'lovesite-wallet-backup',
  'lovesite-wheel-backup',
  'lovesite-whisper-backup',
  'lovesite-wish2-backup',
]
function tombstoneLegacyBackups(): void {
  const id = getSpaceId()
  const flag = `mqtt-kv-tomb-v1${id ? `:${id}` : ''}`
  try {
    if (localStorage.getItem(flag)) return
    localStorage.setItem(flag, '1')
  } catch {
    return
  }
  const ts = Date.now()
  for (const k of LEGACY_BACKUP_KEYS) {
    sharedPublish(TOPIC_PREFIX + b64urlEncode(k), JSON.stringify({ ts, val: null }))
  }
}

/** 2026-10-10 一次性清理：地图边界缓存已停止镜像（见 isTrackedKey），
 *  但历史副本还躺在 broker 上（实测 11 条、约 460KB，会拖着新设备首登变慢）。
 *  这里给每个地级市 adcode 发墓碑把 retained 降下来。覆盖全国地级市 adcode 区间，
 *  多发的墓碑对不存在的键无害；每台设备每空间跑一次。 */
function tombstoneGeoCache(): void {
  const id = getSpaceId()
  const flag = `mqtt-kv-tomb-geo-v1${id ? `:${id}` : ''}`
  try {
    if (localStorage.getItem(flag)) return
    localStorage.setItem(flag, '1')
  } catch {
    return
  }
  const ts = Date.now()
  // 地级市 adcode：130000~659000，步长 10000（如 530000 昆明市、650000 乌鲁木齐市）
  for (let adcode = 130000; adcode <= 659000; adcode += 10000) {
    const k = `lovesite-geo-v2-${adcode}`
    sharedPublish(TOPIC_PREFIX + b64urlEncode(k), JSON.stringify({ ts, val: null }))
  }
}

/** 首次初始化：扫描存量 key 建档，订阅云端，挂补丁 */
export function initCloudSync(): void {
  if (initialized) return
  if (typeof window === 'undefined' || !localStorage) return
  initialized = true

  try {
    me = localStorage.getItem('love-current-user') ?? ''
  } catch {
    me = ''
  }

  loadMeta()
  installStoragePatch()

  // 扫描本地全部 key 建档。无 meta 的存量 key（cloudSync 上线前的老数据）盖扫描戳、
  // 进 scanPending 推迟裁决：等云端 retained 到了再决定是采纳云端还是本地上云
  try {
    scanTime = Date.now()
    for (let i = 0; i < localStorage.length; i++) {
      const rawKey = localStorage.key(i)
      if (!rawKey) continue
      const logical = rawToLogical(rawKey)
      if (!isTrackedKey(logical, me)) continue
      trackedKeys.add(logical)
      if (!meta[logical]) {
        meta[logical] = scanTime
        scanPending.add(logical)
      }
    }
  } catch {
    /* ignore */
  }
  saveMeta()

  // 扫描戳超时上云：10 秒内云端没来消息（该 key 云端确实没有），本机即唯一持有者
  setTimeout(() => {
    for (const k of scanPending) {
      if (meta[k] !== scanTime) continue // 已被云端裁决或本地写入接管
      scanPending.delete(k)
      dirtyKeys.add(k)
    }
    flushDirty()
  }, SCAN_PUBLISH_DELAY)

  sharedSubscribe(TOPIC_WILDCARD, (payload, topic) => {
    if (payload.length === 0 || !topic) return
    const idx = topic.lastIndexOf('/kv/')
    if (idx < 0) return
    let logicalKey = ''
    try {
      logicalKey = b64urlDecode(topic.slice(idx + 4))
    } catch {
      return
    }
    try {
      const entry = JSON.parse(payload.toString()) as { ts?: number; val?: string | null }
      applyRemote(logicalKey, entry)
    } catch {
      /* ignore */
    }
  })

  tombstoneLegacyBackups()
  tombstoneGeoCache()

  // 连上先补发队列里的脏 key（便宜，每次都做）
  onSharedConnect(() => { scheduleFlush() })

  // 重连回补（门控触发：掉线超 1 分钟/切 broker/每日首连）：把本地小 key 全量重发
  // （原 ts 保留，LWW 不会被旧值覆盖）。挪出 onSharedConnect——旧实现每次重连都
  // 逐 key 重发一遍，抖动一次就来一轮，是「同步慢」的常驻流量来源之一
  onSharedResync(() => {
    for (const k of trackedKeys) {
      if (scanPending.has(k)) continue // 扫描戳未裁决，等超时
      const lt = meta[k] ?? 0
      if (lt <= 0) continue
      const val = readRaw(k)
      if (val !== null && val.length > CONNECT_REPUBLISH_MAX) continue
      publishKey(k, val === null)
    }
    scheduleFlush()
  })
}
