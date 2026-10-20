/**
 * 爱情树（樱花树）云端同步：共享 MQTT 连接，独立主题。
 * - 两人共养一棵树，累计经验升级，共 7 种形态
 * - 经验来源：每日登录 / 种植 / 打分，每次行为 +2
 * - 每日上限：每人 100，两人合计 200；经验总量到 10000 封顶
 * - 合并同步：经验按"每人终身贡献账本"记录，合并时按人取最大值（只增不减），
 *   两人同时获得经验也不会互丢，且不受两台手机时钟偏差影响
 * - 默认空间硬保底：公共 broker 清空 retained + 设备本地备份缺失时，全新设备会把空状态
 *   当真相发布，把整组经验刷没。因此默认空间的账本可带永久下限 DEFAULT_FLOOR（来自配置
 *   VITE_TREE_FLOOR），任何采纳/合并不可能低于它；普通部署留空即无下限。
 *   其他账号组走独立主题前缀（space.ts），互不影响，也不受此下限影响。
 */
import { sharedPublish, sharedSubscribe, onSharedConnect, onSharedStatus } from './mqttClient'
import { isGuestSession } from './guest'
import { isPairMember, membersKnown, isDefaultSpace } from './space'
import { TREE_FLOOR } from '../config'

/** 清理混入的外组账号数据：贡献/当日/登录账本只保留当前空间成员。
 *  历史折叠桶 LEGACY_KEY 也不再保留——曾发生过清零事故后云端经验已按
 *  两人实名账本恢复，保留 _legacy 残留会被合并语义加回去导致总数失真。 */
