/**
 * 自定义头像：云端同步（MQTT）+ 本地备份，换设备也能同步
 */
import { sharedPublish, sharedSubscribe, onSharedConnect, onSharedStatus } from './mqttClient'
import { isGuestSession } from './guest'
import { isPairMember, membersKnown } from './space'

/** 清理混入的外组账号数据：头像表只保留当前空间成员 */
function scrubForeign(parsed: Record<string, unknown>): number {
  if (!membersKnown() || !parsed?.avatars || typeof parsed.avatars !== 'object') return 0
  let removed = 0
  const rec = parsed.avatars as Record<string, unknown>
  for (const k of Object.keys(rec)) {
    if (!isPairMember(k)) {
      delete rec[k]
      removed++
    }
  }
  return removed
}

const TOPIC = 'lovesite/avatar/state'
const LS_KEY = 'lovesite-avatar-backup'

export type AvatarState = {
  avatars: Record<string, string> // 用户名 -> dataURL
  /** 每人独立的头像版本时间戳：合并按人取新，不再受整包版本号和两台手机时钟的牵制 */
  avTs?: Record<string, number>
  v: number
}

let initialized = false
let avatars: Record<string, string> = {}
let avTs: Record<string, number> = {}
let stateReceived = false
let cloudReady = false
/** 云端没就绪时的挂起发布：连上后自动补发，避免上传被静默丢弃 */
let pendingPublish = false
/** 已见状态的最大 Lamport 版本号：旧 retained / 自己的回声忽略，防旧头像回滚 */
let lastV = 0
let subscribers: Array<(avatars: Record<string, string>) => void> = []
let errorListeners: Array<(msg: string) => void> = []

function loadBackup(): AvatarState | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as AvatarState
    if (!parsed.avatars || typeof parsed.avatars !== 'object') return null
    scrubForeign(parsed as unknown as Record<string, unknown>) // 本地备份也清掉外组数据
    return {
      avatars: parsed.avatars,
      avTs: parsed.avTs ?? {},
      v: parsed.v ?? 0,
    }
  } catch {
    return null
  }
}

function saveBackup() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ avatars, avTs, v: lastV }))
  } catch {
    /* ignore */
  }
}

/** Lamport 版本：max(已见版本, 本地时钟) + 1，只认先后不认两台手机的时钟（jade/farm 同款修法） */
function bumpV(): number {
  lastV = Math.max(lastV, Date.now()) + 1
  return lastV
}

function notify() {
  const snapshot = { ...avatars }
  subscribers.forEach((cb) => cb(snapshot))
}

function emitError(msg: string) {
  errorListeners.forEach((cb) => cb(msg))
}

