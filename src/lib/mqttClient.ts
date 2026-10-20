/**
 * 全站共享的 MQTT 连接：见闻打分 / 默契挑战 / 互相提问 / 时元钱包 / 开心农场
 * 5 个模块共用 1 条连接，各自订阅独立主题。
 * 之前每个模块单独建连，手机端进功能页要反复和海外公共 broker 握手，非常慢；
 * 现在整个网站只连一次，之后所有功能秒开。
 */
import mqtt, { type MqttClient } from 'mqtt'
import { resolveTopic, getSpaceId } from './space'
import {
  planPublish,
  onIncoming,
  onTopicSubscribed,
  setDispatcher,
  bindDeltaTransport,
} from './syncDelta'


// 架构：默认用部署时自建的 broker 作为主通道（VITE_MQTT_PRIMARY_URL），
// 未配置时直接使用公共 broker。公共 broker 是全网共享的免费实例，延迟高、
// 且可能随时清空 retained / 拒收新连接，仅供试玩；正式使用请自建 broker。
// 每个新会话都从主 broker 开始，主不可用自动切公共备胎（应用层 Lamport 合并 + 持有者回补
// 保证跨 broker 数据最终一致），主恢复后新会话自动回归。
import { MQTT_PRIMARY_URL, MQTT_PRIMARY_USER, MQTT_PRIMARY_PASS } from '../config'

interface BrokerConf { url: string; username?: string; password?: string }
/** 公共 broker：无需账号，但数据不属于你、随时可能被清空 */
const PUBLIC_BROKERS: BrokerConf[] = [
  { url: 'wss://broker.emqx.io:8084/mqtt' }, // 公共 1
  { url: 'wss://broker.hivemq.com:8884/mqtt' }, // 公共 2
  { url: 'wss://test.mosquitto.org:8081/mqtt' }, // 公共 3
]
/** 主通道优先用自建 broker，其后依次是公共备胎 */
const BROKERS: BrokerConf[] = [
  ...(MQTT_PRIMARY_URL
    ? [{
        url: MQTT_PRIMARY_URL,
        ...(MQTT_PRIMARY_USER ? { username: MQTT_PRIMARY_USER, password: MQTT_PRIMARY_PASS } : {}),
      }]
    : []),
  ...PUBLIC_BROKERS,
]
const MIN_FAILOVER_INTERVAL = 6000 // 全部 broker 都拒收时避免疯狂轮询

type PayloadHandler = (payload: Buffer, topic?: string) => void
type StatusHandler = (status: 'error' | 'offline' | 'reconnect', msg?: string) => void

let client: MqttClient | null = null
let connected = false
let brokerIdx = 0
let lastFailoverAt = 0
const topicHandlers = new Map<string, Set<PayloadHandler>>()
/** 通配符订阅（主题含 + / #，如云同步 kv/+）：精确主题查不到时按 MQTT 规则匹配这里 */
const wildcardHandlers = new Map<string, Set<PayloadHandler>>()
/** 内部控制通道订阅（增量层 /~d 差量、/~r 补发请求）：不派发给模块，但重连后必须一并补订 */
const controlTopics = new Set<string>()
const connectListeners = new Set<() => void>()
/** 持有者回补（上传本地全量）专用通道：与 onSharedConnect 分开，按门控触发 */
const resyncListeners = new Set<() => void>()
const statusListeners = new Set<StatusHandler>()

/* ---------- 发布 outbox：fire-and-forget 的发布在断线窗口会永久丢失 ----------
 * 场景：手机切后台 socket 冻结 / broker 故障转移 end(true) 丢弃 mqtt.js 自带离线队列 /
 *       校园网抖动。时元钱包靠自带 pending 队列幸存，玉石/头像/回忆录等裸 publish 的
 *       模块全部踩坑（富贵值、头像"只存本地不上传"事故同款根因）。
 * 兜底规则：
 * - retained 状态快照：按主题只留最新一份（retained 语义本来就是最新生效），
 *   离线暂存，连上即补发，puback 失败重试；
 * - 一次性信令（retain=false）：消息互相不可覆盖，FIFO 排队（封顶 20 条），连上补发。
 * 发布成功（收到 puback）才出箱；连续 5 次失败（如包超被 broker 踢）放弃，
 * 避免毒消息反复触发断线。 */
