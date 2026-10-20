/**
 * 信封打开动画组件（EnvelopeReveal）：
 * 一个轻量的"拆信封"仪式感交互 —— 初始是一封用火漆封口的信封，
 * 点击后翻盖打开、缓缓抽出信纸内容。用于悄悄话/回忆录等"私密信件"场景。
 *
 * 设计取舍：不引入 LETTER-BOX 整站（200+ 模板太重、且是独立平台），
 * 只抽取"信封 → 展开"这一个核心情绪瞬间，纯 CSS 过渡 + 无额外依赖。
 */
import { useState, type ReactNode } from 'react'

type EnvelopeRevealProps = {
  /** 信封封面显示的头像/emoji，默认 💌 */
  seal?: string
  /** 信封标题（如"未读悄悄话"、"一封回忆"） */
  title?: string
  /** 副标题/时间戳 */
  subtitle?: string
  /** 拆开后展示的内容 */
  children: ReactNode
}

export default function EnvelopeReveal({ seal = '💌', title, subtitle, children }: EnvelopeRevealProps) {
  const [opened, setOpened] = useState(false)

  return (
    <div className="relative flex w-full flex-col items-center">
      {/* 信封主体 */}
      <button
        onClick={() => setOpened(true)}
        disabled={opened}
        className={`relative w-full max-w-sm select-none overflow-hidden rounded-3xl px-6 pb-8 pt-5 text-left shadow-lg transition-all duration-300 ${
          opened
            ? 'pointer-events-none -translate-y-1 opacity-0'
            : 'active:scale-[0.98]'
        }`}
        style={{ background: 'linear-gradient(150deg,#fff7fb,#ffe3f0)' }}
      >
        {/* 信封封口三角 + 火漆 */}
        <div className="relative mx-auto mb-3 h-16 w-11/12">
          {/* 封口三角（信封盖） */}
          <div
            className="absolute inset-x-0 top-0 h-0 w-0 mx-auto border-l-[120px] border-r-[120px] border-t-[64px] border-transparent"
            style={{ borderTopColor: '#f8c8dc' }}
          />
          {/* 火漆印章 */}
          <div className="absolute left-1/2 top-8 flex h-12 w-12 -translate-x-1/2 items-center justify-center rounded-full bg-gradient-to-br from-rose-400 to-pink-600 text-2xl shadow-md shadow-pink-300/60 ring-4 ring-rose-200/50">
            {seal}
          </div>
        </div>

        <p className="mt-4 text-center text-sm font-bold tracking-widest text-[#8a1f52]">{title ?? '一封给你的信'}</p>
        {subtitle && <p className="mt-1 text-center text-[11px] text-pink-300">{subtitle}</p>}
        <p className="mt-3 text-center text-[11px] text-pink-400/80">轻点拆开 💝</p>

        {/* 信封底边三角装饰 */}
        <div
          className="absolute inset-x-0 bottom-0 mx-auto h-0 w-0 border-l-[120px] border-r-[120px] border-b-[40px] border-transparent"
          style={{ borderBottomColor: '#f3bfd6' }}
        />
      </button>

      {/* 拆开后抽出的信纸 */}
      {opened && (
        <div className="w-full max-w-sm animate-[envelope-in_0.5s_ease-out] rounded-3xl border border-pink-100 bg-white p-5 shadow-xl shadow-pink-100">
          {children}
        </div>
      )}
    </div>
  )
}