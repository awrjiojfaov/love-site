import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  MapPin,
  Heart,
  Zap,
  Trophy,
  Dices,
  Plane,
  PlaneTakeoff,
  Plus,
  Trash2,
  BookOpen,
  RotateCcw,
  X,
} from 'lucide-react'
import type { User } from './LoginPage'
import {
  subscribeChess,
  startMatch,
  backToSetup,
  roll,
  confirmExecution,
  verifyTask,
  addTheme,
  removeTheme,
  addTask,
  removeTask,
  chooseTheme,
  GRID_N,
  type ChessState,
} from '../lib/flyingChess'
import FloatingBack from '../components/FloatingBack'

/** 螺旋棋盘：7×7，编号 1..49 顺时针向内 */
function buildSpiralGrid(n: number): number[][] {
  const grid = Array.from({ length: n }, () => Array(n).fill(0))
  let top = 0
  let bottom = n - 1
  let left = 0
  let right = n - 1
  let num = 1
  while (top <= bottom && left <= right) {
    for (let c = left; c <= right; c++) grid[top][c] = num++
    top++
    for (let r = top; r <= bottom; r++) grid[r][right] = num++
    right--
    if (top <= bottom) {
      for (let c = right; c >= left; c--) grid[bottom][c] = num++
      bottom--
    }
    if (left <= right) {
      for (let r = bottom; r >= top; r--) grid[r][left] = num++
      left++
    }
  }
  return grid
}

const GLASS = 'rounded-2xl border border-white/15 bg-white/10 backdrop-blur'

