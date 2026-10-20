/**
 * 故事榜单：完结作品的排行，MQTT 云端同步，两台手机实时一致。
 * 合并策略：按书 id 求并集（同名同 id 保留评分更高的那条），只增不删。
 */
import { sharedPublish, sharedSubscribe } from './mqttClient'
import { isPairMember, membersKnown } from './space'

/** 清理混入的外组账号数据：榜单只保留当前空间成员的作品 */
function scrubList(list: BoardBook[]): { list: BoardBook[]; removed: number } {
  if (!membersKnown()) return { list, removed: 0 }
  const filtered = list.filter((b) => isPairMember(String(b?.author ?? '')))
  return { list: filtered, removed: list.length - filtered.length }
}

export type BoardBook = {
  id: string // 与故事 id 一致
  bookName: string
  author: string // 成员A / 成员B
  genre: string
  endingType: string
  happiness: number
  brilliance: number
  comment: string
  endedTs: number
}

const TOPIC = 'lovesite/storyboard/state'
const LS_KEY = 'lovesite-storyboard-backup'

let books: BoardBook[] = []
let subscribers: Array<(b: BoardBook[]) => void> = []
let started = false

function notify(): void {
  const sorted = [...books].sort((a, b) => b.happiness + b.brilliance - (a.happiness + a.brilliance))
  subscribers.forEach((cb) => cb(sorted))
}

function persist(): void {
  localStorage.setItem(LS_KEY, JSON.stringify(books))
}

function merge(remote: BoardBook[]): void {
  const map = new Map<string, BoardBook>()
  for (const b of [...books, ...remote]) {
    const old = map.get(b.id)
    if (!old || b.happiness + b.brilliance > old.happiness + old.brilliance) map.set(b.id, b)
  }
  books = [...map.values()]
}

function start(): void {
  if (started) return
  started = true
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) books = scrubList(JSON.parse(raw) as BoardBook[]).list // 本地备份也清掉外组数据
  } catch {
    books = []
  }
  sharedSubscribe(TOPIC, (payload) => {
    if (payload.length === 0) return
    try {
      const remote = JSON.parse(payload.toString()) as { books?: BoardBook[] }
      if (Array.isArray(remote.books)) {
        const { list, removed } = scrubList(remote.books) // 外组作品入口清掉
        merge(list)
        persist()
        notify()
        if (removed > 0) sharedPublish(TOPIC, JSON.stringify({ books })) // 回发清理后的榜单
      }
    } catch {
      // 忽略坏包
    }
  })
}

/** 订阅榜单（返回退订函数） */
export function subscribeBoard(cb: (b: BoardBook[]) => void): () => void {
  start()
  subscribers.push(cb)
  const sorted = [...books].sort((a, b) => b.happiness + b.brilliance - (a.happiness + a.brilliance))
  cb(sorted)
  return () => {
    subscribers = subscribers.filter((s) => s !== cb)
  }
}

/** 上传一本完结的书到榜单 */
export function publishBook(book: BoardBook): void {
  start()
  merge([book])
  persist()
  sharedPublish(TOPIC, JSON.stringify({ books }))
  notify()
}
