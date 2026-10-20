/**
 * 许愿池 → 心愿商店：自由许愿、自定价格的心愿货架。
 * 流程：许愿(pending) → 对方审批(approved / declined) → 对方买下(purchased，时元先扣) → 许愿人确认(done，时元入账并履行心愿)
 * 同步模式同 wallet.ts / gift.ts：MQTT retained + localStorage 备份 + lastV 版本守卫 + 按 id 按 st 合并。
 */
import { sharedPublish, sharedSubscribe, onSharedConnect } from './mqttClient'
import { addTx } from './wallet'
import { isPairMember, membersKnown } from './space'
import { isGuestSession } from './guest'

/** 清理混入的外组账号数据 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scrubForeign(parsed: any): number {
  if (!membersKnown() || !Array.isArray(parsed?.wishes)) return 0
  const before = parsed.wishes.length
  parsed.wishes = (parsed.wishes as Array<{ from?: string; to?: string }>).filter(
    (w) => isPairMember(String(w?.from ?? '')) && isPairMember(String(w?.to ?? '')),
  )
  return before - parsed.wishes.length
}

const TOPIC = 'lovesite/wish2/state'
const LS_KEY = 'lovesite-wish2-backup'
const MAX_WISH = 80 // 最多保留 80 条心愿（非终态的永远保留）

export type WishStatus = 'pending' | 'approved' | 'declined' | 'purchased' | 'done' | 'withdrawn'

export type Wish = {
  id: string
  /** 许愿人：上架后负责履行，成交后收时元 */
  from: string
  /** 对方：负责审批、购买 */
  to: string
  /** 心愿内容（如「一杯奶茶」「按摩十分钟」） */
  name: string
  /** 插图 emoji（许愿时自选或按关键词自动匹配） */
  emoji: string
  /** 定价（时元），成交后由买方付给许愿人 */
  price: number
  /** 撒娇留言 */
  msg: string
  ts: number
  status: WishStatus
  /** 状态变更时间：合并冲突时以较大者为准 */
  st: number
  /** 购买人（= to） */
  buyer?: string
  /** 审批通过时间 */
  approvedTs?: number
  boughtTs?: number
  doneTs?: number
}

type State = { wishes: Wish[]; v: number }

let initialized = false
let wishes: Wish[] = []
let stateReceived = false
let cloudReady = false
let lastV = 0
let subscribers: Array<(w: Wish[]) => void> = []

/** 关键词 → 插图 emoji 自动匹配（许愿名命中即用，用户可再改） */
const KEYWORD_EMOJI: Array<[RegExp, string]> = [
  [/奶茶/, '🧋'], [/咖啡/, '☕'], [/饮料|可乐|果汁/, '🥤'], [/酒/, '🍷'],
  [/早餐|早饭/, '🍳'], [/做饭|下厨|菜/, '🍲'], [/火锅/, '🍲'], [/烧烤|烤肉/, '🍖'],
  [/零食|薯片|巧克力|甜品|蛋糕|冰淇淋/, '🍰'], [/水果|草莓|西瓜/, '🍓'], [/宵夜|夜宵/, '🍜'],
  [/抱|亲亲|吻|么么/, '🤗'], [/按摩|捶背|捏肩/, '💆'], [/洗头/, '💇'],
  [/洗碗|洗|拖|打扫|家务|卫生/, '🧽'], [/晾衣|叠衣|收衣服/, '👕'],
  [/电影|追剧|剧/, '🎬'], [/游戏|开黑|排位/, '🎮'], [/麻将|扑克|牌/, '🀄'],
  [/歌|唱|演唱会/, '🎤'], [/照片|拍照|写真/, '📸'], [/花|玫瑰/, '🌹'],
  [/约会|出门|逛|游乐园|玩/, '🎡'], [/旅行|旅游|出游|露营/, '✈️'], [/看星星|月亮/, '🌙'],
  [/礼物|惊喜/, '🎁'], [/红包/, '🧧'], [/陪|哄|讲故事/, '🫂'], [/早安|起床/, '🌅'], [/晚安/, '🌙'],
]

