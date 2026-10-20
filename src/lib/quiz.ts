/**
 * 默契挑战云端同步：与见闻打分同款 MQTT 实时通道（独立主题）。
 * - 每日一题：内置题库 + 双方自建题，按日期轮换，两台手机题目一致
 * - 双方盲答，都答完才揭晓；答案实时推送
 * - 合并同步：答案按 (日期, 人) 合并取最新，自建题求并集，两人同时答不互丢
 */
import { sharedPublish, sharedSubscribe, sharedResync, onSharedConnect, onSharedStatus } from './mqttClient'
import { publishPartial, subscribePartial, partialSeenAt, type PartialEnvelope } from './syncPartial'
import { getUserSession } from './auth'
import { isGuestSession } from './guest'
import { BUILTIN_QUESTIONS } from '../data/questions'
import { addTx } from './wallet'
import { isPairMember, membersKnown } from './space'

/** 清理混入的外组账号数据：答案只保留当前空间成员的 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scrubForeign(parsed: any): number {
  if (!membersKnown() || !Array.isArray(parsed?.answers)) return 0
  const before = parsed.answers.length
  parsed.answers = (parsed.answers as Array<{ who?: string }>).filter((a) => isPairMember(String(a?.who ?? '')))
  return before - parsed.answers.length
}

const TOPIC = 'lovesite/quiz/state'
const LS_KEY = 'lovesite-quiz-backup'

/** 答案历史上限：按时间倒序保留最近 400 条，防止包体无限膨胀 */
const MAX_ANSWERS = 400

export type QuizAnswer = {
  date: string // YYYY-MM-DD
  question: string
  who: string
  answer: string
  ts: number
}

export type DailyQuiz = {
  date: string
  question: string
}

export type QuizData = {
  custom: string[]
  answers: QuizAnswer[]
  daily: DailyQuiz | null
}

type State = { custom: string[]; answers: QuizAnswer[]; daily: DailyQuiz | null; v: number }

let initialized = false
let custom: string[] = []
let answers: QuizAnswer[] = []
let daily: DailyQuiz | null = null
let lastV = 0
let stateReceived = false
let cloudReady = false // 收到云端状态（或确认云端为空）前，禁止任何发布，防止空状态覆盖云端
let subscribers: Array<(data: QuizData) => void> = []
let errorListeners: Array<(msg: string) => void> = []

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateAnswers(raw: any): QuizAnswer[] {
  if (!Array.isArray(raw)) return []
  return raw
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((a: any) => ({
      date: String(a?.date ?? ''),
      question: String(a?.question ?? ''),
      who: String(a?.who ?? ''),
      answer: String(a?.answer ?? ''),
      ts: Number(a?.ts ?? 0),
    }))
    .filter((a) => a.date && a.who)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateDaily(raw: any): DailyQuiz | null {
  if (!raw || typeof raw !== 'object') return null
  const date = String(raw.date ?? '')
  const question = String(raw.question ?? '')
  return date && question ? { date, question } : null
}

/** 答案合并：键 = 日期|人，同键取 ts 较新者（重复提交视为修改） */
function mergeAnswers(local: QuizAnswer[], remote: QuizAnswer[]): QuizAnswer[] {
  const map = new Map<string, QuizAnswer>()
  for (const a of [...remote, ...local]) {
    const key = `${a.date}|${a.who}`
    const ex = map.get(key)
    if (!ex || a.ts >= ex.ts) map.set(key, a)
  }
  return [...map.values()].sort((a, b) => b.ts - a.ts).slice(0, MAX_ANSWERS)
}

/** 自建题合并：并集，顺序以较新一方为主，本地独有的附后（顺序影响轮换取题） */
function mergeCustom(local: string[], remote: string[]): string[] {
  const out = [...remote]
  for (const q of local) if (!out.includes(q)) out.push(q)
  return out
}

/** 每日定题合并：日期较新者胜；同一天取非空的那个 */
function mergeDailyState(l: DailyQuiz | null, r: DailyQuiz | null): DailyQuiz | null {
  if (!l) return r
  if (!r) return l
  return r.date >= l.date ? r : l
}

function loadBackup(): State | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as State
    scrubForeign(parsed as unknown as Record<string, unknown>) // 本地备份也清掉外组数据
    return {
      custom: Array.isArray(parsed.custom) ? parsed.custom.map(String) : [],
      answers: migrateAnswers(parsed.answers),
      daily: migrateDaily(parsed.daily),
      v: parsed.v ?? 0,
    }
  } catch {
    return null
  }
}

function saveBackup() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ custom, answers, daily, v: lastV }))
  } catch {
    /* ignore */
  }
}

function notify() {
  const data: QuizData = { custom: [...custom], answers: [...answers], daily }
  subscribers.forEach((cb) => cb(data))
}

function emitError(msg: string) {
  errorListeners.forEach((cb) => cb(msg))
}

