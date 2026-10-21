/**
 * 账号注册表：管理员（成员B）创建的双人账号组通过 MQTT retained 消息云端共享，
 * 新用户在自己手机上仅凭「账号名 + 密码」即可登录，无需任何本机预置数据。
 *
 * - 主题：lovesite/registry/accounts（全局主题，不做空间隔离）
 * - 只有管理员会发布；其他端只订阅读取
 * - 本地缓存 `lovesite-registry-cache` 供登录页同步读取（space.ts 也读它解析成员）
 */
import { sharedPublish, sharedSubscribe } from './mqttClient'
import { isAdminSession } from './auth'

const TOPIC = 'lovesite/registry/accounts'
const LS_CACHE = 'lovesite-registry-cache'

export type RegistryUser = {
  name: string
  password: string
  pairId: string
  theme: 'pink' | 'blue'
  createdAt: number
}

export type RegistryPair = {
  id: string
  members: [string, string]
  createdAt: number
}

export type Registry = {
  users: Record<string, RegistryUser>
  pairs: Record<string, RegistryPair>
  v: number
}

let current: Registry = { users: {}, pairs: {}, v: 0 }
let initialized = false
const listeners = new Set<(r: Registry) => void>()

// 启动时先用本地缓存渲染（登录页同步读取依赖它）
try {
  const raw = localStorage.getItem(LS_CACHE)
  if (raw) {
    const parsed = JSON.parse(raw) as Registry
    if (parsed && typeof parsed === 'object') {
      current = { users: parsed.users ?? {}, pairs: parsed.pairs ?? {}, v: parsed.v ?? 0 }
    }
  }
} catch {
  /* ignore */
}

function saveCache() {
  try {
    localStorage.setItem(LS_CACHE, JSON.stringify(current))
  } catch {
    /* ignore */
  }
}

function notify() {
  listeners.forEach((cb) => cb(current))
}

function ensureSubscribed() {
  if (initialized) return
  initialized = true
  sharedSubscribe(TOPIC, (payload) => {
    if (payload.length === 0) return
    try {
      const incoming = JSON.parse(payload.toString()) as Registry
      if (!incoming || typeof incoming !== 'object') return
      // 注册表只有管理员写入，简单按版本号取新
      if ((incoming.v ?? 0) <= current.v) return
      current = { users: incoming.users ?? {}, pairs: incoming.pairs ?? {}, v: incoming.v ?? 0 }
      saveCache()
      notify()
    } catch {
      /* ignore */
    }
  })
}

/** 同步读取当前注册表（本地缓存；云端更新到达后通过 subscribeRegistry 推送） */
export function getRegistry(): Registry {
  return current
}

/** 订阅注册表变化；返回取消函数 */
export function subscribeRegistry(cb: (r: Registry) => void): () => void {
  ensureSubscribed()
  listeners.add(cb)
  cb(current)
  return () => listeners.delete(cb)
}

/** 按账号名查找（不含默认账号；默认账号在 LoginPage 里硬编码） */
export function findRegistryUser(name: string): RegistryUser | null {
  return current.users[name] ?? null
}

/** 生成一个新账号组 ID（6 位小写字母数字） */
export function generatePairId(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'
  let id = ''
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)]
  return id
}

/** 管理员创建双人账号组；返回 pairId。调用方需自行校验重名。
 *  权限兜底：UI 层（AdminPage）按 ADMIN_NAME + 密码把关，这里再验一遍当前会话，
 *  防止任何绕过 UI 的调用路径直接改写全体账号的登录注册表。 */
export function createPair(
  name1: string,
  password1: string,
  name2: string,
  password2: string,
): string {
  if (!isAdminSession()) {
    console.warn('[registry] 非管理员会话，已拒绝创建账号组')
    return ''
  }
  const pairId = generatePairId()
  const now = Date.now()
  const next: Registry = {
    users: {
      ...current.users,
      [name1]: { name: name1, password: password1, pairId, theme: 'pink', createdAt: now },
      [name2]: { name: name2, password: password2, pairId, theme: 'blue', createdAt: now },
    },
    pairs: { ...current.pairs, [pairId]: { id: pairId, members: [name1, name2], createdAt: now } },
    v: now,
  }
  current = next
  saveCache()
  sharedPublish(TOPIC, JSON.stringify(next))
  notify()
  return pairId
}

/** 管理员删除整个账号组（两位成员一起移除；云端数据保留在原空间主题里，不再可登录） */
export function removePair(pairId: string): void {
  if (!isAdminSession()) {
    console.warn('[registry] 非管理员会话，已拒绝删除账号组')
    return
  }
  const pair = current.pairs[pairId]
  if (!pair) return
  const users = { ...current.users }
  for (const name of pair.members) delete users[name]
  const pairs = { ...current.pairs }
  delete pairs[pairId]
  current = { users, pairs, v: Date.now() }
  saveCache()
  sharedPublish(TOPIC, JSON.stringify(current))
  notify()
}

