import type { User } from '../sections/LoginPage'
import { ADMIN_NAME } from '../config'

/**
 * 会话存储键：与 App.tsx 的 SESSION_KEY 保持一致。
 * 历史遗留 bug：本模块原来读写的是另一个键 `currentUser`，而全站实际会话键是
 * `love-current-user`（登录时 App.handleLogin 只写入用户名字符串），导致
 * getUserSession() 永远拿不到值、setUserSession 写出的数据没人读。
 */
const SESSION_KEY = 'love-current-user'

/**
 * 获取当前登录的用户。
 * 兼容两种存法：完整 User 对象（JSON）与纯用户名字符串（App.handleLogin 的存法）。
 */
export function getUserSession(): User | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(SESSION_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { name?: string }
    if (parsed && typeof parsed.name === 'string') return parsed as User
  } catch {
    /* 不是 JSON → 按纯用户名字符串处理 */
  }
  return { name: raw } as User
}

/**
 * 设置当前登录的用户（与 App.handleLogin 的存法一致：只存用户名字符串）
 */
export function setUserSession(user: User): void {
  try {
    localStorage.setItem(SESSION_KEY, user.name)
  } catch {
    /* ignore */
  }
}

/**
 * 清除当前登录的用户
 */
export function clearUserSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * 检查当前登录会话是否是管理员（昵称见配置 VITE_ADMIN_NAME，名字由登录密码校验把关）
 */
export function isAdminSession(): boolean {
  const u = getUserSession()
  return !!u && u.name === ADMIN_NAME
}

/**
 * 检查是否是管理员用户（昵称见配置 VITE_ADMIN_NAME）
 */
export function isAdminUser(user: User | null): boolean {
  return user?.name === ADMIN_NAME
}
