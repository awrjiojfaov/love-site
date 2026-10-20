/**
 * 你画我猜：一人作画一人实时猜，本地千道题库随机抽题，猜中奖励 200 时元。
 * 双主题：
 *  - state  主题（retained）：回合状态 + 猜词记录，三件套（lastV + 按 id 合并）
 *  - canvas 主题（retained）：笔画列表，同样按笔画 id 合并
 * 裁决规则：只有画师的设备判定猜中并颁奖（单写者，杜绝双端并发重复发奖），
 * 猜的人设备只通过 state 同步看到胜利。
 */
import { sharedPublish, sharedSubscribe, onSharedConnect, onSharedStatus } from './mqttClient'
import { isGuestSession } from './guest'
import { isPairMember, membersKnown, partnerOf } from './space'
import { addTx } from './wallet'
import { DG_WORD_BANK } from './drawguessWords'

const STATE_TOPIC = 'lovesite/drawguess/state'
const CANVAS_TOPIC = 'lovesite/drawguess/canvas'
const LS_STATE_KEY = 'lovesite-drawguess-state-backup'
const LS_CANVAS_KEY = 'lovesite-drawguess-canvas-backup'
const MAX_GUESSES = 200
const MAX_STROKES = 400
export const REWARD = 200

/* ---------------- 类型 ---------------- */

export type DGPhase = 'idle' | 'drawing'

export type DGGuess = {
  id: string
  who: string
  text: string
  ts: number
}

export type DGState = {
  v: number
  phase: DGPhase
  /** 本回合画师 */
  drawer: string
  /** 答案（本题），猜的人界面不展示 */
  word: string
  /** AI 给猜题人的提示（不含答案） */
  hint: string
  /** 出题来源：ai / local（本地词库兜底） */
  source: 'ai' | 'local'
  round: number
  startedAt: number
  /** 猜中者（名字）；null = 还没人猜中 */
  winner: string | null
  solvedAt: number | null
  guesses: DGGuess[]
}

export type DGStroke = {
  id: string
  who: string
  color: string
  size: number
  /** 归一化坐标（0~1000 的整数），成对 [x0,y0,x1,y1,...] */
  pts: number[]
  ts: number
}

export type DGCanvas = {
  v: number
  strokes: DGStroke[]
}

/* ---------------- 本地词库抽题（千道日常偏难词，不依赖 AI 密钥） ---------------- */

let lastPickedWord = ''

function pickLocalWord(): { word: string; hint: string } {
  let word = DG_WORD_BANK[0]
  for (let i = 0; i < 10; i++) {
    word = DG_WORD_BANK[Math.floor(Math.random() * DG_WORD_BANK.length)]
    if (word !== lastPickedWord) break
  }
  lastPickedWord = word
  return { word, hint: '' }
}

/** 出题：从千道题库随机抽一道（避免连续重复） */
async function nextWord(): Promise<{ word: string; hint: string; source: 'ai' | 'local' }> {
  return { ...pickLocalWord(), source: 'local' }
}

/* ---------------- 状态（state 主题） ---------------- */

let stateInitialized = false
let state: DGState = {
  v: 0,
  phase: 'idle',
  drawer: '',
  word: '',
  hint: '',
  source: 'local',
  round: 0,
  startedAt: 0,
  winner: null,
  solvedAt: null,
  guesses: [],
}
let stateReceived = false
let stateCloudReady = false
let stateLastV = 0
let stateSubs: Array<(s: DGState) => void> = []
let canvasSubs: Array<(c: DGCanvas) => void> = []
let errorListeners: Array<(msg: string) => void> = []

/* ---------------- 画布（canvas 主题） ---------------- */

let canvasInitialized = false
let canvas: DGCanvas = { v: 0, strokes: [] }
let canvasReceived = false
let canvasCloudReady = false
let canvasLastV = 0

/** 云端未就绪时：本地照常落笔/猜，标记"待广播"，就绪后自动补发（一笔都不丢） */
let pendingStrokePublish = false
let pendingGuessPublish = false
let dgFlushTimer: ReturnType<typeof setInterval> | null = null
const LS_PENDING_KEY = 'lovesite-drawguess-pending'

