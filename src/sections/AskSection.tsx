import { useEffect, useState } from 'react'
import { Check, CloudOff, HelpCircle, Loader2, Send, Trash2, X } from 'lucide-react'
import type { User } from './LoginPage'
import {
  answerAsk,
  createAsk,
  judgeAsk,
  POINTS_RIGHT,
  POINTS_WRONG,
  removeAsk,
  subscribeAsks,
  type AskItem,
} from '../lib/ask'
import { getPairMembers } from '../lib/space'

// 当前数据空间的两个人
const getPairedUsers = (): string[] => getPairMembers()

function timeLabel(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function parsePts(s: string, fallback: number): number {
  const v = Math.abs(parseInt(s, 10))
  return Number.isFinite(v) ? Math.min(v, 10000) : fallback
}

/** 单条提问卡片（无头像，纯文字简洁风） */
function AskCard({ item, me }: { item: AskItem; me: string }) {
  const [input, setInput] = useState('')
  // 回答时给对方加的时元，多少自己定，默认 10
  const [giftPts, setGiftPts] = useState('10')
  // 旧数据遗留：审核时的奖惩数值
  const [rightPts, setRightPts] = useState('10')
  const [wrongPts, setWrongPts] = useState('5')
  const iAmAsker = item.from === me
  const iAmAnswerer = item.to === me

  const submitAnswer = () => {
    if (!input.trim()) return
    answerAsk(item.id, input, parsePts(giftPts, 10))
    setInput('')
  }

  return (
    <div className="rounded-3xl bg-white p-4 shadow-sm shadow-pink-100">
      {/* 头部：谁问谁 + 时间 */}
      <div className="mb-2.5 flex items-center gap-1.5 text-[11px] text-pink-300">
        <span className="font-medium text-[#b0678c]">{item.from}</span>
        <span>问</span>
        <span className="font-medium text-[#b0678c]">{item.to}</span>
        <span className="ml-auto">{timeLabel(item.ts)}</span>
      </div>

      {/* 题目 */}
      <p className="mb-3 text-sm font-semibold leading-relaxed text-[#8a4a68]">
        <HelpCircle className="mr-1 inline h-4 w-4 text-pink-300" />
        {item.question}
      </p>

      {/* 待回答：写答案 + 自定给对方加的时元 */}
      {item.status === 'pending' && iAmAnswerer && (
        <div>
          <div className="flex items-center gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitAnswer()}
              maxLength={30}
              placeholder="写下你的答案…"
              className="flex-1 rounded-full border border-pink-100 bg-pink-50/50 px-3.5 py-2 text-xs text-[#8a4a68] outline-none placeholder:text-pink-300 focus:border-pink-300 focus:bg-white"
            />
            <button
              onClick={submitAnswer}
              disabled={!input.trim()}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-r from-pink-400 to-rose-400 text-white shadow disabled:opacity-40"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="mt-2 flex items-center gap-1.5 px-1 text-[11px] text-pink-300">
            答完顺便给 {item.from} 加
            <input
              value={giftPts}
              onChange={(e) => setGiftPts(e.target.value.replace(/\D/g, '').slice(0, 5))}
              inputMode="numeric"
              className="w-14 rounded-lg border border-amber-200 bg-white px-1.5 py-0.5 text-center text-xs font-bold text-amber-600 outline-none focus:border-amber-400"
            />
            时元，多少你定
          </div>
        </div>
      )}

      {item.status === 'pending' && iAmAsker && (
        <div className="flex items-center justify-between">
          <span className="animate-pulse text-xs text-pink-300">等 TA 回答中…</span>
          <button
            onClick={() => removeAsk(item.id)}
            className="flex items-center gap-1 text-[11px] text-pink-200 active:text-pink-400"
          >
            <Trash2 className="h-3 w-3" /> 撤回
          </button>
        </div>
      )}

      {/* 已回答（新流程：回答即完成，奖励已给出） */}
      {item.status === 'answered' && item.points != null && (
        <div className="flex items-center gap-2 rounded-2xl bg-pink-50/70 px-3.5 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] text-pink-300">{item.to} 的回答</p>
            <p className="truncate text-sm font-bold text-[#c44d7d]">{item.answer}</p>
          </div>
          <span className="shrink-0 rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-bold text-amber-600">
            🪙 {iAmAsker ? `你 +${item.points}` : `TA 送你 +${item.points}`} 时元
          </span>
        </div>
      )}

      {/* 旧数据遗留：改版前待审核的问答，仍可审核 */}
      {item.status === 'answered' && item.points == null && (
        <div>
          <div className="mb-3 rounded-2xl bg-pink-50/70 px-3.5 py-2.5">
            <p className="text-[11px] text-pink-300">{item.to} 的回答</p>
            <p className="text-sm font-bold text-[#c44d7d]">{item.answer}</p>
          </div>
          {iAmAsker ? (
            <div>
              <div className="mb-2 flex items-center gap-3 rounded-2xl bg-amber-50/70 px-3 py-2 text-[11px] text-[#8a6a3a]">
                <span className="flex items-center gap-1">
                  答对奖
                  <input
                    value={rightPts}
                    onChange={(e) => setRightPts(e.target.value.replace(/\D/g, '').slice(0, 5))}
                    inputMode="numeric"
                    className="w-14 rounded-lg border border-amber-200 bg-white px-1.5 py-0.5 text-center text-xs font-bold text-amber-600 outline-none focus:border-amber-400"
                  />
                </span>
                <span className="flex items-center gap-1">
                  答错扣
                  <input
                    value={wrongPts}
                    onChange={(e) => setWrongPts(e.target.value.replace(/\D/g, '').slice(0, 5))}
                    inputMode="numeric"
                    className="w-14 rounded-lg border border-amber-200 bg-white px-1.5 py-0.5 text-center text-xs font-bold text-amber-600 outline-none focus:border-amber-400"
                  />
                </span>
                <span className="ml-auto text-amber-400">时元</span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => judgeAsk(item.id, true, parsePts(rightPts, POINTS_RIGHT))}
                  className="flex flex-1 items-center justify-center gap-1 rounded-2xl bg-gradient-to-r from-emerald-400 to-teal-400 py-2 text-xs font-semibold text-white shadow transition-transform active:scale-95"
                >
                  <Check className="h-3.5 w-3.5" /> 答对了 +{parsePts(rightPts, POINTS_RIGHT)}
                </button>
                <button
                  onClick={() => judgeAsk(item.id, false, -parsePts(wrongPts, Math.abs(POINTS_WRONG)))}
                  className="flex flex-1 items-center justify-center gap-1 rounded-2xl bg-gradient-to-r from-gray-300 to-gray-400 py-2 text-xs font-semibold text-white shadow transition-transform active:scale-95"
                >
                  <X className="h-3.5 w-3.5" /> 答错了 -{parsePts(wrongPts, Math.abs(POINTS_WRONG))}
                </button>
              </div>
            </div>
          ) : (
            <p className="text-center text-xs text-pink-300">等 {item.from} 审核对错…</p>
          )}
        </div>
      )}

      {/* 已审核（旧数据） */}
      {item.status === 'judged' && (
        <div className="flex items-center gap-2 rounded-2xl bg-pink-50/70 px-3.5 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] text-pink-300">{item.to} 的回答</p>
            <p className="truncate text-sm font-bold text-[#c44d7d]">{item.answer}</p>
          </div>
          <span
            className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${
              item.correct ? 'bg-emerald-100 text-emerald-500' : 'bg-gray-100 text-gray-400'
            }`}
          >
            {(() => {
              const pts = item.points ?? (item.correct ? POINTS_RIGHT : POINTS_WRONG)
              return item.correct ? `✅ +${pts} 时元` : `❌ ${pts} 时元`
            })()}
          </span>
        </div>
      )}
    </div>
  )
}

export default function AskSection({ user }: { user: User }) {
  const [asks, setAsks] = useState<AskItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [question, setQuestion] = useState('')

  useEffect(() => {
    const timer = setTimeout(() => setLoading(false), 3500)
    const unsub = subscribeAsks(
      (data) => {
        setAsks(data)
        setLoading(false)
      },
      (msg) => setError(msg),
    )
    return () => {
      clearTimeout(timer)
      unsub()
    }
  }, [])

  const pairedUsers = getPairedUsers()
  const partner = pairedUsers.find((p) => p !== user.name) ?? ''

  const ask = () => {
    if (createAsk(user.name, partner, question)) setQuestion('')
  }

  return (
    <div>
      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-2xl bg-amber-50 px-4 py-3 text-xs text-amber-500">
          <CloudOff className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* 出题入口 */}
      <div className="mb-5 rounded-3xl bg-white p-4 shadow-lg shadow-pink-100">
        <p className="mb-2.5 text-xs font-semibold tracking-widest text-[#b0678c]">
          {user.name} 发起
        </p>
        <div className="flex items-center gap-2">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && ask()}
            maxLength={50}
            placeholder="出一道只有你们懂的题…"
            className="flex-1 rounded-2xl border border-pink-100 bg-pink-50/50 px-4 py-2.5 text-sm text-[#8a4a68] outline-none placeholder:text-pink-300 focus:border-pink-300 focus:bg-white"
          />
          <button
            onClick={ask}
            disabled={!question.trim()}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-r from-pink-400 to-rose-400 text-white shadow-lg shadow-pink-200 transition-transform active:scale-95 disabled:opacity-40"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-2 text-[11px] text-pink-300">
          TA 回答后会直接给你加时元，加多少由 TA 定
        </p>
      </div>

      {/* 提问列表 */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-pink-300" />
        </div>
      ) : asks.length === 0 ? (
        <p className="py-10 text-center text-xs text-pink-300">
          还没有提问，出第一道题考考 TA 吧 💌
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {asks.map((item) => (
            <AskCard key={item.id} item={item} me={user.name} />
          ))}
        </div>
      )}
    </div>
  )
}