function scrubForeign(parsed: Record<string, unknown>): number {
  let removed = 0
  if (!membersKnown()) return 0
  for (const field of ['contrib', 'dayBy', 'loginDay'] as const) {
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

const TOPIC = 'lovesite/tree/state'
const LS_KEY = 'lovesite-tree-backup'
/** 最优快照归档：broker 会清空 retained、备份也可能被浏览器驱逐，单独留一份"有史以来最高"的
 *  账本快照（只涨不落），启动时与备份按人取最大合并，任何单一环节丢数据都能回补 */
const ARCHIVE_KEY = 'lovesite-tree-archive'

export const XP_PER_ACTION = 2
export const DAILY_CAP_PER_PERSON = 100
export const XP_MAX = 10000
/** 7 种形态对应的累计经验门槛；5000/7000 为盛放后的光彩等级 */
export const STAGE_XP = [0, 200, 500, 1000, 2000, 3000, 10000]
export const AURA_XP = [5000, 7000] // 满形态后：5000 繁茂光晕 · 7000 永恒之树

/** 旧数据（无贡献账本）折叠到这个特殊key下 */
const LEGACY_KEY = '_legacy'

/** 默认空间贡献账本永久下限（来自配置 VITE_TREE_FLOOR；普通部署留空 = 不设下限）。
 *  用途：公共 broker 清空 retained 且本机也没有备份时，避免全新设备把空状态当真相回发，
 *  把整组经验刷没。账本「只增不减」，与自然增长取 max 无副作用；
 *  仅默认空间生效，其他账号组（独立主题前缀）完全不受影响。 */
const DEFAULT_FLOOR: Record<string, number> = TREE_FLOOR

/** 采纳任何账本时套用保底：默认空间下每人贡献不得低于 DEFAULT_FLOOR */
function applyFloor(contrib: Record<string, number>): Record<string, number> {
  if (!isDefaultSpace()) return contrib
  const out = { ...contrib }
  for (const [k, v] of Object.entries(DEFAULT_FLOOR)) {
    if ((out[k] ?? 0) < v) out[k] = v
  }
  return out
}

export type TreeState = {
  total: number
  /** 当日日期串 YYYY-M-D */
  day: string
  /** 当日每人已贡献经验（用于每日上限） */
  dayBy: Record<string, number>
  /** 每人最近一次领取登录经验的日期 */
  loginDay: Record<string, string>
  /** 每人终身贡献经验账本（合并时按人取最大，只增不减） */
  contrib: Record<string, number>
}

type State = TreeState & { v: number }

let initialized = false
let state: TreeState = { total: 0, day: '', dayBy: {}, loginDay: {}, contrib: {} }
let stateReceived = false
/** 已见状态的最大版本号（毫秒时间戳）：旧 retained / 自己的回声一律忽略 */
let lastV = 0
/** 首次同步完成后才允许产生修改，防止手机端慢网络下用过期本地备份覆盖云端 */
let syncReady = false
let pendingOps: Array<() => void> = []
let subscribers: Array<(s: TreeState) => void> = []
let errorListeners: Array<(msg: string) => void> = []

function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** 日期串 YYYY-M-D → 可比较的数字 */
function dayNum(s: string): number {
  const [y, m, d] = s.split('-').map(Number)
  return (y || 0) * 10000 + (m || 0) * 100 + (d || 0)
}

/** 由贡献账本推导总经验（封顶 XP_MAX） */
function deriveTotal(contrib: Record<string, number>): number {
  const sum = Object.values(contrib).reduce((a, b) => a + b, 0)
  return Math.min(sum, XP_MAX)
}

/** 兼容旧数据：没有 contrib 的，把 total 折进 legacy 桶 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateState(parsed: any): State | null {
  if (!parsed || typeof parsed.total !== 'number') return null
  const contrib: Record<string, number> = {}
  if (parsed.contrib && typeof parsed.contrib === 'object') {
    for (const [k, v] of Object.entries(parsed.contrib)) {
      if (typeof v === 'number' && v > 0) contrib[k] = v
    }
  }
  if (Object.keys(contrib).length === 0 && parsed.total > 0) {
    contrib[LEGACY_KEY] = parsed.total
  }
  const dayBy: Record<string, number> = {}
  if (parsed.dayBy && typeof parsed.dayBy === 'object') {
    for (const [k, v] of Object.entries(parsed.dayBy)) {
      if (typeof v === 'number' && v > 0) dayBy[k] = v
    }
  }
  const loginDay: Record<string, string> = {}
  if (parsed.loginDay && typeof parsed.loginDay === 'object') {
    for (const [k, v] of Object.entries(parsed.loginDay)) {
      if (typeof v === 'string' && v) loginDay[k] = v
    }
  }
  return {
    total: deriveTotal(contrib),
    day: typeof parsed.day === 'string' ? parsed.day : '',
    dayBy,
    loginDay,
    contrib,
    v: parsed.v ?? 0,
  }
}

/**
 * 合并：贡献账本按 key 取最大（只增不减，天然收敛）；
 * 当日贡献只有匹配今天才取（按人取最大）；登录日期按人取较新的一天
 */
function mergeTree(local: TreeState, remote: TreeState): TreeState {
  const contrib = { ...local.contrib }
  for (const [k, v] of Object.entries(remote.contrib)) {
    if (v > (contrib[k] ?? 0)) contrib[k] = v
  }
  const tk = todayKey()
  const dayBy: Record<string, number> = {}
  for (const s of [local, remote]) {
    if (s.day !== tk) continue
    for (const [w, n] of Object.entries(s.dayBy)) {
      if (n > (dayBy[w] ?? 0)) dayBy[w] = n
    }
  }
  const loginDay = { ...local.loginDay }
  for (const [w, d] of Object.entries(remote.loginDay)) {
    if (dayNum(d) > dayNum(loginDay[w] ?? '')) loginDay[w] = d
  }
  return {
    total: deriveTotal(contrib),
    day: Object.keys(dayBy).length > 0 ? tk : '',
    dayBy,
    loginDay,
    contrib,
  }
}

/** 被版本守卫拦下的旧包里是否有本地没有的经验/登录进展（时钟偏差兜底） */
function remoteHasExtra(local: TreeState, remote: TreeState): boolean {
  for (const [k, v] of Object.entries(remote.contrib)) {
    if (v > (local.contrib[k] ?? 0)) return true
  }
  for (const [w, d] of Object.entries(remote.loginDay)) {
    if (dayNum(d) > dayNum(local.loginDay[w] ?? '')) return true
  }
  const tk = todayKey()
  if (remote.day === tk) {
    for (const [w, n] of Object.entries(remote.dayBy)) {
      if (n > (local.day === tk ? (local.dayBy[w] ?? 0) : 0)) return true
    }
  }
  return false
}

/** 解析一份原始状态 JSON：清外组 → 迁移 → 套保底。备份与归档快照共用 */
function loadBackupFromRaw(raw: string): State | null {
  try {
    const parsed = JSON.parse(raw)
    scrubForeign(parsed)
    const migrated = migrateState(parsed)
    if (!migrated) return null
    migrated.contrib = applyFloor(migrated.contrib)
    migrated.total = deriveTotal(migrated.contrib)
    return migrated
  } catch {
    return null
  }
}

function loadBackup(): State | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    return loadBackupFromRaw(raw) // 本地备份也清掉外组数据 + 套保底
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

/** 读取最优快照归档（同样走 migrate + 保底），没有则返回 null */
function loadArchive(): State | null {
  try {
    const raw = localStorage.getItem(ARCHIVE_KEY)
    if (!raw) return null
    return loadBackupFromRaw(raw)
  } catch {
    return null
  }
}

/** 状态向善变化时更新归档：只保存"有史以来最高"的账本，低状态永远不会覆盖它 */
function maybeArchive() {
  try {
    const cur = loadArchive()
    if (cur && deriveTotal(cur.contrib) >= state.total) return
    localStorage.setItem(ARCHIVE_KEY, JSON.stringify({ ...state, v: lastV }))
  } catch {
    /* ignore */
  }
}

function notify() {
  const snapshot: TreeState = {
    ...state,
    dayBy: { ...state.dayBy },
    loginDay: { ...state.loginDay },
    contrib: { ...state.contrib },
  }
  subscribers.forEach((cb) => cb(snapshot))
}

function emitError(msg: string) {
  errorListeners.forEach((cb) => cb(msg))
}

function ensureClient() {
  if (initialized) return
  initialized = true

  // 备份 + 最优快照归档按人取最大合并：retained 被 broker 清空、备份被浏览器驱逐时，
  // 只要这台设备历史上见过更高的账本，就能原地复活，不会从零开始
  const backup = loadBackup()
  const archive = loadArchive()
  let base: State | null = backup ?? archive
  if (backup && archive) {
    const contrib = applyFloor({})
    for (const rec of [archive.contrib, backup.contrib]) {
      for (const [k, v] of Object.entries(rec)) {
        if (v > (contrib[k] ?? 0)) contrib[k] = v
      }
    }
    const loginDay = { ...archive.loginDay }
    for (const [w, d] of Object.entries(backup.loginDay)) {
      if (dayNum(d) > dayNum(loginDay[w] ?? '')) loginDay[w] = d
    }
    base = {
      ...backup,
      v: Math.max(backup.v ?? 0, archive.v ?? 0),
      dayBy: { ...archive.dayBy, ...backup.dayBy },
      loginDay,
      contrib,
    }
  }
  if (base) {
    state = {
      total: deriveTotal(base.contrib),
      day: base.day,
      dayBy: base.dayBy,
      loginDay: base.loginDay,
      contrib: base.contrib,
    }
    lastV = base.v ?? 0
  }
  // 硬保底最后过一遍：连备份带归档都没有的全新设备，也从 7100 起算而不是从 0 起算
  state = { ...state, contrib: applyFloor(state.contrib) }
  state.total = deriveTotal(state.contrib)

  const flushPending = () => {
    const ops = pendingOps
    pendingOps = []
    ops.forEach((op) => op())
  }

  sharedSubscribe(TOPIC, (payload) => {
    if (payload.length === 0) return
    try {
      const rawJson = JSON.parse(payload.toString())
      const removedForeign = scrubForeign(rawJson) // 云端混入的外组数据在入口清掉
      const parsed = migrateState(rawJson)
      if (!parsed) return
      // 云端消息同样套保底：低状态包不会被任何一台设备当作真相采纳
      parsed.contrib = applyFloor(parsed.contrib)
      parsed.total = deriveTotal(parsed.contrib)
      const incoming: TreeState = {
        total: parsed.total,
        day: parsed.day,
        dayBy: parsed.dayBy,
        loginDay: parsed.loginDay,
        contrib: parsed.contrib,
      }
      // 版本守卫：只接受更新的状态，忽略旧 retained 和自己刚发的回声
      const pv = parsed.v ?? 0
      if (pv <= lastV) {
        // 时钟偏差兜底：贡献账本按人取最大，旧包里多出来的经验照样收
        if (remoteHasExtra(state, incoming)) {
          state = mergeTree(state, incoming)
          saveBackup()
          maybeArchive()
          notify()
        }
        if (removedForeign > 0) publishState() // 回发清理后的状态，云端一并清干净
        // 云端落后于本地就回发自愈（不限于本会话首次收包），防止陈旧 retained 永久卡住
        if (pv < lastV) publishState()
        if (!stateReceived) {
          stateReceived = true
          if (!syncReady) {
            syncReady = true
            flushPending()
          }
        }
        return
      }
      lastV = pv
      stateReceived = true
      state = mergeTree(state, incoming)
      saveBackup()
      maybeArchive()
      if (!syncReady) {
        syncReady = true
        flushPending()
      }
      notify()
      if (removedForeign > 0) publishState() // 回发清理后的状态
    } catch {
      /* ignore */
    }
  })

  onSharedConnect(() => {
    setTimeout(() => {
      if (!stateReceived) {
        stateReceived = true
        // 云端为空：本地有数据就自愈回云端
        if (state.total > 0) publishState()
        syncReady = true
        flushPending()
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
  sharedPublish(TOPIC, JSON.stringify({ ...state, v } satisfies State))
}

function commit() {
  publishState()
  saveBackup()
  maybeArchive()
  notify()
}

/** 订阅爱情树状态；返回取消订阅函数 */
export function subscribeTree(
  onData: (s: TreeState) => void,
  onError?: (msg: string) => void,
): () => void {
  subscribers.push(onData)
  if (onError) errorListeners.push(onError)
  ensureClient()
  onData({
    ...state,
    dayBy: { ...state.dayBy },
    loginDay: { ...state.loginDay },
    contrib: { ...state.contrib },
  })
  return () => {
    subscribers = subscribers.filter((cb) => cb !== onData)
    if (onError) errorListeners = errorListeners.filter((cb) => cb !== onError)
  }
}

/** 今日某人还可获得的经验（剩余额度） */
export function todayLeft(s: TreeState, who: string): number {
  const used = s.day === todayKey() ? (s.dayBy[who] ?? 0) : 0
  return Math.max(0, DAILY_CAP_PER_PERSON - used)
}

/** 增加经验（登录/种植/打分等行为调用）；返回实际增加量。
 *  首次同步未完成时先排队，等拿到云端最新状态后再执行，避免用过期数据覆盖 */
export function addTreeXp(who: string, amount: number = XP_PER_ACTION): number {
  if (isGuestSession()) return 0
  ensureClient()
  if (!syncReady) {
    pendingOps.push(() => addTreeXp(who, amount))
    return 0
  }
  const key = todayKey()
  // 跨天清零当日贡献
  const dayBy = state.day === key ? { ...state.dayBy } : {}
  const used = dayBy[who] ?? 0
  const room = Math.max(0, DAILY_CAP_PER_PERSON - used)
  const gain = Math.min(room, amount, XP_MAX - state.total)
  if (gain <= 0) return 0
  dayBy[who] = used + gain
  const contrib = { ...state.contrib, [who]: (state.contrib[who] ?? 0) + gain }
  state = { ...state, total: deriveTotal(contrib), day: key, dayBy, contrib }
  commit()
  return gain
}

/** 每日登录经验：每人每天一次，+2；返回是否领取成功（未同步完成时排队处理） */
export function loginTreeXp(who: string): boolean {
  ensureClient()
  if (!syncReady) {
    pendingOps.push(() => loginTreeXp(who))
    return false
  }
  const key = todayKey()
  if (state.loginDay[who] === key) return false
  const gain = addTreeXp(who, XP_PER_ACTION)
  if (gain <= 0 && state.loginDay[who] !== key) {
    // 当天额度满了也记为已登录，避免反复尝试
    state = { ...state, loginDay: { ...state.loginDay, [who]: key } }
    commit()
    return false
  }
  state = { ...state, loginDay: { ...state.loginDay, [who]: key } }
  commit()
  return true
}

/** 当前形态（1~7）与光彩等级（0 无 / 1 繁茂 / 2 永恒） */
export function stageOf(total: number): { stage: number; aura: number } {
  let stage = 1
  for (let i = 0; i < STAGE_XP.length; i++) {
    if (total >= STAGE_XP[i]) stage = i + 1
  }
  const aura = total >= AURA_XP[1] ? 2 : total >= AURA_XP[0] ? 1 : 0
  return { stage, aura }
}

/** 下一形态/光彩门槛（全部达成后返回 null）：阶段门槛与光彩等级合并取最近的下一个 */
const NEXT_GOALS = [...STAGE_XP, ...AURA_XP].sort((a, b) => a - b)
export function nextStageXp(total: number): number | null {
  for (const xp of NEXT_GOALS) {
    if (total < xp) return xp
  }
  return null
}
