import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Brush,
  Check,
  ChevronLeft,
  Coins,
  Eraser,
  Lightbulb,
  Palette,
  PartyPopper,
  RotateCcw,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import {
  subscribeDG,
  startDGRound,
  dgNewWord,
  dgEndRound,
  dgGuess,
  dgAddStroke,
  dgUndoStroke,
  dgClearCanvas,
  setDGLocalName,
  REWARD,
  type DGState,
  type DGCanvas,
  type DGStroke,
} from '../lib/drawguess'
import { partnerOf } from '../lib/space'
import type { User } from './LoginPage'

const COLORS = [
  '#3d2b3d', // 墨
  '#b91c1c', // 朱砂
  '#e14b64', // 桃红
  '#f59e0b', // 橘
  '#facc15', // 鹅黄
  '#10b981', // 松绿
  '#14b8a6', // 青碧
  '#3b82f6', // 天青
  '#8b5cf6', // 紫
  '#ec4899', // 品红
]
const ERASER = '#ffffff'
const SIZES = [3, 6, 10, 16, 24]
const MAX_COORD = 1000 // 笔画坐标归一化到 0~1000

/** 猜中时的满屏小庆祝 */
function ConfettiBurst() {
  const pieces = useMemo(
    () =>
      Array.from({ length: 22 }, (_, i) => ({
        left: `${(i * 47) % 100}%`,
        delay: `${(i % 7) * 0.12}s`,
        emoji: ['🎉', '💖', '✨', '🎨', '💝', '⭐'][i % 6],
        dur: `${2.2 + (i % 5) * 0.4}s`,
      })),
    [],
  )
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {pieces.map((p, i) => (
        <span
          key={i}
          className="absolute top-[-8%] animate-[dg-fall_ease-in_forwards]"
          style={{ left: p.left, animationDelay: p.delay, animationDuration: p.dur }}
        >
          {p.emoji}
        </span>
      ))}
    </div>
  )
}