/** 许愿时的插图候选（emoji 选择器） */
export const EMOJI_OPTIONS: string[] = [
  '🧋', '☕', '🥤', '🍰', '🍓', '🍲', '🍜', '🍖', '🍳', '🍿',
  '🤗', '😘', '💆', '🫂', '🌹', '🎁', '🧧', '💌', '💖', '💝',
  '🎬', '🎮', '🎤', '📸', '🎡', '✈️', '🌙', '🌅', '🎠', '🎈',
  '🧽', '🧹', '🍳', '🛍️', '💅', '💇', '🛁', '🚗', '🏸', '🎣',
  '🍫', '🍉', '🥟', '🍱', '🧁', '🍩', '⚽', '🏀', '📚', '✨',
]

/** 按心愿名自动推荐插图 emoji，未命中返回 ✨ */
export function suggestEmoji(name: string): string {
  for (const [re, emoji] of KEYWORD_EMOJI) {
    if (re.test(name)) return emoji
  }
  return '✨'
}

function loadBackup(): State | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as State
    if (!Array.isArray(parsed.wishes)) return null
    scrubForeign(parsed as unknown as Record<string, unknown>)
    return { wishes: parsed.wishes, v: parsed.v ?? 0 }
  } catch {
    return null
  }
}

function saveBackup() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ wishes, v: lastV }))
  } catch {
    /* ignore */
  }
}

function notify() {
  const snapshot = [...wishes]
  subscribers.forEach((cb) => cb(snapshot))
}

/** 按 id 合并：同 id 冲突时以 st（状态变更时间）较大者为准 */
function mergeWishes(local: Wish[], remote: Wish[]): Wish[] {
  const byId = new Map<string, Wish>()
  for (const w of local) byId.set(w.id, w)
  for (const w of remote) {
    const cur = byId.get(w.id)
    if (!cur || (w.st ?? w.ts) >= (cur.st ?? cur.ts)) byId.set(w.id, w)
  }
  const all = [...byId.values()].sort((a, b) => b.ts - a.ts)
  const TERMINAL: WishStatus[] = ['declined', 'done', 'withdrawn']
  const alive = all.filter((w) => !TERMINAL.includes(w.status))
  const dead = all.filter((w) => TERMINAL.includes(w.status)).slice(0, MAX_WISH - alive.length)
  return [...alive, ...dead]
}

function ensureClient() {
  if (initialized) return
  initialized = true

  if (!stateReceived && wishes.length === 0) {
    const backup = loadBackup()
    if (backup) {
      wishes = backup.wishes
      lastV = backup.v ?? 0
    }
  }

  sharedSubscribe(TOPIC, (payload) => {
    if (payload.length === 0) return
    try {
      const state = JSON.parse(payload.toString()) as State
      if (!Array.isArray(state.wishes)) return
      const removedForeign = scrubForeign(state as unknown as Record<string, unknown>)
      stateReceived = true
      cloudReady = true
      const pv = state.v ?? 0
      const merged = mergeWishes(wishes, state.wishes)
      const changed = JSON.stringify(merged) !== JSON.stringify(wishes)
      if (pv <= lastV && !changed) {
        if (removedForeign > 0) publishState()
        return
      }
      lastV = Math.max(lastV, pv)
      wishes = merged
      saveBackup()
      notify()
      const remoteIds = new Set(state.wishes.map((w) => w.id))
      if (removedForeign > 0 || wishes.some((w) => !remoteIds.has(w.id))) publishState()
    } catch {
      /* ignore */
    }
  })

  onSharedConnect(() => {
    setTimeout(() => {
      if (!stateReceived) {
        cloudReady = true
        notify()
      }
    }, 3000)
  })
}

function publishState() {
  const v = Date.now()
  lastV = v
  sharedPublish(TOPIC, JSON.stringify({ wishes, v }))
}

