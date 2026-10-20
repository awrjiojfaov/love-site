/**
 * 增量同步层（Delta Sync）—— 直击「每次变更都广播整份全量」这个同步变慢的根本原因。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────
 * 全站 29 个模块的发布形态统一是 sharedPublish(topic, JSON.stringify(state), retain=true)：
 * 任何一次写入（农场浇一次水、玉石切一刀、钱包扣一笔）都会把**整份状态**重新广播一遍。
 * 自建 broker 在上海（轻量 2核2G4M），实测吞吐 ≈ 670KB/s，于是：
 *     13KB 包   → 17~25ms   （体感即"毫秒级"）
 *    738KB 包  → 约 1100ms （jade/state）
 *    636KB 包  → 约 2500ms （jade/art/*）
 * 一次「切一刀石头」其实只改了一个字段，却要推 738KB —— 这就是慢的全部原因。
 *
 * ── 做法 ────────────────────────────────────────────────────
 * 在 mqttClient 的发布/订阅路径上插一层**透明**的增量编解码，业务模块一行都不用改：
 *
 *   发布（planPublish）
 *     与「本主题上一次发出的全量」做 JSON diff；差量更小就发差量，否则退回全量。
 *     差量走 `<topic>/~d`，retain=false（一次性信令，天然不进 retained、不阻塞冷启动）；
 *     全量仍走**原主题、原格式**，因此旧版本标签页收到的消息与今天完全一致（可安全混布）。
 *
 *   接收（maybeTranslate）
 *     收到差量时，把它 patch 到「本主题上一次收到的全量」基线上，还原出与今天一模一样的
 *     完整 JSON 字符串，再交给原有 handler —— 各模块的合并/版本守卫逻辑完全不感知。
 *
 *   基线校验 + 自愈
 *     差量信封带 `b`（基线指纹）。指纹对不上（丢包、两端同时改、跨 broker）说明基线已分叉：
 *     本端**丢弃该差量并回退到全量**，同时通过 `<topic>/~r` 请求对端补发一份全量；
 *     对端持有数据才回应（避免"全新设备空状态回补"把有效 retained 顶空的老事故）。
 *
 *   周期压实
 *     差量只是快车道，retained 上的全量才是新设备的冷启动数据源，必须保持新鲜：
 *     累计差量字节 ≥ 全量的 50%，或距上次全量超过 5 分钟，就补发一次全量做压实。
 *     自适应阈值：写得越频繁压实越勤，写得少就几乎不发全量。
 *
 * ── 安全性（关键）────────────────────────────────────────────
 * 任何一步异常（非 JSON、解析失败、diff 超预算、patch 失败、指纹不符）都**退回全量**，
 * 也就是退回今天的既有行为。因此本层只会更快，不会更不可靠。
 * 可用 `VITE_SYNC_DELTA=0` 一键关闭（关掉后行为与改造前逐字节一致）。
 *
 * 依赖：jsondiffpatch（MIT，benjamine/jsondiffpatch）—— 成熟的对象/数组 diff 库，
 * 差量格式极紧凑（对象只记变化的叶子、数组按 objectHash 做 id 匹配），
 * 比 RFC6902 JSON Patch 小得多。它也支持增量撤消/时间旅行，为后续"操作历史"留了口子。
 */
import { create, type Delta, type DiffPatcher } from 'jsondiffpatch'
import { SYNC_DELTA } from '../config'

/** 差量主题后缀（retain=false 快车道） */
export const DELTA_SUFFIX = '/~d'
/** 全量补发请求主题后缀（retain=false） */
export const RESYNC_SUFFIX = '/~r'

/**
 * 增量化的体积门槛。低于它的包按原样直发——自建 broker 实测约 670 字节/ms，
 * 4KB 只有约 6ms，本来就已经是「毫秒级」，不值得为它付解析 + diff 的 CPU，
 * 也避免为大量小主题各挂一对差分控制订阅。
 * 基线只对「超过阈值的全量」建立——两侧规则对称，差量引用的基线一定是对端也有的那一份。
 */
