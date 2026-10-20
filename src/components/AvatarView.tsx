import { useEffect, useState } from 'react'
import { Camera } from 'lucide-react'
import { subscribeAvatars } from '../lib/avatar'
import { isDefaultSpace } from '../lib/space'

/**
 * 统一头像：云端自定义头像 → 账号组默认图（仅默认账号组）→ 空白占位。
 * 新建账号组初始为空白，由本人在主页上传后，双方（同 pair 空间）实时同步。
 * 组件自带云端订阅，任何页面用它都能拿到最新头像。
 */
export default function AvatarView({
  name,
  fallback,
  value,
  size = 40,
  className = '',
  onClick,
  uploadHint = false,
  alt,
}: {
  name: string
  /** 静态兜底图（只有默认账号组会用；新建账号组未上传时一律走空白占位） */
  fallback?: string
  /** 调用方已有的当前头像（优先于组件自订阅，用于预览等场景） */
  value?: string
  size?: number
  className?: string
  onClick?: () => void
  /** 空白时是否显示「点击上传」引导（自己的头像用） */
  uploadHint?: boolean
  alt?: string
}) {
  const [custom, setCustom] = useState('')

  useEffect(() => subscribeAvatars((all) => setCustom(all[name] ?? '')), [name])

  const src = value || custom || (isDefaultSpace() ? (fallback ?? '') : '')

  const inner = src ? (
    <img src={src} alt={alt ?? name} className="h-full w-full object-cover" draggable={false} />
  ) : (
    <span className="flex h-full w-full flex-col items-center justify-center gap-0.5 bg-gradient-to-br from-rose-200 via-fuchsia-200 to-violet-200 ring-1 ring-inset ring-white/70">
      {uploadHint ? (
        <>
          <Camera className="h-[28%] w-[28%] text-white drop-shadow" />
          <span className="text-[9px] font-bold tracking-wider text-white/95 drop-shadow">上传</span>
        </>
      ) : (
        <span className="font-bold text-white/95 drop-shadow" style={{ fontSize: size * 0.36 }}>
          {(name || '?').slice(0, 1)}
        </span>
      )}
    </span>
  )

  const shell = `relative shrink-0 overflow-hidden rounded-full ${className}`

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={`换头像 · ${name}`}
        className={`${shell} transition-transform active:scale-95`}
        style={{ width: size, height: size }}
      >
        {inner}
      </button>
    )
  }
  return (
    <div className={shell} title={name} style={{ width: size, height: size }}>
      {inner}
    </div>
  )
}
