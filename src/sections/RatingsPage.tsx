import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  RefreshCw,
  Send,
  Loader2,
  CloudOff,
  Search,
  Plus,
  ChevronDown,
  Tag,
  Check,
  X,
  Settings2,
  Pencil,
  MessageCircle,
  Users,
} from 'lucide-react'
import type { User } from './LoginPage'
import { getAllUsers as getUserMap } from './LoginPage'
import AvatarView from '../components/AvatarView'
import type { Category, LoveData, Rating } from '../lib/store'
import * as ratingsStore from '../lib/store'
import { getPairMembers } from '../lib/space'
import { MEMBER_AVATARS as AVATARS, MEMBER_AVATAR_LIST, avatarA } from '../lib/memberAvatars'

/** 打分面板需要的数据通道（见闻打分 store） */
export interface RatingStore {
  subscribeRatings: (onData: (data: LoveData) => void, onError?: (msg: string) => void) => () => void
  addRating: (r: {
    who: string
    title: string
    score: number
    note: string
    ts: number
    cat: string
    sub: string
  }) => Promise<Rating>
  rateItem: (id: string, who: string, score: number) => void
  addComment: (id: string, who: string, text: string) => void
  updateItem: (id: string, fields: { title: string; note: string; cat: string; sub: string }) => void
  addCategory: (name: string) => boolean
  addSubCategory: (catName: string, subName: string) => boolean
  deleteCategory: (name: string) => void
  deleteSubCategory: (catName: string, subName: string) => void
  resyncRatings: () => void
}

// 当前数据空间两人的头像（无自定义头像时按主题色回退默认头像）
const getPairedUserAvatars = (): Record<string, string> => {
  const members = getPairMembers()
  const fallbacks = MEMBER_AVATAR_LIST
  return Object.fromEntries(
    members.map((name, i) => [name, getUserMap()[name]?.avatar || fallbacks[i % 2]]),
  )
}

// 当前数据空间的两个人（当前用户 + 对方）
const getPairedUsers = (): string[] => getPairMembers()

const WHO_OPTIONS = ['全部', ...getPairedUsers()]
/** 大分类栏里的特殊筛选：综合评分最高（仅显示两人都打过分且综合 > 9.5 的） */
const TOP_KEY = '__top__'
const TOP_MIN = 9.5

