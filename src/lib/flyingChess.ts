/**
 * 情侣飞行棋（隐藏页）—— 云端对战状态。
 *
 * 玩法移植自开源项目 ChesterTAKA/couple-flying-chess（Next.js + Supabase），
 * 这里去掉 Supabase，改为复用「秘密花园」自己的 MQTT retained 通道，
 * 按 space 自动改写话题（lovesite-pair-<id>/flyingchess/state），两人两台手机实时同步。
 *
 * 规则（与原项目一致）：
 *  - 7×7 螺旋棋盘，共 49 格，终点 = 第 49 格（下标 48）
 *  - 掷骰前进；踩到幸运星 / 陷阱 / 撞机触发任务
 *  - 执行者点「完成」，观察者判定「已执行 / 未执行」
 *  - 未执行：执行者随机后退 0–3 格（撞机场景有特殊退回规则）
 *  - 先到终点者获胜
 *
 * 同步：单文件状态 + 版本号（Date.now()）latest-wins；本地备份防重启闪烁；
 * 空闲自愈（收到旧版本号回发）。题库与对局同存于本状态，双方都可看到与编辑。
 *
 * 题库数据外置在 ./tasks.json（schema 与上游 lib/tasks.json 一致），见下方 builtinThemes()。
 * 内置的是一套温馨/恋爱向内容；需要别的口味时，直接改 tasks.json 或在页面上自行新建主题与任务。
 */
import { sharedPublish, sharedSubscribe, onSharedConnect } from './mqttClient'
import { getPairMembers } from './space'
import { isGuestSession } from './guest'
import BUILTIN_LIBRARY from './tasks.json'

const TOPIC = 'lovesite/flyingchess/state'
const LS_KEY = 'lovesite-flyingchess-backup'

export const BOARD_SIZE = 49
export const GRID_N = 7

/** 幸运星 / 陷阱格子（0-based，与原项目一致） */
const STAR_CELLS = [2, 4, 6, 8, 9, 11, 12, 15, 22, 25, 27, 31, 36, 37, 40, 41, 43]
const TRAP_CELLS = [3, 14, 19, 33, 42, 46, 47]

export type ChessTask = { id: string; text: string }
export type ChessTheme = { id: string; title: string; author: string; tasks: ChessTask[] }
export type TriggerType = 'star' | 'trap' | 'collision'
export type PendingTask = {
  type: TriggerType
  position: number
  executor: string
  observer: string
  status: 'pending' | 'executed'
  taskText: string
  meta?: { dice?: number; attackerOld?: number; penalty?: number }
}
export type ChessPhase = 'setup' | 'playing' | 'completed'

export type ChessState = {
  v: number
  phase: ChessPhase
  /** 两位成员（空间成员名，顺序固定） */
  players: [string, string]
  /** 题库：双方共享可见 */
  themes: ChessTheme[]
  /** 玩家名 -> 已选主题 id */
  chosen: Record<string, string>
  /** 先手 */
  starter: string
  /** 当前该谁掷骰 */
  current: string
  turn: number
  /** 玩家名 -> 位置（0..48） */
  pos: Record<string, number>
  special: Record<number, 'star' | 'trap'>
  pending: PendingTask | null
  winner: string | null
  updatedAt: number
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10)
}

export function playersNow(): [string, string] {
  const m = getPairMembers()
  if (m.length === 2) return [m[0], m[1]]
  return ['玩家一', '玩家二']
}

/* ---------------- 内置题库（数据外置到 ./tasks.json） ----------------
 *
 * 题库内容不再写死在代码里，而是放在同目录的 `tasks.json`，schema 与开源项目
 * ChesterTAKA/couple-flying-chess 的 `lib/tasks.json` 完全一致：
 *
 *     [ { title, description, type, task_count, tasks: string[] }, … ]
 *
 * 想加内容/换内容**只改这个 JSON 即可**，无需动代码（构建时被打进 bundle）。
 * 每一条转换成一套 ChessTheme：
 *  - id 由标题派生且**稳定**（同一份 JSON 在任何设备上都得到同一批 id），
 *    云端合并时不会互相顶掉，也不会每次开页面都冒出一套新题库；
 *  - 题目 id 用「主题序号-题号」而非随机串，保证两端一致、便于定位。
 */