function loadPendingFlags(): void {
  try {
    const raw = localStorage.getItem(LS_PENDING_KEY)
    const p = raw ? (JSON.parse(raw) as { s?: boolean; g?: boolean }) : {}
    pendingStrokePublish = !!p.s
    pendingGuessPublish = !!p.g
  } catch {
    /* ignore */
  }
}

function savePendingFlags(): void {
  try {
    localStorage.setItem(LS_PENDING_KEY, JSON.stringify({ s: pendingStrokePublish, g: pendingGuessPublish }))
  } catch {
    /* ignore */
  }
}

/** 待广播补发：只要云端就绪就把本地完整笔画/猜测广播出去（全量 retained，天然幂等） */
function flushDGPending(): void {
  if (pendingGuessPublish && stateCloudReady) {
    pendingGuessPublish = false
    savePendingFlags()
    publishState()
    notifyState()
  }
  if (pendingStrokePublish && canvasCloudReady) {
    pendingStrokePublish = false
    savePendingFlags()
    publishCanvas()
    notifyCanvas()
  }
}

/** 看门狗：每 4 秒给待广播数据一次机会（注册一次即可） */
function ensureDGFlushTimer(): void {
  if (dgFlushTimer) return
  loadPendingFlags()
  dgFlushTimer = setInterval(flushDGPending, 4000)
}

/* ---------------- 工具 ---------------- */

function emitError(msg: string) {
  errorListeners.forEach((cb) => cb(msg))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scrubStateForeign(parsed: any): number {
  if (!membersKnown()) return 0
  let removed = 0
  if (Array.isArray(parsed?.guesses)) {
    const before = parsed.guesses.length
    parsed.guesses = (parsed.guesses as Array<{ who?: string }>).filter((g) =>
      isPairMember(String(g?.who ?? '')),
    )
    removed += before - parsed.guesses.length
  }
  if (parsed?.drawer && !isPairMember(String(parsed.drawer))) {
    parsed.drawer = ''
    parsed.phase = 'idle'
    removed++
  }
  if (parsed?.winner && !isPairMember(String(parsed.winner))) {
    parsed.winner = null
    removed++
  }
  return removed
}

function mergeGuesses(local: DGGuess[], remote: DGGuess[]): DGGuess[] {
  const byId = new Map<string, DGGuess>()
  for (const g of local) byId.set(g.id, g)
  for (const g of remote) if (!byId.has(g.id)) byId.set(g.id, g)
  return [...byId.values()].sort((a, b) => a.ts - b.ts).slice(-MAX_GUESSES)
}

function hasGuessNotIn(local: DGGuess[], remote: DGGuess[]): boolean {
  const ids = new Set(remote.map((g) => g.id))
  return local.some((g) => !ids.has(g.id))
}

function loadJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function saveStateBackup() {
  try {
    localStorage.setItem(LS_STATE_KEY, JSON.stringify(state))
  } catch {
    /* ignore */
  }
}

function saveCanvasBackup() {
  try {
    localStorage.setItem(LS_CANVAS_KEY, JSON.stringify(canvas))
  } catch {
    /* ignore */
  }
}

function notifyState() {
  const snapshot: DGState = { ...state, guesses: [...state.guesses] }
  stateSubs.forEach((cb) => cb(snapshot))
}

function notifyCanvas() {
  const snapshot: DGCanvas = { v: canvas.v, strokes: [...canvas.strokes] }
  canvasSubs.forEach((cb) => cb(snapshot))
}

function publishState() {
  const v = Date.now()
  stateLastV = v
  state = { ...state, v }
  sharedPublish(STATE_TOPIC, JSON.stringify(state))
}

/** 画布发布节流（只给落笔用）：每画一笔就重发整张画布 = 流量随笔数平方增长
 *  （画到第 n 笔要重传前 n 笔），连续作画时对方还没看到第 1 笔，队列里已经堆了
 *  好几条几十 KB 的全量包，把聊天/记账等要紧消息全堵在后面。
 *  合并到最多 400ms 一发：首笔立即发（对方几乎实时看到），连续快画时每 400ms
 *  用最新画布补发一发（对端看到的延迟上限就是 400ms，肉眼仍算「跟着画」）。
 *  清空/开局/结束/撤销走 publishCanvas 直发，保证语义立即生效 */
const CANVAS_PUB_MS = 400
let canvasPubAt = 0
let canvasPubTimer: ReturnType<typeof setTimeout> | null = null
function publishCanvas() {
  const v = Date.now()
  canvasLastV = v
  canvas = { v, strokes: canvas.strokes }
  canvasPubAt = Date.now()
  sharedPublish(CANVAS_TOPIC, JSON.stringify(canvas))
}
function throttleCanvasPublish() {
  const now = Date.now()
  const wait = CANVAS_PUB_MS - (now - canvasPubAt)
  if (wait <= 0) {
    publishCanvas()
    return
  }
  if (canvasPubTimer) return
  canvasPubTimer = setTimeout(() => {
    canvasPubTimer = null
    publishCanvas()
  }, wait)
}

/** 判定：归一化后完全一致才算猜中（不限次数） */
function isMatch(guess: string, word: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/[\s，。！？!?,.\-_·~～…"'"''""()（）\[\]【】]/g, '')
  const g = norm(guess)
  const w = norm(word)
  return !!g && !!w && g === w
}

