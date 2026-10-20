import { X } from 'lucide-react'
import {
  RECIPES,
  itemInfo,
  recipeById,
  recipeMissing,
  synthesize,
  toggleTrack,
  type FarmOf,
  type Recipe,
} from '../lib/farm'

const TIER_SECTIONS: Array<{ tier: 1 | 2 | 3; title: string }> = [
  { tier: 1, title: '🌱 一阶合成 · 作物鲜鱼的初遇' },
  { tier: 2, title: '✨ 二阶合成 · 合成物的华丽蜕变' },
  { tier: 3, title: '👑 三阶合成 · 传说的顶点' },
]

function RecipeCard({
  recipe,
  farm,
  who,
  onToast,
}: {
  recipe: Recipe
  farm: FarmOf
  who: string
  onToast: (msg: string) => void
}) {
  const tracked = (farm.tracking ?? []).includes(recipe.id)
  const ready = recipeMissing(farm.warehouse, recipe) === null
  // 已合成过：图鉴（dex）永久记录首次获得即解锁的物品 id；合成产物只能靠合成获得，
  // 所以 dex 里有该配方 id，即代表这个配方曾经合成成功过（历史记录，不是当前库存）
  const crafted = (farm.dex ?? []).includes(recipe.id)
  return (
    <div
      className={`mb-3 flex items-center gap-3 rounded-2xl border p-3 shadow-sm transition-all ${
        tracked
          ? 'border-pink-300 bg-white ring-2 ring-pink-200'
          : crafted
            ? 'border-emerald-300 bg-emerald-50/60'
            : 'border-amber-100 bg-white'
      }`}
    >
      {/* 产物 */}
      <span className="w-12 shrink-0 text-center text-4xl leading-none">{recipe.emoji}</span>

      {/* 名称 + 奖励 + 材料 */}
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-black leading-snug text-[#8a4a68]">
          {recipe.name}
          {crafted && (
            <span className="ml-1.5 inline-block translate-y-[-1px] rounded-full bg-emerald-100 px-1.5 py-0.5 align-middle text-[9px] font-bold text-emerald-600">
              ✓ 已合成过
            </span>
          )}
        </p>
        <p className="text-[11px] font-bold text-pink-400">
          {recipe.id.startsWith('pz_')
            ? `🧪 炼制得 ${recipe.name} ×1（进提纯剂库存 · ${recipe.id === 'pz_supreme' ? '每次 +25% 纯度' : recipe.id === 'pz_fine' ? '每次 +12% 纯度' : '每次 +5% 纯度'}）`
            : `+${recipe.reward} 时元`}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[11px] leading-relaxed">
          {recipe.mats.map(([id, qty], i) => {
            const info = itemInfo(id)
            const enough = (farm.warehouse[id] ?? 0) >= qty
            return (
              <span key={id} className={enough ? 'font-semibold text-[#c44d7d]' : 'text-gray-400'}>
                {i > 0 && <span className="mr-1 text-gray-300">+</span>}
                {info.emoji}
                {info.name}×{qty}
              </span>
            )
          })}
        </p>
        {/* 追踪中的配方：材料里的子配方可以直接在这里点一下就合成，不用翻去找 */}
        {tracked &&
          recipe.mats.some(([id]) => recipeById(id)) &&
          recipe.mats
            .filter(([id]) => recipeById(id))
            .map(([id, qty]) => {
              const sub = recipeById(id)!
              const has = farm.warehouse[id] ?? 0
              const subReady = recipeMissing(farm.warehouse, sub) === null
              return (
                <div key={id} className="mt-1.5 flex items-center gap-1.5 rounded-xl bg-amber-50/80 px-2.5 py-1.5 ring-1 ring-amber-100">
                  <span className="text-sm">{sub.emoji}</span>
                  <span className="min-w-0 flex-1 truncate text-[10px] font-medium text-[#8a4a68]">
                    子配方·{sub.name}
                    <span className={has >= qty ? 'text-emerald-500' : 'text-gray-400'}>（{has}/{qty}）</span>
                  </span>
                  {has >= qty ? (
                    <span className="text-[10px] font-bold text-emerald-500">已够 ✓</span>
                  ) : (
                    <button
                      disabled={!subReady}
                      onClick={() => onToast(synthesize(who, sub.id).msg)}
                      className={`rounded-full px-2.5 py-1 text-[10px] font-bold transition-transform ${
                        subReady
                          ? 'bg-gradient-to-r from-amber-400 to-orange-400 text-white shadow active:scale-90'
                          : 'bg-gray-100 text-gray-400'
                      }`}
                    >
                      {subReady ? '⚗️ 点我合成' : '缺材料'}
                    </button>
                  )}
                </div>
              )
            })}
      </div>

      {/* 追踪 + 合成 */}
      <div className="flex shrink-0 flex-col items-center gap-1.5">
        <button
          onClick={() => {
            toggleTrack(who, recipe.id)
            onToast(tracked ? `取消追踪「${recipe.name}」` : `🎯 已追踪「${recipe.name}」，种植时会有提示`)
          }}
          className={`rounded-full px-2 py-1 text-[10px] font-bold transition-all active:scale-90 ${
            tracked ? 'bg-pink-100 text-pink-500 ring-1 ring-pink-300' : 'bg-gray-50 text-gray-400 ring-1 ring-gray-200'
          }`}
        >
          {tracked ? '🎯 目标中' : '🎯 追踪'}
        </button>
        <button
          disabled={!ready}
          onClick={() => onToast(synthesize(who, recipe.id).msg)}
          className={`rounded-full px-3.5 py-1.5 text-[11px] font-bold transition-transform ${
            ready
              ? 'bg-gradient-to-r from-amber-400 to-orange-400 text-white shadow shadow-amber-200 active:scale-90'
              : 'bg-gray-100 text-gray-400'
          }`}
        >
          合成
        </button>
      </div>
    </div>
  )
}

/** 工坊风云榜：库存总数 / 合成种类 / 仙品收藏 双人对比（挂在仓库弹窗） */
export function WorkshopRank({ mine, theirs, who, partner }: { mine: FarmOf; theirs: FarmOf; who: string; partner: string }) {
  const stat = (f: FarmOf) => {
    const stock = Object.values(f.warehouse).reduce((s, n) => s + n, 0)
    const craftKinds = Object.keys(f.warehouse).filter((id) => recipeById(id)).length
    const xian = Object.entries(f.warehouse)
      .filter(([id]) => id.startsWith('x_') || id.startsWith('sr') || id.startsWith('xr'))
      .reduce((s, [, n]) => s + n, 0)
    return { stock, craftKinds, xian }
  }
  const a = stat(mine)
  const b = stat(theirs)
  const rows: Array<{ label: string; emoji: string; va: number; vb: number }> = [
    { label: '家财万贯 · 库存总数', emoji: '🧺', va: a.stock, vb: b.stock },
    { label: '巧夺天工 · 合成种类', emoji: '⚗️', va: a.craftKinds, vb: b.craftKinds },
    { label: '仙缘深厚 · 仙品收藏', emoji: '🌟', va: a.xian, vb: b.xian },
  ]
  return (
    <div className="px-4 pb-8 pt-3">
      <div className="mb-2 grid grid-cols-[1fr_auto_auto] items-center gap-2 px-2 text-[11px] font-bold text-gray-400">
        <span>项目</span>
        <span className="w-14 text-center">{who}</span>
        <span className="w-14 text-center">{partner}</span>
      </div>
      {rows.map((r) => {
        const leadA = r.va > r.vb
        const leadB = r.vb > r.va
        return (
          <div key={r.label} className="mb-2 grid grid-cols-[1fr_auto_auto] items-center gap-2 rounded-2xl bg-white px-3 py-3 shadow-sm ring-1 ring-amber-100">
            <span className="text-[12px] font-semibold text-[#8a4a68]">
              {r.emoji} {r.label}
            </span>
            <span className={`w-14 text-center text-sm font-black ${leadA ? 'text-amber-500' : 'text-gray-500'}`}>
              {leadA && '👑'}{r.va}
            </span>
            <span className={`w-14 text-center text-sm font-black ${leadB ? 'text-amber-500' : 'text-gray-500'}`}>
              {leadB && '👑'}{r.vb}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** 合成工坊：配方书（仓库 → 合成工坊 入口打开） */
export default function WorkshopModal({
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
  const trackCount = (farm.tracking ?? []).length
  return (
    <div className="fixed inset-0 z-[75] flex items-end justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex max-h-[86dvh] w-full max-w-md flex-col overflow-hidden rounded-t-3xl bg-gradient-to-b from-amber-50 to-orange-50/60"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between bg-white/80 px-5 py-4 backdrop-blur">
          <span className="text-sm font-bold tracking-widest text-[#c44d7d]">
            ⚗️ 合成工坊
            {trackCount > 0 && (
              <span className="ml-2 rounded-full bg-pink-100 px-2 py-0.5 text-[10px] text-pink-500">
                🎯 追踪中 {trackCount}
              </span>
            )}
          </span>
          <button onClick={onClose} className="text-pink-300 active:text-pink-500">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 pb-8 pt-3">
          {/* 🧪 提纯剂合成线：独立成组，去「提纯」页用得着 */}
          <div className="mb-5">
            <p className="mb-2.5 text-[13px] font-black tracking-wide text-teal-600">🧪 提纯剂 · 一炉一只，玉石提纯用</p>
            {RECIPES.filter((r) => r.id.startsWith('pz_')).map((r) => (
              <RecipeCard key={r.id} recipe={r} farm={farm} who={who} onToast={onToast} />
            ))}
          </div>
          {/* 🌟 仙品秘宝线单独成组：每件合成物需 5 株仙品作物 */}
          <div className="mb-5">
            <p className="mb-2.5 text-[13px] font-black tracking-wide text-fuchsia-600">🌟 仙品秘宝 · 每件需 5 株仙品作物</p>
            {RECIPES.filter((r) => r.id.startsWith('xr')).map((r) => (
              <RecipeCard key={r.id} recipe={r} farm={farm} who={who} onToast={onToast} />
            ))}
          </div>
          {TIER_SECTIONS.map((sec) => (
            <div key={sec.tier} className="mb-5">
              <p className="mb-2.5 text-[13px] font-black tracking-wide text-emerald-600">{sec.title}</p>
              {RECIPES.filter((r) => r.tier === sec.tier && !r.id.startsWith('xr') && !r.id.startsWith('pz_')).map((r) => (
                <RecipeCard key={r.id} recipe={r} farm={farm} who={who} onToast={onToast} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
