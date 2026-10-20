import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, BadgeCheck, Check, Coins, Heart, RotateCcw, ShoppingBag, Store } from 'lucide-react'
import {
  subscribeWishes, buyWish, confirmWish, cancelPurchase,
  shelfOf, awaitingMyConfirm, awaitingTheirConfirm, terminalWishes,
  type Wish,
} from '../lib/wish'
import { subscribeWallet, type WalletTx } from '../lib/wallet'
import { subscribeAsks, type AskItem } from '../lib/ask'
import { totalBalance } from '../lib/balance'

function fmtTime(ts?: number) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 心愿商店：许愿池上架的心愿货架。买下送给 TA，TA 确认后时元入账并履行心愿 */
export default function WishShopPage({ user, onBack }: { user: { name: string }; onBack: () => void }) {
  const [wishes, setWishes] = useState<Wish[]>([])
  const [txs, setTxs] = useState<WalletTx[]>([])
  const [asks, setAsks] = useState<AskItem[]>([])
  const [tab, setTab] = useState<'shelf' | 'orders'>('shelf')
  const [toast, setToast] = useState('')

  useEffect(() => {
    const u1 = subscribeWishes(setWishes)
    const u2 = subscribeWallet(setTxs)
    const u3 = subscribeAsks(setAsks)
    return () => { u1(); u2(); u3() }
  }, [])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 2600)
    return () => clearTimeout(t)
  }, [toast])

  const balance = totalBalance(txs, asks, user.name)
  const shelf = useMemo(() => shelfOf(wishes), [wishes])
  const toConfirm = useMemo(() => awaitingMyConfirm(wishes, user.name), [wishes, user.name])
  const myOrders = useMemo(() => awaitingTheirConfirm(wishes, user.name), [wishes, user.name])
  const history = useMemo(() => terminalWishes(wishes).slice(0, 30), [wishes])
  const orderCount = toConfirm.length + myOrders.length

  const buy = (w: Wish) => {
    if (!window.confirm(`用 ${w.price} 时元买下「${w.emoji}${w.name}」？\n${w.from} 确认后这笔时元归 TA，TA 就欠你一次啦`)) return
    setToast(buyWish(w.id, user.name, balance).msg)
  }

  return (
    <div className="min-h-dvh pb-10" style={{ background: 'linear-gradient(180deg,#fff6ec 0%,#ffeedd 45%,#ffe4d1 100%)' }}>
      {/* 顶栏 */}
      <div className="sticky top-0 z-10 flex items-center gap-2 bg-[#fff6ec]/90 px-3 py-3 backdrop-blur">
        <button onClick={onBack}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-white/70 shadow-sm">
          <ArrowLeft className="h-4 w-4" style={{ color: '#b45f22' }} />
        </button>
        <h1 className="flex items-center gap-1.5 text-base font-bold" style={{ color: '#8a4413' }}>
          心愿商店
          <Store className="h-4 w-4 text-amber-500" />
        </h1>
        <span className="ml-auto flex items-center gap-1 rounded-full bg-white/85 px-3 py-1 shadow-sm">
          <Coins className="h-3.5 w-3.5 text-amber-500" />
          <span className="text-xs font-bold tabular-nums text-amber-600">{balance}</span>
        </span>
      </div>

      {/* 选项卡 */}
      <div className="mx-4 mt-3 flex rounded-2xl bg-white/70 p-1 shadow-sm">
        <button onClick={() => setTab('shelf')}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2 text-sm font-medium transition-all ${tab === 'shelf' ? 'text-white shadow' : 'text-amber-700/60'}`}
          style={tab === 'shelf' ? { background: 'linear-gradient(135deg,#f0932b,#d96f16)' } : undefined}>
          <ShoppingBag className="h-4 w-4" /> 心愿货架
          {shelf.length > 0 && <span className="text-[10px] opacity-80">· {shelf.length}</span>}
        </button>
        <button onClick={() => setTab('orders')}
          className={`relative flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2 text-sm font-medium transition-all ${tab === 'orders' ? 'text-white shadow' : 'text-amber-700/60'}`}
          style={tab === 'orders' ? { background: 'linear-gradient(135deg,#f0932b,#d96f16)' } : undefined}>
          <BadgeCheck className="h-4 w-4" /> 订单
          {orderCount > 0 && (
            <span className="absolute -top-1.5 right-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white ring-2 ring-white">
              {orderCount}
            </span>
          )}
        </button>
      </div>

      {tab === 'shelf' ? (
        <>
          {shelf.length === 0 ? (
            <div className="px-8 py-20 text-center">
              <p className="text-4xl">🏜️</p>
              <p className="mt-3 text-sm font-medium" style={{ color: '#c98a52' }}>货架空空如也</p>
              <p className="mt-1 text-[11px]" style={{ color: '#d9a878' }}>去「许愿池」许个愿，TA 同意后就会摆上来</p>
            </div>
          ) : (
            <div className="mt-4 grid grid-cols-2 gap-3 px-4">
              {shelf.map((w) => {
                const isMine = w.from === user.name
                const afford = balance >= w.price
                return (
                  <div key={w.id} className="relative flex flex-col items-center rounded-2xl bg-white/85 p-3.5 text-center shadow-sm">
                    {/* 许愿人角标 */}
                    <span className="absolute left-2 top-2 rounded-full bg-amber-50 px-2 py-0.5 text-[9px] font-bold" style={{ color: '#c98a52' }}>
                      {w.from} 许愿
                    </span>
                    <span className="mt-3 text-4xl">{w.emoji}</span>
                    <p className="mt-1.5 w-full truncate text-sm font-bold" style={{ color: '#8a4413' }}>{w.name}</p>
                    {w.msg && <p className="mt-0.5 line-clamp-2 w-full text-[10px] leading-snug" style={{ color: '#c98a52' }}>「{w.msg}」</p>}
                    {isMine ? (
                      <button disabled
                        className="mt-2.5 flex w-full items-center justify-center gap-1 rounded-full py-1.5 text-xs font-bold text-white"
                        style={{ background: '#d9c4ae' }}>
                        <Heart className="h-3 w-3" /> 等 TA 来买
                      </button>
                    ) : (
                      <button onClick={() => buy(w)}
                        className="mt-2.5 flex w-full items-center justify-center gap-1 rounded-full py-1.5 text-xs font-bold text-white shadow transition-transform active:scale-95"
                        style={{ background: afford ? 'linear-gradient(135deg,#f6ad3f,#e07f1a)' : '#d9c4ae' }}>
                        <Coins className="h-3 w-3" /> {w.price}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </>
      ) : (
        <div className="mt-4 px-4">
          {/* 等我确认收款：我许的愿被买了 */}
          {toConfirm.length > 0 && (
            <>
              <p className="mb-2 text-[11px] font-bold tracking-widest" style={{ color: '#d96f16' }}>
                💰 等我确认收款（{toConfirm.length}）
              </p>
              <div className="mb-5 space-y-2.5">
                {toConfirm.map((w) => (
                  <div key={w.id} className="rounded-2xl bg-white/85 p-3.5 shadow-sm ring-1 ring-amber-200">
                    <div className="flex items-center gap-3">
                      <span className="text-3xl">{w.emoji}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-bold" style={{ color: '#8a4413' }}>{w.name}</p>
                        <p className="text-[10px]" style={{ color: '#c98a52' }}>{w.buyer} 已付 {w.price} 时元 · {fmtTime(w.boughtTs)}</p>
                      </div>
                      <button
                        onClick={() => setToast(confirmWish(w.id, user.name).msg)}
                        className="rounded-full px-4 py-2 text-xs font-bold text-white shadow transition-transform active:scale-95"
                        style={{ background: 'linear-gradient(135deg,#f6ad3f,#e07f1a)' }}>
                        <Check className="mr-0.5 inline h-3.5 w-3.5" /> 确认收款
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* 我买的，等对方确认 */}
          {myOrders.length > 0 && (
            <>
              <p className="mb-2 text-[11px] font-bold tracking-widest" style={{ color: '#d96f16' }}>
                🛍️ 我买下的（{myOrders.length}）· 等 TA 确认
              </p>
              <div className="mb-5 space-y-2.5">
                {myOrders.map((w) => (
                  <div key={w.id} className="rounded-2xl bg-white/85 p-3.5 shadow-sm ring-1 ring-amber-100">
                    <div className="flex items-center gap-3">
                      <span className="text-3xl">{w.emoji}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-bold" style={{ color: '#8a4413' }}>{w.name}</p>
                        <p className="text-[10px]" style={{ color: '#c98a52' }}>已付 {w.price} 时元 · {fmtTime(w.boughtTs)}</p>
                      </div>
                      <button
                        onClick={() => {
                          if (!window.confirm(`取消购买「${w.name}」？\n${w.price} 时元会退回，心愿重新上架`)) return
                          setToast(cancelPurchase(w.id, user.name).msg)
                        }}
                        className="flex items-center gap-1 rounded-full bg-gray-100 px-3 py-2 text-[11px] font-bold text-gray-400 active:scale-95">
                        <RotateCcw className="h-3 w-3" /> 取消
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* 成交记录 */}
          <p className="mb-2 text-[11px] font-bold tracking-widest" style={{ color: '#d96f16' }}>📮 心愿记录</p>
          {history.length === 0 ? (
            <p className="py-8 text-center text-xs" style={{ color: '#d9a878' }}>还没有成交记录</p>
          ) : (
            <div className="space-y-1.5">
              {history.map((w) => (
                <div key={w.id} className="flex items-center gap-2.5 rounded-xl bg-white/70 px-3 py-2 text-[12px] ring-1 ring-amber-100/60">
                  <span>{w.emoji}</span>
                  <span className="min-w-0 flex-1 truncate font-medium" style={{ color: '#8a5a34' }}>
                    {w.name}
                    <span className="ml-1 text-[10px] font-bold text-amber-500">💰{w.price}</span>
                  </span>
                  <span className="text-[10px]" style={{ color: '#c98a52' }}>
                    {w.status === 'done' ? `${w.from} 已履行` : w.status === 'declined' ? '被婉拒' : '已撤回'}
                  </span>
                  <span className="text-[10px] text-gray-300">{fmtTime(w.doneTs ?? w.st)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {toast && (
        <div className="fixed inset-x-0 bottom-8 z-20 mx-auto w-fit max-w-[85%] rounded-full px-4 py-2 text-center text-xs text-white shadow-lg"
          style={{ background: 'rgba(180,95,34,0.92)' }}>
          {toast}
        </div>
      )}
    </div>
  )
}
