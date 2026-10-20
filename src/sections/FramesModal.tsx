import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Camera, Coins, X } from 'lucide-react'
import { FRAMES } from '../data/frames'
import { subscribeFrames, equipFrame, buyFrame, type FramesState } from '../lib/frames'
import { setCustomAvatar } from '../lib/avatar'
import AvatarView from '../components/AvatarView'

/** 头像框商店：点主页自己的头像打开。购买扣时元，即买即戴；也支持从相册换头像 */
export default function FramesModal({
  user,
  avatar,
  balance,
  onAvatarChange,
  onClose,
}: {
  user: { name: string }
  avatar: string
  balance: number
  onAvatarChange: (url: string) => void
  onClose: () => void
}) {
  const [state, setState] = useState<FramesState>({ owned: {}, equipped: {} })
  const [synced, setSynced] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  useEffect(() => subscribeFrames(setState), [])

  const myOwned = state.owned[user.name] ?? []
  const myEquipped = state.equipped[user.name] ?? null

  const tap = (id: string, price: number, name: string) => {
    if (myEquipped === id) {
      equipFrame(user.name, null) // 再点一下当前佩戴的 → 卸下
      return
    }
    if (myOwned.includes(id)) {
      equipFrame(user.name, id)
      return
    }
    if (balance < price) {
      alert(`时元不够啦，「${name}」要 ${price} 时元，你现在有 ${balance}`)
      return
    }
    if (window.confirm(`花 ${price} 时元买下「${name}」并戴上吗？`)) {
      const r = buyFrame(user.name, id)
      if (!r.ok) alert(r.msg)
    }
  }

  /** 从相册选图 → 居中裁成正方形 → 缩到 320px → 存 localStorage 并通知刷新 */
  const onPickFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const size = 320
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        const side = Math.min(img.width, img.height)
        const sx = (img.width - side) / 2
        const sy = (img.height - side) / 2
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size)
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
        setCustomAvatar(user.name, dataUrl)
        onAvatarChange(dataUrl)
        setSynced(true)
        window.setTimeout(() => setSynced(false), 2500)
      }
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div
        className="max-h-[82dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-gradient-to-b from-[#fff5f8] to-[#ffe9f2] p-4 pb-8 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between px-1">
          <p className="text-sm font-bold tracking-wider text-[#8a1f52]">头像框商店 🎀</p>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1 rounded-full bg-white/80 px-2.5 py-1 shadow-sm">
              <Coins className="h-3 w-3 text-amber-500" />
              <span className="text-[11px] font-bold tabular-nums text-amber-600">{balance}</span>
            </span>
            <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-full bg-white/70 text-gray-400">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* 换头像 */}
        <button
          onClick={() => fileRef.current?.click()}
          className="mb-2 flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-sky-400 to-indigo-400 py-2.5 text-sm font-bold text-white shadow-lg shadow-sky-200 transition-transform active:scale-95"
        >
          <Camera className="h-4 w-4" /> 从相册换头像
        </button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPickFile} />
        {synced && (
          <p className="mb-2 text-center text-[11px] font-semibold text-emerald-500">已同步，对方马上就能看到 ✓</p>
        )}
        {avatar.startsWith('data:') && (
          <button
            onClick={() => {
              setCustomAvatar(user.name, '')
              onAvatarChange('')
            }}
            className="mb-3 w-full text-center text-[11px] font-medium text-pink-400 underline-offset-2 hover:underline"
          >
            用回空白头像（对方也会看到）
          </button>
        )}

        <div className="grid grid-cols-2 gap-3">
          {FRAMES.map((f) => {
            const owned = myOwned.includes(f.id)
            const wearing = myEquipped === f.id
            return (
              <button
                key={f.id}
                onClick={() => tap(f.id, f.price, f.name)}
                className={`flex flex-col items-center rounded-2xl bg-white/75 p-3 shadow-sm transition-transform active:scale-95 ${
                  wearing ? 'ring-2 ring-[#e0487f]' : ''
                }`}
              >
                {/* 预览：头像在下，框图按 130% 叠在上层，刚好盖住头像边缘 */}
                <div className="relative mb-2 h-16 w-16">
                  <AvatarView
                    name={user.name}
                    value={avatar}
                    fallback={avatar}
                    size={64}
                    className="border-2 border-white shadow"
                  />
                  <img
                    src={f.img}
                    alt=""
                    className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
                    style={{ width: '130%', height: '130%', maxWidth: 'none' }}
                  />
                </div>
                <p className="text-xs font-bold text-[#8a1f52]">{f.name}</p>
                <p
                  className={`mt-0.5 text-[11px] font-medium ${
                    wearing ? 'text-[#e0487f]' : owned ? 'text-emerald-500' : 'text-amber-600'
                  }`}
                >
                  {wearing ? '佩戴中 · 点按卸下' : owned ? '已拥有 · 点按佩戴' : `${f.price} 时元`}
                </p>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