/* ---------- 分片同步（2026-10-18） ----------
 * 默契挑战最典型的故障：两个人几乎同时在答题，双方各发一份「只含自己答案」的整包，
 * 谁的一包丢了，对方就永远只看到自己那半（刷新 = 退订重订拉 retained 才补上）。
 * 现在多一条 <topic>/~p 分片通道：刷新/提交时顺手把自己这份答案（最近 3 天）发过去，
 * 对端按 (日期, 人) 合并——两个人的答案都不丢，也不必等整包。 */
interface QuizSide { answers: QuizAnswer[]; custom: string[]; daily: DailyQuiz | null }

/** 我的这一片：最近 3 天的答案 + 自建题 + 今日定题（几 KB，秒到） */
function mySide(): QuizSide {
  const since = Date.now() - 3 * 86400_000
  return { answers: answers.filter((a) => a.ts >= since), custom, daily }
}

function onSidePacket(msg: PartialEnvelope): void {
  const me = getUserSession()?.name ?? ''
  if (!isPairMember(msg.who) || msg.who === me) return
  const data = msg.data as QuizSide | undefined
  if (!data) return
  const rAnswers = migrateAnswers(data.answers)
  const rCustom = Array.isArray(data.custom) ? data.custom.map(String) : []
  answers = mergeAnswers(answers, rAnswers)
  custom = mergeCustom(custom, rCustom)
  daily = mergeDailyState(daily, migrateDaily(data.daily))
  saveBackup()
  notify()
  // 「也把你那份报给我」（刷新时的双向对齐）：回发一次，不带 req，不会递归
  if (msg.req && me) {
    publishPartial<QuizSide>(TOPIC, me, mySide(), { echo: false })
  }
}

function ensureClient() {
  if (initialized) return
  initialized = true

  // 本地缓存先行：先用上次的备份立刻渲染，云端数据到了再合并
  const backup = loadBackup()
  if (backup) {
    custom = backup.custom
    answers = backup.answers
    daily = backup.daily
    lastV = backup.v ?? 0
  }

  sharedSubscribe(TOPIC, (payload) => {
    if (payload.length === 0) return
    try {
      const state = JSON.parse(payload.toString()) as State
      if (typeof state.v !== 'number') return
      const removedForeign = scrubForeign(state as unknown as Record<string, unknown>) // 外组答案入口清掉
      if (state.v <= lastV) {
        // 回声或旧包；云端落后于本地（代理丢数据）则回发自愈
        if (!stateReceived) {
          stateReceived = true
          cloudReady = true
          if (state.v < lastV) publishState()
        }
        if (removedForeign > 0) publishState() // 回发清理后的状态
        // 时钟偏差兜底：旧版本号里若夹着本地没有的答案/题目，照样合并进来
        const rAnswers = migrateAnswers(state.answers)
        const rCustom = Array.isArray(state.custom) ? state.custom.map(String) : []
        if (
          rAnswers.some((a) => !answers.some((l) => l.date === a.date && l.who === a.who)) ||
          rCustom.some((q) => !custom.includes(q))
        ) {
          answers = mergeAnswers(answers, rAnswers)
          custom = mergeCustom(custom, rCustom)
          daily = mergeDailyState(daily, migrateDaily(state.daily))
          saveBackup()
          notify()
        }
        return
      }
      lastV = state.v
      stateReceived = true
      cloudReady = true
      const rAnswers = migrateAnswers(state.answers)
      const rCustom = Array.isArray(state.custom) ? state.custom.map(String) : []
      const rDaily = migrateDaily(state.daily)
      const localExtra =
        answers.some((a) => !rAnswers.some((r) => r.date === a.date && r.who === a.who)) ||
        custom.some((q) => !rCustom.includes(q))
      answers = mergeAnswers(answers, rAnswers)
      custom = mergeCustom(custom, rCustom)
      daily = mergeDailyState(daily, rDaily)
      saveBackup()
      notify()
      if (localExtra || removedForeign > 0) publishState() // 反熵 + 回发清理后的状态
    } catch {
      /* ignore */
    }
  })

  onSharedConnect(() => {
    setTimeout(() => {
      if (!stateReceived) {
        stateReceived = true
        cloudReady = true
        // 云端为空：本地有内容就自愈回云端
        if (answers.length > 0 || custom.length > 0 || daily) publishState()
        else notify()
      }
    }, 3000)
  })

  onSharedStatus((status, msg) => {
    if (status === 'error') emitError(`连接消息服务器失败：${msg}`)
    else if (status === 'offline') emitError('消息服务器连接中断，正在自动重连…')
    else if (status === 'reconnect') emitError('')
  })

  // 分片通道：对方点「刷新」或提交时只收他那一片答案，不必等整包
  subscribePartial<QuizSide>(TOPIC, onSidePacket)
}

function publishState() {
  // Lamport 版本：手机时钟比对方慢几分钟时，旧实现每次发布都被判成「旧包」——
  // 对方只能靠 key 级兜底合并，且不会触发回发，是「同时填写互相看不到」的一条暗线
  const v = Math.max(Date.now(), lastV + 1)
  lastV = v
  const state: State = { custom, answers, daily, v }
  sharedPublish(TOPIC, JSON.stringify(state))
}

