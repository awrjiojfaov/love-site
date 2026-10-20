import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, CloudOff, Loader2, Plus, Settings2, X } from 'lucide-react'
import type { User } from './LoginPage'
import { addWheelItem, removeWheelItem, subscribeWheel, MAX_WHEEL_ITEMS, type WheelItem } from '../lib/wheel'
import { firework } from '../lib/confetti'
import wheelRing from '../assets/wheel-ring.webp'
import wheelBg from '../assets/wheel-bg.webp'
import FloatingBack from '../components/FloatingBack'

/** 扇区配色：深紫金系，和秘密空间夜色呼应 */
const PALETTE = [
  ['#7c2d5e', '#a4457f'],
  ['#4c2a85', '#6d3fb5'],
  ['#8a5a18', '#c08a2e'],
  ['#86255a', '#b8377d'],
  ['#3d2a6e', '#57409c'],
  ['#7a3b12', '#a85f24'],
  ['#5e1f47', '#8a3468'],
  ['#2f3d82', '#4a5cb5'],
  ['#93415e', '#c05a80'],
  ['#5b3a8e', '#7f57c2'],
  ['#7c5a1c', '#b08232'],
  ['#6e2450', '#9c3674'],
]

const MAX_LABEL_SEGMENTS = 12 // 扇区超过 12 个时隐藏文字，保持盘面干净

