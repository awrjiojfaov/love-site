/**
 * 时元股交所：自选股 / 持仓 / 交易记录，MQTT 同步（对齐 wallet.ts 的三件套规矩）。
 * - 版本守卫 lastV：旧 retained / 自己的回声一律忽略
 * - 交易记录按 id 并集合并；持仓按 (人+代码) 以 upd 时间戳 LWW 收敛
 * - 自选股删除走墓碑：watchDel 里时间戳更新的判删除，双端收敛
 * - 外组账号数据入口清洗（scrubForeign），本地备份 + 反熵回发
 * 交易规则：1 股起买，A 股 T+1（当日买入不可卖），价格用行情层实时价；
 *           买卖都记进时元钱包（addTx），盈亏随钱包双人实时同步。
 */
import { sharedPublish, sharedSubscribe, onSharedConnect, onSharedResync, onSharedStatus } from './mqttClient'
import { isGuestSession } from './guest'
import { isPairMember, membersKnown } from './space'
import { addTx } from './wallet'

const TOPIC = 'lovesite/stock/state'
const LS_KEY = 'lovesite-stock-backup'
const MAX_TX = 400
const MAX_POS_DEL = 500 // 清仓墓碑上限（超出丢最旧，仅影响远古清仓记录的极端重投场景）

export type StockTx = {
  id: string
  who: string
  code: string
  name: string
  side: 'buy' | 'sell'
  price: number
  shares: number
  fee: number // 手续费（卖出含印花税）
  ts: number
}

export type Position = {
  code: string
  name: string
  shares: number // 总持仓
  cost: number // 总成本（含买入手续费），平均成本 = cost / shares
  freeze: number // 当日买入不可卖的部分（T+1）
  upd: number // 本持仓最后变动时间（LWW 合并依据）
  day: string // 最后变动日 yyyyMMdd（跨日先解冻）
}

type State = {
  v: number
  watch: Record<string, Record<string, number>> // who -> code -> 加入时间戳
  watchDel: Record<string, Record<string, number>> // who -> code -> 删除时间戳（墓碑）
  pos: Record<string, Record<string, Position>> // who -> code -> 持仓
  /** 清仓墓碑：who -> code -> 清仓时间戳。没有它，卖光的持仓会被旧消息「合并复活」 */
  posDel?: Record<string, Record<string, number>>
  tx: StockTx[]
}

export type StockSnapshot = {
  watch: Record<string, Record<string, number>>
  pos: Record<string, Record<string, Position>>
  tx: StockTx[]
}

/* ---------- 费用规则 ---------- */
const BUY_FEE_RATE = 0.001 // 佣金 0.1%
const SELL_FEE_RATE = 0.001
const STAMP_RATE = 0.0005 // 印花税（仅卖出）
const MIN_FEE = 1

export function buyFee(cost: number): number {
  return Math.max(MIN_FEE, Math.round(cost * BUY_FEE_RATE))
}
export function sellFee(proceeds: number): number {
  return Math.max(MIN_FEE, Math.round(proceeds * SELL_FEE_RATE)) + Math.round(proceeds * STAMP_RATE)
}

/** 本地日期 yyyyMMdd（T+1 解冻判定用） */
export function todayStr(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
}

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/* ---------- 外组数据清洗 ---------- */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scrubForeign(parsed: any): number {
  if (!membersKnown()) return 0
  let removed = 0
  for (const field of ['watch', 'watchDel', 'pos', 'posDel'] as const) {
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
  if (Array.isArray(parsed?.tx)) {
    const before = parsed.tx.length
    parsed.tx = (parsed.tx as Array<{ who?: string }>).filter((t) => isPairMember(String(t?.who ?? '')))
    removed += before - parsed.tx.length
  }
  return removed
}

/* ---------- 内存态 ---------- */
let initialized = false
let watch: State['watch'] = {}
let watchDel: State['watchDel'] = {}
let pos: State['pos'] = {}
let posDel: Record<string, Record<string, number>> = {}
let tx: StockTx[] = []
let stateReceived = false
let cloudReady = false
let lastV = 0
let subscribers: Array<(s: StockSnapshot) => void> = []
let errorListeners: Array<(msg: string) => void> = []

function snapshot(): StockSnapshot {
  return { watch, pos, tx: [...tx] }
}

function notify(): void {
  const s = snapshot()
  subscribers.forEach((cb) => cb(s))
}

function emitError(msg: string): void {
  errorListeners.forEach((cb) => cb(msg))
}

function loadBackup(): State | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as State
    if (!Array.isArray(parsed.tx)) return null
    scrubForeign(parsed as unknown as Record<string, unknown>)
    return {
      v: parsed.v ?? 0,
      watch: parsed.watch ?? {},
      watchDel: parsed.watchDel ?? {},
      pos: parsed.pos ?? {},
      posDel: parsed.posDel ?? {},
      tx: parsed.tx,
    }
  } catch {
    return null
  }
}

