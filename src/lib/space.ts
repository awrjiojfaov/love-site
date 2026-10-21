import { TOPIC_PREFIX, DEFAULT_MEMBERS as CONFIG_MEMBERS } from '../config'

/**
 * 数据空间（pair 隔离）：每组双人账号拥有完全独立的 MQTT 主题前缀。
 * - 默认空间用 `DEFAULT_PREFIX`（来自配置 VITE_TOPIC_PREFIX）
 * - 新建账号组使用 `lovesite-pair-<pairId>/`，与默认空间互不干扰
 * - 全局主题（账号注册表 registry / 绑定信令 binding）永远走默认前缀，不做空间改写
 *
 * 各业务模块的 TOPIC 常量统一以 MODULE_BASE 开头，无需改动：
 * mqttClient 在订阅/发布时统一调用 resolveTopic() 把 MODULE_BASE 换成当前空间前缀。
 */

/** 各业务模块 TOPIC 常量使用的基准前缀（框架常量，请勿修改） */
export const MODULE_BASE = 'lovesite/'

/** 默认空间的主题前缀（部署时用 VITE_TOPIC_PREFIX 指定） */
export const DEFAULT_PREFIX = TOPIC_PREFIX
/** 全局主题（不参与空间隔离）：账号注册表 + 绑定信令 */
const GLOBAL_SUBTREES = ['registry/', 'binding/']

const LS_SPACE = 'lovesite-space-id'

/** 默认空间的两位成员（部署时用 VITE_MEMBER_A / VITE_MEMBER_B 指定） */
export const DEFAULT_MEMBERS: [string, string] = [CONFIG_MEMBERS[0], CONFIG_MEMBERS[1]]

/* ---------- localStorage 按空间命名空间 ----------
 * 历史事故：所有空间共用同一份模块备份（lovesite-*-backup），在一台设备上切换账号时，
 * 清理逻辑会把主空间的数据抹掉（2026-09-07 樱花树清零事件）。
 * 这里统一给 localStorage 打补丁：非默认空间下，所有 lovesite-* 键自动落到
 * `<key>@<spaceId>`，全局键（空间指针/注册表/绑定信令）除外。
 * 补丁必须在使用方读取前生效——space.ts 被 mqttClient 引入，是全站最早的公共依赖之一。
 */
const GLOBAL_LS_KEYS = new Set([LS_SPACE, 'lovesite-registry-cache'])

function namespacedKey(key: string): string {
  if (!key.startsWith('lovesite-')) return key
  if (GLOBAL_LS_KEYS.has(key)) return key
  if (key.startsWith('lovesite-binding')) return key // 绑定信令保持全局
  const id = getSpaceId()
  return id ? `${key}@${id}` : key
}

try {
  const proto = Storage.prototype
  const origGet = proto.getItem
  const origSet = proto.setItem
  const origRemove = proto.removeItem
  proto.getItem = function (key: string) {
    return origGet.call(this, namespacedKey(key))
  }
  proto.setItem = function (key: string, value: string) {
    return origSet.call(this, namespacedKey(key), value)
  }
  proto.removeItem = function (key: string) {
    return origRemove.call(this, namespacedKey(key))
  }
} catch {
  /* 非浏览器环境（构建/脚本）跳过 */
}

export function getSpaceId(): string {
  try {
    return localStorage.getItem(LS_SPACE) ?? ''
  } catch {
    return ''
  }
}

export function setSpaceId(id: string): void {
  try {
    if (id) localStorage.setItem(LS_SPACE, id)
    else localStorage.removeItem(LS_SPACE)
  } catch {
    /* ignore */
  }
}

/** 当前空间的主题前缀 */
export function spacePrefix(): string {
  const id = getSpaceId()
  return id ? `lovesite-pair-${id}/` : DEFAULT_PREFIX
}

/**
 * 是否默认空间（默认账号组）。
 * 新建账号组 = registry 生成的 6 位 pairId。非默认空间时，一部分功能按新账号规则走：
 * 纪念日盲盒停发、主页计时改为双方自设、头像初始空白。
 */
