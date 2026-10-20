import { Heart, ArrowLeft, Lock, Gift, Flame, Dices, Plane } from 'lucide-react'
import type { User } from './LoginPage'
import { hasSecretFeatures } from '../lib/space'
import FloatingBack from '../components/FloatingBack'

/** 秘密空间：隐藏功能仅对获得权限的账号开放（权限见 lib/space.ts），未开放时显示「待开发」 */
export default function SecretPage({
  user,
  onBack,
  onOpenDo,
  onOpenWheel,
  onOpenFlyingChess,
}: {
  user: User
  onBack: () => void
  onOpenDo: () => void
  onOpenWheel: () => void
  onOpenFlyingChess: () => void
}) {
  // 未开放账号组：功能转「待开发」（路由与预热同步关闭）
  const locked = !hasSecretFeatures(user.name)
  const features = [
    {
      icon: Flame,
      label: 'do打分',
      hint: locked ? '待开发' : '隐藏的打分系统',
      tone: 'rose',
      onOpen: onOpenDo,
    },
    {
      icon: Dices,
      label: '姿势转盘',
      hint: locked ? '待开发' : '转到什么就是什么',
      tone: 'amber',
      onOpen: onOpenWheel,
    },
    {
      icon: Plane,
      label: '情侣飞行棋',
      hint: locked ? '待开发' : '掷骰前进 · 落地抽题',
      tone: 'fuchsia',
      onOpen: onOpenFlyingChess,
    },
  ]
  return (
    <div className="relative flex min-h-dvh flex-col bg-gradient-to-b from-[#2b1a3d] via-[#3d1f4d] to-[#51275a]">
      {/* 顶部返回栏 */}
      <div className="flex items-center gap-3 px-5 pb-2 pt-6">
        <FloatingBack onBack={onBack} tone="light" />
        <button
          onClick={onBack}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition-transform active:scale-90"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <span className="text-sm tracking-widest text-white/60">返回主页</span>
      </div>

      {/* 标题区 */}
      <div className="mt-8 flex flex-col items-center px-6 text-center">
        <div className="relative mb-6">
          <Heart className="h-16 w-16 animate-[beat_1.4s_ease-in-out_infinite] fill-rose-400 text-rose-400 drop-shadow-[0_0_24px_rgba(251,113,133,0.6)]" />
          <Lock className="absolute -bottom-1 -right-1 h-6 w-6 rounded-full bg-[#2b1a3d] p-1 text-amber-300" />
        </div>
        <h1 className="text-2xl font-bold tracking-[0.3em] text-white">秘密空间</h1>
        <p className="mt-3 text-sm leading-relaxed text-white/60">
          {user.name}，欢迎来到这里
          <br />
          以后这里只存放属于我们俩的小秘密
        </p>
      </div>

      {/* 功能区：do打分 + 姿势转盘（新账号组转待开发）+ 预留卡位 */}
      <div className="mx-auto mt-12 grid w-full max-w-md grid-cols-2 gap-4 px-6">
        {features.map((item) => {
          const tone =
            item.tone === 'rose'
              ? { border: 'border-rose-300/30', bg: 'from-rose-400/20 to-fuchsia-400/20', icon: 'text-rose-300', text: 'text-rose-200' }
              : item.tone === 'amber'
                ? { border: 'border-amber-300/30', bg: 'from-amber-400/20 to-purple-400/20', icon: 'text-amber-300', text: 'text-amber-200' }
                : { border: 'border-fuchsia-300/30', bg: 'from-fuchsia-400/20 to-indigo-400/20', icon: 'text-fuchsia-300', text: 'text-fuchsia-200' }
          if (locked) {
            return (
              <div
                key={item.label}
                className="flex h-24 flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-white/20 bg-white/5 backdrop-blur-sm"
              >
                <item.icon className="h-5 w-5 text-white/30" />
                <span className="text-xs tracking-widest text-white/40">{item.label}</span>
                <span className="text-[10px] tracking-wider text-white/30">待开发</span>
              </div>
            )
          }
          return (
            <button
              key={item.label}
              onClick={item.onOpen}
              className={`flex h-24 flex-col items-center justify-center gap-1.5 rounded-2xl border backdrop-blur-sm transition-transform active:scale-95 ${tone.border} bg-gradient-to-br ${tone.bg}`}
            >
              <item.icon className={`h-5 w-5 ${tone.icon}`} />
              <span className={`text-xs font-bold tracking-widest ${tone.text}`}>{item.label}</span>
              <span className="text-[10px] tracking-wider text-white/40">{item.hint}</span>
            </button>
          )
        })}
        {[
          { icon: Gift, label: '预留', hint: '敬请期待' },
        ].map((item, i) => (
          <div
            key={i}
            className="flex h-24 flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-white/20 bg-white/5 backdrop-blur-sm"
          >
            <item.icon className="h-5 w-5 text-white/30" />
            <span className="text-xs tracking-widest text-white/40">
              {item.label} · {item.hint}
            </span>
          </div>
        ))}
      </div>

      <p className="mt-auto pb-10 pt-12 text-center text-xs tracking-[0.4em] text-white/30">
        只 属 于 我 们 俩
      </p>

      <style>{`
        @keyframes beat {
          0%, 100% { transform: scale(1); }
          25% { transform: scale(1.15); }
          40% { transform: scale(1); }
          60% { transform: scale(1.1); }
        }
      `}</style>
    </div>
  )
}
