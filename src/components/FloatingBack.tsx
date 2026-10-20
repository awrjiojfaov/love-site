import { ArrowLeft } from 'lucide-react'

/**
 * 悬浮返回按钮：固定在右下角，页面不用再滚回顶部找退出入口。
 * tone: light = 深色底白字（放在深色/ collage 背景上），plain = 白底灰字（浅色页面）。
 */
export default function FloatingBack({
  onBack,
  tone = 'plain',
}: {
  onBack: () => void
  tone?: 'plain' | 'light'
}) {
  const style =
    tone === 'light'
      ? 'bg-white/12 text-white ring-1 ring-white/25 backdrop-blur shadow-lg'
      : 'bg-white text-slate-500 shadow-md shadow-pink-100 ring-1 ring-slate-100'
  return (
    <button
      onClick={onBack}
      className={`fixed bottom-5 right-4 z-40 flex h-11 w-11 items-center justify-center rounded-full ${style} transition-transform active:scale-90`}
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      aria-label="返回"
    >
      <ArrowLeft className="h-5 w-5" />
    </button>
  )
}