export function isDefaultSpace(): boolean {
  return getSpaceId() === ''
}

function isGlobalTopic(topic: string): boolean {
  if (!topic.startsWith(MODULE_BASE)) return false
  const sub = topic.slice(MODULE_BASE.length)
  return GLOBAL_SUBTREES.some((g) => sub.startsWith(g))
}

/** 把模块里的基准前缀主题改写为当前空间主题；全局主题原样返回 */
export function resolveTopic(topic: string): string {
  if (!topic.startsWith(MODULE_BASE)) return topic
  if (isGlobalTopic(topic)) return topic
  return spacePrefix() + topic.slice(MODULE_BASE.length)
}

// ---- 成员解析（依赖 registry 的本地缓存，避免循环依赖只读 localStorage）----

type RegistryCache = {
  users?: Record<string, { name: string; pairId?: string }>
  pairs?: Record<string, { members: string[] }>
}

/** 2026-10-09 同步提速：按原始字符串缓存解析结果。
 *  旧实现每次调用都 JSON.parse(localStorage)——而 isPairMember 是 scrubForeign 里
 *  逐条记录调用的（钱包一笔交易一条、悄悄话一条消息一条），云端每来一条消息就是
 *  几百次同步 IO + 解析，主线程被冻结几百毫秒，表现就是「同步很慢/点了没反应」。
 *  原始串变了才重新解析（registry 写缓存走 setItem，下次读即失效） */
let regRaw: string | null = null
let regParsed: RegistryCache = {}
function readRegistryCache(): RegistryCache {
  let raw: string | null = null
  try {
    raw = localStorage.getItem('lovesite-registry-cache')
  } catch {
    return {}
  }
  if (raw === regRaw) return regParsed
  regRaw = raw
  if (!raw) {
    regParsed = {}
    return regParsed
  }
  try {
    regParsed = JSON.parse(raw) as RegistryCache
  } catch {
    regParsed = {}
  }
  return regParsed
}

/** 当前空间的两位成员名字 */
export function getPairMembers(): string[] {
  const id = getSpaceId()
  if (!id) return [...DEFAULT_MEMBERS]
  const members = readRegistryCache().pairs?.[id]?.members
  return members && members.length === 2 ? [...members] : []
}

/** 是否当前空间的成员（用于过滤外组混入的数据） */
export function isPairMember(name: string): boolean {
  if (!name) return false
  return getPairMembers().includes(name)
}

/** 我的搭档（当前空间里的另一个人）；找不到时返回空串 */
export function partnerOf(myName: string): string {
  const m = getPairMembers()
  const other = m.find((n) => n !== myName)
  return other ?? ''
}

/** 当前空间成员名单是否已知（未知时一切过滤都应放行，避免误删） */
export function membersKnown(): boolean {
  return getPairMembers().length > 0
}

/**
 * 过滤掉不属于当前空间成员的记录（清理历史上混入的其他账号组数据）。
 * keep 回调拿到 isMember 判定函数，自行决定记录去留；成员名单未知时原样放行。
 */
export function scrubByName<T>(
  list: T[],
  keep: (item: T, isMember: (n?: string) => boolean) => boolean,
): { list: T[]; removed: number } {
  const m = getPairMembers()
  if (m.length === 0) return { list, removed: 0 }
  const isMem = (n?: string) => !!n && m.includes(n)
  const filtered = list.filter((it) => keep(it, isMem))
  return { list: filtered, removed: list.length - filtered.length }
}

/** 删掉按人名作键的外组数据（如 archPlus / dayBy / owned）；名单未知时原样放行 */
export function scrubNameKeys<V>(rec: Record<string, V>): { rec: Record<string, V>; removed: number } {
  const m = getPairMembers()
  if (m.length === 0) return { rec, removed: 0 }
  let removed = 0
  const out: Record<string, V> = {}
  for (const [k, v] of Object.entries(rec)) {
    if (m.includes(k)) out[k] = v
    else removed++
  }
  return { rec: out, removed }
}
