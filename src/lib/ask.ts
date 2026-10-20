/**
 * 互相提问（考考TA）云端同步：与默契挑战同款 MQTT 通道（独立主题）。
 * - 一方向另一方提问 → 对方作答 → 出题人审核对错
 * - 答对 +10 时元，答错 -5 时元（时元账户为预留资产，当前试运行仅展示余额）
 */
import { sharedPublish, sharedSubscribe, sharedResync, onSharedConnect, onSharedStatus } from './mqttClient'
import { isGuestSession } from './guest'
import { isPairMember, membersKnown } from './space'

/** 清理混入的外组账号数据：只保留当前空间成员之间的提问与积分计数器 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scrubForeign(parsed: any): number {
  if (!membersKnown()) return 0
  let removed = 0
  if (Array.isArray(parsed?.asks)) {
    const before = parsed.asks.length
    parsed.asks = (parsed.asks as Array<{ from?: string; to?: string }>).filter(
      (a) => isPairMember(String(a?.from ?? '')) && isPairMember(String(a?.to ?? '')),
    )
    removed += before - parsed.asks.length
  }
  for (const field of ['archPlus', 'archMinus'] as const) {
    const rec = parsed?.[field]
    if (rec && typeof rec === 'object') {
      for (const k of Object.keys(rec as Record<string, unknown>)) {
        if (!isPairMember(k)) {
          delete (rec as Record<string, unknown>)[k]
          removed++
        }
      }
    }
  }
  return removed
}

const TOPIC = 'lovesite/ask/state'
const LS_KEY = 'lovesite-ask-backup'

export const POINTS_RIGHT = 10
export const POINTS_WRONG = -5

export type AskItem = {
  id: string
  from: string // 出题人
  to: string // 答题人
  question: string
  answer: string | null
  status: 'pending' | 'answered' | 'judged'
  correct: boolean | null
  /** 审核时实际加/减的时元（出题人自定；旧数据为空则按默认 ±10/-5 计算） */
  points?: number | null
  ts: number
  answerTs?: number
  judgeTs?: number
}

type State = {
  asks: AskItem[]
  deleted?: Record<string, number>
  v: number
  /** 已折叠出列表的问答积分收入/支出合计（每人，只增不减，合并取大） */
  archPlus?: Record<string, number>
  archMinus?: Record<string, number>
  /** 归档边界：ts 早于此时间的提问已计入积分计数器，合并时跳过 */
  archTs?: number
}

let initialized = false
let asks: AskItem[] = []
/** 删除墓碑：防止合并时旧云端状态复活已删提问 */
let deleted: Record<string, number> = {}
let archPlus: Record<string, number> = {}
let archMinus: Record<string, number> = {}
let archTs = 0
let stateReceived = false
let cloudReady = false
/** 已见状态的最大版本号：旧 retained / 自己的回声一律忽略 */
let lastV = 0
let subscribers: Array<(asks: AskItem[]) => void> = []
let errorListeners: Array<(msg: string) => void> = []

function loadBackup(): State | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as State
    if (!Array.isArray(parsed.asks)) return null
    scrubForeign(parsed as unknown as Record<string, unknown>) // 本地备份也清掉外组数据
    return {
      asks: parsed.asks,
      deleted: parsed.deleted ?? {},
      v: parsed.v ?? 0,
      archPlus: parsed.archPlus ?? {},
      archMinus: parsed.archMinus ?? {},
      archTs: parsed.archTs ?? 0,
    }
  } catch {
    return null
  }
}

function saveBackup() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ asks, deleted, v: lastV, archPlus, archMinus, archTs }))
  } catch {
    /* ignore */
  }
}

function notify() {
  const snapshot = [...asks]
  subscribers.forEach((cb) => cb(snapshot))
}

function emitError(msg: string) {
  errorListeners.forEach((cb) => cb(msg))
}

/** 状态进度：pending < answered < judged，用于同 id 冲突时取进展更大的 */
const RANK: Record<AskItem['status'], number> = { pending: 0, answered: 1, judged: 2 }
const progress = (a: AskItem): number =>
  RANK[a.status] * 1e13 + (a.judgeTs ?? a.answerTs ?? a.ts)

const MAX_ASKS = 200

/** 一条提问产生的积分变动（与 balanceOf 同规则） */
function pointsOf(a: AskItem): [string, number] | null {
  if (a.status === 'answered' && typeof a.points === 'number') return [a.from, a.points]
  if (a.status === 'judged') return [a.to, a.points ?? (a.correct ? POINTS_RIGHT : POINTS_WRONG)]
  return null
}