interface OutboxEntry { payload: string; retain: boolean; tries: number; sent?: boolean }
const retainedOutbox = new Map<string, OutboxEntry>()
const signalQueue: Array<{ topic: string; entry: OutboxEntry }> = []
/** 2026-10-11：20 → 200。队列里现在还会走增量同步的差量包，差量**不可互相覆盖**
 *  （每条都基于上一条的基线），丢一条就会让对端基线分叉、触发一次全量补发（亏大了）。
 *  差量本身只有几十~几百字节，200 条的常驻内存可忽略。 */
const MAX_SIGNAL_QUEUE = 200
const MAX_PUBLISH_RETRIES = 5

/** 2026-10-03 修 retained 丢失竞态：出箱必须验明正身。
 *  旧实现 puback 回调里直接 retainedOutbox.delete(topic)——ack 是异步的，
 *  迟到期间同主题可能已有更新的快照入箱，旧包的 ack 会把新包从箱里抹掉；
 *  若新包的 puback 再一丢，这条状态就永久丢失（拍卖「上架后对方看不到」根因之一）。 */
function removeEntry(topic: string, entry: OutboxEntry): void {
  if (entry.retain) {
    if (retainedOutbox.get(topic) === entry) retainedOutbox.delete(topic)
  } else {
    const i = signalQueue.findIndex((s) => s.entry === entry)
    if (i >= 0) signalQueue.splice(i, 1)
  }
}

function entryAlive(topic: string, entry: OutboxEntry): boolean {
  return entry.retain
    ? retainedOutbox.get(topic) === entry
    : signalQueue.some((s) => s.entry === entry)
}

/** 退避重刷：puback 失败后不再干等重连（旧实现只能靠下次 connect 的 flushOutbox，
 *  一次抖动 = 状态卡住直到用户下次操作），按 1.6s→3.2s→6.4s… 退避自动重发 */
let flushTimer: ReturnType<typeof setTimeout> | null = null
function scheduleFlush(delay: number): void {
  if (flushTimer) return // 已有一发在排队，合并
  flushTimer = setTimeout(() => { flushTimer = null; flushOutbox() }, delay)
}

/* ---------- 大包隔离（2026-10-10 修「换手机登录数据延迟」） ----------
 * 一条 MQTT 连接上的报文是**串行**发送的：broker 端单客户端的投递队列也按字节占用，
 * 排在一条 640KB 图片后面的 0 字节消息同样要等它发完。实测（新设备首登全量收 retained）：
 *   avatar/state 103KB  +126ms
 *   jade/state   738KB  +1101ms
 *   jade/art/…   636KB  +2487ms
 *   crdt/jar     2.6KB  +5216ms   ← 关键状态被大包挤到 5 秒后
 *   0 字节探测包        +5321ms
 * 结论：瓶颈是**字节数**，不是消息条数；小状态消息必须优先于大媒体包投递。
 * 做法：超过 BIG_PACKET 的包延后 BIG_DELAY 再发，并限制并发在途大包数，
 * 给订阅/发布留出一个「快车道窗口」——小消息先落地，大包随后补齐。
 * 牺牲的是大图/大账本几秒的即时性（它们本来就是懒加载/后到的），
 * 换来的是所有 <阈值 的状态同步稳定在百毫秒级。 */
const BIG_PACKET_BYTES = 4096
const BIG_PACKET_DELAY = 1500
const MAX_CONCURRENT_BIG = 1
let bigInFlight = 0

/** 快车道上还有没发出去的小包吗？（大包要不要让路就看这个）
 *  2026-10-17：旧实现无论有没有人排队，大包一律干等 1.5s。空闲时空等纯属白给延迟
 *  （钱包 86KB / 拍卖 16KB 的首次全量最吃亏）；有人排队时才值得让路。
 *  已在途（sent）的小包不用等——它们早已排在 socket 队列前面，大包插不到它们前面。 */
function hasUndispatchedSmall(): boolean {
  for (const [, e] of retainedOutbox) if (e.payload.length <= BIG_PACKET_BYTES && !e.sent) return true
  for (const s of signalQueue) if (s.entry.payload.length <= BIG_PACKET_BYTES && !s.entry.sent) return true
  return false
}

