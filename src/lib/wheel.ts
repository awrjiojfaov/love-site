/**
 * 姿势转盘（秘密空间）云端同步：共享 MQTT 连接，独立主题。
 * - 转盘内容双方都能添加 / 删除，实时同步；上限 100 个，每个概率 = 1/总数
 * - 添加一条 +10 时元，删除一条 -10 时元（走钱包账本）
 * - 合并同步：按 id 求并集 + 删除墓碑，两人同时增删不互丢
 */
import { sharedPublish, sharedSubscribe, onSharedConnect, onSharedStatus } from './mqttClient'
import { isGuestSession } from './guest'
import { addTx } from './wallet'

const TOPIC = 'lovesite/wheel/state'
const LS_KEY = 'lovesite-wheel-backup'

export const MAX_WHEEL_ITEMS = 100
export const WHEEL_ADD_REWARD = 10
export const WHEEL_DEL_PENALTY = -10

export type WheelItem = { id: string; label: string }

type State = { items: WheelItem[]; v: number; deleted?: Record<string, number> }

let initialized = false
let items: WheelItem[] = []
let deleted: Record<string, number> = {}
let lastV = 0
let stateReceived = false
let subscribers: Array<(items: WheelItem[]) => void> = []
let errorListeners: Array<(msg: string) => void> = []

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateItems(raw: any): WheelItem[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((it) => it && typeof it.label === 'string')
    .map((it) => ({ id: String(it.id ?? ''), label: String(it.label) }))
    .filter((it) => it.id && it.label)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateDeleted(raw: any): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'number') out[k] = v
  return out
}

function loadBackup(): State | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as State
    return {
      items: migrateItems(parsed.items),
      v: parsed.v ?? 0,
      deleted: migrateDeleted(parsed.deleted),
    }
  } catch {
    return null
  }
}

function saveBackup() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ items, v: lastV, deleted }))
  } catch {
    /* ignore */
  }
}

/** id 内嵌创建时间（w_<time36>_rand），按 id 排序 ≈ 创建顺序，两端一致 */
function sortItems(list: WheelItem[]): WheelItem[] {
  return [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** 合并：并集 - 墓碑，按创建顺序，保留前 MAX 个 */
function mergeItems(local: WheelItem[], remote: WheelItem[], del: Record<string, number>): WheelItem[] {
  const map = new Map<string, WheelItem>()
  for (const it of [...remote, ...local]) if (!del[it.id]) map.set(it.id, it)
  return sortItems([...map.values()]).slice(0, MAX_WHEEL_ITEMS)
}

function capDeleted(m: Record<string, number>, max = 200): Record<string, number> {
  const entries = Object.entries(m)
  if (entries.length <= max) return m
  entries.sort((a, b) => b[1] - a[1])
  return Object.fromEntries(entries.slice(0, max))
}

/** 墓碑合并：同键取较大时间戳（单调递增，避免远端旧墓碑盖掉本地新墓碑） */
function mergeDeleted(local: Record<string, number>, remote: Record<string, number>): Record<string, number> {
  const out = { ...local }
  for (const [k, v] of Object.entries(remote)) {
    if (v > (out[k] ?? 0)) out[k] = v
  }
  return capDeleted(out)
}

function notify() {
  const snapshot = [...items]
  subscribers.forEach((cb) => cb(snapshot))
}

function emitError(msg: string) {
  errorListeners.forEach((cb) => cb(msg))
}

function ensureClient() {
  if (initialized) return
  initialized = true

  // 本地缓存先行
  const backup = loadBackup()
  if (backup) {
    items = backup.items
    deleted = backup.deleted ?? {}
    lastV = backup.v ?? 0
  }

  sharedSubscribe(TOPIC, (payload) => {
    if (payload.length === 0) return
    try {
      const state = JSON.parse(payload.toString()) as State
      if (typeof state.v !== 'number') return
      if (state.v <= lastV) {
        if (!stateReceived) {
          stateReceived = true
          if (state.v < lastV) publishState()
        }
        // 时钟偏差兜底：旧版本号里若夹着本地没有的条目，照样合并进来
        const rItems = migrateItems(state.items)
        if (rItems.some((it) => !items.some((l) => l.id === it.id))) {
          deleted = mergeDeleted(deleted, migrateDeleted(state.deleted))
          items = mergeItems(items, rItems, deleted)
          saveBackup()
          notify()
        }
        return
      }
      lastV = state.v
      stateReceived = true
      const rItems = migrateItems(state.items)
      const rDel = migrateDeleted(state.deleted)
      const localExtra = items.some((it) => !rItems.some((r) => r.id === it.id))
      deleted = mergeDeleted(deleted, rDel)
      items = mergeItems(items, rItems, deleted)
      saveBackup()
      notify()
      if (localExtra) publishState() // 反熵：云端缺本地条目 → 回发
    } catch {
      /* ignore */
    }
  })

  onSharedConnect(() => {
    // 3 秒内没收到云端保留数据 → 云端为空，本地有内容就自愈回云端
    setTimeout(() => {
      if (!stateReceived) {
        stateReceived = true
        if (items.length > 0) publishState()
        else notify()
      }
    }, 3000)
  })

  onSharedStatus((status, msg) => {
    if (status === 'error') emitError(`连接消息服务器失败：${msg}`)
    else if (status === 'offline') emitError('消息服务器连接中断，正在自动重连…')
    else if (status === 'reconnect') emitError('')
  })
}

function publishState() {
  const v = Date.now()
  lastV = v
  const state: State = { items, v, deleted }
  sharedPublish(TOPIC, JSON.stringify(state))
}

function commit() {
  publishState()
  saveBackup()
  notify()
}

/** 订阅转盘内容；返回取消订阅函数 */
export function subscribeWheel(
  onData: (items: WheelItem[]) => void,
  onError?: (msg: string) => void,
): () => void {
  subscribers.push(onData)
  if (onError) errorListeners.push(onError)
  ensureClient()
  onData([...items])
  return () => {
    subscribers = subscribers.filter((cb) => cb !== onData)
    if (onError) errorListeners = errorListeners.filter((cb) => cb !== onError)
  }
}

/** 添加一个选项（双方实时可见，+10 时元）；返回是否成功 */
export function addWheelItem(who: string, label: string): boolean {
  if (isGuestSession()) return false
  const trimmed = label.trim()
  if (!trimmed || trimmed.length > 12) return false
  if (items.length >= MAX_WHEEL_ITEMS) return false
  if (items.some((it) => it.label === trimmed)) return false
  ensureClient()
  items = sortItems([
    ...items,
    { id: `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, label: trimmed },
  ])
  commit()
  addTx(who, WHEEL_ADD_REWARD, `转盘添加「${trimmed}」`)
  return true
}

/** 删除一个选项（-10 时元，写墓碑防复活） */
export function removeWheelItem(who: string, id: string): void {
  if (isGuestSession()) return
  const target = items.find((it) => it.id === id)
  if (!target) return
  ensureClient()
  items = items.filter((it) => it.id !== id)
  deleted = capDeleted({ ...deleted, [id]: Date.now() })
  commit()
  addTx(who, WHEEL_DEL_PENALTY, `转盘删除「${target.label}」`)
}
