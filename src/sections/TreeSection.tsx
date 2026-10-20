import { useEffect, useRef, useState } from 'react'
import { Sprout, Gift, X, Check } from 'lucide-react'
import {
  nextStageXp,
  stageOf,
  subscribeTree,
  DAILY_CAP_PER_PERSON,
  XP_MAX,
  STAGE_XP,
  type TreeState,
} from '../lib/tree'
import { heartRain, bigCelebrate } from '../lib/confetti'
import {
  subscribeFarm,
  doCheckin,
  hasCheckedIn,
  CHECKIN_STONE_COUNT,
  CHECKIN_REAGENT_COUNT,
  CROPS,
  type FarmOf,
} from '../lib/farm'
import tree1 from '../assets/tree-1.webp'
import tree2 from '../assets/tree-2.webp'
import tree3 from '../assets/tree-3.webp'
import tree4 from '../assets/tree-4.webp'
import tree5 from '../assets/tree-5.webp'
import tree6 from '../assets/tree-6.webp'
import tree7 from '../assets/tree-7.webp'

const TREE_IMGS = [tree1, tree2, tree3, tree4, tree5, tree6, tree7]
const NAMES: string[] = ['萌芽', '幼苗', '小树', '开枝', '初绽', '盛放', '满开']

/** 阶段展示宽度：树越大，占地越大，成长肉眼可见 */
const STAGE_WIDTH = ['w-36', 'w-40', 'w-44', 'w-52', 'w-60', 'w-72', 'w-80']

function todayTotal(s: TreeState): number {
  const d = new Date()
  const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
  if (s.day !== key) return 0
  return Object.values(s.dayBy).reduce((a, b) => a + b, 0)
}