function deliver(topic: string, entry: OutboxEntry): void {
  if (!client || !connected) return
  // 大包排队：等快车道窗口，且同一时刻只允许一个大包在途
  if (entry.payload.length > BIG_PACKET_BYTES) {
    if (bigInFlight >= MAX_CONCURRENT_BIG) {
      scheduleBigRetry()
      return
    }
    bigInFlight++
    const delay = hasUndispatchedSmall() ? BIG_PACKET_DELAY : 0
    setTimeout(() => {
      if (!entryAlive(topic, entry)) { bigInFlight--; return }
      doPublish(topic, entry, true)
    }, delay)
    return
  }
  doPublish(topic, entry, false)
}

/** 大包被并发闸门挡下时的重试（沿用退避定时器，避免自建轮询） */
function scheduleBigRetry(): void {
  scheduleFlush(800)
}

function doPublish(topic: string, entry: OutboxEntry, isBig: boolean): void {
  if (!client || !connected) { if (isBig) bigInFlight--; return }
  entry.sent = true // 已在途：后续大包不必再为它让路
  client.publish(topic, entry.payload, { retain: entry.retain, qos: 1 }, (err?: Error) => {
    if (isBig) bigInFlight = Math.max(0, bigInFlight - 1)
    if (!err) { removeEntry(topic, entry); return }
    if (!entryAlive(topic, entry)) return // 已被更新的快照顶替，旧包不再重试
    entry.tries++
    if (entry.tries >= MAX_PUBLISH_RETRIES) { removeEntry(topic, entry); return }
    scheduleFlush(Math.min(10000, 800 * 2 ** entry.tries))
  })
}

function flushOutbox(): void {
  if (!client || !connected) return
  // 先发小包（快车道），大包留到最后——同一次 flush 里也保证优先级
  const small: Array<[string, OutboxEntry]> = []
  const big: Array<[string, OutboxEntry]> = []
  for (const [topic, entry] of retainedOutbox) {
    if (entry.payload.length > BIG_PACKET_BYTES) big.push([topic, entry])
    else small.push([topic, entry])
  }
  for (const s of signalQueue) {
    if (s.entry.payload.length > BIG_PACKET_BYTES) big.push([s.topic, s.entry])
    else small.push([s.topic, s.entry])
  }
  for (const [topic, entry] of small) deliver(topic, entry)
  for (const [topic, entry] of big) deliver(topic, entry)
}

function ensureShared(): MqttClient {
  if (client) return client
  client = connectBroker(brokerIdx)
  return client
}

/** 2026-10-05 持久会话改造：固定 clientId（设备段 + 标签页段）+ clean:false，broker 记住
 *  这个标签页的订阅会话——同标签页刷新/断线重连时 CONNACK sessionPresent=true，一条 retained
 *  都不重发（旧实现随机 clientId + clean:true，每次打开页面 broker 都把全站 97 条 retained
 *  约 2.9MB 重新推一遍，手机端要下载+解析好几秒，是「联网就慢」的主因）。
 *  只有真正的新会话（新标签页/换设备/切备胎 broker）才全量收 retained，那时本来也需要这份数据。
 *  标签页段独立：两个标签页同时开不会互踢（同 clientId 互踢是 MQTT 铁律）；sessionStorage 让
 *  同标签页刷新后 clientId 不变。 */
function getClientId(): string {
  let dev = ''
  try { dev = localStorage.getItem('mqtt-device-id') ?? '' } catch { dev = '' }
  if (!dev) {
    dev = Math.random().toString(16).slice(2, 10)
    try { localStorage.setItem('mqtt-device-id', dev) } catch { /* ignore */ }
  }
  let tab = ''
  try { tab = sessionStorage.getItem('mqtt-tab-id') ?? '' } catch { tab = '' }
  if (!tab) {
    tab = Math.random().toString(16).slice(2, 6)
    try { sessionStorage.setItem('mqtt-tab-id', tab) } catch { /* ignore */ }
  }
  return `lovesite-${dev}-${tab}`
}

