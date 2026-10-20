import { useState, useEffect, useRef } from 'react'
import { ArrowRight, Coins, PiggyBank, Send, Calendar, Heart, Sparkles, Plus, Minus } from 'lucide-react'
import {
  subscribeJar,
  addJarTx,
  withdrawJarTx,
  jarBalance,
  jarBalanceOf,
  jarDeposited,
  jarSpent,
  type JarTx,
} from '../lib/jar'
import type { User } from './LoginPage'
import { partnerOf } from '../lib/space'
import FloatingBack from '../components/FloatingBack'


export default function JarPage({
  user,
  onBack,
}: {
  user: User
  onBack: () => void
}) {
  const [txs, setTxs] = useState<JarTx[]>([])
  const [depositAmount, setDepositAmount] = useState('')
  const [depositNote, setDepositNote] = useState('')
  const [withdrawAmount, setWithdrawAmount] = useState('')
  const [withdrawNote, setWithdrawNote] = useState('')
  const [tab, setTab] = useState<'deposit' | 'withdraw'>('deposit')
  const [showDepositSuccess, setShowDepositSuccess] = useState(false)
  const [showWithdrawSuccess, setShowWithdrawSuccess] = useState(false)
  const [jarAnimation, setJarAnimation] = useState(false)
  const jarRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const u1 = subscribeJar((t) => setTxs(t))
    return () => u1()
  }, [])

  const totalBalance = jarBalance(txs)
  const deposited = jarDeposited(txs)
  const spent = jarSpent(txs)
  const myBalance = jarBalanceOf(txs, user.name)
  const partnerName = partnerOf(user.name)
  const otherUser = partnerName ? { name: partnerName } : null

  const handleDeposit = () => {

    const amount = parseFloat(depositAmount)
    if (isNaN(amount) || amount <= 0) {
      alert('请输入有效的存款金额')
      return
    }

    if (!depositNote.trim()) {
      alert('请填写存款备注')
      return
    }

    const success = addJarTx(user.name, amount, depositNote)
    if (success) {
      setDepositAmount('')
      setDepositNote('')
      setShowDepositSuccess(true)
      setJarAnimation(true)
      setTimeout(() => {
        setJarAnimation(false)
        setShowDepositSuccess(false)
      }, 3000)
    } else {
      alert('存款失败，请稍后重试')
    }
  }

  const handleWithdraw = () => {
    const amount = parseFloat(withdrawAmount)
    if (isNaN(amount) || amount <= 0) {
      alert('请输入有效的支出金额')
      return
    }
    if (!withdrawNote.trim()) {
      alert('请填写支出原因')
      return
    }

    const res = withdrawJarTx(user.name, amount, withdrawNote)
    if (!res.ok) {
      alert(res.msg)
      return
    }
    setWithdrawAmount('')
    setWithdrawNote('')
    setShowWithdrawSuccess(true)
    setJarAnimation(true)
    setTimeout(() => {
      setJarAnimation(false)
      setShowWithdrawSuccess(false)
    }, 3000)
  }

  const formatDate = (ts: number) => {
    const date = new Date(ts)
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
    
    if (date >= today) {
      return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    } else if (date >= yesterday) {
      return '昨天 ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    } else {
      return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) + 
             ' ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    }
  }

  /** 支出时两人各分摊多少（余额显示用） */
  const shareOf = (amount: number) => {
    const half = Math.round((amount / 2) * 100) / 100
    return { self: amount - half, other: half }
  }

  return (
    <div className="min-h-dvh bg-gradient-to-b from-[#fff5f8] via-[#fdeef6] to-[#fae3ef] p-4">
      <FloatingBack onBack={onBack} tone="plain" />
      {/* 顶部导航 */}
      <div className="flex items-center gap-3 mb-6">
        <button onClick={onBack} className="p-2 rounded-full bg-white/80 shadow-md transition-transform active:scale-95">
          <ArrowRight className="h-5 w-5 text-[#c44d7d]" style={{ transform: 'rotate(180deg)' }} />
        </button>
        <h1 className="text-xl font-bold tracking-wider text-[#c44d7d]">存钱罐</h1>
      </div>

      {/* 存钱罐主体 */}
      <div className="mb-8">
        <div className="relative">
          {/* 存钱罐容器 */}
          <div 
            ref={jarRef}
            className={`relative mx-auto w-48 h-64 bg-gradient-to-b from-[#ff6b9d] to-[#feca57] rounded-3xl shadow-2xl transform transition-all duration-1000 ${
              jarAnimation ? 'scale-110 rotate-3' : 'scale-100 rotate-0'
            }`}
          >
            {/* 存钱罐顶部 */}
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-16 h-8 bg-gradient-to-b from-[#ff6b9d] to-[#feca57] rounded-t-full shadow-lg"></div>
            
            {/* 存钱罐投币口 */}
            <div className="absolute top-4 left-1/2 -translate-x-1/2 w-8 h-2 bg-white/30 rounded-full"></div>
            
            {/* 存钱罐装饰 */}
            <div className="absolute top-12 left-6 w-3 h-3 bg-white/40 rounded-full"></div>
            <div className="absolute top-16 right-6 w-3 h-3 bg-white/40 rounded-full"></div>
            <div className="absolute top-24 left-8 w-2 h-2 bg-white/30 rounded-full"></div>
            
            {/* 金额显示 */}
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <div className="text-white/90 text-sm mb-2">剩余金额</div>
              <div className="text-white text-3xl font-bold mb-2">
                {totalBalance.toFixed(2)}
              </div>
              <div className="text-white/70 text-xs">共同基金</div>
            </div>
            
            {/* 爱心装饰 */}
            <div className="absolute -bottom-4 left-1/2 -translate-x-1/2">
              <div className="relative">
                <div className="w-20 h-10 bg-gradient-to-r from-[#ff6b9d] to-[#feca57] rounded-full shadow-lg"></div>
                <div className="absolute -top-2 left-1/2 -translate-x-1/2">
                  <Heart className="h-6 w-6 text-pink-300" />
                </div>
              </div>
            </div>
          </div>
          
          {/* 金币动画 */}
          {jarAnimation && (
            <div className="absolute top-0 left-1/2 -translate-x-1/2 animate-bounce">
              <Coins className="h-8 w-8 text-amber-400" />
            </div>
          )}
        </div>

        {/* 存入 / 支出小计 */}
        <div className="mt-8 flex items-center justify-center gap-3 text-sm">
          <span className="rounded-full bg-emerald-50 px-3 py-1 font-medium text-emerald-600 ring-1 ring-emerald-100">
            共存入 {deposited.toFixed(2)}
          </span>
          <span className="rounded-full bg-rose-50 px-3 py-1 font-medium text-rose-500 ring-1 ring-rose-100">
            共支出 {spent.toFixed(2)}
          </span>
        </div>
      </div>

      {/* 统计信息 */}
      <div className="mb-6">
        <div className="bg-white/90 rounded-3xl p-6 shadow-lg shadow-pink-200">
          <div className="flex justify-around">
            <div className="text-center">
              <div className="w-12 h-12 bg-pink-100 rounded-full flex items-center justify-center mx-auto mb-2">
                <div className="w-8 h-8 bg-pink-400 rounded-full flex items-center justify-center">
                  <span className="text-xs font-bold text-white">{user.name.slice(0, 2)}</span>
                </div>
              </div>
              <p className="text-xs text-pink-400 mb-1">{user.name}</p>
              <p className="text-lg font-bold text-pink-600">{myBalance.toFixed(2)}</p>
            </div>
            
            <div className="flex items-center">
              <div className="w-px h-12 bg-pink-200"></div>
            </div>
            
            {otherUser && (
              <div className="text-center">
                <div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-2">
                  <div className="w-8 h-8 bg-blue-400 rounded-full flex items-center justify-center">
                    <span className="text-xs font-bold text-white">{otherUser.name.slice(0, 2)}</span>
                  </div>
                </div>
                <p className="text-xs text-blue-400 mb-1">{otherUser.name}</p>
                <p className="text-lg font-bold text-blue-600">
                  {jarBalanceOf(txs, otherUser.name).toFixed(2)}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 存入 / 支出表单 */}
      <div className="mb-6">
        <div className="bg-white/90 rounded-3xl p-6 shadow-lg shadow-pink-200">
          {/* 模式切换 */}
          <div className="mb-5 grid grid-cols-2 gap-2 rounded-2xl bg-pink-50 p-1">
            <button
              onClick={() => setTab('deposit')}
              className={`flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-sm font-semibold transition-all ${
                tab === 'deposit'
                  ? 'bg-gradient-to-r from-pink-400 to-rose-400 text-white shadow-md shadow-pink-200'
                  : 'text-pink-400'
              }`}
            >
              <Plus className="h-4 w-4" />
              存入
            </button>
            <button
              onClick={() => setTab('withdraw')}
              className={`flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-sm font-semibold transition-all ${
                tab === 'withdraw'
                  ? 'bg-gradient-to-r from-rose-400 to-pink-400 text-white shadow-md shadow-pink-200'
                  : 'text-pink-400'
              }`}
            >
              <Minus className="h-4 w-4" />
              支出
            </button>
          </div>

          {tab === 'deposit' ? (
            <div className="space-y-4">
              <h2 className="text-lg font-bold text-[#c44d7d] flex items-center gap-2">
                <Plus className="h-5 w-5 text-pink-400" />
                存入爱心
              </h2>

              <div>
                <label className="block text-sm font-medium text-pink-300 mb-2">
                  存款金额
                </label>
                <div className="relative">
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={depositAmount}
                    onChange={(e) => setDepositAmount(e.target.value)}
                    placeholder="输入存款金额"
                    className="w-full rounded-2xl border border-pink-200 bg-pink-50 px-4 py-3 text-lg text-[#8a4a68] outline-none focus:border-pink-400 focus:bg-white"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-amber-600 font-bold">
                    元
                  </span>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-pink-300 mb-2">
                  存款备注 <span className="text-xs text-pink-400">（必填）</span>
                </label>
                <textarea
                  value={depositNote}
                  onChange={(e) => setDepositNote(e.target.value)}
                  placeholder="请填写存款备注，比如：纪念日基金、旅行基金、生日礼物基金等"
                  rows={3}
                  className="w-full rounded-2xl border border-pink-200 bg-pink-50 px-4 py-3 text-[#8a4a68] outline-none focus:border-pink-400 focus:bg-white resize-none"
                />
              </div>

              <button
                onClick={handleDeposit}
                className="w-full bg-gradient-to-r from-pink-400 to-rose-400 text-white py-3 rounded-2xl font-semibold shadow-lg shadow-pink-200 transition-all active:scale-[0.98] flex items-center justify-center gap-2"
              >
                <Send className="h-4 w-4" />
                存入存钱罐
              </button>

              {showDepositSuccess && (
                <div className="bg-green-50 border border-green-200 rounded-2xl p-3 text-center">
                  <p className="text-sm text-green-600 font-medium flex items-center justify-center gap-2">
                    <Sparkles className="h-4 w-4" />
                    ✅ 存款成功！存钱罐已更新
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <h2 className="text-lg font-bold text-[#c44d7d] flex items-center gap-2">
                <Minus className="h-5 w-5 text-rose-400" />
                从罐里支出
              </h2>

              <div className="rounded-2xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-700 ring-1 ring-amber-100">
                支出金额由两人<strong>平均分摊</strong>，分别从各自的时元钱包扣除；零头由发起方多承担。
              </div>

              <div>
                <label className="block text-sm font-medium text-pink-300 mb-2">
                  支出金额
                </label>
                <div className="relative">
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={withdrawAmount}
                    onChange={(e) => setWithdrawAmount(e.target.value)}
                    placeholder="输入支出金额"
                    className="w-full rounded-2xl border border-pink-200 bg-pink-50 px-4 py-3 text-lg text-[#8a4a68] outline-none focus:border-rose-400 focus:bg-white"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-amber-600 font-bold">
                    元
                  </span>
                </div>
                {(() => {
                  const a = parseFloat(withdrawAmount)
                  if (isNaN(a) || a <= 0) return null
                  const s = shareOf(a)
                  return (
                    <p className="mt-2 text-xs text-rose-400">
                      预计分摊：我 {s.self.toFixed(2)} · {otherUser?.name ?? '对方'} {s.other.toFixed(2)}
                    </p>
                  )
                })()}
              </div>

              <div>
                <label className="block text-sm font-medium text-pink-300 mb-2">
                  支出原因 <span className="text-xs text-pink-400">（必填）</span>
                </label>
                <textarea
                  value={withdrawNote}
                  onChange={(e) => setWithdrawNote(e.target.value)}
                  placeholder="请填写支出原因，比如：一起吃了火锅、买了纪念日礼物、交了水电网费…"
                  rows={3}
                  className="w-full rounded-2xl border border-pink-200 bg-pink-50 px-4 py-3 text-[#8a4a68] outline-none focus:border-rose-400 focus:bg-white resize-none"
                />
              </div>

              <button
                onClick={handleWithdraw}
                className="w-full bg-gradient-to-r from-rose-400 to-pink-500 text-white py-3 rounded-2xl font-semibold shadow-lg shadow-pink-200 transition-all active:scale-[0.98] flex items-center justify-center gap-2"
              >
                <Minus className="h-4 w-4" />
                确认支出（双方分摊）
              </button>

              {showWithdrawSuccess && (
                <div className="bg-green-50 border border-green-200 rounded-2xl p-3 text-center">
                  <p className="text-sm text-green-600 font-medium flex items-center justify-center gap-2">
                    <Sparkles className="h-4 w-4" />
                    ✅ 支出成功！已从两人钱包平均扣除
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 收支记录 */}
      <div>
        <div className="bg-white/90 rounded-3xl p-6 shadow-lg shadow-pink-200">
          <h2 className="text-lg font-bold text-[#c44d7d] mb-4 flex items-center gap-2">
            <Calendar className="h-5 w-5 text-pink-400" />
            收支记录
          </h2>
          
          {txs.length === 0 ? (
            <div className="text-center py-8">
              <div className="w-16 h-16 mx-auto mb-4 relative">
                <PiggyBank className="h-16 w-16 text-pink-300" />
                <div className="absolute -top-2 -right-2">
                  <Plus className="h-6 w-6 text-pink-400 bg-white/80 rounded-full p-1" />
                </div>
              </div>
              <p className="text-sm text-pink-400">还没有记录</p>
              <p className="text-xs text-pink-300 mt-1">快来存第一笔爱心吧！</p>
            </div>
          ) : (
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {txs.map((tx) => {
                const isIncome = tx.amount > 0
                return (
                <div key={tx.id} className={`rounded-2xl p-4 border ${
                  isIncome
                    ? 'bg-gradient-to-r from-pink-50 to-rose-50 border-pink-100'
                    : 'bg-gradient-to-r from-slate-50 to-rose-50/60 border-rose-100'
                }`}>
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white ${
                        isIncome
                          ? tx.who === user.name
                            ? 'bg-gradient-to-br from-pink-400 to-rose-400'
                            : 'bg-gradient-to-br from-blue-400 to-cyan-400'
                          : 'bg-gradient-to-br from-rose-400 to-orange-300'
                      }`}>
                        {isIncome ? (tx.who === user.name ? '我' : tx.who.slice(0, 2)) : '出'}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-[#8a4a68]">
                          {isIncome
                            ? tx.who === user.name ? '我 · 存入' : `${tx.who} · 存入`
                            : `${tx.who === user.name ? '我' : tx.who} · 支出`}
                        </p>
                        <p className="text-xs text-pink-400 flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {formatDate(tx.ts)}
                        </p>
                      </div>
                    </div>
                    <div className={`flex items-center gap-1 rounded-full px-3 py-1 ${
                      isIncome ? 'bg-white/60' : 'bg-rose-100/70'
                    }`}>
                      <Coins className={`h-4 w-4 ${isIncome ? 'text-amber-500' : 'text-rose-500'}`} />
                      <span className={`text-lg font-bold ${isIncome ? 'text-amber-600' : 'text-rose-500'}`}>
                        {isIncome ? '+' : '−'}{Math.abs(tx.amount).toFixed(2)}
                      </span>
                    </div>
                  </div>
                  
                  <div className="bg-white/80 rounded-xl p-3 border border-pink-100">
                    <p className="text-sm text-[#8a4a68] leading-relaxed flex items-start gap-2">
                      <Heart className={`h-4 w-4 mt-0.5 flex-shrink-0 ${isIncome ? 'text-pink-400' : 'text-rose-400'}`} />
                      {tx.note}
                    </p>
                    {!isIncome && otherUser && (
                      <p className="mt-2 pl-6 text-[11px] text-rose-400/90">
                        两人各分摊 {shareOf(Math.abs(tx.amount)).other.toFixed(2)} 元（发起方多担零头）
                      </p>
                    )}
                  </div>
                </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
