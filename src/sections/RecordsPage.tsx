import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Coins, Loader2, CloudOff } from 'lucide-react'
import type { User } from './LoginPage'
import AvatarView from '../components/AvatarView'
import { subscribeWallet, walletArchived, walletFoldedCount, type WalletTx } from '../lib/wallet'
import { subscribeAsks, POINTS_RIGHT, POINTS_WRONG, type AskItem } from '../lib/ask'
import { getPairMembers } from '../lib/space'
import { MEMBER_AVATARS as AVATARS, avatarA } from '../lib/memberAvatars'

// 当前数据空间的两个人
const getPairedUsers = (): string[] => getPairMembers()

const WHO_OPTIONS = ['全部', ...getPairedUsers()]
const MAX_ENTRIES = 200 // 记录上限：只保留最近 200 条，多了自动删掉旧的

type Entry = {
  id: string
  who: string
  delta: number
  reason: string
  ts: number
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 时元记录：双方每一笔时元变动（农场收支 + 问答奖惩），简洁列表，实时更新 */
export default function RecordsPage({ onBack }: { user: User; onBack: () => void }) {
  const [txs, setTxs] = useState<WalletTx[]>([])
  const [asks, setAsks] = useState<AskItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filterWho, setFilterWho] = useState('全部')

  useEffect(() => {
    const timer = setTimeout(() => setLoading(false), 3500)
    const u1 = subscribeWallet(
      (t) => {
        setTxs(t)
        setLoading(false)
      },
      (m) => setError(m),
    )
    const u2 = subscribeAsks((a) => setAsks(a))
    return () => {
      clearTimeout(timer)
      u1()
      u2()
    }
  }, [])

  const entries = useMemo<Entry[]>(() => {
    const farmEntries: Entry[] = txs.map((t) => ({
      id: t.id,
      who: t.who,
      delta: t.delta,
      reason: t.reason,
      ts: t.ts,
    }))
    // 问答时元变动：新流程（回答时直接送给出题人）+ 旧流程遗留（审核奖惩）
    const askEntries: Entry[] = asks
      .filter(
        (a) =>
          (a.status === 'judged' && a.correct !== null) ||
          (a.status === 'answered' && typeof a.points === 'number' && a.points > 0),
      )
      .map((a) => {
        if (a.status === 'answered') {
          return {
            id: `ask_${a.id}`,
            who: a.from,
            delta: a.points as number,
            reason: `${a.to} 回答了「${a.question}」`,
            ts: a.answerTs ?? a.ts,
          }
        }
        return {
          id: `ask_${a.id}`,
          who: a.to,
          delta: a.points ?? (a.correct ? POINTS_RIGHT : POINTS_WRONG),
          reason: `问答「${a.question}」${a.correct ? '答对了' : '答错了'}`,
          ts: a.judgeTs ?? a.ts,
        }
      })
    return [...farmEntries, ...askEntries]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, MAX_ENTRIES)
  }, [txs, asks])

  const shown = filterWho === '全部' ? entries : entries.filter((e) => e.who === filterWho)

  /* 对账：账本只留最近 500 条明细，更早的已折叠进「历史汇总」计数器——
     余额是把它们算在内的，页面上不明说就会出现「明细加起来 ≠ 余额」的困惑 */
  const folded = walletFoldedCount()
  const archNames = filterWho === '全部' ? getPairedUsers() : [filterWho]
  const archPlus = archNames.reduce((s, n) => s + walletArchived(n).plus, 0)
  const archMinus = archNames.reduce((s, n) => s + walletArchived(n).minus, 0)
  const archivedNet = archPlus - archMinus

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
          <h1 className="text-lg font-bold tracking-widest text-[#c44d7d]">记录</h1>
          <p className="text-xs text-pink-300">每一笔时元的来龙去脉</p>
        </div>
        <div className="flex items-center gap-1 rounded-full bg-white/90 px-3 py-1.5 shadow">
          <Coins className="h-4 w-4 text-amber-500" />
          <span className="text-xs font-bold text-amber-600">{entries.length}</span>
        </div>
      </div>

      {error && (
        <div className="mx-5 mt-2 flex items-center gap-2 rounded-2xl bg-amber-50 px-4 py-2.5 text-xs text-amber-500">
          <CloudOff className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="mx-auto max-w-md px-5 pb-16">
        {/* 人员筛选 */}
        <div className="mb-4 flex gap-2">
          {WHO_OPTIONS.map((w) => (
            <button
              key={w}
              onClick={() => setFilterWho(w)}
              className={`flex-1 rounded-full py-2 text-xs font-medium transition-all active:scale-95 ${
                filterWho === w
                  ? 'bg-gradient-to-r from-pink-400 to-rose-400 text-white shadow-md shadow-pink-200'
                  : 'bg-white text-[#b0678c] shadow-sm'
              }`}
            >
              {w}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-pink-300" />
          </div>
        ) : shown.length === 0 ? (
          <p className="py-20 text-center text-xs text-pink-300">
            还没有时元变动，去农场种颗菜就有了 🌱
          </p>
        ) : (
          <div className="overflow-hidden rounded-3xl bg-white shadow-lg shadow-pink-100">
            {shown.map((e, i) => (
              <div
                key={e.id}
                className={`flex items-center gap-3 px-4 py-3 ${i > 0 ? 'border-t border-pink-50' : ''}`}
              >
                <AvatarView
                  name={e.who}
                  fallback={AVATARS[e.who] || avatarA}
                  size={32}
                  className="shrink-0 border border-pink-100"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-[#8a4a68]">{e.reason}</p>
                  <p className="text-[10px] text-pink-300">
                    {e.who} · {formatTime(e.ts)}
                  </p>
                </div>
                <span
                  className={`shrink-0 text-sm font-bold tabular-nums ${
                    e.delta >= 0 ? 'text-emerald-500' : 'text-rose-400'
                  }`}
                >
                  {e.delta >= 0 ? '+' : ''}
                  {e.delta}
                </span>
              </div>
            ))}
          </div>
        )}

        {folded > 0 && archivedNet !== 0 && (
          <div className="mt-3 rounded-2xl bg-white/70 px-4 py-3 shadow-sm">
            <p className="text-[11px] font-medium text-[#8a4a68]">
              更早的 {folded} 笔已汇总（余额里算着，明细不再逐条显示）
            </p>
            <p className="mt-0.5 text-[11px] tabular-nums text-pink-400">
              收入 +{archPlus} · 支出 −{archMinus} · 净 {archivedNet >= 0 ? '+' : ''}{archivedNet}
            </p>
          </div>
        )}

        <p className="mt-4 text-center text-[10px] text-pink-200">
          只保留最近 {MAX_ENTRIES} 条，多了自动删掉旧的
        </p>
      </div>
    </div>
  )
}
