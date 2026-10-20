import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Check, Coins, Sparkles, Trash2, X } from 'lucide-react'
import type { User } from './LoginPage'
import AskSection from './AskSection'
import {
  subscribeWishes, makeWish, approveWish, declineWish, withdrawWish,
  approvalsFor, myWishes, suggestEmoji, EMOJI_OPTIONS, type Wish,
} from '../lib/wish'
import { getPairMembers } from '../lib/space'

function fmtTime(ts: number) {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const STATUS_LABEL: Record<Wish['status'], { text: string; cls: string }> = {
  pending: { text: '等TA点头', cls: 'text-amber-400' },
  approved: { text: '已上架 ✨', cls: 'text-emerald-500' },
  purchased: { text: '已被买走 💝', cls: 'text-violet-500' },
  done: { text: '已成交 🎉', cls: 'text-emerald-400' },
  declined: { text: '被婉拒', cls: 'text-gray-300' },
  withdrawn: { text: '已撤回', cls: 'text-gray-300' },
}

/** 许愿池：自由许愿、自定价格，TA 同意即上架心愿商店 */
export default function AskPage({ user, onBack }: { user: User; onBack: () => void }) {
  const partner = getPairMembers().find((p) => p !== user.name) ?? ''
  const [wishes, setWishes] = useState<Wish[]>([])
  const [toast, setToast] = useState('')
  const [showQuiz, setShowQuiz] = useState(false)

  // 许愿卡表单
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('✨')
  const [price, setPrice] = useState('')
  const [msg, setMsg] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [emojiManual, setEmojiManual] = useState(false) // 用户手动选过图则不再自动匹配

  useEffect(() => subscribeWishes(setWishes), [])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 2600)
    return () => clearTimeout(t)
  }, [toast])

  const approvals = useMemo(() => approvalsFor(wishes, user.name), [wishes, user.name])
  const mine = useMemo(() => myWishes(wishes, user.name).slice(0, 20), [wishes, user.name])

  const submit = () => {
    const n = Math.floor(Number(price))
    const r = makeWish(user.name, partner, name, emoji, n, msg)
    setToast(r.msg)
    if (r.ok) {
      setName('')
      setPrice('')
      setMsg('')
      setEmoji('✨')
      setEmojiManual(false)
    }
  }

  const onNameChange = (v: string) => {
    setName(v)
    // 名字变化时若还没手动选过图，按关键词自动配图
    if (v.trim() && !emojiManual) setEmoji(suggestEmoji(v))
  }

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
          <h1 className="flex items-center gap-1.5 text-lg font-bold tracking-widest text-[#c44d7d]">
            许愿池
            <Sparkles className="h-4 w-4 text-amber-400" />
          </h1>
        </div>
      </div>

      <div className="mx-auto max-w-md px-5 pb-16">
        {/* ===== 许愿卡 ===== */}
        <div className="relative mb-6 rounded-3xl bg-white p-5 shadow-lg shadow-pink-100 ring-1 ring-pink-100">
          {/* 信封贴纸感装饰 */}
          <div className="absolute -top-2.5 left-1/2 h-5 w-16 -translate-x-1/2 rounded-b-lg rounded-t-sm bg-gradient-to-r from-pink-300 to-rose-300 shadow-sm" />

          <div className="flex items-center gap-4">
            {/* 插图预览（点它换图） */}
            <button
              onClick={() => setPickerOpen((o) => !o)}
              className="flex h-20 w-20 shrink-0 flex-col items-center justify-center rounded-2xl bg-gradient-to-br from-pink-50 to-rose-50 ring-1 ring-pink-100 transition-transform active:scale-95"
            >
              <span className="text-4xl leading-none">{emoji}</span>
              <span className="mt-1 text-[9px] text-pink-300">点我换图</span>
            </button>
            <div className="min-w-0 flex-1 space-y-2">
              <input
                value={name}
                onChange={(e) => onNameChange(e.target.value)}
                maxLength={20}
                placeholder="想申请什么？（如：一杯奶茶）"
                className="w-full rounded-xl border border-pink-100 bg-pink-50/50 px-3.5 py-2.5 text-sm text-[#8a4a68] outline-none placeholder:text-pink-300 focus:border-pink-300 focus:bg-white"
              />
              <div className="relative">
                <Coins className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-amber-400" />
                <input
                  type="number"
                  inputMode="numeric"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="定价多少时元？"
                  className="w-full rounded-xl border border-pink-100 bg-pink-50/50 py-2.5 pl-9 pr-3 text-sm text-[#8a4a68] outline-none placeholder:text-pink-300 focus:border-pink-300 focus:bg-white"
                />
              </div>
            </div>
          </div>

          {/* emoji 选择器 */}
          {pickerOpen && (
            <div className="mt-3 grid grid-cols-8 gap-1.5 rounded-2xl bg-pink-50/60 p-2.5 ring-1 ring-pink-100">
              {EMOJI_OPTIONS.map((e) => (
                <button
                  key={e}
                  onClick={() => {
                    setEmoji(e)
                    setEmojiManual(true)
                    setPickerOpen(false)
                  }}
                  className={`flex h-9 items-center justify-center rounded-lg text-xl transition-all active:scale-90 ${
                    emoji === e ? 'bg-white shadow ring-2 ring-pink-300' : 'hover:bg-white/70'
                  }`}
                >
                  {e}
                </button>
              ))}
            </div>
          )}

          <input
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            maxLength={30}
            placeholder="跟 TA 说句好话，更容易通过哦 🥺"
            className="mt-3 w-full rounded-xl border border-pink-100 bg-pink-50/50 px-3.5 py-2.5 text-sm text-[#8a4a68] outline-none placeholder:text-pink-300 focus:border-pink-300 focus:bg-white"
          />

          <button
            onClick={submit}
            className="mt-3.5 w-full rounded-2xl bg-gradient-to-r from-pink-400 to-rose-400 py-3.5 text-sm font-bold text-white shadow-lg shadow-pink-200 transition-transform active:scale-95"
          >
            🫧 投入许愿池
          </button>
        </div>

        {/* ===== 等我审批 ===== */}
        {approvals.length > 0 && (
          <>
            <p className="mb-2 text-[11px] font-bold tracking-widest text-violet-400">💌 TA 的心愿（{approvals.length}）· 等你点头</p>
            <div className="mb-6 space-y-2.5">
              {approvals.map((w) => (
                <div key={w.id} className="rounded-2xl bg-white p-4 shadow-md shadow-violet-100 ring-1 ring-violet-200">
                  <div className="flex items-center gap-3">
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-violet-50 text-2xl">{w.emoji}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-[#8a4a68]">
                        {w.name}
                        <span className="ml-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-500">💰 {w.price}</span>
                      </p>
                      <p className="text-[10px] text-pink-300">
                        {w.from} · {fmtTime(w.ts)}
                      </p>
                    </div>
                  </div>
                  {w.msg && <p className="mt-2 rounded-xl bg-violet-50/70 px-3 py-1.5 text-[11px] text-violet-400">🥺 {w.msg}</p>}
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => setToast(approveWish(w.id, user.name).msg)}
                      className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-gradient-to-r from-violet-400 to-fuchsia-400 py-2.5 text-xs font-bold text-white shadow active:scale-95"
                    >
                      <Check className="h-3.5 w-3.5" /> 同意上架
                    </button>
                    <button
                      onClick={() => setToast(declineWish(w.id, user.name).msg)}
                      className="flex items-center justify-center gap-1 rounded-xl bg-gray-100 px-4 py-2.5 text-xs font-bold text-gray-400 active:scale-95"
                    >
                      <X className="h-3.5 w-3.5" /> 婉拒
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ===== 我的心愿 ===== */}
        <p className="mb-2 text-[11px] font-bold tracking-widest text-pink-400">🫧 我的心愿</p>
        {mine.length === 0 ? (
          <p className="rounded-2xl bg-white/60 py-8 text-center text-xs text-pink-300">还没有许过愿，写下第一个心愿吧 ✨</p>
        ) : (
          <div className="space-y-1.5">
            {mine.map((w) => {
              const st = STATUS_LABEL[w.status]
              return (
                <div key={w.id} className="flex items-center gap-2.5 rounded-xl bg-white/85 px-3 py-2.5 ring-1 ring-pink-100">
                  <span className="text-xl">{w.emoji}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12px] font-semibold text-gray-700">
                      {w.name}
                      <span className="ml-1.5 text-[10px] font-bold text-amber-500">💰{w.price}</span>
                    </p>
                    <p className={`text-[10px] ${st.cls}`}>{st.text}{w.status === 'done' && w.doneTs ? ` · ${fmtTime(w.doneTs)}` : ''}</p>
                  </div>
                  {w.status === 'pending' && (
                    <button
                      onClick={() => setToast(withdrawWish(w.id, user.name).msg)}
                      className="rounded-full bg-gray-100 p-1.5 text-gray-300 active:scale-90"
                      title="撤回"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* ===== 老玩法：出题考 TA ===== */}
        <button
          onClick={() => setShowQuiz((s) => !s)}
          className="mt-8 w-full rounded-2xl bg-white/70 py-2.5 text-[11px] font-medium text-pink-300 ring-1 ring-pink-100 transition-colors active:scale-[0.98]"
        >
          {showQuiz ? '收起「出题考 TA」▲' : '怀旧入口：出题考 TA · 回答送时元 ▼'}
        </button>
        {showQuiz && (
          <div className="mt-3">
            <AskSection user={user} />
          </div>
        )}

        <p className="mt-10 text-center text-[10px] tracking-widest text-pink-200">许愿池 · v2</p>
      </div>

      {toast && (
        <div className="fixed inset-x-0 bottom-8 z-10 mx-auto w-fit max-w-[85%] rounded-full bg-gray-800/90 px-4 py-2 text-center text-xs text-white shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}