function saveBackup(): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ v: lastV, watch, watchDel, pos, posDel, tx }))
  } catch {
    /* ignore */
  }
}

/* ---------- 合并逻辑 ---------- */

/** 交易记录并集（按 id），按时间倒序 */
function mergeTx(local: StockTx[], remote: StockTx[]): StockTx[] {
  const byId = new Map<string, StockTx>()
  for (const t of local) byId.set(t.id, t)
  for (const t of remote) if (!byId.has(t.id)) byId.set(t.id, t)
  return [...byId.values()].sort((a, b) => b.ts - a.ts).slice(0, MAX_TX)
}

function hasTxNotIn(local: StockTx[], remote: StockTx[]): boolean {
  const ids = new Set(remote.map((t) => t.id))
  return local.some((t) => !ids.has(t.id))
}

/** 自选股：加入/删除各记时间戳，时间戳大的赢；双端收敛 */
function mergeWatch(remoteWatch: State['watch'], remoteDel: State['watchDel']): boolean {
  let changed = false
  const whos = new Set([...Object.keys(watch), ...Object.keys(remoteWatch), ...Object.keys(watchDel), ...Object.keys(remoteDel)])
  for (const who of whos) {
    const addLocal = watch[who] ?? {}
    const delLocal = watchDel[who] ?? {}
    const addRemote = remoteWatch[who] ?? {}
    const delRemote = remoteDel[who] ?? {}
    const codes = new Set([...Object.keys(addLocal), ...Object.keys(addRemote)])
    const outAdd: Record<string, number> = {}
    const outDel: Record<string, number> = {}
    for (const code of codes) {
      const addTs = Math.max(addLocal[code] ?? 0, addRemote[code] ?? 0)
      const delTs = Math.max(delLocal[code] ?? 0, delRemote[code] ?? 0)
      if (addTs > delTs) outAdd[code] = addTs
      else if (delTs > 0) outDel[code] = delTs
      if ((addLocal[code] ?? 0) !== addTs || (delLocal[code] ?? 0) !== delTs) changed = true
    }
    if (Object.keys(outAdd).length > 0) watch[who] = outAdd
    else delete watch[who]
    if (Object.keys(outDel).length > 0) watchDel[who] = outDel
    else delete watchDel[who]
  }
  return changed
}

/** 持仓：(人+代码) 以 upd 大者赢（LWW）；清仓墓碑时间晚于持仓最后变动 → 视为已清空，谁都不保留
 * （没有墓碑时，卖光后本地删记录、对方仍持旧副本，一合并持仓就「复活」，市值凭空多一截） */
