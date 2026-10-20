/**
 * 头像框云端同步：共享 MQTT 连接，独立主题。
 * - 每人只改自己的「已拥有列表 + 佩戴中」，按人独立版本号（参考农场 vv 方案），
 *   两人同时买框互不干扰
 * - 购买走钱包账本扣时元，账本失败则整体放弃
 */
import { sharedPublish, sharedSubscribe, onSharedConnect } from './mqttClient'
import { isGuestSession } from './guest'
import { addTx } from './wallet'
import { frameById } from '../data/frames'
import { isPairMember, membersKnown } from './space'

/** 清理混入的外组账号数据：owned/equipped/vv 只保留当前空间成员 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scrubForeign(parsed: any): number {
  if (!membersKnown() || !parsed || typeof parsed !== 'object') return 0
  let removed = 0
  for (const field of ['owned', 'equipped', 'vv'] as const) {
    const rec = parsed[field]
    if (rec && typeof rec === 'object') {
      for (const k of Object.keys(rec)) {
        if (!isPairMember(k)) {
          delete rec[k]
          removed++
        }
      }
    }
  }
  return removed
}

const TOPIC = 'lovesite/frames/state'
const LS_KEY = 'lovesite-frames-backup'

export type FramesState = {
  /** 每人已拥有的框 id 列表 */
  owned: Record<string, string[]>
  /** 每人佩戴中的框 id（null = 不戴） */
  equipped: Record<string, string | null>
}

type State = FramesState & { vv: Record<string, number>; v: number }

let initialized = false
let owned: Record<string, string[]> = {}
let equipped: Record<string, string | null> = {}
let vv: Record<string, number> = {}
let lastV = 0
let stateReceived = false
let cloudReady = false
let subscribers: Array<(s: FramesState) => void> = []

function loadBackup(): State | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as State
    if (!parsed.owned || typeof parsed.owned !== 'object') return null
    scrubForeign(parsed) // 本地备份也清掉外组数据
    return parsed
  } catch {
    return null
  }
}

function saveBackup() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ owned, equipped, vv, v: lastV }))
  } catch {
    /* ignore */
  }
}

function notify() {
  const snapshot: FramesState = {
    owned: Object.fromEntries(Object.entries(owned).map(([k, v]) => [k, [...v]])),
    equipped: { ...equipped },
  }
  subscribers.forEach((cb) => cb(snapshot))
}

function publishState(who: string) {
  vv[who] = Math.max(vv[who] ?? 0, Date.now()) + 1 // Lamport：只认先后不认时钟
  lastV = Date.now()
  sharedPublish(TOPIC, JSON.stringify({ owned, equipped, vv, v: lastV } satisfies State))
}

function ensureClient() {
  if (initialized) return
  initialized = true

  const backup = loadBackup()
  if (backup) {
    owned = backup.owned ?? {}
    equipped = backup.equipped ?? {}
    vv = backup.vv ?? {}
    lastV = backup.v ?? 0
  }

  sharedSubscribe(TOPIC, (payload) => {
    if (payload.length === 0) return
    try {
      const state = JSON.parse(payload.toString()) as State
      if (!state.owned || typeof state.owned !== 'object') return
      const removedForeign = scrubForeign(state) // 外组头像框入口清掉
      stateReceived = true
      cloudReady = true
      const incVv = state.vv ?? {}
      let changed = false
      // 逐人版本守卫：只采纳比我们更新的那个人的数据
      const users = new Set([...Object.keys(state.owned), ...Object.keys(state.equipped ?? {})])
      for (const u of users) {
        const iv = incVv[u] ?? state.v ?? 0
        if (iv > (vv[u] ?? 0)) {
          vv[u] = iv
          if (Array.isArray(state.owned[u])) owned[u] = state.owned[u].filter((id) => frameById(id))
          if (u in (state.equipped ?? {})) equipped[u] = state.equipped[u]
          changed = true
        }
      }
      if ((state.v ?? 0) > lastV) lastV = state.v
      if (removedForeign > 0) {
        // 回发清理后的状态（升版本防止脏 retained 回魂）
        lastV = Date.now()
        sharedPublish(TOPIC, JSON.stringify({ owned, equipped, vv, v: lastV } satisfies State))
        saveBackup()
        notify()
        return
      }
      if (!changed) return
      saveBackup()
      notify()
    } catch {
      /* ignore */
    }
  })

  onSharedConnect(() => {
    setTimeout(() => {
      if (!stateReceived) {
        stateReceived = true
        cloudReady = true
        // 云端为空：本地有数据就自愈回云端
        if (Object.keys(owned).length > 0) {
          for (const u of Object.keys(owned)) vv[u] = Math.max(vv[u] ?? 0, Date.now()) + 1
          lastV = Date.now()
          sharedPublish(TOPIC, JSON.stringify({ owned, equipped, vv, v: lastV } satisfies State))
        }
        notify()
      }
    }, 3000)
  })
}

export function subscribeFrames(onData: (s: FramesState) => void): () => void {
  subscribers.push(onData)
  ensureClient()
  onData({
    owned: Object.fromEntries(Object.entries(owned).map(([k, v]) => [k, [...v]])),
    equipped: { ...equipped },
  })
  return () => {
    subscribers = subscribers.filter((cb) => cb !== onData)
  }
}

/** 佩戴 / 卸下（id 传 null 即卸下） */
export function equipFrame(who: string, id: string | null): void {
  if (isGuestSession()) return
  ensureClient()
  if (!cloudReady) return
  if (id && !(owned[who] ?? []).includes(id)) return
  equipped = { ...equipped, [who]: id }
  publishState(who)
  saveBackup()
  notify()
}

/** 购买并立即佩戴；余额检查由调用方做，这里负责扣账 + 入库 */
export function buyFrame(who: string, id: string): { ok: boolean; msg: string } {
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' }
  ensureClient()
  if (!cloudReady) return { ok: false, msg: '同步中，请稍后再试' }
  const def = frameById(id)
  if (!def) return { ok: false, msg: '这个框不存在' }
  if ((owned[who] ?? []).includes(id)) return { ok: false, msg: '已经拥有啦' }
  if (!addTx(who, -def.price, `购买头像框「${def.name}」`)) {
    return { ok: false, msg: '记账失败，请稍后再试' }
  }
  owned = { ...owned, [who]: [...(owned[who] ?? []), id] }
  equipped = { ...equipped, [who]: id }
  publishState(who)
  saveBackup()
  notify()
  return { ok: true, msg: `已戴上「${def.name}」✨` }
}
