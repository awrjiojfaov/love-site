/**
 * 分片同步（Partial Sync）—— 点一下「同步」，只把我这一份发过去。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────
 * 全站各模块的同步形态是「每次写入广播整份状态」：拍卖会一场含剧本 16KB+、
 * 农场 4~10KB。一次「上拍一件」其实只改了「我这一份」，却要等整包发完对端才看得到；
 * 而 >4KB 的包在 mqttClient 里还要给快车道让路（BIG_PACKET_DELAY 1.5s），
 * 叠加手机上行慢，体感就是「上架了对方半天没动静，点一下刷新才冒出来」。
 *
 * ── 做法 ────────────────────────────────────────────────────
 * 每个模块开一条 `<topic>/~p` 轻量通道（retain=false 一次性信令，不进 retained）：
 *   { who, v, data }   —— 只有发送者自己的那一片，通常几百字节，几十毫秒到对端。
 * 接收端按人合并进本地状态（**只并自己那一片，不覆盖别人的数据、不覆盖剧本**），
 * 随后由常规全量/差量把合并结果写回 retained，所以刷新/换设备也不会丢。
 *
 * ── 与增量层（syncDelta）的分工 ──────────────────────────────
 * - syncDelta：整包太大时自动改发 diff —— 解决「一次小改动要推整包」；
 * - syncPartial：用户点「同步」时只发我这一块 —— 解决「我这块的新数据要等整包才到」。
 *
 * ── 可靠性 ──────────────────────────────────────────────────
 * - 一次手动同步连发两遍（0ms / 700ms）：订阅是 QoS0，单发丢了就白等；
 * - 版本号用 Lamport（max(本地时钟, 上次+1)），两台手机时钟有偏差也不会被判成旧包；
 * - 收到比已知版本更旧的包直接丢弃（**防回退**：迟到的旧分片不能覆盖新数据）；
 * - `req: true` 表示「也请把你那份发给我」，用于刷新时双向对齐（默契挑战同填场景）。
 */
import { sharedSubscribe, sharedPublish } from './mqttClient'

/** 分片通道后缀 */
export const PARTIAL_SUFFIX = '/~p'

export interface PartialEnvelope<T = unknown> {
  /** 发送者 */
  who: string
  /** 发送方分片版本（Lamport，单调递增） */
  v: number
  /** 发送时刻（仅诊断用，比较一律用本地收到时刻） */
  t: number
  /** 可选作用域 id（拍卖会用场次 id，防止跨场串数据） */
  sid?: string
  /** 顺带请求对方也回发一份自己的分片 */
  req?: boolean
  /** 只有发送者自己的那部分数据 */
  data: T
}

type Listener = (msg: PartialEnvelope) => void

const listeners = new Map<string, Set<Listener>>()
const booted = new Set<string>()
/** `${topic}|${who}` → 上次发出的版本（Lamport 单调） */
const lastSentV = new Map<string, number>()
/** `topic` → `who` → 上次处理的版本（去重 + 防回退） */
const lastSeenV = new Map<string, Map<string, number>>()
/** `topic` → `who` → 本地收到时刻（UI 显示「x 秒前同步」） */
const seenAt = new Map<string, Map<string, number>>()

function partialTopic(baseTopic: string): string {
  return baseTopic.endsWith(PARTIAL_SUFFIX) ? baseTopic : baseTopic + PARTIAL_SUFFIX
}

function bumpLastSeen(topic: string, who: string, v: number): Map<string, number> {
  let m = lastSeenV.get(topic)
  if (!m) { m = new Map(); lastSeenV.set(topic, m) }
  m.set(who, v)
  return m
}

function markSeen(topic: string, who: string): void {
  let m = seenAt.get(topic)
  if (!m) { m = new Map(); seenAt.set(topic, m) }
  m.set(who, Date.now())
}

/**
 * 发一份「我这一片」。返回本次的版本号。
 * @param baseTopic 模块主主题（如 'lovesite/auction/state'），分片走它 + '/~p'
 */
export function publishPartial<T>(
  baseTopic: string,
  who: string,
  data: T,
  opts: { sid?: string; req?: boolean; echo?: boolean } = {},
): number {
  const topic = partialTopic(baseTopic)
  const key = `${topic}|${who}`
  const v = Math.max(Date.now(), (lastSentV.get(key) ?? 0) + 1)
  lastSentV.set(key, v)
  const env: PartialEnvelope<T> = {
    who,
    v,
    t: Date.now(),
    data,
    ...(opts.sid ? { sid: opts.sid } : {}),
    ...(opts.req ? { req: true } : {}),
  }
  const raw = JSON.stringify(env)
  sharedPublish(topic, raw, false)
  // 双发：QoS0 订阅下丢一条是常态，手动同步必须「点一下就到」，多几百字节值得
  if (opts.echo !== false) setTimeout(() => sharedPublish(topic, raw, false), 700)
  return v
}

/** 把一份入站分片按 who 去重、防回退后派发 */
function handleIncoming(topic: string, raw: string): void {
  let env: PartialEnvelope
  try {
    env = JSON.parse(raw) as PartialEnvelope
  } catch {
    return
  }
  if (!env || typeof env.who !== 'string' || !env.who || typeof env.v !== 'number') return
  const prev = lastSeenV.get(topic)?.get(env.who) ?? 0
  // 迟到/乱序的旧分片：直接丢，绝不让旧数据把新状态顶回去
  if (env.v <= prev) return
  bumpLastSeen(topic, env.who, env.v)
  markSeen(topic, env.who)
  listeners.get(topic)?.forEach((fn) => {
    try { fn(env) } catch { /* 单个订阅者异常不影响其他人 */ }
  })
}

/**
 * 订阅某模块的分片通道；返回取消函数。
 * 同一主题只真正订阅一次（多个页面/组件共享）。
 */
export function subscribePartial<T>(baseTopic: string, cb: (msg: PartialEnvelope<T>) => void): () => void {
  const topic = partialTopic(baseTopic)
  let set = listeners.get(topic)
  if (!set) { set = new Set(); listeners.set(topic, set) }
  const fn = cb as Listener
  set.add(fn)
  if (!booted.has(topic)) {
    booted.add(topic)
    sharedSubscribe(topic, (payload) => handleIncoming(topic, payload.toString()))
  }
  return () => { set?.delete(fn) }
}

/** 本机收到某人分片的时刻（0 = 本会话还没收到过） */
export function partialSeenAt(baseTopic: string, who: string): number {
  return seenAt.get(partialTopic(baseTopic))?.get(who) ?? 0
}

/** 本会话收到过的所有分片来源（诊断用） */
export function partialPeers(baseTopic: string): Array<[string, number]> {
  const m = seenAt.get(partialTopic(baseTopic))
  return m ? [...m.entries()] : []
}