function mergePos(remote: State['pos'], remoteDel: State['posDel']): boolean {
  let changed = false
  const whos = new Set([...Object.keys(pos), ...Object.keys(remote), ...Object.keys(posDel), ...Object.keys(remoteDel ?? {})])
  for (const who of whos) {
    const localRec = pos[who] ?? {}
    const remoteRec = remote[who] ?? {}
    const delLocal = posDel[who] ?? {}
    const delRemote = remoteDel?.[who] ?? {}
    const codes = new Set([...Object.keys(localRec), ...Object.keys(remoteRec)])
    const out: Record<string, Position> = {}
    const outDel: Record<string, number> = {}
    for (const code of codes) {
      const l = localRec[code]
      const r = remoteRec[code]
      const winner = !l ? r : !r ? l : r.upd > l.upd ? r : l
      const delTs = Math.max(delLocal[code] ?? 0, delRemote[code] ?? 0)
      if (winner && winner.upd > delTs && winner.shares > 0) out[code] = winner
      if (delTs > 0) outDel[code] = delTs
      if (winner !== l || (delLocal[code] ?? 0) !== delTs) changed = true
    }
    // 远端独有的墓碑也要收编（对方在我离线时清仓）
    for (const [code, ts] of Object.entries(delRemote)) {
      if (ts > 0 && (delLocal[code] ?? 0) < ts) {
        outDel[code] = Math.max(ts, outDel[code] ?? 0)
        changed = true
      }
    }
    if (Object.keys(out).length > 0) pos[who] = out
    else delete pos[who]
    if (Object.keys(outDel).length > 0) posDel[who] = outDel
    else delete posDel[who]
  }
  prunePosDel()
  return changed
}

/** 墓碑总量封顶：按时间保留最新 MAX_POS_DEL 条 */
function prunePosDel(): void {
  const all: { who: string; code: string; ts: number }[] = []
  for (const [who, rec] of Object.entries(posDel)) {
    for (const [code, ts] of Object.entries(rec)) all.push({ who, code, ts })
  }
  if (all.length <= MAX_POS_DEL) return
  all.sort((a, b) => b.ts - a.ts)
  const keep = new Set(all.slice(0, MAX_POS_DEL).map((x) => `${x.who}|${x.code}`))
  const next: State['posDel'] = {}
  for (const { who, code, ts } of all) {
    if (!keep.has(`${who}|${code}`)) continue
    if (!next[who]) next[who] = {}
    next[who][code] = ts
  }
  posDel = next
}

function publishState(): void {
  // Lamport 版本（农场/钱包同款教训）：max(已见版本, 本机时钟) + 1，只认先后不认时钟绝对值
  const v = Math.max(lastV, Date.now()) + 1
  lastV = v
  sharedPublish(TOPIC, JSON.stringify({ v, watch, watchDel, pos, posDel, tx } satisfies State))
}

function handleState(state: State): void {
  const removedForeign = scrubForeign(state as unknown as Record<string, unknown>)
  stateReceived = true
  cloudReady = true
  const pv = state.v ?? 0
  const newer = pv > lastV
  if (newer) lastV = pv
  // 并集 / LWW 合并在任何版本下都安全：版本只防账本回滚，不挡收敛
  const incoming = Array.isArray(state.tx) ? state.tx : []
  const cloudMissing = hasTxNotIn(tx, incoming)
  tx = mergeTx(tx, incoming)
  const watchChanged = mergeWatch(state.watch ?? {}, state.watchDel ?? {})
  const posChanged = mergePos(state.pos ?? {}, state.posDel ?? {})
  saveBackup()
  notify()
  // 反熵：云端缺我们的交易 / 自选有差异 / 持仓有差异 / 清掉外组数据 → 回发合并结果
  if (cloudMissing || watchChanged || posChanged || removedForeign > 0) publishState()
}

