import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  RefreshCw,
  Send,
  Loader2,
  CloudOff,
  Sparkles,
  Plus,
  Check,
  History,
} from 'lucide-react'
import type { User } from './LoginPage'
import AvatarView from '../components/AvatarView'
import { getPairMembers } from '../lib/space'
import {
  addCustomQuestion,
  ensureToday,
  isMatch,
  resyncQuiz,
  submitAnswer,
  subscribeQuiz,
  todayStr,
  type DailyQuiz,
  type QuizAnswer,
} from '../lib/quiz'
import { MEMBER_AVATARS as AVATARS, avatarA } from '../lib/memberAvatars'

// 当前数据空间的两个人
const getPairedUsers = (): string[] => getPairMembers()

const PARTNERS = getPairedUsers()

/** 内联出题输入框 */
function InlineQuestion({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState('')
  const confirm = () => {
    if (addCustomQuestion(value)) onDone()
  }
  return (
    <div className="flex items-center gap-2">
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && confirm()}
        maxLength={30}
        placeholder="输入你们的专属题…"
        className="w-44 rounded-full border border-pink-200 bg-white px-3.5 py-2 text-xs text-[#8a4a68] outline-none placeholder:text-pink-300 focus:border-pink-400"
      />
      <button
        onClick={confirm}
        disabled={!value.trim()}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-r from-pink-400 to-rose-400 text-white shadow disabled:opacity-40"
      >
        <Check className="h-4 w-4" />
      </button>
      <button onClick={onDone} className="text-xs text-pink-300 active:text-pink-500">
        取消
      </button>
    </div>
  )
}

