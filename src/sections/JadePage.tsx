import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Coins, Droplets, FlaskConical, Gem, Gift, Hammer, Scale, Trophy, Wrench, X } from 'lucide-react';
import {
  subscribeJade, buyStone, buyStones, completeCut, cutMany, sellStone, keepStone, sellPrice, dissolveProduct,
  stonesOf, collectionOf, jadeStats, jadeWealth,
  craftProduct, craftPreview, giftProduct, productsOf, keptStonesOf,
  STONE_TIERS, JADE_VARIETIES, varietyById, hotVarietyOfDay, luckyTierOfDay, isHotSellable,
  CRAFT_TYPES, CRAFT_METALS, CRAFT_CORDS, craftTypeById,
  forgeBrick, brickOptionsOf, bricksOf, brickNameOf, isBrick, BRICK_GRAMS,
  PURIFIERS, purifierById, purityGrade, purityCoef, GOAL_MIN,
  purifyPreview, purifyStone, reagentCount, reagentCountOf, purifiablesOf,
  type OwnedStone, type JadeProduct, type Purifier, type CutResult, type StoneTier,
} from '../lib/jade';
import { subscribeWallet, type WalletTx } from '../lib/wallet';
import { subscribeAsks, type AskItem } from '../lib/ask';
import { totalBalance } from '../lib/balance';
import { isGuestSession } from '../lib/guest';
import { partnerOf } from '../lib/space';
import { STONE_ART, JADE_ART, craftArt } from '../lib/jadeArt';
import { generateProductArt, productArt, subscribeProductArt } from '../lib/jadeProductArt';
import { isImageReady } from '../lib/deepseek';
import { useSlice, ListMoreBar, ScrollTopButton } from '../components/SliceList';

/** 有 AI 生成图就显示图，否则 emoji 兜底 */
function ArtImg({ art, emoji, className, style }: {
  art: string | undefined; emoji: string;
  className?: string; style?: React.CSSProperties;
}) {
  if (art) return <img src={art} alt="" draggable={false} className={className} style={style} />;
  return <span className={className} style={style}>{emoji}</span>;
}

const RARITY_STYLE: Record<string, { color: string; bg: string }> = {
  '废料': { color: '#8a8a8a', bg: '#f0f0f0' },
  '常见': { color: '#2e7d4f', bg: '#e8f5ec' },
  '少见': { color: '#1d6fa5', bg: '#e6f2fa' },
  '稀有': { color: '#8a4fc4', bg: '#f2eafb' },
  '传说': { color: '#c9930a', bg: '#fdf3d7' },
  '神话': { color: '#d41f3d', bg: '#fde3e8' },
};

type Tab = 'shop' | 'bench' | 'forge' | 'purify' | 'cabinet';

/* ---------- 纯度展示（全站统一口径：纯度 + 品级色） ---------- */
/** 品级字（粗/普/净/润/莹/灵/通/绝）与配色，档位由 lib/jade 的 purityGrade 决定 */
const PURITY_COLOR: Record<string, string> = {
  粗: '#8a8a8a', 普: '#5f9e6b', 净: '#3f9ac4', 润: '#7b6fd0',
  莹: '#a05fc4', 灵: '#c9930a', 通: '#e0743c', 绝: '#d41f3d',
};

function purityStyle(p: number) {
  const grade = purityGrade(p);
  return { color: PURITY_COLOR[grade] ?? '#8a8a8a', label: grade };
}

/** 纯度条：一格一格填满，越纯颜色越亮。size='sm' 用于列表，'lg' 用于详情 */
function PurityBar({ purity, goal, size = 'sm' }: { purity: number; goal: number; size?: 'sm' | 'lg' }) {
  const st = purityStyle(purity);
  const pct = Math.round(purity * 100);
  const goalPct = Math.round(goal * 100);
  const h = size === 'lg' ? 'h-2' : 'h-1.5';
  return (
    <div className="w-full">
      <div className={`relative w-full ${h} overflow-hidden rounded-full bg-emerald-100/80`}>
        {/* 极限纯度刻度线：告诉玩家「还能提到哪」 */}
        <div className="absolute top-0 h-full w-px bg-amber-400/70" style={{ left: `${goalPct}%` }} />
        <div className={`h-full rounded-full transition-[width] ${size === 'lg' ? 'bg-gradient-to-r from-emerald-300 to-emerald-500' : ''}`}
          style={{ width: `${pct}%`, background: size === 'lg' ? undefined : st.color }} />
      </div>
    </div>
  );
}

/** 纯度徽章：品级字 + 纯度百分比，列表/卡片通用 */
function PurityBadge({ purity, goal, showGoal }: { purity: number; goal: number; showGoal?: boolean }) {
  const st = purityStyle(purity);
  const pct = (purity * 100).toFixed(purity >= 0.995 ? 0 : 1);
  const maxed = purity >= goal - 1e-6;
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold"
      style={{ color: st.color, background: `${st.color}14` }}>
      <span className="font-black">{st.label}</span>
      纯度 {pct}%
      {showGoal && !maxed && <span className="font-normal text-emerald-400">/ 顶 {Math.round(goal * 100)}%</span>}
      {maxed && <span className="font-black">· 绝顶</span>}
    </span>
  );
}

/** 数值折成「万」为单位，避免手机端大数字挤成重影：>=1万 显示 X.X万，否则原样 */
function fmtWan(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 10000) {
    const w = n / 10000;
    // 100 万以上取整，否则保留 1 位小数并去掉多余的 0
    const s = abs >= 1000000 ? Math.round(w).toLocaleString() : (Math.round(w * 10) / 10).toString();
    return s + '万';
  }
  return n.toLocaleString();
}

/** 是否已提到极限纯度 */
function isMaxPurity(s: { purity?: number; goalPurity?: number }): boolean {
  return (s.purity ?? 0.5) >= (s.goalPurity ?? GOAL_MIN) - 1e-6;
}

/** 提到极限纯度还能涨多少时元（当前估值 × coef(顶)/coef(现) - 当前估值） */
function purityUpside(s: { value: number; purity?: number; goalPurity?: number }): number {
  const cur = s.purity ?? 0.5;
  const goal = s.goalPurity ?? GOAL_MIN;
  if (cur >= goal - 1e-6) return 0;
  const next = Math.max(50, Math.round((s.value * (purityCoef(goal) / purityCoef(cur))) / 50) * 50);
  return Math.max(0, next - s.value);
}

/* ---------- 长列表「分批展示」：玉石多了不用一路下拉 ---------- */
/* useSlice / ListMoreBar 见 components/SliceList.tsx（拍卖页共用） */