function commit() {
  publishState()
  saveBackup()
  notify()
  // 订阅走 QoS0：一次发布丢了，对方就只能等下次改动或手动刷新。
  // 提交后补发一次（内容相同、版本更大），把「同填时看不到对方答案」堵死。
  setTimeout(publishState, 1200)
}

/** 订阅默契挑战数据；返回取消订阅函数 */
export function subscribeQuiz(
  onData: (data: QuizData) => void,
  onError?: (msg: string) => void,
): () => void {
  subscribers.push(onData)
  if (onError) errorListeners.push(onError)
  ensureClient()
  onData({ custom: [...custom], answers: [...answers], daily })
  return () => {
    subscribers = subscribers.filter((cb) => cb !== onData)
    if (onError) errorListeners = errorListeners.filter((cb) => cb !== onError)
  }
}

/** 提交今天的答案（每人每天一条，重复提交视为修改） */
export function submitAnswer(date: string, question: string, who: string, answer: string): void {
  if (isGuestSession()) return
  ensureClient()
  
  // 获取当前日期的所有答案
  const todayAnswers = answers.filter(a => a.date === date)
  
  // 检查是否有其他人的答案，并且答案匹配
  for (const otherAnswer of todayAnswers) {
    if (otherAnswer.who !== who && 
        otherAnswer.answer.trim().toLowerCase() === answer.trim().toLowerCase()) {
      // 答案匹配，奖励200时元给双方（交易 id 确定性：重复提交/分片回放不会重复发奖）
      addTx(who, 200, `默契挑战答案匹配「${question}」`, `quiz-match-${date}-${who}`)
      addTx(otherAnswer.who, 200, `默契挑战答案匹配「${question}」`, `quiz-match-${date}-${otherAnswer.who}`)
      break
    }
  }
  
  answers = answers.filter((a) => !(a.date === date && a.who === who))
  answers = [{ date, question, who, answer, ts: Date.now() }, ...answers].slice(0, MAX_ANSWERS)
  commit()
  // 分片直发：对方页面几十毫秒内就能看到我的答案，不必等整包、也不必点刷新
  publishPartial<QuizSide>(TOPIC, who, mySide())
}

/** 添加一道自建题，进入每日轮换 */
export function addCustomQuestion(q: string): boolean {
  if (isGuestSession()) return false
  const trimmed = q.trim()
  const pool = [...BUILTIN_QUESTIONS, ...custom]
  if (!trimmed || pool.includes(trimmed)) return false
  ensureClient()
  custom = [...custom, trimmed]
  commit()
  return true
}

/** 手动刷新：重拉云端 retained（退订重订）+ 把自己的分片发过去并请对方回一份。
 *  只靠退订重订的话，双方同填时云端 retained 可能正好停在「只有对方答案」的那一版；
 *  双向分片对齐能把两个人各自手里的答案合到一起。 */
export function resyncQuiz() {
  ensureClient()
  stateReceived = false
  sharedResync(TOPIC)
  const me = getUserSession()?.name ?? ''
  if (me) publishPartial<QuizSide>(TOPIC, me, mySide(), { req: true })
}

/** 本机最近一次收到某人分片的时刻（0 = 本会话没收到过） */
export function quizSideSeenAt(who: string): number {
  return partialSeenAt(TOPIC, who)
}

/** 今天的日期串（本地时区） */
export function todayStr(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 为新的一天挑选候选题（仅定题时使用一次，之后写入云端固定）。
 *  之前出现过的题目（历史答案里的题）不参与循环，优先从未出过的题里按日期取；全部出过才重新轮换 */
function candidateQuestion(pool: string[], date: string, used: Set<string>): string {
  const [y, m, d] = date.split('-').map(Number)
  const dayIndex = Math.floor(Date.UTC(y, m - 1, d) / 86400000)
  const available = pool.filter((q) => !used.has(q))
  const source = available.length > 0 ? available : pool
  return source[dayIndex % source.length]
}

/**
 * 获取今日题目：已固定在云端就直接用；新的一天则定题并写入云端。
 * 两端对同一天算出的候选题一致，天然收敛；之后加题不再影响当天。
 */
export function ensureToday(customQuestions: string[], currentDaily: DailyQuiz | null): DailyQuiz | null {
  const date = todayStr()
  if (currentDaily && currentDaily.date === date && currentDaily.question) return currentDaily
  // 云端状态未就绪前不定题不发布：空状态发布会覆盖云端已保存的答案
  if (!cloudReady) return currentDaily
  const pool = [...BUILTIN_QUESTIONS, ...customQuestions]
  const used = new Set(answers.map((a) => a.question))
  const next: DailyQuiz = { date, question: candidateQuestion(pool, date, used) }
  ensureClient()
  daily = next
  commit()
  return next
}

/** 判断两个答案是否"默契"（忽略空格和大小写） */
export function isMatch(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  return norm(a) === norm(b) && norm(a) !== ''
}