export const DELTA_MIN_BYTES = 4096
/** 差量必须至少比全量小到 1/2 才值得发，否则直接发全量（差量信封有固定开销） */
const DELTA_WORTH_RATIO = 0.5
/**
 * 单次 diff 的 CPU 预算 —— 按「这一包能省下多少网络时间」动态定，而不是拍一个固定值。
 *
 * 自建 broker（上海 4M 峰值）实测吞吐 ≈ 670 字节/ms：
 *   738KB 全量 ≈ 1100ms 网络；而实测 diff 只要 26ms（桌面），手机约 3 倍 ≈ 80ms。
 * 花 80ms CPU 省 1100ms 网络是稳赚，所以预算必须随体积放大，
 * 否则就会出现「最大的包反而被预算挡掉、永远走全量」的荒谬结果（初版 22ms 固定值就是这样）。
 * 上限 200ms 兜住低端机：超过就不值当了，本轮退全量并进入降级冷却。
 */
const DIFF_MIN_BUDGET_MS = 12
const DIFF_MAX_BUDGET_MS = 200
/** 与网络收益的兑换比：允许花掉「节省时间」的 35% 用于算 diff */
const DIFF_BUDGET_SHARE = 0.35
/** 自建 broker 实测吞吐（字节/毫秒） */
const BROKER_BYTES_PER_MS = 670

function diffBudgetMs(payloadBytes: number): number {
  const savedMs = payloadBytes / BROKER_BYTES_PER_MS
  return Math.min(DIFF_MAX_BUDGET_MS, Math.max(DIFF_MIN_BUDGET_MS, savedMs * DIFF_BUDGET_SHARE))
}
/** 降级后的冷却发布次数：连续 N 次直接走全量，之后恢复尝试 */
const BACKOFF_PUBLISHES = 3
/**
 * 空闲压实：连发一阵差量后安静满这么久，就评估一次要不要补发全量刷新 broker 上的 retained。
 * 注意「评估」不是「必发」——见 compactOnIdle 的收益判断，避免稀疏编辑时反复发全量。
 */
const IDLE_COMPACT_MS = 2500
/** 连续编辑不停歇时的硬上限：距上次全量超过这么久，就顺路发一份全量，别让 retained 无限陈旧 */
const FULL_MAX_AGE_MS = 120_000
/**
 * 压实门槛：自上次全量以来累计的差量字节达到全量的这个比例，才值得再发一次全量。
 * 取 10% 是个平衡点：738KB 的玉石要攒约 74KB 差量才压实（几百次操作一次），
 * 30KB 的农场攒 3KB 即可（几十次操作一次）——全量开销收敛成「每阵编辑一次」。
 * 攒不够时 retained 会略旧，由「对端补发请求 + 模块自带反熵回发」兜底，不影响正确性。
 */
const COMPACT_BYTES_RATIO = 0.1
/** 同一主题的全量补发请求节流 */
const RESYNC_REQ_INTERVAL_MS = 3000
/** 响应他人补发请求的节流 */
const RESYNC_REPLY_INTERVAL_MS = 2000

interface Baseline {
  /** 最近一次的全量原文（可能就是直接发给对方的 retained 内容） */
  raw: string
  /** 原文指纹 */
  hash: string
  /** 懒解析缓存：首次做差量时才解析，常态（全量直通）不解析 */
  obj?: unknown
}

/** 发布侧每主题的累计量 / 时间戳 */
interface PubStat {
  /** 自上次全量以来累计发出的差量字节 */
  deltaBytes: number
  /** 上次发全量的时刻（performance.now 基准） */
  fullAt: number
  /** 剩余降级次数 */
  backoff: number
  /** 空闲压实的待触发定时器 */
  compactTimer: ReturnType<typeof setTimeout> | null
}

const baselines = new Map<string, Baseline>()
const pubStats = new Map<string, PubStat>()
/** 已订阅差量通道的主题 */
const deltaTopics = new Set<string>()
/** 已登记订阅（模块真正关心的主题） */
const subscribedTopics = new Set<string>()
/**
 * 「必须直发全量 retained」的主题白名单。
 *
 * 有些模块把「发布」当成「写入云端真相」用：本地状态**没变化也要再发一次**，
 * 目的是把被别的设备用旧包覆盖掉的 broker retained 抢回来（反熵回发 / 原样重发 /
 * 农场「救云」与 assertFarm 自我声明）。这类重发如果被差量层改写成
 * `/~d` 的一次性信令（retain=false），云端 retained 就永远停在被覆盖的旧版本，
 * 新设备冷启动拿到旧数据 —— 即「数据回退」。
 *
 * 这些主题因此登记为「全量直通」：不进差量、每个发布都原样 retain=true 写云端，
 * 语义与该层引入之前逐字节一致。代价只是这些主题不再省带宽（其体积本就不大）。
 */