/** 画师设备专用：扫描新猜测，命中则裁决 + 发奖（单写者，不会双发） */
function judgeIfDrawer() {
  if (state.phase !== 'drawing' || state.winner !== null) return
  const me = localDrawerName
  if (!me || state.drawer !== me) return
  const hit = state.guesses.find((g) => g.who !== state.drawer && isMatch(g.text, state.word))
  if (!hit) return
  state = { ...state, winner: hit.who, solvedAt: Date.now() }
  saveStateBackup()
  publishState()
  notifyState()
  addTx(hit.who, REWARD, '你画我猜猜中奖励')
}

/** 本机用户名（judgeIfDrawer 用；startRound/submitGuess 显式传 who，双保险） */
let localDrawerName = ''

export function setDGLocalName(name: string): void {
  localDrawerName = name
}

/* ---------------- 初始化 ---------------- */

function ensureStateClient() {
  if (stateInitialized) return
  stateInitialized = true

  if (!stateReceived && state.guesses.length === 0 && state.phase === 'idle') {
    const backup = loadJson<DGState>(LS_STATE_KEY)
    if (backup && typeof backup === 'object') {
      state = {
        v: backup.v ?? 0,
        phase: backup.phase === 'drawing' ? 'drawing' : 'idle',
        drawer: backup.drawer ?? '',
        word: backup.word ?? '',
        hint: backup.hint ?? '',
        source: backup.source === 'ai' ? 'ai' : 'local',
        round: backup.round ?? 0,
        startedAt: backup.startedAt ?? 0,
        winner: backup.winner ?? null,
        solvedAt: backup.solvedAt ?? null,
        guesses: Array.isArray(backup.guesses) ? backup.guesses : [],
      }
      stateLastV = backup.v ?? 0
    }
  }

  sharedSubscribe(STATE_TOPIC, (payload) => {
    if (payload.length === 0) return
    try {
      const incoming = JSON.parse(payload.toString()) as DGState
      if (!Array.isArray(incoming.guesses)) return
      const removedForeign = scrubStateForeign(incoming as unknown as Record<string, unknown>)
      stateReceived = true
      stateCloudReady = true
      flushDGPending() // 云端就绪：先补发本地待广播的猜测
      const pv = incoming.v ?? 0
      if (pv <= stateLastV) {
        if (hasGuessNotIn(state.guesses, incoming.guesses) || removedForeign > 0) {
          state = { ...state, guesses: mergeGuesses(state.guesses, incoming.guesses) }
          saveStateBackup()
          notifyState()
        }
        if (removedForeign > 0) publishState()
        return
      }
      stateLastV = pv
      const cloudMissing = hasGuessNotIn(state.guesses, incoming.guesses)
      state = {
        ...incoming,
        guesses: mergeGuesses(state.guesses, incoming.guesses),
      }
      saveStateBackup()
      notifyState()
      if (cloudMissing || removedForeign > 0) publishState()
      // 云端状态更新后画师设备继续判定新猜测
      judgeIfDrawer()
    } catch {
      /* ignore */
    }
  })

  onSharedConnect(() => {
    setTimeout(() => {
      if (!stateReceived) {
        const backup = loadJson<DGState>(LS_STATE_KEY)
        stateCloudReady = true
        flushDGPending()
        if (backup && (backup.phase === 'drawing' || backup.guesses?.length > 0)) {
          state = { ...state, ...backup, v: stateLastV }
          notifyState()
        }
      }
    }, 3000)
  })

  onSharedStatus((status, msg) => {
    if (status === 'error') emitError(`连接消息服务器失败：${msg}`)
    else if (status === 'offline') emitError('消息服务器连接中断，正在自动重连…')
    else if (status === 'reconnect') emitError('')
  })
}