/** 条目的综合评分（两人平均）；只有一个人打过返回 null */
function avgScoreOf(r: Rating): number | null {
  const values = Object.values(r.scores)
  if (values.length < 2) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 分数配色：高分玫红，中分粉，低分灰 */
function scoreColor(score: number): string {
  if (score >= 8) return 'bg-rose-400 text-white'
  if (score >= 6) return 'bg-pink-300 text-white'
  if (score >= 4) return 'bg-pink-200 text-[#8a4a68]'
  return 'bg-gray-200 text-gray-500'
}

/** 条目顶部徽章：双分取综合，单分直接显示 */
function headBadge(r: Rating): { text: string; cls: string } {
  const values = Object.values(r.scores)
  if (values.length >= 2) {
    const avg = values.reduce((a, b) => a + b, 0) / values.length
    return { text: `综合 ${avg.toFixed(1)}`, cls: scoreColor(avg) }
  }
  if (values.length === 1) return { text: values[0].toFixed(1), cls: scoreColor(values[0]) }
  return { text: '待打分', cls: 'bg-gray-100 text-gray-400' }
}

function Chip({
  active,
  onClick,
  children,
}: {
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 rounded-full px-3.5 py-1.5 text-xs font-medium transition-all active:scale-95 ${
        active
          ? 'bg-gradient-to-r from-pink-400 to-rose-400 text-white shadow-md shadow-pink-200'
          : 'bg-white text-[#b0678c] shadow-sm'
      }`}
    >
      {children}
    </button>
  )
}

/** "＋ 添加"虚线空位芯片 */
function AddChip({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className="flex shrink-0 items-center gap-1 rounded-full border-2 border-dashed border-pink-200 bg-white/60 px-3.5 py-1.5 text-xs font-medium text-pink-400 transition-all active:scale-95"
    >
      <Plus className="h-3 w-3" />
      {label}
    </button>
  )
}

/** 管理模式下的可删除芯片 */
function DeleteChip({ label, onDelete }: { label: string; onDelete: () => void }) {
  return (
    <button
      onClick={onDelete}
      className="flex shrink-0 items-center gap-1 rounded-full bg-white px-3 py-1.5 text-xs font-medium text-[#b0678c] shadow-sm transition-all active:scale-95"
    >
      {label}
      <X className="h-3 w-3 text-rose-400" />
    </button>
  )
}

/** 内联新建输入框 */
function InlineAdd({
  placeholder,
  onConfirm,
  onCancel,
}: {
  placeholder: string
  onConfirm: (name: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState('')
  const confirm = () => {
    if (value.trim()) onConfirm(value.trim())
  }
  return (
    <div className="flex items-center gap-2">
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && confirm()}
        maxLength={10}
        placeholder={placeholder}
        className="w-28 rounded-full border border-pink-200 bg-white px-3 py-1.5 text-xs text-[#8a4a68] outline-none placeholder:text-pink-300 focus:border-pink-400"
      />
      <button
        onClick={confirm}
        disabled={!value.trim()}
        className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-r from-pink-400 to-rose-400 text-white shadow disabled:opacity-40"
      >
        <Check className="h-3.5 w-3.5" />
      </button>
      <button onClick={onCancel} className="text-xs text-pink-300 active:text-pink-500">
        取消
      </button>
    </div>
  )
}

/** 大分类 + 小分类选择器（添加表单和编辑面板共用，含 ＋ 添加空位） */
function CategoryPicker({
  cats,
  cat,
  sub,
  onPickCat,
  onPickSub,
  store,
}: {
  cats: Category[]
  cat: string
  sub: string
  onPickCat: (name: string) => void
  onPickSub: (name: string) => void
  store: RatingStore
}) {
  const [addingCat, setAddingCat] = useState(false)
  const [addingSub, setAddingSub] = useState(false)
  const selectedCat = cats.find((c) => c.name === cat)

  return (
    <>
      <p className="mb-2 flex items-center gap-1 text-xs text-pink-400">
        <Tag className="h-3 w-3" /> 大分类
      </p>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {cats.map((c) => (
          <Chip key={c.name} active={cat === c.name} onClick={() => onPickCat(c.name)}>
            {c.name}
          </Chip>
        ))}
        {addingCat ? (
          <InlineAdd
            placeholder="新大分类名"
            onConfirm={(name) => {
              if (store.addCategory(name)) onPickCat(name)
              setAddingCat(false)
            }}
            onCancel={() => setAddingCat(false)}
          />
        ) : (
          <AddChip label="添加" onClick={() => setAddingCat(true)} />
        )}
      </div>

      {cat && (
        <>
          <p className="mb-2 flex items-center gap-1 text-xs text-pink-400">
            <Tag className="h-3 w-3" /> 小分类
          </p>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {(selectedCat?.subs ?? []).map((name) => (
              <Chip key={name} active={sub === name} onClick={() => onPickSub(name)}>
                {name}
              </Chip>
            ))}
            {addingSub ? (
              <InlineAdd
                placeholder="新小分类名"
                onConfirm={(name) => {
                  if (store.addSubCategory(cat, name)) onPickSub(name)
                  setAddingSub(false)
                }}
                onCancel={() => setAddingSub(false)}
              />
            ) : (
              <AddChip label="添加" onClick={() => setAddingSub(true)} />
            )}
          </div>
        </>
      )}
    </>
  )
}

export function RatingBoard({
  user,
  onBack,
  store,
  pageTitle,
  rewards,
}: {
  user: User
  onBack: () => void
  store: RatingStore
  pageTitle: string
  /** 时元奖励提示：create 发起奖励 / participate 首次参与奖励（0 或不传则不提示） */
  rewards?: { create?: number; participate?: number }
}) {
  const {
    subscribeRatings,
    addRating,
    rateItem,
    addComment,
    updateItem,
    deleteCategory,
    deleteSubCategory,
    resyncRatings,
  } = store
  const [ratings, setRatings] = useState<Rating[]>([])
  const [cats, setCats] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [toast, setToast] = useState('')

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(''), 2600)
  }

  // 添加表单
  const [formOpen, setFormOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [cat, setCat] = useState('')
  const [sub, setSub] = useState('')
  const [score, setScore] = useState(8)
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const [manageMode, setManageMode] = useState(false)

  // 补分 / 改分
  const [ratingId, setRatingId] = useState('')
  const [ratingScore, setRatingScore] = useState(8)

  // 评论 / 追评
  const [openCommentId, setOpenCommentId] = useState('')
  const [commentText, setCommentText] = useState('')

  // 编辑整条见闻
  const [editingId, setEditingId] = useState('')
  const [editTitle, setEditTitle] = useState('')
  const [editNote, setEditNote] = useState('')
  const [editCat, setEditCat] = useState('')
  const [editSub, setEditSub] = useState('')

  // 筛选
  const [query, setQuery] = useState('')
  const [filterCat, setFilterCat] = useState('全部')
  const [filterSub, setFilterSub] = useState('全部')
  const [filterWho, setFilterWho] = useState('全部')

  // 订阅云端消息：双方任何更新都会实时推送过来
  useEffect(() => {
    const timer = setTimeout(() => setLoading(false), 3500)
    const unsub = subscribeRatings(
      (data) => {
        setRatings(data.items)
        setCats(data.cats)
        setLoading(false)
        setSyncing(false)
      },
      (msg) => setError(msg),
    )
    return () => {
      clearTimeout(timer)
      unsub()
    }
  }, [])

  const refresh = () => {
    setSyncing(true)
    resyncRatings()
    setTimeout(() => setSyncing(false), 2500)
  }

  const submit = async () => {
    const trimmed = title.trim()
    if (!trimmed || sending) return
    setSending(true)
    try {
      await addRating({
        who: user.name,
        title: trimmed,
        score,
        note: note.trim(),
        ts: Date.now(),
        cat,
        sub,
      })
      setTitle('')
      setNote('')
      setScore(8)
      setFormOpen(false)
      if (rewards?.create) showToast(`🪙 +${rewards.create} 时元已入账`)
    } catch {
      setError('保存失败，请检查网络后重试')
    } finally {
      setSending(false)
    }
  }

  const confirmRate = (id: string) => {
    // 首次参与才提示奖励（修改自己的分不重复奖励）
    const target = ratings.find((x) => x.id === id)
    const firstJoin = target ? target.scores[user.name] === undefined : false
    rateItem(id, user.name, ratingScore)
    setRatingId('')
    if (firstJoin && rewards?.participate) showToast(`🪙 +${rewards.participate} 时元已入账`)
  }

  const sendComment = (id: string) => {
    const trimmed = commentText.trim()
    if (!trimmed) return
    addComment(id, user.name, trimmed)
    setCommentText('')
  }

  const startEdit = (r: Rating) => {
    setEditingId(r.id)
    setEditTitle(r.title)
    setEditNote(r.note)
    setEditCat(r.cat)
    setEditSub(r.sub)
    setRatingId('')
  }

  const saveEdit = () => {
    const trimmed = editTitle.trim()
    if (!trimmed) return
    updateItem(editingId, { title: trimmed, note: editNote.trim(), cat: editCat, sub: editSub })
    setEditingId('')
  }

  const onDeleteCat = (name: string) => {
    if (window.confirm(`删除大分类「${name}」？\n里面的见闻会变为"未分类"，不会丢失。`)) {
      deleteCategory(name)
      if (cat === name) {
        setCat('')
        setSub('')
      }
      if (filterCat === name) {
        setFilterCat('全部')
        setFilterSub('全部')
      }
    }
  }

  const onDeleteSub = (catName: string, subName: string) => {
    if (window.confirm(`删除小分类「${subName}」？\n相关见闻的大分类保留，小分类清空。`)) {
      deleteSubCategory(catName, subName)
      if (sub === subName) setSub('')
      if (filterSub === subName) setFilterSub('全部')
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim()
    // 综合评分最高模式：两人都打过分且综合 > 9.5，按分数从高到低排
    if (filterCat === TOP_KEY) {
      return ratings
        .filter((r) => {
          const avg = avgScoreOf(r)
          if (avg === null || avg <= TOP_MIN) return false
          if (filterWho !== '全部' && r.scores[filterWho] === undefined) return false
          if (q && !r.title.includes(q) && !r.note.includes(q)) return false
          return true
        })
        .sort((a, b) => (avgScoreOf(b) ?? 0) - (avgScoreOf(a) ?? 0))
    }
    return ratings.filter((r) => {
      if (filterCat !== '全部' && (r.cat || '未分类') !== filterCat) return false
      if (filterSub !== '全部' && (r.sub || '未分类') !== filterSub) return false
      if (filterWho !== '全部' && r.scores[filterWho] === undefined) return false
      if (q && !r.title.includes(q) && !r.note.includes(q)) return false
      return true
    })
  }, [ratings, query, filterCat, filterSub, filterWho])

  const selectedCat = cats.find((c) => c.name === cat)
  const filterCatObj = cats.find((c) => c.name === filterCat)

  return (
    <div className="min-h-dvh bg-gradient-to-b from-[#fff5f8] via-[#fdeef6] to-[#fae3ef]">
      {/* 顶部栏 */}
      <div className="sticky top-0 z-10 flex items-center gap-3 bg-[#fff5f8]/90 px-5 pb-3 pt-6 backdrop-blur">
        <button
          onClick={onBack}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-[#c44d7d] shadow transition-transform active:scale-90"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-lg font-bold tracking-widest text-[#c44d7d]">{pageTitle}</h1>
          <div className="flex items-center gap-1">
            <Users className="h-3 w-3 text-pink-300" />
            <p className="text-xs text-pink-300">两人专属，共同记录</p>
          </div>
        </div>
        <button
          onClick={refresh}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-pink-400 shadow transition-transform active:scale-90"
          title="刷新"
        >
          <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* 奖励提示 */}
      {toast && (
        <div className="fixed inset-x-0 top-20 z-[60] mx-auto w-fit max-w-[85vw] rounded-full bg-black/70 px-4 py-2 text-center text-xs text-white shadow-xl">
          {toast}
        </div>
      )}

      <div className="mx-auto max-w-md px-5 pb-16">
        {/* ===== 添加入口 / 表单 ===== */}
        {!formOpen ? (
          <button
            onClick={() => setFormOpen(true)}
            className="mb-5 flex w-full items-center justify-center gap-2 rounded-3xl bg-gradient-to-r from-pink-400 to-rose-400 py-4 text-sm font-semibold text-white shadow-lg shadow-pink-200 transition-all active:scale-[0.98]"
          >
            <Plus className="h-5 w-5" />
            添加一条{pageTitle}
          </button>
        ) : (
          <div className="mb-5 rounded-3xl bg-white p-5 shadow-lg shadow-pink-100">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <AvatarView
                  name={user.name}
                  fallback={user.avatar}
                  size={40}
                  className="border-2 border-pink-100"
                />
                <span className="text-sm font-semibold text-[#8a4a68]">{user.name} 来打分</span>
              </div>
              <button onClick={() => setFormOpen(false)} className="text-pink-300 active:text-pink-500">
                <ChevronDown className="h-5 w-5" />
              </button>
            </div>

            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={30}
              placeholder="遇到了什么有趣的？（如：楼下的橘猫）"
              className="mb-4 w-full rounded-2xl border border-pink-100 bg-pink-50/50 px-4 py-3 text-sm text-[#8a4a68] outline-none placeholder:text-pink-300 focus:border-pink-300 focus:bg-white"
            />

            {/* 分类（自建 + 管理删除） */}
            <div className="mb-2 flex items-center justify-between">
              <p className="flex items-center gap-1 text-xs text-pink-400">
                <Tag className="h-3 w-3" /> 分类
              </p>
              <button
                onClick={() => setManageMode((v) => !v)}
                className={`flex items-center gap-1 text-xs transition-colors ${
                  manageMode ? 'font-semibold text-rose-400' : 'text-pink-300'
                }`}
              >
                <Settings2 className="h-3 w-3" />
                {manageMode ? '完成' : '管理'}
              </button>
            </div>

            {manageMode ? (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  {cats.map((c) => (
                    <DeleteChip key={c.name} label={c.name} onDelete={() => onDeleteCat(c.name)} />
                  ))}
                  {cats.length === 0 && <span className="text-xs text-pink-300">还没有分类</span>}
                </div>
                {selectedCat && selectedCat.subs.length > 0 && (
                  <div className="mb-4 flex flex-wrap items-center gap-2">
                    {selectedCat.subs.map((name) => (
                      <DeleteChip key={name} label={name} onDelete={() => onDeleteSub(cat, name)} />
                    ))}
                  </div>
                )}
              </>
            ) : (
              <CategoryPicker
                cats={cats}
                cat={cat}
                sub={sub}
                onPickCat={(name) => {
                  setCat(name)
                  setSub('')
                }}
                onPickSub={setSub}
                store={store}
              />
            )}

            {/* 评分滑杆 1-10，0.5 一档 */}
            <div className="mb-4 rounded-2xl bg-pink-50/60 px-4 py-3">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs text-pink-400">我的评分</span>
                <span className={`rounded-full px-3 py-0.5 text-sm font-bold tabular-nums ${scoreColor(score)}`}>
                  {score.toFixed(1)} 分
                </span>
              </div>
              <input
                type="range"
                min={1}
                max={10}
                step={0.5}
                value={score}
                onChange={(e) => setScore(Number(e.target.value))}
                className="love-slider w-full"
              />
              <div className="flex justify-between text-[10px] text-pink-300">
                <span>1</span>
                <span>5</span>
                <span>10</span>
              </div>
            </div>

            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={100}
              rows={2}
              placeholder="想说点什么…（可不填）"
              className="mb-4 w-full resize-none rounded-2xl border border-pink-100 bg-pink-50/50 px-4 py-3 text-sm text-[#8a4a68] outline-none placeholder:text-pink-300 focus:border-pink-300 focus:bg-white"
            />

            <button
              onClick={submit}
              disabled={!title.trim() || sending}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-pink-400 to-rose-400 py-3 text-sm font-semibold text-white shadow-lg shadow-pink-200 transition-all active:scale-95 disabled:opacity-40"
            >
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {sending ? '保存中…' : '记录下来'}
            </button>
          </div>
        )}

        {/* ===== 筛选区 ===== */}
        <div className="mb-3 flex items-center gap-2 rounded-2xl bg-white px-4 py-2.5 shadow-sm">
          <Search className="h-4 w-4 shrink-0 text-pink-300" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索见闻…"
            className="w-full bg-transparent text-sm text-[#8a4a68] outline-none placeholder:text-pink-300"
          />
        </div>

        <div className="mb-2 flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {['全部', TOP_KEY, ...cats.map((c) => c.name)].map((name) => (
            <Chip
              key={name}
              active={filterCat === name}
              onClick={() => {
                setFilterCat(name)
                setFilterSub('全部')
              }}
            >
              {name === TOP_KEY ? '🏆 最高分' : name}
            </Chip>
          ))}
        </div>

        {filterCatObj && filterCatObj.subs.length > 0 && (
          <div className="mb-2 flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {['全部', ...filterCatObj.subs].map((name) => (
              <Chip key={name} active={filterSub === name} onClick={() => setFilterSub(name)}>
                {name}
              </Chip>
            ))}
          </div>
        )}

        <div className="mb-4 flex gap-2">
          {WHO_OPTIONS.map((name) => (
            <Chip key={name} active={filterWho === name} onClick={() => setFilterWho(name)}>
              {name}
            </Chip>
          ))}
          <span className="ml-auto self-center text-xs text-pink-300">共 {filtered.length} 条</span>
        </div>

        {/* 状态提示 */}
        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-2xl bg-amber-50 px-4 py-3 text-xs text-amber-500">
            <CloudOff className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {/* ===== 记录列表 ===== */}
        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-pink-300" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center">
            <Search className="mx-auto mb-3 h-8 w-8 text-pink-200" />
            <p className="text-sm text-pink-300">
              {ratings.length === 0 ? '还没有记录' : filterCat === TOP_KEY ? `还没有综合评分超过 ${TOP_MIN} 的见闻` : '没有找到相关记录'}
            </p>
            <p className="mt-1 text-xs text-pink-200">
              {ratings.length === 0 ? '写下第一条见闻，对方马上就能看到' : '换个分类或关键词试试'}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {filtered.map((r) => {
              const badge = headBadge(r)
              const editing = editingId === r.id
              return (
                <div key={r.id} className="rounded-3xl bg-white p-4 shadow-sm shadow-pink-100">
                  {/* ===== 编辑面板 ===== */}
                  {editing ? (
                    <div>
                      <p className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-[#c44d7d]">
                        <Pencil className="h-3.5 w-3.5" /> 编辑见闻
                      </p>
                      <input
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        maxLength={30}
                        placeholder="事件名称"
                        className="mb-3 w-full rounded-2xl border border-pink-100 bg-pink-50/50 px-4 py-2.5 text-sm text-[#8a4a68] outline-none placeholder:text-pink-300 focus:border-pink-300 focus:bg-white"
                      />
                      <textarea
                        value={editNote}
                        onChange={(e) => setEditNote(e.target.value)}
                        maxLength={100}
                        rows={2}
                        placeholder="事件介绍…（可不填）"
                        className="mb-3 w-full resize-none rounded-2xl border border-pink-100 bg-pink-50/50 px-4 py-2.5 text-sm text-[#8a4a68] outline-none placeholder:text-pink-300 focus:border-pink-300 focus:bg-white"
                      />
                      <CategoryPicker
                        cats={cats}
                        cat={editCat}
                        sub={editSub}
                        onPickCat={(name) => {
                          setEditCat(name)
                          setEditSub('')
                        }}
                        onPickSub={setEditSub}
                        store={store}
                      />
                      <div className="flex justify-end gap-3">
                        <button
                          onClick={() => setEditingId('')}
                          className="text-xs text-pink-300 active:text-pink-500"
                        >
                          取消
                        </button>
                        <button
                          onClick={saveEdit}
                          disabled={!editTitle.trim()}
                          className="rounded-full bg-gradient-to-r from-pink-400 to-rose-400 px-4 py-1.5 text-xs font-semibold text-white shadow active:scale-95 disabled:opacity-40"
                        >
                          保存
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {/* ===== 展示模式 ===== */}
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <span className="text-base font-semibold text-[#8a4a68]">{r.title}</span>
                          <button
                            onClick={() => startEdit(r)}
                            className="text-pink-300 transition-colors active:text-pink-500"
                            title="编辑"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold tabular-nums ${badge.cls}`}>
                          {badge.text}
                        </span>
                      </div>

                      <div className="mb-2 flex items-center gap-1.5">
                        <span className="rounded-full bg-pink-50 px-2.5 py-0.5 text-[11px] text-[#c44d7d]">
                          {r.cat || '未分类'}
                        </span>
                        {r.sub && (
                          <>
                            <span className="text-[11px] text-pink-200">·</span>
                            <span className="rounded-full bg-pink-50 px-2.5 py-0.5 text-[11px] text-[#b0678c]">
                              {r.sub}
                            </span>
                          </>
                        )}
                      </div>

                      {r.note && <p className="mb-2.5 text-sm leading-relaxed text-[#a06b87]">{r.note}</p>}

                      {/* 双人评分区 */}
                      <div className="mb-2.5 flex gap-2">
                        {getPairedUsers().map((name) => {
                          const s = r.scores[name]
                          const isMe = name === user.name
                          const pairedAvatars = getPairedUserAvatars()
                          
                          if (s !== undefined) {
                            return (
                              <button
                                key={name}
                                onClick={() => {
                                  if (isMe) {
                                    setRatingId(r.id)
                                    setRatingScore(s)
                                    setEditingId('')
                                  }
                                }}
                                className={`flex flex-1 items-center justify-center gap-1.5 rounded-2xl px-2 py-2 text-xs font-semibold ${scoreColor(s)} ${
                                  isMe ? 'opacity-100' : 'opacity-80'
                                }`}
                                title={isMe ? '点我修改评分' : ''}
                              >
                                <img src={pairedAvatars[name] || AVATARS[name]} alt={name} className="h-4 w-4 rounded-full object-cover" />
                                {name} {s.toFixed(1)}
                                {isMe && <span className="text-[10px] opacity-70">改</span>}
                              </button>
                            )
                          }
                          if (isMe) {
                            return (
                              <button
                                key={name}
                                onClick={() => {
                                  setRatingId(r.id)
                                  setRatingScore(8)
                                  setEditingId('')
                                }}
                                className="flex flex-1 items-center justify-center gap-1 rounded-2xl border-2 border-dashed border-pink-300 bg-pink-50/60 px-2 py-2 text-xs font-semibold text-[#c44d7d] transition-all active:scale-95"
                              >
                                <Plus className="h-3.5 w-3.5" />
                                我来打分
                              </button>
                            )
                          }
                          return (
                            <div
                              key={name}
                              className="flex flex-1 items-center justify-center gap-1 rounded-2xl bg-gray-50 px-2 py-2 text-xs text-gray-400"
                            >
                              {name} 待打分
                            </div>
                          )
                        })}
                      </div>

                      {/* 打分滑杆面板 */}
                      {ratingId === r.id && (
                        <div className="mb-2.5 rounded-2xl bg-pink-50/60 px-4 py-3">
                          <div className="mb-1 flex items-center justify-between">
                            <span className="text-xs text-pink-400">{user.name} 的评分</span>
                            <span className={`rounded-full px-3 py-0.5 text-sm font-bold tabular-nums ${scoreColor(ratingScore)}`}>
                              {ratingScore.toFixed(1)} 分
                            </span>
                          </div>
                          <input
                            type="range"
                            min={1}
                            max={10}
                            step={0.5}
                            value={ratingScore}
                            onChange={(e) => setRatingScore(Number(e.target.value))}
                            className="love-slider w-full"
                          />
                          <div className="mt-2 flex justify-end gap-3">
                            <button onClick={() => setRatingId('')} className="text-xs text-pink-300 active:text-pink-500">
                              取消
                            </button>
                            <button
                              onClick={() => confirmRate(r.id)}
                              className="rounded-full bg-gradient-to-r from-pink-400 to-rose-400 px-4 py-1.5 text-xs font-semibold text-white shadow active:scale-95"
                            >
                              确定
                            </button>
                          </div>
                        </div>
                      )}

                      {/* 评论区入口：双方可评、可追评 */}
                      <button
                        onClick={() => {
                          setOpenCommentId(openCommentId === r.id ? '' : r.id)
                          setCommentText('')
                        }}
                        className="mb-2.5 flex items-center gap-1.5 text-xs text-pink-400 transition-colors active:text-pink-600"
                      >
                        <MessageCircle className="h-3.5 w-3.5" />
                        {r.comments.length > 0 ? `评论 ${r.comments.length}` : '抢首评'}
                        <span className="text-pink-200">
                          {openCommentId === r.id ? '收起' : '展开'}
                        </span>
                      </button>

                      {/* 评论串：一行一条，名字在前，按时间排列 */}
                      {openCommentId === r.id && (
                        <div className="mb-2.5 rounded-2xl bg-pink-50/50 px-3.5 py-2.5">
                          {r.comments.length > 0 && (
                            <div className="mb-2 flex flex-col gap-1.5">
                              {r.comments.map((c) => {
                                const pairedAvatars = getPairedUserAvatars()
                                return (
                                  <div key={c.id} className="flex items-start gap-1.5">
                                    <img
                                      src={pairedAvatars[c.who] || AVATARS[c.who] || avatarA}
                                      alt={c.who}
                                      className="mt-0.5 h-4 w-4 shrink-0 rounded-full object-cover"
                                    />
                                    <p className="flex-1 text-xs leading-relaxed text-[#a06b87]">
                                      <span className="font-semibold text-[#c44d7d]">{c.who}：</span>
                                      {c.text}
                                      <span className="ml-1.5 text-[10px] text-pink-200">
                                        {formatTime(c.ts)}
                                      </span>
                                    </p>
                                  </div>
                                )
                              })}
                            </div>
                          )}
                          <div className="flex items-center gap-2">
                            <input
                              value={commentText}
                              onChange={(e) => setCommentText(e.target.value)}
                              onKeyDown={(e) => e.key === 'Enter' && sendComment(r.id)}
                              maxLength={60}
                              placeholder={r.comments.length > 0 ? '追评一句…' : '写下第一条评论…'}
                              className="flex-1 rounded-full border border-pink-100 bg-white px-3.5 py-2 text-xs text-[#8a4a68] outline-none placeholder:text-pink-300 focus:border-pink-300"
                            />
                            <button
                              onClick={() => sendComment(r.id)}
                              disabled={!commentText.trim()}
                              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-r from-pink-400 to-rose-400 text-white shadow transition-transform active:scale-90 disabled:opacity-40"
                            >
                              <Send className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      )}

                      <div className="flex items-center justify-between border-t border-pink-50 pt-2.5">
                        <div className="flex items-center gap-2">
                          <img
                            src={getPairedUserAvatars()[r.createdBy] || AVATARS[r.createdBy] || avatarA}
                            alt={r.createdBy}
                            className="h-6 w-6 rounded-full object-cover"
                          />
                          <span className="text-xs font-medium text-[#c44d7d]">{r.createdBy} 记录</span>
                        </div>
                        <span className="text-xs text-pink-300">{formatTime(r.ts)}</span>
                      </div>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* 版本标记 */}
        <p className="mt-10 text-center text-[10px] tracking-widest text-pink-200">v9 · 双人评论</p>
      </div>

      <style>{`
        .love-slider {
          -webkit-appearance: none;
          appearance: none;
          height: 6px;
          border-radius: 9999px;
          background: linear-gradient(to right, #f9a8c9, #fb7185);
          outline: none;
        }
        .love-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 22px;
          height: 22px;
          border-radius: 9999px;
          background: #fff;
          border: 3px solid #fb7185;
          box-shadow: 0 2px 6px rgba(251, 113, 133, 0.4);
          cursor: pointer;
        }
        .love-slider::-moz-range-thumb {
          width: 22px;
          height: 22px;
          border-radius: 9999px;
          background: #fff;
          border: 3px solid #fb7185;
          box-shadow: 0 2px 6px rgba(251, 113, 133, 0.4);
          cursor: pointer;
        }
      `}</style>
    </div>
  )
}

/** 见闻打分（主页功能）：注入见闻打分数据通道 */
export default function RatingsPage({ user, onBack }: { user: User; onBack: () => void }) {
  return (
    <RatingBoard
      user={user}
      onBack={onBack}
      store={ratingsStore}
      pageTitle="见闻打分"
      rewards={{ create: 10, participate: 5 }}
    />
  )
}
