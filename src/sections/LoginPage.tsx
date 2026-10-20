import { useEffect, useState } from 'react'
import { BellRing, Heart, Lock } from 'lucide-react'
import loginBg from '../assets/login-bg.webp'
import { subscribeAsks, type AskItem } from '../lib/ask'
import { subscribeRegistry, getRegistry } from '../lib/registry'
import { getPairMembers } from '../lib/space'
import { MEMBER_AVATARS, avatarB } from '../lib/memberAvatars'
import {
  MEMBER_A,
  MEMBER_B,
  MEMBER_A_PASSWORD,
  MEMBER_B_PASSWORD,
  ADMIN_NAME,
  ADMIN_PASSWORD,
  LOGIN_TITLE,
  ICP,
} from '../config'

export type User = {
  name: string
  avatar: string
  theme: 'pink' | 'blue'
  guest?: boolean // 游客：剧情工坊随便玩，其他板块只读
  password?: string // 用户密码
  bindingCode?: string // 绑定码
  isDefault?: boolean // 是否是默认账号
  pairId?: string // 所属账号组（空 = 默认账号组）
}



// 默认账号（昵称/密码见配置 VITE_MEMBER_A/B_*；头像见 src/lib/memberAvatars.ts）
export const DEFAULT_USERS: Record<string, User> = {
  [MEMBER_A]: { name: MEMBER_A, avatar: MEMBER_AVATARS[MEMBER_A], theme: 'pink', isDefault: true, password: MEMBER_A_PASSWORD, pairId: '' },
  [MEMBER_B]: { name: MEMBER_B, avatar: MEMBER_AVATARS[MEMBER_B], theme: 'blue', isDefault: true, password: MEMBER_B_PASSWORD, pairId: '' },
}

// 所有用户（默认 + 本机历史注册 + 云端注册表里的账号组）
let USERS: Record<string, User> = { ...DEFAULT_USERS }

/**
 * 隔离兜底：历史遗留的本机注册账号没有 pairId，统一归入 'legacy' 空间，
 * 绝不能落进默认账号组造成数据混杂。
 */
function isolateLegacyUsers() {
  for (const [key, u] of Object.entries(USERS)) {
    if (!u.isDefault && u.pairId === undefined) {
      USERS[key] = { ...u, pairId: 'legacy' }
    }
  }
}

// 合并云端注册表里的账号（管理员创建的账号组，任何设备都能登录）
function mergeRegistryUsers() {
  const registryUsers = Object.values(getRegistry().users).map((ru) => ({
    name: ru.name,
    avatar: '',
    theme: ru.theme,
    password: ru.password,
    isDefault: false,
    pairId: ru.pairId,
  }))
  USERS = { ...USERS, ...Object.fromEntries(registryUsers.map((u) => [u.name, u])) }
  isolateLegacyUsers()
}

// 从localStorage加载注册的用户
function loadRegisteredUsers() {
  try {
    const saved = localStorage.getItem('registeredUsers')
    if (saved) {
      const registered = JSON.parse(saved)
      USERS = { ...DEFAULT_USERS, ...registered }
    }
  } catch (e) {
    console.error('加载注册用户失败:', e)
  }
  mergeRegistryUsers()
}



/** 获取当前全部账号（默认 + 本机注册），供其他模块读取（浏览器端没有 require，必须走导入） */
export function getAllUsers(): Record<string, User> {
  return USERS
}



// 初始化
loadRegisteredUsers()

// 更新注册用户状态
function updateRegisteredUsers() {
  try {
    const saved = localStorage.getItem('registeredUsers')
    if (saved) {
      const registered = JSON.parse(saved)
      USERS = { ...DEFAULT_USERS, ...registered }
    }
  } catch (e) {
    console.error('加载注册用户失败:', e)
  }
  mergeRegistryUsers()
}

