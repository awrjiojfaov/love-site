/**
 * 在一起的起始时刻：新建账号组由双方自己设置，设置后持久不变，只在本账号组两台手机之间同步。
 * 默认账号组（成员B & 成员A）不用这个模块，仍走 HomePage 里写死的 START_TIME。
 * 存储：MQTT retained（topic 按 space 自动改写成 lovesite-pair-<id>/timer/state）+ 本地备份。
 */
import { sharedPublish, sharedSubscribe, onSharedConnect } from './mqttClient'
import { isGuestSession } from './guest'

const TOPIC = 'lovesite/timer/state'
const LS_KEY = 'lovesite-timer-backup'

export type LoveTimeState = {
  start: number | null // 起始毫秒时间戳；null = 还没设置
  v: number
  by?: string // 谁设置的（展示用）
}

let initialized = false
let state: LoveTimeState = { start: null, v: 0 }
let stateReceived = false
let cloudReady = false
let pendingPublish = false
let lastV = 0
let subscribers: Array<(start: number | null) => void> = []

function loadBackup(): LoveTimeState | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as LoveTimeState
    if (typeof parsed !== 'object' || parsed === null) return null
    return {
      start: typeof parsed.start === 'number' ? parsed.start : null,
      v: parsed.v ?? 0,
      by: parsed.by,
    }
  } catch {
    return null
  }
}

function saveBackup() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ ...state, v: lastV }))
  } catch {
    /* ignore */
  }
}

function notify() {
  const value = state.start
  subscribers.forEach((cb) => cb(value))
}

function publishState() {
  const v = Date.now()
  lastV = v // 自己的回声会被版本守卫忽略
  state = { ...state, v }
  pendingPublish = false
  saveBackup()
  sharedPublish(TOPIC, JSON.stringify(state))
}

function ensureClient() {
  if (initialized) return
  initialized = true

  // 本地备份先行：先用上次的值立刻渲染，云端到了再覆盖
  const backup = loadBackup()
  if (backup) {
    state = backup
    lastV = backup.v ?? 0
  }

  sharedSubscribe(TOPIC, (payload) => {
    if (payload.length === 0) return
    try {
      const remote = JSON.parse(payload.toString()) as LoveTimeState
      if (typeof remote !== 'object' || remote === null) return
      stateReceived = true
      cloudReady = true
      const remoteStart = typeof remote.start === 'number' ? remote.start : null
      const pv = remote.v ?? 0
      if (pv <= lastV) {
        // 时钟偏差兜底：旧版本号里若夹着本地还没有的设置，照样合并
        if (state.start === null && remoteStart !== null) {
          state = { start: remoteStart, v: pv, by: remote.by }
          lastV = Math.max(lastV, pv)
          saveBackup()
          notify()
        }
        if (pendingPublish) publishState()
        return
      }
      lastV = pv
      state = { start: remoteStart, v: pv, by: remote.by }
      saveBackup()
      notify()
      if (pendingPublish) publishState()
    } catch {
      /* ignore */
    }
  })

  onSharedConnect(() => {
    setTimeout(() => {
      if (!stateReceived) {
        cloudReady = true
        // 本地备份只做展示，不回发（避免过期值盖掉对方的设置）
      }
      if (pendingPublish && cloudReady) publishState()
      notify()
    }, 3000)
  })
}

/** 订阅起始时刻（立即回放现值；未设置时回放 null） */
export function subscribeLoveTime(fn: (start: number | null) => void): () => void {
  subscribers.push(fn)
  ensureClient()
  fn(state.start)
  return () => {
    subscribers = subscribers.filter((cb) => cb !== fn)
  }
}

/** 设置/修改起始时刻（双方手机同步；传 null 清除） */
export function setLoveTime(ms: number | null, by?: string): boolean {
  if (isGuestSession()) return false
  ensureClient()
  state = { start: ms, v: Date.now(), by }
  saveBackup()
  notify()
  if (cloudReady) publishState()
  else pendingPublish = true // 连上后自动补发，不再静默丢弃
  return true
}

/** 当前起始时刻（未初始化时读本地备份，兜底 null） */
export function loveTimeNow(): number | null {
  if (!initialized) {
    const backup = loadBackup()
    if (backup) state = backup
  }
  return state.start
}
