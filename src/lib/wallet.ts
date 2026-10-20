/**
 * 时元钱包：云端交易账本（MQTT 独立主题，与农场/问答共用通道模式）。
 * - 余额 = 所有交易之和；问答试运行的积分仍由 ask.ts 单独计算，展示时两处相加
 * - 农场消费（种植/开垦/浇水）与收入（收获奖励）都记账，两台手机实时一致
 */
import { sharedPublish, sharedSubscribe, onSharedConnect, onSharedResync, onSharedStatus } from './mqttClient'
import { isGuestSession } from './guest'
import { isPairMember, membersKnown } from './space'

/** 清理混入的外组账号数据：交易与归档计数器只保留当前空间成员的 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scrubForeign(parsed: any): number {
  if (!membersKnown()) return 0
  let removed = 0
  if (Array.isArray(parsed?.tx)) {
    const before = parsed.tx.length
    parsed.tx = (parsed.tx as Array<{ who?: string }>).filter((t) => isPairMember(String(t?.who ?? '')))
    removed += before - parsed.tx.length
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

const TOPIC = 'lovesite/wallet/state'
const LS_KEY = 'lovesite-wallet-backup'
const MAX_TX = 500 // 账本只保留最近 500 条明细，更早的折叠进归档计数器，余额永远精确
const FOLD_WINDOW = 7 * 24 * 3600 * 1000 // 折叠 7 天前的明细；边界由账本数据决定，两端必然一致
const MAX_ARCH_IDS = 2000 // 折叠墓碑上限（超出丢弃最旧墓碑，仅影响远古交易的极端重投场景）

export type WalletTx = {
  id: string
  who: string
  delta: number // 正为收入，负为支出
  reason: string
  ts: number
}

type State = {
  tx: WalletTx[]
  v: number
  /** 已折叠出明细的历史收入合计（每人，只增不减，合并取大） */
  archPlus?: Record<string, number>
  /** 已折叠出明细的历史支出合计（每人，绝对值，只增不减，合并取大） */
  archMinus?: Record<string, number>
  /** 归档边界：ts 早于此时间的交易都已计入 archPlus/archMinus（旧字段，现以 archIds 墓碑为准） */
  archTs?: number
  /** 已折叠交易的 id 墓碑：防「计数器+明细」双算、防旧账重投重复计数（两端取并集） */
  archIds?: string[]
}

let initialized = false
let tx: WalletTx[] = []
let archPlus: Record<string, number> = {}
let archMinus: Record<string, number> = {}
let archTs = 0
let archIds: string[] = []
let archIdSet = new Set<string>()
let stateReceived = false
let cloudReady = false
/** 已见账本的最大版本号：旧 retained / 自己的回声一律忽略，防止旧账本回滚新交易 */
let lastV = 0
/** 云端未就绪时记账先进这里，就绪后自动补发（防止开盘 3 秒内的账被静默吞掉） */
let pending: WalletTx[] = []
const PENDING_KEY = 'lovesite-wallet-pending'
let subscribers: Array<(tx: WalletTx[]) => void> = []
let errorListeners: Array<(msg: string) => void> = []

function loadPending(): void {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    const parsed = raw ? (JSON.parse(raw) as WalletTx[]) : []
    pending = Array.isArray(parsed) ? parsed : []
  } catch {
    pending = []
  }
}

function savePending(): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending))
  } catch {
    /* ignore */
  }
}

/** 待发出队补进账本并广播（cloudReady 后才有效；按 id + 墓碑去重防重复入账） */
function flushPending(): void {
  if (!cloudReady || pending.length === 0) return
  const existing = new Set(tx.map((t) => t.id))
  const fresh = pending.filter((t) => !existing.has(t.id) && !archIdSet.has(t.id))
  pending = []
  savePending()
  if (fresh.length === 0) return
  tx = [...fresh, ...tx]
  foldIfNeeded()
  saveBackup()
  publishState()
  notify()
}