function ensureCanvasClient() {
  if (canvasInitialized) return
  canvasInitialized = true

  if (!canvasReceived && canvas.strokes.length === 0) {
    const backup = loadJson<DGCanvas>(LS_CANVAS_KEY)
    if (backup && Array.isArray(backup.strokes)) {
      canvas = { v: backup.v ?? 0, strokes: backup.strokes }
      canvasLastV = backup.v ?? 0
    }
  }

  sharedSubscribe(CANVAS_TOPIC, (payload) => {
    if (payload.length === 0) return
    try {
      const incoming = JSON.parse(payload.toString()) as DGCanvas
      if (!Array.isArray(incoming.strokes)) return
      canvasReceived = true
      canvasCloudReady = true
      flushDGPending() // 云端就绪：先补发本地待广播的笔画
      const pv = incoming.v ?? 0
      const byId = new Map<string, DGStroke>()
      for (const s of canvas.strokes) byId.set(s.id, s)
      let changed = false
      for (const s of incoming.strokes) {
        if (!byId.has(s.id)) {
          byId.set(s.id, s)
          changed = true
        }
      }
      // 画布清空（v 更新但笔画更少）：以新版为准
      if (pv > canvasLastV && incoming.strokes.length < canvas.strokes.length) {
        canvas = { v: pv, strokes: incoming.strokes }
        saveCanvasBackup()
        notifyCanvas()
        judgeIfDrawer()
        return
      }
      if (pv <= canvasLastV && !changed) return
      canvasLastV = Math.max(canvasLastV, pv)
      canvas = { v: canvasLastV, strokes: [...byId.values()].sort((a, b) => a.ts - b.ts).slice(-MAX_STROKES) }
      saveCanvasBackup()
      notifyCanvas()
      judgeIfDrawer()
    } catch {
      /* ignore */
    }
  })

  onSharedConnect(() => {
    setTimeout(() => {
      if (!canvasReceived) {
        const backup = loadJson<DGCanvas>(LS_CANVAS_KEY)
        canvasCloudReady = true
        flushDGPending()
        if (backup && backup.strokes?.length > 0) {
          canvas = { v: canvasLastV, strokes: backup.strokes }
          notifyCanvas()
        }
      }
    }, 3000)
  })
}

/* ---------------- 对外 API ---------------- */

export function subscribeDG(
  onState: (s: DGState) => void,
  onCanvas: (c: DGCanvas) => void,
  onError?: (msg: string) => void,
): () => void {
  ensureDGFlushTimer()
  stateSubs.push(onState)
  canvasSubs.push(onCanvas)
  if (onError) errorListeners.push(onError)
  ensureStateClient()
  ensureCanvasClient()
  onState({ ...state, guesses: [...state.guesses] })
  onCanvas({ v: canvas.v, strokes: [...canvas.strokes] })
  return () => {
    stateSubs = stateSubs.filter((cb) => cb !== onState)
    canvasSubs = canvasSubs.filter((cb) => cb !== onCanvas)
    if (onError) errorListeners = errorListeners.filter((cb) => cb !== onError)
  }
}

