/**
 * do打分（秘密空间·隐藏打分系统）云端同步：与见闻打分同构，独立 MQTT 主题互不干扰。
 * - 分类结构 + 双人共评模型完全复用见闻打分的类型（types 来自 store.ts）
 * - 合并同步：与见闻打分同一套合并引擎（ratingMerge.ts），两人同时操作不互丢
 */
import { sharedPublish, sharedSubscribe, sharedResync, onSharedConnect, onSharedStatus } from './mqttClient'
import { isGuestSession } from './guest'
import { addTx } from './wallet'
import { addTreeXp } from './tree'
import type { Category, LoveData, Rating, RatingComment } from './store'
import { REWARD_COMMENT } from './store'
import { capStamps, mergeCats, mergeItems, remoteHasExtra, remoteMissing, subKey, type Stamp } from './ratingMerge'
import { isPairMember, membersKnown } from './space'

/** 清理混入的外组账号数据：do打分只保留当前空间成员创建的；分数/评论剔除非成员 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scrubForeign(parsed: any): number {
  if (!membersKnown() || !parsed || !Array.isArray(parsed.items)) return 0
  let removed = 0
  const beforeItems = parsed.items.length
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parsed.items = parsed.items.filter((r: any) => isPairMember(String(r?.createdBy ?? r?.who ?? '')))
  removed += beforeItems - parsed.items.length
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const r of parsed.items as any[]) {
    if (r?.scores && typeof r.scores === 'object') {
      for (const k of Object.keys(r.scores)) {
        if (!isPairMember(k)) {
          delete r.scores[k]
          removed++
        }
      }
    }
    if (Array.isArray(r?.comments)) {
      const before = r.comments.length
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      r.comments = r.comments.filter((c: any) => isPairMember(String(c?.who ?? '')))
      removed += before - r.comments.length
    }
  }
  return removed
}

/** do打分奖励：只有发起打分的有奖励，+30 时元 */
export const REWARD_CREATE = 30

/** 评论上限：每条记录最多保留 50 条评论，超出删最旧 */
const MAX_COMMENTS = 50

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateComments(raw: any): RatingComment[] {
  if (!Array.isArray(raw)) return []
  return raw
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((c: any) => ({
      id: String(c?.id ?? ''),
      who: String(c?.who ?? ''),
      text: String(c?.text ?? ''),
      ts: Number(c?.ts ?? 0),
    }))
    .filter((c) => c.id && c.text)
}

const TOPIC = 'lovesite/dorate/state'
const LS_KEY = 'lovesite-dorate-backup'

type State = {
  items: Rating[]
  cats: Category[]
  v: number
  catTs?: Stamp
  subTs?: Stamp
  delCats?: Stamp
  delSubs?: Stamp
}

