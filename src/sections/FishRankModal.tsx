import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { subscribeFishingLog, type CatchEntry } from '../lib/fishing'
import { itemInfo, RARE_FISH } from '../lib/farm'
import { getPairMembers } from '../lib/space'

// 当前数据空间的两个人
const getPairedUsers = (): string[] => getPairMembers()

type UserStat = {
  total: number
  rare: number
  rareSpecies: Array<{ fishId: string; n: number }>
  lastTs: number
}

function statOf(log: CatchEntry[], who: string): UserStat {
  const mine = log.filter((e) => e.who === who)
  const rareMap = new Map<string, number>()
  for (const e of mine) if (e.rare) rareMap.set(e.fishId, (rareMap.get(e.fishId) ?? 0) + 1)
  return {
    total: mine.length,
    rare: mine.filter((e) => e.rare).length,
    rareSpecies: [...rareMap.entries()]
      .map(([fishId, n]) => ({ fishId, n }))
      .sort((a, b) => b.n - a.n),
    lastTs: mine[0]?.ts ?? 0,
  }
}

/** 渔获排行榜：按稀有鱼数量排名，持平比总渔获 */
export default function FishRankModal({ onClose }: { onClose: () => void }) {
  const [log, setLog] = useState<CatchEntry[]>([])

  useEffect(() => subscribeFishingLog(setLog), [])

  const stats = useMemo(() => {
    const list = getPairedUsers().map((who) => ({ who, ...statOf(log, who) }))
    list.sort((a, b) => b.rare - a.rare || b.total - a.total)
    return list
  }, [log])

  const recent = useMemo(() => log.slice(0, 10), [log])
  const winner = stats.length === 2 && (stats[0].rare !== stats[1].rare || stats[0].total !== stats[1].total) ? stats[0] : null

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-5 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex max-h-[82vh] w-full max-w-sm flex-col overflow-hidden rounded-3xl bg-gradient-to-b from-sky-50 to-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-sky-100 px-5 py-3.5">
          <span className="text-sm font-bold tracking-widest text-sky-700">🏆 渔获排行榜</span>
          <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-full bg-sky-100/70 text-sky-500">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* 对战卡片 */}
          <div className="mb-4 grid grid-cols-2 gap-3">
            {stats.map((s, i) => (
              <div
                key={s.who}
                className={`relative rounded-2xl p-3 text-center shadow-sm ring-1 ${
                  winner?.who === s.who ? 'bg-amber-50 ring-amber-300' : 'bg-white ring-sky-100'
                }`}
              >
                {winner?.who === s.who && <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 text-lg">👑</span>}
                <p className="mt-1 text-[13px] font-bold text-gray-700">{s.who}</p>
                <p className="mt-1.5 text-2xl font-black text-sky-600">{s.rare}</p>
                <p className="text-[10px] text-gray-400">稀有鱼</p>
                <p className="mt-1.5 text-[11px] font-semibold text-gray-500">总渔获 {s.total} 条</p>
                {i === 0 && s.total === 0 && <p className="mt-1 text-[10px] text-sky-300">还没有渔获，快去钓鱼吧</p>}
              </div>
            ))}
          </div>

          {/* 稀有鱼图鉴进度 */}
          <p className="mb-2 text-[11px] font-bold tracking-widest text-sky-600/80">✨ 稀有鱼收集（共 {RARE_FISH.length} 种）</p>
          <div className="mb-4 space-y-1.5">
            {RARE_FISH.map((f) => {
              const a = stats[0]?.rareSpecies.find((r) => r.fishId === f.id)?.n ?? 0
              const b = stats[1]?.rareSpecies.find((r) => r.fishId === f.id)?.n ?? 0
              const got = a + b > 0
              return (
                <div
                  key={f.id}
                  className={`flex items-center gap-2 rounded-xl px-3 py-2 text-[12px] ring-1 ${
                    got ? 'bg-white text-gray-600 ring-sky-100' : 'bg-gray-50/60 text-gray-300 ring-gray-100'
                  }`}
                >
                  <span className={`text-base ${got ? '' : 'opacity-25 grayscale'}`}>{f.emoji}</span>
                  <span className="flex-1 font-medium">{got ? f.name : '？？？'}</span>
                  <span className="text-[11px]">
                    {stats[0]?.who.slice(0, 2)}×{a} · {stats[1]?.who.slice(0, 2)}×{b}
                  </span>
                </div>
              )
            })}
          </div>

          {/* 最近渔获 */}
          <p className="mb-2 text-[11px] font-bold tracking-widest text-sky-600/80">🕐 最近渔获</p>
          {recent.length === 0 ? (
            <p className="py-4 text-center text-xs text-sky-300">暂无记录，第一竿会是谁的呢？</p>
          ) : (
            <div className="space-y-1.5">
              {recent.map((e) => {
                const info = itemInfo(e.fishId)
                const d = new Date(e.ts)
                return (
                  <div key={e.id} className="flex items-center gap-2 rounded-xl bg-white px-3 py-1.5 text-[12px] ring-1 ring-sky-50">
                    <span className="text-sm">{info.emoji}</span>
                    <span className={`font-medium ${e.rare ? 'text-amber-600' : 'text-gray-600'}`}>
                      {info.name}
                      {e.rare && ' ✨'}
                    </span>
                    <span className="flex-1 text-right text-gray-400">{e.who}</span>
                    <span className="text-[10px] text-gray-300">
                      {d.getMonth() + 1}/{d.getDate()} {String(d.getHours()).padStart(2, '0')}:{String(d.getMinutes()).padStart(2, '0')}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