/** 列表超限时把最老的折叠进积分计数器，余额分毫不差 */
function foldAsks(list: AskItem[]): AskItem[] {
  if (list.length <= MAX_ASKS) return list
  const kept = list.slice(0, MAX_ASKS)
  const boundaryTs = kept[kept.length - 1].ts
  const rest = list.slice(MAX_ASKS)
  const stay = rest.filter((a) => a.ts >= boundaryTs)
  for (const a of rest) {
    if (a.ts >= boundaryTs) continue
    const p = pointsOf(a)
    if (!p) continue
    const [who, pts] = p
    if (pts > 0) archPlus[who] = (archPlus[who] ?? 0) + pts
    else if (pts < 0) archMinus[who] = (archMinus[who] ?? 0) + -pts
  }
  archTs = Math.max(archTs, boundaryTs)
  return [...kept, ...stay]
}

/** 合并对方的归档计数器（每人单调递增，取大即收敛） */
function mergeArch(state: State): void {
  for (const [who, n] of Object.entries(state.archPlus ?? {})) {
    if (typeof n === 'number' && n > (archPlus[who] ?? 0)) archPlus[who] = n
  }
  for (const [who, n] of Object.entries(state.archMinus ?? {})) {
    if (typeof n === 'number' && n > (archMinus[who] ?? 0)) archMinus[who] = n
  }
  if (typeof state.archTs === 'number' && state.archTs > archTs) archTs = state.archTs
  asks = asks.filter((a) => a.ts >= archTs)
}

/** 按提问 id 合并：并集，同 id 取进展更大（更新）的一条；归档边界前的直接跳过 */
function mergeAsks(local: AskItem[], remote: AskItem[]): AskItem[] {
  const byId = new Map<string, AskItem>()
  for (const a of local) byId.set(a.id, a)
  for (const a of remote) {
    if (a.ts < archTs) continue // 已计入归档计数器
    const cur = byId.get(a.id)
    if (!cur || progress(a) > progress(cur)) byId.set(a.id, a)
  }
  const merged = [...byId.values()]
    .filter((a) => (deleted[a.id] ?? 0) < a.ts)
    .sort((a, b) => b.ts - a.ts)
  return foldAsks(merged)
}

function hasAskNotIn(local: AskItem[], remote: AskItem[]): boolean {
  const ids = new Set(remote.map((a) => a.id))
  return local.some((a) => !ids.has(a.id))
}

function applyTombstones() {
  asks = asks.filter((a) => (deleted[a.id] ?? 0) < a.ts)
  const ids = Object.keys(deleted)
  if (ids.length > 100) {
    const sorted = ids.sort((a, b) => deleted[b] - deleted[a])
    deleted = Object.fromEntries(sorted.slice(0, 100).map((id) => [id, deleted[id]]))
  }
}