/** 扇形路径（从正上方开始，顺时针） */
function segPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const rad = (d: number) => (d * Math.PI) / 180
  const x1 = cx + r * Math.cos(rad(startDeg))
  const y1 = cy + r * Math.sin(rad(startDeg))
  const x2 = cx + r * Math.cos(rad(endDeg))
  const y2 = cy + r * Math.sin(rad(endDeg))
  const large = endDeg - startDeg > 180 ? 1 : 0
  return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`
}

/** 姿势转盘（秘密空间）：内容双方可增删，华丽金环 + 夜色丝绸背景 */
export default function WheelPage({ user, onBack }: { user: User; onBack: () => void }) {
  const [items, setItems] = useState<WheelItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [manageMode, setManageMode] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [rotation, setRotation] = useState(0)
  const [spinning, setSpinning] = useState(false)
  const [result, setResult] = useState<WheelItem | null>(null)
  const [toast, setToast] = useState('')
  const spinTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = (msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 2600)
  }

  useEffect(() => {
    const timer = setTimeout(() => setLoading(false), 3500)
    const unsub = subscribeWheel(
      (list) => {
        setItems(list)
        setLoading(false)
      },
      (m) => setError(m),
    )
    return () => {
      clearTimeout(timer)
      if (spinTimer.current) clearTimeout(spinTimer.current)
      if (toastTimer.current) clearTimeout(toastTimer.current)
      unsub()
    }
  }, [])

  const n = items.length
  // 每个选项概率 = 1/总数（均分圆盘）
  const seg = n > 0 ? 360 / n : 60
  const usable = n >= 2

  const spin = () => {
    if (!usable || spinning) return
    setSpinning(true)
    setResult(null)
    const target = Math.floor(Math.random() * n)
    // 目标扇区内随机落点（避开分界线 15%）
    const offset = (0.15 + Math.random() * 0.7) * seg
    const wanted = -(target * seg + offset) // 指针在正上方：轮盘需转到的角度（mod 360）
    setRotation((cur) => {
      const delta = ((wanted - cur) % 360 + 360) % 360
      return cur + 360 * 5 + delta
    })
    spinTimer.current = setTimeout(() => {
      setSpinning(false)
      setResult(items[target])
      firework(50, 35)
    }, 4700)
  }

  const addItem = () => {
    const label = newLabel.trim()
    if (!label) return
    if (items.length >= MAX_WHEEL_ITEMS) {
      showToast(`最多 ${MAX_WHEEL_ITEMS} 个选项`)
      return
    }
    if (addWheelItem(user.name, label)) {
      setNewLabel('')
      showToast('🪙 +10 时元已入账')
    } else {
      showToast('已存在相同选项')
    }
  }

  const delItem = (id: string) => {
    removeWheelItem(user.name, id)
    showToast('🪙 -10 时元')
  }

  const segments = useMemo(() => {
    if (usable) return items
    // 占位轮：未添加内容时的空轮盘
    return Array.from({ length: 6 }, (_, i) => ({ id: `ph_${i}`, label: '?' }))
  }, [items, usable])

  const m = segments.length
  const segDeg = usable ? seg : 60
  const SIZE = 300
  const C = SIZE / 2
  const R = SIZE / 2 - 4

  return (
    <div className="relative min-h-dvh overflow-hidden bg-[#1d1029]">
      {/* 夜色丝绸背景 */}
      <img src={wheelBg} alt="" className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-70" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-[#1d1029]/60 via-transparent to-[#1d1029]/85" />

      {/* 顶部栏 */}
      <div className="relative z-10 flex items-center gap-3 px-5 pb-2 pt-6">
        <FloatingBack onBack={onBack} tone="light" />
        <button
          onClick={onBack}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition-transform active:scale-90"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-lg font-bold tracking-[0.3em] text-amber-100 drop-shadow">姿势转盘</h1>
          <p className="text-[11px] text-white/40">转到什么就是什么 · {user.name}</p>
        </div>
        <button
          onClick={() => setManageMode(!manageMode)}
          className={`flex h-9 w-9 items-center justify-center rounded-full backdrop-blur transition-transform active:scale-90 ${
            manageMode ? 'bg-amber-300/30 text-amber-200' : 'bg-white/10 text-white/80'
          }`}
          title="编辑内容"
        >
          <Settings2 className="h-4 w-4" />
        </button>
      </div>

      {/* 提示条 */}
      {toast && (
        <div className="fixed inset-x-0 top-20 z-[60] mx-auto w-fit max-w-[85vw] rounded-full bg-black/70 px-4 py-2 text-center text-xs text-white shadow-xl">
          {toast}
        </div>
      )}

      {error && (
        <div className="relative z-10 mx-5 mt-1 flex items-center gap-2 rounded-2xl bg-amber-500/15 px-4 py-2.5 text-xs text-amber-200">
          <CloudOff className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {loading ? (
        <div className="relative z-10 flex justify-center py-24">
          <Loader2 className="h-6 w-6 animate-spin text-amber-200/60" />
        </div>
      ) : (
        <div className="relative z-10 mx-auto flex max-w-md flex-col items-center px-5 pb-16 pt-4">
          {/* ===== 转盘 ===== */}
          <div className="relative aspect-square w-[88vw] max-w-[360px]">
            {/* 金色华丽外环（黑底滤除） */}
            <img
              src={wheelRing}
              alt=""
              className="pointer-events-none absolute inset-0 z-20 h-full w-full mix-blend-screen"
              draggable={false}
            />
            {/* 顶部指针 */}
            <div className="absolute -top-1 left-1/2 z-30 -translate-x-1/2">
              <div
                className="h-0 w-0 border-x-[11px] border-t-[20px] border-x-transparent border-t-amber-300"
                style={{ filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.6))' }}
              />
            </div>

            {/* 旋转盘面（SVG 尺寸占外环内孔 ~64%） */}
            <div
              className="absolute left-1/2 top-1/2 z-10 aspect-square w-[64%] -translate-x-1/2 -translate-y-1/2"
              style={{
                transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
                transition: spinning ? 'transform 4.6s cubic-bezier(0.12, 0.8, 0.08, 1)' : 'none',
              }}
            >
              <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="h-full w-full drop-shadow-[0_0_18px_rgba(0,0,0,0.55)]">
                <defs>
                  {segments.map((_, i) => {
                    const [c1, c2] = usable ? PALETTE[i % PALETTE.length] : ['#3a2a4d', '#4a3560']
                    return (
                      <linearGradient key={i} id={`wg${i}`} x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0%" stopColor={c1} />
                        <stop offset="100%" stopColor={c2} />
                      </linearGradient>
                    )
                  })}
                </defs>
                {segments.map((it, i) => {
                  const start = -90 + i * segDeg
                  const end = start + segDeg
                  const mid = start + segDeg / 2
                  const midRad = (mid * Math.PI) / 180
                  const tx = C + R * 0.62 * Math.cos(midRad)
                  const ty = C + R * 0.62 * Math.sin(midRad)
                  return (
                    <g key={it.id}>
                      <path d={segPath(C, C, R, start, end)} fill={`url(#wg${i})`} stroke="rgba(255,215,140,0.35)" strokeWidth="1.5" />
                      {m <= MAX_LABEL_SEGMENTS && (
                        <text
                          x={tx}
                          y={ty}
                          fill="#fff"
                          fontSize={m > 8 ? 13 : 15}
                          fontWeight="700"
                          textAnchor="middle"
                          dominantBaseline="middle"
                          transform={`rotate(${mid + 90}, ${tx}, ${ty})`}
                          style={{ textShadow: '0 1px 3px rgba(0,0,0,0.7)' }}
                        >
                          {it.label.length > 6 ? `${it.label.slice(0, 6)}…` : it.label}
                        </text>
                      )}
                    </g>
                  )
                })}
                {/* 内圈金线 */}
                <circle cx={C} cy={C} r={R - 1} fill="none" stroke="rgba(255,215,140,0.5)" strokeWidth="2" />
              </svg>
            </div>

            {/* 中心 GO 按钮 */}
            <button
              onClick={spin}
              disabled={!usable || spinning}
              className={`absolute left-1/2 top-1/2 z-30 flex h-[17%] w-[17%] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-sm font-black tracking-widest text-[#5a3a08] shadow-[0_0_20px_rgba(255,200,100,0.55),inset_0_2px_4px_rgba(255,255,255,0.6)] transition-transform ${
                usable && !spinning ? 'bg-gradient-to-br from-amber-200 via-amber-300 to-amber-400 active:scale-90' : 'bg-gradient-to-br from-amber-200/50 to-amber-400/50'
              }`}
            >
              {spinning ? '···' : 'GO'}
            </button>
          </div>

          {!usable && (
            <p className="mt-5 text-center text-[11px] tracking-widest text-white/35">先添加至少 2 个选项才能开转</p>
          )}

          {/* ===== 内容管理 ===== */}
          <div className="mt-4 w-full rounded-3xl border border-white/10 bg-white/5 p-4 backdrop-blur-sm">
            <div className="mb-3 flex gap-2">
              <input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addItem()}
                maxLength={12}
                placeholder={items.length >= MAX_WHEEL_ITEMS ? `最多 ${MAX_WHEEL_ITEMS} 个` : '添加新选项（+10 时元）…'}
                disabled={items.length >= MAX_WHEEL_ITEMS}
                className="min-w-0 flex-1 rounded-2xl border border-white/15 bg-white/10 px-4 py-2.5 text-sm text-amber-50 outline-none placeholder:text-white/30 focus:border-amber-300/50"
              />
              <button
                onClick={addItem}
                disabled={!newLabel.trim() || items.length >= MAX_WHEEL_ITEMS}
                className="flex items-center gap-1 rounded-2xl bg-gradient-to-r from-amber-300 to-amber-400 px-4 py-2.5 text-sm font-bold text-[#5a3a08] shadow transition-transform active:scale-95 disabled:opacity-40"
              >
                <Plus className="h-4 w-4" />
                添加
              </button>
            </div>
            {items.length === 0 ? (
              <p className="py-3 text-center text-xs text-white/30">还没有选项，添加几个让转盘转起来 ✨</p>
            ) : (
              <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
                {items.map((it) => (
                  <span
                    key={it.id}
                    className="flex items-center gap-1.5 rounded-full border border-amber-200/20 bg-white/10 px-3 py-1.5 text-xs font-medium text-amber-50"
                  >
                    {it.label}
                    {manageMode && (
                      <button onClick={() => delItem(it.id)} className="text-rose-300 active:text-rose-400">
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}
            {manageMode && (
              <p className="mt-3 text-center text-[10px] text-white/25">
                点 × 删除（-10 时元）
              </p>
            )}
          </div>
        </div>
      )}

      {/* ===== 结果弹窗 ===== */}
      {result && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 px-8 backdrop-blur-sm" onClick={() => setResult(null)}>
          <div
            className="w-full max-w-xs rounded-3xl border border-amber-300/30 bg-gradient-to-b from-[#3a1f4d] to-[#2b1638] p-7 text-center shadow-[0_0_40px_rgba(255,190,100,0.25)]"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-3xl">🎉</p>
            <p className="mt-2 text-xs tracking-[0.4em] text-amber-200/70">今晚就它了</p>
            <p className="mt-3 text-2xl font-black tracking-wider text-amber-100 drop-shadow">{result.label}</p>
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setResult(null)}
                className="flex-1 rounded-2xl border border-white/15 py-2.5 text-xs text-white/60 transition-transform active:scale-95"
              >
                收好
              </button>
              <button
                onClick={() => {
                  setResult(null)
                  spin()
                }}
                className="flex-1 rounded-2xl bg-gradient-to-r from-amber-300 to-amber-400 py-2.5 text-xs font-bold text-[#5a3a08] shadow transition-transform active:scale-95"
              >
                再来一次
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
