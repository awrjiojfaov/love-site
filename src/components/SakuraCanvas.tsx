import { useEffect, useRef } from 'react'

type Petal = {
  x: number
  y: number
  size: number
  speedY: number
  swayAmp: number
  swayFreq: number
  phase: number
  rot: number
  rotSpeed: number
  opacity: number
  color: string
  flip: number
}

const COLORS = ['#ffd9e3', '#ffc9d9', '#ffe6ec', '#f7b8cd', '#ffdfef', '#f9c2d8']

function makePetal(w: number, h: number, fromTop: boolean): Petal {
  return {
    x: Math.random() * w,
    y: fromTop ? -20 - Math.random() * 60 : Math.random() * h,
    size: 8 + Math.random() * 9,
    speedY: 0.5 + Math.random() * 1.2,
    swayAmp: 24 + Math.random() * 42,
    swayFreq: 0.4 + Math.random() * 0.9,
    phase: Math.random() * Math.PI * 2,
    rot: Math.random() * Math.PI * 2,
    rotSpeed: (Math.random() - 0.5) * 0.025,
    opacity: 0.5 + Math.random() * 0.45,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    flip: Math.random() < 0.5 ? 1 : -1,
  }
}

/** 全屏樱花花瓣飘落画布（fixed 定位，不拦截点击） */
export default function SakuraCanvas({ density = 36 }: { density?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let w = (canvas.width = window.innerWidth)
    let h = (canvas.height = window.innerHeight)
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = w * dpr
    canvas.height = h * dpr
    ctx.scale(dpr, dpr)

    let petals: Petal[] = Array.from({ length: density }, () => makePetal(w, h, false))

    const onResize = () => {
      w = window.innerWidth
      h = window.innerHeight
      canvas.width = w * dpr
      canvas.height = h * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      petals = Array.from({ length: density }, () => makePetal(w, h, false))
    }
    window.addEventListener('resize', onResize)

    let raf = 0
    let t = 0

    const drawPetal = (p: Petal) => {
      const sway = Math.sin(t * p.swayFreq * 0.02 + p.phase) * p.swayAmp
      const x = p.x + sway
      const y = p.y

      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(p.rot + Math.sin(t * 0.01 + p.phase) * 0.5)
      ctx.scale(p.flip, 1)
      ctx.globalAlpha = p.opacity
      ctx.fillStyle = p.color

      // 真樱花瓣：细长水滴形，尖端收窄，宽端带小缺口
      const s = p.size
      ctx.beginPath()
      ctx.moveTo(0, -s) // 尖端
      ctx.bezierCurveTo(s * 0.62, -s * 0.55, s * 0.58, s * 0.25, s * 0.16, s * 0.72)
      ctx.quadraticCurveTo(0, s * 0.52, -s * 0.16, s * 0.72) // 宽端内凹小缺口
      ctx.bezierCurveTo(-s * 0.58, s * 0.25, -s * 0.62, -s * 0.55, 0, -s)
      ctx.fill()

      // 花瓣高光
      ctx.globalAlpha = p.opacity * 0.35
      ctx.fillStyle = '#ffffff'
      ctx.beginPath()
      ctx.ellipse(-s * 0.12, -s * 0.35, s * 0.16, s * 0.3, 0.3, 0, Math.PI * 2)
      ctx.fill()

      ctx.restore()
    }

    const tick = () => {
      t += 1
      ctx.clearRect(0, 0, w, h)
      for (const p of petals) {
        p.y += p.speedY
        p.rot += p.rotSpeed
        if (p.y > h + 30) {
          Object.assign(p, makePetal(w, h, true))
        }
        drawPetal(p)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [density])

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none fixed inset-0 z-50"
      style={{ width: '100vw', height: '100vh' }}
    />
  )
}