/** broker 侧会话里已有的订阅（按 clientId 记在 sessionStorage）：
 *  sessionPresent=true 时只补订「这个 clientId 从没订过的主题」，已知的跳过——重复
 *  SUBSCRIBE 会被 broker 当成新订阅再发一遍该主题 retained。键不带 lovesite- 前缀，
 *  cloudSync 不跟踪（两台设备共用 clientId 会互踢，绝不同步）。
 *  2026-10-10 修「存钱罐重复入账」：旧实现记在 localStorage，而 clientId 的 tab 段来自
 *  **sessionStorage**——关标签页再开，tab 段重新随机 → clientId 变了，新会话却继承着旧
 *  clientId 的订阅清单，于是「明知该订的主题」一个都不订、也不触发 SUBSCRIBE。CRDT 的
 *  retained 全量快照在断线期间被对方覆盖（对方晚于本机离线、本机又先于对方上线）时，
 *  本机这条会话拿不回它，而重连只做一次共享反熵（拉一次 retained）——错过即永久错过，
 *  本地陈旧副本被当成真相回发上云，合并后金额翻倍。改用 sessionStorage：clientId 的
 *  tab 段与它同生命周期，新标签页/新 clientId 必伴生空清单 → 全量重订 → 拿回 retained。 */
const SESS_KEY = `mqtt-sess-topics:${getClientId()}`
const sessTtlMs = 30 * 24 * 3600 * 1000 // 与 sessionExpiryInterval 对齐：超过它 B 端早忘了这个会话
const sessTopics = new Map<string, number>()
try {
  const raw = sessionStorage.getItem(SESS_KEY)
  const now = Date.now()
  for (const e of raw ? (JSON.parse(raw) as Array<[string, number]>) : []) {
    if (Array.isArray(e) && typeof e[0] === 'string' && now - (e[1] ?? 0) < sessTtlMs) {
      sessTopics.set(e[0], e[1] ?? now)
    }
  }
} catch { /* ignore */ }
function saveSessTopics(): void {
  try { sessionStorage.setItem(SESS_KEY, JSON.stringify([...sessTopics])) } catch { /* ignore */ }
}
/** 记一条「已订阅」；重复订阅会重发该主题 retained，是回补时机，所以同时刷新时间戳 */
function markSessTopic(topic: string): void {
  // 顺手清理过老条目：broker 端会话过期后这些订阅已不存在，留着会永久跳过 → 数据永远拿不回
  const now = Date.now()
  if (sessTopics.size > 200) {
    for (const [t, ts] of sessTopics) if (now - ts >= sessTtlMs) sessTopics.delete(t)
  }
  sessTopics.set(topic, now)
}
/* ---------- 冷启动快车道（2026-10-17）----------
 * 新会话（新标签页 / 换设备 / broker 会话过期）要一次性收下全部 retained：实测 149 个主题
 * 2.0MB，其中 jade/art 636KB、map/photo 合计约 400KB、avatar 102KB 全是媒体/大块。
 * broker 按订阅顺序逐条回投 retained —— 媒体排在前面，钱包/拍卖/农场这些几 KB 的小状态
 * 就被挤到几秒之后（历史实测：0 字节探测包被推到 5.3s），表现就是「打开页面数据半天不来」。
 * 图片本来就是懒加载、模块也都有本地备份，晚 3 秒没人看得出；让它们延后订阅，
 * 小状态先落地，页面一开就有数据。 */