const fullOnlyTopics = new Set<string>()

/**
 * 把一个主题设为「全量直通」（在模块初始化时调用）。传 on=false 可撤销。
 * 幂等；切换时清掉该主题已建立的差量基线，避免半途混用两种编码。
 */
export function setTopicFullOnly(topic: string, on = true): void {
  const had = fullOnlyTopics.has(topic)
  if (on === had) return
  if (on) {
    fullOnlyTopics.add(topic)
    const st = pubStats.get(topic)
    if (st) clearCompact(st) // 定时器可能已挂：必须拆掉，否则会补发一份陈旧全量
    baselines.delete(topic)
    pubStats.delete(topic)
    deltaTopics.delete(topic)
  } else {
    fullOnlyTopics.delete(topic)
  }
}

/** 某主题是否登记为全量直通（自检用） */
export function isTopicFullOnly(topic: string): boolean {
  return fullOnlyTopics.has(topic)
}

/** 上次向对端请求全量的时刻 */
const lastResyncReq = new Map<string, number>()
/** 上次响应他人补发请求的时刻 */
const lastResyncReply = new Map<string, number>()

/** 由 mqttClient 注入的原始收发通道（绕过本层，避免递归） */
export interface DeltaTransport {
  /** 订阅一个原始主题（走共享连接） */
  subscribe(topic: string): void
  /** 发布一个原始消息；retain=true 会进 outbox 重试队列 */
  publish(topic: string, payload: string, retain: boolean): void
}

let transport: DeltaTransport | null = null

/** 统计（供自检 / 故障排查 / 性能实测） */
export const deltaStats = {
  fullSent: 0,
  deltaSent: 0,
  fullBytes: 0,
  deltaBytes: 0,
  deltaApplied: 0,
  deltaRejected: 0,
  resyncRequested: 0,
  resyncServed: 0,
  diffOverBudget: 0,
}

export function resetDeltaStats(): void {
  deltaStats.fullSent = 0
  deltaStats.deltaSent = 0
  deltaStats.fullBytes = 0
  deltaStats.deltaBytes = 0
  deltaStats.deltaApplied = 0
  deltaStats.deltaRejected = 0
  deltaStats.resyncRequested = 0
  deltaStats.resyncServed = 0
  deltaStats.diffOverBudget = 0
}

/** 省点算力：默认不做数组 move 检测（本项目的数组都是短 id 列表） */
let dp: DiffPatcher | null = null
function patcher(): DiffPatcher {
  if (!dp) {
    dp = create({
      objectHash: (item: object) => {
        const o = item as Record<string, unknown>
        const id = o?.id ?? o?.key ?? o?.pid
        return typeof id === 'string' ? id : undefined
      },
      arrays: { detectMove: false, includeValueOnMove: false },
      omitRemovedValues: true,
    })
  }
  return dp
}