export default function DrawGuessPage({ user, onBack }: { user: User; onBack: () => void }) {
  const [dgState, setDGState] = useState<DGState | null>(null)
  const [dgCanvas, setDGCanvas] = useState<DGCanvas>({ v: 0, strokes: [] })
  const [error, setError] = useState('')
  const [color, setColor] = useState(COLORS[1])
  const [size, setSize] = useState(SIZES[1])
  const [guessInput, setGuessInput] = useState('')
  const [starting, setStarting] = useState(false)
  const [showSolved, setShowSolved] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const drawingRef = useRef(false)
  const activeIdRef = useRef<number | null>(null) // 正在画的那一指，其他手指一律不认（防斜对角乱连线）
  const redrawRef = useRef<() => void>(() => {}) // 永远指向最新 redraw，resize 只挂一次监听也不怕闭包锁在首帧
  const livePtsRef = useRef<number[]>([])
  const liveStrokeRef = useRef<{ color: string; size: number; pts: number[] } | null>(null)
  // 一笔内锁定的画布几何：起笔那一刻的 getBoundingClientRect（含 left/top/width/height）。
  // 采集坐标（clientX-left）与绘制位图（cssW=cssH 归一化）必须共用同一套，否则漂移。
  const geomRef = useRef<DOMRect | null>(null)

  const partner = partnerOf(user.name)

  useEffect(() => {
    setDGLocalName(user.name)
    const u = subscribeDG(
      (s) => {
        setDGState((prev) => {
          // 从未猜中 → 猜中：弹出庆祝层
          if (prev && prev.winner === null && s.winner !== null) setShowSolved(true)
          return s
        })
      },
      (c) => setDGCanvas(c),
      setError,
    )
    return () => u()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const phase = dgState?.phase ?? 'idle'
  const drawer = dgState?.drawer ?? ''
  const amDrawer = phase === 'drawing' && drawer === user.name
  const solved = !!dgState?.winner

  /* ---------- 画布渲染 ---------- */

  const drawStrokes = (
    ctx: CanvasRenderingContext2D,
    strokes: DGStroke[],
    cssW: number,
    cssH: number,
  ) => {
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    // X/Y 直接落到 CSS 像素（ctx 已按 dpr 缩放，见 redraw），与采集端归一化严格闭环
    const X = (v: number) => (v / MAX_COORD) * cssW
    const Y = (v: number) => (v / MAX_COORD) * cssH
    for (const s of strokes) {
      // 单点轻点：画一个圆点（旧逻辑直接丢弃，手机上点不出小点）
      if (s.pts.length === 2) {
        ctx.fillStyle = s.color
        ctx.beginPath()
        ctx.arc(X(s.pts[0]), Y(s.pts[1]), Math.max(s.size / 2, 1.5), 0, Math.PI * 2)
        ctx.fill()
        continue
      }
      if (s.pts.length < 4) continue
      ctx.strokeStyle = s.color
      ctx.lineWidth = s.size
      // 中点二次贝塞尔平滑：笔迹圆润不折线
      ctx.beginPath()
      ctx.moveTo(X(s.pts[0]), Y(s.pts[1]))
      // pts 是 [x0,y0,x1,y1,...]：偶数下标是 x、奇数下标才是 y，
      // 控制点取 (pts[i], pts[i+1])，中点取两相邻点各自分量的平均（i+1 / i+3 是 y）
      for (let i = 2; i < s.pts.length - 2; i += 2) {
        const cx = X(s.pts[i])
        const cy = Y(s.pts[i + 1])
        const mx = (cx + X(s.pts[i + 2])) / 2
        const my = (cy + Y(s.pts[i + 3])) / 2
        ctx.quadraticCurveTo(cx, cy, mx, my)
      }
      ctx.lineTo(X(s.pts[s.pts.length - 2]), Y(s.pts[s.pts.length - 1]))
      ctx.stroke()
    }
  }

  const redraw = () => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    // 绘画中冻结几何：一手正在画时，位图尺寸与采集基准都不许变，
    // 否则已画笔画按新尺寸重算 → 笔迹整体漂移。几何只在「笔与笔之间」更新。
    const cssW = drawingRef.current && geomRef.current ? geomRef.current.width : wrap.clientWidth
    const cssH = drawingRef.current && geomRef.current ? geomRef.current.height : wrap.clientHeight
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr)
      canvas.height = Math.round(cssH * dpr)
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0) // 建立 CSS 像素坐标系，位图即 css*dpr
    ctx.clearRect(0, 0, cssW, cssH)
    drawStrokes(ctx, dgCanvas.strokes, cssW, cssH)
    // live stroke
    if (liveStrokeRef.current) {
      drawStrokes(
        ctx,
        [{ id: 'live', who: user.name, color: liveStrokeRef.current.color, size: liveStrokeRef.current.size, pts: liveStrokeRef.current.pts, ts: 0 }],
        cssW,
        cssH,
      )
    }
  }

  redrawRef.current = redraw

  // 笔画变化 / 窗口尺寸变化 → 重绘
  useEffect(() => {
    redraw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dgCanvas])

  useEffect(() => {
    const onResize = () => redrawRef.current()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /* ---------- 作画（仅画师） ---------- */

  const onPointerDown = (e: React.PointerEvent) => {
    if (!amDrawer || solved) return
    // 手机上握机的另一根手指也会点到画布：已有一指在画时，第二指直接忽略，
    // 否则它的坐标会被拼进当前笔画 → 一落笔就从斜对角拉一条直线。
    // 例外：当前笔画还只有落笔那一个点，说明前一指可能丢了 pointerup（掉线），
    // 这时交给新指接管，不然整幅画再也画不动。
    if (activeIdRef.current !== null && activeIdRef.current !== e.pointerId) {
      // livePtsRef 存的是 [x0,y0,x1,y1,...] 坐标元素数组，1 个点 = 2 个元素。
      // 只有「还只有落笔那 1 个点」(length<=2) 才交给新指接管；否则拒绝，防斜对角乱连线。
      if (livePtsRef.current.length > 2) return
    }
    e.preventDefault()
    canvasRef.current?.setPointerCapture(e.pointerId)
    activeIdRef.current = e.pointerId
    drawingRef.current = true
    // 一笔内锁定几何：采集与绘制共用这一套 rect，杜绝漂移
    const rect = canvasRef.current?.getBoundingClientRect()
    geomRef.current = rect ?? null
    if (rect && rect.width > 0 && rect.height > 0) {
      const x = Math.max(0, Math.min(MAX_COORD, Math.round(((e.clientX - rect.left) / rect.width) * MAX_COORD)))
      const y = Math.max(0, Math.min(MAX_COORD, Math.round(((e.clientY - rect.top) / rect.height) * MAX_COORD)))
      livePtsRef.current = [x, y]
      liveStrokeRef.current = { color, size, pts: livePtsRef.current }
    } else {
      livePtsRef.current = []
      liveStrokeRef.current = null
    }
    redraw()
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drawingRef.current || !liveStrokeRef.current) return
    // 只认起笔的那一指（另一指在画布上移动/握机抖动都不算数）
    if (e.pointerId !== activeIdRef.current) return
    const pts = livePtsRef.current
    // 一笔内用起笔那一刻锁定的几何：中途页面滚动/键盘弹出会改变位置，
    // 每次 move 重读会让同一笔的坐标系前后不一致，笔画整体歪掉
    const geom = geomRef.current
    if (!geom || geom.width <= 0 || geom.height <= 0) return
    // 只用主事件的 clientX/clientY（浏览器保证正确、与 getBoundingClientRect 同视口坐标系）。
    // 历史教训：getCoalescedEvents() 在安卓 WebView 上坐标不可靠（陈旧/错位），
    // 且它不含当前帧的 native 事件本身，会把跳变坐标 push 进 pts → 两点之间连成斜线。
    const native = e.nativeEvent
    const x = Math.max(0, Math.min(MAX_COORD, Math.round(((native.clientX - geom.left) / geom.width) * MAX_COORD)))
    const y = Math.max(0, Math.min(MAX_COORD, Math.round(((native.clientY - geom.top) / geom.height) * MAX_COORD)))
    const lastX = pts[pts.length - 2]
    const lastY = pts[pts.length - 1]
    if (Math.abs(x - lastX) + Math.abs(y - lastY) < 5) return // 太近的采样点跳过，给 MQTT 省流量
    pts.push(x, y)
    redraw()
  }

  const onPointerUp = (e?: React.PointerEvent) => {
    if (!drawingRef.current) return
    // 别的手指抬起/离开不结束这一笔
    if (e && e.pointerId !== activeIdRef.current) return
    drawingRef.current = false
    activeIdRef.current = null
    geomRef.current = null
    const live = liveStrokeRef.current
    liveStrokeRef.current = null
    if (live && live.pts.length >= 2) {
      dgAddStroke(user.name, { color: live.color, size: live.size, pts: live.pts })
    }
    redraw()
  }

  /* ---------- 操作 ---------- */

  const handleStart = async () => {
    setStarting(true)
    try {
      await startDGRound(user.name)
    } finally {
      setStarting(false)
    }
  }

  const handleGuess = () => {
    const text = guessInput.trim()
    if (!text) return
    if (dgGuess(user.name, text)) setGuessInput('')
    else setError('这局好像还没开始，等画师开新局吧')
  }

  const wordDisplay = dgState?.word ?? ''

  return (
    <div className="relative flex min-h-dvh flex-col bg-gradient-to-b from-[#fff5f8] via-[#fdeef6] to-[#fae3ef]">
      {/* 顶部导航 */}
      <div className="sticky top-0 z-10 flex items-center gap-3 bg-white/70 px-4 pb-3 pt-4 shadow-sm shadow-pink-100 backdrop-blur-md">
        <button
          onClick={onBack}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white shadow-md transition-transform active:scale-95"
        >
          <ChevronLeft className="h-5 w-5 text-[#c44d7d]" />
        </button>
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-violet-400 to-fuchsia-400 shadow-md shadow-violet-200">
          <Palette className="h-5 w-5 text-white" />
        </div>
        <div className="flex-1">
          <p className="text-[15px] font-bold tracking-wider text-[#c44d7d]">你画我猜</p>
          <p className="text-[11px] text-pink-300">
            {phase === 'idle'
              ? '千道难题 · 一人画一人猜'
              : solved
                ? `答案：${wordDisplay}`
                : amDrawer
                  ? '你是画师，画出答案吧'
                  : `${drawer} 正在作画，快猜！`}
          </p>
        </div>
      </div>

      {error && <p className="bg-red-50 px-4 py-2 text-center text-xs text-red-400">{error}</p>}

      {phase === 'idle' ? (
        /* ============ 待机页 ============ */
        <div className="flex flex-1 flex-col items-center justify-center px-8 pb-16">
          <div className="relative mb-8">
            <div className="flex h-24 w-24 items-center justify-center rounded-[2rem] bg-gradient-to-br from-violet-400 via-fuchsia-400 to-pink-400 shadow-2xl shadow-fuchsia-200">
              <Brush className="h-12 w-12 text-white" />
            </div>
            <span className="absolute -right-3 -top-3 animate-bounce text-2xl">🎨</span>
            <span className="absolute -bottom-2 -left-4 animate-pulse text-2xl">💖</span>
          </div>
          <p
            className="text-2xl tracking-[0.25em] text-[#c44d7d]"
            style={{ fontFamily: "'Ma Shan Zheng', 'STKaiti', 'KaiTi', cursive" }}
          >
            你画我猜
          </p>
          <p className="mt-3 text-center text-xs leading-relaxed tracking-wider text-pink-400">
            从千道日常难题里随机抽一题，画师悄悄看答案作画
            <br />
            对方边看边猜，不限次数，猜中奖励 {REWARD} 时元
          </p>

          <button
            onClick={handleStart}
            disabled={starting}
            className="mt-10 flex items-center gap-2 rounded-full bg-gradient-to-r from-violet-400 via-fuchsia-400 to-pink-400 px-10 py-4 text-base font-bold tracking-[0.2em] text-white shadow-xl shadow-fuchsia-200 transition-all active:scale-95 disabled:opacity-60"
          >
            {starting ? (
              <>
                <Sparkles className="h-5 w-5 animate-spin" />
                抽题中…
              </>
            ) : (
              <>
                <Brush className="h-5 w-5" />
                我来画！
              </>
            )}
          </button>

          {partner && (
            <p className="mt-4 text-[11px] tracking-widest text-pink-300">{partner} 负责猜</p>
          )}

          {dgState && dgState.round > 0 && (
            <div className="mt-10 w-full max-w-xs rounded-2xl bg-white/70 p-4 text-center shadow-md shadow-pink-100">
              <p className="text-[11px] tracking-widest text-pink-300">已经玩过 {dgState.round} 局啦</p>
            </div>
          )}
        </div>
      ) : (
        /* ============ 对局页 ============ */
        <div className="flex flex-1 flex-col px-4 pb-4 pt-3">
          {/* 题目卡：画师看答案，猜的人看提示 */}
          <div
            className={`mb-3 flex items-center gap-3 rounded-2xl px-4 py-3 shadow-md ${
              solved
                ? 'bg-gradient-to-r from-emerald-400 to-teal-400 shadow-emerald-200'
                : amDrawer
                  ? 'bg-gradient-to-r from-violet-400 to-fuchsia-400 shadow-violet-200'
                  : 'bg-white shadow-pink-100'
            }`}
          >
            {solved ? (
              <>
                <PartyPopper className="h-6 w-6 shrink-0 text-white" />
                <div className="flex-1">
                  <p className="text-sm font-bold text-white">
                    {dgState?.winner} 猜中了！答案就是「{wordDisplay}」
                  </p>
                  <p className="mt-0.5 flex items-center gap-1 text-xs text-white/90">
                    <Coins className="h-3.5 w-3.5" />
                    {REWARD} 时元奖励已入账
                  </p>
                </div>
              </>
            ) : amDrawer ? (
              <>
                <Lightbulb className="h-6 w-6 shrink-0 text-white" />
                <div className="flex-1">
                  <p className="text-sm font-bold tracking-wider text-white">
                    你的题目：<span className="text-lg">{wordDisplay}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-white/85">别让 TA 看到屏幕哦～</p>
                </div>
                <button
                  onClick={() => void dgNewWord(user.name)}
                  className="flex items-center gap-1 rounded-full bg-white/25 px-3 py-1.5 text-xs font-bold text-white backdrop-blur transition-transform active:scale-95"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  换题
                </button>
              </>
            ) : (
              <>
                <Lightbulb className="h-6 w-6 shrink-0 text-amber-400" />
                <div className="flex-1">
                  <p className="text-sm font-bold tracking-wider text-[#c44d7d]">
                    题目是：<span className="text-lg tracking-[0.3em]">？</span>
                    <span className="ml-2 text-xs font-normal text-pink-300">{dgState?.word.length ?? 0} 个字</span>
                  </p>
                </div>
              </>
            )}
          </div>

          {/* 画布 */}
          <div
            ref={wrapRef}
            className="relative w-full flex-1 touch-none overflow-hidden rounded-3xl bg-white shadow-lg shadow-pink-100 ring-1 ring-pink-100"
            style={{ minHeight: '280px' }}
          >
            <canvas
              ref={canvasRef}
              className={`absolute inset-0 h-full w-full ${amDrawer && !solved ? 'cursor-crosshair' : ''}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onPointerLeave={onPointerUp}
            />
            {!amDrawer && !solved && (
              <div className="pointer-events-none absolute bottom-2 right-3 text-[10px] tracking-widest text-pink-200">
                {drawer} 作画中 ✏️
              </div>
            )}
            {amDrawer && dgCanvas.strokes.length === 0 && !solved && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <p className="text-xs tracking-[0.3em] text-pink-200">在这里作画 ✏️</p>
              </div>
            )}
          </div>

          {/* 画师工具栏：两行式，手机上不再挤成一团 */}
          {amDrawer && !solved && (
            <div className="mt-3 flex flex-col gap-2 rounded-2xl bg-white/80 px-3 py-2.5 shadow-md shadow-pink-100 backdrop-blur">
              <div className="flex items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  {COLORS.map((c) => (
                    <button
                      key={c}
                      onClick={() => setColor(c)}
                      aria-label={`画笔 ${c}`}
                      className={`h-6 w-6 rounded-full shadow-inner transition-transform active:scale-90 ${
                        color === c ? 'ring-2 ring-offset-2 ring-pink-400 ring-offset-white' : ''
                      }`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
                <button
                  onClick={() => setColor(ERASER)}
                  title="橡皮擦"
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white shadow-inner transition-transform active:scale-90 ${
                    color === ERASER ? 'ring-2 ring-offset-2 ring-pink-400 ring-offset-white' : ''
                  }`}
                >
                  <Eraser className="h-4 w-4 text-pink-400" />
                </button>
              </div>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                  {SIZES.map((s) => (
                    <button
                      key={s}
                      onClick={() => setSize(s)}
                      aria-label={`笔宽 ${s}`}
                      className={`flex h-8 w-8 items-center justify-center rounded-full transition-transform active:scale-90 ${
                        size === s ? 'bg-pink-100 ring-1 ring-pink-300' : ''
                      }`}
                    >
                      <span
                        className={`rounded-full ${color === ERASER ? 'bg-pink-300' : 'bg-[#3d2b3d]'}`}
                        style={{ width: Math.min(s + 4, 20), height: Math.min(s + 4, 20) }}
                      />
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => dgUndoStroke(user.name)}
                    title="撤销一笔"
                    className="flex h-8 w-8 items-center justify-center rounded-full text-pink-400 transition-transform active:scale-90"
                  >
                    <Undo2 className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => {
                      if (window.confirm('清空画布重画吗？')) dgClearCanvas(user.name)
                    }}
                    title="清空画布"
                    className="flex h-8 w-8 items-center justify-center rounded-full text-red-400 transition-transform active:scale-90"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 猜题区（猜的人） */}
          {!amDrawer && !solved && (
            <div className="mt-3">
              <div className="flex items-center gap-2">
                <input
                  value={guessInput}
                  onChange={(e) => setGuessInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleGuess()}
                  placeholder="你觉得画的是什么？"
                  maxLength={20}
                  className="h-11 flex-1 rounded-full border border-pink-200 bg-white px-4 text-[15px] text-[#6b3a52] outline-none placeholder:text-pink-300 focus:border-pink-400"
                />
                <button
                  onClick={handleGuess}
                  disabled={!guessInput.trim()}
                  className="flex h-11 items-center gap-1 rounded-full bg-gradient-to-r from-violet-400 to-fuchsia-400 px-5 text-sm font-bold text-white shadow-lg shadow-violet-200 transition-all active:scale-95 disabled:opacity-40"
                >
                  <Check className="h-4 w-4" />
                  猜！
                </button>
              </div>
              {/* 猜测记录 */}
              {dgState && dgState.guesses.length > 0 && (
                <div className="mt-2.5 flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
                  {[...dgState.guesses].reverse().map((g) => (
                    <span
                      key={g.id}
                      className={`rounded-full px-2.5 py-1 text-xs shadow-sm ${
                        g.who === user.name
                          ? 'bg-white text-[#c44d7d]'
                          : 'bg-pink-100/70 text-pink-400'
                      }`}
                    >
                      {g.who === user.name ? '' : `${g.who}：`}
                      {g.text}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 底部按钮 */}
          <div className="mt-3 flex gap-2">
            {amDrawer && !solved && (
              <button
                onClick={() => {
                  if (window.confirm('结束这一局吗？')) dgEndRound(user.name)
                }}
                className="flex-1 rounded-2xl bg-white/80 py-3 text-sm font-semibold tracking-widest text-pink-400 shadow-md shadow-pink-100 transition-transform active:scale-[0.98]"
              >
                结束本局
              </button>
            )}
            {(solved || amDrawer) && (
              <button
                onClick={() => {
                  setShowSolved(false)
                  void handleStart()
                }}
                className="flex flex-[2] items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-violet-400 via-fuchsia-400 to-pink-400 py-3 text-sm font-bold tracking-widest text-white shadow-lg shadow-fuchsia-200 transition-transform active:scale-[0.98]"
              >
                <RotateCcw className="h-4 w-4" />
                再来一局（你画）
              </button>
            )}
          </div>
        </div>
      )}

      {/* 猜中庆祝弹层 */}
      {showSolved && dgState?.winner && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 px-8 backdrop-blur-sm">
          <ConfettiBurst />
          <div className="relative w-full max-w-xs rounded-3xl bg-white p-7 text-center shadow-2xl">
            <button
              onClick={() => setShowSolved(false)}
              className="absolute right-4 top-4 text-pink-300 transition-colors active:text-pink-500"
            >
              <X className="h-5 w-5" />
            </button>
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-emerald-300 to-teal-400 shadow-lg shadow-emerald-200">
              <PartyPopper className="h-8 w-8 text-white" />
            </div>
            <p className="text-lg font-bold text-[#c44d7d]">{dgState.winner} 猜中啦！</p>
            <p className="mt-2 text-sm text-[#6b3a52]">
              答案：<span className="font-bold text-fuchsia-500">{dgState.word}</span>
            </p>
            <p className="mt-1.5 flex items-center justify-center gap-1 text-xs text-amber-600">
              <Coins className="h-3.5 w-3.5" />
              {REWARD} 时元奖励已入账
            </p>
            <button
              onClick={() => {
                setShowSolved(false)
                void handleStart()
              }}
              className="mt-6 w-full rounded-2xl bg-gradient-to-r from-violet-400 via-fuchsia-400 to-pink-400 py-3 text-sm font-bold tracking-widest text-white shadow-lg shadow-fuchsia-200 transition-all active:scale-95"
            >
              再来一局（换你画）
            </button>
          </div>
        </div>
      )}

      <style>{`
        @keyframes dg-fall {
          0% { transform: translateY(0) rotate(0deg); opacity: 1; }
          100% { transform: translateY(105vh) rotate(360deg); opacity: 0.6; }
        }
      `}</style>
    </div>
  )
}
