import { useEffect, useRef } from 'react'
import { tsParticles } from '@tsparticles/engine'
import { loadSlim } from '@tsparticles/slim'
import { loadImageShape } from '@tsparticles/shape-image'
import { loadWobbleUpdater } from '@tsparticles/updater-wobble'

/**
 * 横幅花瓣粒子层（2026-10-20 背景美化 · 方案 A+B）。
 * - 只覆盖顶部横幅区，15~22 片花瓣缓慢飘落 + 轻微摆动，不抢内容注意力
 * - 离屏自动暂停（IntersectionObserver），低动态偏好（prefers-reduced-motion）不渲染
 * - 纯装饰：pointer-events 透传，不挡按钮
 */

// 花瓣形状：单色 SVG data URI，用粒子颜色着色（粉/玫/浅粉轮换）
const PETAL_SVG =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23ffffff' d='M12 2c3 4 7 7 7 12a7 7 0 1 1-14 0c0-5 4-8 7-12z'/%3E%3C/svg%3E"

// 全站情侣粉配色（与 confetti.ts 的 PINKS 同源）
const PETAL_COLORS = ['#ff87b2', '#f5a8c6', '#ffd6e7', '#e0487f', '#f78fb3']

export default function PetalParticles() {
  const holderRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // 低动态偏好：直接不跑粒子
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const el = holderRef.current
    if (!el) return

    let container: Awaited<ReturnType<typeof tsParticles.load>> | null = null
    let disposed = false

    // 离屏暂停 / 回屏恢复：横幅滚出视口就不再耗 rAF
    const io = new IntersectionObserver(
      (entries) => {
        if (!container) return
        if (entries[0]?.isIntersecting) container.play()
        else container.pause()
      },
      { threshold: 0 }
    )
    io.observe(el)

    void (async () => {
      await loadSlim(tsParticles) // slim 基础插件
      await loadImageShape(tsParticles) // v4 需显式注册图片形状
      await loadWobbleUpdater(tsParticles) // 花瓣摇摆飘落
      if (disposed) return
      container = await tsParticles.load({
        id: 'home-petals',
        options: {
          fullScreen: { enable: false },
          detectRetina: true,
          fpsLimit: 60,
          particles: {
            number: { value: 18, density: { enable: true, width: 800, height: 600 } },
            color: { value: PETAL_COLORS },
            shape: {
              type: 'image',
              options: { image: [{ src: PETAL_SVG, width: 24, height: 24 }] },
            },
            opacity: { value: { min: 0.25, max: 0.55 } },
            size: { value: { min: 8, max: 16 } },
            rotate: {
              value: { min: 0, max: 360 },
              direction: 'random',
              animation: { enable: true, speed: { min: 6, max: 14 }, sync: false },
            },
            move: {
              enable: true,
              direction: 'bottom',
              speed: { min: 0.4, max: 0.9 },
              drift: { min: -0.4, max: 0.4 },
              outModes: { default: 'out' },
              straight: false,
            },
            wobble: {
              distance: 6,
              enable: true,
              speed: { min: 4, max: 8 },
            },
          },
          interactivity: {
            events: {
              onHover: { enable: false },
              onClick: { enable: false },
              resize: { enable: true },
            },
          },
        },
      })
    })()

    return () => {
      disposed = true
      io.disconnect()
      void container?.destroy()
    }
  }, [])

  return (
    <div
      ref={holderRef}
      id="home-petals"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
    />
  )
}
