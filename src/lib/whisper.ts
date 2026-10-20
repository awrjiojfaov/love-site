/**
 * 悄悄话：双人实时聊天（MQTT retained + localStorage 备份）。
 * 三件套范式：版本守卫 lastV + 按 id 合并 + 删除墓碑(del)，参照 wallet.ts。
 * 另有非 retained 的 typing 信令主题：对方正在输入时广播，不发 retained。
 */
import { sharedPublish, sharedSubscribe, onSharedConnect, onSharedStatus } from './mqttClient'
import { isGuestSession } from './guest'
import { isPairMember, membersKnown } from './space'

const TOPIC = 'lovesite/whisper/state'
const TYPING_TOPIC = 'lovesite/whisper/typing'
const LS_KEY = 'lovesite-whisper-backup'
const MAX_MSGS = 300 // 聊天只保留最近 300 条，更早的直接丢弃（不像账本需要精确归档）

export type WhisperMsg = {
  id: string
  who: string
  text: string
  ts: number
  /** 删除墓碑：true 表示已撤回，合并时以墓碑为准 */
  del?: boolean
}

type State = {
  msgs: WhisperMsg[]
  v: number
}

/** 清理混入的外组账号消息 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scrubForeign(parsed: any): number {
  if (!membersKnown()) return 0
  let removed = 0
  if (Array.isArray(parsed?.msgs)) {
    const before = parsed.msgs.length
    parsed.msgs = (parsed.msgs as Array<{ who?: string }>).filter((m) => isPairMember(String(m?.who ?? '')))
    removed += before - parsed.msgs.length
  }
  return removed
}

let initialized = false
let msgs: WhisperMsg[] = []
let stateReceived = false
let cloudReady = false
let lastV = 0
let subscribers: Array<(msgs: WhisperMsg[]) => void> = []
let typingSubscribers: Array<(who: string, text?: string) => void> = []
let errorListeners: Array<(msg: string) => void> = []

function loadBackup(): State | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as State
    if (!Array.isArray(parsed.msgs)) return null
    scrubForeign(parsed as unknown as Record<string, unknown>)
    return { msgs: parsed.msgs, v: parsed.v ?? 0 }
  } catch {
    return null
  }
}

function saveBackup() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ msgs, v: lastV }))
  } catch {
    /* ignore */
  }
}

function notify() {
  const snapshot = [...msgs]
  subscribers.forEach((cb) => cb(snapshot))
}

function emitError(msg: string) {
  errorListeners.forEach((cb) => cb(msg))
}

/** 按消息 id 合并（墓碑优先：一端删了，另一端同步删除） */
function mergeMsgs(local: WhisperMsg[], remote: WhisperMsg[]): WhisperMsg[] {
  const byId = new Map<string, WhisperMsg>()
  for (const m of local) byId.set(m.id, m)
  for (const m of remote) {
    const existing = byId.get(m.id)
    if (!existing) {
      byId.set(m.id, m)
    } else if (m.del && !existing.del) {
      byId.set(m.id, m) // 墓碑覆盖正文
    }
  }
  return [...byId.values()].sort((a, b) => a.ts - b.ts)
}

function hasMsgNotIn(local: WhisperMsg[], remote: WhisperMsg[]): boolean {
  const ids = new Set(remote.map((m) => m.id))
  return local.some((m) => !ids.has(m.id))
}