function ensureClient() {
  if (initialized) return
  initialized = true

  // 本地缓存先行：先用上次的备份立刻渲染，云端数据到了再覆盖
  if (!stateReceived && Object.keys(avatars).length === 0) {
    const backup = loadBackup()
    if (backup) {
      avatars = backup.avatars
      avTs = backup.avTs ?? {}
      // 老备份没有 avTs：用备份版本号给已知头像 seed 一个时间戳，
      // 否则旧包里的同名头像会被误当成"新的"覆盖本地
      if (Object.keys(avTs).length === 0 && backup.v) {
        for (const name of Object.keys(avatars)) avTs[name] = backup.v
      }
      lastV = backup.v ?? 0
    }
  }

  sharedSubscribe(TOPIC, (payload) => {
    if (payload.length === 0) return
    try {
      const state = JSON.parse(payload.toString()) as AvatarState
      if (!state.avatars || typeof state.avatars !== 'object') return
      const removedForeign = scrubForeign(state as unknown as Record<string, unknown>) // 外组头像入口清掉
      stateReceived = true
      cloudReady = true
      if (pendingPublish) publishState()
      const pv = state.v ?? 0
      // 按人合并：每人用自己的 avTs 比新旧（老消息没有 avTs 就退回整包 v 当时间戳）。
      // 不再只看整包版本号——时钟偏差下对方换头像会被判"旧包"而丢弃（只补缺不覆盖的旧逻辑同款 bug）
      const remoteTs = state.avTs ?? {}
      let changed = removedForeign > 0
      for (const [name, url] of Object.entries(state.avatars)) {
        const rt = remoteTs[name] ?? pv
        const mine = avTs[name]
        if (mine === undefined || rt > mine) {
          if ((avatars[name] ?? '') !== url) changed = true
          if (url) avatars[name] = url
          else delete avatars[name] // 空串 = 对方清空头像
          avTs[name] = rt
        }
      }
      // 持有者回补：retained 是整条替换，对方发的包里可能丢了我们本地有的头像
      // （对方重装/换机/云端丢数据），不补的话这条就永远从云端消失
      for (const [name, url] of Object.entries(avatars)) {
        if (url && !(name in state.avatars)) {
          changed = true
          break
        }
      }
      if (pv > lastV) lastV = pv
      if (changed) {
        saveBackup()
        notify()
        bumpV() // 升版本回发合并结果：时钟偏大的设备也能立刻收到对方的换头像
        sharedPublish(TOPIC, JSON.stringify({ avatars, avTs, v: lastV }))
      }
    } catch {
      /* ignore */
    }
  })

  onSharedConnect(() => {
    setTimeout(() => {
      if (!stateReceived) {
        const backup = loadBackup()
        cloudReady = true
        if (backup && Object.keys(backup.avatars).length > 0) {
          // 合并本地备份到云端数据（避免覆盖云端的新头像）
          const backupTs = backup.avTs ?? {}
          Object.entries(backup.avatars).forEach(([name, url]) => {
            if (url && avTs[name] === undefined) {
              avatars[name] = url
              avTs[name] = backupTs[name] ?? backup.v ?? 0
            }
          })
          lastV = Math.max(lastV, backup.v ?? 0)
        }
        notify()
        // 持有者回补：等 3 秒还没收到任何云端状态 = 云端是空的（retained 被 broker 清空/
        // 切到没有数据的备用 broker，2026-10-02 实测 emqx/hivemq 上 avatar 主题全无 retained）。
        // 此时必须把本地头像重新发布上云，否则任何人的头像都永远不会同步。
        // 按人带原 avTs 回发是安全的：对方按 rt>mine 合并，不会盖掉对方更新的头像
        // （对方 avTs 更大时反而会反超回来），与 frames.ts 的空云自愈同思路。
        if (Object.keys(avatars).length > 0) {
          bumpV()
          sharedPublish(TOPIC, JSON.stringify({ avatars, avTs, v: lastV }))
        }
      }
      if (pendingPublish && cloudReady) publishState()
    }, 3000)
  })

  onSharedStatus((status, msg) => {
    // 补发 pendingPublish 走 onSharedConnect（连上后 3 秒统一补一次），这里只报错
    if (status === 'error') emitError(`连接消息服务器失败：${msg}`)
    else if (status === 'offline') emitError('消息服务器连接中断，正在自动重连…')
    else if (status === 'reconnect') emitError('')
  })
}

function publishState() {
  const v = bumpV() // 自己的回声会被 avTs/内容比对挡掉（同值不变化）
  const state: AvatarState = { avatars, avTs, v }
  pendingPublish = false
  sharedPublish(TOPIC, JSON.stringify(state))
}

export function subscribeAvatars(
  onData: (avatars: Record<string, string>) => void,
  onError?: (msg: string) => void,
): () => void {
  subscribers.push(onData)
  if (onError) errorListeners.push(onError)
  ensureClient()
  onData({ ...avatars })
  return () => {
    subscribers = subscribers.filter((cb) => cb !== onData)
    if (onError) errorListeners = errorListeners.filter((cb) => cb !== onError)
  }
}

/** 设置自定义头像（云端同步）；传空串 = 清空回空白占位 */
export function setCustomAvatar(name: string, dataUrl: string): boolean {
  if (isGuestSession()) return false
  ensureClient()

  if (dataUrl) {
    avatars[name] = dataUrl
    avTs[name] = Date.now()
  } else {
    delete avatars[name]
    delete avTs[name]
  }
  saveBackup()
  notify()
  if (cloudReady) publishState()
  else pendingPublish = true // 云端没就绪时先本地生效并挂起，连上自动补发，不再静默丢弃
  return true
}

/** 获取自定义头像 */
export function customAvatar(name: string): string | null {
  try {
    return avatars[name] || null
  } catch {
    return null
  }
}

// 保持向后兼容的本地存储函数（已弃用，但保留以防其他代码使用）
export function legacyCustomAvatar(name: string): string | null {
  try {
    return localStorage.getItem(`love-avatar-${name}`)
  } catch {
    return null
  }
}

export function legacySetCustomAvatar(name: string, dataUrl: string): void {
  try {
    localStorage.setItem(`love-avatar-${name}`, dataUrl)
  } catch {
    /* ignore */
  }
}
