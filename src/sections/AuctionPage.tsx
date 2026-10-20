/* 玉缘拍卖会：双方各自上拍，AI 买家举牌竞价，两人围观落槌分时元。
 * 三幕：征集（上拍/验货/设保留价）→ 拍卖台（两端同步播放同一份剧本）→ 战报结算
 */
import { memo, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Coins, Gavel, Lightbulb, Sparkles, Timer, X, RefreshCw } from 'lucide-react';
import {
  subscribeAuction, auctionState, openSession, listLot, withdrawLot, setReady, startLive,
  settleIfDone, claimProceeds, buyAiLot, liveFrame, liveElapsed, flawOf, fmtMoney, roundGrid, priceGrid, lotEmoji,
  themeById, MARKET_LABEL, MARKET_EMOJI, TAG_LABEL, FLAW_LABEL, MAX_LOTS,
  listedLotsOf, UPGRADE_TOKEN_REF, redeemHeldLot, redeemFee, heldLotsOf,
  syncMySide, subscribeAuctionSide, sideSeenAt,
  type AuctionLot, type AuctionSession, type BidEvent, type Flaw,
} from '../lib/auction';
import { subscribeJade, stonesOf, productsOf, varietyById, isBrick, brickNameOf, type JadeProduct, type OwnedStone } from '../lib/jade';
import { subscribeWallet, type WalletTx } from '../lib/wallet';
import { subscribeAsks, type AskItem } from '../lib/ask';
import { totalBalance } from '../lib/balance';
import { subscribeProductArt, productArt } from '../lib/jadeProductArt';
import { JADE_ART, craftArt } from '../lib/jadeArt';
import { subscribeFarm, farmOf, itemInfo, warehouseItemValue, UPGRADE_TOKEN_VALUE, type FarmOf } from '../lib/farm';
import { isGuestSession } from '../lib/guest';
import { partnerOf } from '../lib/space';
import { useSlice, ListMoreBar, ScrollTopButton } from '../components/SliceList';

const RARITY_COLOR: Record<string, string> = {
  '废料': '#8a8a8a', '常见': '#7fae6e', '少见': '#1d6fa5', '稀有': '#8a4fc4', '传说': '#c9930a', '神话': '#d41f3d',
};

/* ---------- 拍品图（成品 AI 图 / 器型图 / 品种图，逐步兜底 emoji）
 * memo：拍卖台 100ms 心跳刷新时 lot 引用不变 → 整图块跳过重渲染（大图重绘是掉帧主因） ---------- */
const LotArt = memo(function LotArt({ lot, className, imgClass }: { lot: AuctionLot; className?: string; imgClass?: string }) {
  const [, tick] = useState(0);
  useEffect(() => subscribeProductArt(() => tick((t) => t + 1)), []);
  let src: string | undefined;
  if (lot.kind === 'product') {
    src = lot.artKey ? productArt(lot.artKey) : craftArt(lot.typeId ?? '', lot.varietyId);
  } else {
    src = JADE_ART[lot.varietyId];
  }
  return (
    <div className={`flex items-center justify-center ${className ?? ''}`}>
      {src ? (
        <img src={src} alt="" draggable={false} className={`max-h-full max-w-full object-contain ${imgClass ?? ''}`} />
      ) : (
        <span className="text-4xl">{lotEmoji(lot)}</span>
      )}
    </div>
  );
});

/* ---------- 上拍选品 ---------- */
interface Candidate {
  kind: 'product' | 'stone' | 'warehouse';
  refId: string;
  name: string;
  varietyId: string;
  typeId?: string;
  emoji: string;
  artKey?: string;
  /** 成品/原石 = 总估值；仓库物品 = 单件估值 */
  value: number;
  grams?: number;
  /** 仓库物品持有数量（可选卖数量，默认 1） */
  qty?: number;
}

function buildCandidates(who: string, farms: Record<string, FarmOf>): Candidate[] {
  const products: Candidate[] = productsOf(who).map((p: JadeProduct) => ({
    kind: 'product',
    refId: p.id,
    name: p.name,
    varietyId: p.varietyId,
    typeId: p.typeId,
    emoji: '',
    artKey: p.art ? p.id : undefined,
    value: p.value,
    grams: p.grams,
  }));
  const stones: Candidate[] = stonesOf(who)
    .filter((s: OwnedStone) => s.status === 'cut' || s.status === 'kept')
    .map((s: OwnedStone) => ({
      kind: 'stone',
      refId: s.id,
      name: isBrick(s)
        ? `${brickNameOf(s.varietyId)} · ${s.grams ?? 0}g`
        : `${varietyById(s.varietyId).name}原石 · ${s.grams ?? 0}g`,
      varietyId: s.varietyId,
      typeId: isBrick(s) ? 'brick' : undefined, // 玉砖走「玉砖大观」专场命中
      emoji: varietyById(s.varietyId).emoji,
      value: s.value,
      grams: s.grams,
    }));
  // 仓库物品：农场作物/水产/合成物 + 土地升级券
  const farm = farmOf(farms, who);
  const wares: Candidate[] = Object.entries(farm.warehouse)
    .filter(([, q]) => q > 0)
    .map(([id, q]) => {
      const info = itemInfo(id);
      return {
        kind: 'warehouse' as const,
        refId: id,
        name: info.name,
        varietyId: '',
        emoji: info.emoji,
        value: warehouseItemValue(id),
        qty: q,
      };
    });
  const tokens = farm.upgradeTokens ?? 0;
  if (tokens > 0) {
    wares.push({
      kind: 'warehouse',
      refId: UPGRADE_TOKEN_REF,
      name: '土地升级券',
      varietyId: '',
      emoji: '🎫',
      value: UPGRADE_TOKEN_VALUE,
      qty: tokens,
    });
  }
  // 统一按估值从高到低，好宝贝排前面，不用一直往下翻
  return [...products, ...stones, ...wares].sort((a, b) => b.value - a.value);
}

