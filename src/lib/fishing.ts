/**
 * 渔获日志：钓鱼成功的每一条鱼都上云（MQTT 独立主题，模式同 wallet.ts）。
 * - 排行榜数据 = 按人聚合渔获条目；两台手机实时一致
 * - 只记录鱼（障碍/炸药桶不算渔获）
 */
import { sharedPublish, sharedSubscribe, onSharedConnect } from './mqttClient'
import { isPairMember, membersKnown } from './space'

/** 清理混入的外组账号数据：渔获只保留当前空间成员的 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scrubForeign(parsed: any): number {
  if (!membersKnown() || !Array.isArray(parsed?.log)) return 0
  const before = parsed.log.length
  parsed.log = (parsed.log as Array<{ who?: string }>).filter((e) => isPairMember(String(e?.who ?? '')))
  return before - parsed.log.length
}

const TOPIC = 'lovesite/fishing/state'
const LS_KEY = 'lovesite-fishing-backup'
const MAX_LOG = 300 // 只留最近 300 条，排行榜统计的是窗口内战绩

export type CatchEntry = {
  id: string
  who: string
  fishId: string
  rare: boolean
  ts: number
}

type State = { log: CatchEntry[]; v: number }

let initialized = false
let log: CatchEntry[] = []
let stateReceived = false
let cloudReady = false
let lastV = 0
let subscribers: Array<(log: CatchEntry[]) => void> = []

function loadBackup(): State | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as State
    if (!Array.isArray(parsed.log)) return null
    scrubForeign(parsed as unknown as Record<string, unknown>) // 本地备份也清掉外组数据
    return { log: parsed.log, v: parsed.v ?? 0 }
  } catch {
    return null
  }
}

function saveBackup() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ log, v: lastV }))
  } catch {
    /* ignore */
  }
}

function notify() {
  const snapshot = [...log]
  subscribers.forEach((cb) => cb(snapshot))
}

/** 按条目 id 求并集，按时间倒序，截断到 MAX_LOG */
function mergeLog(local: CatchEntry[], remote: CatchEntry[]): CatchEntry[] {
  const byId = new Map<string, CatchEntry>()
  for (const e of local) byId.set(e.id, e)
  for (const e of remote) if (!byId.has(e.id)) byId.set(e.id, e)
  return [...byId.values()].sort((a, b) => b.ts - a.ts).slice(0, MAX_LOG)
}

function ensureClient() {
  if (initialized) return
  initialized = true

  if (!stateReceived && log.length === 0) {
    const backup = loadBackup()
    if (backup) {
      log = backup.log
      lastV = backup.v ?? 0
    }
  }

  sharedSubscribe(TOPIC, (payload) => {
    if (payload.length === 0) return
    try {
      const state = JSON.parse(payload.toString()) as State
      if (!Array.isArray(state.log)) return
      const removedForeign = scrubForeign(state as unknown as Record<string, unknown>) // 外组渔获入口清掉
      stateReceived = true
      cloudReady = true
      const pv = state.v ?? 0
      const ids = new Set(log.map((e) => e.id))
      const cloudMissing = state.log.some((e) => !ids.has(e.id))
      if (pv <= lastV && !cloudMissing) {
        if (removedForeign > 0) publishState() // 回发清理后的状态
        return // 旧 retained / 自己回声
      }
      lastV = Math.max(lastV, pv)
      const remoteIds = new Set(state.log.map((e) => e.id))
      const remoteMissing = log.some((e) => !remoteIds.has(e.id))
      log = mergeLog(log, state.log)
      saveBackup()
      notify()
      if (removedForeign > 0 || (remoteMissing && pv <= lastV)) publishState() // 反熵回发 + 清理回发
    } catch {
      /* ignore */
    }
  })

  onSharedConnect(() => {
    setTimeout(() => {
      if (!stateReceived) {
        cloudReady = true
        notify()
      }
    }, 3000)
  })
}

function publishState() {
  const v = Date.now()
  lastV = v
  sharedPublish(TOPIC, JSON.stringify({ log, v }))
}

export function subscribeFishingLog(onData: (log: CatchEntry[]) => void): () => void {
  subscribers.push(onData)
  ensureClient()
  onData([...log])
  return () => {
    subscribers = subscribers.filter((cb) => cb !== onData)
  }
}

/** 记一条渔获（云端未就绪时返回 false，调用方自行决定要不要重试/提示） */
export function logCatch(who: string, fishId: string, rare: boolean): boolean {
  ensureClient()
  if (!cloudReady) return false
  log = [
    {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      who,
      fishId,
      rare,
      ts: Date.now(),
    },
    ...log,
  ].slice(0, MAX_LOG)
  saveBackup()
  publishState()
  notify()
  return true
}