type RawLibraryTheme = {
  title?: string
  description?: string
  type?: string
  task_count?: number
  tasks?: unknown
}

/** 标题 → 稳定 slug（纯中文标题会得到空串，此时退回 themeN 序号，同样稳定） */
function titleSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

let builtinCache: ChessTheme[] | null = null
/** 内置题库：惰性构建一次并缓存（sanitize() 每条入站消息都会取 base，不能反复重建） */
export function builtinThemes(): ChessTheme[] {
  if (builtinCache) return builtinCache
  const raw = BUILTIN_LIBRARY as RawLibraryTheme[]
  const seen = new Set<string>()
  const out: ChessTheme[] = []
  raw.forEach((t, ti) => {
    const title = String(t?.title ?? '').trim()
    const list = Array.isArray(t?.tasks) ? t.tasks : []
    const tasks: ChessTask[] = list
      .map((s, si) => ({ id: `bt${ti}-${si}`, text: String(s ?? '').trim() }))
      .filter((k) => k.text.length > 0)
    if (!title || tasks.length === 0) return
    let key = titleSlug(title) || `theme${ti}`
    while (seen.has(key)) key = `${key}-${ti}`
    seen.add(key)
    out.push({ id: `builtin-${key}`, title, author: '内置题库', tasks })
  })
  builtinCache = out
  return out
}

/** JSON 被清空/解析不出内容时的兜底：至少保证能开一局 */
function fallbackTheme(author: string): ChessTheme {
  return {
    id: 'builtin-fallback',
    title: '甜蜜日常',
    author,
    tasks: ['给对方一个 10 秒的拥抱', '认真夸对方三个优点', '对视 30 秒，先笑的人认输'].map((text) => ({
      id: uid(),
      text,
    })),
  }
}

/** 内置题库的浅拷贝（避免共享同一批主题对象被后续就地改写） */
function seedThemes(author: string): ChessTheme[] {
  const b = builtinThemes()
  return b.length > 0 ? b.map((t) => ({ ...t })) : [fallbackTheme(author)]
}

function initialState(): ChessState {
  const [a, b] = playersNow()
  return {
    v: 0,
    phase: 'setup',
    players: [a, b],
    themes: seedThemes(a),
    chosen: {},
    starter: a,
    current: a,
    turn: 1,
    pos: { [a]: 0, [b]: 0 },
    special: {},
    pending: null,
    winner: null,
    updatedAt: 0,
  }
}

let initialized = false
let stateReceived = false
let state: ChessState = initialState()
let lastV = 0
let subscribers: Array<(s: ChessState) => void> = []

function sanitize(raw: unknown): ChessState | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<ChessState>
  if (!r.players || !Array.isArray(r.players)) return null
  const base = initialState()
  return {
    v: typeof r.v === 'number' ? r.v : 0,
    phase: r.phase === 'playing' || r.phase === 'completed' ? r.phase : 'setup',
    players: [String(r.players[0] ?? base.players[0]), String(r.players[1] ?? base.players[1])],
    themes: Array.isArray(r.themes) ? (r.themes as ChessTheme[]).filter((t) => t && t.id) : base.themes,
    chosen: r.chosen && typeof r.chosen === 'object' ? r.chosen : {},
    starter: String(r.starter ?? base.starter),
    current: String(r.current ?? base.current),
    turn: typeof r.turn === 'number' ? r.turn : 1,
    pos: r.pos && typeof r.pos === 'object' ? r.pos : base.pos,
    special: r.special && typeof r.special === 'object' ? r.special : {},
    pending: (r.pending ?? null) as PendingTask | null,
    winner: r.winner ? String(r.winner) : null,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
  }
}

function loadBackup(): ChessState | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    return sanitize(JSON.parse(raw))
  } catch {
    return null
  }
}

function saveBackup() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state))
  } catch {
    /* ignore */
  }
}

function notify() {
  const snapshot = { ...state }
  subscribers.forEach((cb) => cb(snapshot))
}