const CandidateArt = memo(function CandidateArt({ c, className }: { c: Candidate; className?: string }) {
  const [, tick] = useState(0);
  useEffect(() => subscribeProductArt(() => tick((t) => t + 1)), []);
  let src: string | undefined;
  if (c.kind === 'product') src = c.artKey ? productArt(c.artKey) : craftArt(c.typeId ?? '', c.varietyId);
  else src = JADE_ART[c.varietyId];
  return (
    <div className={`flex items-center justify-center overflow-hidden ${className ?? ''}`}>
      {src ? <img src={src} alt="" draggable={false} className="max-h-full max-w-full object-contain" /> : <span className="text-3xl">{c.emoji}</span>}
    </div>
  );
});

const genLotId = (who: string) => `lot-${who}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function PickLotModal({ who, farms, onClose, onMsg }: { who: string; farms: Record<string, FarmOf>; onClose: () => void; onMsg: (m: string) => void }) {
  const candidates = useMemo(() => buildCandidates(who, farms), [who, farms]);
  const candSlice = useSlice(candidates.length);
  const [selId, setSelId] = useState<string | null>(null);
  const [lotId, setLotId] = useState<string>(() => genLotId(who));
  const [inspected, setInspected] = useState(false);
  const [reserveIdx, setReserveIdx] = useState(1);
  const [selQty, setSelQty] = useState(1);
  const sel = candidates.find((c) => c.refId === selId) ?? null;
  const isWare = sel?.kind === 'warehouse';
  const selValue = sel ? (isWare ? sel.value * selQty : sel.value) : 0;
  const selName = sel ? (isWare ? `${sel.name} ×${selQty}` : sel.name) : '';
  const flaw: Flaw | null = inspected ? flawOf(lotId) : null;

  const rg = (n: number) => roundGrid(n, priceGrid(selValue));
  const reserves = sel
    ? [
        { label: '不设保留价', hint: '交给缘分', v: 0 },
        { label: `求稳 · ${fmtMoney(rg(selValue * 0.8))}`, hint: '落袋为安', v: rg(selValue * 0.8) },
        { label: `行情 · ${fmtMoney(rg(selValue))}`, hint: '随行就市', v: rg(selValue) },
        { label: `搏高 · ${fmtMoney(rg(selValue * 1.3))}`, hint: '待价而沽', v: rg(selValue * 1.3) },
      ]
    : [];

  const doList = () => {
    if (!sel) return;
    const r = listLot(who, {
      lotId, kind: sel.kind, refId: sel.refId, name: selName, varietyId: sel.varietyId,
      typeId: sel.typeId, emoji: sel.emoji, artKey: sel.artKey, value: selValue, grams: sel.grams,
      qty: isWare ? selQty : undefined,
      reserve: reserves[reserveIdx]?.v ?? 0, inspected: isWare ? false : inspected,
    });
    onMsg(r.msg);
    if (r.ok) onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#0d231c]">
      <div className="flex items-center gap-3 px-4 py-3">
        <button onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-amber-100 active:scale-95">
          <X className="h-5 w-5" />
        </button>
        <p className="text-base font-bold tracking-widest text-amber-100">选一件宝贝上拍</p>
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-44">
        {candidates.length === 0 && (
          <p className="mt-20 text-center text-sm text-amber-100/60">仓库空空～先去「玉石鉴定」切点料子、磨件成品，或去农场收点货吧</p>
        )}
        <div className="grid grid-cols-2 gap-3">
          {candidates.slice(0, candSlice.shown).map((c) => (
            <button
              key={c.refId}
              onClick={() => { setSelId(c.refId); setInspected(false); setLotId(genLotId(who)); setSelQty(1); }}
              className={`rounded-2xl border p-3 text-left transition-all active:scale-95 ${
                selId === c.refId ? 'border-amber-300 bg-amber-300/10 shadow-lg shadow-amber-500/20' : 'border-white/10 bg-white/5'
              }`}
            >
              <CandidateArt c={c} className="h-20" />
              <p className="mt-2 truncate text-xs font-semibold text-amber-50">{c.name}</p>
              {c.kind === 'warehouse' ? (
                <p className="text-[11px] text-amber-200/70">估值 {fmtMoney(c.value)}/件 · 有 {c.qty}</p>
              ) : (
                <p className="text-[11px] text-amber-200/70">估值 {fmtMoney(c.value)} 时元</p>
              )}
            </button>
          ))}
        </div>
        <div className="mt-3">
          <ListMoreBar shown={candSlice.shown} total={candidates.length}
            hasMore={candSlice.hasMore} onMore={candSlice.more}
            onAll={candSlice.all} onCollapse={candSlice.reset} label="件宝贝" tone="dark" />
        </div>
      </div>

      {/* 底部操作台 */}
      {sel && (
        <div className="absolute inset-x-0 bottom-0 rounded-t-3xl border-t border-amber-200/20 bg-[#122b23] p-4 pb-6 shadow-2xl">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-bold text-amber-100">{selName}</p>
            {!isWare && (
              <button
                onClick={() => setInspected(true)}
                disabled={inspected}
                className="flex items-center gap-1 rounded-full bg-sky-400/15 px-3 py-1.5 text-xs font-semibold text-sky-200 active:scale-95 disabled:opacity-60"
              >
                <Lightbulb className="h-3.5 w-3.5" />
                {inspected ? '已验货' : '🔦 打灯验货'}
              </button>
            )}
          </div>
          {isWare && (
            <div className="mb-3 flex items-center gap-2">
              <span className="text-[11px] tracking-widest text-amber-200/60">数量</span>
              <div className="flex items-center gap-2">
                <button onClick={() => setSelQty((q) => Math.max(1, q - 1))}
                  className="h-8 w-8 rounded-full bg-white/10 text-lg font-bold text-amber-100 active:scale-95">−</button>
                <span className="min-w-8 text-center text-sm font-bold text-amber-100">{selQty}</span>
                <button onClick={() => setSelQty((q) => Math.min(sel.qty ?? 1, q + 1))}
                  className="h-8 w-8 rounded-full bg-white/10 text-lg font-bold text-amber-100 active:scale-95">＋</button>
              </div>
              <span className="ml-auto text-xs text-amber-200/70">共值 {fmtMoney(selValue)} 时元</span>
            </div>
          )}
          {inspected && flaw && (
            <p className={`mb-3 rounded-xl px-3 py-2 text-xs font-semibold ${
              flaw === 'crack' ? 'bg-red-400/15 text-red-200' : flaw === 'suspect' ? 'bg-amber-400/15 text-amber-200' : 'bg-emerald-400/15 text-emerald-200'
            }`}>
              {FLAW_LABEL[flaw]}
            </p>
          )}
          <p className="mb-1.5 text-[11px] tracking-widest text-amber-200/60">保留价</p>
          <div className="mb-4 grid grid-cols-4 gap-2">
            {reserves.map((r, i) => (
              <button
                key={r.label}
                onClick={() => setReserveIdx(i)}
                className={`rounded-xl px-1 py-2 text-center transition-all active:scale-95 ${
                  reserveIdx === i ? 'bg-amber-400 text-[#3a2c07] shadow-lg shadow-amber-500/30' : 'bg-white/8 text-amber-100/80'
                }`}
              >
                <p className="text-[11px] font-bold leading-tight">{r.label}</p>
                <p className="mt-0.5 text-[9px] opacity-70">{r.hint}</p>
              </button>
            ))}
          </div>
          <button
            onClick={doList}
            className="w-full rounded-2xl bg-gradient-to-r from-amber-400 to-yellow-500 py-3.5 text-sm font-bold tracking-[0.2em] text-[#3a2c07] shadow-lg shadow-amber-500/30 transition-transform active:scale-95"
          >
            确认上拍 🔨
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------- 第一幕：征集 ---------- */
/** 对方最近一次「同步」到达本机的时间（分片通道，不依赖整包） */
function sideSyncLabel(partner: string): string {
  const at = sideSeenAt(partner);
  if (!at) return '对方未同步';
  return `⚡ ${new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 已同步`;
}

function PrepView({ session, who, partner, onMsg, onPick }: {
  session: AuctionSession; who: string; partner: string; onMsg: (m: string) => void; onPick: () => void;
}) {
  const theme = themeById(session.themeId);
  const mine = listedLotsOf(session, who);
  const theirs = listedLotsOf(session, partner);
  const myReady = !!session.ready[who];
  const partnerReady = !!session.ready[partner];

  return (
    <div className="flex-1 overflow-y-auto px-4 pb-40">
      {/* 征集公告 */}
      <div className="rounded-3xl border border-amber-200/25 bg-gradient-to-br from-[#16382d] to-[#0f2a21] p-5 shadow-xl">
        <div className="flex items-center gap-2">
          <span className="text-2xl">{theme.emoji}</span>
          <p className="text-lg font-bold tracking-widest text-amber-200">{theme.name}</p>
          <span className="ml-auto rounded-full bg-white/10 px-2.5 py-1 text-[11px] text-amber-100/80">
            {MARKET_EMOJI[session.market]} {MARKET_LABEL[session.market]}
          </span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-amber-100/70">{theme.desc}</p>
        <p className="mt-2 flex items-start gap-1.5 text-xs text-emerald-200/90">
          <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          专场已正式官宣：按主题挑宝贝上拍更抢手，流拍更少、价更高
        </p>
      </div>

      {/* 我的上拍 */}
      <div className="mt-6 mb-2 flex items-end gap-2">
        <p className="text-xs tracking-[0.25em] text-amber-200/60">我的拍品 · {mine.length}/{MAX_LOTS}</p>
        <button
          onClick={() => { const r = syncMySide(who); onMsg(r.msg); }}
          className="ml-auto flex items-center gap-1 rounded-full bg-amber-400/15 px-2.5 py-1 text-[11px] font-semibold text-amber-200 transition-transform active:scale-90"
          title="只把我这一份拍品和准备状态发过去，几百字节秒到"
        >
          <RefreshCw className="h-3 w-3" /> 同步给对方
        </button>
      </div>
      <div className="space-y-2.5">
        {mine.map((lot) => (
          <div key={lot.id} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-3">
            <LotArt lot={lot} className="h-14 w-14 shrink-0 rounded-xl bg-black/20" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-amber-50">{lot.name}</p>
              <p className="text-[11px] text-amber-200/70">
                估值 {fmtMoney(lot.value)} · {lot.reserve > 0 ? `保留价 ${fmtMoney(lot.reserve)}` : '不设保留价'}
                {lot.inspected ? ' · 已验货' : ''}
              </p>
              {lot.inspected && (
                <p className="text-[11px] font-semibold text-sky-300/90">{FLAW_LABEL[lot.flaw]}</p>
              )}
            </div>
            <button
              onClick={() => { const r = withdrawLot(who, lot.id); onMsg(r.msg); }}
              className="rounded-full bg-white/10 px-3 py-1.5 text-xs text-amber-100/80 active:scale-95"
            >
              撤拍
            </button>
          </div>
        ))}
        {mine.length < MAX_LOTS && (
          <button
            onClick={onPick}
            className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-amber-300/40 py-4 text-sm font-semibold text-amber-200 active:scale-95"
          >
            <Gavel className="h-4 w-4" /> 上拍一件宝贝
          </button>
        )}
      </div>

      {/* 对方的 */}
      <div className="mt-6 mb-2 flex items-center gap-2">
        <p className="text-xs tracking-[0.25em] text-amber-200/60">{partner || '对方'}的拍品（保留价保密）</p>
        <span className="ml-auto text-[10px] text-amber-100/40">{sideSyncLabel(partner)}</span>
      </div>
      <div className="space-y-2.5">
        {theirs.map((lot) => (
          <div key={lot.id} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-3">
            <LotArt lot={lot} className="h-14 w-14 shrink-0 rounded-xl bg-black/20" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-amber-50">{lot.name}</p>
              <p className="text-[11px] text-amber-200/70">估值 {fmtMoney(lot.value)}{lot.inspected ? ' · 对方已验货' : ''}</p>
            </div>
          </div>
        ))}
        {theirs.length === 0 && <p className="rounded-2xl bg-white/5 p-4 text-center text-xs text-amber-100/50">还在挑宝贝…</p>}
      </div>

      {/* 底部操作 */}
      <div className="fixed inset-x-0 bottom-0 mx-auto max-w-md rounded-t-3xl border-t border-amber-200/20 bg-[#122b23]/95 p-4 pb-6 backdrop-blur">
        <div className="mb-3 flex items-center justify-center gap-4 text-xs">
          <span className={myReady ? 'text-emerald-300' : 'text-amber-100/50'}>
            {myReady ? '✅ 我已准备' : '❌ 我未准备'}
          </span>
          <span className={partnerReady ? 'text-emerald-300' : 'text-amber-100/50'}>
            {partnerReady ? `✅ ${partner}已准备` : `⏳ 等${partner}准备`}
          </span>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => { const r = setReady(who); onMsg(r.msg); }}
            disabled={myReady || mine.length === 0}
            className="flex-1 rounded-2xl border border-amber-300/40 py-3 text-sm font-bold tracking-widest text-amber-200 transition-transform active:scale-95 disabled:opacity-40"
          >
            {myReady ? '已准备 ✓' : '准备完毕'}
          </button>
          <button
            onClick={() => { const r = startLive(who); onMsg(r.msg); }}
            disabled={!(myReady && partnerReady)}
            className="flex-[1.4] rounded-2xl bg-gradient-to-r from-amber-400 to-yellow-500 py-3 text-sm font-bold tracking-[0.2em] text-[#3a2c07] shadow-lg shadow-amber-500/30 transition-transform active:scale-95 disabled:opacity-30"
          >
            开槌 🔨
          </button>
        </div>
        <p className="mt-2 text-center text-[10px] text-amber-100/40">双方都准备后才能开槌</p>
      </div>
    </div>
  );
}

/* ---------- 第二幕：拍卖台（两端同步播放剧本） ---------- */
/** 舞台拍品位：心跳刷新时 lot 引用不变 → memo 跳过重渲染 */
const StageLot = memo(function StageLot({ lot }: { lot: AuctionLot }) {
  const rarityColor = RARITY_COLOR[varietyById(lot.varietyId).rarity] ?? '#7fae6e';
  return (
    <>
      <div className="relative">
        <div className="absolute inset-0 rounded-3xl bg-amber-300/15 blur-2xl" />
        {/* 2026-10-05 边框改圆角方形：拍品图本身是正方形，原来用圆形边框会切掉四角 */}
        <div className="relative flex h-40 w-40 items-center justify-center overflow-hidden rounded-3xl border-2 border-amber-300/50 bg-black/25 shadow-[0_0_40px_rgba(251,191,36,0.25)]">
          <LotArt lot={lot} className="h-32 w-32" imgClass="rounded-2xl" />
        </div>
      </div>
      <p className="mt-4 max-w-[80%] truncate text-center text-base font-bold text-amber-50">{lot.name}</p>
      <p className="mt-1 text-[11px] text-amber-200/70">
        委托人 {lot.seller} · 行家估价 <span style={{ color: rarityColor }}>{fmtMoney(lot.value)}</span>
      </p>
    </>
  );
});

/** 出价流水行：b 来自剧本内稳定引用 → 无新出价时跳过重渲染 */
const BidRow = memo(function BidRow({ b }: { b: BidEvent }) {
  const jump = b.delta != null && b.price > 0 && b.delta / b.price >= 0.18;
  return (
    <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5" style={{ animation: 'auc-in .35s ease' }}>
      <span className="text-sm">{b.emoji}</span>
      <p className="flex-1 text-xs text-amber-100/90">{b.ai}</p>
      {b.delta != null && b.delta > 0 && (
        <p className={`text-[10px] font-bold ${jump ? 'text-orange-400' : 'text-amber-200/50'}`}>
          {jump ? '🔥 +' : '+'}{fmtMoney(b.delta)}
        </p>
      )}
      <p className="text-sm font-bold text-amber-300">{fmtMoney(b.price)}</p>
    </div>
  );
});

function LiveView({ session }: { session: AuctionSession }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((t) => t + 1), 100);
    return () => clearInterval(id);
  }, []);
  // 对齐开槌者时钟（见 lib/auction 的 anchorClock），两台手机系统时间不一致也能同帧
  const elapsed = liveElapsed(session);
  useEffect(() => {
    if (elapsed > (session.script?.total ?? Infinity)) settleIfDone();
  });
  const frame = liveFrame(session, elapsed);
  const theme = themeById(session.themeId);
  const ls = frame.ls;
  const recentBids = frame.bidsSoFar.slice(-3);
  const startPrice = ls?.bids[0]?.price ?? 0;
  // 进度点仅在换拍品时重算
  const dots = useMemo(() => session.script?.lots.map((l, i) => (
    <span key={l.lotId} className={`h-1.5 rounded-full transition-all ${i === frame.lotIdx ? 'w-5 bg-amber-300' : i < frame.lotIdx ? 'w-1.5 bg-amber-300/60' : 'w-1.5 bg-white/15'}`} />
  )) ?? null, [session.script, frame.lotIdx]);

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      {/* 顶部：专场 + 进度 */}
      <div className="flex items-center justify-between px-4 pt-2">
        <p className="text-xs tracking-widest text-amber-200/70">{theme.emoji} {theme.name}</p>
        {session.script && (
          <div className="flex items-center gap-1.5">
            {dots}
          </div>
        )}
      </div>

      {/* 舞台 */}
      <div className="flex flex-1 flex-col items-center justify-center px-6">
        {frame.phase === 'wait' && (
          <p className="animate-pulse text-sm tracking-[0.3em] text-amber-200">拍卖即将开始…</p>
        )}
        {(frame.phase === 'intro' || frame.phase === 'bidding' || frame.phase === 'hammer' || frame.phase === 'unsold') && frame.lot && ls && (
          <>
            {/* 拍品 */}
            <StageLot lot={frame.lot} />

            {/* 价格区 */}
            <div className="mt-5 flex h-24 flex-col items-center justify-center">
              {frame.phase === 'intro' && (
                <div className="text-center">
                  <p className="text-xs tracking-[0.3em] text-amber-200/70">即将开拍</p>
                  <p className="mt-1 text-2xl font-bold text-amber-100">{fmtMoney(startPrice)} 起拍</p>
                </div>
              )}
              {frame.phase === 'bidding' && (
                <div key={`${frame.price}-${frame.leader}`} className="text-center" style={{ animation: 'auc-pop .3s ease' }}>
                  <p className="text-[11px] tracking-[0.3em] text-amber-200/60">当前价</p>
                  <p className="bg-gradient-to-b from-amber-200 to-amber-400 bg-clip-text text-5xl font-black text-transparent">
                    {fmtMoney(frame.price)}
                  </p>
                  {frame.leader && <p className="mt-1 text-xs text-amber-200/80">{frame.leaderEmoji} {frame.leader} 领先</p>}
                </div>
              )}
              {frame.phase === 'hammer' && (
                <div className="text-center" style={{ animation: 'auc-in .4s ease' }}>
                  <p className="text-3xl" style={{ animation: 'auc-hammer .5s ease' }}>🔨</p>
                  <p className="mt-1 bg-gradient-to-b from-amber-200 to-amber-400 bg-clip-text text-4xl font-black text-transparent">
                    成交！{fmtMoney(ls.price)}
                  </p>
                  <p className="mt-1 text-xs text-amber-200/80">🏆 {ls.buyer} 拍得</p>
                </div>
              )}
              {frame.phase === 'unsold' && (
                <div className="text-center" style={{ animation: 'auc-in .4s ease' }}>
                  <p className="text-4xl">🕊️</p>
                  <p className="mt-1 text-2xl font-black tracking-[0.2em] text-amber-100/80">流 拍</p>
                  <p className="mt-1 text-xs text-amber-200/60">{bidsSoFarText(ls)}</p>
                </div>
              )}
            </div>

            {/* 出价流水 */}
            <div className="mt-2 flex h-24 w-full max-w-xs flex-col-reverse gap-1.5 overflow-hidden">
              {recentBids.map((b) => (
                <BidRow key={`${b.t}-${b.ai}-${b.price}`} b={b} />
              ))}
            </div>
          </>
        )}
        {frame.phase === 'done' && <p className="animate-pulse text-sm tracking-[0.3em] text-amber-200">统计战报中…</p>}
      </div>

      {/* 叫价大字（落槌倒计时） */}
      {frame.phase === 'bidding' && frame.callout && (
        <div className="pointer-events-none absolute inset-x-0 top-[16%] flex justify-center">
          <p className="rounded-2xl border-2 border-red-400/70 bg-red-950/70 px-6 py-2 text-3xl font-black tracking-[0.3em] text-red-200 shadow-[0_0_30px_rgba(239,68,68,0.5)]" style={{ animation: 'auc-flash .5s infinite' }}>
            {frame.callout}
          </p>
        </div>
      )}
      {frame.phase === 'bidding' && ls && (
        <div className="pointer-events-none absolute inset-x-0 bottom-[31%] flex justify-center">
          <div className="flex items-center gap-1 rounded-full bg-black/40 px-3 py-1 text-[11px] text-amber-200/80">
            <Timer className="h-3 w-3" />
            {Math.max(0, (ls.hammerAt - elapsed) / 1000).toFixed(1)}s
          </div>
        </div>
      )}
    </div>
  );
}

function bidsSoFarText(ls: { bids: unknown[]; result: string }): string {
  if (ls.result !== 'unsold') return '';
  return ls.bids.length > 0 ? '有人举牌，但没到卖家保留价' : '无人应价…';
}

/* ---------- 流拍保管仓（ settled 战报 & 空闲页共用） ---------- */
function HeldVault({ who, balance, onMsg }: { who: string; balance: number; onMsg: (m: string) => void }) {
  const held = heldLotsOf(who);
  if (held.length === 0) return null;
  return (
    <div className="mt-5 rounded-3xl border border-amber-200/25 bg-gradient-to-br from-[#1a2f3a] to-[#122530] p-4">
      <p className="mb-1 flex items-center gap-1.5 text-xs tracking-[0.25em] text-sky-200/80">🏦 拍卖行保管仓 · {held.length} 件</p>
      <div className="space-y-2">
        {held.map((lot) => {
          const fee = redeemFee(lot);
          const afford = balance >= fee;
          return (
            <div key={lot.id} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-3">
              <LotArt lot={lot} className="h-12 w-12 shrink-0 rounded-xl bg-black/20" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-amber-50">{lot.name}</p>
                <p className="text-[11px] text-amber-200/60">
                  {lot.seller === who ? '我的委托' : lot.seller} · 保管溢价 <span className="font-bold text-sky-300">{fmtMoney(fee)}</span>
                </p>
              </div>
              <button
                onClick={() => { const r = redeemHeldLot(who, lot.id, balance); onMsg(r.msg); }}
                disabled={!afford}
                className="shrink-0 rounded-full bg-gradient-to-r from-sky-400 to-cyan-400 px-3 py-1.5 text-xs font-bold text-[#0b2a33] shadow-lg shadow-sky-500/20 transition-transform active:scale-95 disabled:opacity-40"
              >
                赎回
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- 第三幕：战报 ---------- */
function SettledView({ session, who, partner, balance, onMsg }: { session: AuctionSession; who: string; partner: string; balance: number; onMsg: (m: string) => void }) {
  const sc = session.script;
  const mySummary = sessionSummary(session, who);
  const partnerSummary = sessionSummary(session, partner);

  // 结算即默认收回成交款，不用等手动确认；paid 墓碑 + 确定性交易 id 双保险，双端同时触发也只入账一次
  useEffect(() => {
    const r = claimProceeds(who);
    if (r.ok && r.amount > 0) onMsg(r.msg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [who, session.id]);

  return (
    <div className="flex-1 overflow-y-auto px-4 pb-12">
      <p className="mt-2 text-center text-lg font-bold tracking-[0.3em] text-amber-200">本场战报</p>
      <p className="mt-1 text-center text-[11px] text-amber-200/50">{themeById(session.themeId).emoji} {themeById(session.themeId).name} · 已落槌 {sc?.lots.filter((l) => l.result === 'sold').length ?? 0} 件</p>

      {/* 双方对比 */}
      {sc && (
        <div className="mt-5 grid grid-cols-2 gap-3">
          {[{ name: who, s: mySummary }, { name: partner, s: partnerSummary }].map(({ name, s }) => (
            <div key={name} className={`rounded-2xl border p-4 ${name === who ? 'border-amber-300/40 bg-amber-300/8' : 'border-white/10 bg-white/5'}`}>
              <p className="text-xs text-amber-200/70">{name}{name === who ? '（我）' : ''}</p>
              <p className="mt-1 text-2xl font-black text-amber-200">{fmtMoney(s?.total ?? 0)}</p>
              <p className="text-[10px] text-amber-200/60">成交额 · 时元</p>
              <p className="mt-2 text-[11px] leading-relaxed text-amber-100/80">
                成交 {s?.sold ?? 0} 件 · 流拍 {s?.unsold ?? 0} 件
                {s?.bestName ? <><br />标王：{s.bestName}</> : ''}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* 每件拍品结果 */}
      <div className="mt-6 space-y-2.5">
        {sc?.lots.map((ls) => {
          const lot = session.lots[ls.lotId] ?? session.aiLots?.[ls.lotId];
          if (!lot) return null;
          const buy = session.aiBuys?.[ls.lotId];
          return (
            <div key={ls.lotId} className={`rounded-2xl border p-3.5 ${lot.ai ? 'border-sky-300/25 bg-sky-300/5' : 'border-white/10 bg-white/5'}`}>
              <div className="flex items-center gap-3">
                <LotArt lot={lot} className="h-12 w-12 shrink-0 rounded-xl bg-black/20" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-amber-50">{lot.name}</p>
                  <p className="text-[11px] text-amber-200/60">
                    {lot.seller} 委托{lot.ai ? ' · 私藏' : ''} · 行家事后估价 {fmtMoney(ls.hiddenV)}
                  </p>
                </div>
                <div className="text-right">
                  {ls.result === 'sold' ? (
                    <p className="text-base font-black text-amber-300">{fmtMoney(ls.price)}</p>
                  ) : (
                    <p className="text-base font-black text-amber-100/40">流拍</p>
                  )}
                  <p className="text-[10px] text-amber-200/60">{TAG_LABEL[ls.tag]}</p>
                </div>
              </div>
              <p className="mt-2 text-[11px] italic leading-relaxed text-amber-100/60">“{ls.comment}”</p>
              {/* AI 私藏：成交后双方可按成交价抢收 */}
              {lot.ai && ls.result === 'sold' && (
                buy ? (
                  <p className={`mt-2 rounded-xl px-3 py-2 text-center text-[11px] font-semibold ${buy.who === who ? 'bg-emerald-400/15 text-emerald-200' : 'bg-white/5 text-amber-100/60'}`}>
                    {buy.who === who ? '已收入你的仓库 ✓' : `已被 ${buy.who} 收下`}
                  </p>
                ) : (
                  <button
                    onClick={() => { const r = buyAiLot(who, ls.lotId, balance); onMsg(r.msg); }}
                    className="mt-2 w-full rounded-xl bg-gradient-to-r from-sky-400 to-cyan-400 py-2 text-xs font-bold tracking-widest text-[#0b2a33] shadow-lg shadow-sky-500/20 transition-transform active:scale-95">
                    按成交价 {fmtMoney(ls.price)} 收下 💎
                  </button>
                )
              )}
            </div>
          );
        })}
      </div>

      {/* 流拍保管仓：付溢价赎回 */}
      <HeldVault who={who} balance={balance} onMsg={onMsg} />

      {/* 成交款自动入账 + 再来一场 */}
      {mySummary && mySummary.total > 0 && (
        <p className="mt-6 rounded-2xl bg-emerald-400/10 px-4 py-3 text-center text-xs font-semibold text-emerald-200">
          成交款 {fmtMoney(mySummary.total)} 时元已自动入袋 💰
        </p>
      )}
      <button
        onClick={() => { onMsg('正在开新场…'); void openSession(who).then((r) => onMsg(r.msg)); }}
        className="mt-3 w-full rounded-2xl border border-amber-300/40 py-3 text-sm font-bold tracking-widest text-amber-200 transition-transform active:scale-95"
      >
        再来一场 🔨
      </button>
    </div>
  );
}

function sessionSummary(session: AuctionSession, who: string) {
  const sc = session.script;
  if (!sc) return { total: 0, sold: 0, unsold: 0, bestName: undefined as string | undefined, bestPrice: undefined as number | undefined };
  let total = 0; let sold = 0; let unsold = 0;
  let bestName: string | undefined; let bestPrice = 0;
  for (const ls of sc.lots) {
    const lot = session.lots[ls.lotId];
    if (!lot || lot.seller !== who) continue;
    if (ls.result === 'sold') {
      total += ls.price; sold++;
      if (ls.price > bestPrice) { bestPrice = ls.price; bestName = lot.name; }
    } else {
      unsold++;
    }
  }
  return { total, sold, unsold, bestName, bestPrice: bestPrice || undefined };
}

/* ---------- 空闲态 ---------- */
function IdleView({ who, balance, onMsg }: { who: string; balance: number; onMsg: (m: string) => void }) {
  const st = auctionState();
  const archives = Object.values(st.archives).sort((a, b) => b.at - a.at);
  return (
    <div className="flex-1 overflow-y-auto px-4 pb-12">
      {/* 招牌 */}
      <div className="relative mt-2 overflow-hidden rounded-3xl border border-amber-200/25 bg-gradient-to-br from-[#173a2f] via-[#10291f] to-[#0b1d16] p-6 shadow-xl">
        <div className="absolute -right-6 -top-6 text-[100px] opacity-10">🔨</div>
        <p className="text-3xl">🏛️</p>
        <p className="mt-2 bg-gradient-to-b from-amber-200 to-amber-400 bg-clip-text text-2xl font-black tracking-[0.2em] text-transparent">玉缘拍卖会</p>
        <p className="mt-2 text-xs leading-relaxed text-amber-100/70">
          月上柳梢，拍卖行的灯笼亮了 🏮<br />
          珍宝轮番登场，举牌起落之间，<br />
          今晚的标王会是谁——
        </p>
        <button
          onClick={() => { onMsg('正在开新场…'); void openSession(who).then((r) => onMsg(r.msg)); }}
          className="mt-5 w-full rounded-2xl bg-gradient-to-r from-amber-400 to-yellow-500 py-3.5 text-sm font-bold tracking-[0.25em] text-[#3a2c07] shadow-lg shadow-amber-500/30 transition-transform active:scale-95"
        >
          开一场拍卖会 🔨
        </button>
      </div>

      {/* 今夜看点 */}
      <div className="mt-5 rounded-3xl border border-white/10 bg-white/5 p-4">
        <p className="mb-2 text-xs tracking-[0.25em] text-amber-200/60">今夜看点</p>
        {[
          ['🏮', '从仓库挑一件宝贝上拍，上拍前可以打灯验验货'],
          ['🎭', '蒙面卖家和深夜来客各带 2 件私藏登场，落槌后谁手快就是谁的'],
          ['🌱', '私藏里偶尔混着一包农场特殊种子（每场至多一次），拍到就能种'],
          ['🔨', '加价一手接一手咬到最后一秒，最高能翻到行家估价的 10 倍'],
          ['💥', '偶尔杀出志在必得的神秘买家，再不起眼的小玩意儿也可能拍出天价'],
          ['🏦', '流拍的宝贝会进保管仓，想取回得付保管溢价赎回'],
        ].map(([e, t]) => (
          <p key={t} className="mb-1.5 flex gap-2 text-[11px] leading-relaxed text-amber-100/75">
            <span className="shrink-0">{e}</span>
            {t}
          </p>
        ))}
      </div>

      {/* 流拍保管仓 */}
      <HeldVault who={who} balance={balance} onMsg={onMsg} />

      {/* 最近战报 */}
      {archives.length > 0 && (
        <div className="mt-5">
          <p className="mb-2 text-xs tracking-[0.25em] text-amber-200/60">最近战报</p>
          <div className="space-y-2">
            {archives.map((a) => (
              <div key={a.id} className="rounded-2xl border border-white/10 bg-white/5 p-3 text-[11px] text-amber-100/75">
                <p className="text-amber-200/60">{new Date(a.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
                <p className="mt-1">
                  {Object.entries(a.bySeller).map(([name, s]) => `${name} ${fmtMoney(s.total)}`).join(' · ')} 时元
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- 页面 ---------- */
/** keyframes 只注一次：不能放在 LiveView 里——它 100ms 强制重渲染一次，
 *  每次重写 <style> 文本都会让浏览器重新解析动画 CSS 并全页样式重算（手机掉帧主因） */
function injectKeyframes(): void {
  if (typeof document === 'undefined' || document.getElementById('auc-anim')) return;
  const el = document.createElement('style');
  el.id = 'auc-anim';
  el.textContent = `
    @keyframes auc-pop { 0% { transform: scale(1.3); } 100% { transform: scale(1); } }
    @keyframes auc-in { 0% { opacity: 0; transform: translateY(12px) scale(.92); } 100% { opacity: 1; transform: none; } }
    @keyframes auc-flash { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
    @keyframes auc-hammer { 0% { transform: translateY(-46px) rotate(-32deg); opacity: 0; } 55% { transform: translateY(5px) rotate(10deg); opacity: 1; } 100% { transform: none; } }
  `;
  document.head.appendChild(el);
}

export default function AuctionPage({ user, onBack }: { user: { name: string }; onBack: () => void }) {
  const [, tick] = useState(0);
  const [txs, setTxs] = useState<WalletTx[]>([]);
  const [asks, setAsks] = useState<AskItem[]>([]);
  const [farms, setFarms] = useState<Record<string, FarmOf>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const guest = isGuestSession();

  useEffect(() => subscribeAuction(() => tick((t) => t + 1)), []);
  // 分片到达（对方点了「同步」）时也要刷新：弹窗/列表要立刻出现对方的拍品
  useEffect(() => subscribeAuctionSide(() => tick((t) => t + 1)), []);
  useEffect(() => { injectKeyframes(); }, []);
  useEffect(() => subscribeJade(() => tick((t) => t + 1)), []);
  useEffect(() => subscribeWallet((t) => setTxs(t)), []);
  useEffect(() => subscribeAsks((a) => setAsks(a)), []);
  useEffect(() => subscribeFarm((f) => setFarms(f)), []);
  useEffect(() => {
    if (!msg) return;
    const id = setTimeout(() => setMsg(null), 2800);
    return () => clearTimeout(id);
  }, [msg]);

  const who = user.name;
  const partner = partnerOf(who);
  const balance = totalBalance(txs, asks, who);
  const st = auctionState();
  const session = st.session;
  const status = session?.status ?? 'idle';

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col bg-gradient-to-b from-[#0d231c] via-[#0f2a21] to-[#0a1d16]">
      {/* 头部 */}
      <div className="sticky top-0 z-20 flex items-center gap-3 border-b border-white/5 bg-[#0d231c]/90 px-4 py-3 backdrop-blur">
        <button onClick={onBack} className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-amber-100 active:scale-95">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <p className="text-base font-bold tracking-[0.2em] text-amber-100">玉缘拍卖会</p>
        <span className="ml-auto flex items-center gap-1 rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-amber-200">
          <Coins className="h-3.5 w-3.5" />
          {fmtMoney(balance)}
        </span>
      </div>

      {guest && (
        <p className="mx-4 mt-3 rounded-xl bg-white/10 px-3 py-2 text-center text-xs text-amber-100/70">游客模式：只能围观，不能上拍</p>
      )}

      {status === 'idle' && <IdleView who={who} balance={balance} onMsg={setMsg} />}
      {session && status === 'prep' && (
        <PrepView session={session} who={who} partner={partner} onMsg={setMsg} onPick={() => setPicking(true)} />
      )}
      {session && status === 'live' && <LiveView session={session} />}
      {session && status === 'settled' && (
        <SettledView session={session} who={who} partner={partner} balance={balance} onMsg={setMsg} />
      )}

      <ScrollTopButton tone="dark" />

      {/* 选品上拍 */}
      {picking && session?.status === 'prep' && (
        <PickLotModal who={who} farms={farms} onClose={() => setPicking(false)} onMsg={setMsg} />
      )}

      {/* toast */}
      {msg && (
        <div className="fixed inset-x-0 top-16 z-[60] flex justify-center px-8">
          <p className="rounded-full bg-black/75 px-5 py-2.5 text-center text-xs font-semibold text-amber-100 shadow-xl backdrop-blur">{msg}</p>
        </div>
      )}
    </div>
  );
}
