import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  CloudOff,
  Coins,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react'
import type { User } from './LoginPage'
import {
  CROPS,
  FISH,
  MAX_PLOTS,
  MAX_POND,
  UNLOCK_COST,
  WATER_COST,
  WATER_DAILY_MAX,
  LEVEL_NAMES,
  UPGRADE_COSTS,
  MAX_LEVEL,
  cropById,
  farmOf,
  fishById,
  harvest,
  harvestAll,
  harvestFish,
  itemInfo,
  plant,
  plantAll,
  steal,
  stockFish,
  stockAllFish,
  subscribeFarm,
  recipeById,
  rareId,
  rareFishById,
  RARE_FISH_SELL,
  sellRareFish,
  dexRewardOf,
  RECIPES,
  unlockPlot,
  unlockPond,
  upgradePlot,
  water,
  weatherToday,
  assertFarm,
  syncMyFarm,
  resyncFarm,
  fuseItems,
  plantFromSeed,
  dailyFusionRecipe,
  FUSION_RECIPE_REWARD,
  SEED_PRICE_MULT,
  stockRareFish,
  spinWheel,
  spinWheelMulti,
  WHEEL_COST,
  WHEEL_SLICES,
  anyFishById,
  RARE_FISH,
  seedId,
  fryId,
  type FarmOf,
  type HarvestGain,
  type FusionResult,
  type WheelPrize,
  curePest,
  helpWater,
} from '../lib/farm'
import { subscribeWallet, type WalletTx } from '../lib/wallet'
import { subscribeAsks, type AskItem } from '../lib/ask'
import { totalBalance } from '../lib/balance'
import { TILE_RECTS } from '../lib/tileRects'
import { POND_RECTS } from '../lib/pondRects'
import FishingModal from './FishingModal'
import WorkshopModal, { WorkshopRank } from './WorkshopModal'
import farmScene from '../assets/farm-scene-portrait.webp'
import { getPairMembers } from '../lib/space'
// 升级土地光晕颜色：[贴边亮光, 中层光, 外围大光晕]。用「描边 + 高斯模糊」让光聚集在土地边缘，
// 三层由亮到淡向外扩散，远处一眼就能看出这块地升级过
const LEVEL_GLOW_COLORS: Array<[string, string, string] | null> = [
  null,
  // 银白土地：亮白银光
  ['rgba(255,255,255,1)', 'rgba(196,207,228,0.9)', 'rgba(158,172,200,0.6)'],
  // 金土地：浓郁金光
  ['rgba(255,204,44,1)', 'rgba(246,164,8,0.9)', 'rgba(222,132,0,0.65)'],
  // 紫金土地：高贵紫光 + 淡淡金边
  ['rgba(192,92,255,1)', 'rgba(148,48,230,0.9)', 'rgba(226,164,64,0.6)'],
  // 青色土地：清透青碧光
  ['rgba(45,230,215,1)', 'rgba(16,185,170,0.9)', 'rgba(8,120,110,0.65)'],
  // 天蓝土地：梦幻天蓝光
  ['rgba(120,200,255,1)', 'rgba(70,150,255,0.9)', 'rgba(150,220,255,0.65)'],
]

// 当前数据空间的两个人
const getPairedUsers = (): string[] => getPairMembers()

// ===================== 场景坐标（竖屏 1024×1536） =====================
// 土地 20 块（行优先）：像素级颜色分割实测（src/lib/tileRects.ts），含 4px 出血
const tileRect = (i: number) => {
  const r = TILE_RECTS[i]
  return {
    left: `${r.left}%`,
    top: `${r.top}%`,
    width: `${r.width}%`,
    height: `${r.height}%`,
  }
}

// 鱼塘：20 个养殖位，水面边界像素级实测后均匀排布（src/lib/pondRects.ts）
const pondRect = (i: number) => {
  const r = POND_RECTS[i]
  return {
    left: `${r.left}%`,
    top: `${r.top}%`,
    width: `${r.width}%`,
    height: `${r.height}%`,
  }
}

// 场景里的功能热区
const ZONE_HOUSE = { left: '70%', top: '4%', width: '28%', height: '16%' } // 小房子 → 仓库
const ZONE_CAN = { left: '9%', top: '82%', width: '18%', height: '11%' } // 洒水桶 → 浇水模式
const ZONE_SHOVEL = { left: '52%', top: '83%', width: '14%', height: '11%' } // 锄头 → 一键操作
const ZONE_CAT = { left: '72%', top: '82%', width: '24%', height: '15%' } // 猫咪 → 去 TA 家

function leftText(ms: number): string {
  if (ms <= 0) return '熟'
  const h = Math.floor(ms / 3600_000)
  const m = Math.ceil((ms % 3600_000) / 60_000)
  return h > 0 ? `${h}h${m > 0 ? `${m}m` : ''}` : `${m}m`
}