let initialized = false
let current: Rating[] = []
let cats: Category[] = []
let catTs: Stamp = {}
let subTs: Stamp = {}
let delCats: Stamp = {}
let delSubs: Stamp = {}
let lastV = 0
let stateReceived = false
let subscribers: Array<(data: LoveData) => void> = []
let errorListeners: Array<(msg: string) => void> = []

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateItem(raw: any): Rating {
  if (raw && raw.scores && typeof raw.scores === 'object') {
    return {
      id: String(raw.id ?? ''),
      title: String(raw.title ?? ''),
      note: String(raw.note ?? ''),
      ts: Number(raw.ts ?? 0),
      cat: String(raw.cat ?? ''),
      sub: String(raw.sub ?? ''),
      createdBy: String(raw.createdBy ?? ''),
      scores: raw.scores as Record<string, number>,
      comments: migrateComments(raw.comments),
      mts: typeof raw.mts === 'number' ? raw.mts : undefined,
    }
  }
  const who = String(raw?.who ?? '')
  const scores: Record<string, number> = {}
  if (who && typeof raw?.score === 'number') scores[who] = raw.score
  return {
    id: String(raw?.id ?? ''),
    title: String(raw?.title ?? ''),
    note: String(raw?.note ?? ''),
    ts: Number(raw?.ts ?? 0),
    cat: String(raw?.cat ?? ''),
    sub: String(raw?.sub ?? ''),
    createdBy: who,
    scores,
    comments: migrateComments(raw?.comments),
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateItems(raw: any): Rating[] {
  if (!Array.isArray(raw)) return []
  return raw.map(migrateItem).filter((r) => r.id)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateStamps(raw: any): Stamp {
  if (!raw || typeof raw !== 'object') return {}
  const out: Stamp = {}
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'number') out[k] = v
  return out
}

function loadBackup(): State | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as State
    if (!Array.isArray(parsed.items)) return null
    scrubForeign(parsed) // 本地备份也清掉外组数据
    return {
      items: migrateItems(parsed.items),
      cats: Array.isArray(parsed.cats) ? parsed.cats : [],
      v: parsed.v ?? 0,
      catTs: migrateStamps(parsed.catTs),
      subTs: migrateStamps(parsed.subTs),
      delCats: migrateStamps(parsed.delCats),
      delSubs: migrateStamps(parsed.delSubs),
    }
  } catch {
    return null
  }
}

function saveBackup() {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ items: current, cats, v: lastV, catTs, subTs, delCats, delSubs }),
    )
  } catch {
    /* 存储满了就忽略 */
  }
}

function sorted(items: Rating[]): Rating[] {
  return [...items].sort((a, b) => b.ts - a.ts)
}

function notify() {
  const data: LoveData = { items: sorted(current), cats: [...cats] }
  subscribers.forEach((cb) => cb(data))
}

function emitError(msg: string) {
  errorListeners.forEach((cb) => cb(msg))
}

function ensureClient() {
  if (initialized) return
  initialized = true

  // 本地缓存先行：先用上次的备份立刻渲染，云端数据到了再合并
  const backup = loadBackup()
  if (backup) {
    current = backup.items
    cats = backup.cats
    catTs = backup.catTs ?? {}
    subTs = backup.subTs ?? {}
    delCats = backup.delCats ?? {}
    delSubs = backup.delSubs ?? {}
    lastV = backup.v ?? 0
  }

  sharedSubscribe(TOPIC, (payload) => {
    if (payload.length === 0) return
    try {
      const state = JSON.parse(payload.toString()) as State
      if (!Array.isArray(state.items) || typeof state.v !== 'number') return
      const removedForeign = scrubForeign(state) // 外组数据入口清掉
      if (state.v <= lastV) {
        if (!stateReceived) {
          stateReceived = true
          if (state.v < lastV) publishState()
        }
        if (removedForeign > 0) publishState() // 回发清理后的状态
        // 时钟偏差兜底：旧版本号里若夹着本地没有的内容，照样合并进来
        const rItems = migrateItems(state.items)
        const rCats = Array.isArray(state.cats) ? state.cats : []
        if (remoteHasExtra(current, cats, rItems, rCats)) {
          current = mergeItems(current, rItems)
          const mc = mergeCats(
            cats,
            rCats,
            catTs,
            migrateStamps(state.catTs),
            subTs,
            migrateStamps(state.subTs),
            delCats,
            migrateStamps(state.delCats),
            delSubs,
            migrateStamps(state.delSubs),
          )
          cats = mc.cats
          catTs = mc.catTs
          subTs = mc.subTs
          delCats = mc.delCats
          delSubs = mc.delSubs
          saveBackup()
          notify()
        }
        return
      }
      lastV = state.v
      stateReceived = true
      const rItems = migrateItems(state.items)
      const rCats = Array.isArray(state.cats) ? state.cats : []
      const missing = remoteMissing(current, cats, { items: rItems, cats: rCats })
      current = mergeItems(current, rItems)
      const mc = mergeCats(
        cats,
        rCats,
        catTs,
        migrateStamps(state.catTs),
        subTs,
        migrateStamps(state.subTs),
        delCats,
        migrateStamps(state.delCats),
        delSubs,
        migrateStamps(state.delSubs),
      )
      cats = mc.cats
      catTs = mc.catTs
      subTs = mc.subTs
      delCats = mc.delCats
      delSubs = mc.delSubs
      saveBackup()
      notify()
      if (missing || removedForeign > 0) publishState() // 反熵回发 + 清理回发
    } catch {
      /* 忽略脏数据 */
    }
  })

  onSharedConnect(() => {
    // 3 秒内没收到云端保留数据 → 云端为空，用本地备份自愈回云端
    setTimeout(() => {
      if (!stateReceived) {
        stateReceived = true
        if (current.length > 0 || cats.length > 0) publishState()
        else notify()
      }
    }, 3000)
  })

  onSharedStatus((status, msg) => {
    if (status === 'error') emitError(`连接消息服务器失败：${msg}`)
    else if (status === 'offline') emitError('消息服务器连接中断，正在自动重连…')
    else if (status === 'reconnect') emitError('')
  })
}