function ensureClient() {
  if (initialized) return
  initialized = true

  // 本地缓存先行
  if (!stateReceived && msgs.length === 0) {
    const backup = loadBackup()
    if (backup) {
      msgs = backup.msgs
      lastV = backup.v
    }
  }

  sharedSubscribe(TOPIC, (payload) => {
    if (payload.length === 0) return
    try {
      const state = JSON.parse(payload.toString()) as State
      if (!Array.isArray(state.msgs)) return
      const removedForeign = scrubForeign(state as unknown as Record<string, unknown>)
      stateReceived = true
      cloudReady = true
      const pv = state.v ?? 0
      if (pv <= lastV) {
        // 旧 retained / 自己的回声：只把缺失的消息（含墓碑）合并进来
        if (hasMsgNotIn(msgs, state.msgs)) {
          msgs = mergeMsgs(msgs, state.msgs)
          msgs = msgs.slice(-MAX_MSGS)
          saveBackup()
          notify()
        }
        if (removedForeign > 0) publishState()
        return
      }
      lastV = pv
      const cloudMissing = hasMsgNotIn(msgs, state.msgs)
      msgs = mergeMsgs(msgs, state.msgs)
      msgs = msgs.slice(-MAX_MSGS)
      saveBackup()
      notify()
      if (cloudMissing || removedForeign > 0) publishState()
    } catch {
      /* ignore */
    }
  })

  // typing 信令：非 retained，收到即通知（5 秒内有效由页面判断）。
  // 2026-10-20 起载荷可带 text：对方正在打的字原样捎带，主页弹幕实时浮现（同一条信号，两种用处）
  sharedSubscribe(TYPING_TOPIC, (payload) => {
    if (payload.length === 0) return
    try {
      const sig = JSON.parse(payload.toString()) as { who?: string; text?: unknown }
      if (sig.who) {
        const text = typeof sig.text === 'string' ? sig.text : undefined
        typingSubscribers.forEach((cb) => cb(String(sig.who), text))
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
        if (backup && backup.msgs.length > 0) {
          msgs = mergeMsgs(msgs, backup.msgs)
          msgs = msgs.slice(-MAX_MSGS)
          lastV = Math.max(lastV, backup.v)
          // 不把可能过期的本地备份发布上云（参照 wallet），仅本地展示
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
  lastV = v
  const state: State = { msgs, v }
  sharedPublish(TOPIC, JSON.stringify(state))
}

export function subscribeWhisper(
  onData: (msgs: WhisperMsg[]) => void,
  onError?: (msg: string) => void,
): () => void {
  subscribers.push(onData)
  if (onError) errorListeners.push(onError)
  ensureClient()
  onData([...msgs])
  return () => {
    subscribers = subscribers.filter((cb) => cb !== onData)
    if (onError) errorListeners = errorListeners.filter((cb) => cb !== onError)
  }
}

/** 对方正在输入的信令（非 retained）。text 存在时=带原文的实时草稿（主页弹幕用） */
export function subscribeTyping(onTyping: (who: string, text?: string) => void): () => void {
  typingSubscribers.push(onTyping)
  ensureClient()
  return () => {
    typingSubscribers = typingSubscribers.filter((cb) => cb !== onTyping)
  }
}

/** 对方正在输入的信令（非 retained）。
 *  2026-10-09 加节流：页面 onChange 每敲一个字符就调一次，旧实现等于打一句话
 *  发几十条 QoS1 消息，白白占满发送队列（真正要紧的消息被排在后面 → 同步慢）。
 *  节流后首字符立即发、连续输入期间最多 1.5s 一发，对端 5 秒有效的展示窗口不受影响
 *  2026-10-20 改版：text 参数带上正在打的字 → 主页「实时弹幕」直接显示出来；节流收紧到
 *  600ms（弹幕要跟手）。旧调用不带 text 仍按 1.5s 节流，用作悄悄话页的「正在输入」提示 */
const TYPING_THROTTLE_MS = 1500
const DRAFT_THROTTLE_MS = 600
let lastTypingAt = 0
export function sendTyping(who: string, text?: string): void {
  if (isGuestSession()) return
  const now = Date.now()
  if (now - lastTypingAt < (text !== undefined ? DRAFT_THROTTLE_MS : TYPING_THROTTLE_MS)) return
  lastTypingAt = now
  ensureClient()
  const payload: { who: string; ts: number; text?: string } = { who, ts: now }
  if (typeof text === 'string') payload.text = text.slice(0, 40)
  sharedPublish(TYPING_TOPIC, JSON.stringify(payload), false)
}

/** 发一条悄悄话 */
export function sendWhisper(who: string, text: string): boolean {
  if (isGuestSession()) return false
  ensureClient()
  if (!cloudReady) return false
  const trimmed = text.trim()
  if (!trimmed) return false
  msgs = [
    ...msgs,
    {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      who,
      text: trimmed.slice(0, 500),
      ts: Date.now(),
    },
  ]
  msgs = msgs.slice(-MAX_MSGS)
  saveBackup()
  publishState()
  notify()
  return true
}

/** 撤回自己的消息（立墓碑，双方同步消失） */
export function recallWhisper(who: string, id: string): boolean {
  if (isGuestSession()) return false
  ensureClient()
  if (!cloudReady) return false
  const target = msgs.find((m) => m.id === id && m.who === who)
  if (!target || target.del) return false
  msgs = msgs.map((m) => (m.id === id ? { ...m, del: true } : m))
  saveBackup()
  publishState()
  notify()
  return true
}
