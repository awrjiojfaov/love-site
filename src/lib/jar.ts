/**
 * 存钱罐：双方共同存钱的云端账本。
 * 2026-10-05 起接入 CRDT 同步层（Yjs over MQTT，见 crdt.ts）：
 * - 交易列表 = CRDT Y.Array，双端离线并发记账自动合并，彻底删掉 lastV 版本守卫
 * - legacy 主题保留为「旧版 App 互通桥」：对方手机还没升级时，老版本仍能互相同步；
 *   两台都升级后即可拆除（删 LEGACY_TOPIC 相关代码）
 * - 外组数据清理仍在读出口做（CRDT 内不删记录，防止被旧 retained 反播复活）
 *
 * 2026-10-10 三处修复：
 * 1. 「多笔钱重复加入」：重连时主动拉一次 retained（crdt 层），配合 mqttClient 会话订阅
 *    清单改用 sessionStorage —— 否则新 clientId 继承旧订阅清单，retained 永不回投，
 *    本地陈旧副本会被当成真相回发上云，合并后金额翻倍。
 * 2. 同 id 的重复记录（旧版云同步遗留 / 互通桥写入）在入账口去重，只留最早一笔。
 * 3. 新增支出：双方都能扣，扣款从两人钱包**平均分摊**（余数归发起方），写入时元账本。
 */
import { sharedPublish, sharedSubscribe, onSharedConnect, onSharedStatus } from './mqttClient'
import { isGuestSession } from './guest'
import { isPairMember, membersKnown, getPairMembers } from './space'
import { getCrdtDoc } from './crdt'
import { addTx } from './wallet'
import { totalBalanceOf } from './balance'
import type * as Y from 'yjs'

/** 旧版 App 只认这个主题（CRDT 引入前的账本协议） */
const LEGACY_TOPIC = 'lovesite/jar/state'
const LS_KEY = 'lovesite-jar-backup'
const DOC_NAME = 'jar'

export type JarTx = {
  id: string
  who: string
  amount: number // 金额：正数 = 存入，负数 = 支出
  note: string // 备注说明
  ts: number
}

type LegacyState = { tx: JarTx[]; v: number }

let initialized = false
let cloudReady = false
let txArr: Y.Array<JarTx> | null = null
let subscribers: Array<(tx: JarTx[]) => void> = []
let errorListeners: Array<(msg: string) => void> = []
let legacyTimer: ReturnType<typeof setTimeout> | null = null

/** 同一 id 只留最早一笔（ts 最小者胜，两端/新旧代码判断一致） */
function dedupeById(list: JarTx[]): JarTx[] {
  const map = new Map<string, JarTx>()
  for (const t of list) {
    if (!t || !t.id) continue
    const prev = map.get(t.id)
    if (!prev || t.ts < prev.ts) map.set(t.id, t)
  }
  return [...map.values()]
}

/** 读出口：CRDT 全量 → 同 id 去重 → 过滤外组 → 按时间倒序（UI 层格式不变） */
function snapshot(): JarTx[] {
  if (!txArr) return []
  const all = dedupeById(txArr.toArray())
  const clean = membersKnown() ? all.filter((t) => isPairMember(String(t?.who ?? ''))) : all
  return clean.sort((a, b) => b.ts - a.ts)
}

function notify() {
  const snap = snapshot()
  subscribers.forEach((cb) => cb(snap))
}

function emitError(msg: string) {
  errorListeners.forEach((cb) => cb(msg))
}

/* ---------- 旧版 App 互通桥 ----------
 * 老版本只订阅/发布 LEGACY_TOPIC。桥的两向：
 * - 出：CRDT 变更 → 300ms 防抖后把当前账本以旧协议发出去（v 递增，老版本版本守卫直接放行）
 * - 入：老版本/旧 retained 的账本里凡 CRDT 没有的交易 id，补进 CRDT（幂等，重复收不重复插） */
function publishLegacyBridge() {
  if (legacyTimer) return
  legacyTimer = setTimeout(() => {
    legacyTimer = null
    if (!txArr) return
    const state: LegacyState = { tx: snapshot(), v: Date.now() }
    sharedPublish(LEGACY_TOPIC, JSON.stringify(state))
  }, 300)
}