function ensureClient(): void {
  if (initialized) return
  initialized = true

  if (!stateReceived && tx.length === 0) {
    const backup = loadBackup()
    if (backup) {
      watch = backup.watch
      watchDel = backup.watchDel
      pos = backup.pos
      posDel = backup.posDel ?? {}
      tx = backup.tx
      lastV = backup.v ?? 0
    }
  }

  sharedSubscribe(TOPIC, (payload) => {
    if (payload.length === 0) return
    try {
      handleState(JSON.parse(payload.toString()) as State)
    } catch {
      /* ignore */
    }
  })

  onSharedConnect(() => {
    setTimeout(() => {
      if (!stateReceived) {
        cloudReady = true // 无云端数据时本端即唯一持有者，写入直接生效
        const backup = loadBackup()
        if (backup && (backup.tx.length > 0 || Object.keys(backup.pos).length > 0)) {
          lastV = Math.max(lastV, backup.v ?? 0)
          notify()
        }
      }
    }, 3000)
  })

  // 持有者回补：只在门控放行时（掉线超 1 分钟/切 broker/每日首连）广播本地全量——
  // 修复「对方交易时恰好掉线 / retained 被清 → 持仓/自选/记录永远差一截」。
  // 挪出 onSharedConnect：30~60KB 每次抖动重传会堵住队列里的小消息（同步慢根因）
  onSharedResync(() => {
    setTimeout(() => {
      if (tx.length > 0 || Object.keys(pos).length > 0 || Object.keys(watch).length > 0) publishState()
    }, 3000)
  })

  // 反熵心跳：定期广播全量，静默修掉「某次发布悄悄失败（弱网/后台被挂）」造成的分叉。
  // 不 bump 版本（内容没变对端是 no-ops）+ 后台不发，避免两台设备常驻背景流量与周期性重渲染
  setInterval(() => {
    if (!cloudReady) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    if (tx.length === 0 && Object.keys(pos).length === 0 && Object.keys(watch).length === 0) return
    sharedPublish(TOPIC, JSON.stringify({ watch, watchDel, pos, posDel, tx, v: lastV }))
  }, 60_000)

  onSharedStatus((status, msg) => {
    if (status === 'error') emitError(`连接消息服务器失败：${msg}`)
    else if (status === 'offline') emitError('消息服务器连接中断，正在自动重连…')
    else if (status === 'reconnect') emitError('')
  })
}

/* ---------- 对外 API ---------- */