function loadBackup(): State | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as State
    if (!Array.isArray(parsed.tx)) return null
    scrubForeign(parsed as unknown as Record<string, unknown>) // 本地备份也清掉外组数据
    archIds = Array.isArray(parsed.archIds) ? parsed.archIds : []
    archIdSet = new Set(archIds)
    return {
      tx: parsed.tx,
      v: parsed.v ?? 0,
      archPlus: parsed.archPlus ?? {},
      archMinus: parsed.archMinus ?? {},
      archTs: parsed.archTs ?? 0,
      archIds,
    }
  } catch {
    return null
  }
}

function saveBackup() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ tx, v: lastV, archPlus, archMinus, archTs, archIds }))
  } catch {
    /* ignore */
  }
}

/** 登记折叠墓碑：已计入归档计数器的交易 id，重投/重折叠时一律跳过 */
function addArchTombstones(ids: string[]) {
  for (const id of ids) {
    if (archIdSet.has(id)) continue
    archIdSet.add(id)
    archIds.push(id)
  }
  while (archIds.length > MAX_ARCH_IDS) archIdSet.delete(archIds.shift()!)
}

function notify() {
  // 云端未就绪时记账先进 pending：快照把它一并算上，本端余额即时可见，云端补发后两台一致
  const snapshot = [...tx]
  if (pending.length > 0) {
    const seen = new Set(snapshot.map((t) => t.id))
    for (const t of pending) {
      if (!seen.has(t.id) && !archIdSet.has(t.id)) {
        seen.add(t.id)
        snapshot.push(t)
      }
    }
    snapshot.sort((a, b) => b.ts - a.ts)
  }
  subscribers.forEach((cb) => cb(snapshot))
}

function emitError(msg: string) {
  errorListeners.forEach((cb) => cb(msg))
}

/** 按交易 id 合并两个账本（并集）；折叠墓碑里的 id 已计入归档计数器，一律跳过（不看 ts，旧账晚到也不丢） */
function mergeTx(local: WalletTx[], remote: WalletTx[]): WalletTx[] {
  const byId = new Map<string, WalletTx>()
  for (const t of local) byId.set(t.id, t)
  for (const t of remote) if (!byId.has(t.id) && !archIdSet.has(t.id)) byId.set(t.id, t)
  return [...byId.values()].sort((a, b) => b.ts - a.ts)
}

/** 明细超窗/超量时，把最老的折叠进归档计数器（收入/支出分开累计，余额分毫不差）。
 *  折叠边界由账本数据本身决定（最新交易往前 7 天）：两端账本内容一致 → 边界一致 →
 *  各自折掉的是同一批交易，归档计数器经「取大」合并后依然精确（旧版按各自 500 条就地折叠，
 *  两端折的是不同集合，取大合并会整段丢钱——时元差一截且永不自愈的根源之一）。 */
function foldIfNeeded(): void {
  if (tx.length === 0) return
  const boundary = tx[0].ts - FOLD_WINDOW
  let cut = tx.filter((t) => t.ts < boundary)
  let kept = tx.filter((t) => t.ts >= boundary)
  if (kept.length > MAX_TX) {
    // 极端爆量兜底：硬压到 MAX_TX（此时两端折叠集可能不同，靠墓碑防双算）
    cut = [...cut, ...kept.slice(MAX_TX)]
    kept = kept.slice(0, MAX_TX)
  }
  if (cut.length === 0) return
  addArchTombstones(cut.map((t) => t.id))
  for (const t of cut) {
    if (t.delta > 0) archPlus[t.who] = (archPlus[t.who] ?? 0) + t.delta
    else if (t.delta < 0) archMinus[t.who] = (archMinus[t.who] ?? 0) + -t.delta
  }
  archTs = Math.max(archTs, cut[cut.length - 1].ts)
  tx = kept
}

