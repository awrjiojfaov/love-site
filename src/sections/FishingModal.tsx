import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import fishingBg from '../assets/fishing-bg.webp'
import { FISH, RARE_FISH, fishById, pondFishCaught, grantFishingLoot, itemInfo } from '../lib/farm'
import { addTx } from '../lib/wallet'
import { logCatch } from '../lib/fishing'
import FishRankModal from './FishRankModal'

/**
 * 黄金矿工式钓鱼：钩子以船底为支点 180° 摆动，点屏出钩。
 * - 三档入场券：100/200/300 时元，各 6 次出钩；档位越高稀有鱼概率越高（2%/5%/9%）
 * - 水里的鱼全部以盲盒 🎁 形式游动，钓上来才知道是什么；稀有鱼带金色光晕
 * - 当前鱼塘里成熟的鱼也会进场（钓走入自己仓库）
 * - 障碍物（沉木/破靴）钩到浪费一次；炸药桶钩到爆炸浪费一次并惊散鱼群
 */

/** 三档船票 */
const TIERS = [
  { cost: 100, rareRate: 0.02, name: '近海小钓', emoji: '🛶' },
  { cost: 200, rareRate: 0.05, name: '深海远航', emoji: '🚤' },
  { cost: 300, rareRate: 0.09, name: '传说之海', emoji: '⛵' },
]
const ATTEMPTS = 6

type ObjKind = 'fish' | 'dynamite' | 'rock' | 'egg'
type Obj = {
  kind: ObjKind
  fishId: string // 鱼 = 物品 id；道具 = 装饰 emoji 键
  emoji: string
  x: number
  y: number
  vx: number
  vy: number
  r: number
  weight: number // 影响收线速度
  slotId: number | null // 池塘鱼的槽位；野鱼/道具为 null
  rare: boolean
  dead: boolean
}
/** 一根钩子：off = 相对摆角偏移（三重钩用），done = 本次出钩已结束（钩到或出界） */
type Hook = { off: number; caught: Obj | null; done: boolean }

type Phase = 'intro' | 'aiming' | 'extend' | 'retract' | 'over'