function publishState() {
  const v = Date.now()
  lastV = v
  const state: State = { items: sorted(current), cats, v, catTs, subTs, delCats: capStamps(delCats), delSubs: capStamps(delSubs) }
  sharedPublish(TOPIC, JSON.stringify(state))
}

function commit() {
  publishState()
  saveBackup()
  notify()
}

/** 订阅数据（打分 + 分类）；返回取消订阅函数 */
export function subscribeRatings(
  onData: (data: LoveData) => void,
  onError?: (msg: string) => void,
): () => void {
  subscribers.push(onData)
  if (onError) errorListeners.push(onError)
  ensureClient()
  onData({ items: sorted(current), cats: [...cats] })
  return () => {
    subscribers = subscribers.filter((cb) => cb !== onData)
    if (onError) errorListeners = errorListeners.filter((cb) => cb !== onError)
  }
}

/** 创建一条记录（创建者同时打下自己的分） */
export async function addRating(r: {
  who: string
  title: string
  score: number
  note: string
  ts: number
  cat: string
  sub: string
}): Promise<Rating> {
  if (isGuestSession()) {
    return { id: `guest_${r.ts}`, title: r.title, note: r.note, ts: r.ts, cat: r.cat, sub: r.sub, createdBy: r.who, scores: {}, comments: [] }
  }
  ensureClient()
  const item: Rating = {
    id: `r_${r.ts}_${Math.random().toString(36).slice(2, 8)}`,
    title: r.title,
    note: r.note,
    ts: r.ts,
    cat: r.cat,
    sub: r.sub,
    createdBy: r.who,
    scores: { [r.who]: r.score },
    comments: [],
    mts: Date.now(),
  }
  if (!current.some((x) => x.id === item.id)) {
    current = [...current, item]
    commit()
    // 发起 do打分奖励 30 时元（参与评分无奖励）
    addTx(r.who, REWARD_CREATE, `发起do打分「${r.title}」`)
    addTreeXp(r.who) // 打分行为：爱情树 +2
  }
  return item
}

/** 给已有记录打分 / 修改自己的分 */
export function rateItem(id: string, who: string, score: number): void {
  if (isGuestSession()) return
  const target = current.find((x) => x.id === id)
  if (!target) return
  ensureClient()
  // 首次参与评分（此前没有此人的分）：爱情树 +2
  const firstJoin = target.scores[who] === undefined
  const now = Date.now()
  current = current.map((x) => (x.id === id ? { ...x, scores: { ...x.scores, [who]: score }, mts: now } : x))
  commit()
  if (firstJoin) addTreeXp(who)
}

