import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Coins, Crown, Search, Star, X } from 'lucide-react'
import {
  quoteBatch, searchStocks, fetchKline, fetchRank, subscribeQuotes,
  isTradingNow, INDEX_CODES, quoteTimeText,
  type StockQuote, type KlineBar, type StockHit, type RankRow,
} from '../lib/stockQuote'
import {
  subscribeStocks, toggleWatch, tradeBuy, tradeSell, stockReady,
  watchListOf, positionsOf, sellableOf, portfolioOf, buyFee, sellFee, todayStr,
  type StockSnapshot, type Position, type StockTx,
} from '../lib/stockStore'
import { subscribeWallet, type WalletTx } from '../lib/wallet'
import { subscribeAsks, type AskItem } from '../lib/ask'
import { totalBalance } from '../lib/balance'
import { getPairMembers } from '../lib/space'

/* A 股配色：红涨绿跌 */
const UP = '#e23a3a'
const DOWN = '#0da35f'
const pctColor = (n: number) => (n > 0 ? UP : n < 0 ? DOWN : '#888')
const fmtPct = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(2)}%`
const fmtAmt = (a: number) => (a >= 10000 ? `${(a / 10000).toFixed(2)}亿` : `${a}万`)

const INDEX_NAMES: Record<string, string> = {
  sh000001: '上证指数',
  sz399001: '深证成指',
  sz399006: '创业板指',
}

/** 热门股一键添加（自选为空时展示） */
const HOT_STOCKS: Array<{ code: string; name: string }> = [
  { code: 'sh600519', name: '贵州茅台' },
  { code: 'sz300750', name: '宁德时代' },
  { code: 'sz000858', name: '五粮液' },
  { code: 'sh601318', name: '中国平安' },
  { code: 'sz002594', name: '比亚迪' },
  { code: 'sh600036', name: '招商银行' },
  { code: 'sh601899', name: '紫金矿业' },
  { code: 'sz300059', name: '东方财富' },
  { code: 'sh600900', name: '长江电力' },
  { code: 'sz000063', name: '中兴通讯' },
]

type MainTab = 'market' | 'hold' | 'log'
type RankTab = 'all' | 'watch' | 'up' | 'down'

export default function StockPage({ user, onBack }: { user: { name: string }; onBack: () => void }) {
  const [snap, setSnap] = useState<StockSnapshot>({ watch: {}, pos: {}, tx: [] })
  const [txs, setTxs] = useState<WalletTx[]>([])
  const [asks, setAsks] = useState<AskItem[]>([])
  const [quotes, setQuotes] = useState<Record<string, StockQuote>>({})
  const [indexes, setIndexes] = useState<Record<string, StockQuote>>({})
  const [tab, setTab] = useState<MainTab>('market')
  const [rankTab, setRankTab] = useState<RankTab>('all')
  const [rank, setRank] = useState<RankRow[]>([])
  const [sel, setSel] = useState<string | null>(null) // 详情页代码
  const [chartKind, setChartKind] = useState<'m5' | 'day'>('m5')
  const [bars, setBars] = useState<KlineBar[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [connErr, setConnErr] = useState('')
  const [ready, setReady] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [shares, setShares] = useState(1)

  const myWatch = useMemo(() => watchListOf(snap, user.name), [snap, user.name])
  const myPos = useMemo(() => positionsOf(snap, user.name), [snap, user.name])
  // 口径与首页/农场一致：钱包账本 + 问答积分（旧实现漏了问答积分，两处数字对不上）
  const balance = totalBalance(txs, asks, user.name)
  const trading = isTradingNow(new Date(now))

  /* 休市期间行情停留在最近交易日：把数据所属日期明说，免得看起来像「每天一个样是坏了」 */
  const idxTime = indexes[INDEX_CODES[0]]?.time ?? ''
  const idxDateText = idxTime.length >= 8 ? `${Number(idxTime.slice(4, 6))}月${Number(idxTime.slice(6, 8))}日` : ''

  /* 连接状态 & 时钟（30 秒走一格，驱动休市判断和数据时效提示） */
  // 成交广播：快照里出现 partner 的新交易就飘屏；首次加载的历史成交不弹
  const seenTxRef = useRef<Set<string> | null>(null)
  const [feed, setFeed] = useState<StockTx[]>([])
  useEffect(
    () =>
      subscribeStocks((s) => {
        if (seenTxRef.current === null) {
          seenTxRef.current = new Set(s.tx.map((t) => t.id))
          setSnap(s)
          return
        }
        const fresh = s.tx.filter((t) => !seenTxRef.current!.has(t.id))
        fresh.forEach((t) => seenTxRef.current!.add(t.id))
        const partnerNew = fresh.filter((t) => t.who !== user.name).reverse()
        if (partnerNew.length > 0) {
          setFeed((f) => [...partnerNew, ...f].slice(0, 3))
          partnerNew.forEach((t, i) => {
            setTimeout(() => setFeed((f) => f.filter((x) => x.id !== t.id)), 4000 + i * 900)
          })
        }
        setSnap(s)
      }, setConnErr),
    [user.name],
  )
  useEffect(() => subscribeWallet(setTxs), [])
  useEffect(() => subscribeAsks(setAsks), [])
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now())
      setReady(stockReady())
    }, 1000)
    return () => clearInterval(id)
  }, [])

  /* 订阅：自选 + 持仓 + 详情页 + 全部榜单 的实时报价 */
  const rankCodes = useMemo(
    () => (tab === 'market' && rankTab === 'all' ? rank.map((r) => r.code) : []),
    [tab, rankTab, rank],
  )
  const codesKey = useMemo(
    () =>
      [...new Set([...myWatch, ...myPos.map((p) => p.code), ...(sel ? [sel] : []), ...rankCodes])]
        .sort()
        .join(','),
    [myWatch, myPos, sel, rankCodes],
  )
  useEffect(() => {
    const codes = codesKey ? codesKey.split(',') : []
    if (codes.length === 0) return
    return subscribeQuotes(codes, (q) => setQuotes((prev) => ({ ...prev, ...q })))
  }, [codesKey])

  /* 大盘指数条：5 秒一拍 */
  useEffect(() => {
    let alive = true
    const load = () =>
      quoteBatch(INDEX_CODES)
        .then((q) => alive && setIndexes(q))
        .catch(() => {})
    load()
    const id = setInterval(load, 5000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  /* 榜单：10 秒刷新（全部 = 涨跌榜合并 + 热门股兜底，玩家不建自选也能直接看直接买） */
  useEffect(() => {
    if (tab !== 'market' || rankTab === 'watch') return
    let alive = true
    const loadAll = () =>
      Promise.all([fetchRank('up'), fetchRank('down')])
        .then(([upR, downR]) => {
          if (!alive) return
          const seen = new Set<string>()
          const rows: RankRow[] = []
          for (const r of [...upR, ...downR]) {
            if (!seen.has(r.code)) {
              seen.add(r.code)
              rows.push(r)
            }
          }
          for (const h of HOT_STOCKS) {
            if (!seen.has(h.code)) {
              seen.add(h.code)
              rows.push({ code: h.code, name: h.name, price: 0, pct: 0, change: 0 })
            }
          }
          setRank(rows)
        })
        .catch(() => {})
    const load = () =>
      rankTab === 'all'
        ? loadAll()
        : fetchRank(rankTab)
            .then((r) => alive && setRank(r))
            .catch(() => {})
    load()
    const id = setInterval(load, 10000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [tab, rankTab])

  /* 详情页 K 线：分时 30 秒刷，日 K 60 秒刷 */
  useEffect(() => {
    if (!sel) return
    let alive = true
    const load = () =>
      fetchKline(sel, chartKind, chartKind === 'day' ? 120 : 96)
        .then((b) => alive && setBars(b))
        .catch(() => {})
    load()
    const id = setInterval(load, chartKind === 'm5' ? 30000 : 60000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [sel, chartKind])

  const showToast = (msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(''), 2600)
  }

  /* ---------- 交易 ---------- */
  const selQ = sel ? quotes[sel] : undefined
  // 分时数据所属日期（腾讯 m5 为 yyyyMMddHHmm，日K 为 yyyy-MM-dd；休市期间是最近交易日）
  const barDateM = bars.length > 0 ? /^(\d{4})-?(\d{2})-?(\d{2})/.exec(bars[bars.length - 1].time) : null
  const barDateText = barDateM ? `${Number(barDateM[2])}月${Number(barDateM[3])}日` : ''
  const doTrade = (side: 'buy' | 'sell') => {
    if (!sel || !selQ) return showToast('行情还没到位，稍等一秒再试')
    const fn = side === 'buy' ? tradeBuy : tradeSell
    const r = fn(user.name, sel, selQ.name, selQ.price, shares)
    showToast(r.msg)
  }

  /* ---------- 渲染 ---------- */
  return (
    <div className="flex min-h-dvh flex-col" style={{ background: '#f5f6f8' }}>
      {/* 顶栏 */}
      <div className="sticky top-0 z-20 flex items-center gap-2 px-3 py-3" style={{ background: 'rgba(245,246,248,0.92)', backdropFilter: 'blur(8px)' }}>
        <button onClick={onBack} className="flex h-8 w-8 items-center justify-center rounded-full bg-white shadow-sm">
          <ArrowLeft className="h-4 w-4 text-slate-600" />
        </button>
        <h1 className="text-base font-bold tracking-wide text-slate-800">时元股交所</h1>
        <span
          className="rounded-full px-2 py-0.5 text-[10px] font-medium"
          style={{ background: trading ? '#fee2e2' : '#e2e8f0', color: trading ? UP : '#64748b' }}
        >
          {trading ? '交易中' : '休市'}
        </span>
        <span className="ml-auto flex items-center gap-1 rounded-full bg-white px-3 py-1 shadow-sm">
          <Coins className="h-3.5 w-3.5 text-amber-500" />
          <span className="text-xs font-bold tabular-nums text-amber-600">{balance}</span>
        </span>
      </div>

      {connErr && <p className="mx-4 mb-2 rounded-lg bg-amber-50 px-3 py-1.5 text-[11px] text-amber-600">{connErr}</p>}

      {/* 成交广播：TA 买卖了你这边实时飘屏（进页之前的历史不弹） */}
      {feed.map((t) => (
        <div
          key={t.id}
          className="mx-4 mb-2 flex items-center gap-2.5 rounded-xl px-3 py-2.5 shadow-md"
          style={{ background: 'rgba(30,41,59,0.94)', animation: 'stockFeedIn .25s ease-out' }}
        >
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-white"
            style={{ background: t.side === 'buy' ? UP : DOWN }}
          >
            {t.side === 'buy' ? '买' : '卖'}
          </span>
          <p className="text-xs leading-snug text-slate-200">
            {t.who} 刚刚{t.side === 'buy' ? '买入' : '卖出'} <b className="text-white">{t.name}</b> ×{t.shares}股 @{t.price.toFixed(2)}
          </p>
        </div>
      ))}
      <style>{'@keyframes stockFeedIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}'}</style>

      {/* 大盘指数条 */}
      <div className="mx-4 mb-3 grid grid-cols-3 gap-2">
        {INDEX_CODES.map((c) => {
          const q = indexes[c]
          return (
            <div key={c} className="rounded-xl bg-white px-2.5 py-2 shadow-sm">
              <p className="text-[10px] text-slate-400">{INDEX_NAMES[c]}</p>
              <p className="text-sm font-bold tabular-nums" style={{ color: q ? pctColor(q.pct) : '#999' }}>
                {q ? q.price.toFixed(2) : '--'}
              </p>
              <p className="text-[10px] tabular-nums" style={{ color: q ? pctColor(q.pct) : '#999' }}>
                {q ? fmtPct(q.pct) : ''}
              </p>
            </div>
          )
        })}
      </div>

      {/* 休市提示：数据日期明说不骗人，开盘自动恢复实时刷新 */}
      {!trading && idxDateText && (
        <p className="mx-4 mb-3 rounded-lg bg-white/70 px-3 py-1.5 text-center text-[10px] leading-relaxed text-slate-400">
          🌙 休市中 · 行情停留在 {idxDateText}（最近交易日）收盘，开盘自动恢复实时刷新
        </p>
      )}

      {/* 主选项卡 */}
      <div className="mx-4 mb-3 flex rounded-xl bg-slate-200/60 p-1">
        {(['market', 'hold', 'log'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 rounded-lg py-1.5 text-sm font-medium transition-all ${tab === t ? 'bg-white text-slate-800 shadow' : 'text-slate-500'}`}
          >
            {t === 'market' ? '行情' : t === 'hold' ? '持仓' : '记录'}
          </button>
        ))}
      </div>

      {/* ================= 行情 ================= */}
      {tab === 'market' && !sel && (
        <div className="px-4 pb-8">
          <div className="mb-3 flex gap-2">
            {(['all', 'watch', 'up', 'down'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setRankTab(t)}
                className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition-all ${
                  rankTab === t ? 'bg-slate-800 text-white shadow' : 'bg-white text-slate-500'
                }`}
              >
                {t === 'all' ? '全部' : t === 'watch' ? '自选' : t === 'up' ? '涨幅榜' : '跌幅榜'}
              </button>
            ))}
            <button
              onClick={() => setSearchOpen(true)}
              className="ml-auto flex items-center gap-1 rounded-full bg-white px-3.5 py-1.5 text-xs font-medium text-slate-600 shadow active:scale-95"
            >
              <Search className="h-3.5 w-3.5" /> 加自选
            </button>
          </div>

          {/* 自选股列表 */}
          {rankTab === 'watch' &&
            (myWatch.length === 0 ? (
              <div>
                <p className="py-6 text-center text-xs text-slate-400">还没有自选股，从下面热门股一键添加，或点右上角搜索 🔍</p>
                <div className="rounded-xl bg-white p-3 shadow-sm">
                  <p className="mb-2 px-1 text-sm font-bold text-slate-700">热门股票 · 一键加自选</p>
                  <div className="grid grid-cols-2 gap-2">
                    {HOT_STOCKS.map((h) => (
                      <button
                        key={h.code}
                        onClick={() => {
                          if (toggleWatch(user.name, h.code, h.name)) showToast(`已加入自选：${h.name} ⭐`)
                          else showToast('正在连接同步服务器，稍候再试')
                        }}
                        className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2.5 text-left active:scale-95"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-semibold text-slate-800">{h.name}</span>
                          <span className="block text-[10px] text-slate-400">{h.code.slice(2)}</span>
                        </span>
                        <span className="rounded-full bg-white px-2 py-0.5 text-xs font-bold text-red-500 shadow-sm">+</span>
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => {
                      let n = 0
                      for (const h of HOT_STOCKS) {
                        if (!myWatch.includes(h.code) && toggleWatch(user.name, h.code, h.name)) n++
                      }
                      showToast(n > 0 ? `已一键添加 ${n} 只热门股 ⭐` : '添加失败，稍候再试')
                    }}
                    className="mt-2.5 w-full rounded-lg py-2.5 text-sm font-bold text-white shadow-sm active:scale-95"
                    style={{ background: UP }}
                  >
                    全部添加（10 只）
                  </button>
                </div>
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl bg-white shadow-sm">
                {myWatch.map((code, i) => (
                  <QuoteRow
                    key={code}
                    q={quotes[code]}
                    onClick={() => {
                      setSel(code)
                      setChartKind('m5')
                    }}
                    border={i > 0}
                  />
                ))}
              </div>
            ))}

          {/* 全部：涨跌榜合并 + 热门股，直接点进详情即可买，无需先加自选 */}
          {rankTab === 'all' &&
            (rank.length === 0 ? (
              <p className="py-16 text-center text-xs text-slate-400">行情加载中…</p>
            ) : (
              <div className="overflow-hidden rounded-xl bg-white shadow-sm">
                {rank.map((r, i) => (
                  <QuoteRow
                    key={r.code}
                    q={quotes[r.code]}
                    onClick={() => {
                      setSel(r.code)
                      setChartKind('m5')
                    }}
                    border={i > 0}
                  />
                ))}
              </div>
            ))}

          {/* 涨跌榜 */}
          {(rankTab === 'up' || rankTab === 'down') &&
            (rank.length === 0 ? (
              <p className="py-16 text-center text-xs text-slate-400">榜单加载中…</p>
            ) : (
              <div className="overflow-hidden rounded-xl bg-white shadow-sm">
                {rank.map((r, i) => {
                  const up = r.pct >= 0
                  return (
                    <button
                      key={r.code}
                      onClick={() => {
                        setSel(r.code)
                        setChartKind('m5')
                      }}
                      className={`flex w-full items-center gap-3 px-4 py-3 text-left active:bg-slate-50 ${i > 0 ? 'border-t border-slate-100' : ''}`}
                    >
                      <span
                        className="w-6 text-center text-sm font-bold tabular-nums"
                        style={{ color: i < 3 ? (up ? UP : DOWN) : '#cbd5e1' }}
                      >
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-slate-800">{r.name}</span>
                        <span className="block text-[10px] text-slate-400">{r.code.slice(2)}</span>
                      </span>
                      <span className="text-sm font-bold tabular-nums text-slate-700">{r.price.toFixed(2)}</span>
                      <span
                        className="w-16 rounded-md py-1 text-center text-xs font-bold tabular-nums text-white"
                        style={{ background: up ? UP : DOWN }}
                      >
                        {fmtPct(r.pct)}
                      </span>
                    </button>
                  )
                })}
              </div>
            ))}
        </div>
      )}

      {/* ================= 个股详情 ================= */}
      {tab === 'market' && sel && (
        <div className="px-4 pb-8">
          <button onClick={() => setSel(null)} className="mb-2 flex items-center gap-1 text-xs text-slate-400 active:text-slate-600">
            <ArrowLeft className="h-3.5 w-3.5" /> 返回列表
          </button>

          {/* 报价头 */}
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-base font-bold text-slate-800">{selQ?.name ?? '加载中…'}</p>
                <p className="text-[11px] text-slate-400">
                  {sel.slice(2)} · {sel.startsWith('sh') ? '沪A' : '深A'} · {quoteTimeText(selQ) || '--'} {trading ? '' : '已收盘'}
                </p>
              </div>
              <button
                onClick={() => {
                  if (toggleWatch(user.name, sel, selQ?.name ?? '')) showToast(isWatchedCode(myWatch, sel) ? '已移出自选' : '已加入自选 ⭐')
                }}
                className="flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-600 active:scale-95"
              >
                <Star className={`h-3.5 w-3.5 ${isWatchedCode(myWatch, sel) ? 'fill-amber-400 text-amber-400' : 'text-slate-400'}`} />
                自选
              </button>
            </div>
            <div className="mt-2 flex items-end gap-3">
              <p className="text-3xl font-bold tabular-nums" style={{ color: selQ ? pctColor(selQ.pct) : '#333' }}>
                {selQ ? selQ.price.toFixed(2) : '--'}
              </p>
              <p className="pb-1 text-sm font-bold tabular-nums" style={{ color: selQ ? pctColor(selQ.change) : '#333' }}>
                {selQ ? `${selQ.change > 0 ? '+' : ''}${selQ.change.toFixed(2)} ${fmtPct(selQ.pct)}` : ''}
              </p>
            </div>
            {selQ && (
              <div className="mt-3 grid grid-cols-4 gap-x-2 gap-y-1.5 border-t border-slate-100 pt-2.5 text-[11px]">
                <Stat label="今开" value={selQ.open.toFixed(2)} />
                <Stat label="最高" value={selQ.high.toFixed(2)} color={selQ.high >= selQ.prevClose ? UP : DOWN} />
                <Stat label="最低" value={selQ.low.toFixed(2)} color={selQ.low >= selQ.prevClose ? UP : DOWN} />
                <Stat label="昨收" value={selQ.prevClose.toFixed(2)} />
                <Stat label="成交量" value={selQ.volume >= 10000 ? `${(selQ.volume / 10000).toFixed(1)}万手` : `${selQ.volume}手`} />
                <Stat label="成交额" value={fmtAmt(selQ.amount)} />
                <Stat label="振幅" value={`${selQ.prevClose ? (((selQ.high - selQ.low) / selQ.prevClose) * 100).toFixed(2) : '0.00'}%`} />
                <Stat label="市值波动" value={selQ.change > 0 ? '↗' : selQ.change < 0 ? '↘' : '—'} color={pctColor(selQ.change)} />
              </div>
            )}
          </div>

          {/* 走势图 */}
          <div className="mt-3 rounded-xl bg-white p-3 shadow-sm">
            <div className="mb-2 flex gap-1.5">
              {(['m5', 'day'] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => setChartKind(k)}
                  className={`rounded-md px-3 py-1 text-xs font-medium ${chartKind === k ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-500'}`}
                >
                  {k === 'm5' ? '分时' : '日K'}
                </button>
              ))}
              {chartKind === 'm5' && barDateText && (
                <span className="ml-auto self-center text-[10px] tabular-nums text-slate-400">
                  {barDateText} 分时{!trading ? '（最近交易日）' : ''}
                </span>
              )}
            </div>
            {bars.length < 2 ? (
              <p className="py-14 text-center text-xs text-slate-300">走势图加载中…</p>
            ) : chartKind === 'm5' ? (
              <LineChart bars={bars} prevClose={selQ?.prevClose ?? bars[0].open} />
            ) : (
              <KlineChart bars={bars} />
            )}
          </div>

          {/* 交易面板 */}
          <div className="mt-3 rounded-xl bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold text-slate-700">模拟交易</p>
              {(() => {
                const p = myPos.find((x) => x.code === sel)
                return p ? (
                  <p className="text-[11px] text-slate-500">
                    持仓 <span className="font-bold text-slate-700">{p.shares}</span> 股 · 可卖{' '}
                    <span className="font-bold text-slate-700">{sellableOf(p)}</span> 股
                    {p.day === todayStr() && p.freeze > 0 ? `（今买 ${p.freeze} 股 T+1 冻结）` : ''}
                  </p>
                ) : (
                  <p className="text-[11px] text-slate-400">暂无持仓</p>
                )
              })()}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button onClick={() => setShares((s) => Math.max(1, s - 1))} className="h-9 w-9 shrink-0 rounded-lg bg-slate-100 text-lg font-bold text-slate-600 active:scale-95">−</button>
              <input
                type="number"
                min={1}
                value={shares}
                onChange={(e) => setShares(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                className="h-9 min-w-0 flex-1 rounded-lg border border-slate-200 text-center text-sm font-bold tabular-nums outline-none focus:border-slate-400"
              />
              <button onClick={() => setShares((s) => s + 1)} className="h-9 w-9 shrink-0 rounded-lg bg-slate-100 text-lg font-bold text-slate-600 active:scale-95">+</button>
              <span className="shrink-0 text-xs text-slate-400">股</span>
            </div>
            <div className="mt-2 grid grid-cols-4 gap-2">
              {[1, 10, 50, 100].map((n) => (
                <button
                  key={n}
                  onClick={() => setShares(n)}
                  className={`h-8 rounded-lg text-xs font-medium tabular-nums active:scale-95 ${
                    shares === n ? 'bg-slate-800 text-white shadow' : 'bg-slate-100 text-slate-500'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
            {selQ && (
              <div className="mt-2 flex justify-between text-[11px] text-slate-400">
                <span>预计买入 <b className="text-slate-600">{Math.round(selQ.price * shares) + buyFee(Math.round(selQ.price * shares))}</b> 时元（含手续费）</span>
                <span>预计卖出到账 <b className="text-slate-600">{Math.max(0, Math.round(selQ.price * shares) - sellFee(Math.round(selQ.price * shares)))}</b> 时元</span>
              </div>
            )}
            <div className="mt-3 grid grid-cols-2 gap-2.5">
              <button
                onClick={() => doTrade('buy')}
                disabled={!ready}
                className="rounded-lg py-2.5 text-sm font-bold text-white shadow-sm transition-transform active:scale-95 disabled:opacity-40"
                style={{ background: UP }}
              >
                买入
              </button>
              <button
                onClick={() => doTrade('sell')}
                disabled={!ready}
                className="rounded-lg py-2.5 text-sm font-bold text-white shadow-sm transition-transform active:scale-95 disabled:opacity-40"
                style={{ background: DOWN }}
              >
                卖出
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= 持仓 ================= */}
      {tab === 'hold' && (
        <HoldTab
          snap={snap}
          quotes={quotes}
          myName={user.name}
          myBalance={balance}
          onOpen={(code) => {
            setSel(code)
            setTab('market')
            setChartKind('m5')
          }}
        />
      )}

      {/* ================= 记录 ================= */}
      {tab === 'log' && (
        <div className="px-4 pb-8">
          {snap.tx.length === 0 ? (
            <p className="py-16 text-center text-xs text-slate-400">还没有交易记录</p>
          ) : (
            <div className="overflow-hidden rounded-xl bg-white shadow-sm">
              {snap.tx.slice(0, 100).map((t, i) => (
                <div key={t.id} className={`flex items-center gap-3 px-4 py-3 ${i > 0 ? 'border-t border-slate-100' : ''}`}>
                  <span
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-white"
                    style={{ background: t.side === 'buy' ? UP : DOWN }}
                  >
                    {t.side === 'buy' ? '买' : '卖'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-800">
                      {t.name} <span className="text-slate-400">×{t.shares}股</span>
                    </p>
                    <p className="text-[10px] text-slate-400">
                      {t.who} · @{t.price.toFixed(2)} · {new Date(t.ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                  <p className="text-xs font-bold tabular-nums" style={{ color: t.side === 'buy' ? UP : DOWN }}>
                    {t.side === 'buy' ? '-' : '+'}
                    {Math.round(t.price * t.shares)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 搜索加自选 */}
      {searchOpen && (
        <SearchSheet
          watched={new Set(myWatch)}
          onClose={() => setSearchOpen(false)}
          onPick={(code) => {
            setSearchOpen(false)
            setSel(code)
            setChartKind('m5')
          }}
          onToast={showToast}
          who={user.name}
        />
      )}

      {/* 轻提示 */}
      {toast && (
        <div className="fixed inset-x-0 top-16 z-50 flex justify-center px-6">
          <p className="max-w-xs rounded-full px-4 py-2 text-center text-xs leading-relaxed text-white shadow-lg" style={{ background: 'rgba(30,41,59,0.92)' }}>
            {toast}
          </p>
        </div>
      )}
    </div>
  )
}

/* ---------- 小组件 ---------- */

function isWatchedCode(list: string[], code: string): boolean {
  return list.includes(code)
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <p className="flex flex-col">
      <span className="text-slate-400">{label}</span>
      <span className="font-semibold tabular-nums text-slate-700" style={color ? { color } : undefined}>{value}</span>
    </p>
  )
}

function QuoteRow({ q, onClick, border }: { q: StockQuote | undefined; onClick: () => void; border: boolean }) {
  const up = (q?.pct ?? 0) >= 0
  return (
    <button onClick={onClick} className={`flex w-full items-center gap-3 px-4 py-3 text-left active:bg-slate-50 ${border ? 'border-t border-slate-100' : ''}`}>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-slate-800">{q?.name ?? '…'}</p>
        <p className="text-[10px] text-slate-400">{q ? `${q.code.slice(2)} · ${quoteTimeText(q) || '--'}` : ''}</p>
      </div>
      <p className="text-sm font-bold tabular-nums text-slate-700">{q ? q.price.toFixed(2) : '--'}</p>
      <span className="w-16 rounded-md py-1.5 text-center text-xs font-bold tabular-nums text-white" style={{ background: q ? (up ? UP : DOWN) : '#cbd5e1' }}>
        {q ? fmtPct(q.pct) : '--'}
      </span>
    </button>
  )
}

/** 分时折线：昨收基准线 + 最新价描点 */
function LineChart({ bars, prevClose }: { bars: KlineBar[]; prevClose: number }) {
  const W = 320
  const H = 170
  const closes = bars.map((b) => b.close)
  const min = Math.min(...closes, prevClose)
  const max = Math.max(...closes, prevClose)
  const span = max - min || 1
  const y = (v: number) => 8 + (1 - (v - min) / span) * (H - 36)
  const pts = closes.map((c, i) => `${((i / (closes.length - 1)) * W).toFixed(1)},${y(c).toFixed(1)}`).join(' ')
  const last = closes[closes.length - 1]
  const up = last >= prevClose
  const baseY = y(prevClose)
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        <line x1={0} x2={W} y1={baseY} y2={baseY} stroke="#94a3b8" strokeWidth={0.6} strokeDasharray="3 3" />
        <polyline points={pts} fill="none" stroke={up ? UP : DOWN} strokeWidth={1.4} />
        <circle cx={W} cy={y(last)} r={2.4} fill={up ? UP : DOWN} />
      </svg>
      <div className="flex justify-between text-[10px] tabular-nums text-slate-400">
        <span>{max.toFixed(2)}</span>
        <span style={{ color: up ? UP : DOWN }}>昨收 {prevClose.toFixed(2)}</span>
        <span>{min.toFixed(2)}</span>
      </div>
    </div>
  )
}

/** 日 K 蜡烛图 + 成交量柱 */
function KlineChart({ bars }: { bars: KlineBar[] }) {
  const W = 320
  const H = 200
  const volH = 34
  const priceH = H - volH - 8
  const view = bars.slice(-90)
  const min = Math.min(...view.map((b) => b.low))
  const max = Math.max(...view.map((b) => b.high))
  const span = max - min || 1
  const maxVol = Math.max(...view.map((b) => b.vol)) || 1
  const bw = W / view.length
  const y = (v: number) => 4 + (1 - (v - min) / span) * priceH
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        {view.map((b, i) => {
          const up = b.close >= b.open
          const c = up ? UP : DOWN
          const x = i * bw + bw / 2
          const bodyTop = y(Math.max(b.open, b.close))
          const bodyH = Math.max(1, Math.abs(y(b.open) - y(b.close)))
          return (
            <g key={b.time}>
              <line x1={x} x2={x} y1={y(b.high)} y2={y(b.low)} stroke={c} strokeWidth={0.7} />
              <rect x={x - bw * 0.32} y={bodyTop} width={bw * 0.64} height={bodyH} fill={up ? '#fff' : c} stroke={c} strokeWidth={0.7} />
              <rect x={x - bw * 0.32} y={H - (b.vol / maxVol) * volH} width={bw * 0.64} height={(b.vol / maxVol) * volH} fill={up ? '#f3b0b0' : '#a7dcc0'} />
            </g>
          )
        })}
      </svg>
      <div className="flex justify-between text-[10px] tabular-nums text-slate-400">
        <span>{max.toFixed(2)}</span>
        <span>{min.toFixed(2)}</span>
      </div>
    </div>
  )
}

/** 搜索加自选：底部弹层 */
function SearchSheet({
  watched,
  who,
  onClose,
  onPick,
  onToast,
}: {
  watched: Set<string>
  who: string
  onClose: () => void
  onPick: (code: string) => void
  onToast: (msg: string) => void
}) {
  const [kw, setKw] = useState('')
  const [hits, setHits] = useState<StockHit[]>([])
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)

  useEffect(() => {
    const word = kw.trim()
    if (!word) {
      setHits([])
      return
    }
    setLoading(true)
    const mySeq = ++seq.current
    const t = setTimeout(() => {
      searchStocks(word)
        .then((r) => {
          if (seq.current === mySeq) setHits(r)
        })
        .catch(() => {
          if (seq.current === mySeq) setHits([])
        })
        .finally(() => {
          if (seq.current === mySeq) setLoading(false)
        })
    }, 350)
    return () => clearTimeout(t)
  }, [kw])

  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end bg-black/40" onClick={onClose}>
      <div className="max-h-[85dvh] overflow-y-auto rounded-t-3xl bg-white p-4 pb-8" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center gap-2">
          <div className="flex h-9 flex-1 items-center gap-2 rounded-full bg-slate-100 px-3">
            <Search className="h-4 w-4 text-slate-400" />
            <input
              autoFocus
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              placeholder="股票名 / 拼音 / 代码，如：茅台"
              className="h-full flex-1 bg-transparent text-sm outline-none"
            />
          </div>
          <button onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100">
            <X className="h-4 w-4 text-slate-500" />
          </button>
        </div>
        <p className="mb-2 text-[10px] text-slate-400">{loading ? '搜索中…' : hits.length > 0 ? `找到 ${hits.length} 只` : kw ? '没搜到，换个关键词试试' : '输入名称、拼音首字母或 6 位代码'}</p>
        <div className="max-h-80 overflow-y-auto">
          {hits.map((h) => (
            <div key={h.code} className="flex items-center gap-3 border-t border-slate-50 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-800">{h.name}</p>
                <p className="text-[10px] text-slate-400">
                  {h.code} · {h.code.startsWith('sh') ? '沪A' : '深A'}
                </p>
              </div>
              <button
                onClick={() => {
                  if (toggleWatch(who, h.code, h.name)) onToast(watched.has(h.code) ? '已移出自选' : '已加入自选 ⭐')
                  else onToast('正在连接同步服务器，稍候再试')
                }}
                className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-600 active:scale-95"
              >
                {watched.has(h.code) ? '移出' : '+自选'}
              </button>
              <button onClick={() => onPick(h.code)} className="rounded-full bg-slate-800 px-3 py-1.5 text-xs font-medium text-white active:scale-95">
                查看
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** 持仓页：我的持仓 + 双人 PK */
function HoldTab({
  snap,
  quotes,
  myName,
  myBalance,
  onOpen,
}: {
  snap: StockSnapshot
  quotes: Record<string, StockQuote>
  myName: string
  myBalance: number
  onOpen: (code: string) => void
}) {
  const members = getPairMembers()
  const partner = members.find((n) => n !== myName) ?? ''
  const mine = portfolioOf(snap, myName, quotes)
  const theirs = partner ? portfolioOf(snap, partner, quotes) : null

  const rows = positionsOf(snap, myName)
  const myAsset = myBalance + mine.value
  return (
    <div className="px-4 pb-8">
      {/* 资产卡 */}
      <div className="rounded-xl bg-gradient-to-br from-slate-800 to-slate-700 p-4 text-white shadow-sm">
        <div className="flex items-end justify-between">
          <div>
            <p className="text-[11px] text-slate-300">我的总资产（时元）</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{myAsset.toLocaleString()}</p>
          </div>
          <div className="text-right">
            <p className="text-[11px] text-slate-300">持仓盈亏</p>
            <p className="mt-1 text-lg font-bold tabular-nums" style={{ color: mine.pnl > 0 ? '#fda4af' : mine.pnl < 0 ? '#86efac' : '#e2e8f0' }}>
              {mine.pnl > 0 ? '+' : ''}
              {mine.pnl.toLocaleString()}
            </p>
          </div>
        </div>
        <div className="mt-3 flex justify-between border-t border-white/10 pt-2.5 text-[11px] text-slate-300">
          <span>
            时元现金 <b className="text-white">{myBalance.toLocaleString()}</b>
          </span>
          <span>
            股票市值 <b className="text-white">{mine.value.toLocaleString()}</b>
          </span>
          <span>
            持仓成本 <b className="text-white">{mine.cost.toLocaleString()}</b>
          </span>
        </div>
      </div>

      {/* 双人 PK */}
      {partner && theirs && (
        <div className="mt-3 rounded-xl bg-white p-4 shadow-sm">
          <p className="mb-2.5 flex items-center gap-1.5 text-sm font-bold text-slate-700">
            <Crown className="h-4 w-4 text-amber-500" /> 收益 PK
          </p>
          {[
            { name: myName, pnl: mine.pnl, me: true },
            { name: partner, pnl: theirs.pnl, me: false },
          ]
            .sort((a, b) => b.pnl - a.pnl)
            .map((r, i) => (
              <div key={r.name} className={`flex items-center gap-3 py-2 ${i > 0 ? 'border-t border-slate-50' : ''}`}>
                <span className="w-6 text-center text-base">{i === 0 && r.pnl !== 0 ? '👑' : ''}</span>
                <span className="flex-1 text-sm font-medium text-slate-700">{r.name}{r.me ? '（我）' : ''}</span>
                <span className="text-sm font-bold tabular-nums" style={{ color: pctColor(r.pnl) }}>
                  {r.pnl > 0 ? '+' : ''}
                  {r.pnl.toLocaleString()}
                </span>
              </div>
            ))}
          <p className="mt-1.5 text-center text-[10px] text-slate-400">按持仓浮动盈亏排名 · 实时刷新</p>
        </div>
      )}

      {/* 持仓列表 */}
      <p className="mb-2 mt-4 text-sm font-bold text-slate-700">我的持仓</p>
      {rows.length === 0 ? (
        <p className="rounded-xl bg-white py-14 text-center text-xs text-slate-400">空仓中，去行情页选一只心仪的股吧 📈</p>
      ) : (
        <div className="overflow-hidden rounded-xl bg-white shadow-sm">
          {rows.map((p: Position, i: number) => {
            const q = quotes[p.code]
            const price = q?.price ?? 0
            const value = Math.round(price * p.shares)
            const pnl = value - p.cost
            const pct = p.cost > 0 ? (pnl / p.cost) * 100 : 0
            const sellable = sellableOf(p)
            return (
              <button key={p.code} onClick={() => onOpen(p.code)} className={`flex w-full items-center gap-3 px-4 py-3 text-left active:bg-slate-50 ${i > 0 ? 'border-t border-slate-100' : ''}`}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-800">
                    {p.name}
                    {sellable < p.shares && (
                      <span className="ml-1.5 rounded bg-amber-50 px-1 py-0.5 text-[9px] font-normal text-amber-500">T+1 冻结 {p.shares - sellable}</span>
                    )}
                  </p>
                  <p className="text-[10px] text-slate-400">
                    {p.shares} 股 · 成本 {(p.cost / p.shares).toFixed(2)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-bold tabular-nums text-slate-700">{q ? price.toFixed(2) : '--'}</p>
                  <p className="text-[10px] font-medium tabular-nums" style={{ color: pctColor(pnl) }}>
                    {pnl > 0 ? '+' : ''}
                    {pnl}（{fmtPct(pct)}）
                  </p>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