// ===================== 选择器弹窗 =====================
function PickerModal({
  title,
  groups,
  neededLack,
  onPick,
  onClose,
}: {
  title: string
  groups: Array<{ group: string; items: Array<{ id: string; name: string; emoji: string; cost: number; extra?: string }> }>
  /** 追踪中的配方还缺的物品数量（已扣库存）：在选择卡片上显示 🎯 还缺 N */
  neededLack?: Map<string, number>
  onPick: (id: string) => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/55" onClick={onClose}>
      <div
        className="max-h-[72dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 pb-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <span className="text-sm font-bold tracking-widest text-[#c44d7d]">{title}</span>
          <button onClick={onClose} className="text-pink-300 active:text-pink-500">
            <X className="h-5 w-5" />
          </button>
        </div>
        {groups.map((g) => (
          <div key={g.group} className="mb-4">
            <p className="mb-2 text-xs font-semibold text-[#b0678c]">
              {g.group}（{g.items.length} 种）
            </p>
            <div className="grid grid-cols-4 gap-2">
              {g.items.map((it) => {
                const lack = neededLack?.get(it.id) ?? 0
                // 「种子×N / 鱼苗×N」这类非时元成本：一键种植时要让用户看清手上够种几株，
                // 所以按库存渲染（N=持有量），而不是写死 ×1。
                const isSeed = it.extra?.startsWith('种子') ?? false
                const isFry = it.extra?.startsWith('鱼苗') ?? false
                return (
                <button
                  key={it.id}
                  onClick={() => onPick(it.id)}
                  className="relative flex flex-col items-center gap-1 rounded-2xl border border-pink-100 bg-pink-50/50 px-1 py-2.5 transition-transform active:scale-95"
                >
                  {lack > 0 && (
                    <span className="absolute -top-1.5 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-pink-400 text-[9px] text-white shadow">
                      🎯
                    </span>
                  )}
                  <span className="text-2xl">{it.emoji}</span>
                  <span className="text-[11px] font-medium text-[#8a4a68]">{it.name}</span>
                  <span className={`text-[10px] font-bold ${isSeed || isFry ? 'text-emerald-600' : 'text-amber-500'}`}>
                    {isSeed ? `🌱 ${it.extra}` : isFry ? `🐟 ${it.extra}` : `${it.cost} 时元`}
                  </span>
                  {it.extra && !isSeed && !isFry && <span className="text-[9px] text-pink-300">{it.extra}</span>}
                  {lack > 0 && <span className="text-[9px] font-bold text-pink-400">还缺 {lack}</span>}
                </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ===================== 收获庆祝弹窗（屏幕居中，樱花飘落） =====================
function HarvestModal({ gains, onClose }: { gains: HarvestGain[]; onClose: () => void }) {
  const totalCoins = gains.reduce((s, g) => s + g.coins, 0)
  const best = Math.max(...gains.map((g) => Math.max(g.qtyCrit, g.coinCrit)))
  // 合并同种物品（一键收获时同种作物可能有多份）
  const merged: HarvestGain[] = []
  for (const g of gains) {
    const m = merged.find((x) => x.name === g.name)
    if (m) {
      m.qty += g.qty
      m.coins += g.coins
      m.qtyCrit = Math.max(m.qtyCrit, g.qtyCrit)
      m.coinCrit = Math.max(m.coinCrit, g.coinCrit)
    } else {
      merged.push({ ...g })
    }
  }
  const petals = ['🌸', '✨', '🌸', '💮', '🌸', '✨', '🌸', '💮', '🌸', '✨', '🌸', '💮']
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55" onClick={onClose}>
      {/* 樱花雨 */}
      {petals.map((p, i) => (
        <span
          key={i}
          className="pointer-events-none absolute top-[-8%] text-lg"
          style={{
            left: `${6 + i * 8}%`,
            animation: `harvestFall ${2.6 + (i % 4) * 0.7}s linear ${(i % 5) * 0.4}s infinite`,
          }}
        >
          {p}
        </span>
      ))}
      <div
        className="w-[86%] max-w-sm rounded-3xl bg-gradient-to-b from-amber-50 to-orange-50 p-5 pb-6 text-center shadow-2xl"
        style={{ animation: 'harvestPop 0.45s cubic-bezier(0.34, 1.56, 0.64, 1)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-2xl font-black tracking-widest text-amber-500" style={{ textShadow: '0 2px 0 rgba(255,255,255,0.8)' }}>
          🎉 大丰收 🎉
        </p>
        {best > 1 && (
          <p className="mt-1 inline-block rounded-full bg-gradient-to-r from-rose-400 to-orange-400 px-3 py-0.5 text-[11px] font-bold text-white shadow">
            暴击 x{best}！欧气爆棚
          </p>
        )}
        <div className="mt-4 grid grid-cols-3 gap-2">
          {merged.map((g) => {
            const isRare = g.name.startsWith('仙品·')
            return (
              <div
                key={g.name}
                className={`relative flex flex-col items-center gap-0.5 rounded-2xl px-1 py-2.5 shadow-sm ${
                  isRare
                    ? 'border-2 border-yellow-400 bg-gradient-to-b from-yellow-50 to-amber-100'
                    : 'border border-amber-200/70 bg-white/80'
                }`}
              >
                {isRare && (
                  <span className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-full bg-gradient-to-r from-yellow-400 to-amber-500 px-2 py-px text-[9px] font-black text-white shadow">
                    ✨仙品
                  </span>
                )}
                <span className="text-3xl">{g.emoji}</span>
                <span className={`text-[11px] font-semibold ${isRare ? 'text-amber-700' : 'text-[#8a4a68]'}`}>{g.name}</span>
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-600">×{g.qty}</span>
                {g.coins > 0 && <span className="text-[10px] font-bold text-orange-500">+{g.coins} 时元</span>}
                {(g.qtyCrit > 1 || g.coinCrit > 1) && (
                  <span className="absolute -top-1.5 -right-1 rounded-full bg-rose-400 px-1.5 py-px text-[9px] font-black text-white shadow">
                    x{Math.max(g.qtyCrit, g.coinCrit)}
                  </span>
                )}
              </div>
            )
          })}
        </div>
        <p className="mt-4 text-sm font-bold text-amber-600">
          共收获 {merged.reduce((s, g) => s + g.qty, 0)} 份 · <Coins className="inline h-3.5 w-3.5 -translate-y-px" /> +{totalCoins} 时元
        </p>
        <button
          onClick={onClose}
          className="mt-4 w-full rounded-2xl bg-gradient-to-r from-amber-400 to-orange-400 py-2.5 text-sm font-bold text-white shadow-lg shadow-amber-200 transition-transform active:scale-95"
        >
          收进仓库 🧺
        </button>
      </div>
    </div>
  )
}

// ===================== 图鉴弹窗 =====================
const DEX_TABS = [
  { key: 'crop', label: '🌱 作物', ids: CROPS.map((c) => c.id) },
  { key: 'fish', label: '🐟 水产', ids: FISH.map((f) => f.id) },
  { key: 'rare', label: '✨ 仙品', ids: CROPS.map((c) => rareId(c.id)) },
  { key: 'recipe', label: '⚗️ 合成', ids: RECIPES.map((r) => r.id) },
] as const

function DexModal({ farm, onClose }: { farm: FarmOf; onClose: () => void }) {
  const dex = useMemo(() => new Set(farm.dex ?? []), [farm.dex])
  const [tab, setTab] = useState<(typeof DEX_TABS)[number]['key']>('crop')
  const cur = DEX_TABS.find((t) => t.key === tab)!
  const totalAll = DEX_TABS.reduce((s, t) => s + t.ids.length, 0)
  const unlockedAll = DEX_TABS.reduce((s, t) => s + t.ids.filter((id) => dex.has(id)).length, 0)
  const earned = [...dex].reduce((s, id) => s + dexRewardOf(id), 0)
  return (
    <div className="fixed inset-0 z-[75] flex items-end justify-center bg-black/50" onClick={onClose}>
      <div
        className="flex max-h-[82dvh] w-full max-w-md flex-col rounded-t-3xl bg-white p-5 pb-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-bold tracking-widest text-[#c44d7d]">📖 农场图鉴</span>
          <button onClick={onClose} className="text-pink-300 active:text-pink-500">
            <X className="h-5 w-5" />
          </button>
        </div>
        {/* 总进度 */}
        <div className="mb-3 rounded-2xl bg-gradient-to-r from-pink-50 to-amber-50 p-3">
          <div className="flex items-center justify-between text-[11px] font-bold text-[#8a4a68]">
            <span>收集进度 {unlockedAll}/{totalAll}</span>
            <span className="text-amber-600">图鉴奖励已赚 {earned} 时元</span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-white/80">
            <div
              className="h-full rounded-full bg-gradient-to-r from-pink-400 to-amber-400 transition-all"
              style={{ width: `${totalAll ? (unlockedAll / totalAll) * 100 : 0}%` }}
            />
          </div>
        </div>
        {/* 分类页签 */}
        <div className="mb-3 grid grid-cols-4 gap-1.5">
          {DEX_TABS.map((t) => {
            const n = t.ids.filter((id) => dex.has(id)).length
            const active = tab === t.key
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`rounded-xl py-1.5 text-[11px] font-bold transition-all ${active ? 'text-white shadow' : 'bg-pink-50 text-[#b0678c]'}`}
                style={active ? { background: 'linear-gradient(135deg,#e0487f,#c44d7d)' } : undefined}
              >
                {t.label}
                <span className="block text-[9px] font-medium opacity-80">{n}/{t.ids.length}</span>
              </button>
            )
          })}
        </div>
        {/* 图鉴网格 */}
        <div className="grid flex-1 grid-cols-4 gap-2 overflow-y-auto pb-2">
          {cur.ids.map((id) => {
            const has = dex.has(id)
            const info = itemInfo(id)
            return (
              <div
                key={id}
                className={`flex flex-col items-center gap-1 rounded-2xl px-1 py-2.5 ${
                  has
                    ? tab === 'rare'
                      ? 'border-2 border-yellow-300 bg-gradient-to-b from-yellow-50 to-amber-50'
                      : 'border border-pink-100 bg-pink-50/60'
                    : 'border border-gray-100 bg-gray-50/80'
                }`}
              >
                <span className={`text-2xl ${has ? '' : 'opacity-25 grayscale'}`}>{has ? info.emoji : '❓'}</span>
                <span className={`text-center text-[10px] leading-tight ${has ? 'font-medium text-[#8a4a68]' : 'text-gray-300'}`}>
                  {has ? info.name : '？？？'}
                </span>
                {has && (
                  <span className="rounded-full bg-amber-100 px-1.5 py-px text-[9px] font-bold text-amber-600">
                    +{dexRewardOf(id)}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ===================== 仓库弹窗（含合成工坊/风云榜入口） =====================
function WarehouseModal({
  farm,
  partnerFarm,
  who,
  partner,
  onOpenWorkshop,
  onOpenDex,
  onOpenFusion,
  onToast,
  onClose,
}: {
  farm: FarmOf
  partnerFarm: FarmOf
  who: string
  partner: string
  onOpenWorkshop: () => void
  onOpenDex: () => void
  onOpenFusion: () => void
  onToast: (msg: string) => void
  onClose: () => void
}) {
  const [showRank, setShowRank] = useState(false)
  const entries = Object.entries(farm.warehouse).filter(([, q]) => q > 0)
  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/55" onClick={onClose}>
      <div
        className="max-h-[78dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 pb-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <span className="text-sm font-bold tracking-widest text-[#c44d7d]">
            🏠 {showRank ? '工坊风云榜' : '我的仓库'}
          </span>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowRank(!showRank)}
              className={`text-xs font-bold transition-colors ${showRank ? 'text-amber-600' : 'text-amber-500'} active:text-amber-600`}
            >
              🏅 风云榜
            </button>
            <button onClick={onOpenDex} className="text-xs font-bold text-amber-500 active:text-amber-600">
              📖 图鉴
            </button>
            <button onClick={onClose} className="text-pink-300 active:text-pink-500">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
        
        {/* 合成工坊和大融合按钮移到顶部 */}
        <div className="mb-4 grid grid-cols-2 gap-3">
          <button
            onClick={onOpenWorkshop}
            className="rounded-2xl bg-gradient-to-r from-fuchsia-400 to-purple-400 py-3 text-sm font-semibold text-white shadow-lg shadow-fuchsia-200 transition-transform active:scale-95"
          >
            ⚗️ 合成工坊 · {RECIPES.length} 种配方
          </button>
          <button
            onClick={onOpenFusion}
            className="rounded-2xl bg-gradient-to-r from-indigo-500 via-purple-500 to-fuchsia-500 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-200 transition-transform active:scale-95"
          >
            🔥 大融合 · 100 个单位换神秘种子
          </button>
        </div>
        
        {showRank ? (
          <WorkshopRank mine={farm} theirs={partnerFarm} who={who} partner={partner} />
        ) : (
          <>
            {entries.length === 0 ? (
              <p className="py-10 text-center text-xs text-pink-300">仓库空空如也，快去种菜收菜吧 🌱</p>
            ) : (
              <div className="grid grid-cols-4 gap-2">
                {entries.map(([id, qty]) => {
                  const info = itemInfo(id)
                  const rf = rareFishById(id)
                  if (rf) {
                    // 稀有鱼：点按出售换时元
                    const price = RARE_FISH_SELL[id] ?? 150
                    return (
                      <button
                        key={id}
                        onClick={() => {
                          if (window.confirm(`出售 1 只 ${rf.emoji}${rf.name}？\n+${price} 时元（还剩 ${qty - 1} 只）`)) {
                            onToast(sellRareFish(who, id, 1).msg)
                          }
                        }}
                        className="relative flex flex-col items-center gap-1 rounded-2xl border border-amber-300 bg-gradient-to-b from-amber-50 to-yellow-50 px-1 py-2.5 shadow-sm transition-transform active:scale-95"
                      >
                        <span className="text-2xl">{info.emoji}</span>
                        <span className="text-[11px] font-medium text-[#8a4a68]">{info.name}</span>
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-600">×{qty}</span>
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[9px] font-bold text-emerald-600">售 {price}</span>
                      </button>
                    )
                  }
                  return (
                    <div
                      key={id}
                      className="flex flex-col items-center gap-1 rounded-2xl border border-amber-100 bg-amber-50/60 px-1 py-2.5"
                    >
                      <span className="text-2xl">{info.emoji}</span>
                      <span className="text-[11px] font-medium text-[#8a4a68]">{info.name}</span>
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-600">×{qty}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ===================== 大融合弹窗 =====================
function FusionModal({
  farm,
  who,
  onToast,
  onClose,
}: {
  farm: FarmOf
  who: string
  onToast: (msg: string) => void
  onClose: () => void
}) {
  const [pot, setPot] = useState<Record<string, number>>({})
  const [result, setResult] = useState<FusionResult | null>(null)
  const [fusing, setFusing] = useState(false)
  const recipe = useMemo(() => dailyFusionRecipe(), [])
  const recipeMap = useMemo(() => new Map(recipe), [recipe])
  const options = Object.entries(farm.warehouse)
    .filter(([, n]) => n > 0)
    .map(([id, n]) => ({ id, n, info: itemInfo(id) }))
    .sort((a, b) => b.n - a.n)
  const total = Object.values(pot).reduce((s, n) => s + n, 0)
  // 是否已恰好命中配方
  const matchedNow = useMemo(() => {
    const keys = Object.keys(pot).filter((id) => (pot[id] ?? 0) > 0)
    if (keys.length !== recipe.length) return false
    return recipe.every(([id, qty]) => (pot[id] ?? 0) === qty)
  }, [pot, recipe])

  const change = (id: string, delta: number, max: number) => {
    setPot((p) => {
      const cur = p[id] ?? 0
      const next = { ...p, [id]: Math.max(0, Math.min(max, cur + delta)) }
      if (next[id] <= 0) delete next[id]
      return next
    })
  }

  const fillRecipe = () => setPot(Object.fromEntries(recipe))

  const doFuse = () => {
    if (total === 0 || fusing) return
    setFusing(true)
    setResult(null)
    setTimeout(() => {
      const r = fuseItems(who, pot)
      setFusing(false)
      if (r.ok && r.result) {
        setResult(r.result)
        setPot({})
      } else onToast(r.msg)
    }, 700)
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/70" onClick={onClose}>
      <div
        className="max-h-[86dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-gradient-to-b from-[#1b1035] via-[#2a1a4d] to-[#120b24] p-5 pb-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <span className="text-sm font-bold tracking-widest text-amber-200">🔥 大融合</span>
          <button onClick={onClose} className="text-purple-300 active:text-purple-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* 今日配方 */}
        <div className="mb-4 rounded-2xl bg-gradient-to-br from-amber-400/15 to-fuchsia-500/15 p-3 ring-1 ring-amber-300/30">
          <p className="mb-2 text-center text-[11px] font-bold text-amber-200">📜 今日配方 · 集齐可 100% 得 {FUSION_RECIPE_REWARD} 个特殊种子</p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {recipe.map(([id, qty], i) => {
              const info = itemInfo(id)
              const have = farm.warehouse[id] ?? 0
              const inPot = pot[id] ?? 0
              return (
                <span key={id} className="flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[11px] text-purple-50 ring-1 ring-white/20">
                  {i > 0 && <span className="text-purple-300">+</span>}
                  <span className="text-base">{info.emoji}</span>
                  <span className="font-bold">{info.name}×{qty}</span>
                  <span className={`text-[9px] ${inPot === qty ? 'text-emerald-300' : have >= qty ? 'text-purple-300' : 'text-rose-300'}`}>
                    {inPot === qty ? '✓' : `${have}/${qty}`}
                  </span>
                </span>
              )
            })}
          </div>
          <button
            onClick={fillRecipe}
            className="mt-2.5 w-full rounded-xl bg-gradient-to-r from-amber-400 to-orange-400 py-2 text-xs font-bold text-white shadow active:scale-95"
          >
            ⚡ 一键按配方放入
          </button>
        </div>

        {result ? (
          <div className="mb-4 rounded-3xl bg-white/5 p-5 text-center ring-1 ring-amber-200/30">
            <p className="text-2xl">{result.matchedRecipe ? '🌟' : '🎁'}</p>
            <p className="mt-1 text-sm font-black text-amber-100">{result.matchedRecipe ? '命中配方！' : '融合完成'}</p>
            {result.matchedRecipe && <p className="mt-1 text-[11px] font-bold text-emerald-300">100% 爆出 {FUSION_RECIPE_REWARD} 个特殊种子！</p>}
            {!result.matchedRecipe && <p className="mt-1 text-[11px] font-bold text-purple-300">未命中配方，只出了普通种子/鱼苗</p>}
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              {result.gained.map((g) => (
                <div key={g.id} className="flex items-center gap-1 rounded-full bg-white/10 px-3 py-1.5 text-xs text-purple-50 ring-1 ring-white/20">
                  <span className="text-lg">{g.emoji}</span>
                  <span className="font-bold">
                    {g.name}×{g.qty}
                  </span>
                </div>
              ))}
            </div>
            <button
              onClick={() => setResult(null)}
              className="mt-4 rounded-full bg-gradient-to-r from-amber-400 to-orange-400 px-6 py-2 text-xs font-bold text-white shadow active:scale-95"
            >
              再融合一次
            </button>
          </div>
        ) : (
          <>
            {options.length === 0 ? (
              <p className="py-10 text-center text-xs text-purple-400">仓库空空如也，先去收点东西吧</p>
            ) : (
              <div className="mb-3 grid max-h-52 grid-cols-2 gap-2 overflow-y-auto">
                {options.map((o) => {
                  const inPot = pot[o.id] ?? 0
                  const isRecipeItem = recipeMap.has(o.id)
                  return (
                    <div
                      key={o.id}
                      className={`flex items-center gap-2 rounded-2xl px-2.5 py-2 ring-1 transition-all ${
                        inPot > 0 ? 'bg-purple-500/30 ring-2 ring-amber-300' : 'bg-white/5 ring-white/10'
                      }`}
                    >
                      <span className="text-xl">{o.info.emoji}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[10px] font-medium text-purple-100">
                          {isRecipeItem && '📜'}{o.info.name}
                        </p>
                        <p className="text-[9px] text-purple-300">有 {o.n}</p>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => change(o.id, -1, o.n)}
                          disabled={inPot <= 0}
                          className="h-6 w-6 rounded-full bg-white/10 text-sm font-bold text-purple-200 disabled:opacity-30"
                        >
                          −
                        </button>
                        <input
                          type="number"
                          min={0}
                          max={o.n}
                          value={inPot}
                          onChange={(e) => {
                            const val = parseInt(e.target.value, 10)
                            if (!isNaN(val)) {
                              setPot((p) => {
                                const next = { ...p, [o.id]: Math.max(0, Math.min(o.n, val)) }
                                if (next[o.id] <= 0) delete next[o.id]
                                return next
                              })
                            }
                          }}
                          className="h-6 w-10 rounded-lg bg-white/10 text-center text-xs font-bold text-purple-100 ring-1 ring-white/20 focus:outline-none focus:ring-2 focus:ring-amber-300 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        <button
                          onClick={() => change(o.id, 1, o.n)}
                          disabled={inPot >= o.n}
                          className="h-6 w-6 rounded-full bg-amber-400 text-sm font-bold text-white disabled:opacity-30"
                        >
                          +
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            <div className="mb-3 flex items-center justify-between rounded-2xl bg-white/5 px-4 py-2.5 ring-1 ring-white/10">
              <span className="text-xs font-bold text-purple-50">已投入 {total} 个</span>
              <span className={`text-xs font-bold ${matchedNow ? 'text-emerald-300' : 'text-amber-200'}`}>
                {matchedNow ? '✓ 已命中配方' : '未命中配方'}
              </span>
            </div>
            <button
              onClick={doFuse}
              disabled={total === 0 || fusing}
              className={`w-full rounded-2xl py-4 text-sm font-bold text-white shadow-lg transition-all ${
                total > 0 && !fusing
                  ? matchedNow
                    ? 'bg-gradient-to-r from-emerald-400 via-teal-400 to-cyan-400 shadow-emerald-500/30 active:scale-95'
                    : 'bg-gradient-to-r from-amber-400 via-orange-400 to-rose-400 shadow-orange-500/30 active:scale-95'
                  : 'bg-white/10 text-purple-400'
              }`}
            >
              {fusing ? '🔥 熔炼中…' : matchedNow ? '🔥 融合（必得特殊种子）' : '🔥 开始融合'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// ===================== 农场转盘弹窗 =====================
const WHEEL_COLORS = ['#fda4af', '#fcd34d', '#6ee7b7', '#93c5fd', '#c4b5fd', '#f9a8d4', '#67e8f9', '#fdba74']

function FarmWheelModal({
  who,
  balance,
  onToast,
  onClose,
}: {
  who: string
  balance: number
  onToast: (msg: string) => void
  onClose: () => void
}) {
  const [rotation, setRotation] = useState(0)
  const [spinning, setSpinning] = useState(false)
  const [prize, setPrize] = useState<WheelPrize | null>(null)
  const [multi, setMulti] = useState<WheelPrize[] | null>(null)

  // 盘面 8 等分、纯装饰（不体现概率）：实际中奖由 farm.ts 的 rollWheelSlice 决定，
  // 单抽时转盘转到对应奖区，十连抽随机落点、结果在下方网格展示
  const segs = WHEEL_SLICES.map((s, i) => ({
    ...s,
    start: (i * 360) / WHEEL_SLICES.length,
    end: ((i + 1) * 360) / WHEEL_SLICES.length,
    color: WHEEL_COLORS[i % WHEEL_COLORS.length],
  }))
  const gradient = `conic-gradient(${segs.map((s) => `${s.color} ${s.start}deg ${s.end}deg`).join(', ')})`

  const draw = (times: number) => {
    if (spinning) return
    setPrize(null)
    setMulti(null)
    if (times === 1) {
      const r = spinWheel(who, balance)
      if (!r.ok) {
        onToast(r.msg)
        return
      }
      const segIndex = Math.max(
        0,
        segs.findIndex((s) => (r.prize.type === 'coins' ? s.type === 'coins' && s.coins === r.prize.coins : s.type === r.prize.type)),
      )
      const seg = segs[segIndex]
      const center = (seg.start + seg.end) / 2
      const current = rotation % 360
      const delta = ((360 - center - current) % 360 + 360) % 360
      setSpinning(true)
      setRotation(rotation + 360 * 6 + delta)
      setTimeout(() => {
        setSpinning(false)
        setPrize(r.prize)
        onToast(r.msg)
      }, 4300)
    } else {
      const r = spinWheelMulti(who, balance, times)
      if (!r.ok) {
        onToast(r.msg)
        return
      }
      setSpinning(true)
      setRotation(rotation + 360 * 6 + Math.floor(Math.random() * 360))
      setTimeout(() => {
        setSpinning(false)
        setMulti(r.prizes)
        onToast(r.msg)
      }, 4300)
    }
  }

  const shortLabel = (s: (typeof segs)[number]): string => {
    if (s.type === 'coins') return '时元奖'
    if (s.type === 'thanks') return '下次好运'
    if (s.type === 'seed') return '神秘种子'
    if (s.type === 'again') return '再来一次'
    return '升级券'
  }

  return (
    <div className="fixed inset-0 z-[82] flex items-end justify-center bg-black/75" onClick={onClose}>
      <div
        className="max-h-[88dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-gradient-to-b from-[#241a38] via-[#2e1f47] to-[#1b1229] p-5 pb-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <span className="text-sm font-bold tracking-widest text-amber-200">🎡 幸运大转盘</span>
          <button onClick={onClose} className="text-purple-300 active:text-purple-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* 转盘 */}
        <div className="relative mx-auto mb-4 h-72 w-72">
          {/* 指针 */}
          <div className="absolute left-1/2 top-[-8px] z-30 -translate-x-1/2 text-4xl drop-shadow-[0_2px_6px_rgba(0,0,0,0.7)]">🔻</div>
          {/* 外圈金环 + 呼吸光晕 */}
          <div className="absolute -inset-1 animate-pulse rounded-full ring-4 ring-amber-300/70 shadow-[0_0_45px_rgba(251,191,36,0.55)]" />
          {/* 外圈灯珠 */}
          {Array.from({ length: 16 }).map((_, i) => {
            const a = (i / 16) * 360
            const rad = (a * Math.PI) / 180
            return (
              <span
                key={i}
                className="pointer-events-none absolute z-20 h-2 w-2 rounded-full bg-amber-200 shadow-[0_0_6px_rgba(251,191,36,0.9)]"
                style={{ left: 144 + 142 * Math.sin(rad) - 4, top: 144 - 142 * Math.cos(rad) - 4 }}
              />
            )
          })}
          {/* 轮盘 */}
          <div
            className="absolute inset-2 rounded-full"
            style={{
              background: gradient,
              transform: `rotate(${rotation}deg)`,
              transition: spinning ? 'transform 4.2s cubic-bezier(0.15, 0.85, 0.25, 1)' : 'none',
              boxShadow: 'inset 0 0 24px rgba(0,0,0,0.25)',
            }}
          >
            {/* 奖品名写在盘上，随盘旋转 */}
            {segs.map((s, i) => {
              const center = (s.start + s.end) / 2
              const rad = (center * Math.PI) / 180
              const r = 86
              return (
                <span
                  key={i}
                  className="pointer-events-none absolute z-10 whitespace-nowrap text-[11px] font-black text-white"
                  style={{
                    left: 136 + r * Math.sin(rad),
                    top: 136 - r * Math.cos(rad),
                    transform: `translate(-50%, -50%) rotate(${center}deg)`,
                    textShadow: '0 1px 3px rgba(0,0,0,0.8)',
                  }}
                >
                  {shortLabel(s)}
                </span>
              )
            })}
          </div>
          {/* 中心轴 */}
          <div className="absolute left-1/2 top-1/2 z-20 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-gradient-to-b from-amber-300 to-orange-400 text-lg font-black text-white ring-4 ring-white/50 shadow-xl">
            ✨
          </div>
        </div>

        {/* 结果 */}
        {prize && !spinning && (
          <div className="mb-3 rounded-2xl bg-white/5 px-4 py-3 text-center ring-1 ring-amber-200/30">
            <p className="text-sm font-black text-amber-100">
              {prize.type === 'thanks' ? '😅 下次好运' : prize.type === 'again' ? '🔁 再来一次' : prize.type === 'upgrade' ? '🎫 升级券' : prize.item ? `${prize.item.emoji} ${prize.item.name}` : `💰 ${prize.coins} 时元`}
            </p>
          </div>
        )}
        {multi && !spinning && (
          <div className="mb-3 rounded-2xl bg-white/5 px-3 py-3 ring-1 ring-amber-200/30">
            <div className="grid grid-cols-5 gap-2">
              {multi.map((p, i) => (
                <div key={i} className="flex flex-col items-center rounded-xl bg-white/5 py-1.5">
                  <span className="text-lg leading-none">
                    {p.type === 'coins' ? '💰' : p.type === 'again' ? '🔁' : p.type === 'upgrade' ? '🎫' : p.item ? p.item.emoji : '😅'}
                  </span>
                  <span className="mt-0.5 text-[9px] font-bold text-amber-100/90">
                    {p.type === 'coins' ? `${p.coins}时元` : p.type === 'again' ? '再来' : p.type === 'upgrade' ? '升级券' : p.item ? p.item.name : '谢谢'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mb-4 grid grid-cols-2 gap-3">
          <button
            onClick={() => draw(1)}
            disabled={spinning}
            className={`rounded-2xl py-4 text-sm font-bold text-white shadow-lg transition-all ${
              !spinning
                ? 'bg-gradient-to-r from-amber-400 via-orange-400 to-rose-400 shadow-orange-500/30 active:scale-95'
                : 'bg-white/10 text-purple-300'
            }`}
          >
            {spinning ? '🎡 转动中…' : `🎡 抽一次（${WHEEL_COST} 时元）`}
          </button>
          <button
            onClick={() => draw(10)}
            disabled={spinning}
            className={`rounded-2xl py-4 text-sm font-bold text-white shadow-lg transition-all ${
              !spinning
                ? 'bg-gradient-to-r from-purple-500 via-pink-500 to-rose-500 shadow-pink-500/30 active:scale-95'
                : 'bg-white/10 text-purple-300'
            }`}
          >
            🚀 十连抽（${WHEEL_COST * 10} 时元）
          </button>
        </div>
      </div>
    </div>
  )
}

// ===================== 主页面 =====================
export default function FarmPage({ user, onBack }: { user: User; onBack: () => void }) {
  const [farms, setFarms] = useState<Record<string, FarmOf>>({})
  const [txs, setTxs] = useState<WalletTx[]>([])
  const [asks, setAsks] = useState<AskItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [viewing, setViewing] = useState<'mine' | 'partner'>('mine')
  const [toast, setToast] = useState('')
  const [now, setNow] = useState(Date.now())
  const [waterMode, setWaterMode] = useState(false)
  const [upgradeMode, setUpgradeMode] = useState(false)
  const [toolSheet, setToolSheet] = useState(false)
  const [fishingOpen, setFishingOpen] = useState(false)

  const [picker, setPicker] = useState<null | { mode: 'plant' | 'plantAll'; plotId?: number }>(null)
  const [fishPickerSlot, setFishPickerSlot] = useState<number | null>(null)
  const [stockAllOpen, setStockAllOpen] = useState(false)
  const [warehouseOpen, setWarehouseOpen] = useState(false)
  const [dexOpen, setDexOpen] = useState(false)
  const [workshopOpen, setWorkshopOpen] = useState(false)
  const [fusionOpen, setFusionOpen] = useState(false)
  const [wheelOpen, setWheelOpen] = useState(false)
  const [harvestShow, setHarvestShow] = useState<HarvestGain[] | null>(null)

  const wx = weatherToday()

  const pairedUsers = getPairedUsers()
  const partner = pairedUsers.find((p) => p !== user.name) ?? ''
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useLayoutEffect(() => {
    const timer = setTimeout(() => setLoading(false), 4000)
    // 进场后 3.2 秒做一次"农场主自我声明"：等云端合并完成后，
    // 用 Lamport max+1 重新声明本人农场，修复历史时钟偏差造成的同步卡死
    const healTimer = setTimeout(() => assertFarm(user.name), 3200)
    const u1 = subscribeFarm(
      (f) => {
        setFarms(f)
        setLoading(false)
      },
      (m) => setError(m),
    )
    const u2 = subscribeWallet((t) => setTxs(t))
    const u3 = subscribeAsks((a) => setAsks(a))
    const tick = setInterval(() => setNow(Date.now()), 15_000)
    return () => {
      clearTimeout(timer)
      clearTimeout(healTimer)
      clearInterval(tick)
      u1()
      u2()
      u3()
    }
  }, [])

  const showToast = (msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 3500)
  }

  const balance = useMemo(
    () => totalBalance(txs, asks, user.name),
    [txs, asks, user.name],
  )
  const partnerBalance = useMemo(
    () => totalBalance(txs, asks, partner),
    [txs, asks, partner],
  )

  const mine = farmOf(farms, user.name)
  const theirs = farmOf(farms, partner)
  const viewingFarm = viewing === 'mine' ? mine : theirs
  const isMine = viewing === 'mine'
  const todayKey = (() => {
    const d = new Date()
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
  })()
  const waterUsed = mine.waterDay === todayKey ? mine.waterCount : 0

  // 普通作物分组（价格翻倍展示；融合作物除外）
  const normalCropGroups = useMemo(() => {
    const order = ['花卉', '果蔬香草', '新增作物']
    return order.map((g) => ({
      group: g,
      items: CROPS.filter((c) => c.group === g && !c.fusionOnly).map((c) => ({ ...c, cost: c.cost * SEED_PRICE_MULT })),
    }))
  }, [])
  // 融合作物（种子）：只在仓库里有「种子」时显示（成品不可再当种子种）
  const fusionCropItems = useMemo(
    () =>
      CROPS.filter((c) => c.fusionOnly && (mine.warehouse[seedId(c.id)] ?? 0) >= 1).map((c) => ({
        ...c,
        cost: 0,
        extra: '种子×1',
      })),
    [mine.warehouse],
  )
  // 单块种植用：普通作物 + 融合作物种子
  const plantGroups = useMemo(() => {
    if (fusionCropItems.length === 0) return normalCropGroups
    return [...normalCropGroups, { group: '融合作物', items: fusionCropItems }]
  }, [normalCropGroups, fusionCropItems])
  // 一键种植用：普通作物 + 特殊种子（融合作物）。
  // 与单块种植的区别：卡片上标出**持有种子数**（一键会把它们批量种满空地），
  // 且只列出「仓库里真有种子」的融合作物——没有种子的选项点了一键必然失败。
  const plantAllGroups = useMemo(() => {
    const seeds = CROPS.filter((c) => c.fusionOnly && (mine.warehouse[seedId(c.id)] ?? 0) >= 1).map((c) => ({
      ...c,
      cost: 0,
      extra: `种子×${mine.warehouse[seedId(c.id)] ?? 0}`,
    }))
    if (seeds.length === 0) return normalCropGroups
    return [...normalCropGroups, { group: '融合作物（特殊种子）', items: seeds }]
  }, [normalCropGroups, mine.warehouse])
  const fishGroups = useMemo(() => {
    const order = ['淡水鱼', '咸水鱼', '新增水产']
    return order.map((g) => ({
      group: g,
      items: FISH.filter((f) => f.group === g),
    }))
  }, [])
  // 稀有鱼（鱼苗）：仓库里有「鱼苗」时显示，可用鱼苗放养（成品鱼不可再当鱼苗）
  const rareFishItems = useMemo(
    () => RARE_FISH.filter((f) => (mine.warehouse[fryId(f.id)] ?? 0) >= 1).map((f) => ({ ...f, cost: 0, extra: '鱼苗×1' })),
    [mine.warehouse],
  )
  const fishPickerGroups = useMemo(() => {
    if (rareFishItems.length === 0) return fishGroups
    return [...fishGroups, { group: '稀有鱼', items: rareFishItems }]
  }, [fishGroups, rareFishItems])

  // 追踪中的配方所需的原材料数量（含高阶配方逐层拆解到作物/水产），减去仓库库存 = 还缺几个
  const trackedNeeded = useMemo(() => {
    const need = new Map<string, number>()
    const expand = (rid: string, depth: number, mult: number) => {
      if (depth > 4) return
      const r = recipeById(rid)
      if (!r) return
      for (const [id, n] of r.mats) {
        if (cropById(id) || fishById(id)) need.set(id, (need.get(id) ?? 0) + n * mult)
        else expand(id, depth + 1, n * mult)
      }
    }
    ;(mine.tracking ?? []).forEach((rid) => expand(rid, 0, 1))
    const lack = new Map<string, number>()
    for (const [id, n] of need) {
      const l = n - (mine.warehouse[id] ?? 0)
      if (l > 0) lack.set(id, l)
    }
    return lack
  }, [mine.tracking, mine.warehouse])

  // 鱼的游动路径：每条鱼在自己的养殖位出发，随机游遍整个鱼塘水面再回家
  // （水面实测边界 x15.8%-82.5% y72.3%-80.9%，路径按养殖位 id 确定性生成，重渲染不乱跳）
  const swimCSS = useMemo(() => {
    const rand = (seed: number) => {
      let s = seed
      return () => {
        s = (s * 9301 + 49297) % 233280
        return s / 233280
      }
    }
    return viewingFarm.pond
      .filter((s) => s.fishId)
      .map((s) => {
        const r = rand(s.id * 77 + 13)
        const home = POND_RECTS[s.id]
        const pts: string[] = [`0% { left: ${home.left}%; top: ${home.top}%; }`]
        for (let i = 1; i <= 4; i++) {
          const l = 16.5 + r() * 61 // 横向 16.5% ~ 77.5%
          const t = 72.6 + r() * 5.2 // 纵向 72.6% ~ 77.8%
          pts.push(`${i * 20}% { left: ${l.toFixed(2)}%; top: ${t.toFixed(2)}%; }`)
        }
        pts.push(`100% { left: ${home.left}%; top: ${home.top}%; }`)
        return `@keyframes swim${s.id} { ${pts.join(' ')} }`
      })
      .join('\n')
  }, [viewingFarm.pond])

  // ===================== 地块交互 =====================
  const tapPlot = (plot: FarmOf['plots'][number]) => {
    const crop = plot.cropId ? cropById(plot.cropId) : null
    const nowTs = Date.now() // 用实时时间判断成熟度，避免 15s 刷新间隔造成"熟了不能收"
    const mature = crop && plot.matureAt <= nowTs

    // 处理害虫/猫骚扰：点击显示清除确认
    if (plot.pest && isMine && !mature) {
      if (window.confirm(`花费 5 时元清除${plot.pest === 'bug' ? '虫害' : '猫骚扰'}？`)) {
        showToast(curePest(user.name, plot.id, balance).msg)
      }
      return
    }

    // 处理偷菜反馈：点击显示谁偷的
    if (plot.stolen && isMine) {
      const stolenBy = plot.stolenBy
      const stolenAt = plot.stolenAt
      const minutesAgo = Math.floor((Date.now() - stolenAt!) / 60000)
      showToast(`这块地在 ${minutesAgo} 分钟前被 ${stolenBy} 偷走了 😭`)
      return
    }

    if (isMine) {
      if (upgradeMode) {
        const lv = plot.level ?? 0
        if (lv >= MAX_LEVEL) {
          showToast('已经是最高级的天蓝土地啦 ✨')
        } else {
          const hasToken = (mine.upgradeTokens ?? 0) > 0
          const tip = hasToken
            ? `用升级券把这块地免费升级为「${LEVEL_NAMES[lv + 1]}」？（还剩 ${mine.upgradeTokens} 张券）`
            : `把这块地升级为「${LEVEL_NAMES[lv + 1]}」？\n花费 ${UPGRADE_COSTS[lv]} 时元，产量 +1、暴击率提升。`
          if (window.confirm(tip)) showToast(upgradePlot(user.name, plot.id, balance).msg)
        }
        return
      }
      if (waterMode) {
        if (crop && !mature) {
          showToast(water(user.name, plot.id, balance).msg)
          setNow(Date.now()) // 立即刷新界面时钟，浇水后进度/成熟度马上可见
        } else showToast(crop ? '已经成熟，直接收获吧' : '这块地还没种东西')
        setWaterMode(false)
        return
      }
      if (!crop) {
        setPicker({ mode: 'plant', plotId: plot.id })
        return
      }
      if (mature) {
        const r = harvest(user.name, plot.id)
        if (r.ok && r.gain) setHarvestShow([r.gain])
        else showToast(r.msg)
        return
      }
      showToast(`${crop.emoji} ${crop.name} 生长中，还需 ${leftText(plot.matureAt - nowTs)}`)
      return
    }

    // 参观 TA 的农场：添加浇水帮助功能
    if (isMine && partner && !waterMode) {
      if (window.confirm(`帮助 ${partner} 浇水？花费 2 时元，加速 1 小时`)) {
        showToast(helpWater(user.name, partner, plot.id, balance).msg)
      }
      return
    }

    // 参观 TA 的农场：偷菜逻辑
    if (crop && mature && !plot.stolen) {
      showToast(steal(user.name, partner, plot.id).msg)
    } else if (crop) {
      showToast(mature ? '这块已经被偷过啦' : `${crop.name} 还没熟，${leftText(plot.matureAt - nowTs)}后来偷 😈`)
    }
  }

  const tapPond = (slot: FarmOf['pond'][number]) => {
    const fish = slot.fishId ? anyFishById(slot.fishId) : null
    const mature = fish && slot.matureAt <= Date.now()
    if (isMine) {
      if (!fish) {
        setFishPickerSlot(slot.id)
        return
      }
      if (mature) {
        const r = harvestFish(user.name, slot.id)
        if (r.ok && r.gain) setHarvestShow([r.gain])
        else showToast(r.msg)
        return
      }
      showToast(`${fish.emoji} ${fish.name} 养着，还需 ${leftText(slot.matureAt - now)}`)
      return
    }
    if (fish) showToast(`${fish.name} 还需要 ${leftText(slot.matureAt - now)}，鱼可偷不走哦 🐟`)
  }

  // ===================== 场景覆盖层 =====================
  const renderPlotOverlay = (plot: FarmOf['plots'][number]) => {
    const crop = plot.cropId ? cropById(plot.cropId) : null
    const mature = crop && plot.matureAt <= now
    const progress = crop ? Math.min(1, (now - plot.plantedAt) / Math.max(1, plot.matureAt - plot.plantedAt)) : 0
    // 生长四阶段：发芽 → 长叶 → 结苞（作物小图） → 成熟（作物大图弹跳）
    const stage = !crop ? '' : progress < 0.3 ? '🌱' : progress < 0.6 ? '🌿' : crop.emoji
    const stageSize = !crop
      ? ''
      : mature
        ? 'text-[22px]'
        : progress < 0.3
          ? 'text-[13px]'
          : progress < 0.6
            ? 'text-[16px]'
            : 'text-[19px]'

    return (
      <button
        key={plot.id}
        onClick={() => tapPlot(plot)}
        style={tileRect(plot.id)}
        className={`absolute flex flex-col items-center justify-center rounded-lg transition-transform active:scale-95 ${
          waterMode && isMine && crop && !mature ? 'ring-2 ring-sky-300' : ''
        } ${upgradeMode && isMine ? 'ring-2 ring-amber-300' : ''} ${mature ? 'ring-2 ring-yellow-300/90' : ''}`}
      >
        {/* 升级土地：三层描边模糊光，由亮到淡向外扩散，一眼可见 */}
        {(plot.level ?? 0) > 0 && LEVEL_GLOW_COLORS[plot.level ?? 0] && (
          <>
            <div
              className="pointer-events-none absolute inset-0 z-0 animate-pulse rounded-lg"
              style={{ border: `4px solid ${LEVEL_GLOW_COLORS[plot.level ?? 0]![0]}`, filter: 'blur(6px)' }}
            />
            <div
              className="pointer-events-none absolute inset-0 z-0 animate-pulse rounded-lg"
              style={{ border: `10px solid ${LEVEL_GLOW_COLORS[plot.level ?? 0]![1]}`, filter: 'blur(16px)', opacity: 0.95 }}
            />
            <div
              className="pointer-events-none absolute inset-0 z-0 animate-pulse rounded-lg"
              style={{ border: `16px solid ${LEVEL_GLOW_COLORS[plot.level ?? 0]![2]}`, filter: 'blur(30px)', opacity: 0.7 }}
            />
          </>
        )}
        {/* 天蓝土地：华丽旋转光环 + 漂浮星光 */}
        {(plot.level ?? 0) === 5 && (
          <>
            <div
              className="pointer-events-none absolute -inset-3 z-0 animate-spin rounded-full"
              style={{
                background:
                  'conic-gradient(from 0deg, rgba(120,200,255,0), rgba(120,200,255,0.6), rgba(255,255,255,0.85), rgba(150,220,255,0.6), rgba(120,200,255,0))',
                filter: 'blur(4px)',
                animationDuration: '3.5s',
              }}
            />
            <span className="pointer-events-none absolute -top-2 -left-1 z-[2] animate-bounce text-[11px]">✨</span>
            <span className="pointer-events-none absolute -top-1 right-1 z-[2] animate-pulse text-[10px]">🌟</span>
          </>
        )}
        {!crop && isMine && (
          <span className="relative z-[1] flex h-4 w-4 items-center justify-center rounded-full bg-white/25 text-[10px] font-bold text-white/90 shadow-sm">
            ＋
          </span>
        )}
        {crop && (
          <>
            <span className={`pointer-events-none relative z-[1] leading-none ${mature ? 'animate-bounce' : ''} ${stageSize}`} style={{ textShadow: '0 1px 3px rgba(0,0,0,0.3)' }}>
              {stage}
            </span>
            {/* 进度条 */}
            <span className="pointer-events-none absolute bottom-[6%] left-[12%] right-[12%] h-[3px] overflow-hidden rounded-full bg-black/30">
              <span
                className={`block h-full rounded-full ${mature ? 'bg-yellow-300' : 'bg-green-400'}`}
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </span>
            {mature && (
              <span className="pointer-events-none absolute -top-1.5 -right-1 text-[11px]">
                {isMine ? '🧺' : plot.stolen ? '' : '🥷'}
              </span>
            )}
            {plot.stolen && <span className="pointer-events-none absolute top-0 left-0.5 text-[9px]">🥷</span>}
            {/* 虫害/猫骚扰 */}
            {plot.pest && !mature && (
              <span
                className={`pointer-events-none absolute -top-1 -left-1 text-[11px] ${plot.pest === 'bug' ? 'animate-pulse' : ''}`}
                title={plot.pest === 'bug' ? '被虫子啃了，产量会下降' : '被旁边的猫踩了，产量会下降'}
              >
                {plot.pest === 'bug' ? '🐛' : '🐱'}
              </span>
            )}
          </>
        )}
      </button>
    )
  }

  const renderPondOverlay = (slot: FarmOf['pond'][number]) => {
    const fish = slot.fishId ? anyFishById(slot.fishId) : null
    const mature = fish && slot.matureAt <= now
    // 空养殖位：原地小圆圈 ＋
    if (!fish) {
      return (
        <button
          key={slot.id}
          onClick={() => tapPond(slot)}
          style={pondRect(slot.id)}
          className="absolute flex items-center justify-center rounded-full transition-transform active:scale-95"
        >
          {isMine && (
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-white/30 text-[10px] font-bold text-white shadow-sm">
              ＋
            </span>
          )}
        </button>
      )
    }
    // 有鱼：脱离格子，在整个鱼塘水面自由游动（路径见 swimCSS）
    return (
      <button
        key={slot.id}
        onClick={() => tapPond(slot)}
        className="absolute flex items-center justify-center transition-transform active:scale-95"
        style={{
          width: '5.5%',
          height: '3.2%',
          left: `${POND_RECTS[slot.id].left}%`,
          top: `${POND_RECTS[slot.id].top}%`,
          animation: `swim${slot.id} ${18 + ((slot.id * 7) % 12)}s ease-in-out ${-((slot.id * 3.3) % 12).toFixed(1)}s infinite`,
        }}
      >
        <span
          className={`pointer-events-none leading-none ${mature ? 'animate-bounce text-[20px]' : 'text-[18px]'}`}
          style={{ textShadow: '0 1px 3px rgba(0,0,0,0.35)' }}
        >
          {fish.emoji}
        </span>
        {mature && isMine && <span className="pointer-events-none absolute -top-1.5 -right-1 text-[11px]">🧺</span>}
      </button>
    )
  }

  const ownerName = isMine ? user.name : partner

  return (
    <div className="flex min-h-dvh flex-col bg-gradient-to-b from-sky-200 via-sky-100 to-emerald-50">
      {/* 顶部栏 */}
      <div className="sticky top-0 z-10 flex flex-nowrap items-center gap-1.5 bg-sky-200/95 px-4 pb-3 pt-6" style={{ transform: 'translateZ(0)' }}>
        <button
          onClick={onBack}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-[#c44d7d] shadow transition-transform active:scale-90"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-bold leading-tight tracking-widest text-emerald-800">开心农场</h1>
          <p className="truncate whitespace-nowrap text-[11px] text-emerald-600/70">{ownerName}的园子 · 浇水 {waterUsed}/{WATER_DAILY_MAX}</p>
        </div>
        <button
          onClick={() => {
            // 一按两件事：拉云端最新（退订重订）+ 只把我这一片农场发过去（几百字节，秒到）
            resyncFarm(user.name)
            showToast(syncMyFarm(user.name).msg)
          }}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/90 text-emerald-600 shadow transition-transform active:scale-90"
          title="同步：拉取云端最新 + 把我的农场发过去"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
        <button
          onClick={() => {
            setViewing(isMine ? 'partner' : 'mine')
            setWaterMode(false)
            setUpgradeMode(false)
          }}
          className="shrink-0 whitespace-nowrap rounded-full bg-white/90 px-2.5 py-1.5 text-xs font-bold text-emerald-700 shadow transition-transform active:scale-90"
        >
          {isMine ? `去TA家 🐾` : '回我家 🏡'}
        </button>
        <div className="flex shrink-0 items-center gap-1 rounded-full bg-white/90 px-3 py-1.5 shadow">
          <Coins className="h-4 w-4 shrink-0 text-amber-500" />
          <span className="text-sm font-bold tabular-nums text-amber-600">{balance}</span>
        </div>
      </div>

      {error && (
        <div className="mx-4 mt-2 flex items-center gap-2 rounded-2xl bg-amber-50 px-4 py-2.5 text-xs text-amber-500">
          <CloudOff className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* 提示条 */}
      {toast && (
        <div className="fixed inset-x-0 top-20 z-[60] mx-auto w-fit max-w-[85vw] rounded-full bg-black/70 px-4 py-2 text-center text-xs text-white shadow-xl">
          {toast}
        </div>
      )}

      {loading ? (
        <div className="flex flex-1 justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-emerald-300" />
        </div>
      ) : (
        <div className="mx-auto w-full max-w-md flex-1 px-2 pb-6 pt-2">
          {/* 今日天气 */}
          <div className="mb-2 flex justify-center gap-2 px-1">
            <span className="flex items-center gap-1.5 whitespace-nowrap rounded-full bg-white/85 px-3.5 py-1.5 text-[10px] font-semibold text-emerald-700 shadow-sm">
              <span className="text-sm leading-none">{wx.emoji}</span>
              {wx.name}
              <span className="text-emerald-500/80">{wx.desc}</span>
            </span>
            {upgradeMode && (
              <button
                onClick={() => setUpgradeMode(false)}
                className="flex items-center gap-1 whitespace-nowrap rounded-full bg-violet-500 px-3.5 py-1.5 text-[10px] font-bold text-white shadow-sm transition-transform active:scale-95"
              >
                升级模式中 · 退出
              </button>
            )}
          </div>

          {/* ===== 1:1 场景复刻：图片 + 交互层 ===== */}
          <div className="relative aspect-[2/3] w-full overflow-hidden rounded-2xl shadow-lg shadow-emerald-200/60">
            <img src={farmScene} alt="农场" className="absolute inset-0 block h-full w-full select-none object-cover" style={{ transform: 'translateZ(0)', backfaceVisibility: 'hidden' }} draggable={false} />

            {/* 已解锁地块 */}
            {viewingFarm.plots.map(renderPlotOverlay)}

            {/* 下一块待开垦土地（虚线圈提示） */}
            {isMine && viewingFarm.plots.length < MAX_PLOTS && (
              <button
                onClick={() => showToast(unlockPlot(user.name, balance).msg)}
                style={tileRect(viewingFarm.plots.length)}
                className="absolute flex flex-col items-center justify-center gap-0.5 rounded-lg border-2 border-dashed border-white/70 bg-black/15 transition-transform active:scale-95"
              >
                <span className="text-[11px]">🔓</span>
                <span className="text-[7px] font-bold text-white drop-shadow">{UNLOCK_COST}开垦</span>
              </button>
            )}

            {/* 鱼塘位置 */}
            {viewingFarm.pond.map(renderPondOverlay)}

            {/* 下一个待开通养殖位 */}
            {isMine && viewingFarm.pond.length < MAX_POND && (
              <button
                onClick={() => showToast(unlockPond(user.name, balance).msg)}
                style={pondRect(viewingFarm.pond.length)}
                className="absolute flex flex-col items-center justify-center gap-0.5 rounded-full border-2 border-dashed border-white/70 bg-black/15 transition-transform active:scale-95"
              >
                <span className="text-[11px]">🔓</span>
                <span className="text-[7px] font-bold text-white drop-shadow">{UNLOCK_COST}开通</span>
              </button>
            )}

            {/* 小房子 → 仓库 */}
            <button
              onClick={() => setWarehouseOpen(true)}
              style={ZONE_HOUSE}
              className="absolute transition-transform active:scale-90"
              title="仓库"
            >
              <span className="absolute -top-2 -right-2 flex h-7 w-7 items-center justify-center rounded-full bg-amber-400 text-sm shadow-md ring-2 ring-white/80">
                🏠
              </span>
              <span className="absolute bottom-0 left-1/2 -translate-x-1/2 rounded-full bg-amber-400/95 px-2.5 py-0.5 text-[10px] font-bold text-white shadow">
                仓库
              </span>
            </button>

            {/* 鱼塘上方 → 幸运大转盘 */}
            <button
              onClick={() => setWheelOpen(true)}
              style={{ left: '84%', top: '64.5%', width: '13%', height: '8%' }}
              className="absolute transition-transform active:scale-90"
              title="大转盘"
            >
              <span className="absolute top-0 right-0 flex h-8 w-8 items-center justify-center rounded-full bg-amber-400 text-base shadow-md ring-2 ring-white/80">
                🎡
              </span>
              <span className="absolute bottom-0 left-1/2 -translate-x-1/2 rounded-full bg-amber-400/95 px-2.5 py-0.5 text-[10px] font-bold whitespace-nowrap text-white shadow">
                转盘
              </span>
            </button>

            {/* 鱼塘右侧 → 钓鱼小游戏（自家和对方家都能钓） */}
            <button
              onClick={() => setFishingOpen(true)}
              style={{ left: '84%', top: '72.5%', width: '13%', height: '8%' }}
              className="absolute transition-transform active:scale-90"
              title="钓鱼"
            >
              <span className="absolute top-0 right-0 flex h-8 w-8 items-center justify-center rounded-full bg-sky-400 text-base shadow-md ring-2 ring-white/80">
                🎣
              </span>
              <span className="absolute bottom-0 left-1/2 -translate-x-1/2 rounded-full bg-sky-400/95 px-2.5 py-0.5 text-[10px] font-bold whitespace-nowrap text-white shadow">
                钓鱼
              </span>
            </button>

{/* 洒水桶 → 浇水模式（仅自己农场） */}
             {isMine && (
               <button
                 onClick={() => {
                   setWaterMode(!waterMode)
                   setUpgradeMode(false)
                   const cost = wx.id === 'rain' ? 0 : WATER_COST
                   const hours = wx.id === 'rain' || wx.id === 'breeze' ? 2 : 1
                   showToast(
                     waterMode
                       ? '退出浇水模式'
                       : `浇水模式：点一块生长中的地（${cost > 0 ? `-${cost}时元/` : '免费/'}次，加速${hours}小时）`,
                   )
                 }}
                 style={ZONE_CAN}
                 className={`absolute rounded-full transition-all active:scale-90 ${waterMode ? 'bg-sky-400/40 ring-2 ring-sky-300' : ''}`}
                 title="洒水桶"
               />
             )}

             {/* 浇水帮助模式（仅参观他人农场时） */}
             {partner && (
               <button
                 onClick={() => {
                   setWaterMode(!waterMode)
                   setUpgradeMode(false)
                   showToast(
                     waterMode
                       ? '退出浇水帮助模式'
                       : '浇水帮助模式：点一块生长中的地帮助浇水（-2时元/次，加速1小时）',
                   )
                 }}
                 style={ZONE_CAN}
                 className={`absolute rounded-full transition-all active:scale-90 ${waterMode ? 'bg-green-400/40 ring-2 ring-green-300' : ''}`}
                 title="浇水帮助"
               />
             )}

            {/* 锄头 → 一键操作（仅自己农场） */}
            {isMine && (
              <button
                onClick={() => setToolSheet(true)}
                style={ZONE_SHOVEL}
                className="absolute rounded-full transition-transform active:scale-90"
                title="锄头"
              />
            )}

            {/* 猫咪 → 去 TA 家 / 回我家（彩蛋） */}
            <button
              onClick={() => {
                setViewing(isMine ? 'partner' : 'mine')
                setWaterMode(false)
                setUpgradeMode(false)
                showToast(isMine ? `喵~ 带你去${partner}家串门 🐾` : '喵~ 欢迎回家 🏡')
              }}
              style={ZONE_CAT}
              className="absolute transition-transform active:scale-90"
              title={isMine ? `去${partner}家` : '回我的农场'}
            >
              <span className="absolute -top-1 -left-1 flex h-4 w-4 items-center justify-center rounded-full bg-white text-[9px] shadow">
                {isMine ? '👀' : '🏡'}
              </span>
            </button>
          </div>

          {/* 场景说明 */}
          <p className="mt-2 text-center text-[11px] text-emerald-600/70">
            {isMine
              ? '点空地种植 · 点🧺收获 · 点洒水桶浇水 · 点锄头一键操作 · 点小房子开仓库'
              : `正在参观${partner}的农场 · 点🥷偷菜(50%血本无归) · 点猫咪回家 · TA的时元 ${partnerBalance}`}
          </p>
        </div>
      )}

      {/* 锄头一键操作 */}
      {toolSheet && (
        <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/55" onClick={() => setToolSheet(false)}>
          <div className="w-full max-w-md rounded-t-3xl bg-white p-5 pb-8" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <span className="text-sm font-bold tracking-widest text-[#c44d7d]">⛏️ 锄头 · 一键操作</span>
              <button onClick={() => setToolSheet(false)} className="text-pink-300 active:text-pink-500">
                <X className="h-5 w-5" />
              </button>
            </div>
            <button
              onClick={() => {
                setToolSheet(false)
                setPicker({ mode: 'plantAll' })
              }}
              className="mb-3 w-full rounded-2xl bg-gradient-to-r from-emerald-400 to-lime-400 py-3 text-sm font-semibold text-white shadow-lg shadow-emerald-200 transition-transform active:scale-95"
            >
              🌱 一键种植所有空地（含特殊种子）
            </button>
            <button
              onClick={() => {
                setToolSheet(false)
                setStockAllOpen(true)
              }}
              className="mb-3 w-full rounded-2xl bg-gradient-to-r from-sky-400 to-cyan-400 py-3 text-sm font-semibold text-white shadow-lg shadow-sky-200 transition-transform active:scale-95"
            >
              🐟 一键养满所有空养殖位
            </button>
            <button
              onClick={() => {
                setToolSheet(false)
                setWaterMode(false)
                setUpgradeMode(true)
                showToast('土地升级模式：点一块地升级（普通→银灰→金色→紫金→青色→天蓝），每级产量 +1')
              }}
              className="mb-3 w-full rounded-2xl bg-gradient-to-r from-violet-400 to-fuchsia-400 py-3 text-sm font-semibold text-white shadow-lg shadow-violet-200 transition-transform active:scale-95"
            >
              ⚫ 土地升级（{UPGRADE_COSTS.join('/')} 时元 · 只加暴击）
            </button>
            <button
              onClick={() => {
                setToolSheet(false)
                const r = harvestAll(user.name)
                if (r.ok && r.gains.length > 0) setHarvestShow(r.gains)
                else showToast(r.msg)
              }}
              className="w-full rounded-2xl bg-gradient-to-r from-amber-400 to-orange-400 py-3 text-sm font-semibold text-white shadow-lg shadow-amber-200 transition-transform active:scale-95"
            >
              🧺 一键收获所有成熟作物和鱼
            </button>
          </div>
        </div>
      )}

      {/* 种子选择 */}
      {picker && (
        <PickerModal
          title={picker.mode === 'plantAll' ? '⛏️ 一键种植：选择作物' : '🌱 选择要种的作物'}
          groups={picker.mode === 'plantAll' ? plantAllGroups : plantGroups}
          neededLack={trackedNeeded}
          onClose={() => setPicker(null)}
          onPick={(id) => {
            if (picker.mode === 'plantAll') {
              showToast(plantAll(user.name, id, balance).msg)
            } else if (picker.plotId !== undefined) {
              const crop = cropById(id)
              if (crop?.fusionOnly) showToast(plantFromSeed(user.name, picker.plotId, id).msg)
              else showToast(plant(user.name, picker.plotId, id, balance).msg)
            }
            setPicker(null)
          }}
        />
      )}

      {/* 鱼苗选择 */}
      {fishPickerSlot !== null && (
        <PickerModal
          title="🎣 选择要养的水产"
          groups={fishPickerGroups}
          neededLack={trackedNeeded}
          onClose={() => setFishPickerSlot(null)}
          onPick={(id) => {
            const isRare = rareFishById(id) != null
            if (isRare) showToast(stockRareFish(user.name, fishPickerSlot, id).msg)
            else showToast(stockFish(user.name, fishPickerSlot, id, balance).msg)
            setFishPickerSlot(null)
          }}
        />
      )}

      {/* 一键养鱼选择 */}
      {stockAllOpen && (
        <PickerModal
          title="🐟 一键养满：选择水产"
          groups={fishGroups}
          neededLack={trackedNeeded}
          onClose={() => setStockAllOpen(false)}
          onPick={(id) => {
            showToast(stockAllFish(user.name, id, balance).msg)
            setStockAllOpen(false)
          }}
        />
      )}

      {/* 钓鱼小游戏 */}
      {fishingOpen && (
        <FishingModal
          user={user}
          balance={balance}
          pondOwner={isMine ? user.name : partner}
          pondFish={viewingFarm.pond
            .filter((s) => s.fishId && s.matureAt <= Date.now())
            .map((s) => ({ slotId: s.id, fishId: s.fishId! }))}
          onClose={() => setFishingOpen(false)}
        />
      )}

      {/* 仓库 */}
      {warehouseOpen && (
        <WarehouseModal
          farm={mine}
          partnerFarm={theirs}
          who={user.name}
          partner={partner}
          onOpenWorkshop={() => {
            setWarehouseOpen(false)
            setWorkshopOpen(true)
          }}
          onOpenDex={() => {
            setWarehouseOpen(false)
            setDexOpen(true)
          }}
          onOpenFusion={() => {
            setWarehouseOpen(false)
            setFusionOpen(true)
          }}
          onToast={showToast}
          onClose={() => setWarehouseOpen(false)}
        />
      )}

      {/* 图鉴 */}
      {dexOpen && <DexModal farm={mine} onClose={() => setDexOpen(false)} />}

      {/* 合成工坊 */}
      {workshopOpen && (
        <WorkshopModal farm={mine} who={user.name} onToast={showToast} onClose={() => setWorkshopOpen(false)} />
      )}

      {/* 大融合 */}
      {fusionOpen && (
        <FusionModal farm={mine} who={user.name} onToast={showToast} onClose={() => setFusionOpen(false)} />
      )}

      {/* 大转盘 */}
      {wheelOpen && (
        <FarmWheelModal who={user.name} balance={balance} onToast={showToast} onClose={() => setWheelOpen(false)} />
      )}

      {/* 收获庆祝 */}
      {harvestShow && <HarvestModal gains={harvestShow} onClose={() => setHarvestShow(null)} />}

      <style>{`
        @keyframes harvestPop {
          0% { transform: scale(0.5); opacity: 0; }
          100% { transform: scale(1); opacity: 1; }
        }
        @keyframes harvestFall {
          0% { transform: translateY(0) rotate(0deg); opacity: 0; }
          10% { opacity: 1; }
          100% { transform: translateY(110vh) rotate(340deg); opacity: 0.7; }
        }
        ${swimCSS}
      `}</style>
    </div>
  )
}
