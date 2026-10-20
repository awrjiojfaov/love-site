import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, MessageCircleHeart, Send, Trash2 } from 'lucide-react'
import {
  subscribeWhisper,
  subscribeTyping,
  sendTyping,
  sendWhisper,
  recallWhisper,
  type WhisperMsg,
} from '../lib/whisper'
import { partnerOf } from '../lib/space'
import type { User } from './LoginPage'

function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  if (sameDay) return hm
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

export default function WhisperPage({ user, onBack }: { user: User; onBack: () => void }) {
  const [msgs, setMsgs] = useState<WhisperMsg[]>([])
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const [partnerTyping, setPartnerTyping] = useState(false)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const listEndRef = useRef<HTMLDivElement>(null)
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const partner = partnerOf(user.name)

  useEffect(() => {
    const u1 = subscribeWhisper((m) => setMsgs(m), setError)
    const u2 = subscribeTyping((who) => {
      if (who !== user.name) {
        setPartnerTyping(true)
        if (typingTimer.current) clearTimeout(typingTimer.current)
        typingTimer.current = setTimeout(() => setPartnerTyping(false), 4000)
      }
    })
    return () => {
      u1()
      u2()
      if (typingTimer.current) clearTimeout(typingTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 新消息自动滚到底
  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [msgs, partnerTyping])

  const visible = msgs.filter((m) => !m.del)

  const handleSend = () => {
    const text = input.trim()
    if (!text) return
    if (sendWhisper(user.name, text)) setInput('')
    else setError('云端还没就绪，稍等一秒再发～')
  }

  return (
    <div className="flex min-h-dvh flex-col bg-gradient-to-b from-[#fff5f8] via-[#fdeef6] to-[#fae3ef]">
      {/* 顶部导航 */}
      <div className="sticky top-0 z-10 flex items-center gap-3 bg-white/70 px-4 pb-3 pt-4 shadow-sm shadow-pink-100 backdrop-blur-md">
        <button
          onClick={onBack}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white shadow-md transition-transform active:scale-95"
        >
          <ChevronLeft className="h-5 w-5 text-[#c44d7d]" />
        </button>
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-pink-400 to-rose-400 shadow-md shadow-pink-200">
          <MessageCircleHeart className="h-5 w-5 text-white" />
        </div>
        <div>
          <p className="text-[15px] font-bold tracking-wider text-[#c44d7d]">悄悄话</p>
          <p className="text-[11px] text-pink-300">
            {partnerTyping ? '对方正在输入…' : partner ? `只讲给 ${partner} 听` : '两个人的小纸条'}
          </p>
        </div>
      </div>

      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {visible.length === 0 ? (
          <div className="mt-24 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-white shadow-lg shadow-pink-100">
              <MessageCircleHeart className="h-8 w-8 text-pink-300" />
            </div>
            <p className="text-sm tracking-widest text-pink-300">还没有悄悄话</p>
            <p className="mt-1 text-xs text-pink-200">发第一句吧，TA 会实时收到 💌</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {visible.map((m) => {
              const mine = m.who === user.name
              const isExpanded = expandedIds.has(m.id)
              return (
                <div
                  key={m.id}
                  className={`flex items-end gap-1.5 ${mine ? 'flex-row-reverse' : 'flex-row'}`}
                >
                  <button
                    onClick={() => {
                      const next = new Set(expandedIds)
                      if (next.has(m.id)) next.delete(m.id)
                      else next.add(m.id)
                      setExpandedIds(next)
                    }}
                    title={mine ? '点我展开/收起，垃圾桶撤回' : m.who}
                    className={`max-w-[70%] rounded-2xl px-4 py-2 text-left text-[15px] leading-relaxed shadow-md transition-transform active:scale-[0.98] ${
                      isExpanded
                        ? 'whitespace-normal break-all'
                        : 'overflow-hidden text-ellipsis whitespace-nowrap'
                    } ${
                      mine
                        ? 'rounded-br-md bg-gradient-to-br from-pink-400 to-rose-400 text-white shadow-pink-200'
                        : 'rounded-bl-md bg-white text-[#6b3a52] shadow-pink-100'
                    }`}
                  >
                    {m.text}
                  </button>
                  <span className="shrink-0 pb-0.5 text-[10px] tabular-nums text-pink-300">
                    {formatTime(m.ts)}
                  </span>
                  {mine && (
                    <button
                      onClick={() => {
                        if (window.confirm('撤回这条悄悄话吗？')) recallWhisper(user.name, m.id)
                      }}
                      title="撤回"
                      className="shrink-0 pb-0.5 text-pink-300 transition-colors active:text-red-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {partnerTyping && (
          <div className="mt-3 flex items-center gap-1.5">
            <div className="flex items-center gap-1 rounded-2xl rounded-bl-md bg-white px-4 py-3 shadow-md shadow-pink-100">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-pink-300 [animation-delay:0ms]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-pink-300 [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-pink-300 [animation-delay:300ms]" />
            </div>
          </div>
        )}
        <div ref={listEndRef} />
      </div>

      {error && (
        <p className="bg-red-50 px-4 py-2 text-center text-xs text-red-400">{error}</p>
      )}

      {/* 输入栏 */}
      <div className="border-t border-pink-100 bg-white/80 p-3 pb-5 backdrop-blur-md">
        <div className="flex items-center gap-2">
          <input
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              sendTyping(user.name)
            }}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="说一句悄悄话…"
            maxLength={500}
            className="h-11 flex-1 rounded-full border border-pink-200 bg-white px-4 text-[15px] text-[#6b3a52] outline-none placeholder:text-pink-300 focus:border-pink-400"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim()}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-pink-400 to-rose-400 text-white shadow-lg shadow-pink-200 transition-all active:scale-90 disabled:opacity-40"
          >
            <Send className="h-5 w-5" />
          </button>
        </div>
      </div>
    </div>
  )
}