/** 写状态并广播（版本号 = 当前毫秒） */
function commit(patch: Partial<ChessState>): void {
  const v = Date.now()
  lastV = v
  state = { ...state, ...patch, v, updatedAt: v }
  saveBackup()
  notify()
  sharedPublish(TOPIC, JSON.stringify(state))
}

function ensureClient() {
  if (initialized) return
  initialized = true

  const backup = loadBackup()
  if (backup) {
    state = backup
    lastV = backup.v ?? 0
  }
  // 兜底：把内置题库补齐（旧备份里没有 themes，或题库被删空）
  if (!state.themes || state.themes.length === 0) {
    state = { ...state, themes: seedThemes(state.players[0]) }
  }

  sharedSubscribe(TOPIC, (payload) => {
    if (payload.length === 0) return
    try {
      const remote = sanitize(JSON.parse(payload.toString()))
      if (!remote) return
      stateReceived = true
      const pv = remote.v ?? 0
      if (pv <= lastV) return
      lastV = pv
      state = remote
      saveBackup()
      notify()
    } catch {
      /* ignore */
    }
  })

  onSharedConnect(() => {
    setTimeout(() => {
      if (!stateReceived) {
        stateReceived = true
        // 云端迟迟没有状态：保留本地备份展示，等待对方/自己首次写入
        notify()
      }
    }, 3000)
  })
}

/** 订阅对局状态（立即回放现值） */
export function subscribeChess(cb: (s: ChessState) => void): () => void {
  subscribers.push(cb)
  ensureClient()
  cb({ ...state })
  return () => {
    subscribers = subscribers.filter((f) => f !== cb)
  }
}

/** 同步读取当前状态（未初始化时读本地备份兜底） */
export function chessNow(): ChessState {
  if (!initialized) {
    const backup = loadBackup()
    if (backup) state = backup
  }
  return state
}

/* ---------------- 对局动作 ---------------- */

function freshPositions(): Record<string, number> {
  const [a, b] = state.players
  return { [a]: 0, [b]: 0 }
}

function buildSpecial(): Record<number, 'star' | 'trap'> {
  const cells: Record<number, 'star' | 'trap'> = {}
  for (const i of STAR_CELLS) cells[i] = 'star'
  for (const i of TRAP_CELLS) cells[i] = 'trap'
  return cells
}

/** 开始 / 重新开始一局：随机先手 */
export function startMatch(): void {
  if (isGuestSession()) return
  ensureClient()
  const [a, b] = state.players
  const starter = Math.random() < 0.5 ? a : b
  commit({
    phase: 'playing',
    starter,
    current: starter,
    turn: 1,
    pos: freshPositions(),
    special: buildSpecial(),
    pending: null,
    winner: null,
  })
}

/** 回到准备页（不改题库，只复位棋盘） */
export function backToSetup(): void {
  if (isGuestSession()) return
  ensureClient()
  commit({ phase: 'setup', pending: null, winner: null, pos: freshPositions(), special: {}, turn: 1 })
}

function pickTaskFor(themeId: string | undefined): string {
  if (!themeId) return ''
  const theme = state.themes.find((t) => t.id === themeId)
  if (!theme || theme.tasks.length === 0) return ''
  return theme.tasks[Math.floor(Math.random() * theme.tasks.length)].text
}