export default function QuizPage({ user, onBack }: { user: User; onBack: () => void }) {
  const [custom, setCustom] = useState<string[]>([])
  const [answers, setAnswers] = useState<QuizAnswer[]>([])
  const [daily, setDaily] = useState<DailyQuiz | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [syncing, setSyncing] = useState(false)

  const [myInput, setMyInput] = useState('')
  const [editingAnswer, setEditingAnswer] = useState(false)
  const [addingQuestion, setAddingQuestion] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setLoading(false), 3500)
    const unsub = subscribeQuiz(
      (data) => {
        setCustom(data.custom)
        setAnswers(data.answers)
        setDaily(data.daily)
        setLoading(false)
        setSyncing(false)
      },
      (msg) => setError(msg),
    )
    return () => {
      clearTimeout(timer)
      unsub()
    }
  }, [])

  // 新的一天：在云端固定今日题目（两端计算一致，天然收敛）
  useEffect(() => {
    if (loading) return
    if (!daily || daily.date !== todayStr()) {
      ensureToday(custom, daily)
    }
  }, [daily, custom, loading])

  const refresh = () => {
    setSyncing(true)
    resyncQuiz()
    setTimeout(() => setSyncing(false), 2500)
  }

  const todayDate = todayStr()
  const question = daily && daily.date === todayDate ? daily.question : ''
  const todayAnswers = answers.filter((a) => a.date === todayDate)
  const myAnswer = todayAnswers.find((a) => a.who === user.name)
  const pairedUsers = getPairedUsers()
  const partnerName = pairedUsers.find((p: string) => p !== user.name) ?? ''
  const partnerAnswer = todayAnswers.find((a) => a.who === partnerName)
  const revealed = Boolean(myAnswer && partnerAnswer)
  const matched = revealed ? isMatch(myAnswer!.answer, partnerAnswer!.answer) : false

  const submit = () => {
    const trimmed = myInput.trim()
    if (!trimmed || !question) return
    submitAnswer(todayDate, question, user.name, trimmed)
    setMyInput('')
    setEditingAnswer(false)
  }

  // 历史记录：按日期倒序（不含今天）
  const history = useMemo(() => {
    const byDate = new Map<string, QuizAnswer[]>()
    for (const a of answers) {
      if (a.date === todayDate) continue
      const list = byDate.get(a.date) ?? []
      list.push(a)
      byDate.set(a.date, list)
    }
    return [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  }, [answers, todayDate])

  return (
    <div className="min-h-dvh bg-gradient-to-b from-[#fff5f8] via-[#fdeef6] to-[#fae3ef]">
      {/* 顶部栏 */}
      <div className="sticky top-0 z-10 flex items-center gap-3 bg-[#fff5f8]/90 px-5 pb-3 pt-6 backdrop-blur">
        <button
          onClick={onBack}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-[#c44d7d] shadow transition-transform active:scale-90"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-lg font-bold tracking-widest text-[#c44d7d]">默契挑战</h1>
        </div>
        <button
          onClick={refresh}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-pink-400 shadow transition-transform active:scale-90"
          title="同步：重拉云端最新，并把我的答案发过去"
        >
          <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="mx-auto max-w-md px-5 pb-16">
        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-2xl bg-amber-50 px-4 py-3 text-xs text-amber-500">
            <CloudOff className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-pink-300" />
          </div>
        ) : (
          <>
            {/* ===== 今日题目卡 ===== */}
            <div className="mb-5 rounded-3xl bg-white p-6 shadow-lg shadow-pink-100">
              <div className="mb-4 flex items-center justify-between">
                <span className="rounded-full bg-pink-50 px-3 py-1 text-[11px] text-[#c44d7d]">
                  {todayDate.slice(5).replace('-', '月')}日 · 今日一题
                </span>
                <Sparkles className="h-4 w-4 text-pink-300" />
              </div>

              <p className="mb-6 text-center text-xl font-bold leading-relaxed text-[#8a4a68]">
                {question || '出题中…'}
              </p>

              {/* 状态一：我还没答 */}
              {!myAnswer && (
                <div>
                  <input
                    value={myInput}
                    onChange={(e) => setMyInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && submit()}
                    maxLength={15}
                    placeholder="写下你的答案（15字内）"
                    className="mb-3 w-full rounded-2xl border border-pink-100 bg-pink-50/50 px-4 py-3 text-center text-sm text-[#8a4a68] outline-none placeholder:text-pink-300 focus:border-pink-300 focus:bg-white"
                  />
                  <button
                    onClick={submit}
                    disabled={!myInput.trim()}
                    className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-pink-400 to-rose-400 py-3 text-sm font-semibold text-white shadow-lg shadow-pink-200 transition-all active:scale-95 disabled:opacity-40"
                  >
                    <Send className="h-4 w-4" />
                    提交答案
                  </button>
                </div>
              )}

              {/* 状态二：我答了，等 TA */}
              {myAnswer && !partnerAnswer && (
                <div className="text-center">
                  <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-pink-50 px-4 py-2">
                    <Check className="h-4 w-4 text-rose-400" />
                    <span className="text-sm text-[#8a4a68]">已提交，等 {partnerName} 作答</span>
                  </div>
                  <p className="mb-3 animate-pulse text-xs text-pink-300">答案揭晓中…保密中…</p>
                  {!editingAnswer ? (
                    <button
                      onClick={() => {
                        setEditingAnswer(true)
                        setMyInput(myAnswer.answer)
                      }}
                      className="text-xs text-pink-300 underline underline-offset-2 active:text-pink-500"
                    >
                      修改我的答案
                    </button>
                  ) : (
                    <div className="flex items-center justify-center gap-2">
                      <input
                        value={myInput}
                        onChange={(e) => setMyInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && submit()}
                        maxLength={15}
                        className="w-40 rounded-full border border-pink-200 bg-white px-3.5 py-2 text-center text-xs text-[#8a4a68] outline-none focus:border-pink-400"
                      />
                      <button
                        onClick={submit}
                        disabled={!myInput.trim()}
                        className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-r from-pink-400 to-rose-400 text-white shadow disabled:opacity-40"
                      >
                        <Check className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* 状态三：揭晓！ */}
              {revealed && (
                <div>
                  <div className="mb-4 flex gap-3">
                    {PARTNERS.map((name) => {
                      const a = todayAnswers.find((x) => x.who === name)
                      return (
                        <div
                          key={name}
                          className="flex flex-1 flex-col items-center gap-2 rounded-2xl bg-pink-50/70 px-3 py-4"
                        >
                          <AvatarView
                            name={name}
                            fallback={AVATARS[name] || avatarA}
                            size={40}
                            className="border-2 border-white shadow"
                          />
                          <span className="text-[11px] font-medium text-[#b0678c]">{name}</span>
                          <span className="text-center text-base font-bold text-[#c44d7d]">
                            {a?.answer ?? '—'}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                  <div
                    className={`rounded-2xl py-3 text-center text-sm font-bold tracking-widest text-white shadow-md ${
                      matched
                        ? 'bg-gradient-to-r from-rose-400 to-pink-400 shadow-pink-200'
                        : 'bg-gradient-to-r from-pink-300 to-rose-300 shadow-pink-100'
                    }`}
                  >
                    {matched ? '💞 心有灵犀！答案一致' : '😆 各有想法，聊聊？'}
                  </div>
                </div>
              )}
            </div>

            {/* ===== 出题入口 ===== */}
            <div className="mb-6 flex justify-center">
              {addingQuestion ? (
                <InlineQuestion onDone={() => setAddingQuestion(false)} />
              ) : (
                <button
                  onClick={() => setAddingQuestion(true)}
                  className="flex items-center gap-1.5 rounded-full border-2 border-dashed border-pink-200 bg-white/70 px-4 py-2 text-xs font-medium text-pink-400 transition-all active:scale-95"
                >
                  <Plus className="h-3.5 w-3.5" />
                  出一道我们的专属题
                </button>
              )}
            </div>

            {/* ===== 历史默契记录 ===== */}
            {history.length > 0 && (
              <div>
                <p className="mb-3 flex items-center gap-1.5 text-xs font-semibold tracking-widest text-[#b0678c]">
                  <History className="h-3.5 w-3.5" /> 历史默契记录
                </p>
                <div className="flex flex-col gap-3">
                  {history.map(([date, list]) => {
                    const question = list[0]?.question ?? ''
                    const pairedUsers = getPairedUsers()
                    const a1 = list.find((x) => x.who === pairedUsers[0])
                    const a2 = list.find((x) => x.who === pairedUsers[1])
                    const both = a1 && a2
                    const m = both ? isMatch(a1.answer, a2.answer) : false
                    return (
                      <div key={date} className="rounded-3xl bg-white p-4 shadow-sm shadow-pink-100">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="text-[11px] text-pink-300">{date}</span>
                          {both && (
                            <span
                              className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                                m ? 'bg-rose-100 text-rose-500' : 'bg-gray-100 text-gray-400'
                              }`}
                            >
                              {m ? '💞 默契' : '😆 不同'}
                            </span>
                          )}
                        </div>
                        <p className="mb-3 text-sm font-semibold text-[#8a4a68]">{question}</p>
                        <div className="flex gap-2">
                          {pairedUsers.map((name) => {
                            const a = list.find((x) => x.who === name)
                            return (
                              <div key={name} className="flex flex-1 items-center gap-1.5 rounded-xl bg-pink-50/60 px-2.5 py-2">
                                <AvatarView
                                  name={name}
                                  fallback={AVATARS[name] || avatarA}
                                  size={20}
                                  className="rounded-full"
                                />
                                <span className="text-xs font-medium text-[#8a4a68]">
                                  {a?.answer ?? '未答'}
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </>
        )}

        {/* 版本标记 */}
        <p className="mt-10 text-center text-[10px] tracking-widest text-pink-200">默契挑战 · v3</p>
      </div>
    </div>
  )
}