function mergeLegacyTx(incoming: JarTx[]) {
  const arr = txArr
  if (!arr) return
  const known = new Set(arr.toArray().map((t) => t.id))
  const seen = new Set<string>()
  const fresh = incoming.filter((t) => {
    if (!t || !t.id || known.has(t.id) || seen.has(t.id)) return false
    seen.add(t.id)
    return true
  })
  if (fresh.length === 0) return
  arr.doc!.transact(() => {
    for (const t of fresh) arr.push([t])
  })
  // observe 回调会统一 notify + publishLegacyBridge，这里不重复发
}

/* ---------- 一次性修复：清掉 CRDT 里重复 id 的副本 ----------
 * 起因（2026-10-10）：会话订阅清单错位时，本机拿不回被对方覆盖的 crdt/jar retained，
 * 便把本地陈旧快照（内含旧副本）当成真相回发上云，合并后同一笔钱出现两份 → 金额翻倍。
 * 修法：多端都按「同 id 取 ts 最小者」判定后，各自删掉多余副本，结果一致，CRDT 也只增不删地收敛。
 * 标志键确保每台设备每空间只跑一次，跑完即可删掉本段（连同 JAR_DEDUP_KEY）。 */
const JAR_DEDUP_KEY = 'lovesite-jar-dedup-v1'
function dedupeDocOnce() {
  const arr = txArr
  if (!arr) return
  try {
    if (localStorage.getItem(JAR_DEDUP_KEY)) return
    localStorage.setItem(JAR_DEDUP_KEY, '1')
  } catch {
    return
  }
  const all = arr.toArray()
  const bestTs = new Map<string, number>()
  for (const t of all) {
    if (!t || !t.id) continue
    const prev = bestTs.get(t.id)
    if (prev === undefined || t.ts < prev) bestTs.set(t.id, t.ts)
  }
  const drop: number[] = []
  all.forEach((t, i) => {
    if (t && t.id && bestTs.get(t.id) !== t.ts) drop.push(i)
  })
  if (drop.length === 0) return
  arr.doc!.transact(() => {
    for (const i of drop.reverse()) arr.delete(i, 1)
  })
  emitError('')
}

/** 首次启用 CRDT：老 localStorage 备份直接播种进空文档（CRDT 幂等，重复播种按 id 去重） */
function seedFromBackup() {
  const arr = txArr
  if (!arr || arr.length > 0) return
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as LegacyState
    if (!Array.isArray(parsed.tx) || parsed.tx.length === 0) return
    const clean = dedupeById(
      membersKnown()
        ? parsed.tx.filter((t) => isPairMember(String(t?.who ?? '')))
        : parsed.tx,
    )
    if (clean.length === 0) return
    arr.doc!.transact(() => arr.push(clean))
  } catch {
    /* ignore */
  }
}