/** 合并对方的归档计数器（每人单调递增，取大即收敛）+ 折叠墓碑（取并集） */
function mergeArch(state: State): void {
  for (const [who, n] of Object.entries(state.archPlus ?? {})) {
    if (typeof n === 'number' && n > (archPlus[who] ?? 0)) archPlus[who] = n
  }
  for (const [who, n] of Object.entries(state.archMinus ?? {})) {
    if (typeof n === 'number' && n > (archMinus[who] ?? 0)) archMinus[who] = n
  }
  if (typeof state.archTs === 'number' && state.archTs > archTs) archTs = state.archTs
  // 对方折掉的交易：本地若还挂着活体副本，按墓碑剔除——否则计数器（取大合并来的）+ 明细各算一次，余额虚高
  if (Array.isArray(state.archIds) && state.archIds.length > 0) {
    const drop = new Set<string>()
    for (const id of state.archIds) {
      if (archIdSet.has(id)) continue
      archIdSet.add(id)
      archIds.push(id)
      drop.add(id)
    }
    while (archIds.length > MAX_ARCH_IDS) archIdSet.delete(archIds.shift()!)
    if (drop.size > 0) tx = tx.filter((t) => !drop.has(t.id))
  }
}

/** local 是否有 remote 缺的交易（用于判断要不要回发合并结果） */
function hasTxNotIn(local: WalletTx[], remote: WalletTx[]): boolean {
  const ids = new Set(remote.map((t) => t.id))
  return local.some((t) => !ids.has(t.id))
}

function ensureClient() {
  if (initialized) return
  initialized = true
  loadPending()

  // 本地缓存先行：先用上次的备份立刻渲染，云端数据到了再覆盖
  if (!stateReceived && tx.length === 0) {
    const backup = loadBackup()
    if (backup) {
      tx = backup.tx
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
      if (!Array.isArray(state.tx)) return
      const removedForeign = scrubForeign(state as unknown as Record<string, unknown>) // 外组交易入口清掉
      stateReceived = true
      cloudReady = true
      flushPending() // 云端就绪：先把排队账补进去再合并
      // 版本守卫：只处理更新的账本；旧 retained 和自己的回声直接忽略
      const pv = state.v ?? 0
      if (pv <= lastV) {
        // 时钟偏差兜底：旧版本号里若夹着本地没有的交易，照样合并进来（墓碑防重，旧账晚到不丢）
        mergeArch(state)
        if (hasTxNotIn(state.tx, tx)) {
          tx = mergeTx(tx, state.tx)
          foldIfNeeded()
          saveBackup()
          notify()
        }
        if (removedForeign > 0) publishState() // 回发清理后的账本
        return
      }
      lastV = pv
      // 合并而非覆盖：按交易 id 求并集，两台手机同时记账也不会互丢
      mergeArch(state)
      const cloudMissing = hasTxNotIn(tx, state.tx)
      tx = mergeTx(tx, state.tx)
      foldIfNeeded()
      saveBackup()
      notify()
      // 反熵：云端缺我们已有的交易时回发合并结果；清掉外组数据后也要回发
      if (cloudMissing || removedForeign > 0) publishState()
    } catch {
      /* ignore */
    }
  })

  onSharedConnect(() => {
    loadPending()
    setTimeout(() => {
      if (!stateReceived) {
        const backup = loadBackup()
        cloudReady = true
        if (backup && backup.tx.length > 0) {
          tx = mergeTx(tx, backup.tx)
          mergeArch(backup)
          foldIfNeeded()
          lastV = Math.max(lastV, backup.v ?? 0)
        }
      }
      flushPending() // 无云端账本时也要把排队账发出去（本端即唯一持有者）
      notify()
    }, 3000)
  })

  // 持有者回补：只在门控放行时（掉线超时/切 broker/每日首连）广播本地全量。
  // 合并是按 id 并集 + 墓碑去重，旧备份重投不会双算、也不会盖掉对方的合法交易——
  // 修复「对方记账时恰好掉线 / retained 被 broker 清掉 → 余额永远差一笔」。
  // 放到 onSharedResync 而非每次重连：45~100KB 的账本每次抖动重传会堵住后续小消息
  onSharedResync(() => {
    setTimeout(() => {
      if (tx.length > 0 || archIds.length > 0 || Object.keys(archPlus).length > 0) publishState()
    }, 3000)
  })

  onSharedStatus((status, msg) => {
    if (status === 'error') emitError(`连接消息服务器失败：${msg}`)
    else if (status === 'offline') emitError('消息服务器连接中断，正在自动重连…')
    else if (status === 'reconnect') emitError('')
  })

  // 看门狗：无论哪条路径漏了，排队账每 4 秒找机会补发一次
  setInterval(flushPending, 4000)
  // 反熵心跳：定期广播一次全量，静默修掉「某次发布悄悄失败（弱网/后台被挂）」造成的余额分叉。
  // 关键：心跳不 bump 版本——内容没变时对端走「旧包」分支只做并集比对，不写备份不重渲染；
  // 旧实现每 60s 把 v 推到 now+1，两台设备的每条心跳都被对方当成新版本，
  // 每分钟各做一次全量 JSON 写 localStorage + 重渲染，是「没操作页面也在卡」的来源之一。
  // 锁屏/后台不发（省掉常驻背景流量，唤醒后由重连回补与下次心跳接管）
  setInterval(() => {
    if (!cloudReady) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    if (tx.length === 0 && archIds.length === 0) return
    sharedPublish(TOPIC, JSON.stringify({ tx, v: lastV, archPlus, archMinus, archTs, archIds }))
  }, 60_000)
}

