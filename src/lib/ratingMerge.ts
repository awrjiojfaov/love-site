/**
 * 见闻打分 / do打分 共用的合并引擎。
 * 两个模块数据结构相同（items + cats），此前收到云端整包直接覆盖本地，
 * 两人同时操作会互相顶掉数据。这里提供纯函数合并：
 * - items 按 id 求并集；同 id 时取"最后修改时间 mts"较新者的文本字段，
 *   scores 按人合并（新者覆盖同一个人的旧分），comments 按评论 id 求并集
 * - cats/subs 求并集，用"创建时间 vs 删除墓碑时间"决定存亡，删除不会被旧包复活
 */
import type { Category, Rating, RatingComment } from './store'

export type Stamp = Record<string, number>

/** 两个字典按键求并集，同键取较大时间戳 */
export function unionMax(a: Stamp | undefined, b: Stamp | undefined): Stamp {
  const out: Stamp = { ...(a ?? {}) }
  for (const [k, v] of Object.entries(b ?? {})) {
    if (typeof v === 'number' && v > (out[k] ?? 0)) out[k] = v
  }
  return out
}

/** 墓碑map防爆：最多保留 200 条，超了丢最旧 */
export function capStamps(m: Stamp, max = 200): Stamp {
  const entries = Object.entries(m)
  if (entries.length <= max) return m
  entries.sort((a, b) => b[1] - a[1])
  return Object.fromEntries(entries.slice(0, max))
}

function mergeComments(a: RatingComment[], b: RatingComment[]): RatingComment[] {
  const map = new Map<string, RatingComment>()
  for (const c of [...a, ...b]) if (c && c.id) map.set(c.id, c)
  return [...map.values()].sort((x, y) => x.ts - y.ts).slice(-50)
}

function itemMts(r: Rating): number {
  return r.mts ?? r.ts ?? 0
}

/** 同 id 两条见闻合并：文本字段取新者，scores/comments 做并集 */
function mergeOne(a: Rating, b: Rating): Rating {
  const newer = itemMts(a) >= itemMts(b) ? a : b
  const older = itemMts(a) >= itemMts(b) ? b : a
  return {
    ...newer,
    scores: { ...older.scores, ...newer.scores },
    comments: mergeComments(older.comments ?? [], newer.comments ?? []),
  }
}

/** items 按 id 并集（remote 为较新版本，顺序以 remote 为主，本地多出的附后） */
export function mergeItems(local: Rating[], remote: Rating[]): Rating[] {
  const map = new Map<string, Rating>()
  for (const it of remote) if (it && it.id) map.set(it.id, it)
  for (const it of local) {
    if (!it || !it.id) continue
    const ex = map.get(it.id)
    map.set(it.id, ex ? mergeOne(ex, it) : it)
  }
  return [...map.values()]
}

export type CatSync = {
  cats: Category[]
  catTs: Stamp
  subTs: Stamp
  delCats: Stamp
  delSubs: Stamp
}

export const subKey = (cat: string, sub: string): string => `${cat}/${sub}`

/**
 * 分类结构合并：名字求并集；存在性由"创建时间 > 删除墓碑时间"决定；
 * 旧数据没有创建时间，只要没有墓碑就保留。
 */
export function mergeCats(
  localCats: Category[],
  remoteCats: Category[],
  lCatTs: Stamp,
  rCatTs: Stamp,
  lSubTs: Stamp,
  rSubTs: Stamp,
  lDelC: Stamp,
  rDelC: Stamp,
  lDelS: Stamp,
  rDelS: Stamp,
): CatSync {
  const catTs = unionMax(lCatTs, rCatTs)
  const subTs = unionMax(lSubTs, rSubTs)
  const delCats = capStamps(unionMax(lDelC, rDelC))
  const delSubs = capStamps(unionMax(lDelS, rDelS))

  const catAlive = (name: string): boolean =>
    delCats[name] === undefined ? true : (catTs[name] ?? 0) > delCats[name]
  const subAlive = (cat: string, sub: string): boolean =>
    delSubs[subKey(cat, sub)] === undefined ? true : (subTs[subKey(cat, sub)] ?? 0) > delSubs[subKey(cat, sub)]

  // 顺序以 remote（较新）为主，本地多出的附后
  const ordered: Category[] = []
  const seen = new Set<string>()
  const pushCat = (c: Category) => {
    if (!c || seen.has(c.name)) return
    seen.add(c.name)
    ordered.push({ name: c.name, subs: [...(c.subs ?? [])] })
  }
  remoteCats.forEach(pushCat)
  // 本地独有的分类补进来；同名的 subs 做并集
  for (const c of localCats) {
    if (!c) continue
    const ex = ordered.find((o) => o.name === c.name)
    if (!ex) {
      if (!seen.has(c.name)) {
        seen.add(c.name)
        ordered.push({ name: c.name, subs: [...(c.subs ?? [])] })
      }
    } else {
      for (const s of c.subs ?? []) if (!ex.subs.includes(s)) ex.subs.push(s)
    }
  }

  const cats = ordered
    .filter((c) => catAlive(c.name))
    .map((c) => ({ name: c.name, subs: c.subs.filter((s) => subAlive(c.name, s)) }))

  return { cats, catTs, subTs, delCats, delSubs }
}

/** 反熵检查：云端包是否缺了本地内容（缺则调用方回发合并结果自愈） */
export function remoteMissing(localItems: Rating[], localCats: Category[], remote: { items?: Rating[]; cats?: Category[] }): boolean {
  const rIds = new Set((remote.items ?? []).map((i) => i?.id))
  if (localItems.some((i) => !rIds.has(i.id))) return true
  const rCats = new Set((remote.cats ?? []).map((c) => c?.name))
  return localCats.some((c) => !rCats.has(c.name))
}

/** 时钟偏差兜底：被版本守卫拦下的旧包里，是否夹着本地没有的内容 */
export function remoteHasExtra(localItems: Rating[], localCats: Category[], rItems: Rating[], rCats: Category[]): boolean {
  const lIds = new Set(localItems.map((i) => i.id))
  if (rItems.some((i) => i && i.id && !lIds.has(i.id))) return true
  const lCats = new Set(localCats.map((c) => c.name))
  return rCats.some((c) => c && !lCats.has(c.name))
}