function ensureClient() {
  if (initialized) return
  initialized = true

  const doc = getCrdtDoc(DOC_NAME)
  txArr = doc.getArray<JarTx>('tx')

  seedFromBackup()
  dedupeDocOnce()


  txArr.observe(() => {
    notify()
    publishLegacyBridge()
  })

  // 互通桥入口：旧协议账本 → CRDT
  sharedSubscribe(LEGACY_TOPIC, (payload) => {
    if (payload.length === 0) return
    try {
      const state = JSON.parse(payload.toString()) as LegacyState
      if (!Array.isArray(state.tx)) return
      cloudReady = true
      mergeLegacyTx(state.tx)
    } catch {
      /* ignore */
    }
  })

  onSharedConnect(() => {
    // 3s 内既没收到 CRDT 也没收到 legacy 消息：按本地数据就绪处理（老版本同款兜底）
    setTimeout(() => {
      if (!cloudReady) {
        cloudReady = true
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

export function subscribeJar(
  onData: (tx: JarTx[]) => void,
  onError?: (msg: string) => void,
): () => void {
  subscribers.push(onData)
  if (onError) errorListeners.push(onError)
  ensureClient()
  onData(snapshot())
  return () => {
    subscribers = subscribers.filter((cb) => cb !== onData)
    if (onError) errorListeners = errorListeners.filter((cb) => cb !== onError)
  }
}

/** 生成一笔交易的 id（存钱罐 / 支出共用格式） */
function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** 写入一笔交易（内部统一入口，按 id 幂等） */
function pushTx(entry: JarTx): boolean {
  const arr = txArr
  if (!arr) return false
  const all = arr.toArray()
  if (all.some((t) => t && t.id === entry.id)) return true // 幂等：同 id 不重复入账
  arr.doc!.transact(() => arr.push([entry]))
  return true
}

/** 存一笔钱（云端未就绪时拒绝，防止丢账） */
export function addJarTx(who: string, amount: number, note: string): boolean {
  if (isGuestSession()) return false
  if (amount <= 0) return false
  if (!note.trim()) return false // 必须有备注

  ensureClient()
  if (!cloudReady) return false
  if (!txArr) return false

  return pushTx({
    id: genId(),
    who,
    amount,
    note: note.trim(),
    ts: Date.now(),
  })
  // notify / CRDT 发布 / legacy 桥全部由 observe 与 crdt 层回调统一处理
}

/**
 * 从存钱罐支出一笔钱：钱从**双方时元钱包平均分摊**扣掉。
 * - 双方都可以扣（who = 发起人，仅用于记录，不影响分摊口径）
 * - 分摊：total 能整除就一人一半；余数（0.01 的零头）由发起方多承担，保证扣款总额分毫不差
 * - 时元余额不足时整笔拒绝（先校验后扣款，绝不只扣一方）
 * - 扣款写入时元账本（wallet），带确定性 id，双端并发也只记一次
 */
export function withdrawJarTx(
  who: string,
  total: number,
  note: string,
): { ok: true } | { ok: false; msg: string } {
  if (isGuestSession()) return { ok: false, msg: '只读模式不能操作存钱罐' }
  if (!note.trim()) return { ok: false, msg: '请填写支出原因' }
  const amount = Math.round(total * 100) / 100
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, msg: '请输入有效的支出金额' }

  ensureClient()
  if (!cloudReady || !txArr) return { ok: false, msg: '云端还没连接好，请稍后再试' }

  const members = getPairMembers()
  if (members.length !== 2) return { ok: false, msg: '账号组信息还没就绪，请稍后再试' }

  // 平均分摊：余数（分的零头）归发起方，保证两人扣款之和 = 总额
  const half = Math.round((amount / 2) * 100) / 100
  const payerA = members[0]
  const payerB = members[1]
  const shareA = payerA === who ? half + Math.round((amount - half * 2) * 100) / 100 : half
  const shareB = Math.round((amount - shareA) * 100) / 100

  // 口径与首页/农场一致（钱包账本 + 问答积分）：旧实现只算钱包，首页显示够钱、
  // 存钱罐却说不够
  const balA = totalBalanceOf(payerA)
  const balB = totalBalanceOf(payerB)
  if (balA < shareA || balB < shareB) {
    const lack = payerA === who ? `${payerA} 还差 ${(shareA - balA).toFixed(2)}` : `${payerB} 还差 ${(shareB - balB).toFixed(2)}`
    return { ok: false, msg: `时元不够啦（${lack}），先攒一攒吧` }
  }

  const ts = Date.now()
  const id = `${ts.toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  const reason = `🐷 存钱罐支出：${note.trim()}`

  // 先扣钱：任一笔记账失败就整笔回滚（把已写的那笔反过来），避免只扣一方
  const paid: Array<{ who: string; delta: number; id: string }> = []
  const deltas: Array<{ who: string; delta: number }> = [
    { who: payerA, delta: -shareA },
    { who: payerB, delta: -shareB },
  ]
  for (const d of deltas) {
    if (d.delta <= 0) continue
    const wid = `${id}-${d.who}`
    if (!addTx(d.who, d.delta, reason, wid)) {
      for (const p of paid) addTx(p.who, -p.delta, `↩️ 存钱罐支出回滚：${note.trim()}`, `rb-${p.id}`)
      return { ok: false, msg: '扣款失败，请稍后再试' }
    }
    paid.push({ who: d.who, delta: d.delta, id: wid })
  }

  pushTx({ id, who, amount: -amount, note: note.trim(), ts })
  return { ok: true }
}

/** 存钱罐总余额 = 存入为正、支出为负的净额 */
export function jarBalance(txs: JarTx[]): number {
  return txs.reduce((sum, t) => sum + t.amount, 0)
}

/** 累计存入（不含支出），用于展示「存了多少钱」 */
export function jarDeposited(txs: JarTx[]): number {
  return txs.filter((t) => t.amount > 0).reduce((sum, t) => sum + t.amount, 0)
}

/** 累计支出（正数展示） */
export function jarSpent(txs: JarTx[]): number {
  return txs.filter((t) => t.amount < 0).reduce((sum, t) => sum + -t.amount, 0)
}

/** 获取指定用户的存款总额（净额，已扣除对方在此罐上的分摊支出口径不计入） */
export function jarBalanceOf(txs: JarTx[], who: string): number {
  return txs.filter((t) => t.who === who && t.amount > 0).reduce((sum, t) => sum + t.amount, 0)
}