export function subscribeStocks(
  onData: (s: StockSnapshot) => void,
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

/** 云端是否就绪（未就绪时交易/改自选会被拒，防止开盘丢单） */
export function stockReady(): boolean {
  ensureClient()
  return cloudReady
}

export function isWatched(s: StockSnapshot, who: string, code: string): boolean {
  return (s.watch[who]?.[code] ?? 0) > (watchDel[who]?.[code] ?? 0)
}

/** 某人的自选股列表（新的在前） */
export function watchListOf(s: StockSnapshot, who: string): string[] {
  const del = watchDel[who] ?? {}
  return Object.entries(s.watch[who] ?? {})
    .filter(([code, ts]) => ts > (del[code] ?? 0))
    .sort((a, b) => b[1] - a[1])
    .map(([code]) => code)
}

export function positionsOf(s: StockSnapshot, who: string): Position[] {
  return Object.values(s.pos[who] ?? {})
    .filter((p) => p.shares > 0)
    .sort((a, b) => b.cost - a.cost)
}

/** 今日可卖数量（跨日自动解冻） */
export function sellableOf(p: Position): number {
  return p.day === todayStr() ? p.shares - p.freeze : p.shares
}

/** 加/删自选股（墓碑删除）；未连接返回 false */
export function toggleWatch(who: string, code: string, name: string): boolean {
  if (isGuestSession()) return false
  ensureClient()
  if (!cloudReady) return false
  const del = watchDel[who] ?? {}
  const added = (watch[who]?.[code] ?? 0) > (del[code] ?? 0)
  const now = Date.now()
  if (added) {
    if (!watchDel[who]) watchDel[who] = {}
    watchDel[who][code] = now // 墓碑
  } else {
    if (!watch[who]) watch[who] = {}
    watch[who][code] = now
    void name // 名字从行情层取，这里只为接口对称
  }
  saveBackup()
  publishState()
  notify()
  return true
}

export type TradeResult = { ok: boolean; msg: string }

function applyT1Unfreeze(p: Position): Position {
  const today = todayStr()
  if (p.day === today) return p
  return { ...p, freeze: 0, day: today }
}

/** 买入：1 股起，按传入的实时价成交；钱从时元钱包扣 */
export function tradeBuy(who: string, code: string, name: string, price: number, shares: number): TradeResult {
  if (isGuestSession()) return { ok: false, msg: '游客模式只能看行情～' }
  ensureClient()
  if (!cloudReady) return { ok: false, msg: '正在连接同步服务器，稍候再试' }
  if (!Number.isFinite(price) || price <= 0) return { ok: false, msg: '暂时没有最新价格，稍候再试' }
  if (!Number.isInteger(shares) || shares < 1 || shares > 1000000) return { ok: false, msg: '股数必须是正整数' }
  const cost = Math.round(price * shares)
  const fee = buyFee(cost)
  const total = cost + fee
  if (!addTx(who, -total, `买入 ${name}×${shares}股`)) return { ok: false, msg: '时元不足或无法记账' }
  const now = Date.now()
  const cur = applyT1Unfreeze(pos[who]?.[code] ?? { code, name, shares: 0, cost: 0, freeze: 0, upd: 0, day: todayStr() })
  const next: Position = {
    code,
    name,
    shares: cur.shares + shares,
    cost: cur.cost + total,
    freeze: cur.freeze + shares,
    upd: now,
    day: todayStr(),
  }
  if (!pos[who]) pos[who] = {}
  pos[who][code] = next
  tx = mergeTx([{ id: uid(), who, code, name, side: 'buy', price, shares, fee, ts: now }], tx)
  saveBackup()
  publishState()
  notify()
  return { ok: true, msg: `买入成交：${name} ${shares}股 @ ${price.toFixed(2)}，共 ${total} 时元（含手续费 ${fee}）` }
}

/** 卖出：受 T+1 限制（当日买入不可卖），按实时价成交 */
export function tradeSell(who: string, code: string, name: string, price: number, shares: number): TradeResult {
  if (isGuestSession()) return { ok: false, msg: '游客模式只能看行情～' }
  ensureClient()
  if (!cloudReady) return { ok: false, msg: '正在连接同步服务器，稍候再试' }
  const p0 = pos[who]?.[code]
  if (!p0 || p0.shares <= 0) return { ok: false, msg: '没有这只股票的持仓' }
  const cur = applyT1Unfreeze(p0)
  const sellable = cur.shares - cur.freeze
  if (!Number.isInteger(shares) || shares < 1) return { ok: false, msg: '股数必须是正整数' }
  if (shares > sellable) {
    return { ok: false, msg: cur.freeze > 0 ? `T+1：今天买的 ${cur.freeze} 股明天才能卖，当前可卖 ${sellable} 股` : `持仓不足，当前可卖 ${sellable} 股` }
  }
  if (!Number.isFinite(price) || price <= 0) return { ok: false, msg: '暂时没有最新价格，稍候再试' }
  const proceeds = Math.round(price * shares)
  const fee = sellFee(proceeds)
  const net = proceeds - fee
  if (!addTx(who, net, `卖出 ${name}×${shares}股`)) return { ok: false, msg: '记账失败' }
  const now = Date.now()
  const avg = cur.cost / cur.shares
  const remain = cur.shares - shares
  if (!pos[who]) pos[who] = {}
  if (remain <= 0) {
    delete pos[who][code]
    // 清仓墓碑：本地删除后对方仍可能持旧副本，靠墓碑在合并时压死，防止持仓「复活」
    if (!posDel[who]) posDel[who] = {}
    posDel[who][code] = now
    prunePosDel()
  } else {
    pos[who][code] = { ...cur, shares: remain, cost: Math.round(avg * remain), upd: now, day: todayStr() }
  }
  tx = mergeTx([{ id: uid(), who, code, name, side: 'sell', price, shares, fee, ts: now }], tx)
  saveBackup()
  publishState()
  notify()
  return { ok: true, msg: `卖出成交：${name} ${shares}股 @ ${price.toFixed(2)}，到账 ${net} 时元（扣费用 ${fee}）` }
}

/** 某人持仓总市值 + 总盈亏（need quotes: code -> price） */
export function portfolioOf(
  s: StockSnapshot,
  who: string,
  quotes: Record<string, { price: number }>,
): { value: number; cost: number; pnl: number } {
  let value = 0
  let cost = 0
  for (const p of positionsOf(s, who)) {
    const q = quotes[p.code]
    value += Math.round((q?.price ?? 0) * p.shares)
    cost += p.cost
  }
  return { value, cost, pnl: value - cost }
}
