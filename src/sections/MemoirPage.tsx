/* 回忆录：双人日记本 —— 双方都能写，自己的篇章可以改/删，游客只读 */
import { useEffect, useState } from 'react'
import { ArrowLeft, BookHeart, Loader2, Pencil, PenLine, Trash2, X } from 'lucide-react'
import type { User } from './LoginPage'
import EnvelopeReveal from '../components/EnvelopeReveal'
import {
  MOODS,
  addEntry,
  listMemoir,
  removeEntry,
  subscribeMemoir,
  updateEntry,
  type MemoirEntry,
} from '../lib/memoir'
import { MEMBER_A, MEMBER_B } from '../config'

// 动态获取所有用户（包括默认用户和注册用户）
// const getAllUsers = () => {
//   const allUsers = Object.values(require('./LoginPage').USERS) as Array<{ name: string }>
//   return allUsers.map(u => u.name)
// }

const AUTHOR_STYLE: Record<string, string> = {
  [MEMBER_B]: 'bg-pink-100 text-pink-500',
  [MEMBER_A]: 'bg-indigo-100 text-indigo-500',
}

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

type Draft = { title: string; content: string; mood: string; date: string }
const EMPTY: Draft = { title: '', content: '', mood: '😊', date: today() }

export default function MemoirPage({ user, onBack }: { user: User; onBack: () => void }) {
  const [, setTick] = useState(0)
  const [writing, setWriting] = useState(false)
  const [editing, setEditing] = useState<MemoirEntry | null>(null) // 编辑已有篇章
  const [reading, setReading] = useState<MemoirEntry | null>(null) // 阅读全文
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [tip, setTip] = useState('')
  const [confirmDel, setConfirmDel] = useState<MemoirEntry | null>(null)

  useEffect(() => subscribeMemoir(() => setTick((t) => t + 1)), [])

  // 提示 2 秒自动消失
  useEffect(() => {
    if (!tip) return
    const t = setTimeout(() => setTip(''), 2000)
    return () => clearTimeout(t)
  }, [tip])

  const entries = listMemoir()
  const openEditor = writing || editing

  const startWrite = () => {
    setDraft({ ...EMPTY, date: today() })
    setWriting(true)
  }
  const startEdit = (e: MemoirEntry) => {
    setDraft({ title: e.title, content: e.content, mood: e.mood, date: e.date })
    setReading(null)
    setEditing(e)
  }

  const save = () => {
    if (saving) return
    setSaving(true)
    const r = editing
      ? updateEntry(editing.id, user.name, draft)
      : addEntry(user.name, draft)
    setSaving(false)
    if (!r.ok) {
      setTip(r.msg ?? '保存失败')
      return
    }
    setWriting(false)
    setEditing(null)
    setDraft(EMPTY)
  }

  const doDelete = () => {
    if (!confirmDel) return
    const r = removeEntry(confirmDel.id, user.name)
    if (!r.ok) setTip(r.msg ?? '删除失败')
    setConfirmDel(null)
    setReading(null)
  }

  return (
    <div className="min-h-dvh bg-gradient-to-b from-[#fff5f8] via-[#fdeef6] to-[#fae3ef] pb-10">
      {/* 顶栏 */}
      <div className="sticky top-0 z-10 flex items-center gap-3 bg-white/80 px-4 py-3 shadow-sm backdrop-blur">
        <button onClick={onBack} className="rounded-full p-1.5 text-[#c44d7d] active:bg-pink-100">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <BookHeart className="h-4 w-4 text-[#c44d7d]" />
        <p className="flex-1 text-sm font-bold text-[#c44d7d]">回忆录</p>
        <span className="text-[11px] text-pink-300">{entries.length} 篇</span>
      </div>

      {/* 写一篇入口（游客隐藏） */}
      {!user.guest && (
        <div className="px-4 pt-4">
          <button
            onClick={startWrite}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-pink-400 to-rose-400 py-3 text-sm font-bold tracking-widest text-white shadow-lg shadow-pink-200 transition-transform active:scale-95"
          >
            <PenLine className="h-4 w-4" /> 写一篇
          </button>
        </div>
      )}

      {/* 篇章列表 */}
      <div className="mt-4 space-y-3 px-4">
        {entries.length === 0 && (
          <div className="mt-16 text-center">
            <BookHeart className="mx-auto h-10 w-10 text-pink-200" />
            <p className="mt-3 text-sm text-pink-300">还没有篇章，写下你们的第一页吧</p>
          </div>
        )}
        {entries.map((e) => (
          <button
            key={e.id}
            onClick={() => setReading(e)}
            className="w-full rounded-2xl bg-white p-4 text-left shadow-md shadow-pink-100 transition-transform active:scale-[0.98]"
          >
            <div className="flex items-center gap-2">
              <span className="text-lg">{e.mood}</span>
              <p className="min-w-0 flex-1 truncate text-sm font-bold text-[#8a4a68]">{e.title}</p>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${AUTHOR_STYLE[e.author] ?? 'bg-gray-100 text-gray-500'}`}>
                {e.author}
              </span>
            </div>
            <p className="mt-2 line-clamp-3 text-xs leading-relaxed whitespace-pre-wrap text-[#a06f8b]">{e.content}</p>
            <p className="mt-2 text-[10px] tracking-wider text-pink-300">{e.date}</p>
          </button>
        ))}
      </div>

      {/* 浮动提示 */}
      {tip && (
        <div className="fixed top-20 left-1/2 z-[70] -translate-x-1/2 rounded-full bg-gray-800/85 px-4 py-2 text-xs whitespace-nowrap text-white shadow-lg backdrop-blur">
          {tip}
        </div>
      )}

      {/* 阅读全文弹窗（信封拆开体验） */}
      {reading && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 backdrop-blur-sm" onClick={() => setReading(null)}>
          <div
            className="max-h-[82dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white/95 p-5 shadow-2xl"
            onClick={(ev) => ev.stopPropagation()}
          >
            <EnvelopeReveal seal={reading.mood} title={reading.title} subtitle={`${reading.date} · ${reading.author}`}>
              <p className="text-sm leading-[1.9] whitespace-pre-wrap text-[#5d3a4e]">{reading.content}</p>
              {reading.author === user.name && !user.guest && (
                <div className="mt-6 flex gap-3">
                  <button
                    onClick={() => startEdit(reading)}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-indigo-50 py-2.5 text-sm font-semibold text-indigo-500 active:scale-95"
                  >
                    <Pencil className="h-3.5 w-3.5" /> 修改
                  </button>
                  <button
                    onClick={() => setConfirmDel(reading)}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-red-50 py-2.5 text-sm font-semibold text-red-400 active:scale-95"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> 删除
                  </button>
                </div>
              )}
            </EnvelopeReveal>
          </div>
        </div>
      )}

      {/* 写/改 编辑器弹窗 */}
      {openEditor && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 backdrop-blur-sm">
          <div className="max-h-[88dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-6 shadow-2xl">
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold text-[#c44d7d]">{editing ? '修改这篇' : '写一篇'}</p>
              <button
                onClick={() => { setWriting(false); setEditing(null) }}
                className="rounded-full p-1.5 text-pink-300 active:bg-pink-50"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* 心情选择 */}
            <div className="mt-4 flex flex-wrap gap-2">
              {MOODS.map((m) => (
                <button
                  key={m}
                  onClick={() => setDraft((d) => ({ ...d, mood: m }))}
                  className={`flex h-9 w-9 items-center justify-center rounded-full text-lg transition-transform active:scale-90 ${
                    draft.mood === m ? 'bg-pink-100 ring-2 ring-pink-300' : 'bg-gray-50'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>

            {/* 日期 */}
            <input
              type="date"
              value={draft.date}
              onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))}
              className="mt-4 w-full rounded-xl border border-pink-200 bg-pink-50/50 px-3.5 py-2.5 text-sm text-[#8a4a68] outline-none"
            />

            {/* 标题 */}
            <input
              value={draft.title}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
              placeholder="给这一天起个题目（可留空）"
              maxLength={30}
              className="mt-3 w-full rounded-xl border border-pink-200 bg-pink-50/50 px-3.5 py-2.5 text-sm text-[#8a4a68] outline-none placeholder:text-pink-300"
            />

            {/* 正文 */}
            <textarea
              value={draft.content}
              onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
              placeholder="今天发生了什么值得记住的事…"
              rows={8}
              className="mt-3 w-full resize-none rounded-xl border border-pink-200 bg-pink-50/50 px-3.5 py-2.5 text-sm leading-relaxed text-[#8a4a68] outline-none placeholder:text-pink-300"
            />

            <button
              onClick={save}
              disabled={saving || !draft.content.trim()}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-pink-400 to-rose-400 py-3 text-sm font-bold tracking-widest text-white shadow-md shadow-pink-200 active:scale-95 disabled:opacity-40"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <PenLine className="h-4 w-4" />}
              {editing ? '保存修改' : '收进回忆录'}
            </button>
          </div>
        </div>
      )}

      {/* 删除确认 */}
      {confirmDel && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-8 backdrop-blur-sm">
          <div className="w-full max-w-xs rounded-3xl bg-white p-6 text-center shadow-2xl">
            <p className="text-sm font-bold text-[#8a4a68]">确定删掉《{confirmDel.title}》吗？</p>
            <p className="mt-2 text-xs text-pink-300">删掉就找不回来啦</p>
            <div className="mt-5 flex gap-3">
              <button
                onClick={() => setConfirmDel(null)}
                className="flex-1 rounded-xl bg-gray-100 py-2.5 text-sm font-semibold text-gray-500 active:scale-95"
              >
                再想想
              </button>
              <button
                onClick={doDelete}
                className="flex-1 rounded-xl bg-gradient-to-r from-red-400 to-rose-400 py-2.5 text-sm font-bold text-white active:scale-95"
              >
                删掉
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