function publishState() {
  // Lamport 版本（农场同款教训）：max(已见版本, 本机时钟) + 1，版本只认先后顺序、不认时钟绝对值，
  // 杜绝两台手机时钟偏差把版本号推到「未来」后自己反被忽略的问题
  const v = Math.max(lastV, Date.now()) + 1
  lastV = v // 自己的回声会被版本守卫（pv <= lastV）挡下
  const state: State = { tx, v, archPlus, archMinus, archTs, archIds }
  sharedPublish(TOPIC, JSON.stringify(state))
}

export function subscribeWallet(
  onData: (tx: WalletTx[]) => void,
  onError?: (msg: string) => void,
): () => void {
  subscribers.push(onData)
  if (onError) errorListeners.push(onError)
  ensureClient()
  onData([...tx])
  return () => {
    subscribers = subscribers.filter((cb) => cb !== onData)
    if (onError) errorListeners = errorListeners.filter((cb) => cb !== onError)
  }
}

/** 记一笔账：云端就绪直接入账；未就绪先进待发出队，就绪后自动补发，不再丢账。
 *  id 可选：传确定性 id（如拍卖会成交款 auc-xxx-who）则双端同时入账也只记一次（按 id 去重） */
export function addTx(who: string, delta: number, reason: string, id?: string): boolean {
  if (isGuestSession()) return false
  ensureClient()
  const entry: WalletTx = {
    id: id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    who,
    delta,
    reason,
    ts: Date.now(),
  }
  // 幂等：同一确定性 id 重复提交（双端并发自动入账）直接视为成功，不产生第二笔
  if (archIdSet.has(entry.id) || tx.some((t) => t.id === entry.id) || pending.some((t) => t.id === entry.id)) return true
  if (!cloudReady) {
    loadPending()
    pending = [entry, ...pending]
    savePending()
    notify() // 本地先展示（快照含 pending），云端补发后两台一致
    return true
  }
  tx = [entry, ...tx]
  foldIfNeeded()
  saveBackup()
  publishState()
  notify()
  return true
}

/** 当前账本快照（lib 层只读计算用，无需订阅；含 pending 之外的已入账交易） */
export function walletSnapshot(): WalletTx[] {
  ensureClient()
  return [...tx]
}

/** 已折叠进归档计数器的历史收支（明细里已经看不到，但对账必须算上，见记录页） */
export function walletArchived(who: string): { plus: number; minus: number } {
  return { plus: archPlus[who] ?? 0, minus: archMinus[who] ?? 0 }
}

/** 已折叠（归档）的交易笔数：两端一致，用于对账展示 */
export function walletFoldedCount(): number {
  return archIds.length
}

/** 每人初始时元 */
export const BASE_BALANCE = 1000

/** 钱包账本余额（不含问答试运行积分；含初始 1000 时元；含已归档的历史收支，永远精确） */
export function walletBalance(txs: WalletTx[], who: string): number {
  const archived = (archPlus[who] ?? 0) - (archMinus[who] ?? 0)
  return BASE_BALANCE + archived + txs.filter((t) => t.who === who).reduce((sum, t) => sum + t.delta, 0)
}