export function subscribeWishes(onData: (w: Wish[]) => void): () => void {
  subscribers.push(onData)
  ensureClient()
  onData([...wishes])
  return () => {
    subscribers = subscribers.filter((cb) => cb !== onData)
  }
}

function setStatus(w: Wish[], id: string, status: WishStatus, extra?: Partial<Wish>): Wish[] {
  return w.map((x) => (x.id === id ? { ...x, status, st: Date.now(), ...extra } : x))
}

/** 许愿：写进池子里等对方审批 */
export function makeWish(from: string, to: string, name: string, emoji: string, price: number, msg: string): { ok: boolean; msg: string } {
  ensureClient()
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' }
  if (!cloudReady) return { ok: false, msg: '同步中，请稍后再试' }
  const trimmed = name.trim()
  if (!trimmed) return { ok: false, msg: '先写上心愿内容吧' }
  if (trimmed.length > 20) return { ok: false, msg: '心愿名字太长了，20 字以内' }
  const p = Math.floor(price)
  if (!Number.isFinite(p) || p <= 0) return { ok: false, msg: '给自己定个价吧（时元）' }
  if (p > 99999) return { ok: false, msg: '定价别太离谱啦（上限 99999）' }
  const wish: Wish = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    from,
    to,
    name: trimmed,
    emoji: emoji || suggestEmoji(trimmed),
    price: p,
    msg: msg.trim(),
    ts: Date.now(),
    status: 'pending',
    st: Date.now(),
  }
  wishes = [wish, ...wishes].slice(0, MAX_WISH)
  saveBackup()
  publishState()
  notify()
  return { ok: true, msg: `✨ 心愿已投入许愿池，等${to}点头～` }
}

/** 审批通过：上架心愿商店 */
export function approveWish(id: string, who: string): { ok: boolean; msg: string } {
  ensureClient()
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' }
  if (!cloudReady) return { ok: false, msg: '同步中，请稍后再试' }
  const w = wishes.find((x) => x.id === id)
  if (!w || w.to !== who) return { ok: false, msg: '心愿不存在' }
  if (w.status !== 'pending') return { ok: false, msg: '已经处理过啦' }
  wishes = setStatus(wishes, id, 'approved', { approvedTs: Date.now() })
  saveBackup()
  publishState()
  notify()
  return { ok: true, msg: `已同意，「${w.emoji}${w.name}」上架心愿商店～` }
}

/** 婉拒心愿 */
export function declineWish(id: string, who: string): { ok: boolean; msg: string } {
  ensureClient()
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' }
  if (!cloudReady) return { ok: false, msg: '同步中，请稍后再试' }
  const w = wishes.find((x) => x.id === id)
  if (!w || w.to !== who) return { ok: false, msg: '心愿不存在' }
  if (w.status !== 'pending') return { ok: false, msg: '已经处理过啦' }
  wishes = setStatus(wishes, id, 'declined')
  saveBackup()
  publishState()
  notify()
  return { ok: true, msg: '已婉拒这个心愿 🙈' }
}

/** 许愿人撤回（仅 pending 可撤回） */
export function withdrawWish(id: string, who: string): { ok: boolean; msg: string } {
  ensureClient()
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' }
  if (!cloudReady) return { ok: false, msg: '同步中，请稍后再试' }
  const w = wishes.find((x) => x.id === id)
  if (!w || w.from !== who) return { ok: false, msg: '心愿不存在' }
  if (w.status !== 'pending') return { ok: false, msg: '已经上架啦，不能反悔了哦' }
  wishes = setStatus(wishes, id, 'withdrawn')
  saveBackup()
  publishState()
  notify()
  return { ok: true, msg: '已撤回这个心愿' }
}