const SLOW_TOPIC_RE: RegExp[] = [/\/jade\/art\//, /\/map\/photo\//, /\/avatar\/state$/]
const SLOW_SUB_DELAY_MS = 3000
const slowScheduled = new Set<string>()
function isSlowTopic(topic: string): boolean {
  return SLOW_TOPIC_RE.some((re) => re.test(topic))
}
/** 订阅一个主题；媒体主题延后，其余按需要走「退订再订」强制回投 retained。
 *  媒体主题不做退订重订：否则每次懒加载页面都会把几百 KB 的图再拉一遍 */
function subscribeTopic(topic: string, forceRetained = false): void {
  if (!client || !connected) return
  if (isSlowTopic(topic)) {
    if (slowScheduled.has(topic)) return
    slowScheduled.add(topic)
    setTimeout(() => {
      // 连不上了就撤销登记：没真的订出去，下次 subscribeMissing 会重来
      if (!client || !connected) { slowScheduled.delete(topic); return }
      markSessTopic(topic) // 真正订出去的那一刻才登记，否则断线会漏订
      saveSessTopics()
      client.subscribe(topic, { qos: 0 })
    }, SLOW_SUB_DELAY_MS)
    return
  }
  if (forceRetained) client.unsubscribe(topic, () => { client?.subscribe(topic, { qos: 0 }) })
  else client.subscribe(topic, { qos: 0 })
}

/** 补订 broker 会话里还没有的主题；返回实际发出的订阅数（0 = 全跳过了） */
function subscribeMissing(): number {
  let n = 0
  const doSub = (topic: string) => {
    if (sessTopics.has(topic)) return
    if (isSlowTopic(topic)) { subscribeTopic(topic); return } // 延后订阅：真正订出时才登记
    markSessTopic(topic)
    n++
    client!.subscribe(topic, { qos: 0 })
  }
  for (const topic of topicHandlers.keys()) doSub(topic)
  for (const pattern of wildcardHandlers.keys()) doSub(pattern)
  for (const topic of controlTopics) doSub(topic)
  saveSessTopics()
  return n
}
/** 断线横幅宽限：掉线 3s 内恢复就当没发生过（锁屏唤醒/信号抖动 95% 是这种），
 *  超过 3s 才通知各模块亮「连接中断」横幅；重连成功即灭 */
const OFFLINE_GRACE_MS = 3000
let offlineTimer: ReturnType<typeof setTimeout> | null = null
let offlineNotified = false

/* ---------- 回补门控（2026-10-09 同步提速） ----------
 * 旧实现每次重连都让各模块「持有者回补」= 立即广播本地全量：jade 272KB、wallet/stock
 * 全量账本、auction 含剧本整场、cloudSync 逐 key 重发、crdt 全量快照……而重连本身
 * （锁屏唤醒、校园网抖动、2s 退避）一天能发生几十次。QoS1 的大包会在发送队列里排队，
 * 把后面真正重要的小消息（对方刚发的聊天/操作）堵在路上——表现就是「同步慢」。
 * 自建 broker 已落盘持久化，短抖动重连后 retained 一条不少，全量回补纯属重复上传。
 * 改为只在真需要时回补（onSharedResync）：
 * - 掉线超过 1 分钟（真离开过，不是信号抖一下；掉线期间的更新可能已经错过）
 * - 切换 broker（公共备胎会清 retained，必须重新播种）
 * - 每天首次连接做一次全量反熵，兜住「发布静默失败」造成的静默分叉
 * 其余重连只走 onSharedConnect（收 retained + 本地兜底），不再重复上传。 */
const OFFLINE_RESYNC_MS = 60_000
/** 回补窗口：门控放行后 10 分钟内才注册的模块也算进这一轮（模块是按需初始化的，
 *  登录后的 warmup、点开某个功能页都可能晚于 connect；每个模块每次页面生命周期
 *  最多只注册一次，所以窗口再长也只会多发一轮） */
const RESYNC_WINDOW_MS = 600_000
const DAILY_RESYNC_KEY_PREFIX = 'mqtt-resync-day:'
let lastOfflineAt = 0
let lastConnectBrokerIdx = -1
/** 最近一次「需要回补」的时间戳：窗口内才注册的模块也补跑一次 */
let resyncNeededAt = 0
/** localStorage 不可用时的兜底：每个标签页只回补一次，别退化成每次重连都回补 */
let dailyStampBroken = false

function computeNeedResync(now: number): boolean {
  let daily = false
  const today = new Date().toDateString()
  // 按空间记戳：切换账号组会整页重载，各空间各做各的每日回补
  const key = `${DAILY_RESYNC_KEY_PREFIX}${getSpaceId()}`
  try {
    const prev = localStorage.getItem(key)
    if (prev !== today) {
      localStorage.setItem(key, today)
      daily = true
    }
  } catch {
    daily = !dailyStampBroken
    dailyStampBroken = true
  }
  const offlineGap = lastOfflineAt ? now - lastOfflineAt : 0
  lastOfflineAt = 0
  const brokerChanged = lastConnectBrokerIdx >= 0 && lastConnectBrokerIdx !== brokerIdx
  lastConnectBrokerIdx = brokerIdx
  return daily || brokerChanged || offlineGap > OFFLINE_RESYNC_MS
}

/** 连接错峰间隔：27 个模块同一拍齐发会打成同步风暴（锁屏唤醒卡顿根因之二） */
const STAGGER_MS = 120

function connectBroker(idx: number): MqttClient {
  const b = BROKERS[idx]
  const c = mqtt.connect(b.url, {
    clientId: getClientId(),
    connectTimeout: 12000,
    // 2026-10-03 4000→2000：断线后干等 4s 才开始重连是「对方看不到更新」感知延迟的大头之一
    reconnectPeriod: 2000,
    clean: false, // 2026-10-05：持久会话（配合 sessionExpiryInterval），重连/刷新不重发 retained
    // MQTT5 会话过期时间默认 0（断开即清会话），必须显式给，否则 clean:false 等于白搭
    properties: { sessionExpiryInterval: 30 * 24 * 3600 }, // 会话保留 30 天
    protocolVersion: 5, // 需要 v5 的 rh 订阅选项；nanomq/emqx/hivemq/mosquitto 全部支持
    // 自建 broker 需要账号密码（公共备胎允许匿名，不填即可）
    ...(b.username ? { username: b.username, password: b.password } : {}),
  })

  c.on('connect', (connack) => {
    connected = true
    // 掉线宽限期内恢复：横幅从未亮起，当没发生过
    if (offlineTimer) { clearTimeout(offlineTimer); offlineTimer = null }
    // 横幅亮过才真正灭（模块只认 'reconnect' 状态清横幅）
    if (offlineNotified) { offlineNotified = false; statusListeners.forEach((cb) => cb('reconnect')) }
    // 会话在 broker 侧还在（同标签页刷新/断线重连）：跳过已知订阅，retained 一条不重发；
    // 会话是新的（新标签页/换设备/切备胎 broker）：全量订阅收 retained（新会话本来需要）。
    // 只补订本 clientId 没订过的主题（sessTopics），避免重复 SUBSCRIBE 触发 retained 重发。
    // 订阅一律 QoS0：QoS1 + 持久会话会让 broker 累积离线消息队列，重连时整桶倾倒
    // （实测 17 秒离线回补 259 条 / 4.3MB，比重发 retained 更卡）；模块本来就有
    // 「3 秒没收到就本地回补」的互丢自愈设计（按 id/按人合并 + 版本守卫），
    // 丢包语义下 QoS0 与旧 clean 会话行为一致，不损失任何既有可靠性。
    const sessionPresent = !!(connack as { sessionPresent?: boolean } | undefined)?.sessionPresent
    if (!sessionPresent) sessTopics.clear()
    // 全新会话（sessionPresent=false）：broker 侧没有任何订阅，逐条全量补订，正常拿 retained
    // 持久会话（true）：只补订会话里没有的；但若「清单声称全订过、实际一个都没订」，
    // 说明之前有过裸订阅（曾用在主题列表就绪前调用 ensureShared 的路径），
    // retained 将永不回投 → 丢掉清单强制全量重订一次（重复订阅只是重发 retained，安全）
    if (sessionPresent && subscribeMissing() === 0 && (topicHandlers.size > 0 || wildcardHandlers.size > 0)) {
      sessTopics.clear()
      subscribeMissing()
    }
    flushOutbox() // 断线期间暂存的发布统一补发（先于 connectListeners，模块回补的更新会覆盖旧值）
    // 错峰回补：29 个模块同一拍齐发全量状态会打成同步风暴（锁屏唤醒卡顿根因之二），
    // 每个监听器错开 STAGGER_MS，把一次大爆发摊成平缓小流
    let i = 0
    connectListeners.forEach((cb) => { const d = i++ * STAGGER_MS; setTimeout(cb, d) })
    // 持有者回补（上传本地全量）按门控触发：短抖动/同日重连不再全量重传，
    // 只有掉线超时、切 broker、每日首连才回补；排在 connect 监听器之后执行，
    // 让各模块先把云端 retained 合并进本地，再决定发什么
    if (computeNeedResync(Date.now())) {
      resyncNeededAt = Date.now()
      const base = i * STAGGER_MS
      let j = 0
      resyncListeners.forEach((cb) => { const d = base + j++ * STAGGER_MS; setTimeout(cb, d) })
    }
  })

  c.on('message', (topic, payload) => {
    // 增量同步层先过一遍：差量 /~d 会被还原成与既有协议逐字节一致的完整载荷，
    // 补发请求 /~r 会被就地消化（返回 null）。其余消息原样返回，零语义变化。
    const raw = payload.toString()
    const out = onIncoming(topic, raw)
    if (out === null) return
    dispatchMessage(topic, out === raw ? payload : Buffer.from(out))
  })

  c.on('error', (e) => {
    statusListeners.forEach((cb) => cb('error', e.message))
    // connack 拒绝（已连上过的连接出错不算，比如发布超时）→ 切备用 broker
    if (connected) return
    // 连不上的两类外象都算：网关明确拒收（Connection refused），以及校园网防火墙
    // 这类「静默丢包/TLS 劫持」——mqtt.js 对后者抛的是 connack timeout（connectTimeout 到点），
    // 旧实现只认 refused，被拦的环境永远卡在主 broker 干等、切不进备胎（2026-10-20 修）
    if (!/Connection refused|connack timeout|ETIMEDOUT|ENOTFOUND|invalid certificate|证书/.test(e?.message ?? '')) return
    const elapsed = Date.now() - lastFailoverAt
    if (elapsed < MIN_FAILOVER_INTERVAL) {
      setTimeout(() => failoverFrom(idx), MIN_FAILOVER_INTERVAL - elapsed)
    } else {
      failoverFrom(idx)
    }
  })
  c.on('offline', () => {
    connected = false
    lastOfflineAt = Date.now() // 回补门控：断线时长决定重连后要不要全量回补
    // 宽限 3s：瞬时抖动不亮横幅；真断线才通知（亮横幅）
    if (offlineTimer) clearTimeout(offlineTimer)
    offlineTimer = setTimeout(() => {
      offlineTimer = null
      if (connected) return
      offlineNotified = true
      statusListeners.forEach((cb) => cb('offline'))
    }, OFFLINE_GRACE_MS)
  })
  // 注意：mqtt.js 的 'reconnect' 是「每次重连尝试」事件，不再转发给模块——
  // 模块拿它清横幅，尝试≠成功，转发会造成横幅在断网期间一闪一闪。成功连接时统一清（见 connect）

  return c
}

/** 丢弃当前 broker 的连接，换下一个候选（带节流，全部拒收时不会死循环狂切） */
function failoverFrom(idx: number): void {
  if (client && brokerIdx !== idx) return // 已经切走了（可能是节流期间又触发的旧定时器）
  lastFailoverAt = Date.now()
  const old = client
  client = null
  connected = false
  lastOfflineAt = Date.now() // 换 broker 必然换 retained，重连后要全量回补
  old?.end(true)
  brokerIdx = (idx + 1) % BROKERS.length
  statusListeners.forEach((cb) => cb('reconnect')) // 通知各模块清掉错误横幅
  client = connectBroker(brokerIdx)
}

/** MQTT 主题通配匹配：+ 匹配单级，# 匹配剩余全部级（须为末级） */
function topicMatches(pattern: string, topic: string): boolean {
  const p = pattern.split('/')
  const t = topic.split('/')
  for (let i = 0, j = 0; i < p.length; i++, j++) {
    if (p[i] === '#') return true
    if (p[i] === '+') {
      if (j >= t.length) return false
      continue
    }
    if (p[i] !== t[j]) return false
  }
  return p.length === t.length
}

/** 订阅主题（共享连接），返回取消函数；主题按当前数据空间自动改写前缀。
 *  支持通配符（kv/+ 这种）：回调会收到实际主题作为第二个参数 */
export function sharedSubscribe(rawTopic: string, cb: PayloadHandler): () => void {
  ensureShared()
  const topic = resolveTopic(rawTopic)
  const isWildcard = topic.includes('+') || topic.includes('#')
  if (!isWildcard) onTopicSubscribed(topic) // 告知增量层：这个主题有模块在关心
  const table = isWildcard ? wildcardHandlers : topicHandlers
  let set = table.get(topic)
  if (!set) {
    set = new Set()
    table.set(topic, set)
  }
  set.add(cb)
  if (connected) {
    const firstSubscriber = set.size === 1
    // 2026-10-17：先问「之前订过没」再登记——旧实现 markSessTopic 在前，has 恒为 true，
    // 于是每个懒加载模块首次订阅都要走一遍「退订再订」，把该主题的 retained 整份重拉
    // （玉石页 = 348KB、玉石图 = 636KB），白等一轮往返
    const knownBefore = sessTopics.has(topic)
    if (!isSlowTopic(topic)) markSessTopic(topic)
    subscribeTopic(topic, knownBefore && firstSubscriber)
    saveSessTopics()
  }
  return () => {
    set.delete(cb)
    if (set.size === 0) table.delete(topic)
  }
}

/** 连接建立（含每次重连成功）时回调；若当前已连接则异步立即回调 */
export function onSharedConnect(cb: () => void): void {
  ensureShared()
  connectListeners.add(cb)
  if (connected) setTimeout(cb, 0)
}

/** 持有者回补回调：只在「掉线超 1 分钟 / 切 broker / 每日首连」时触发，
 *  用于把本地全量状态重新播种到 broker（防 retained 被清、防发布静默丢失）。
 *  普通重连不触发——短抖动后 retained 原样还在，再发一遍只会把队列堵住（同步慢根因）。
 *  若注册时回补窗口还开着（刚连上就回补过），异步补跑一次，不漏掉晚注册的模块 */
export function onSharedResync(cb: () => void): void {
  ensureShared()
  resyncListeners.add(cb)
  if (connected && resyncNeededAt && Date.now() - resyncNeededAt < RESYNC_WINDOW_MS) {
    setTimeout(cb, 0)
  }
}

/** 连接状态广播 */
export function onSharedStatus(cb: StatusHandler): void {
  ensureShared()
  statusListeners.add(cb)
}

/** 把一条原始消息放进 outbox 并投递：retained 状态按主题新盖旧，一次性信令 FIFO 排队 */
function enqueuePublish(topic: string, payload: string, retain: boolean): void {
  if (retain) {
    retainedOutbox.set(topic, { payload, retain, tries: 0 })
    deliver(topic, retainedOutbox.get(topic)!)
  } else {
    if (signalQueue.length >= MAX_SIGNAL_QUEUE) signalQueue.shift()
    const item = { topic, entry: { payload, retain, tries: 0 } }
    signalQueue.push(item)
    deliver(topic, item.entry)
  }
}

/** 派发一条消息给该主题的订阅者（载荷可能已被增量层从差量还原成全量） */
function dispatchMessage(topic: string, payload: Buffer): void {
  topicHandlers.get(topic)?.forEach((cb) => cb(payload, topic))
  if (wildcardHandlers.size === 0) return
  for (const [pattern, cbs] of wildcardHandlers) {
    if (!topicMatches(pattern, topic)) continue
    cbs.forEach((cb) => cb(payload, topic))
  }
}

/** 增量层用的原始订阅：不挂业务回调，只保证「连上 / 重连」后订阅存在。
 *  未连上时只登记，connect 时由 subscribeMissing()（已包含 controlTopics）补订。 */
function rawSubscribe(topic: string): void {
  if (controlTopics.has(topic)) return
  controlTopics.add(topic)
  ensureShared()
  if (!connected || !client) return
  markSessTopic(topic)
  client.subscribe(topic, { qos: 0 })
  saveSessTopics()
}

setDispatcher((topic, payload) => dispatchMessage(topic, Buffer.from(payload)))
bindDeltaTransport({
  subscribe: rawSubscribe,
  publish: (topic, payload, retain) => { ensureShared(); enqueuePublish(topic, payload, retain) },
})

/** 发布 retained 状态；retain=false 用于一次性信令（如求援请求）。
 *  可靠性：离线/未连接时进 outbox 暂存（retained 按主题新盖旧，信令 FIFO 封顶），
 *  连上自动补发，puback 失败自动重试，最多 5 次——不再静默丢包。
 *  主题按当前数据空间改写。
 *  2026-10-11：改为经增量层规划——体积较大的状态只发「变化的那部分」，
 *  发布方与订阅方都无感知，业务模块一行未改。详见 syncDelta.ts */
export function sharedPublish(rawTopic: string, payload: string, retain = true): void {
  ensureShared()
  const topic = resolveTopic(rawTopic)
  for (const step of planPublish(topic, payload, retain)) {
    enqueuePublish(step.topic, step.payload, step.retain)
  }
}

/** 强制重新拉取保留消息：退订再订阅，broker 会重发 retained */
export function sharedResync(rawTopic: string): void {
  ensureShared()
  if (!connected || !client) return
  const topic = resolveTopic(rawTopic)
  client.unsubscribe(topic, () => {
    client?.subscribe(topic, { qos: 0 })
  })
}