export default function FlyingChessPage({ user, onBack }: { user: User; onBack: () => void }) {
  const [state, setState] = useState<ChessState | null>(null)
  useEffect(() => subscribeChess(setState), [])

  // 掷骰动画
  const [lastDice, setLastDice] = useState<number | null>(null)
  const [rolling, setRolling] = useState(false)
  // 棋子逐步逼近真实位置的动画（未初始化时以目标值起步，无需额外初始化 effect）
  const [disp, setDisp] = useState<Record<string, number>>({})
  // 题库管理面板
  const [libOpen, setLibOpen] = useState(false)

  const grid = useMemo(() => buildSpiralGrid(GRID_N), [])
  const stepPos = useMemo(() => {
    const map: Record<number, { row: number; col: number }> = {}
    for (let r = 0; r < GRID_N; r++)
      for (let c = 0; c < GRID_N; c++) map[grid[r][c]] = { row: r, col: c }
    return map
  }, [grid])

  const players = useMemo<[string, string]>(
    () => state?.players ?? ['玩家一', '玩家二'],
    [state],
  )

  // 位置动画：定时器回调里推进（异步，不在 effect 体内同步 setState）
  useEffect(() => {
    if (!state) return
    const id = setInterval(() => {
      setDisp((prev) => {
        let changed = false
        const next = { ...prev }
        for (const p of state.players) {
          const target = state.pos[p] ?? 0
          const cur = prev[p] ?? target
          if (cur < target) {
            next[p] = cur + 1
            changed = true
          } else if (cur > target) {
            next[p] = cur - 1
            changed = true
          }
        }
        return changed ? next : prev
      })
    }, 160)
    return () => clearInterval(id)
  }, [state])

  if (!state) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-gradient-to-b from-[#2b1a3d] via-[#3d1f4d] to-[#51275a] text-white/60">
        载入中…
      </div>
    )
  }

  const canRoll = state.phase === 'playing' && !state.pending && state.current === user.name

  const handleRoll = () => {
    if (!canRoll || rolling) return
    // 先播动画，稍后再提交，让对端也看到过程感
    const d = Math.floor(Math.random() * 6) + 1
    setRolling(true)
    setTimeout(() => {
      roll(user.name)
      setLastDice(d)
      setRolling(false)
    }, 450)
  }

  const themeTitle = (id: string | undefined) =>
    state.themes.find((t) => t.id === id)?.title ?? '未选择'

  return (
    <div className="relative flex min-h-dvh flex-col bg-gradient-to-b from-[#2b1a3d] via-[#3d1f4d] to-[#51275a]">
      {/* 顶栏 */}
      <div className="flex items-center gap-3 px-5 pb-2 pt-6">
        <FloatingBack onBack={onBack} tone="light" />
        <button
          onClick={onBack}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition-transform active:scale-90"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-base font-bold tracking-[0.2em] text-white">情侣飞行棋</h1>
          <p className="text-[10px] tracking-widest text-white/50">
            {state.phase === 'playing' ? `第 ${state.turn} 回合` : '先选好主题，再起飞'}
          </p>
        </div>
        {state.phase !== 'setup' && (
          <button
            onClick={() => {
              if (confirm('复位棋盘、重新开始一局？（题库保留）')) startMatch()
            }}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white/80 backdrop-blur transition-transform active:scale-90"
            title="重开一局"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
        )}
        <button
          onClick={() => setLibOpen(true)}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white/80 backdrop-blur transition-transform active:scale-90"
          title="题库"
        >
          <BookOpen className="h-4 w-4" />
        </button>
      </div>

      {state.phase === 'setup' ? (
        <SetupPanel state={state} user={user} themeTitle={themeTitle} />
      ) : (
        <>
          {/* 双方状态条 */}
          <div className="mx-4 mt-2 grid grid-cols-2 gap-2">
            {players.map((p, i) => {
              const active = state.current === p && state.phase === 'playing'
              return (
                <div
                  key={p}
                  className={`${GLASS} flex items-center justify-between px-3 py-2 transition-all ${
                    active ? 'ring-2 ring-rose-400/70' : 'opacity-80'
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <div
                      className={`flex h-6 w-6 items-center justify-center rounded-md ${
                        i === 0 ? 'bg-rose-400/20' : 'bg-purple-400/20'
                      }`}
                    >
                      {i === 0 ? (
                        <Plane className="h-4 w-4 rotate-45 text-rose-300" />
                      ) : (
                        <PlaneTakeoff className="h-4 w-4 text-purple-300" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-white">
                        {p}
                        {p === user.name && <span className="ml-1 text-[10px] text-white/50">（你）</span>}
                      </p>
                      <p className="text-[10px] text-white/60">
                        {active ? '该你了' : p === state.winner ? '抵达终点' : '等待中'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 text-[11px] text-white/80">
                    <MapPin className="h-3 w-3" />
                    <span>{(state.pos[p] ?? 0) + 1}</span>
                  </div>
                </div>
              )
            })}
          </div>

          {/* 掷骰 */}
          <div className={`${GLASS} mx-4 mt-3 flex items-center justify-between gap-3 p-4`}>
            <div
              className={`flex h-16 w-16 items-center justify-center rounded-xl bg-gradient-to-br from-rose-400 to-fuchsia-500 text-3xl font-bold text-white shadow-lg transition-transform ${
                rolling ? 'animate-[spin_0.4s_linear_infinite]' : ''
              } ${canRoll && !rolling ? 'animate-[beat_1.2s_ease-in-out_infinite]' : ''}`}
            >
              {rolling ? '🎲' : (lastDice ?? '?')}
            </div>
            <button
              onClick={handleRoll}
              disabled={!canRoll || rolling}
              className={`flex items-center gap-2 rounded-xl bg-gradient-to-r from-rose-400 to-fuchsia-500 px-6 py-3 font-semibold text-white shadow-lg transition-transform ${
                canRoll && !rolling ? 'active:scale-95' : 'cursor-not-allowed opacity-50'
              }`}
            >
              <Dices className="h-5 w-5" />
              {rolling ? '掷骰中' : canRoll ? '掷骰子' : '等待对方'}
            </button>
          </div>

          {/* 棋盘 */}
          <div className={`${GLASS} mx-4 mb-6 mt-3 p-2`}>
            <div className="grid grid-cols-7 gap-1">
              {Array.from({ length: GRID_N * GRID_N }, (_, i) => {
                const row = Math.floor(i / GRID_N)
                const col = i % GRID_N
                const step = grid[row][col]
                const idx = step - 1
                const isP1 = (disp[players[0]] ?? 0) === idx
                const isP2 = (disp[players[1]] ?? 0) === idx
                const both = isP1 && isP2
                const sp = state.special[idx]
                const isStart = step === 1
                const isEnd = step === GRID_N * GRID_N
                return (
                  <div
                    key={i}
                    className={`relative flex aspect-square items-center justify-center rounded-lg border transition-all ${
                      isEnd
                        ? 'border-transparent bg-gradient-to-br from-rose-400 to-fuchsia-500'
                        : sp === 'star'
                          ? 'border-rose-300/30 bg-rose-400/20'
                          : sp === 'trap'
                            ? 'border-purple-300/30 bg-purple-500/20'
                            : 'border-white/10 bg-white/5'
                    }`}
                  >
                    {step < GRID_N * GRID_N &&
                      !(isP1 || isP2) &&
                      (() => {
                        const cur = stepPos[step]
                        const nxt = stepPos[step + 1]
                        const dx = (nxt?.col ?? col) - (cur?.col ?? col)
                        const dy = (nxt?.row ?? row) - (cur?.row ?? row)
                        const Icon =
                          dx === 1 ? ArrowRight : dx === -1 ? ArrowLeft : dy === 1 ? ArrowDown : dy === -1 ? ArrowUp : null
                        return Icon ? (
                          <Icon className="absolute h-3 w-3 text-white/15" />
                        ) : null
                      })()}
                    {isStart && <span className="text-[9px] text-white/50">起点</span>}
                    {isEnd && <Trophy className="h-4 w-4 text-white" />}
                    {sp === 'star' && !isEnd && <Heart className="h-3.5 w-3.5 text-rose-300" />}
                    {sp === 'trap' && !isEnd && <Zap className="h-3.5 w-3.5 text-purple-300" />}
                    {(isP1 || isP2) && !isEnd && (
                      <div className="absolute z-10 flex h-8 w-8 items-center justify-center">
                        {both ? (
                          <div className="flex h-8 w-8 animate-pulse items-center justify-center rounded-full border-2 border-white bg-gradient-to-br from-rose-400 to-purple-500 shadow-lg">
                            <Plane className="h-4 w-4 rotate-45 text-white" />
                          </div>
                        ) : isP1 ? (
                          <div className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-gradient-to-br from-pink-400 to-pink-600 shadow-lg">
                            <Plane className="h-4 w-4 rotate-45 text-white" />
                          </div>
                        ) : (
                          <div className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-gradient-to-br from-purple-400 to-purple-600 shadow-lg">
                            <PlaneTakeoff className="h-4 w-4 text-white" />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            <div className="mt-2 flex items-center justify-center gap-4 text-[10px] text-white/50">
              <span className="flex items-center gap-1">
                <Heart className="h-3 w-3 text-rose-300" /> 幸运星
              </span>
              <span className="flex items-center gap-1">
                <Zap className="h-3 w-3 text-purple-300" /> 陷阱
              </span>
              <span className="flex items-center gap-1">
                <Trophy className="h-3 w-3" /> 终点
              </span>
            </div>
          </div>
        </>
      )}

      {/* 任务弹窗 */}
      {state.pending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm">
          <div className={`${GLASS} w-full max-w-sm p-6`}>
            <div className="mb-4 flex justify-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-rose-400 to-fuchsia-500 shadow-lg">
                {state.pending.type === 'collision' ? (
                  <Plane className="h-8 w-8 rotate-45 text-white" />
                ) : state.pending.type === 'star' ? (
                  <Heart className="h-8 w-8 text-white" />
                ) : (
                  <Zap className="h-8 w-8 text-white" />
                )}
              </div>
            </div>
            <h3 className="mb-1 text-center text-lg font-bold text-white">
              {state.pending.type === 'collision' ? '撞机任务！' : state.pending.type === 'star' ? '幸运星任务！' : '陷阱任务！'}
            </h3>
            <p className="mb-4 text-center text-[11px] text-white/50">
              执行者：{state.pending.executor} · 判定者：{state.pending.observer}
            </p>
            <div className="mb-6 rounded-xl border border-white/10 bg-white/5 p-4">
              <p className="text-center leading-relaxed text-white/85">
                {state.pending.taskText || '（题库为空）请进行一组互动动作，由判定者确认。'}
              </p>
            </div>

            {state.pending.status === 'pending' && state.pending.executor === user.name ? (
              <button
                onClick={() => confirmExecution(user.name)}
                className="w-full rounded-xl bg-gradient-to-r from-rose-400 to-fuchsia-500 py-3 font-semibold text-white shadow-lg transition-transform active:scale-95"
              >
                完成任务
              </button>
            ) : state.pending.status === 'executed' && state.pending.observer === user.name ? (
              <div className="flex gap-3">
                <button
                  onClick={() => verifyTask(user.name, true)}
                  className="flex-1 rounded-xl bg-emerald-500 py-3 font-semibold text-white transition-transform active:scale-95"
                >
                  已执行
                </button>
                <button
                  onClick={() => verifyTask(user.name, false)}
                  className="flex-1 rounded-xl bg-rose-600 py-3 font-semibold text-white transition-transform active:scale-95"
                >
                  未执行
                </button>
              </div>
            ) : (
              <p className="text-center text-sm text-white/50">
                等待{state.pending.status === 'pending' ? '执行者确认' : '判定者判定'}…
              </p>
            )}
          </div>
        </div>
      )}

      {/* 胜利弹窗 */}
      {state.phase === 'completed' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
          <div className={`${GLASS} w-full max-w-sm p-6 text-center`}>
            <div className="mb-4 flex justify-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-300 to-rose-400 shadow-lg">
                <Trophy className="h-8 w-8 text-white" />
              </div>
            </div>
            <h3 className="mb-2 text-xl font-bold text-white">游戏结束！</h3>
            <p className="mb-6 text-white/70">赢家：{state.winner ?? '—'}</p>
            <div className="flex gap-3">
              <button
                onClick={() => startMatch()}
                className="flex-1 rounded-xl bg-gradient-to-r from-rose-400 to-fuchsia-500 py-3 font-semibold text-white shadow-lg transition-transform active:scale-95"
              >
                再来一局
              </button>
              <button
                onClick={() => backToSetup()}
                className="flex-1 rounded-xl bg-white/10 py-3 font-medium text-white/80 transition-transform active:scale-95"
              >
                回到准备页
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 题库管理 */}
      {libOpen && <LibraryPanel state={state} user={user} onClose={() => setLibOpen(false)} />}

      <style>{`
        @keyframes beat {
          0%, 100% { transform: scale(1); }
          25% { transform: scale(1.12); }
          40% { transform: scale(1); }
          60% { transform: scale(1.08); }
        }
      `}</style>
    </div>
  )
}

/* ---------------- 准备页：选主题 + 开始 ---------------- */

function SetupPanel({
  state,
  user,
  themeTitle,
}: {
  state: ChessState
  user: User
  themeTitle: (id?: string) => string
}) {
  const [a, b] = state.players
  const ready = !!state.chosen[a] && !!state.chosen[b]
  return (
    <div className="flex-1 px-4 pb-10">
      <div className="mt-6 text-center">
        <Heart className="mx-auto h-12 w-12 animate-[beat_1.4s_ease-in-out_infinite] fill-rose-400 text-rose-400 drop-shadow-[0_0_24px_rgba(251,113,133,0.6)]" />
        <h2 className="mt-4 text-lg font-bold tracking-[0.2em] text-white">准备起飞</h2>
        <p className="mt-2 text-xs leading-relaxed text-white/55">
          两人各选一个主题题库，踩到「幸运星 / 陷阱 / 撞机」就抽一道题
          <br />
          先到终点的获胜
        </p>
      </div>

      <div className="mt-6 space-y-4">
        {[a, b].map((p, i) => (
          <div key={p} className={`${GLASS} p-4`}>
            <div className="mb-3 flex items-center gap-2">
              <div className={`flex h-7 w-7 items-center justify-center rounded-lg ${i === 0 ? 'bg-rose-400/20' : 'bg-purple-400/20'}`}>
                {i === 0 ? <Plane className="h-4 w-4 rotate-45 text-rose-300" /> : <PlaneTakeoff className="h-4 w-4 text-purple-300" />}
              </div>
              <span className="text-sm font-bold text-white">
                {p}
                {p === user.name && <span className="ml-1 text-[10px] text-white/50">（你）</span>}
              </span>
              <span className="ml-auto text-[11px] text-white/50">{themeTitle(state.chosen[p])}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {state.themes.map((t) => (
                <button
                  key={t.id}
                  onClick={() => chooseTheme(p, t.id)}
                  className={`rounded-full px-3 py-1.5 text-xs transition-all ${
                    state.chosen[p] === t.id
                      ? 'bg-gradient-to-r from-rose-400 to-fuchsia-500 font-semibold text-white'
                      : 'bg-white/10 text-white/70'
                  }`}
                >
                  {t.title}
                  <span className="ml-1 opacity-60">·{t.tasks.length}</span>
                </button>
              ))}
              {state.themes.length === 0 && (
                <span className="text-xs text-white/40">还没有题库，点右上角书本站图标新建</span>
              )}
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={() => startMatch()}
        disabled={!ready}
        className={`mt-8 w-full rounded-2xl py-4 text-base font-bold tracking-[0.2em] text-white shadow-lg transition-transform ${
          ready ? 'bg-gradient-to-r from-rose-400 to-fuchsia-500 active:scale-95' : 'cursor-not-allowed bg-white/10 text-white/40'
        }`}
      >
        {ready ? '开始飞行' : '两人都选好主题后开始'}
      </button>
    </div>
  )
}

/* ---------------- 题库管理面板 ---------------- */

function LibraryPanel({
  state,
  user,
  onClose,
}: {
  state: ChessState
  user: User
  onClose: () => void
}) {
  const [newTitle, setNewTitle] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black/50 backdrop-blur-sm">
      <div className="mx-auto flex h-full w-full max-w-md flex-col bg-gradient-to-b from-[#2b1a3d] to-[#3d1f4d]">
        <div className="flex items-center gap-3 border-b border-white/10 px-5 py-4">
          <BookOpen className="h-5 w-5 text-rose-300" />
          <h2 className="flex-1 text-base font-bold tracking-widest text-white">题库管理</h2>
          <button onClick={onClose} className="text-white/60 active:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {state.themes.map((t) => (
            <div key={t.id} className={`${GLASS} mb-4 p-4`}>
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold text-white">{t.title}</p>
                  <p className="text-[10px] text-white/45">
                    由 {t.author} 创建 · {t.tasks.length} 题
                  </p>
                </div>
                <button
                  onClick={() => {
                    if (confirm(`删除题库「${t.title}」？`)) removeTheme(t.id)
                  }}
                  className="text-white/40 active:text-rose-400"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>

              <div className="space-y-1.5">
                {t.tasks.map((k) => (
                  <div key={k.id} className="flex items-start gap-2 rounded-lg bg-white/5 px-3 py-1.5">
                    <span className="flex-1 text-xs leading-relaxed text-white/75">{k.text}</span>
                    <button onClick={() => removeTask(t.id, k.id)} className="mt-0.5 text-white/30 active:text-rose-400">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>

              <div className="mt-2 flex gap-2">
                <input
                  value={drafts[t.id] ?? ''}
                  onChange={(e) => setDrafts((d) => ({ ...d, [t.id]: e.target.value }))}
                  placeholder="加一道题…"
                  className="flex-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs text-white outline-none placeholder:text-white/30 focus:border-rose-400/60"
                />
                <button
                  onClick={() => {
                    addTask(t.id, drafts[t.id] ?? '')
                    setDrafts((d) => ({ ...d, [t.id]: '' }))
                  }}
                  className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-r from-rose-400 to-fuchsia-500 text-white active:scale-95"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}

          {state.themes.length === 0 && (
            <p className="py-10 text-center text-xs text-white/40">还没有题库，新建一个吧</p>
          )}
        </div>

        <div className="flex gap-2 border-t border-white/10 px-5 py-4">
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="新建主题名，如「旅行愿望」"
            className="flex-1 rounded-xl border border-white/15 bg-white/5 px-3 py-2.5 text-sm text-white outline-none placeholder:text-white/30 focus:border-rose-400/60"
          />
          <button
            onClick={() => {
              const id = addTheme(newTitle, user.name)
              if (id) setNewTitle('')
            }}
            className="rounded-xl bg-gradient-to-r from-rose-400 to-fuchsia-500 px-4 text-sm font-semibold text-white active:scale-95"
          >
            新建主题
          </button>
        </div>
      </div>
    </div>
  )
}