/** 买下心愿：买方付时元（先入池托管），等许愿人确认后入账 */
export function buyWish(id: string, who: string, myBalance: number): { ok: boolean; msg: string } {
  ensureClient()
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' }
  if (!cloudReady) return { ok: false, msg: '同步中，请稍后再试' }
  const w = wishes.find((x) => x.id === id)
  if (!w || w.to !== who) return { ok: false, msg: '心愿不存在' }
  if (w.status !== 'approved') return { ok: false, msg: '这个心愿暂时买不了' }
  if (myBalance < w.price) return { ok: false, msg: `时元不够啦，你有 ${myBalance}，这个心愿 ${w.price}` }
  if (!addTx(who, -w.price, `🛍️ 买下心愿：${w.emoji}${w.name}`)) return { ok: false, msg: '同步中，请稍后再试' }
  wishes = setStatus(wishes, id, 'purchased', { buyer: who, boughtTs: Date.now() })
  saveBackup()
  publishState()
  notify()
  return { ok: true, msg: `已买下「${w.name}」，等${w.from}确认后TA就欠你一次啦 💝` }
}

/** 许愿人确认收到：时元入账，心愿转为待履行 */
export function confirmWish(id: string, who: string): { ok: boolean; msg: string } {
  ensureClient()
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' }
  if (!cloudReady) return { ok: false, msg: '同步中，请稍后再试' }
  const w = wishes.find((x) => x.id === id)
  if (!w || w.from !== who) return { ok: false, msg: '心愿不存在' }
  if (w.status !== 'purchased') return { ok: false, msg: '这个还没被买走哦' }
  if (!addTx(who, w.price, `💝 心愿成交：${w.emoji}${w.name}`)) return { ok: false, msg: '同步中，请稍后再试' }
  wishes = setStatus(wishes, id, 'done', { doneTs: Date.now() })
  saveBackup()
  publishState()
  notify()
  return { ok: true, msg: `${w.price} 时元已入账！记得履行「${w.name}」哦 🫡` }
}

/** 买方取消购买（对方未确认前）：时元全额退回，心愿重新上架 */
export function cancelPurchase(id: string, who: string): { ok: boolean; msg: string } {
  ensureClient()
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' }
  if (!cloudReady) return { ok: false, msg: '同步中，请稍后再试' }
  const w = wishes.find((x) => x.id === id)
  if (!w || w.buyer !== who) return { ok: false, msg: '订单不存在' }
  if (w.status !== 'purchased') return { ok: false, msg: '已经确认成交啦' }
  if (!addTx(who, w.price, `↩️ 取消心愿订单：${w.emoji}${w.name}`)) return { ok: false, msg: '同步中，请稍后再试' }
  wishes = setStatus(wishes, id, 'approved', { buyer: undefined, boughtTs: undefined })
  saveBackup()
  publishState()
  notify()
  return { ok: true, msg: '已取消购买，时元退回，心愿重新上架' }
}

/** 等我审批的心愿（TA 许的） */
export function approvalsFor(list: Wish[], who: string): Wish[] {
  return list.filter((w) => w.status === 'pending' && w.to === who)
}

/** 货架：已上架的心愿 */
export function shelfOf(list: Wish[]): Wish[] {
  return list.filter((w) => w.status === 'approved').sort((a, b) => a.ts - b.ts)
}

/** 等许愿人确认的订单（我买的） */
export function awaitingTheirConfirm(list: Wish[], who: string): Wish[] {
  return list.filter((w) => w.status === 'purchased' && w.buyer === who)
}

/** 等我确认收款的订单（我许的愿被买了） */
export function awaitingMyConfirm(list: Wish[], who: string): Wish[] {
  return list.filter((w) => w.status === 'purchased' && w.from === who)
}

/** 我的心愿（全部状态） */
export function myWishes(list: Wish[], who: string): Wish[] {
  return list.filter((w) => w.from === who)
}

/** 全部门店记录（终态） */
export function terminalWishes(list: Wish[]): Wish[] {
  const T: WishStatus[] = ['done', 'declined', 'withdrawn']
  return list.filter((w) => T.includes(w.status))
}

/** 主页角标：等我审批 + 等我确认收款 */
export function wishBadgeFor(list: Wish[], who: string): number {
  return approvalsFor(list, who).length + awaitingMyConfirm(list, who).length
}