/** 开始一回合（点按钮的人当画师；AI 出题，失败用本地词库） */
export async function startDGRound(who: string): Promise<void> {
  if (isGuestSession()) return
  ensureStateClient()
  setDGLocalName(who)
  const w = await nextWord()
  canvas = { v: canvas.v, strokes: [] }
  saveCanvasBackup()
  publishCanvas()
  state = {
    ...state,
    phase: 'drawing',
    drawer: who,
    word: w.word,
    hint: w.hint,
    source: w.source,
    round: state.round + 1,
    startedAt: Date.now(),
    winner: null,
    solvedAt: null,
    guesses: [],
  }
  saveStateBackup()
  publishState()
  notifyState()
  notifyCanvas()
}

/** 画师换一道题（重新 AI 出题，画布清空，已猜记录清空） */
export async function dgNewWord(who: string): Promise<void> {
  if (state.phase !== 'drawing' || state.drawer !== who || state.winner) return
  const w = await nextWord()
  canvas = { v: canvas.v, strokes: [] }
  saveCanvasBackup()
  publishCanvas()
  state = { ...state, word: w.word, hint: w.hint, source: w.source, guesses: [], winner: null, solvedAt: null, startedAt: Date.now() }
  saveStateBackup()
  publishState()
  notifyState()
  notifyCanvas()
}

/** 画师结束本局（回 idle，清画布） */
export function dgEndRound(who: string): void {
  if (isGuestSession()) return
  ensureStateClient()
  if (state.phase !== 'drawing' || state.drawer !== who) return
  canvas = { v: canvas.v, strokes: [] }
  saveCanvasBackup()
  publishCanvas()
  state = { ...state, phase: 'idle', winner: null, solvedAt: null, guesses: [] }
  saveStateBackup()
  publishState()
  notifyState()
  notifyCanvas()
}

/** 提交一次猜测（不限次数；画师的设备负责判定）；云端未就绪先本地记账，就绪自动补发 */
export function dgGuess(who: string, text: string): boolean {
  if (isGuestSession()) return false
  ensureStateClient()
  if (state.phase !== 'drawing') return false
  const trimmed = text.trim().slice(0, 20)
  if (!trimmed) return false
  state = {
    ...state,
    guesses: [
      ...state.guesses,
      {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        who,
        text: trimmed,
        ts: Date.now(),
      },
    ].slice(-MAX_GUESSES),
  }
  saveStateBackup()
  if (stateCloudReady) publishState()
  else {
    pendingGuessPublish = true
    savePendingFlags()
  }
  notifyState()
  judgeIfDrawer()
  return true
}

/** 画师落笔完成一笔（整笔上传，归一化坐标）；云端未就绪先本地落笔，就绪自动补发 */
export function dgAddStroke(who: string, stroke: Omit<DGStroke, 'id' | 'who' | 'ts'>): boolean {
  if (isGuestSession()) return false
  ensureCanvasClient()
  if (state.phase !== 'drawing' || state.drawer !== who) return false
  if (canvas.strokes.length >= MAX_STROKES) return false
  canvas = {
    v: canvas.v,
    strokes: [
      ...canvas.strokes,
      {
        ...stroke,
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        who,
        ts: Date.now(),
      },
    ],
  }
  saveCanvasBackup()
  if (canvasCloudReady) throttleCanvasPublish()
  else {
    pendingStrokePublish = true
    savePendingFlags()
  }
  notifyCanvas()
  return true
}

/** 画师撤销自己最后一笔 */
export function dgUndoStroke(who: string): void {
  if (isGuestSession()) return
  ensureCanvasClient()
  if (state.drawer !== who) return
  const idx = [...canvas.strokes].map((s, i) => ({ s, i })).reverse().find((x) => x.s.who === who)?.i
  if (idx === undefined) return
  canvas = { v: canvas.v, strokes: canvas.strokes.filter((_, i) => i !== idx) }
  saveCanvasBackup()
  publishCanvas()
  notifyCanvas()
}

/** 画师清空画布 */
export function dgClearCanvas(who: string): void {
  if (isGuestSession()) return
  ensureCanvasClient()
  if (state.drawer !== who) return
  canvas = { v: canvas.v, strokes: [] }
  saveCanvasBackup()
  publishCanvas()
  notifyCanvas()
}

/** 搭档是谁（UI 展示用） */
export function dgPartnerName(me: string): string {
  return partnerOf(me)
}