// 初始化和监听注册用户变化
updateRegisteredUsers()
window.addEventListener('storage', updateRegisteredUsers)
// 云端注册表更新时同步进 USERS（新账号组在其他设备上创建后本机可登录）
subscribeRegistry(() => mergeRegistryUsers())

/** 某人的待办问答数：等 TA 回答 + 等 TA 审核（仅旧流程遗留数据需要审核） */
function pendingOf(asks: AskItem[], name: string): { answer: number; judge: number } {
  return {
    answer: asks.filter((a) => a.to === name && a.status === 'pending').length,
    judge: asks.filter((a) => a.from === name && a.status === 'answered' && a.points == null).length,
  }
}

export default function LoginPage({ onLogin }: { onLogin: (user: User) => void }) {
  const [nickname, setNickname] = useState('')
  const [pwd, setPwd] = useState('')
  const [error, setError] = useState('')
  const [shake, setShake] = useState(false)
  const [asks, setAsks] = useState<AskItem[]>([])

  // 登录页小待办：有等你回答 / 等你审核的问答时提示（仅当前数据空间的两位成员）
  useEffect(() => subscribeAsks((a) => setAsks(a)), [])
  const members = getPairMembers()
  const todos = Object.values(USERS)
    .filter((u) => members.includes(u.name))
    .map((u) => ({ name: u.name, ...pendingOf(asks, u.name) }))
    .filter((t) => t.answer + t.judge > 0)

  const submit = () => {
    const trimmedNickname = nickname.trim()
    const trimmedPwd = pwd.trim()
    
    if (!trimmedNickname || !trimmedPwd) {
      setError('请输入昵称和密码')
      return
    }

    // 检查是否是默认账号
    const defaultUser = Object.values(DEFAULT_USERS).find(u => u.name === trimmedNickname)
    if (defaultUser) {
      // 默认账号使用密码登录
      if (trimmedPwd === defaultUser.password) {
        onLogin(defaultUser)
      } else {
        setError('密码错误')
        setShake(true)
        setTimeout(() => setShake(false), 500)
      }
      return
    }

    // 检查是否是已注册的用户
    const existingUser = Object.values(USERS).find(u => u.name === trimmedNickname)
    if (existingUser) {
      if (existingUser.password === trimmedPwd) {
        onLogin(existingUser)
      } else {
        setError('密码错误')
        setShake(true)
        setTimeout(() => setShake(false), 500)
      }
      return
    }

    // 检查是否是管理员（昵称见配置 VITE_ADMIN_NAME）
    if (trimmedNickname === ADMIN_NAME && trimmedPwd === ADMIN_PASSWORD) {
      // 管理员账号特殊处理，确保不会触发绑定逻辑导致自动退出
      const adminUser: User = {
        name: ADMIN_NAME,
        avatar: MEMBER_AVATARS[ADMIN_NAME] ?? avatarB,
        theme: 'blue',
        isDefault: true,
        password: ADMIN_PASSWORD
      }
      onLogin(adminUser)
      return
    }

    // 不是已注册的用户，提示错误
    setError(`用户不存在，请联系${ADMIN_NAME}创建账号`)
    setShake(true)
    setTimeout(() => setShake(false), 500)
  }


  
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-6">
      {/* 全屏封面背景 */}
      <img
        src={loginBg}
        alt=""
        className="pointer-events-none absolute inset-0 h-full w-full object-cover"
      />
      {/* 柔光遮罩：保证卡片和文字可读 */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/15 via-transparent to-black/30" />

      <div
        className={`relative z-10 w-full max-w-sm rounded-3xl bg-white/85 p-8 shadow-xl backdrop-blur-md transition-transform ${
          shake ? 'animate-[shake_0.45s_ease-in-out]' : ''
        }`}
      >
        <h1 className="mb-1 text-center text-2xl font-bold tracking-wide text-[#c44d7d]">
          {LOGIN_TITLE}
        </h1>
        <p className="mb-8 text-center text-sm text-[#b78aa5]">输入昵称和密码，开始属于你的旅程</p>

        <div className="mb-4 flex items-center gap-3 rounded-2xl border border-pink-200 bg-pink-50/60 px-4 py-3 focus-within:border-pink-400 focus-within:bg-white">
          <Heart className="h-5 w-5 shrink-0 text-pink-400" />
          <input
            type="text"
            placeholder="请输入昵称"
            value={nickname}
            autoFocus
            onChange={(e) => {
              setNickname(e.target.value)
              setError('')
            }}
            onKeyDown={(e) => e.key === 'Enter' && (pwd && submit())}
            className="w-full bg-transparent text-lg text-[#8a4a68] outline-none placeholder:text-sm placeholder:text-pink-300"
          />
        </div>

        <div className="mb-5 flex items-center gap-3 rounded-2xl border border-pink-200 bg-pink-50/60 px-4 py-3 focus-within:border-pink-400 focus-within:bg-white">
          <Lock className="h-5 w-5 shrink-0 text-pink-400" />
          <input
            type="password"
            placeholder="请输入密码"
            value={pwd}
            onChange={(e) => {
              setPwd(e.target.value)
              setError('')
            }}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            className="w-full bg-transparent text-lg text-[#8a4a68] outline-none placeholder:text-sm placeholder:text-pink-300"
          />
        </div>

        {error && (
          <p className="mb-4 text-center text-sm text-red-400">{error}</p>
        )}

        <button
          onClick={submit}
          className="w-full rounded-2xl bg-gradient-to-r from-pink-400 to-rose-400 py-3.5 text-lg font-semibold text-white shadow-lg shadow-pink-300/50 transition-all active:scale-95"
        >
          {Object.values(DEFAULT_USERS).some(u => u.name === nickname) ? '登录' : '登录'}
        </button>

        {/* 管理员账号显示管理入口 */}
        {nickname === ADMIN_NAME && pwd === ADMIN_PASSWORD && (
          <div className="mt-4 p-3 bg-purple-50 rounded-xl">
            <p className="text-xs text-purple-600 mb-2 font-medium">管理员功能</p>
            <button
              onClick={() => {
                // 这里可以跳转到管理页面
                alert('请从主页的管理按钮进入管理页面')
              }}
              className="w-full rounded-xl bg-purple-100 py-2 text-sm font-medium text-purple-600 transition-all active:bg-purple-200"
            >
              账号管理
            </button>
          </div>
        )}

        {/* 小待办：有待回答 / 待审核的问答时显示 */}
        {todos.length > 0 && (
          <div className="relative z-10 mt-4 flex items-center gap-2 rounded-full bg-white/70 px-4 py-2 shadow-md backdrop-blur">
            <BellRing className="h-3.5 w-3.5 shrink-0 animate-pulse text-rose-400" />
            <p className="text-[11px] text-[#b0678c]">
              {todos.map((t) => (
                <span key={t.name} className="mr-2.5 last:mr-0">
                  <span className="font-bold text-[#c44d7d]">{t.name}</span>
                  {t.answer > 0 && ` ${t.answer} 题待答`}
                  {t.answer > 0 && t.judge > 0 && ' ·'}
                  {t.judge > 0 && ` ${t.judge} 题待审`}
                </span>
              ))}
            </p>
          </div>
        )}

        {/* ICP 备案号（配置 VITE_ICP 提供；留空则不显示，中国大陆自建站才需要） */}
        {ICP && (
          <a
            href="https://beian.miit.gov.cn"
            target="_blank"
            rel="noreferrer"
            className="relative z-10 mt-3 text-[10px] tracking-wider text-white/70 [text-shadow:0_1px_3px_rgba(0,0,0,0.4)]"
          >
            {ICP}
          </a>
        )}

        <style>{`
          @keyframes shake {
            0%, 100% { transform: translateX(0); }
            20%, 60% { transform: translateX(-8px); }
            40%, 80% { transform: translateX(8px); }
          }
        `}</style>
      </div>
    </div>
  )
}