/** 给记录加评论 / 追评（双方都可，按时间排成评论串） */
export function addComment(id: string, who: string, text: string): void {
  if (isGuestSession()) return
  const trimmed = text.trim()
  const target = current.find((x) => x.id === id)
  if (!target || !trimmed) return
  ensureClient()
  const now = Date.now()
  const comment: RatingComment = {
    id: `c_${now}_${Math.random().toString(36).slice(2, 6)}`,
    who,
    text: trimmed.slice(0, 60),
    ts: now,
  }
  current = current.map((x) =>
    x.id === id ? { ...x, comments: [...x.comments, comment].slice(-MAX_COMMENTS), mts: now } : x,
  )
  commit()
  // 对方评论了你的do打分：创作者 +2 时元（自己评论自己不奖励）
  if (who !== target.createdBy) {
    addTx(target.createdBy, REWARD_COMMENT, `对方评论了你的do打分「${target.title}」`)
  }
}

/** 编辑记录的名称 / 介绍 / 分类（双方都可改） */
export function updateItem(
  id: string,
  fields: { title: string; note: string; cat: string; sub: string },
): void {
  if (isGuestSession()) return
  const target = current.find((x) => x.id === id)
  if (!target) return
  ensureClient()
  const now = Date.now()
  current = current.map((x) =>
    x.id === id
      ? { ...x, title: fields.title, note: fields.note, cat: fields.cat, sub: fields.sub, mts: now }
      : x,
  )
  commit()
}

/** 新建大分类（双方实时可见）；返回是否创建成功 */
export function addCategory(name: string): boolean {
  if (isGuestSession()) return false
  const trimmed = name.trim()
  if (!trimmed || cats.some((c) => c.name === trimmed)) return false
  ensureClient()
  const now = Date.now()
  cats = [...cats, { name: trimmed, subs: [] }]
  catTs = { ...catTs, [trimmed]: now }
  delCats = { ...delCats }
  delete delCats[trimmed]
  commit()
  return true
}

/** 在指定大分类下新建小分类；返回是否创建成功 */
export function addSubCategory(catName: string, subName: string): boolean {
  if (isGuestSession()) return false
  const trimmed = subName.trim()
  const target = cats.find((c) => c.name === catName)
  if (!target || !trimmed || target.subs.includes(trimmed)) return false
  ensureClient()
  const now = Date.now()
  cats = cats.map((c) => (c.name === catName ? { ...c, subs: [...c.subs, trimmed] } : c))
  subTs = { ...subTs, [subKey(catName, trimmed)]: now }
  delSubs = { ...delSubs }
  delete delSubs[subKey(catName, trimmed)]
  commit()
  return true
}

/** 删除大分类：该分类下的记录变为未分类（写墓碑防复活） */
export function deleteCategory(name: string): void {
  if (isGuestSession()) return
  ensureClient()
  const now = Date.now()
  cats = cats.filter((c) => c.name !== name)
  delCats = { ...delCats, [name]: now }
  catTs = { ...catTs }
  delete catTs[name]
  current = current.map((r) => (r.cat === name ? { ...r, cat: '', sub: '', mts: now } : r))
  commit()
}

/** 删除小分类：相关记录的小分类清空，大分类保留（写墓碑防复活） */
export function deleteSubCategory(catName: string, subName: string): void {
  if (isGuestSession()) return
  ensureClient()
  const now = Date.now()
  cats = cats.map((c) =>
    c.name === catName ? { ...c, subs: c.subs.filter((s) => s !== subName) } : c,
  )
  delSubs = { ...delSubs, [subKey(catName, subName)]: now }
  subTs = { ...subTs }
  delete subTs[subKey(catName, subName)]
  current = current.map((r) => (r.cat === catName && r.sub === subName ? { ...r, sub: '', mts: now } : r))
  commit()
}

/** 手动刷新：重新订阅拿最新保留消息 */
export function resyncRatings() {
  ensureClient()
  stateReceived = false
  sharedResync(TOPIC)
}