export default function JadePage({ user, onBack, onOpenFarm }: {
  user: { name: string }; onBack: () => void; onOpenFarm?: () => void;
}) {
  const [, tick] = useState(0);
  const [txs, setTxs] = useState<WalletTx[]>([]);
  const [asks, setAsks] = useState<AskItem[]>([]);
  const [tab, setTab] = useState<Tab>('shop');
  const [msg, setMsg] = useState<string | null>(null);
  const [cutting, setCutting] = useState<string | null>(null); // stoneId
  const [detailVariety, setDetailVariety] = useState<string | null>(null); // 收藏柜点开查看
  const [forgeStone, setForgeStone] = useState<string | null>(null); // 工坊预选料子
  const [purifyStone, setPurifyStone] = useState<string | null>(null); // 提纯页预选石头
  const [buyTier, setBuyTier] = useState<string | null>(null); // 批量购入的档位
  const cutHoldUntil = useRef(0); // 切完开奖展示期：期内不自动退回列表，开奖画面不被闪走
  /** 一键切石的汇总开奖（切完 5 块一次性看结果） */
  const [batchCut, setBatchCut] = useState<Array<CutResult & { stoneId: string; tierId: string }> | null>(null);
  const guest = isGuestSession();

  useEffect(() => subscribeJade(() => tick((t) => t + 1)), []);
  useEffect(() => subscribeWallet((t) => setTxs(t)), []);
  useEffect(() => subscribeAsks((a) => setAsks(a)), []);
  useEffect(() => {
    if (!msg) return;
    const id = setTimeout(() => setMsg(null), 2600);
    return () => clearTimeout(id);
  }, [msg]);

  const who = user.name;
  // 今日高价玉石 / 今日幸运料子（每日按本地日期哈希，多端一致）
  const hotVariety = varietyById(hotVarietyOfDay());
  const luckyTier = STONE_TIERS.find((t) => t.id === luckyTierOfDay());
  const buyTierObj = buyTier ? STONE_TIERS.find((t) => t.id === buyTier) : undefined;
  // 与主页同一口径：钱包账本 + 默契挑战积分，两个页面数字永远一致
  const balance = totalBalance(txs, asks, who);
  const wealth = jadeWealth(who);
  const myStones = stonesOf(who);
  const uncut = myStones.filter((s) => s.status === 'uncut');
  const cutPending = myStones.filter((s) => s.status === 'cut');
  // 长列表分批：切割台两块列表各管各的（待切通常不多，待处理容易积压）
  const uncutSlice = useSlice(uncut.length);
  const pendingSlice = useSlice(cutPending.length);
  const collection = collectionOf(who);
  const stats = jadeStats(who);
  const profit = stats.earned - stats.spent;

  const doBuy = (tierId: string) => {
    const r = buyStone(who, tierId, balance);
    setMsg(r.msg);
    if (r.ok && r.stone) {
      setCutting(r.stone.id);
      setTab('bench'); // 买料后直接去切割台开磨，不用自己再点一页
    }
  };

  // 切完直接卖掉后料子会从列表消失，自动退回切割台列表，避免卡在开奖界面空白；
  // 但开奖展示期（切完几秒内）不退出——同步消息抖动导致料子瞬断时开奖画面不能被闪走
  useEffect(() => {
    if (cutting && Date.now() >= cutHoldUntil.current && !myStones.some((s) => s.id === cutting)) setCutting(null);
  }, [cutting, myStones]);

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col bg-gradient-to-b from-[#f3f7f4] to-[#e8f0ea]">
      {/* 头部 */}
      <div className="sticky top-0 z-20 flex items-center gap-3 bg-white/85 px-4 py-3 shadow-sm backdrop-blur">
        <button onClick={onBack} className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 active:scale-95">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1">
          <p className="text-base font-bold text-emerald-800">玉石鉴定</p>
        </div>
        <div className="flex items-center gap-1 rounded-full bg-amber-50 px-3 py-1.5">
          <Coins className="h-4 w-4 text-amber-500" />
          <span className="text-sm font-bold text-amber-600">{balance}</span>
        </div>
      </div>

      {/* 提示条（fixed 悬浮不占文档流：买料提示 2.6 秒后消失时，不会再把下方打磨页面顶得跳一下） */}
      {msg && (
        <div className="pointer-events-none fixed inset-x-0 top-16 z-40 flex justify-center px-6">
          <div className="max-w-xs rounded-2xl bg-emerald-700/90 px-4 py-2.5 text-center text-xs leading-relaxed text-white shadow-lg">
            {msg}
          </div>
        </div>
      )}
      {guest && (
        <div className="mx-4 mt-3 rounded-2xl bg-white/80 px-4 py-2.5 text-center text-xs text-emerald-700 shadow">
          👀 游客模式：可以围观，买石头和切割要登录哦
        </div>
      )}

      {/* 内容 */}
      <div className="flex-1 px-4 pb-28 pt-4">
        {/* 每日行情：今日高价玉石 + 今日幸运料子 */}
        <div className="mb-3 flex items-center gap-2 rounded-2xl bg-gradient-to-r from-amber-50 to-orange-50 px-3 py-2.5 shadow-sm shadow-amber-100">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="shrink-0 text-xs font-bold text-amber-600">今日高价</span>
            <span className="truncate text-xs font-bold" style={{ color: hotVariety.color }}>{hotVariety.name}</span>
            <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold text-amber-700">回收×2</span>
          </div>
          <div className="h-4 w-px bg-amber-200" />
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="shrink-0 text-xs font-bold text-emerald-600">今日好料</span>
            <span className="truncate text-xs font-bold text-emerald-700">{luckyTier?.name}</span>
            <span className="shrink-0 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700">稀有×2</span>
          </div>
        </div>

        {tab === 'shop' && (
          <div className="space-y-3">
            {STONE_TIERS.map((t) => (
              <div key={t.id} className="flex items-center gap-3 rounded-2xl bg-white p-4 shadow-md shadow-emerald-100">
                <ArtImg art={STONE_ART[t.id]} emoji={t.emoji}
                  className="h-16 w-16 shrink-0 rounded-2xl object-cover"
                  style={{ background: 'linear-gradient(150deg,#dfe7df,#c4d2c4)' }} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-emerald-900">{t.name}</p>
                  <p className="mt-1 flex items-center gap-1 text-sm font-black text-amber-600">
                    <Coins className="h-3.5 w-3.5" />{t.price.toLocaleString()}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-stretch gap-1.5">
                  <button
                    onClick={() => doBuy(t.id)}
                    className="rounded-full bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-2 text-xs font-semibold text-white shadow-md shadow-emerald-200 transition-transform active:scale-95"
                  >
                    买下
                  </button>
                  <button
                    onClick={() => setBuyTier(t.id)}
                    className="rounded-full border border-emerald-200 bg-emerald-50 px-4 py-1 text-[11px] font-bold text-emerald-600 transition-transform active:scale-95"
                  >
                    购入
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'bench' && (
          <div className="space-y-3">
            {cutting ? (
              <CuttingView stoneId={cutting} who={who} onMsg={setMsg} onDone={() => setCutting(null)}
                onCutDone={() => { cutHoldUntil.current = Date.now() + 5000; }}
                onForge={(id) => { setForgeStone(id); setTab('forge'); }} />
            ) : (
              <>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-emerald-600">切割台：{uncut.length} 块待切 · {cutPending.length} 块待处理</p>
                  {uncut.length > 0 && (
                    <button
                      onClick={() => {
                        const r = cutMany(who, 5);
                        setMsg(r.msg);
                        if (r.results.length > 0) {
                          setBatchCut(r.results);
                          window.scrollTo({ top: 0 });
                        }
                      }}
                      className="shrink-0 rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 px-3.5 py-2 text-xs font-bold text-white shadow-md shadow-violet-200 transition-transform active:scale-95"
                    >
                      ⚡ 一键切石 ×{Math.min(5, uncut.length)}
                    </button>
                  )}
                </div>
                {uncut.length === 0 && cutPending.length === 0 && (
                  <p className="py-16 text-center text-sm text-emerald-400">切割台空空的<br />去「买料」扛块石头回来 🪨</p>
                )}
                {uncut.slice(0, uncutSlice.shown).map((s) => {
                  const tier = STONE_TIERS.find((t) => t.id === s.tierId)!;
                  return (
                    <button key={s.id} onClick={() => setCutting(s.id)}
                      className="flex w-full items-center gap-3 rounded-2xl bg-white p-4 text-left shadow-md shadow-emerald-100 active:scale-[0.98]">
                      <ArtImg art={STONE_ART[s.tierId]} emoji="🪨"
                        className="h-14 w-14 shrink-0 rounded-2xl object-cover" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-bold text-emerald-900">{tier.name}</p>
                        <p className="text-[11px] text-emerald-500">还没切 · 上打磨机 →</p>
                      </div>
                      <Hammer className="h-5 w-5 text-emerald-400" />
                    </button>
                  );
                })}
                <ListMoreBar shown={uncutSlice.shown} total={uncut.length}
                  hasMore={uncutSlice.hasMore} onMore={uncutSlice.more}
                  onAll={uncutSlice.all} onCollapse={uncutSlice.reset} label="块待切" />
                {cutPending.slice(0, pendingSlice.shown).map((s) => (
                  <RevealCard key={s.id} stone={s} who={who} onMsg={setMsg}
                    onForge={(id) => { setForgeStone(id); setTab('forge'); }} />
                ))}
                <ListMoreBar shown={pendingSlice.shown} total={cutPending.length}
                  hasMore={pendingSlice.hasMore} onMore={pendingSlice.more}
                  onAll={pendingSlice.all} onCollapse={pendingSlice.reset} label="块待处理" />
              </>
            )}
          </div>
        )}

        {tab === 'forge' && (
          <ForgeView
            who={who}
            onMsg={setMsg}
            selectedId={forgeStone}
            onSelect={setForgeStone}
          />
        )}

        {tab === 'purify' && (
          <PurifyView who={who} onMsg={setMsg} onOpenFarm={onOpenFarm}
            presetId={purifyStone} onPresetDone={() => setPurifyStone(null)} />
        )}

        {tab === 'cabinet' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-3.5 shadow-md shadow-emerald-200">
              <div className="flex items-center gap-2">
                <Gem className="h-5 w-5 text-white" />
                <span className="text-sm font-bold text-white">富贵值</span>
              </div>
              <span className="text-xl font-black tabular-nums text-white">{wealth}</span>
            </div>
            <div className="grid grid-cols-5 gap-2 rounded-2xl bg-white p-3 text-center shadow-md shadow-emerald-100">
              <div><p className="text-sm font-black text-emerald-800">{stats.cut}</p><p className="text-[10px] text-emerald-500">切过</p></div>
              <div><p className="text-sm font-black text-emerald-800">{stats.kept}</p><p className="text-[10px] text-emerald-500">收藏</p></div>
              <div><p className="text-sm font-black text-violet-600">{stats.crafted}</p><p className="text-[10px] text-emerald-500">成品</p></div>
              <div><p className="text-sm font-black text-amber-600">{fmtWan(stats.spent)}</p><p className="text-[10px] text-emerald-500">投入</p></div>
              <div>
                <p className={`text-sm font-black ${profit >= 0 ? 'text-rose-500' : 'text-slate-500'}`}>
                  {profit >= 0 ? '+' : '-'}{fmtWan(Math.abs(profit))}
                </p>
                <p className="text-[10px] text-emerald-500">盈亏</p>
              </div>
            </div>

            <p className="text-xs text-emerald-600">收藏柜（{collection.length}/{VARIETY_TOTAL} 个品种）</p>
            {collection.length === 0 ? (
              <p className="py-12 text-center text-sm text-emerald-400">柜子还空着<br />切出好玉记得点「收藏」💎</p>
            ) : (
              <div className="grid grid-cols-3 gap-2.5">
                {collection.map((c) => {
                  const v = varietyById(c.varietyId);
                  const st = RARITY_STYLE[v.rarity];
                  return (
                    <button key={c.varietyId} onClick={() => setDetailVariety(c.varietyId)}
                      className="flex flex-col items-center rounded-2xl bg-white py-3 shadow-md shadow-emerald-100 transition-transform active:scale-[0.97]">
                      <ArtImg art={JADE_ART[c.varietyId]} emoji={v.emoji}
                        className="h-14 w-14 rounded-2xl object-cover" />
                      <span className="mt-1 text-xs font-bold" style={{ color: st.color }}>{v.name}</span>
                      <span className="text-[10px] text-emerald-400">{c.grams}克 · 值{c.value.toLocaleString()}</span>
                      <span className="mt-0.5 text-[9px] font-bold" style={{ color: purityStyle(c.purity).color }}>
                        纯度 {(c.purity * 100).toFixed(0)}%
                      </span>
                      <span className="mt-0.5 text-[9px] tracking-widest text-emerald-300">点开查看 ➜</span>
                    </button>
                  );
                })}
              </div>
            )}

            <p className="pt-2 text-xs text-emerald-600">全部品种图鉴</p>
            <div className="grid grid-cols-4 gap-2">
              {JADE_VARIETIES.map((v) => {
                const st = RARITY_STYLE[v.rarity];
                const got = collection.some((c) => c.varietyId === v.id);
                return (
                  <div key={v.id} className="flex flex-col items-center rounded-xl py-2"
                    style={{ background: got ? st.bg : 'rgba(255,255,255,0.5)', opacity: got ? 1 : 0.45 }}>
                    {got ? (
                      <ArtImg art={JADE_ART[v.id]} emoji={v.emoji}
                        className="h-10 w-10 rounded-xl object-cover" />
                    ) : (
                      <span className="h-10 w-10 text-center text-xl leading-10">❓</span>
                    )}
                    <span className="text-[10px]" style={{ color: st.color }}>{v.name}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* 底部导航 */}
      <div className="fixed bottom-0 left-1/2 z-20 w-full max-w-md -translate-x-1/2 border-t border-emerald-100 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
        <div className="grid grid-cols-5">
          {([
            ['shop', '买料', Gem],
            ['bench', '切割台', Hammer],
            ['forge', '工坊', Wrench],
            ['purify', '提纯', FlaskConical],
            ['cabinet', '收藏柜', Trophy],
          ] as [Tab, string, typeof Gem][]).map(([id, label, Icon]) => (
            <button key={id} onClick={() => { setTab(id); setCutting(null); window.scrollTo({ top: 0 }); }}
              className={`flex flex-col items-center gap-1 py-3 ${tab === id ? 'text-emerald-600' : 'text-emerald-300'}`}>
              <Icon className="h-5 w-5" />
              <span className="text-[10px] font-medium">{label}</span>
            </button>
          ))}
        </div>
      </div>
      {/* 切页自动回顶：从长列表切到别的 tab，不会还停在半山腰 */}
      <ScrollTopButton tone="light" />
      {/* 收藏柜 · 点开查看某品种的每一颗 */}
      {detailVariety && (
        <KeptDetailModal
          who={who}
          varietyId={detailVariety}
          onClose={() => setDetailVariety(null)}
          onMsg={setMsg}
          onForge={(stoneId) => {
            setDetailVariety(null);
            setForgeStone(stoneId);
            setTab('forge');
          }}
          onPurify={(stoneId) => {
            setDetailVariety(null);
            setPurifyStone(stoneId);
            setTab('purify');
            window.scrollTo({ top: 0 });
          }}
        />
      )}

      {/* 一键切石 · 汇总开奖弹窗 */}
      {batchCut && (
        <BatchCutModal results={batchCut} onClose={() => setBatchCut(null)} />
      )}

      {/* 批量购入弹窗 */}
      {buyTierObj && (
        <BatchBuySheet
          who={who} tier={buyTierObj} balance={balance}
          onClose={() => setBuyTier(null)}
          onMsg={setMsg}
        />
      )}

    </div>
  );
}

/* 品种图鉴总数 */
const VARIETY_TOTAL = JADE_VARIETIES.length;

/* ---------- 买料区 · 批量购入 ----------
 * 一次下单 N 块直接入库（未切态）一次结账，钱包只记一笔总账 */
function BatchBuySheet({ who, tier, balance, onClose, onMsg }: {
  who: string; tier: StoneTier; balance: number;
  onClose: () => void; onMsg: (m: string) => void;
}) {
  const [n, setN] = useState(5);
  const cap = Math.max(1, Math.min(99, Math.floor(balance / tier.price) || 1));
  const cost = tier.price * n;
  const afford = balance >= cost;
  const delta = (d: number) => setN((v) => Math.max(1, Math.min(99, v + d)));
  const buyBatch = () => {
    const r = buyStones(who, tier.id, n, balance);
    onMsg(r.msg);
    if (r.ok) onClose();
  };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45" onClick={onClose}>
      <div className="w-full max-w-md rounded-t-3xl bg-white p-5 pb-8 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3">
          <ArtImg art={STONE_ART[tier.id]} emoji={tier.emoji}
            className="h-12 w-12 shrink-0 rounded-2xl object-cover"
            style={{ background: 'linear-gradient(150deg,#dfe7df,#c4d2c4)' }} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-black text-emerald-900">{tier.name}</p>
            <p className="mt-0.5 flex items-center gap-1 text-xs font-bold text-amber-600">
              <Coins className="h-3.5 w-3.5" />{tier.price.toLocaleString()} <span className="font-normal text-emerald-400">/ 块</span>
            </p>
          </div>
          <button onClick={onClose} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-500 active:scale-95">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 数量调节 */}
        <div className="mt-4 flex items-center justify-center gap-4">
          <button onClick={() => delta(-1)}
            className="flex h-11 w-11 items-center justify-center rounded-full bg-emerald-50 text-xl font-black text-emerald-600 active:scale-95">−</button>
          <p className="min-w-[5.5rem] text-center text-3xl font-black tabular-nums text-emerald-900">{n}<span className="ml-1 text-xs font-bold text-emerald-400">块</span></p>
          <button onClick={() => delta(1)}
            className="flex h-11 w-11 items-center justify-center rounded-full bg-emerald-50 text-xl font-black text-emerald-600 active:scale-95">+</button>
        </div>
        <div className="mt-3 flex justify-center gap-2">
          {[5, 10, 20, 50].map((c) => (
            <button key={c} onClick={() => setN(c)} disabled={c > cap}
              className="rounded-full bg-emerald-50 px-3.5 py-1.5 text-[11px] font-bold text-emerald-600 active:scale-95 disabled:opacity-30">
              ×{c}
            </button>
          ))}
        </div>

        {/* 合计 */}
        <div className="mt-4 flex items-center justify-between rounded-2xl bg-emerald-50/70 px-4 py-3">
          <p className="text-xs font-bold text-emerald-700">合计 {cost.toLocaleString()} 时元</p>
          <p className="text-[10px] tabular-nums text-emerald-400">{afford ? `可买 ${cap} 块` : '不够'}</p>
        </div>

        <button onClick={buyBatch} disabled={!afford}
          className={`mt-3 w-full rounded-full py-3 text-sm font-black text-white shadow-md transition-transform active:scale-95 disabled:opacity-40 ${
            afford ? 'bg-gradient-to-r from-emerald-500 to-teal-500 shadow-emerald-200' : 'bg-slate-400'
          }`}>
          {afford ? `购入 ${n} 块入库` : `时元不够 · 还差 ${(cost - balance).toLocaleString()}`}
        </button>
      </div>
    </div>
  );
}

/* ---------- 一键切石 · 汇总开奖 ---------- */
function BatchCutModal({ results, onClose }: {
  results: Array<CutResult & { stoneId: string; tierId: string }>; onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-6" onClick={onClose}>
      <div
        className="max-h-[78dvh] w-full max-w-sm overflow-y-auto rounded-3xl bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        style={{ animation: 'jade-pop .45s ease' }}
      >
        <p className="text-center text-base font-black tracking-widest text-emerald-800">⚡ 切石总结</p>
        <div className="mt-4 space-y-2">
          {results.map((r) => {
            const tier = STONE_TIERS.find((t) => t.id === r.tierId);
            if (r.waste) {
              return (
                <div key={r.stoneId} className="flex items-center gap-3 rounded-2xl bg-slate-50 p-3">
                  <span className="text-xl">💨</span>
                  <div className="min-w-0 flex-1 truncate text-xs text-slate-500">{tier?.name ?? '原石'}</div>
                  <span className="shrink-0 text-xs font-bold text-slate-400">什么都没有…</span>
                </div>
              );
            }
            const v = r.main ? varietyById(r.main.varietyId) : null;
            const st = v ? RARITY_STYLE[v.rarity] : null;
            return (
              <div key={r.stoneId} className="flex items-center gap-3 rounded-2xl bg-emerald-50/70 p-3">
                <ArtImg art={v ? JADE_ART[v.id] : undefined} emoji={v?.emoji ?? '💎'}
                  className="h-10 w-10 shrink-0 rounded-xl object-cover" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-bold" style={{ color: st?.color }}>{v?.name ?? '？'}</p>
                  <p className="truncate text-[10px] text-emerald-500">
                    {tier?.name} · {r.main?.grams ?? 0}g
                    {r.children.length > 0 && ` · 融合伴生 ${r.children.length} 块`}
                  </p>
                </div>
                <span className="shrink-0 text-[11px] font-bold text-amber-600">值 {(r.main?.value ?? 0).toLocaleString()}</span>
              </div>
            );
          })}
        </div>
        <button
          onClick={onClose}
          className="mt-5 w-full rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-500 py-3 text-sm font-bold text-white shadow-md shadow-emerald-200 active:scale-95"
        >
          好
        </button>
      </div>
    </div>
  );
}

/* ---------- 打磨切割小游戏 ---------- */
function CuttingView({ stoneId, who, onMsg, onDone, onCutDone, onForge }: {
  stoneId: string; who: string;
  onMsg: (m: string) => void; onDone: () => void;
  onCutDone: () => void;   // 切完一刻通知父级进入展示期（父级此期间不自动退回列表）
  onForge: (stoneId: string) => void;
}) {
  const stone = stonesOf(who).find((s) => s.id === stoneId);
  const tier = STONE_TIERS.find((t) => t.id === stone?.tierId);
  const [progress, setProgress] = useState(0);   // 取整 0-100：驱动进度条 + 切完判定（每帧 setState 会触发滚动锚定补偿，整页抖）
  const [holding, setHolding] = useState(false);
  const [inZone, setInZone] = useState(true);
  const [done, setDone] = useState(false);
  const [revealed, setRevealed] = useState<CutResult | null>(null); // 开奖快照：展示期以它为准
  const [showCard, setShowCard] = useState(false); // 展示时间结束才出操作卡
  const raf = useRef(0);
  const knobRef = useRef<HTMLDivElement>(null);
  const st = useRef({ pos: 50, progress: 0, holding: false });

  const setHold = (v: boolean) => { st.current.holding = v; setHolding(v); };

  // 进入打磨台即回顶：从列表中间进入时内容高度突变，浏览器保留原滚动位页面就会跳一下
  useEffect(() => { window.scrollTo({ top: 0 }); }, []);

  // 指针往返 + 按住打磨推进。
  // 2026-10-03 修「打磨时页面跳动」：指针每帧直接写 knob 的 style.left（不走 React setState），
  // 60fps 重渲染 + 进度条 width 过渡会触发浏览器滚动锚定补偿，整页跟着抖；
  // progress 取整后才 setState，一格一格走不影响手感
  useEffect(() => {
    let last = performance.now();
    const zone = tier?.zone ?? 30;
    const zoneStart = (100 - zone) / 2;
    let dir = 1;
    let shownProg = 0;
    let shownZone = true;
    const loop = (now: number) => {
      const dt = Math.min(50, now - last);
      last = now;
      const s = st.current;
      let p = s.pos + dir * dt * 0.045;
      if (p >= 100) { p = 100; dir = -1; }
      if (p <= 0) { p = 0; dir = 1; }
      s.pos = p;
      if (knobRef.current) knobRef.current.style.left = `calc(${p}% - 3px)`;
      const iz = p >= zoneStart && p <= zoneStart + zone;
      if (iz !== shownZone) { shownZone = iz; setInZone(iz); }
      let pr = s.progress;
      // 2026-10-03 提速：0.8 个来回切完——0.8×2 趟 × 绿区宽度(zone%) 的绿区接触 = 100%，
      // 指针速度 0.045%/ms，速率常数 = 100×0.045/(1.6×zone) = 2.8125/zone
      if (s.holding) pr = iz ? pr + dt * (2.8125 / zone) : pr - dt * 0.02;
      else pr = Math.max(0, pr - dt * 0.004);
      s.progress = pr;
      const ri = Math.min(100, Math.round(pr));
      if (ri !== shownProg) { shownProg = ri; setProgress(ri); }
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切完：揭开品种 + 定格快照 + 展示时间。开奖画面先停留 1.8s 再出操作卡，
  // 期间任何同步抖动/料子瞬断都不影响展示（渲染只认快照）
  useEffect(() => {
    if (progress >= 100 && !done) {
      setDone(true);
      cancelAnimationFrame(raf.current);
      setHold(false);
      window.scrollTo({ top: 0 }); // 开奖卡替换游戏区（高度不同），回顶保证完整看到开奖
      const cut = completeCut(who, stoneId);
      setRevealed(cut ?? (stone ? { main: { ...stone, status: stone.status === 'uncut' ? 'cut' : stone.status }, children: [] } : null));
      onCutDone();
      const t = setTimeout(() => setShowCard(true), 1800);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress]);

  // 开奖展示期：快照优先，stone 瞬断也继续展示
  const shown = revealed?.main ?? (stone && stone.status !== 'uncut' ? stone : null);
  const children = revealed?.children ?? [];

  // 星陨料·空芯开奖：什么都没有（不进 RevealCard，数据已结成 sold）
  if (shown?.void) {
    return (
      <div className="space-y-2">
        <style>{`@keyframes jade-pop { 0% { transform: scale(.55); opacity: 0; } 60% { transform: scale(1.08); opacity: 1; } 100% { transform: scale(1); } }`}</style>
        <div
          className="w-full overflow-hidden rounded-3xl bg-gradient-to-b from-slate-700 to-slate-900 p-6 text-center shadow-xl shadow-slate-300 ring-2 ring-slate-400"
          style={{ animation: 'jade-pop .5s ease' }}
        >
          <p className="text-xs font-bold tracking-[0.3em] text-slate-400">💨 切 开 了 💨</p>
          <div className="mx-auto mt-4 flex h-24 w-24 items-center justify-center rounded-full bg-slate-800 text-4xl ring-4 ring-slate-600">
            <span style={{ animation: 'jade-pop .6s ease' }}>💨</span>
          </div>
          <p className="mt-4 text-lg font-black tracking-widest text-slate-200">空空如也…</p>
        </div>
        <button onClick={onDone} className="w-full py-2 text-xs text-emerald-400 active:opacity-60">
          ⬅ 返回切割台
        </button>
      </div>
    );
  }

  if (shown) {
    const v = varietyById(shown.varietyId);
    const st = RARITY_STYLE[v.rarity];
    return (
      <div className="space-y-2">
        <style>{`@keyframes jade-pop { 0% { transform: scale(.55); opacity: 0; } 60% { transform: scale(1.08); opacity: 1; } 100% { transform: scale(1); } }`}</style>
        {!showCard && done ? (
          <button onClick={() => setShowCard(true)}
            className="relative w-full overflow-hidden rounded-3xl bg-white p-5 text-center shadow-xl shadow-emerald-200 ring-2 ring-emerald-300 active:scale-[0.99]">
            <p className="text-xs font-bold tracking-[0.3em] text-amber-500" style={{ animation: 'jade-pop .5s ease' }}>🎉 切 开 了 🎉</p>
            <p className="mt-2 text-[11px] font-bold tracking-widest" style={{ color: st.color }}>✦ {v.rarity} · {v.name} ✦</p>
            <ArtImg art={JADE_ART[v.id]} emoji={v.emoji}
              className="mx-auto mt-3 h-28 w-28 rounded-full object-cover shadow-inner ring-4"
              style={{ ['--tw-ring-color' as string]: v.color, animation: 'jade-pop .6s ease' }} />
            <p className="mt-3 flex items-center justify-center gap-1 text-[11px] text-emerald-500">
              <Scale className="h-3 w-3" /> 主料 {shown.grams ?? '—'} 克
            </p>
          </button>
        ) : (
          <RevealCard stone={shown} who={who} onMsg={onMsg} big onForge={onForge} />
        )}
        {children.length > 0 ? (
          <div className="rounded-2xl bg-white/85 p-3 shadow-md shadow-emerald-100">
            <p className="text-center text-[10px] font-bold tracking-[0.25em] text-emerald-500">
              {shown.tierId === 't5' && children.length >= 2
                ? `🌀 多玉融合：这块料还并出了 ${children.length} 块小料`
                : `💠 这块料还切出了 ${children.length} 块伴生小料`}
            </p>
            <div className="mt-2 flex flex-wrap justify-center gap-2">
              {children.map((c) => {
                const cv = varietyById(c.varietyId);
                const cst = RARITY_STYLE[cv.rarity];
                return (
                  <span key={c.id} className="flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[10px]"
                    style={{ animation: 'jade-pop .5s ease' }}>
                    <span>{cv.emoji}</span>
                    <span className="font-bold" style={{ color: cst.color }}>{cv.name}</span>
                    <span className="text-emerald-400">{c.grams}g</span>
                  </span>
                );
              })}
            </div>
          </div>
        ) : null}
        <button onClick={onDone} className="w-full py-2 text-xs text-emerald-400 active:opacity-60">
          ⬅ 返回切割台
        </button>
      </div>
    );
  }

  if (!stone || !tier) return null;

  const zoneStart = (100 - tier.zone) / 2;

  return (
    <div className="rounded-3xl bg-white p-5 shadow-xl shadow-emerald-100">
      <p className="text-center text-sm font-bold text-emerald-800">🪨 {tier.name} · 切割中</p>

      {/* 石头 + 锯片 */}
      <div className="relative mx-auto mt-5 h-36 w-36 overflow-hidden">
        <ArtImg art={STONE_ART[tier.id]} emoji="🪨"
          className="pointer-events-none absolute inset-0 h-full w-full rounded-[45%] object-cover shadow-inner"
          style={{ transform: `scale(${1 + progress / 400})` }} />
        <div className="pointer-events-none absolute left-1/2 top-0 z-10 h-full w-1 -translate-x-1/2 bg-rose-400/70 transition-opacity"
          style={{ opacity: progress > 5 ? 1 : 0.3 }} />
        {progress > 30 && (
          <span className="pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 text-4xl opacity-60">✨</span>
        )}
      </div>

      {/* 进度（2026-10-02 加粗，绿区占轨道一半后更好瞄；2026-10-03 去掉 width 过渡：每帧更新时过渡反而引发布局抖动） */}
      <div className="mt-5 h-5 overflow-hidden rounded-full bg-emerald-100">
        <div className="h-full rounded-full bg-gradient-to-r from-amber-400 to-rose-400"
          style={{ width: `${progress}%` }} />
      </div>

      {/* 指针轨道 */}
      <div className="relative mt-4 h-8 overflow-hidden rounded-full bg-slate-100">
        <div className="absolute top-0 h-full bg-emerald-300/70"
          style={{ left: `${zoneStart}%`, width: `${tier.zone}%` }} />
        <div ref={knobRef} className="absolute top-0 h-full w-1.5 rounded-full bg-rose-500 shadow"
          style={{ left: 'calc(50% - 3px)' }} />
      </div>

      <button
        onPointerDown={() => setHold(true)}
        onPointerUp={() => setHold(false)}
        onPointerLeave={() => setHold(false)}
        onPointerCancel={() => setHold(false)}
        className={`mt-5 w-full select-none rounded-2xl py-4 text-base font-bold text-white shadow-lg transition-colors active:scale-95 ${
          holding ? (inZone ? 'bg-emerald-500 shadow-emerald-200' : 'bg-rose-500 shadow-rose-200') : 'bg-slate-400 shadow-slate-200'
        }`}
        style={{ touchAction: 'none' }}>
        {holding ? (inZone ? '打磨中… 好手感！' : '⚠️ 偏了偏了，松手！') : '👆 按住打磨'}
      </button>
      <button onClick={onDone} className="mt-2 w-full py-2 text-xs text-emerald-400">
        先放回去，下次再切
      </button>
    </div>
  );
}

/* ---------- 开奖卡 ---------- */
function RevealCard({ stone, who, onMsg, big, onForge }: {
  stone: OwnedStone; who: string; onMsg: (m: string) => void; big?: boolean;
  onForge?: (stoneId: string) => void;
}) {
  const v = varietyById(stone.varietyId);
  const st = RARITY_STYLE[v.rarity];
  const [justCut] = useState(stone.status === 'cut');
  const [partial, setPartial] = useState(false);
  const [grams, setGrams] = useState('');

  const act = (fn: typeof sellStone) => {
    const r = fn(who, stone.id);
    onMsg(r.msg);
  };

  if (stone.status === 'sold') return (
    <div className="flex items-center gap-3 rounded-2xl bg-white/60 p-4 opacity-60">
      <span className="text-2xl">{v.emoji}</span>
      <p className="text-xs text-slate-500">{v.name} · 已卖出 +{stone.value.toLocaleString()} 时元</p>
    </div>
  );

  const craftable = stone.status === 'cut' && !!onForge;
  const price = sellPrice(stone);
  const totalG = stone.grams ?? 0;
  const hot = isHotSellable(stone.varietyId);
  const hotName = varietyById(hotVarietyOfDay()).name;

  return (
    <div className={`rounded-3xl bg-white p-5 text-center shadow-xl ${justCut && big ? 'shadow-emerald-200 ring-2 ring-emerald-300' : 'shadow-emerald-100'}`}>
      <p className="text-[11px] font-bold tracking-widest" style={{ color: st.color }}>
        ✦ {v.rarity} · {v.name} ✦
      </p>
      <ArtImg art={JADE_ART[v.id]} emoji={v.emoji}
        className="mx-auto mt-3 h-24 w-24 rounded-full object-cover shadow-inner ring-4"
        style={{ ['--tw-ring-color' as string]: v.color }} />
      <p className="mt-3 text-2xl font-black text-amber-600">{price.toLocaleString()} <span className="text-xs font-medium">时元</span></p>
      <p className="mt-1 flex items-center justify-center gap-1 text-[11px] text-emerald-500">
        <Scale className="h-3 w-3" />
        重 {stone.grams ?? '—'} 克
      </p>
      {/* 纯度：这颗玉的价格里，纯度占了大头（提纯能把它推到极限纯度） */}
      <div className="mx-auto mt-3 max-w-[220px]">
        <div className="mb-1 flex items-center justify-center gap-1.5">
          <PurityBadge purity={stone.purity ?? 0.5} goal={stone.goalPurity ?? GOAL_MIN} showGoal />
        </div>
        <PurityBar purity={stone.purity ?? 0.5} goal={stone.goalPurity ?? GOAL_MIN} size="lg" />
      </div>
      <div className={`mt-4 grid gap-3 ${craftable ? (hot ? 'grid-cols-3' : 'grid-cols-2') : hot ? 'grid-cols-2' : 'grid-cols-1'}`}>
        {hot && (
          <button onClick={() => act(sellStone)}
            className="rounded-2xl bg-gradient-to-r from-amber-400 to-orange-400 py-3 text-sm font-bold text-white shadow-md shadow-amber-200 active:scale-95">
            卖出 +{price.toLocaleString()}
          </button>
        )}
        <button onClick={() => act(keepStone)}
          className="rounded-2xl bg-gradient-to-r from-emerald-400 to-teal-400 py-3 text-sm font-bold text-white shadow-md shadow-emerald-200 active:scale-95">
          💎 收藏进柜
        </button>
        {craftable && (
          <button onClick={() => onForge!(stone.id)}
            className="rounded-2xl bg-gradient-to-r from-violet-400 to-fuchsia-400 py-3 text-sm font-bold text-white shadow-md shadow-violet-200 active:scale-95">
            🔧 送打磨
          </button>
        )}
      </div>
      {!hot && (
        <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-[10px] leading-relaxed text-amber-600">
          ⛔ 不是今日高价「{hotName}」，不能直接卖<br />只能送去「玉缘拍卖会」上拍
        </p>
      )}
      {/* 部分卖出：自由选克数（仅今日高价可卖） */}
      {hot && (!partial ? (
        <button onClick={() => setPartial(true)} className="mt-2 text-[11px] text-emerald-400 underline underline-offset-2 active:opacity-60">
          只卖一部分克数
        </button>
      ) : (
        <div className="mt-3 flex items-center gap-2 rounded-2xl bg-emerald-50/70 p-2.5">
          <input
            type="number" min={5} max={totalG - 1} value={grams}
            onChange={(e) => setGrams(e.target.value)}
            placeholder={`克数（共 ${totalG}g）`}
            className="h-9 min-w-0 flex-1 rounded-xl border border-emerald-100 bg-white px-3 text-sm text-emerald-800 outline-none placeholder:text-emerald-300 focus:border-amber-300" />
          <button
            onClick={() => {
              const g = Math.floor(Number(grams));
              if (!g || g < 5 || g >= totalG) { onMsg(`克数要在 5 ~ ${totalG - 1} 之间`); return; }
              const r = sellStone(who, stone.id, g);
              onMsg(r.msg);
              if (r.ok) { setPartial(false); setGrams(''); }
            }}
            className="shrink-0 rounded-xl bg-gradient-to-r from-amber-400 to-orange-400 px-3.5 py-2 text-xs font-bold text-white shadow active:scale-95">
            卖出这部分
          </button>
          <button onClick={() => { setPartial(false); setGrams(''); }}
            className="shrink-0 px-1 text-xs text-emerald-400">
            取消
          </button>
        </div>
      ))}
    </div>
  );
}


/* ---------- 玉砖熔铸：同种玉石凑满 1000g 铸一块，黄金铸金砖 ---------- */
function BrickForge({ who, onMsg }: { who: string; onMsg: (m: string) => void }) {
  const options = brickOptionsOf(who);
  const bricks = bricksOf(who);
  const totalG = options.reduce((a, o) => a + o.grams, 0);
  if (options.length === 0 && bricks.length === 0) {
    return (
      <div className="rounded-2xl bg-gradient-to-br from-amber-50 to-orange-50 p-4 shadow-md shadow-amber-100">
        <p className="text-xs font-bold text-amber-800">🧱 玉砖熔铸</p>
        <p className="mt-1.5 text-[10px] leading-relaxed text-amber-600">
          同种玉石凑满 {BRICK_GRAMS}g 才能开炉（碎料大料都行）· 切开的料会在下方按品种列出
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-2xl bg-gradient-to-br from-amber-50 to-orange-50 p-4 shadow-md shadow-amber-100">
      <div className="flex items-center justify-between">
        <p className="text-xs font-bold text-amber-800">🧱 玉砖熔铸 <span className="font-normal text-amber-500">（限同种玉石 · {BRICK_GRAMS}g/炉）</span></p>
        <p className="text-[10px] text-amber-500">库存 {bricks.length} 块</p>
      </div>
      <div className="mt-2 max-h-44 space-y-1.5 overflow-y-auto pr-0.5">
        {options.map((o) => {
          const v = varietyById(o.varietyId);
          const st = RARITY_STYLE[v.rarity];
          const enough = o.grams >= BRICK_GRAMS;
          return (
            <div key={o.varietyId} className="flex items-center gap-2 rounded-xl bg-white/80 px-2.5 py-1.5">
              <span className="text-base">{v.emoji}</span>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-bold" style={{ color: st.color }}>{v.name}</p>
                <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-amber-100">
                  <div className="h-full rounded-full bg-gradient-to-r from-amber-400 to-orange-400 transition-[width]"
                    style={{ width: `${Math.min(100, (o.grams / BRICK_GRAMS) * 100)}%` }} />
                </div>
              </div>
              <span className="shrink-0 text-[9px] tabular-nums text-amber-500">{o.grams}/{BRICK_GRAMS}g</span>
              <button
                onClick={() => { const r = forgeBrick(who, o.varietyId); onMsg(r.msg); }}
                disabled={!enough}
                className="shrink-0 rounded-full bg-gradient-to-r from-amber-500 to-orange-500 px-2.5 py-1 text-[10px] font-bold text-white shadow active:scale-95 disabled:opacity-35">
                {enough ? `铸${brickNameOf(o.varietyId)}` : '未够'}
              </button>
            </div>
          );
        })}
      </div>
      <p className="mt-1.5 text-[9px] leading-relaxed text-amber-500">
        共 {Math.floor(totalG)}g 料 · 低值碎料先进炉 · 铸成的砖在料单里，可上拍卖会（「玉砖大观」专场更抢手）
      </p>
      {bricks.length > 0 && (
        <div className="mt-2 space-y-1.5 border-t border-amber-200/60 pt-2">
          {bricks.slice(0, 3).map((b) => (
            <p key={b.id} className="flex items-center justify-between rounded-xl bg-white/70 px-3 py-1.5 text-[11px] text-amber-700">
              <span>{brickNameOf(b.varietyId)} · {b.grams}g</span>
              <span className="font-bold">值 {b.value.toLocaleString()} 时元</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- 收藏柜 · 点开查看某品种的每一颗 ---------- */
function KeptDetailModal({ who, varietyId, onClose, onForge, onPurify, onMsg }: {
  who: string; varietyId: string; onClose: () => void;
  onForge: (stoneId: string) => void; onPurify: (stoneId: string) => void;
  onMsg: (m: string) => void;
}) {
  const v = varietyById(varietyId);
  const st = RARITY_STYLE[v.rarity];
  const list = keptStonesOf(who, varietyId);
  const listSlice = useSlice(list.length);
  const totalG = list.reduce((a, s) => a + (s.grams ?? 0), 0);
  const totalValue = list.reduce((a, s) => a + sellPrice(s), 0);
  const hot = hotVarietyOfDay() === varietyId;
  const [partial, setPartial] = useState(false);
  const [grams, setGrams] = useState('');
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 backdrop-blur-sm" onClick={onClose}>
      <div className="max-h-[75dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <p className="text-sm font-bold" style={{ color: st.color }}>
            ✦ {v.rarity} · {v.name}
            {hot && <span className="ml-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] text-amber-700">今日高价×2</span>}
          </p>
          <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-50 text-emerald-500 active:scale-95">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 总克数 + 自定义数量卖出（仅今日高价可卖） */}
        <div className="mt-3 rounded-2xl bg-emerald-50/70 p-3">
          <div className="flex items-baseline justify-between">
            <p className="text-xs text-emerald-600">合计 <b className="text-base font-black text-emerald-800">{totalG}</b> 克 · {list.length} 颗</p>
            <p className="text-[11px] text-amber-600">值 <b className="font-black">{totalValue.toLocaleString()}</b> 时元</p>
          </div>
          {!hot ? (
            <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-[10px] leading-relaxed text-amber-600">
              ⛔ 不是今日高价，不能直接卖，只能送去「玉缘拍卖会」上拍
            </p>
          ) : partial ? (
            <div className="mt-2 flex items-center gap-2">
              <input
                type="number" min={5} max={totalG - 1} value={grams}
                onChange={(e) => setGrams(e.target.value)}
                placeholder={`想卖多少克？（最多 ${totalG - 1}g）`}
                className="h-9 min-w-0 flex-1 rounded-xl border border-emerald-100 bg-white px-3 text-sm text-emerald-800 outline-none placeholder:text-emerald-300 focus:border-amber-300" />
              <button
                onClick={() => {
                  const g = Math.floor(Number(grams));
                  if (!g || g < 5 || g >= totalG) { onMsg(`克数要在 5 ~ ${totalG - 1} 之间`); return; }
                  // 从克数最多的一颗开始逐颗扣，直到卖够 g 克
                  const sorted = [...list].sort((a, b) => (b.grams ?? 0) - (a.grams ?? 0));
                  let left = g;
                  for (const s of sorted) {
                    if (left <= 0) break;
                    const sellG = Math.min(left, (s.grams ?? 0));
                    if (sellG >= 5) {
                      const r = sellStone(who, s.id, sellG < (s.grams ?? 0) ? sellG : undefined);
                      if (r.ok) left -= sellG;
                    }
                  }
                  onMsg(left > 0 ? `卖出 ${g - left} 克，剩余部分不足 5 克未卖` : `已卖出 ${g} 克 ✅`);
                  setPartial(false); setGrams('');
                }}
                className="shrink-0 rounded-xl bg-gradient-to-r from-amber-400 to-orange-400 px-3 py-2 text-xs font-bold text-white shadow active:scale-95">
                卖出
              </button>
              <button onClick={() => { setPartial(false); setGrams(''); }} className="shrink-0 px-1 text-xs text-emerald-400">取消</button>
            </div>
          ) : (
            <button onClick={() => setPartial(true)}
              className="mt-2 w-full rounded-xl border border-emerald-200 bg-white py-2 text-xs font-bold text-emerald-600 active:scale-95">
              ✂️ 自定义数量卖出
            </button>
          )}
        </div>

        <div className="mt-3 space-y-2">
          {list.slice(0, listSlice.shown).map((s) => (
            <div key={s.id} className="flex items-center gap-3 rounded-2xl bg-emerald-50/60 p-3">
              <ArtImg art={JADE_ART[s.varietyId]} emoji={v.emoji} className="h-11 w-11 rounded-xl object-cover" />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1 text-xs font-bold text-emerald-800">
                  <Scale className="h-3 w-3 text-emerald-400" />
                  {s.grams ?? '—'} 克
                  <PurityBadge purity={s.purity ?? 0.5} goal={s.goalPurity ?? GOAL_MIN} />
                </p>
                <div className="mt-1 max-w-[140px]">
                  <PurityBar purity={s.purity ?? 0.5} goal={s.goalPurity ?? GOAL_MIN} />
                </div>
                <p className="mt-0.5 text-[10px] text-emerald-400">
                  料值 {s.value.toLocaleString()} 时元 · {new Date(s.cutTs ?? s.ts).toLocaleDateString('zh-CN')}
                </p>
              </div>
              <div className="flex shrink-0 flex-col gap-1">
                {!isMaxPurity(s) && (
                  <button onClick={() => onPurify(s.id)}
                    className="rounded-full bg-gradient-to-r from-teal-400 to-cyan-400 px-3 py-1.5 text-[11px] font-bold text-white shadow-md shadow-teal-200 active:scale-95">
                    🧪 提纯
                  </button>
                )}
                <button onClick={() => onForge(s.id)}
                  className="rounded-full bg-gradient-to-r from-violet-400 to-fuchsia-400 px-3 py-1.5 text-[11px] font-bold text-white shadow-md shadow-violet-200 active:scale-95">
                  🔧 打磨
                </button>
                {hot && (
                  <button onClick={() => onMsg(sellStone(who, s.id).msg)}
                    className="rounded-full bg-gradient-to-r from-amber-400 to-orange-400 px-3 py-1.5 text-[11px] font-bold text-white shadow-md shadow-amber-200 active:scale-95">
                    卖 {sellPrice(s).toLocaleString()}
                  </button>
                )}
              </div>
            </div>
          ))}
          <ListMoreBar shown={listSlice.shown} total={list.length}
            hasMore={listSlice.hasMore} onMore={listSlice.more}
            onAll={listSlice.all} onCollapse={listSlice.reset} label="颗" />
          {list.length === 0 && <p className="py-6 text-center text-xs text-emerald-400">柜子里还没有这个品种的料 💎</p>}
        </div>
      </div>
    </div>
  );
}

/* ---------- 玉器工坊：选料 → DIY → 开磨 → 成品柜 ---------- */
function ForgeView({ who, onMsg, selectedId, onSelect }: {
  who: string; onMsg: (m: string) => void;
  selectedId: string | null; onSelect: (id: string | null) => void;
}) {
  const [, tick] = useState(0);
  useEffect(() => subscribeJade(() => tick((t) => t + 1)), []);
  useEffect(() => subscribeProductArt(() => tick((t) => t + 1)), []);
  const [typeId, setTypeId] = useState('bangle');
  const [metalId, setMetalId] = useState('none');
  const [cordId, setCordId] = useState('red');
  const [engraving, setEngraving] = useState('');
  const [grinding, setGrinding] = useState(false);   // 开磨动画中
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<JadeProduct | null>(null);
  const [artBusy, setArtBusy] = useState<string | null>(null); // 正在生成 AI 图的成品 id
  const [artN, setArtN] = useState<Record<string, number>>({}); // 每件成品已换图次数（换场景用）
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const finishGuard = useRef(false); // 收尾只跑一次：setProgress 的 updater 必须纯净，副作用放 effect
  const diyRef = useRef<HTMLDivElement | null>(null);

  const materials = stonesOf(who).filter((s) => s.status === 'cut' || s.status === 'kept');
  const matSlice = useSlice(materials.length);
  const stone = materials.find((s) => s.id === selectedId) ?? null;
  const type = craftTypeById(typeId);
  const grams = stone?.grams ?? 0;
  // 只吃 useG 克，剩下的全是余料（克数/估值都留在料子上）
  const pv = stone ? craftPreview(stone, typeId, metalId) : null;
  const partner = partnerOf(who);
  const products = productsOf(who);
  const prodSlice = useSlice(products.length);
  const imageReady = isImageReady() && !isGuestSession();

  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  // 选中的料子被整块消耗/不存在时自动复位（有余料就继续留着选中）
  useEffect(() => {
    if (selectedId && !materials.some((s) => s.id === selectedId)) onSelect(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materials.length]);

  // 从开奖卡/收藏柜带着料子跳进工坊时，自动滚到 DIY 搭配区，不用自己翻
  useEffect(() => {
    if (!stone) return;
    const t = setTimeout(() => diyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  /** 生成/换一张 AI 成品图（每次换一套场景 = 换一张脸） */
  const makeArt = async (p: JadeProduct) => {
    if (artBusy) return;
    const n = (artN[p.id] ?? 0) + 1;
    setArtN((prev) => ({ ...prev, [p.id]: n }));
    setArtBusy(p.id);
    try {
      await generateProductArt(who, p, n);
      onMsg('AI 成品图出炉 🎨');
    } catch (e) {
      onMsg(e instanceof Error ? e.message : '生图失败，稍后再试');
    } finally {
      setArtBusy(null);
    }
  };

  const startGrind = () => {
    if (!stone || grinding) return;
    setGrinding(true);
    setProgress(0);
    finishGuard.current = false;
    timer.current = setInterval(() => {
      setProgress((p) => Math.min(100, p + 4));
    }, 80);
  };

  // 打磨收尾：进度到 100 才落库（updater 里做副作用会被 React 重放导致一件磨两件）
  useEffect(() => {
    if (!grinding || progress < 100 || finishGuard.current || !stone) return;
    finishGuard.current = true;
    if (timer.current) clearInterval(timer.current);
    const r = craftProduct(who, stone.id, {
      typeId, metalId, cordId: type.cord ? cordId : null, engraving,
    });
    onMsg(r.msg);
    setGrinding(false);
    if (r.ok && r.product) {
      setResult(r.product);
      setEngraving('');
      // 有余料就接着留在选中态，可以直接再磨一件；整块用完才取消选中
      const still = stonesOf(who).some(
        (s) => s.id === stone.id && (s.status === 'cut' || s.status === 'kept'),
      );
      if (!still) onSelect(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress, grinding]);

  /* 成品大图结果卡 */
  if (result) {
    const doneArt = productArt(result.id) ?? craftArt(result.typeId, result.varietyId, result.id);
    const busy = artBusy === result.id;
    return (
      <div className="space-y-3">
        <div className="rounded-3xl bg-white p-5 text-center shadow-xl shadow-violet-100 ring-2 ring-violet-200">
          <p className="text-[11px] font-bold tracking-widest text-violet-500">✦ 打磨完成 ✦</p>
          <ArtImg art={doneArt} emoji="💎"
            className="mx-auto mt-3 h-40 w-40 rounded-full object-cover shadow-inner ring-4"
            style={{ ['--tw-ring-color' as string]: varietyById(result.varietyId).color }} />
          <p className="mt-3 text-base font-black text-emerald-800">{result.name}</p>
          <p className="mt-1 flex items-center justify-center gap-2 text-[11px] text-emerald-500">
            <Scale className="h-3 w-3" /> 用料 {result.grams} 克
            <span className="text-amber-600">· 估值 {result.value.toLocaleString()} 时元</span>
          </p>
          {result.engraving && (
            <p className="mt-1 text-[11px] text-violet-400">内侧刻着「{result.engraving}」</p>
          )}
          {!imageReady ? null : (
            <button onClick={() => makeArt(result)} disabled={busy}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-violet-200 bg-violet-50 py-2.5 text-xs font-bold text-violet-600 transition-all active:scale-95 disabled:opacity-60">
              {busy ? '🎨 AI 作画中…' : productArt(result.id) ? '🎨 换一张 AI 成品图' : '🎨 AI 定制成品图'}
            </button>
          )}
          <button onClick={() => setResult(null)}
            className="mt-3 w-full rounded-2xl bg-gradient-to-r from-violet-400 to-fuchsia-400 py-3 text-sm font-bold text-white shadow-md shadow-violet-200 active:scale-95">
            再做一个
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* 第一步：选料 */}
      <p className="text-xs text-emerald-600">选一块切开的料子（只吃一件的用料，剩下的全是余料）</p>
      {materials.length === 0 && (
        <p className="py-10 text-center text-sm text-emerald-400">没有可打磨的料子<br />先去「切割台」开一块 🪨</p>
      )}
      {materials.slice(0, matSlice.shown).map((s) => {
        const v = varietyById(s.varietyId);
        const brick = isBrick(s);
        const active = s.id === selectedId;
        return (
          <button key={s.id} onClick={() => onSelect(active ? null : s.id)}
            className={`flex w-full items-center gap-3 rounded-2xl p-3 text-left shadow-md transition-all active:scale-[0.98] ${
              active ? 'bg-violet-50 ring-2 ring-violet-300' : 'bg-white shadow-emerald-100'
            }`}>
            <ArtImg art={JADE_ART[s.varietyId]} emoji={v.emoji} className="h-12 w-12 rounded-xl object-cover" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-emerald-900">
                {brick ? `${brickNameOf(s.varietyId)}（${v.name}底）` : v.name}
              </p>
              <p className="mt-0.5 flex items-center gap-1 text-[11px] text-emerald-500">
                <Scale className="h-3 w-3" />
                {s.grams ?? '—'} 克 · 料值 {s.value.toLocaleString()} 时元
                {s.status === 'kept' && <span className="text-violet-400">· 柜中</span>}
              </p>
              <p className="mt-0.5">
                <PurityBadge purity={s.purity ?? 0.5} goal={s.goalPurity ?? GOAL_MIN} />
              </p>
            </div>
            <span className={`text-[10px] font-bold ${active ? 'text-violet-500' : 'text-emerald-300'}`}>
              {active ? '已选' : '选用'}
            </span>
          </button>
        );
      })}
      <ListMoreBar shown={matSlice.shown} total={materials.length}
        hasMore={matSlice.hasMore} onMore={matSlice.more}
        onAll={matSlice.all} onCollapse={matSlice.reset} label="块料子" />

      {/* 玉砖熔铸：碎料大料凑满 1000g */}
      <BrickForge who={who} onMsg={onMsg} />

      {/* 第二步：DIY 搭配 */}
      {stone && (
        <div ref={diyRef} className="rounded-3xl bg-white p-4 shadow-md shadow-emerald-100">
          <p className="text-xs font-bold text-emerald-700">做什么器型？<span className="font-normal text-emerald-400">（{grams}g 可用，只吃一件的料）</span></p>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {CRAFT_TYPES.map((t) => {
              const ok = grams >= t.useG;
              const active = t.id === typeId;
              return (
                <button key={t.id} disabled={!ok} onClick={() => setTypeId(t.id)}
                  className={`flex flex-col items-center rounded-2xl border px-1 py-2 transition-all active:scale-95 ${
                    active ? 'border-violet-400 bg-violet-50' : 'border-emerald-100 bg-white'
                  } ${!ok ? 'opacity-40' : ''}`}>
                  <span className="text-lg">{t.emoji}</span>
                  <span className={`text-[11px] font-bold ${active ? 'text-violet-600' : 'text-emerald-800'}`}>{t.name}</span>
                  <span className="text-[9px] text-emerald-400">用 {t.useG}g</span>
                </button>
              );
            })}
          </div>

          <p className="mt-3 text-xs font-bold text-emerald-700">配件</p>
          <div className="mt-1.5 flex gap-2">
            {CRAFT_METALS.map((m) => (
              <button key={m.id} onClick={() => setMetalId(m.id)}
                className={`flex-1 rounded-full border py-1.5 text-[11px] font-bold transition-all active:scale-95 ${
                  m.id === metalId ? 'border-violet-400 bg-violet-50 text-violet-600' : 'border-emerald-100 text-emerald-700'
                }`}>
                {m.name}
              </button>
            ))}
          </div>

          {type.cord && (
            <>
              <p className="mt-3 text-xs font-bold text-emerald-700">绳链</p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {CRAFT_CORDS.map((c) => (
                  <button key={c.id} onClick={() => setCordId(c.id)}
                    className={`rounded-full border px-3 py-1.5 text-[11px] font-bold transition-all active:scale-95 ${
                      c.id === cordId ? 'border-violet-400 bg-violet-50 text-violet-600' : 'border-emerald-100 text-emerald-700'
                    }`}>
                    {c.name}
                  </button>
                ))}
              </div>
            </>
          )}

          <p className="mt-3 text-xs font-bold text-emerald-700">刻字（可选，6 字内）</p>
          <input value={engraving} onChange={(e) => setEngraving(e.target.value)} maxLength={6}
            placeholder="比如：平安 · 顺遂 · 有你"
            className="mt-1.5 h-10 w-full rounded-xl border border-emerald-100 bg-emerald-50/40 px-3 text-sm text-emerald-800 outline-none placeholder:text-emerald-300 focus:border-violet-300" />

          <button onClick={startGrind} disabled={grinding || !pv?.ok}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-violet-400 via-fuchsia-400 to-pink-400 py-3.5 text-sm font-bold tracking-widest text-white shadow-lg shadow-violet-200 transition-all active:scale-[0.98] disabled:opacity-60">
            <Hammer className="h-4 w-4" />
            {grinding
              ? `打磨中… ${progress}%`
              : pv?.ok
                ? `🔥 开磨（用 ${pv.useG}g · 预估 ${pv.value.toLocaleString()} 时元）`
                : `✗ ${pv?.reason ?? '料子不够'}`}
          </button>
          {grinding && (
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-violet-100">
              <div className="h-full rounded-full bg-gradient-to-r from-violet-400 to-fuchsia-400 transition-[width]"
                style={{ width: `${progress}%` }} />
            </div>
          )}

          {/* 余料：打完还剩多少、值多少、要不要直接卖（仅今日高价可卖） */}
          {pv && (
            <div className="mt-3 flex items-center justify-between gap-2 rounded-2xl bg-emerald-50/70 px-3 py-2.5">
              <p className="min-w-0 text-[11px] leading-snug text-emerald-600">
                {pv.ok ? <>用料 {pv.useG}g → <b className="text-emerald-700">余料 {pv.leftG}g</b></> : <>这块只剩 {grams}g</>}
                <span className="block text-[10px] text-emerald-400">
                  {isHotSellable(stone.varietyId)
                    ? `余料值 ${pv.leftValue.toLocaleString()} 时元 · 今日高价可直接卖`
                    : '非今日高价 · 只能送去拍卖会'}
                </span>
              </p>
              {isHotSellable(stone.varietyId) && (
                <button
                  onClick={() => { const r = sellStone(who, stone.id); onMsg(r.msg); }}
                  className="shrink-0 rounded-full bg-gradient-to-r from-amber-400 to-orange-400 px-3 py-1.5 text-[10px] font-bold text-white shadow active:scale-95">
                  卖掉 +{sellPrice(stone).toLocaleString()}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* 成品柜 */}
      <p className="pt-2 text-xs text-emerald-600">成品柜（{products.length} 件{partner ? ` · 可转赠 ${partner}` : ''}）</p>
      {products.length === 0 ? (
        <p className="py-8 text-center text-sm text-emerald-400">还没有成品<br />选块料子磨一件吧 🔧</p>
      ) : (
        <div className="grid grid-cols-2 gap-2.5">
          {products.slice(0, prodSlice.shown).map((p) => {
            const art = productArt(p.id) ?? craftArt(p.typeId, p.varietyId, p.id);
            const busy = artBusy === p.id;
            return (
              <div key={p.id} className="flex flex-col items-center rounded-2xl bg-white p-3 shadow-md shadow-emerald-100">
                <div className="relative">
                  <ArtImg art={art} emoji={craftTypeById(p.typeId).emoji}
                    className="h-20 w-20 rounded-full object-cover ring-2"
                    style={{ ['--tw-ring-color' as string]: varietyById(p.varietyId).color }} />
                  {p.art && (
                    <span className="absolute -right-1 -top-1 rounded-full bg-violet-500 px-1.5 py-0.5 text-[8px] font-black text-white shadow">AI</span>
                  )}
                </div>
                <p className="mt-1.5 w-full truncate text-center text-[11px] font-bold text-emerald-800">{p.name}</p>
                <p className="mt-0.5 flex items-center gap-1 text-[10px] text-emerald-400">
                  <Scale className="h-2.5 w-2.5" />
                  {p.grams}g · {p.value.toLocaleString()} 时元
                </p>
                {p.maker !== p.by && (
                  <p className="mt-0.5 text-[9px] text-pink-400">💝 {p.maker} 所赠</p>
                )}
                <div className="mt-2 flex w-full flex-wrap items-center justify-center gap-1.5">
                  {imageReady && p.by === who && (
                    <button onClick={() => makeArt(p)} disabled={busy}
                      className="flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-[10px] font-bold text-violet-600 active:scale-95 disabled:opacity-60">
                      🎨 {busy ? '作画中…' : p.art ? '换图' : 'AI 图'}
                    </button>
                  )}
                  {p.by === who && (
                    <button onClick={() => {
                      if (window.confirm(`把「${p.name}」熔回 ${p.grams} 克玉料吗？`)) {
                        const r = dissolveProduct(who, p.id);
                        onMsg(r.msg);
                      }
                    }}
                      className="flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[10px] font-bold text-amber-600 active:scale-95">
                      ♻️ 还原
                    </button>
                  )}
                  {partner && (
                    <button onClick={() => {
                      if (window.confirm(`把「${p.name}」赠给 ${partner} 吗？`)) {
                        const r = giftProduct(who, p.id);
                        onMsg(r.msg);
                      }
                    }}
                      className="flex items-center gap-1 rounded-full bg-gradient-to-r from-pink-400 to-rose-400 px-2.5 py-1 text-[10px] font-bold text-white shadow active:scale-95">
                      <Gift className="h-3 w-3" />
                      赠 {partner}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <ListMoreBar shown={prodSlice.shown} total={products.length}
        hasMore={prodSlice.hasMore} onMore={prodSlice.more}
        onAll={prodSlice.all} onCollapse={prodSlice.reset} label="件成品" />
    </div>
  );
}

/* ---------- 提纯工坊：投提纯剂把玉石纯度往上抬，直到极限纯度 ---------- */
/** 提纯剂合成配方 id 映射（与 lib/farm.ts 的 PURIFIER_RECIPES 对应，用于「去农场合成」引导） */
const PURIFIER_RECIPE: Record<Purifier['id'], string> = {
  basic: 'pz_basic', fine: 'pz_fine', supreme: 'pz_supreme',
};

function PurifyView({ who, onMsg, onOpenFarm, presetId, onPresetDone }: {
  who: string; onMsg: (m: string) => void;
  onOpenFarm?: () => void;
  /** 从收藏柜「提纯」按钮跳进来时预选的石头 id */
  presetId?: string | null;
  onPresetDone?: () => void;
}) {
  const [, tick] = useState(0);
  useEffect(() => subscribeJade(() => tick((t) => t + 1)), []);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickPurifier, setPickPurifier] = useState(PURIFIERS[0].id as Purifier['id']);
  const [busy, setBusy] = useState(false);          // 提纯动画中
  const [progress, setProgress] = useState(0);
  const [flash, setFlash] = useState<OwnedStone | null>(null); // 提纯后的大字反馈
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const finishGuard = useRef(false);

  const list = purifiablesOf(who);
  const listSlice = useSlice(list.length);
  const stone = list.find((s) => s.id === selectedId) ?? null;
  // 每种剂分别计数（提纯剂由农场合成，不再用时元买）
  const haveOf = (id: string) => reagentCountOf(who, id);
  const have = haveOf(pickPurifier);
  const totalHave = reagentCount(who);
  const pv = stone ? purifyPreview(stone, pickPurifier, have) : null;
  const purifier = purifierById(pickPurifier);

  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);
  // 从收藏柜「提纯」按钮跳进来：预选这颗石头并清掉预设标记
  useEffect(() => {
    if (presetId) { setSelectedId(presetId); setFlash(null); onPresetDone?.(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetId]);
  // 选中的石头被卖掉/打磨完就自动复位
  useEffect(() => {
    if (selectedId && !list.some((s) => s.id === selectedId)) setSelectedId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.length]);

  const start = () => {
    if (!stone || busy || !pv?.ok) return;
    if (have < pv.doses) { onMsg(`没有${purifier.name}了（一次要 ${pv.doses} 只，现有 ${have} 只）`); return; }
    finishGuard.current = false;
    setBusy(true);
    setProgress(0);
    timer.current = setInterval(() => setProgress((p) => Math.min(100, p + 5)), 60);
  };

  // 到 100 才真正落库（副作用放 effect，updater 保持纯净，避免重放导致投两份料）
  useEffect(() => {
    if (!busy || progress < 100 || finishGuard.current || !stone) return;
    finishGuard.current = true;
    if (timer.current) clearInterval(timer.current);
    const r = purifyStone(who, stone.id, pickPurifier);
    onMsg(r.msg);
    setBusy(false);
    if (r.ok && r.stone) setFlash(r.stone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress, busy]);

  return (
    <div className="space-y-3">
      {/* 库存 + 说明 */}
      <div className="rounded-2xl bg-gradient-to-r from-teal-500 to-cyan-500 px-4 py-3 shadow-md shadow-teal-200">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FlaskConical className="h-5 w-5 text-white" />
            <span className="text-sm font-bold text-white">提纯工坊</span>
          </div>
          <span className="rounded-full bg-white/25 px-2.5 py-1 text-xs font-black text-white">
            🧪 提纯剂 ×{totalHave}
          </span>
        </div>
        <p className="mt-1.5 text-[10px] leading-relaxed text-white/85">
          越高级的提纯剂抬得越多：<b className="text-white">草木 +5% / 寒泉 +12% / 龙涎 +25%</b>，
          每次固定耗 1 只 —— 龙涎最快（最多 4 只到顶），草木最肝但最好合。
          提纯剂不花时元 —— 去「农场 · 合成工坊」自己种出来配出来 🌱
        </p>
      </div>

      {flash && (
        <div className="rounded-2xl bg-white p-4 text-center shadow-lg shadow-teal-100 ring-2 ring-teal-200">
          <p className="text-[11px] font-bold tracking-widest text-teal-500">✦ 提 纯 完 成 ✦</p>
          <p className="mt-1 text-sm font-black text-emerald-800">{varietyById(flash.varietyId).name}</p>
          <div className="mx-auto mt-2 max-w-[240px]">
            <PurityBar purity={flash.purity ?? 0.5} goal={flash.goalPurity ?? GOAL_MIN} size="lg" />
          </div>
          <p className="mt-2 text-lg font-black text-amber-600">
            {((flash.purity ?? 0.5) * 100).toFixed(1)}%
            {isMaxPurity(flash) && <span className="ml-1 text-xs text-rose-500">绝顶！</span>}
          </p>
          <p className="mt-0.5 text-[11px] text-emerald-500">当前估值 {flash.value.toLocaleString()} 时元</p>
          <button onClick={() => setFlash(null)}
            className="mt-3 w-full rounded-2xl bg-gradient-to-r from-teal-400 to-cyan-400 py-2.5 text-xs font-bold text-white shadow active:scale-95">
            继续提纯 / 换一颗
          </button>
        </div>
      )}

      {/* 选料 */}
      <p className="text-xs text-emerald-600">选一颗要提纯的玉石（切割台 + 收藏柜里的都能提）</p>
      {list.length === 0 && (
        <p className="py-14 text-center text-sm text-emerald-400">
          没有可提纯的玉石<br />先去「切割台」开一块 🪨
        </p>
      )}
      {list.slice(0, listSlice.shown).map((s) => {
        const v = varietyById(s.varietyId);
        const active = s.id === selectedId;
        const maxed = isMaxPurity(s);
        return (
          <button key={s.id} onClick={() => { setSelectedId(active ? null : s.id); setFlash(null); }}
            className={`w-full rounded-2xl p-3 text-left shadow-md transition-all active:scale-[0.98] ${
              active ? 'bg-teal-50 ring-2 ring-teal-300' : 'bg-white shadow-emerald-100'
            }`}>
            <div className="flex items-center gap-3">
              <ArtImg art={JADE_ART[s.varietyId]} emoji={v.emoji} className="h-12 w-12 rounded-xl object-cover" />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 text-sm font-bold text-emerald-900">
                  {isBrick(s) ? `${brickNameOf(s.varietyId)}（${v.name}底）` : v.name}
                  {s.status === 'kept' && <span className="text-[9px] font-normal text-violet-400">柜中</span>}
                </p>
                <p className="mt-0.5 flex items-center gap-1 text-[11px] text-emerald-500">
                  <Scale className="h-3 w-3" />{s.grams ?? '—'} 克 · 料值 {s.value.toLocaleString()}
                </p>
              </div>
              <span className={`shrink-0 text-[10px] font-bold ${active ? 'text-teal-500' : 'text-emerald-300'}`}>
                {active ? '已选' : '选用'}
              </span>
            </div>
            <div className="mt-2">
              <div className="mb-1 flex items-center justify-between">
                <PurityBadge purity={s.purity ?? 0.5} goal={s.goalPurity ?? GOAL_MIN} showGoal />
                {maxed
                  ? <span className="text-[9px] font-bold text-rose-500">🔥 已达绝顶</span>
                  : <span className="text-[9px] text-emerald-400">顶到极限还能涨 {purityUpside(s).toLocaleString()}</span>}
              </div>
              <PurityBar purity={s.purity ?? 0.5} goal={s.goalPurity ?? GOAL_MIN} />
            </div>
          </button>
        );
      })}
      <ListMoreBar shown={listSlice.shown} total={list.length}
        hasMore={listSlice.hasMore} onMore={listSlice.more}
        onAll={listSlice.all} onCollapse={listSlice.reset} label="块可提纯" />

      {/* 提纯操作台 */}
      {stone && pv && (
        <div className="rounded-3xl bg-white p-4 shadow-md shadow-teal-100">
          <p className="text-xs font-bold text-emerald-700">
            选提纯剂 <span className="font-normal text-emerald-400">（一次固定耗 1 只）</span>
          </p>
          <div className="mt-2 space-y-2">
            {PURIFIERS.map((p) => {
              const preview = purifyPreview(stone, p.id, haveOf(p.id));
              const active = p.id === pickPurifier;
              const mine = haveOf(p.id);          // 我手上这种剂有几只
              const enough = mine >= preview.doses;
              return (
                <button key={p.id} onClick={() => setPickPurifier(p.id)}
                  className={`flex w-full items-center gap-2.5 rounded-2xl border p-2.5 text-left transition-all active:scale-[0.99] ${
                    active ? 'border-teal-400 bg-teal-50' : 'border-emerald-100 bg-white'
                  }`}>
                  <span className="text-xl">{p.emoji}</span>
                  <div className="min-w-0 flex-1">
                    <p className={`text-[11px] font-bold ${active ? 'text-teal-600' : 'text-emerald-800'}`}>
                      {p.name}
                      {!enough && <span className="ml-1 text-[9px] font-normal text-rose-400">库存 0</span>}
                    </p>
                    <p className="truncate text-[9px] text-emerald-400">{p.desc}</p>
                    <p className="mt-0.5 text-[9px] text-emerald-500">
                      <span className="font-bold text-teal-600">+{p.power}%</span>
                      {' · '}
                      {preview.maxed ? '已到顶' : `本次 ${(pv.purity * 100).toFixed(0)}%→${(preview.nextPurity * 100).toFixed(1)}%，再 ${preview.leftToMax} 只到顶`}
                      <span className="text-emerald-400"> · 现有 {mine} 只</span>
                    </p>
                  </div>
                  <span className="shrink-0 text-right">
                    <span className="block text-[11px] font-black text-teal-600">库存 {mine}</span>
                    <span className="block text-[9px] text-emerald-400">只</span>
                  </span>
                </button>
              );
            })}
          </div>

          {/* 去农场合成引导（提纯剂不再用时元购买） */}
          <div className="mt-3 rounded-2xl bg-teal-50/70 px-3 py-2.5">
            <p className="text-[11px] leading-snug text-teal-700">
              🌱 <b>{purifier.name}</b> 需要去农场合成
              <span className="block text-[10px] text-teal-500">
                现有 {have} 只 · 配方号 {PURIFIER_RECIPE[purifier.id]}
              </span>
            </p>
            <button onClick={() => onOpenFarm?.()}
              className="mt-2 w-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-500 px-3 py-1.5 text-[11px] font-bold text-white shadow active:scale-95">
              去农场 · 合成工坊炼制 →
            </button>
          </div>

          <button onClick={start} disabled={busy || !pv.ok || have < pv.doses}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-teal-400 via-cyan-400 to-sky-400 py-3.5 text-sm font-bold tracking-widest text-white shadow-lg shadow-teal-200 transition-all active:scale-[0.98] disabled:opacity-60">
            <Droplets className="h-4 w-4" />
            {busy ? `提纯中… ${progress}%`
              : pv.maxed ? '✗ 已达极限纯度'
              : have < pv.doses ? `✗ 没有${purifier.name}（去农场合成）`
              : `🔥 提纯一次 · 耗 1 只（+${pv.gainPct.toFixed(1)}% → ${(pv.nextPurity * 100).toFixed(1)}%）`}
          </button>
          {busy && (
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-teal-100">
              <div className="h-full rounded-full bg-gradient-to-r from-teal-400 to-cyan-400 transition-[width]"
                style={{ width: `${progress}%` }} />
            </div>
          )}

          {/* 本次提纯账目 */}
          <div className="mt-3 grid grid-cols-4 gap-1.5 rounded-2xl bg-emerald-50/70 p-3 text-center">
            <div>
              <p className="text-[10px] text-emerald-500">当前纯度</p>
              <p className="text-xs font-black text-emerald-800">{((pv.purity ?? 0.5) * 100).toFixed(1)}%</p>
            </div>
            <div>
              <p className="text-[10px] text-emerald-500">提纯后</p>
              <p className="text-xs font-black text-teal-700">{(pv.nextPurity * 100).toFixed(1)}%</p>
            </div>
            <div>
              <p className="text-[10px] text-emerald-500">估值变化</p>
              <p className="text-xs font-black text-amber-600">
                {pv.value.toLocaleString()} → {pv.nextValue.toLocaleString()}
              </p>
            </div>
            <div>
              <p className="text-[10px] text-emerald-500">还剩几只要顶</p>
              <p className="text-xs font-black text-teal-600">{pv.leftToMax} 只</p>
            </div>
          </div>
          <p className="mt-1.5 text-center text-[9px] leading-relaxed text-emerald-400">
            一炉提纯剂是好几轮作物换来的 —— 但一口「绝顶」的玉，价值是实打实的
          </p>
        </div>
      )}
    </div>
  );
}