/** FNV-1a 32 位指纹：738KB 约 1~2ms，只在全量出入时算一次 */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** 解析成「可 diff 的 JSON 对象」；非对象（纯字符串 / 图片 base64 / 数组字面量）返回 null */
function parseObject(raw: string): unknown {
  // 便宜的预筛：只有 { 开头才可能是对象
  if (raw.charCodeAt(0) !== 123 /* { */) return null
  try {
    const o = JSON.parse(raw) as unknown
    return o && typeof o === 'object' ? o : null
  } catch {
    return null
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/** 记录一份新的全量基线 */
function setBaseline(topic: string, raw: string, obj?: unknown): void {
  baselines.set(topic, { raw, hash: fnv1a(raw), obj })
}

/* ────────────────────────── 发布侧 ────────────────────────── */

export interface PublishStep {
  topic: string
  payload: string
  retain: boolean
}

/** 取消待触发的空闲压实（发全量之后必须取消，否则会多发一轮） */
function clearCompact(stat: PubStat): void {
  if (stat.compactTimer) { clearTimeout(stat.compactTimer); stat.compactTimer = null }
}

/**
 * 空闲压实的实际判定：安静下来后，只有「攒下的差量确实值得压一次」才补发全量。
 * - 稀疏编辑（改一下就停）：攒的差量远小于全量 → 不发。retained 会略旧一点，
 *   新设备/断线设备对上时的基线失配由「请求补发」当场治愈，代价一次往返、不损正确性。
 * - 高频编辑（连改几十上百下）：攒够了 → 发一次全量，把 broker retained 追平最新状态。
 * 这条判断是「既不被稀疏编辑拖回旧行为，也不让 retained 无限陈旧」的关键。
 */
function compactOnIdle(topic: string, stat: PubStat): void {
  stat.compactTimer = null
  const base = baselines.get(topic)
  if (!base || !transport) return
  if (stat.deltaBytes < Math.max(DELTA_MIN_BYTES, base.raw.length * COMPACT_BYTES_RATIO)) return
  transport.publish(topic, base.raw, true)
  stat.fullAt = now()
  stat.deltaBytes = 0
  deltaStats.fullSent++
  deltaStats.fullBytes += base.raw.length
}

function scheduleIdleCompact(topic: string, stat: PubStat): void {
  if (stat.compactTimer) clearTimeout(stat.compactTimer)
  stat.compactTimer = setTimeout(() => compactOnIdle(topic, stat), IDLE_COMPACT_MS)
}

/**
 * 规划一次发布：返回真正要发出去的一到多个步骤。
 * - 返回 `[原样]`：退化为改造前的行为
 * - 返回 `[{topic:~d}]`：只发差量（全量刻意不发，交给空闲压实补齐 retained）
 * - 返回 `[]`：内容与基线完全一致，无需发送
 */
export function planPublish(topic: string, payload: string, retain: boolean): PublishStep[] {
  if (!SYNC_DELTA || !retain || !transport) return [{ topic, payload, retain }]

  // 全量直通主题：模块把「发布」当「写云端真相」用（反熵回发 / 救云 / 持有者自我声明），
  // 本地内容没变也必须原样 retain=true 覆盖云端。此处绝不降级成差量信令——
  // 一旦降级，云端 retained 就停在被覆盖的旧版本，新设备冷启动拿到旧数据 = 数据回退。
  // 这类主题体积本就不大，放弃差量化换正确性是划算的。详见 fullOnlyTopics 的注释。
  if (fullOnlyTopics.has(topic)) return [{ topic, payload, retain }]

  // 小包直通：几毫秒的事，不值得为它付解析 + diff 的 CPU。
  // 同时清掉基线：基线只认「超过阈值的全量」，两侧规则对称才能对得上指纹。
  if (payload.length <= DELTA_MIN_BYTES) {
    const old = pubStats.get(topic)
    if (old) clearCompact(old)
    baselines.delete(topic)
    pubStats.delete(topic)
    deltaStats.fullSent++
    deltaStats.fullBytes += payload.length
    return [{ topic, payload, retain }]
  }

  const stat = pubStats.get(topic) ?? { deltaBytes: 0, fullAt: 0, backoff: 0, compactTimer: null }
  pubStats.set(topic, stat)

  const obj = parseObject(payload)
  if (obj === null) {
    // 非 JSON（大图 base64 等）：差量无意义，原样全量
    setBaseline(topic, payload)
    clearCompact(stat)
    stat.deltaBytes = 0
    stat.fullAt = now()
    stat.backoff = 0
    deltaStats.fullSent++
    deltaStats.fullBytes += payload.length
    return [{ topic, payload, retain }]
  }

  const base = baselines.get(topic)
  if (!base) {
    setBaseline(topic, payload, obj)
    clearCompact(stat)
    stat.deltaBytes = 0
    stat.fullAt = now()
    deltaStats.fullSent++
    deltaStats.fullBytes += payload.length
    return [{ topic, payload, retain }]
  }

  // 降级冷却期内直接走全量，避免在慢设备上反复付 diff 的 CPU
  if (stat.backoff > 0) {
    stat.backoff--
    setBaseline(topic, payload, obj)
    clearCompact(stat)
    stat.deltaBytes = 0
    stat.fullAt = now()
    deltaStats.fullSent++
    deltaStats.fullBytes += payload.length
    return [{ topic, payload, retain }]
  }

  const baseObj = base.obj !== undefined ? base.obj : parseObject(base.raw)
  if (baseObj === null) {
    setBaseline(topic, payload, obj)
    clearCompact(stat)
    stat.deltaBytes = 0
    stat.fullAt = now()
    deltaStats.fullSent++
    deltaStats.fullBytes += payload.length
    return [{ topic, payload, retain }]
  }

  const t0 = now()
  let d: Delta
  try {
    d = patcher().diff(baseObj, obj)
  } catch {
    d = undefined
  }
  const cost = now() - t0
  const budget = diffBudgetMs(payload.length)
  const overBudget = cost > budget

  // diff 无变化：状态一模一样，没有必要占用带宽（模块的 bumpV 常常空转）
  if (d === undefined) {
    setBaseline(topic, payload, obj)
    return []
  }

  if (overBudget) {
    deltaStats.diffOverBudget++
    stat.backoff = BACKOFF_PUBLISHES
  }

  const envelope = JSON.stringify({ b: base.hash, d })
  const t1 = now()
  const needCompact =
    t1 - (stat.fullAt || 0) > FULL_MAX_AGE_MS ||
    stat.deltaBytes > payload.length * COMPACT_BYTES_RATIO

  // 差量不比全量明显小 → 不值得，直接全量（同时把 retained 刷新一次）
  if (overBudget || envelope.length > payload.length * DELTA_WORTH_RATIO || needCompact) {
    setBaseline(topic, payload, obj)
    clearCompact(stat)
    stat.deltaBytes = 0
    stat.fullAt = t1
    deltaStats.fullSent++
    deltaStats.fullBytes += payload.length
    return [{ topic, payload, retain }]
  }

  setBaseline(topic, payload, obj)
  stat.deltaBytes += envelope.length
  if (!stat.fullAt) stat.fullAt = t1
  deltaStats.deltaSent++
  deltaStats.deltaBytes += envelope.length
  // 安静下来后补一份全量刷新 broker 上的 retained（新设备冷启动的数据源）
  scheduleIdleCompact(topic, stat)
  return [{ topic: topic + DELTA_SUFFIX, payload: envelope, retain: false }]
}

/* ────────────────────────── 接收侧 ────────────────────────── */

/**
 * 处理一条入站消息。
 * 返回 `null` 表示这条消息已被本层消费（是差量/请求，不该再派发给模块）；
 * 返回字符串表示要派发给模块的载荷（可能已被还原成全量，也可能原样透传）。
 */
export function onIncoming(topic: string, payload: string): string | null {
  if (!SYNC_DELTA || !transport) return payload

  // 全量直通主题：不建基线、不补订差量通道——它的每一条消息都必须是原样全量，
  // 差量层对它形同不存在（与改造前的行为逐字节一致）。
  if (fullOnlyTopics.has(topic)) return payload

  if (topic.endsWith(DELTA_SUFFIX)) {
    applyDelta(topic.slice(0, -DELTA_SUFFIX.length), payload)
    return null
  }
  if (topic.endsWith(RESYNC_SUFFIX)) {
    serveResync(topic.slice(0, -RESYNC_SUFFIX.length), payload)
    return null
  }

  // 普通全量：登记基线，并在首次遇到大包时补订差量通道
  if (payload.length > DELTA_MIN_BYTES) {
    setBaseline(topic, payload)
    if (parseObject(payload) !== null) ensureDeltaSubscription(topic)
  } else {
    // 小包不建基线（与发布侧对称）；已有的大基线作废，等下一次大全量重建
    baselines.delete(topic)
  }
  return payload
}

/** 模块订阅了某主题：登记，便于 e2e/自检与阈值判定 */
export function onTopicSubscribed(topic: string): void {
  subscribedTopics.add(topic)
}

/** 懒补订：只有真正出现过大包的主题才需要差量通道，避免订阅数翻倍 */
function ensureDeltaSubscription(topic: string): void {
  if (!transport || deltaTopics.has(topic)) return
  deltaTopics.add(topic)
  transport.subscribe(topic + DELTA_SUFFIX)
  transport.subscribe(topic + RESYNC_SUFFIX)
}

/** 把差量 patch 回基线，还原出与既有协议逐字节一致的完整 JSON */
function applyDelta(topic: string, envelope: string): void {
  const base = baselines.get(topic)
  if (!base) {
    requestResync(topic)
    deltaStats.deltaRejected++
    return
  }
  let env: { b?: string; d?: Delta }
  try {
    env = JSON.parse(envelope) as { b?: string; d?: Delta }
  } catch {
    deltaStats.deltaRejected++
    return
  }
  // 基线指纹不符 = 中间丢过差量或两端同时改：本端基线已不可信，退回全量
  if (!env || env.b !== base.hash || env.d === undefined) {
    requestResync(topic)
    deltaStats.deltaRejected++
    return
  }
  // 就地 patch（不 clone）：基线对象本来就要被这一版替换掉，克隆 738KB 纯属浪费。
  // 万一 patch 中途抛错，基线已被改坏——直接丢掉基线并请对端补发全量，
  // 绝不把可能损坏的状态交给模块。
  try {
    const baseObj = base.obj !== undefined ? base.obj : parseObject(base.raw)
    if (baseObj === null) throw new Error('base is not a json object')
    const next = patcher().patch(baseObj, env.d) as unknown
    const raw = JSON.stringify(next)
    baselines.set(topic, { raw, hash: fnv1a(raw), obj: next })
    deltaStats.deltaApplied++
    dispatchTranslated(topic, raw)
  } catch {
    baselines.delete(topic)
    requestResync(topic)
    deltaStats.deltaRejected++
  }
}

/**
 * 请求对端补发全量。节流：同一主题 3 秒内只发一次，
 * 避免在断线抖动时把请求本身刷成流量风暴。
 */
function requestResync(topic: string): void {
  if (!transport) return
  const t = now()
  const last = lastResyncReq.get(topic) ?? -Infinity
  if (t - last < RESYNC_REQ_INTERVAL_MS) return
  lastResyncReq.set(topic, t)
  deltaStats.resyncRequested++
  transport.publish(topic + RESYNC_SUFFIX, baselines.get(topic)?.hash ?? '', false)
}

/**
 * 响应他人的全量补发请求。
 * 只在「本端确实持有该主题数据」且「对端指纹与本端不同」时回发——
 * 全新设备没有数据时绝不回发，避免把 broker 上的有效 retained 顶成空状态。
 */
function serveResync(topic: string, requesterHash: string): void {
  if (!transport || !subscribedTopics.has(topic)) return
  const base = baselines.get(topic)
  if (!base || base.raw.length <= DELTA_MIN_BYTES) return
  if (base.hash === requesterHash) return
  const t = now()
  const last = lastResyncReply.get(topic) ?? -Infinity
  if (t - last < RESYNC_REPLY_INTERVAL_MS) return
  lastResyncReply.set(topic, t)
  deltaStats.resyncServed++
  transport.publish(topic, base.raw, true)
}

/** 把还原出的载荷派发给该主题的常规订阅者 */
let dispatcher: ((topic: string, payload: string) => void) | null = null
export function setDispatcher(fn: (topic: string, payload: string) => void): void {
  dispatcher = fn
}
function dispatchTranslated(topic: string, payload: string): void {
  dispatcher?.(topic, payload)
}

/** 绑定原始通道（由 mqttClient 在建立连接时调用一次） */
export function bindDeltaTransport(t: DeltaTransport): void {
  transport = t
}

/** 自检信息（性能实测 / 线上排查用） */
export function deltaReport(): string {
  const s = deltaStats
  const sent = s.fullSent + s.deltaSent
  const bytes = s.fullBytes + s.deltaBytes
  const avg = sent ? Math.round(bytes / sent) : 0
  return (
    `full=${s.fullSent}(${Math.round(s.fullBytes / 1024)}KB) ` +
    `delta=${s.deltaSent}(${Math.round(s.deltaBytes / 1024)}KB) ` +
    `applied=${s.deltaApplied} rejected=${s.deltaRejected} ` +
    `resync(req/serve)=${s.resyncRequested}/${s.resyncServed} ` +
    `overBudget=${s.diffOverBudget} avg=${avg}B`
  )
}

/** 测试与调优用：当前基线体积表 */
export function baselineSizes(): Array<[string, number]> {
  return [...baselines.entries()]
    .map(([t, b]) => [t, b.raw.length] as [string, number])
    .sort((a, b) => b[1] - a[1])
}