function ensureClient() {
  if (initialized) return
  initialized = true

  // 本地缓存先行：先用上次的备份立刻渲染，云端数据到了再合并
  if (!stateReceived && asks.length === 0) {
    const backup = loadBackup()
    if (backup) {
      asks = backup.asks
      deleted = backup.deleted ?? {}
      archPlus = backup.archPlus ?? {}
      archMinus = backup.archMinus ?? {}
      archTs = backup.archTs ?? 0
      lastV = backup.v ?? 0
    }
  }

  sharedSubscribe(TOPIC, (payload) => {
    if (payload.length === 0) return
    try {
      const state = JSON.parse(payload.toString()) as State
      if (!Array.isArray(state.asks)) return
      const removedForeign = scrubForeign(state as unknown as Record<string, unknown>) // 外组提问入口清掉
      stateReceived = true
      cloudReady = true
      const pv = state.v ?? 0
      if (pv <= lastV) {
        // 时钟偏差兜底：旧版本号里若夹着本地没有的提问或更新的进展，照样合并进来
        mergeArch(state)
        const incoming = state.asks.filter((a) => a.ts >= archTs)
        const remoteHasProgress = incoming.some((a) => {
          const l = asks.find((x) => x.id === a.id)
          return l ? progress(a) > progress(l) : true
        })
        if (remoteHasProgress) {
          asks = mergeAsks(asks, incoming)
          for (const [id, ts] of Object.entries(state.deleted ?? {})) {
            if (ts > (deleted[id] ?? 0)) deleted[id] = ts
          }
          applyTombstones()
          saveBackup()
          notify()
        }
        if (removedForeign > 0) publishState() // 回发清理后的状态
        return
      }
      lastV = pv
      // 合并而非覆盖：两人同时提问/回答/审核也不会互丢
      mergeArch(state)
      const incoming = state.asks.filter((a) => a.ts >= archTs)
      const cloudMissing = hasAskNotIn(asks, incoming)
      asks = mergeAsks(asks, incoming)
      for (const [id, ts] of Object.entries(state.deleted ?? {})) {
        if (ts > (deleted[id] ?? 0)) deleted[id] = ts
      }
      applyTombstones()
      saveBackup()
      notify()
      // 反熵：云端缺我们已有的提问时回发合并结果；清掉外组数据后也要回发
      if (cloudMissing || removedForeign > 0) publishState()
    } catch {
      /* ignore */
    }
  })

  onSharedConnect(() => {
    setTimeout(() => {
      if (!stateReceived) {
        const backup = loadBackup()
        cloudReady = true
        if (backup && backup.asks.length > 0) {
          mergeArch(backup)
          asks = mergeAsks(asks, backup.asks)
          deleted = { ...deleted, ...(backup.deleted ?? {}) }
          lastV = Math.max(lastV, backup.v ?? 0)
          applyTombstones()
          // 不发布旧备份上云（会盖掉对方的新提问），仅本地展示
        }
        notify()
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
  lastV = v // 自己的回声会被版本守卫忽略
  const state: State = { asks, deleted, v, archPlus, archMinus, archTs }
  sharedPublish(TOPIC, JSON.stringify(state))
}

/** 订阅提问列表；返回取消订阅函数 */
export function subscribeAsks(
  onData: (asks: AskItem[]) => void,
  onError?: (msg: string) => void,
): () => void {
  subscribers.push(onData)
  if (onError) errorListeners.push(onError)
  ensureClient()
  onData([...asks])
  return () => {
    subscribers = subscribers.filter((cb) => cb !== onData)
    if (onError) errorListeners = errorListeners.filter((cb) => cb !== onError)
  }
}

/** 当前提问列表快照（lib 层只读计算用，如余额汇总，无需再订阅一次） */
export function asksSnapshot(): AskItem[] {
  ensureClient()
  return [...asks]
}

function update(fn: () => void) {
  if (isGuestSession()) return // 游客只能参观，改动直接丢弃
  ensureClient()
  if (!cloudReady) return
  fn()
  saveBackup()
  publishState()
  notify()
}

/** 我向 TA 出一道题 */
export function createAsk(from: string, to: string, question: string): boolean {
  const trimmed = question.trim()
  if (!trimmed) return false
  update(() => {
    asks = [
      {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        from,
        to,
        question: trimmed,
        answer: null,
        status: 'pending',
        correct: null,
        ts: Date.now(),
      },
      ...asks,
    ]
  })
  return true
}

/** 答题人提交答案，并直接给出题人加时元（多少由答题人自己定，可为 0） */
export function answerAsk(id: string, answer: string, points: number): void {
  const trimmed = answer.trim()
  if (!trimmed) return
  const pts = Math.max(0, Math.min(10000, Math.floor(points) || 0))
  update(() => {
    asks = asks.map((a) =>
      a.id === id && a.status === 'pending'
        ? { ...a, answer: trimmed, status: 'answered' as const, points: pts, answerTs: Date.now() }
        : a,
    )
  })
}

/** 出题人审核对错（旧流程遗留，仅用于处理改版前未审核的旧数据） */
export function judgeAsk(id: string, correct: boolean, points?: number): void {
  update(() => {
    asks = asks.map((a) =>
      a.id === id && a.status === 'answered' && a.points == null
        ? {
            ...a,
            status: 'judged' as const,
            correct,
            points: (() => {
              const p = points ?? (correct ? POINTS_RIGHT : POINTS_WRONG)
              return Math.max(-10000, Math.min(10000, Math.floor(p) || 0))
            })(),
            judgeTs: Date.now(),
          }
        : a,
    )
  })
}

/** 删除一条提问（仅出题人、且未作答前） */
export function removeAsk(id: string): void {
  update(() => {
    const target = asks.find((a) => a.id === id)
    asks = asks.filter((a) => a.id !== id || a.status !== 'pending')
    if (target) deleted = { ...deleted, [id]: Date.now() }
  })
}

/**
 * 时元余额（试运行，含已归档的历史积分，永远精确）：
 * - 新流程：回答时答题人直接给出题人加时元（answered 且带 points）
 * - 旧流程遗留：审核后给答题人加减分（judged）
 */
export function balanceOf(asks: AskItem[], who: string): number {
  const archived = (archPlus[who] ?? 0) - (archMinus[who] ?? 0)
  return archived + asks.reduce((sum, a) => {
    if (a.status === 'answered' && typeof a.points === 'number' && a.from === who) {
      return sum + a.points
    }
    // 与记录页口径一致：judged 但 correct 为 null 的旧数据不算分（记录页也不显示它），
    // 否则会出现「明细里没有这笔、余额里却扣了」的对不上
    if (a.status === 'judged' && a.correct !== null && a.to === who) {
      return sum + (a.points ?? (a.correct ? POINTS_RIGHT : POINTS_WRONG))
    }
    return sum
  }, 0)
}

/** 手动刷新 */
export function resyncAsks() {
  ensureClient()
  stateReceived = false
  sharedResync(TOPIC)
}