/** 今日日期串（同 farm/tree 口径） */
function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** 爱情树：两人共养的樱花树，登录/种植/打分都会让它长大 */
export default function TreeSection({ who }: { who: string }) {
  const [s, setS] = useState<TreeState>({ total: 0, day: '', dayBy: {}, loginDay: {}, contrib: {} })
  const [farms, setFarms] = useState<Record<string, FarmOf>>({})
  const [panel, setPanel] = useState(false)   // 打卡面板
  const [flash, setFlash] = useState<string | null>(null) // 打卡结果
  const [msg, setMsg] = useState<string | null>(null)

  // 记录上一次可见的形态 key（stage + aura），升级时触发庆祝
  const prevKey = useRef<number | null>(null)

  useEffect(() => subscribeTree((t) => {
    const cur = stageOf(t.total)
    const key = cur.stage * 10 + cur.aura
    const before = prevKey.current
    prevKey.current = key
    // 首次进入不庆祝，只在真正的形态升级时庆祝
    if (before !== null && key > before) {
      if (cur.aura === 2 || cur.stage === STAGE_XP.length) bigCelebrate()
      else heartRain(70)
    }
    setS(t)
  }), [])

  // 订阅农场：打卡状态（checkinDay）存在农场对象里
  useEffect(() => subscribeFarm((f) => setFarms(f)), [])

  useEffect(() => {
    if (!msg) return
    const id = setTimeout(() => setMsg(null), 2600)
    return () => clearTimeout(id)
  }, [msg])

  const { stage, aura } = stageOf(s.total)
  const next = nextStageXp(s.total)
  const today = todayTotal(s)

  const checkedIn = hasCheckedIn(farms, who)

  const onCheckin = () => {
    const r = doCheckin(who)
    setMsg(r.msg)
    if (r.ok) {
      setFlash(r.msg)
      bigCelebrate()
    }
  }

  // 进度：到下一形态（满形态后到光彩等级，都满了就 100%）
  const prevXp = stage > 1 ? STAGE_XP[stage - 1] : 0
  const progress = next === null ? 1 : Math.min(1, (s.total - prevXp) / (next - prevXp))

  // 特殊种子清单（面板里展示「各一个」）
  const fuseCrops = CROPS.filter((c) => c.fusionOnly)

  return (
    <div className="relative mb-10 flex flex-col items-center">
      {msg && (
        <div className="pointer-events-none fixed inset-x-0 top-20 z-40 flex justify-center px-6">
          <div className="max-w-xs rounded-2xl bg-pink-600/90 px-4 py-2.5 text-center text-xs leading-relaxed text-white shadow-lg">
            {msg}
          </div>
        </div>
      )}

      {/* 标题行 */}
      <div className="mb-1 flex items-center gap-2">
        <Sprout className="h-4 w-4 text-emerald-400" />
        <span className="text-sm font-semibold tracking-widest text-[#c44d7d]">我们的樱花树</span>
        <span className="rounded-full bg-gradient-to-r from-pink-400 to-rose-400 px-2.5 py-0.5 text-[10px] font-bold text-white shadow-sm">
          {NAMES[stage - 1]}
          {stage < STAGE_XP.length && (aura === 1 ? ' · 繁茂' : aura === 2 ? ' · 永恒' : '')}
        </span>
      </div>

      {/* 树图 + 挂件：打卡礼物挂在树梢右侧 */}
      <div className="relative">
        <img
          src={TREE_IMGS[stage - 1]}
          alt={`樱花树 · ${NAMES[stage - 1]}`}
          className={`${STAGE_WIDTH[stage - 1]} select-none transition-all duration-1000 ${
            aura > 0 ? 'drop-shadow-[0_0_28px_rgba(255,170,200,0.65)]' : ''
          }`}
          style={{
            maskImage: 'radial-gradient(ellipse 72% 68% at center, black 52%, transparent 76%)',
            WebkitMaskImage: 'radial-gradient(ellipse 72% 68% at center, black 52%, transparent 76%)',
          }}
          draggable={false}
        />

        {/* 每日打卡：树上的礼物铃铛 */}
        <button
          onClick={() => setPanel(true)}
          aria-label="每日打卡"
          className="absolute right-0 top-1 z-10 flex flex-col items-center active:scale-95"
        >
          <span className={`relative flex h-12 w-12 items-center justify-center rounded-full shadow-lg transition-all ${
            checkedIn
              ? 'bg-gradient-to-br from-pink-200 to-rose-200 shadow-pink-200/70'
              : 'animate-bounce bg-gradient-to-br from-rose-400 to-pink-500 shadow-rose-300/80'
          }`}>
            <Gift className={`h-6 w-6 ${checkedIn ? 'text-rose-400' : 'text-white'}`} />
            {!checkedIn && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-amber-400 text-[9px] font-black text-white shadow">
                !
              </span>
            )}
            {checkedIn && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-400 text-white shadow">
                <Check className="h-3 w-3" />
              </span>
            )}
          </span>
          <span className={`mt-0.5 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[9px] font-bold shadow-sm ${
            checkedIn ? 'bg-white/80 text-rose-400' : 'bg-white/90 text-rose-500'
          }`}>
            {checkedIn ? '今日已打卡' : '每日打卡'}
          </span>
        </button>
      </div>

      {/* 经验进度 */}
      <div className="-mt-3 w-full max-w-[240px]">
        <div className="h-2 overflow-hidden rounded-full bg-pink-100/80 shadow-inner">
          <div
            className="h-full rounded-full bg-gradient-to-r from-pink-300 via-rose-400 to-pink-400 transition-all duration-700"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[10px] text-pink-300">
          <span className="tabular-nums">
            经验 {s.total}{next !== null ? ` / ${next}` : ` · 已满 ${XP_MAX}`}
          </span>
          <span className="tabular-nums">
            今日 +{today} / {DAILY_CAP_PER_PERSON * 2}
          </span>
        </div>
      </div>

      {/* 打卡面板 */}
      {panel && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 backdrop-blur-sm" onClick={() => { setPanel(false); setFlash(null) }}>
          <div className="max-h-[80dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-sm font-bold text-rose-500">
                <Gift className="h-4 w-4" /> 樱花树 · 每日打卡
                <span className="rounded-full bg-pink-100 px-2 py-0.5 text-[9px] text-rose-500">{todayKey()}</span>
              </p>
              <button onClick={() => { setPanel(false); setFlash(null) }}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-pink-50 text-rose-400 active:scale-95">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* 奖励清单 */}
            <div className="mt-3 space-y-2">
              <div className="flex items-center gap-3 rounded-2xl bg-gradient-to-r from-amber-50 to-orange-50 p-3 ring-1 ring-amber-100">
                <span className="text-2xl">🪨</span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold text-amber-700">帝王料 ×{CHECKIN_STONE_COUNT}</p>
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-2xl bg-gradient-to-r from-teal-50 to-cyan-50 p-3 ring-1 ring-teal-100">
                <span className="text-2xl">🔥</span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold text-teal-700">龙涎提纯剂 ×{CHECKIN_REAGENT_COUNT}</p>
                </div>
              </div>
              <div className="rounded-2xl bg-gradient-to-r from-emerald-50 to-lime-50 p-3 ring-1 ring-emerald-100">
                <p className="mb-1.5 text-xs font-bold text-emerald-700">特殊种子 · 每种各 1 个</p>
                <div className="flex flex-wrap gap-1.5">
                  {fuseCrops.map((c) => (
                    <span key={c.id} className="flex items-center gap-1 rounded-full bg-white/80 px-2 py-0.5 text-[10px] text-emerald-600 shadow-sm">
                      {c.emoji}{c.name}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {flash && (
              <div className="mt-3 rounded-2xl bg-gradient-to-r from-rose-400 to-pink-400 p-3 text-center text-xs font-bold text-white shadow-lg shadow-rose-200">
                {flash}
              </div>
            )}

            <button
              onClick={onCheckin}
              disabled={checkedIn}
              className={`mt-4 flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-bold tracking-widest text-white shadow-lg transition-all active:scale-[0.98] ${
                checkedIn
                  ? 'bg-emerald-200 opacity-80 shadow-emerald-100'
                  : 'bg-gradient-to-r from-rose-400 via-pink-400 to-fuchsia-400 shadow-rose-200'
              }`}
            >
              {checkedIn ? <><Check className="h-4 w-4" /> 今天已经打过卡啦</> : <><Gift className="h-4 w-4" /> 打卡领取今日礼物</>}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