/** 掷骰推进。仅当轮到你且没有待处理任务时有效。 */
export function roll(byName: string): boolean {
  if (isGuestSession()) return false
  ensureClient()
  if (state.phase !== 'playing') return false
  if (state.pending) return false
  if (state.current !== byName) return false

  const [a, b] = state.players
  const dice = Math.floor(Math.random() * 6) + 1
  const oldPos = state.pos[byName] ?? 0
  const tentative = oldPos + dice
  const newPos = tentative >= BOARD_SIZE ? BOARD_SIZE - 1 : tentative

  const pos = { ...state.pos, [byName]: newPos }

  // 抵达终点：直接获胜
  if (newPos === BOARD_SIZE - 1) {
    commit({ pos, phase: 'completed', winner: byName, pending: null })
    return true
  }

  const other = byName === a ? b : a
  const otherPos = state.pos[other] ?? 0
  const specialType = state.special[newPos]
  const isCollision = newPos === otherPos

  if (specialType || isCollision) {
    let type: TriggerType = 'star'
    let executor = other
    let observer = byName
    let themeId = state.chosen[byName]

    if (isCollision) {
      type = 'collision'
      observer = byName
      executor = other
      themeId = state.chosen[byName]
    } else if (specialType === 'star') {
      type = 'star'
      observer = byName
      executor = other
      themeId = state.chosen[byName]
    } else if (specialType === 'trap') {
      type = 'trap'
      executor = byName
      observer = other
      themeId = state.chosen[other]
    }

    const pending: PendingTask = {
      type,
      position: newPos,
      executor,
      observer,
      status: 'pending',
      taskText: pickTaskFor(themeId),
      meta: { dice, attackerOld: isCollision ? oldPos : undefined },
    }
    // 冻结回合推进，待判定后再切换
    commit({ pos, pending })
    return true
  }

  // 无任务：切换回合
  commit({ pos, current: other, turn: state.turn + 1 })
  return true
}

/** 执行者点「完成任务」 */
export function confirmExecution(byName: string): boolean {
  if (isGuestSession()) return false
  ensureClient()
  const p = state.pending
  if (!p || p.status !== 'pending') return false
  if (p.executor !== byName) return false
  commit({ pending: { ...p, status: 'executed' } })
  return true
}

/** 观察者判定：done=true 已执行 / false 未执行（未执行触发后退惩罚） */
export function verifyTask(byName: string, done: boolean): boolean {
  if (isGuestSession()) return false
  ensureClient()
  const p = state.pending
  if (!p || p.status !== 'executed') return false
  if (p.observer !== byName) return false

  const [a, b] = state.players
  const pos = { ...state.pos }

  if (p.type === 'collision') {
    if (done) {
      // 对方完成：撞击者退回回合开始前的格子
      const attacker = p.observer
      pos[attacker] = Math.max(0, p.meta?.attackerOld ?? 0)
    } else {
      // 未完成：被撞者退回起点
      pos[p.executor] = 0
    }
  } else if (!done) {
    const penalty = Math.floor(Math.random() * 4) // 0..3
    pos[p.executor] = Math.max(0, (pos[p.executor] ?? 0) - penalty)
    p.meta = { ...(p.meta ?? {}), penalty }
  }

  // 判定后轮到另一方
  const nextCurrent = state.current === a ? b : a
  commit({ pos, pending: null, current: nextCurrent, turn: state.turn + 1 })
  return true
}

/* ---------------- 题库管理（双方共享） ---------------- */

export function addTheme(title: string, author: string): string | null {
  if (isGuestSession()) return null
  ensureClient()
  const name = title.trim()
  if (!name) return null
  const theme: ChessTheme = { id: uid(), title: name, author, tasks: [] }
  commit({ themes: [...state.themes, theme] })
  return theme.id
}

export function removeTheme(id: string): void {
  if (isGuestSession()) return
  ensureClient()
  const themes = state.themes.filter((t) => t.id !== id)
  const chosen: Record<string, string> = {}
  for (const [k, val] of Object.entries(state.chosen)) if (val !== id) chosen[k] = val
  commit({ themes, chosen })
}

export function addTask(themeId: string, text: string): void {
  if (isGuestSession()) return
  ensureClient()
  const t = text.trim()
  if (!t) return
  const themes = state.themes.map((th) =>
    th.id === themeId ? { ...th, tasks: [...th.tasks, { id: uid(), text: t }] } : th,
  )
  commit({ themes })
}

export function removeTask(themeId: string, taskId: string): void {
  if (isGuestSession()) return
  ensureClient()
  const themes = state.themes.map((th) =>
    th.id === themeId ? { ...th, tasks: th.tasks.filter((k) => k.id !== taskId) } : th,
  )
  commit({ themes })
}

/** 选主题（准备页，每人各选一个） */
export function chooseTheme(player: string, themeId: string): void {
  if (isGuestSession()) return
  ensureClient()
  commit({ chosen: { ...state.chosen, [player]: themeId } })
}