export default function FishingModal({
  user,
  balance,
  pondOwner,
  pondFish,
  onClose,
}: {
  user: { name: string }
  balance: number
  pondOwner: string // 当前看的谁的鱼塘
  pondFish: Array<{ slotId: number; fishId: string }>
  onClose: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [phase, setPhase] = useState<Phase>('intro')
  const [attemptsLeft, setAttemptsLeft] = useState(ATTEMPTS)
  const [results, setResults] = useState<Array<{ emoji: string; name: string; rare: boolean }>>([])
  const [banner, setBanner] = useState('') // 钩中提示
  const [myBalance, setMyBalance] = useState(balance)
  const [rankOpen, setRankOpen] = useState(false)
  const [tier, setTier] = useState(1) // 档位：0 近海 / 1 深海 / 2 传说
  const [tripleOn, setTripleOn] = useState(false) // 彩蛋：三重钩模式（界面提示用）

  // 游戏内部状态全走 ref，不触发 React 渲染
  const g = useRef<{
    objs: Obj[]
    angle: number
    angleDir: 1 | -1
    len: number
    hooks: Hook[]
    bonus: Obj[] // 炸药顺带震上来的鱼
    triple: boolean // 彩蛋：三重钩模式
    phase: Phase
    attempts: number
    waterTop: number
    pivot: { x: number; y: number }
    bg: HTMLImageElement | null
    shake: number
    raf: number
  }>({
    objs: [],
    angle: 0,
    angleDir: 1,
    len: 30,
    hooks: [{ off: 0, caught: null, done: false }],
    bonus: [],
    triple: false,
    phase: 'intro',
    attempts: ATTEMPTS,
    waterTop: 0,
    pivot: { x: 0, y: 0 },
    bg: null,
    shake: 0,
    raf: 0,
  })

  const cw = () => canvasRef.current?.width ? canvasRef.current.width / (window.devicePixelRatio || 1) : 400
  const chh = () => canvasRef.current?.height ? canvasRef.current.height / (window.devicePixelRatio || 1) : 700

  /** 生成一局的水下目标：盲盒鱼固定 5~8 条（池塘成熟鱼优先进场）+ 炸药/顽石/彩蛋各 1 */
  const spawnObjs = (rareRate: number) => {
    const W = cw()
    const top = g.current.waterTop
    const H = chh()
    const objs: Obj[] = []
    const rnd = (a: number, b: number) => a + Math.random() * (b - a)
    const waterH = H - top

    const mkMover = (o: Partial<Obj>): Obj => {
      const ang = rnd(0, Math.PI * 2)
      const speed = rnd(90, 170) // 直线快速游动
      return {
        kind: 'fish', fishId: '', emoji: '🎁', x: rnd(50, W - 50), y: top + rnd(50, waterH - 60),
        vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed * 0.55, r: 22, weight: 0.5,
        slotId: null, rare: false, dead: false, ...o,
      } as Obj
    }

    // 盲盒鱼固定 5~8 条：池塘里成熟的鱼优先进场，其余用野鱼补齐
    const total = 5 + Math.floor(Math.random() * 4)
    const sample = [...pondFish].sort(() => Math.random() - 0.5).slice(0, total)
    for (const pf of sample) {
      const f = fishById(pf.fishId)
      if (!f) continue
      objs.push(mkMover({ fishId: f.id, weight: Math.min(3, f.cost / 20), slotId: pf.slotId }))
    }
    for (let i = objs.length; i < total; i++) {
      if (Math.random() < rareRate) {
        const rf = RARE_FISH[Math.floor(Math.random() * RARE_FISH.length)]
        objs.push(mkMover({ fishId: rf.id, r: 26, weight: 1.2, rare: true }))
      } else {
        const f = FISH[Math.floor(Math.random() * FISH.length)]
        objs.push(mkMover({ fishId: f.id, weight: Math.min(3, f.cost / 20) }))
      }
    }
    // 道具：炸药（炸起附近的鱼）/ 顽石（重，拖拽慢）/ 彩蛋（三重钩）
    objs.push(mkMover({ kind: 'dynamite', fishId: '', emoji: '🧨', r: 22, weight: 0.4, vx: rnd(-40, 40), vy: rnd(-20, 20) }))
    objs.push(mkMover({ kind: 'rock', fishId: '', emoji: '🪨', r: 24, weight: 6, vx: rnd(-25, 25), vy: rnd(-12, 12) }))
    objs.push(mkMover({ kind: 'egg', fishId: '', emoji: '🥚', r: 20, weight: 0.5, vx: rnd(-35, 35), vy: rnd(-18, 18) }))
    g.current.objs = objs
  }

  /** 开局：扣费时元 → 生成目标 → 进入瞄准 */
  const startSession = () => {
    const t = TIERS[tier]
    if (myBalance < t.cost) {
      alert(`时元不够啦，${t.name}要 ${t.cost} 时元，你现在有 ${myBalance}`)
      return
    }
    if (!addTx(user.name, -t.cost, `出海钓鱼·${t.name}`)) {
      alert('同步中，请稍后再试')
      return
    }
    setMyBalance((b) => b - t.cost)
    g.current.attempts = ATTEMPTS
    g.current.triple = false
    g.current.hooks = [{ off: 0, caught: null, done: false }]
    g.current.bonus = []
    setTripleOn(false)
    setAttemptsLeft(ATTEMPTS)
    setResults([])
    spawnObjs(t.rareRate)
    g.current.phase = 'aiming'
    setPhase('aiming')
  }

  /** 收线结算 */
  const settleCatch = (obj: Obj) => {
    if (obj.kind === 'fish') {
      const info = itemInfo(obj.fishId)
      // 池塘鱼：先从塘里捞走（防重复），成功才入仓；野鱼/稀有鱼直接入仓
      if (obj.slotId !== null) {
        const got = pondFishCaught(pondOwner, obj.slotId)
        if (!got) {
          setBanner('慢了一步，这条鱼已经不在塘里了')
          return
        }
      }
      grantFishingLoot(user.name, { [obj.fishId]: 1 })
      logCatch(user.name, obj.fishId, obj.rare)
      setResults((rs) => [...rs, { emoji: info.emoji, name: info.name, rare: obj.rare }])
      setBanner(obj.rare ? `✨ 稀有！盲盒开出 ${info.emoji}${info.name}！` : `盲盒开出 ${info.emoji}${info.name}！`)
    } else if (obj.kind === 'rock') {
      setBanner('🪨 钓上一块顽石…死沉死沉的，白费一次 😮‍💨')
    } else if (obj.kind === 'egg') {
      g.current.triple = true
      setTripleOn(true)
      setBanner('🥚 彩蛋！之后每次甩出三重钩，仍只耗 1 次机会！')
    }
    // 炸药在钩中瞬间已结算（炸起附近的鱼），这里不再处理
  }

  // ===================== Canvas 主循环 =====================
  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    const dpr = window.devicePixelRatio || 1
    const W = window.innerWidth
    const H = window.innerHeight
    canvas.width = W * dpr
    canvas.height = H * dpr
    canvas.style.width = `${W}px`
    canvas.style.height = `${H}px`

    const img = new Image()
    img.src = fishingBg
    img.onload = () => { g.current.bg = img }

    let last = performance.now()
    let bannerTimer = 0

    const SWING_SPEED = 2.0 // rad/s，摆钩速度
    const MAX_ANGLE = (85 * Math.PI) / 180
    const EXTEND_SPEED = 520
    const RETRACT_EMPTY = 340

    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const s = g.current

      // 支点：船底中心（原图 50% 宽、35.2% 高），经 cover 变换
      const scale = Math.max(W / 1706, H / 1279)
      const offX = (W - 1706 * scale) / 2
      const offY = (H - 1279 * scale) / 2
      s.pivot = { x: 0.5 * 1706 * scale + offX, y: 0.352 * 1279 * scale + offY }
      s.waterTop = 0.372 * 1279 * scale + offY

      // ---- 状态更新 ----
      if (s.phase === 'aiming' || s.phase === 'intro') {
        s.angle += s.angleDir * SWING_SPEED * dt
        if (s.angle > MAX_ANGLE) { s.angle = MAX_ANGLE; s.angleDir = -1 }
        if (s.angle < -MAX_ANGLE) { s.angle = -MAX_ANGLE; s.angleDir = 1 }
        s.len = 30
      } else if (s.phase === 'extend') {
        // 分步推进防穿透快速鱼；每根钩独立判定，钩到或出界即完成
        let step = EXTEND_SPEED * dt
        while (step > 0 && s.hooks.some((h) => !h.done)) {
          const inc = Math.min(step, 6)
          s.len += inc
          step -= inc
          for (const h of s.hooks) {
            if (h.done) continue
            const ang = s.angle + h.off
            const tx = s.pivot.x + Math.sin(ang) * s.len
            const ty = s.pivot.y + Math.cos(ang) * s.len
            // 触底 / 出界
            if (ty > H - 6 || tx < 4 || tx > W - 4) { h.done = true; continue }
            for (const o of s.objs) {
              if (o.dead) continue
              if (Math.hypot(o.x - tx, o.y - ty) < o.r + 7) {
                o.dead = true
                h.caught = o
                h.done = true
                if (o.kind === 'dynamite') {
                  // 💥 炸药：把附近的鱼全部震上来（顺带收获）
                  s.shake = 16
                  let n = 0
                  for (const f of s.objs) {
                    if (f.kind === 'fish' && !f.dead && Math.hypot(f.x - o.x, f.y - o.y) < 170) {
                      f.dead = true
                      s.bonus.push(f)
                      n++
                    }
                  }
                  setBanner(n > 0 ? `💥 炸药炸了！附近 ${n} 条鱼全被震上来！` : '💥 炸药炸了！可惜附近没有鱼')
                }
                break
              }
            }
          }
        }
        if (s.hooks.every((h) => h.done)) s.phase = 'retract'
      } else if (s.phase === 'retract') {
        // 收线速度由最重的一件收获决定（顽石会拖得很慢）
        let maxW = 0
        for (const h of s.hooks) if (h.caught) maxW = Math.max(maxW, h.caught.weight)
        for (const b of s.bonus) maxW = Math.max(maxW, b.weight)
        const speed = RETRACT_EMPTY / (1 + maxW)
        s.len -= speed * dt
        for (const h of s.hooks) {
          if (!h.caught) continue
          const ang = s.angle + h.off
          h.caught.x = s.pivot.x + Math.sin(ang) * s.len
          h.caught.y = s.pivot.y + Math.cos(ang) * s.len + h.caught.r * 0.4
        }
        // 炸药震上来的鱼跟在中钩后面
        s.bonus.forEach((b, i) => {
          const ang = s.angle + (i - (s.bonus.length - 1) / 2) * 0.14
          const l = Math.max(26, s.len - 26 - i * 4)
          b.x = s.pivot.x + Math.sin(ang) * l
          b.y = s.pivot.y + Math.cos(ang) * l + b.r * 0.4
        })
        if (s.len <= 30) {
          for (const h of s.hooks) if (h.caught && h.caught.kind !== 'dynamite') settleCatch(h.caught)
          for (const b of s.bonus) settleCatch(b)
          s.hooks = [{ off: 0, caught: null, done: false }]
          s.bonus = []
          s.len = 30
          if (s.attempts <= 0) {
            s.phase = 'over'
            setPhase('over')
          } else {
            s.phase = 'aiming'
          }
        }
      }

      // 鱼游动：直线 + 碰边反弹
      for (const o of s.objs) {
        if (o.dead) continue
        o.x += o.vx * dt
        o.y += o.vy * dt
        if (o.x < o.r + 6) { o.x = o.r + 6; o.vx = Math.abs(o.vx) }
        if (o.x > W - o.r - 6) { o.x = W - o.r - 6; o.vx = -Math.abs(o.vx) }
        if (o.y < s.waterTop + o.r + 8) { o.y = s.waterTop + o.r + 8; o.vy = Math.abs(o.vy) }
        if (o.y > H - o.r - 10) { o.y = H - o.r - 10; o.vy = -Math.abs(o.vy) }
      }
      if (s.shake > 0) s.shake = Math.max(0, s.shake - dt * 30)
      if (bannerTimer > 0) bannerTimer -= dt

      // ---- 绘制 ----
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)
      if (s.shake > 0) {
        ctx.translate((Math.random() - 0.5) * s.shake, (Math.random() - 0.5) * s.shake)
      }
      if (s.bg) ctx.drawImage(s.bg, offX, offY, 1706 * scale, 1279 * scale)
      else { ctx.fillStyle = '#1d6fa8'; ctx.fillRect(0, 0, W, H) }

      // 水下目标（鱼以盲盒形式游动，钓上来才揭晓；稀有鱼带金色光晕；钩中的随钩绘制）
      for (const o of s.objs) {
        if (o.dead) continue
        ctx.save()
        ctx.translate(o.x, o.y)
        if (o.rare) {
          ctx.shadowColor = 'rgba(255, 215, 0, 0.95)'
          ctx.shadowBlur = 22
        }
        ctx.font = `${o.r * 1.6}px serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(o.kind === 'fish' ? '🎁' : o.emoji, 0, 0)
        ctx.restore()
      }

      // 鱼线 + 钩（彩蛋三重钩时画三根）
      const hooksToDraw: Hook[] =
        s.phase === 'extend' || s.phase === 'retract' ? s.hooks : [{ off: 0, caught: null, done: false }]
      for (const h of hooksToDraw) {
        const ang = s.angle + h.off
        const tx = s.pivot.x + Math.sin(ang) * s.len
        const ty = s.pivot.y + Math.cos(ang) * s.len
        ctx.strokeStyle = 'rgba(255,255,255,0.95)'
        ctx.lineWidth = 2.5
        ctx.beginPath()
        ctx.moveTo(s.pivot.x, s.pivot.y)
        ctx.lineTo(tx, ty)
        ctx.stroke()
        ctx.save()
        ctx.translate(tx, ty)
        ctx.rotate(-ang * 0.3)
        ctx.font = '22px serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('🪝', 0, 6)
        ctx.restore()
        // 钩上的收获（鱼保持盲盒神秘感）
        if (h.caught) {
          ctx.save()
          ctx.translate(tx, ty + h.caught.r * 0.9)
          ctx.font = `${h.caught.r * 1.6}px serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(h.caught.kind === 'fish' ? '🎁' : h.caught.emoji, 0, 0)
          ctx.restore()
        }
      }
      // 炸药震上来的鱼串
      for (const b of s.bonus) {
        ctx.save()
        ctx.translate(b.x, b.y)
        if (b.rare) {
          ctx.shadowColor = 'rgba(255, 215, 0, 0.95)'
          ctx.shadowBlur = 22
        }
        ctx.font = `${b.r * 1.6}px serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('🎁', 0, 0)
        ctx.restore()
      }

      s.raf = requestAnimationFrame(loop)
    }
    g.current.raf = requestAnimationFrame(loop)

    const onTap = () => {
      const s = g.current
      if (s.phase !== 'aiming') return
      s.attempts -= 1
      setAttemptsLeft(s.attempts)
      // 彩蛋三重钩：三根钩扇形甩出，仍只耗 1 次机会
      s.hooks = s.triple
        ? [
            { off: -0.34, caught: null, done: false },
            { off: 0, caught: null, done: false },
            { off: 0.34, caught: null, done: false },
          ]
        : [{ off: 0, caught: null, done: false }]
      s.bonus = []
      s.phase = 'extend'
    }
    canvas.addEventListener('pointerdown', onTap)
    return () => {
      cancelAnimationFrame(g.current.raf)
      canvas.removeEventListener('pointerdown', onTap)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 提示横幅 2 秒自动消
  useEffect(() => {
    if (!banner) return
    const t = setTimeout(() => setBanner(''), 2000)
    return () => clearTimeout(t)
  }, [banner])

  return (
    <div className="fixed inset-0 z-[80]">
      <canvas ref={canvasRef} className="block" />

      {/* 顶栏 */}
      <div className="absolute inset-x-0 top-0 flex items-center justify-between px-4 pt-3">
        <button
          onClick={onClose}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/85 text-gray-500 shadow"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setRankOpen(true)}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-300/95 text-base shadow"
            title="渔获排行榜"
          >
            🏆
          </button>
          <span className="rounded-full bg-white/85 px-3 py-1.5 text-xs font-bold text-sky-700 shadow">
            🪝 剩余 {attemptsLeft} 次
          </span>
          {tripleOn && (
            <span className="rounded-full bg-amber-300/95 px-3 py-1.5 text-xs font-bold text-white shadow">
              🥚 三重钩
            </span>
          )}
          <span className="rounded-full bg-white/85 px-3 py-1.5 text-xs font-bold text-amber-600 shadow">
            💰 {myBalance}
          </span>
        </div>
      </div>

      {/* 横幅提示 */}
      {banner && (
        <div className="absolute inset-x-0 top-16 flex justify-center px-8">
          <p className="rounded-full bg-black/60 px-4 py-2 text-center text-xs font-medium text-white shadow-lg">
            {banner}
          </p>
        </div>
      )}

      {/* 开场说明 */}
      {phase === 'intro' && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/45 px-8 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl bg-white/95 p-5 shadow-2xl">
            <p className="text-center text-lg font-bold text-sky-800">🎣 出海钓鱼</p>
            <p className="mt-1 text-center text-[11px] text-sky-500">
              {pondOwner === user.name ? '在自家鱼塘甩两杆' : `来 ${pondOwner} 家鱼塘做客钓鱼 😈`}
            </p>
            <div className="mt-3 space-y-1.5 text-xs leading-relaxed text-gray-600">
              <p>· 每局水里固定 <b>5~8 条盲盒鱼 🎁</b>，钓上来才揭晓</p>
              <p>· 钩子来回摆动，<b>点屏幕</b>出钩，钩到什么拉什么</p>
              <p>· 塘里成熟的鱼优先进场——钓走直接进你仓库</p>
              <p>· 🧨 炸药：炸起附近的鱼<b>全部收获</b>；🪨 顽石：死沉拖半天白费一次；🥚 彩蛋：之后变<b>三重钩</b>仍只耗 1 次</p>
              <p>· 稀有鱼带<span className="text-amber-500">金色光晕</span>，可在仓库出售换时元</p>
            </div>

            {/* 三档船票 */}
            <div className="mt-3 grid grid-cols-3 gap-2">
              {TIERS.map((t, i) => (
                <button
                  key={t.cost}
                  onClick={() => setTier(i)}
                  className={`rounded-2xl px-1 py-2.5 text-center ring-1 transition-all active:scale-95 ${
                    tier === i ? 'bg-sky-50 ring-2 ring-sky-400 shadow' : 'bg-gray-50 ring-gray-200'
                  }`}
                >
                  <p className="text-lg">{t.emoji}</p>
                  <p className={`text-[11px] font-bold ${tier === i ? 'text-sky-700' : 'text-gray-500'}`}>{t.name}</p>
                  <p className="text-[10px] font-bold text-amber-500">{t.cost} 时元</p>
                  <p className="text-[9px] text-gray-400">稀有 {(t.rareRate * 100).toFixed(0)}%</p>
                </button>
              ))}
            </div>

            <button
              onClick={startSession}
              className="mt-4 w-full rounded-2xl bg-gradient-to-r from-sky-400 to-blue-500 py-3 text-sm font-bold text-white shadow-lg shadow-sky-300 transition-transform active:scale-95"
            >
              花 {TIERS[tier].cost} 时元出海 {TIERS[tier].emoji}
            </button>
            <button onClick={onClose} className="mt-2 w-full py-2 text-xs text-gray-400">
              下次再钓
            </button>
          </div>
        </div>
      )}

      {/* 结算面板 */}
      {phase === 'over' && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/45 px-8 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl bg-white/95 p-5 shadow-2xl">
            <p className="text-center text-lg font-bold text-sky-800">🧺 渔获结算</p>
            {results.length === 0 ? (
              <p className="py-6 text-center text-xs text-gray-400">空军了…一条都没钓到 😢</p>
            ) : (
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                {results.map((r, i) => (
                  <span
                    key={i}
                    className={`flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-bold shadow-sm ${
                      r.rare ? 'bg-gradient-to-r from-amber-100 to-yellow-200 text-amber-700 ring-1 ring-amber-300' : 'bg-sky-50 text-sky-700'
                    }`}
                  >
                    {r.emoji} {r.name}
                    {r.rare && ' ✨'}
                  </span>
                ))}
              </div>
            )}
            <button
              onClick={startSession}
              className="mt-3 w-full rounded-2xl bg-gradient-to-r from-sky-400 to-blue-500 py-3 text-sm font-bold text-white shadow-lg shadow-sky-300 transition-transform active:scale-95"
            >
              再来一局（{TIERS[tier].cost} 时元）
            </button>
            <button
              onClick={onClose}
              className="mt-2 w-full rounded-2xl bg-gray-100 py-2.5 text-sm text-gray-500"
            >
              收竿回家
            </button>
          </div>
        </div>
      )}

      {/* 渔获排行榜 */}
      {rankOpen && <FishRankModal onClose={() => setRankOpen(false)} />}
    </div>
  )
}
