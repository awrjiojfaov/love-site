import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { BellRing, BookHeart, BookOpen, Coins, Gem, Gift, Heart, Lock, LockOpen, LogOut, MapPinned, MessageCircleHeart, Palette, Pencil, PiggyBank, ScrollText, Send, Sparkles, Star, TrendingUp, Users, X } from 'lucide-react'
import bgHero from '../assets/bg-hero.jpg'
import lihuaCat from '../assets/pet/lihua-cat.png'
import { MEMBER_AVATARS } from '../lib/memberAvatars'
import { LOVE_START, ADMIN_NAME, ICP } from '../config'
import type { User } from './LoginPage'
import { getAllUsers as getUserMap } from './LoginPage'
import { partnerOf, isDefaultSpace, hasSecretFeatures } from '../lib/space'
import { subscribeRegistry } from '../lib/registry'
import { subscribeLoveTime, setLoveTime } from '../lib/loveTime'
import { subscribeWallet, type WalletTx } from '../lib/wallet'
import { subscribeAsks, type AskItem } from '../lib/ask'
import { totalBalance } from '../lib/balance'
import { loginTreeXp, subscribeTree } from '../lib/tree'
import { subscribeFarm, farmOf, DEX_TOTAL, type FarmOf } from '../lib/farm'
import { subscribeBlindbox, availableFor, type Who } from '../lib/blindbox'
import { subscribeJade, jadeWealth } from '../lib/jade'
import { subscribeRatings } from '../lib/store'
import { subscribeWishes, approvalsFor, awaitingMyConfirm } from '../lib/wish'
import { subscribeLockdown, setGardenLocked as setGardenLockedCloud, GARDEN_KEEPER } from '../lib/lockdown'
import { subscribeFrames, type FramesState } from '../lib/frames'
import { subscribeAvatars } from '../lib/avatar'
import { subscribeJar, jarBalance, type JarTx } from '../lib/jar'
import { subscribeWhisper, subscribeTyping, sendTyping, sendWhisper, type WhisperMsg } from '../lib/whisper'
import { isGuestSession } from '../lib/guest'

import { checkAndGenerateAIRating } from '../lib/store'
import { frameById } from '../data/frames'
import FramesModal from './FramesModal'
import TreeSection from './TreeSection'
import BlindBoxModal from './BlindBoxModal'
import AvatarView from '../components/AvatarView'
import PetalParticles from '../components/PetalParticles'

/**
 * 在一起的起始时刻（默认账号组专用，固定绝对时间，两台手机显示完全一致）。
 * 取值来自配置 VITE_LOVE_START；未配置则为 0，主页不做写死计时。
 * 新建账号组不用它：初始留空，由双方在主页自己设置（见 lib/loveTime.ts）。
 */
const START_TIME = LOVE_START

function useLoveTimer(start: number) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const diff = Math.max(0, now - start)
  const days = Math.floor(diff / 86400000)
  const hours = Math.floor((diff % 86400000) / 3600000)
  const minutes = Math.floor((diff % 3600000) / 60000)
  const seconds = Math.floor((diff % 60000) / 1000)
  return { days, hours, minutes, seconds }
}

export default function HomePage({
  user,
  onLogout,
  onOpenRatings,
  onOpenSecret,
  onOpenQuiz,
  onOpenAsk,
  onOpenFarm,
  onOpenRecords,
  onOpenMap,
  onOpenWishShop,
  onOpenStory,
  onOpenMemoir,
  onOpenJar,
  onOpenWhisper,
  onOpenDrawGuess,
  onOpenJade,
  onOpenAuction,
  onOpenStock,
  onOpenAdmin,
}: {
  user: User
  onLogout: () => void
  onOpenRatings: () => void
  onOpenSecret: () => void
  onOpenQuiz: () => void
  onOpenAsk: () => void
  onOpenFarm: () => void
  onOpenRecords: () => void
  onOpenMap: () => void
  onOpenWishShop: () => void
  onOpenStory: () => void
  onOpenMemoir: () => void
  onOpenJar: () => void
  onOpenWhisper: () => void
  onOpenDrawGuess: () => void
  onOpenJade: () => void
  onOpenAuction: () => void
  onOpenStock: () => void
  onOpenAdmin: () => void
}) {
  // 账号组判定：默认账号组保留全部老功能，其余按新账号规则
  const isDefault = isDefaultSpace()

  // 隐藏页面权限：管理员在管理端改动后，本页入口实时刷新（注册表缓存变化即重渲染）
  const [, bumpAccess] = useState(0)
  useEffect(() => subscribeRegistry(() => bumpAccess((v) => v + 1)), [])
  const canOpenHidden = hasSecretFeatures(user.name)

  // 在一起的起始时刻：默认组写死常量；新建组留空由双方自设，设置后持久、双方同步
  const [loveStart, setLoveStart] = useState<number | null>(null)
  const [timeEditing, setTimeEditing] = useState(false)
  const [draftDate, setDraftDate] = useState('')
  const [draftTime, setDraftTime] = useState('')
  const needSetup = !isDefault && loveStart === null
  const { days, hours, minutes, seconds } = useLoveTimer(
    isDefault ? START_TIME : (loveStart ?? START_TIME),
  )

  useEffect(() => {
    if (isDefault) return
    return subscribeLoveTime(setLoveStart)
  }, [isDefault])

  const pad2 = (n: number) => String(n).padStart(2, '0')
  const openTimeEdit = () => {
    const d = new Date(loveStart ?? Date.now())
    setDraftDate(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`)
    setDraftTime(`${pad2(d.getHours())}:${pad2(d.getMinutes())}`)
    setTimeEditing(true)
  }
  const saveLoveTime = () => {
    if (!draftDate) return
    const ms = new Date(`${draftDate}T${draftTime || '00:00'}:00`).getTime()
    if (!Number.isFinite(ms)) return
    setLoveTime(ms, user.name)
    setLoveStart(ms)
    setTimeEditing(false)
  }

  // 时元总资产：钱包账本 + 问答积分，MQTT 实时更新
  const [txs, setTxs] = useState<WalletTx[]>([])
  const [asks, setAsks] = useState<AskItem[]>([])
  const [farms, setFarms] = useState<Record<string, FarmOf>>({})
  const [treeTotal, setTreeTotal] = useState(0)
  const [boxCount, setBoxCount] = useState(0)
  const [boxOpen, setBoxOpen] = useState(false)
  // 许愿池：等我审批的心愿数（功能位角标）
  const [wishApproveCount, setWishApproveCount] = useState(0)
  // 心愿商店：等我确认收款的订单数（功能位角标）
  const [wishConfirmCount, setWishConfirmCount] = useState(0)
  // 见闻打分：我还没打分的项目数（板块右上角数字角标）
  const [unrated, setUnrated] = useState(0)
  // 富贵值：（收藏柜+切割台）玉石总价值 × 0.01，自己和搭档各一份（subscribeJade 触发重算）
  const partnerNameForWealth = partnerOf(user.name)
  const [wealth, setWealth] = useState<Record<string, number>>({})
  useEffect(
    () =>
      subscribeJade(() => {
        const next: Record<string, number> = { [user.name]: jadeWealth(user.name) }
        if (partnerNameForWealth) next[partnerNameForWealth] = jadeWealth(partnerNameForWealth)
        setWealth(next)
      }),
    [user.name, partnerNameForWealth],
  )
  useEffect(() => {
    const u1 = subscribeWallet((t) => setTxs(t))
    const u2 = subscribeAsks((a) => setAsks(a))
    const u3 = subscribeFarm((f) => setFarms(f))
    const u4 = subscribeTree((s) => setTreeTotal(s.total))
    // 纪念日盲盒：新建账号组整体停用（不订阅、不显示）
    const u5 = isDefault
      ? subscribeBlindbox(() => setBoxCount(availableFor(user.name as Who).length))
      : () => {}
    const u6 = subscribeWishes((w) => {
      setWishApproveCount(approvalsFor(w, user.name).length)
      setWishConfirmCount(awaitingMyConfirm(w, user.name).length)
    })
    const u7 = subscribeRatings((d) =>
      setUnrated(d.items.filter((it) => it.scores[user.name] === undefined).length),
    )
    setBoxCount(isDefault ? availableFor(user.name as Who).length : 0)
    loginTreeXp(user.name) // 每日登录经验（幂等，每人每天一次）
    
    // 检查并生成AI评分
    checkAndGenerateAIRating()
    
    return () => {
      u1()
      u2()
      u3()
      u4()
      u5()
      u6()
      u7()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const balanceOf = (name: string) => totalBalance(txs, asks, name)

  // 农场成熟提醒：有自己已成熟的作物或鱼时，农场按钮亮红点
  const myFarm = farmOf(farms, user.name)
  const hasMature =
    myFarm.plots.some((p) => p.cropId && p.matureAt <= Date.now()) ||
    myFarm.pond.some((s) => s.fishId && s.matureAt <= Date.now())
  const warehouseCount = Object.values(myFarm.warehouse).reduce((a, b) => a + b, 0)

  // 我的问答待办：等我回答 + 等我审核（仅旧流程遗留数据需要审核）
  const todoAnswer = asks.filter((a) => a.to === user.name && a.status === 'pending').length
  const todoJudge = asks.filter(
    (a) => a.from === user.name && a.status === 'answered' && a.points == null,
  ).length
  const todoTotal = todoAnswer + todoJudge

  // 欢迎语：停留片刻后自动淡出消失
  const [showWelcome, setShowWelcome] = useState(true)
  useEffect(() => {
    const id = setTimeout(() => setShowWelcome(false), 3500)
    return () => clearTimeout(id)
  }, [])

  // 秘密空间密码门
  const [gateOpen, setGateOpen] = useState(false)
  const [gatePwd, setGatePwd] = useState('')
  const [gateError, setGateError] = useState(false)


  const openGate = () => {
    setGateOpen(true)
  }

  // 花园停用状态（仅花园管理员可见右上角开关）
  const [gardenLocked, setGardenLocked] = useState(false)
  useEffect(() => subscribeLockdown((s) => setGardenLocked(s.locked)), [])

  // 头像框：两人佩戴状态 + 商店弹窗
  const [framesState, setFramesState] = useState<FramesState>({ owned: {}, equipped: {} })
  const [framesOpen, setFramesOpen] = useState(false)
  const [avatars, setAvatars] = useState<Record<string, string>>({})
  const [jarTxs, setJarTxs] = useState<JarTx[]>([])
  useEffect(() => {
    subscribeFrames(setFramesState)
    subscribeAvatars(setAvatars)
    const uJar = subscribeJar((t) => setJarTxs(t))
    return () => uJar()
  }, [])

  // 自定义头像由 AvatarView 直接订阅云端；这里只留 FramesModal 预览用的快照

  /** ===== 悄悄话 · 主页实时弹幕 =====
   *  liveDraft：对方正在打的字（typing 信令实时捎带原文，1.6s 无新字符自动散掉）
   *  dmks：正式送出的消息飘屏幕（自己发 + 悄悄话页发的 + 对方发，全部走消息 diff） */
  type Dmk = { key: number; who: string; text: string; mine: boolean; lane: number; dur: number }
  const [dmks, setDmks] = useState<Dmk[]>([])
  const dmkSeq = useRef(0)
  const whisperPrevIds = useRef<Set<string> | null>(null)
  const [liveDraft, setLiveDraft] = useState<{ who: string; text: string } | null>(null)
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [whisperInput, setWhisperInput] = useState('')
  const [whisperOpen, setWhisperOpen] = useState(false)
  const [sendFailed, setSendFailed] = useState(false)
  const guestView = isGuestSession()
  const dmkColor = (who: string) => (who === user.name ? '#e5487f' : '#8b5cf6')

  useEffect(() => {
    const uTyping = subscribeTyping((who, text) => {
      if (!text || who === user.name) return
      setLiveDraft({ who, text })
      if (liveTimer.current) clearTimeout(liveTimer.current)
      liveTimer.current = setTimeout(() => setLiveDraft(null), 1600)
    })
    const uMsg = subscribeWhisper((list: WhisperMsg[]) => {
      const prev = whisperPrevIds.current
      const cur = new Set(list.map((m) => m.id))
      if (!prev) { whisperPrevIds.current = cur; return }
      const fresh = list.filter((m) => !prev.has(m.id) && !m.del)
      whisperPrevIds.current = cur
      if (fresh.length === 0) return
      setDmks((old) => {
        const next = [...old]
        for (const m of fresh.slice(-4)) {
          const seq = ++dmkSeq.current
          next.push({ key: seq, who: m.who, text: m.text, mine: m.who === user.name, lane: seq % 3, dur: 6.5 + (seq % 3) * 0.9 })
        }
        return next.slice(-5)
      })
    })
    return () => {
      uTyping()
      uMsg()
      if (liveTimer.current) clearTimeout(liveTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.name])

  const whisperSend = () => {
    const t = whisperInput.trim()
    if (!t) return
    if (sendWhisper(user.name, t)) {
      setWhisperInput('')
      setSendFailed(false)
      setWhisperOpen(false)
    } else {
      setSendFailed(true)
      setTimeout(() => setSendFailed(false), 1200)
    }
  }
  const onWhisperChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    setWhisperInput(v)
    setSendFailed(false)
    if (v.trim()) sendTyping(user.name, v.trim())
  }

  /** 狸花猫挂件：不打字时蹲在屏幕上，可以拖着走；点一下打开输入框。开窗/收窗不依赖 blur，避免手机上焦点抢占地盘时窗口刚开又被关掉 */
  const [catPos, setCatPos] = useState({ x: -200, y: -200 })
  const catDrag = useRef({ active: false, moved: false, sx: 0, sy: 0, ox: 0, oy: 0, id: -1, suppressClick: false })
  const whisperInputRef = useRef<HTMLInputElement | null>(null)
  const lastWhisperOpenAt = useRef(0)
  useEffect(() => {
    const place = () => setCatPos({
      x: Math.max(8, window.innerWidth - 64 - 20),
      y: Math.max(8, window.innerHeight - (user.name === ADMIN_NAME ? 192 : 88)),
    })
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [user.name])
  /** 同步提交并立刻聚焦：整个动作发生在指针手势的同一个浏览器任务内，iOS/微信内核才肯弹键盘 */
  const openWhisperNow = () => {
    flushSync(() => setWhisperOpen(true))
    lastWhisperOpenAt.current = Date.now()
    try { whisperInputRef.current?.focus({ preventScroll: true }) } catch { whisperInputRef.current?.focus() }
  }
  const closeWhisper = () => {
    // 刚打开的 300ms 内忽略一切收起动作：挡掉这一次点按残留的幽灵 click 误触到胶囊关闭按钮上
    if (Date.now() - lastWhisperOpenAt.current < 300) return
    setWhisperOpen(false)
  }
  const onCatDown = (e: React.PointerEvent<HTMLElement>) => {
    catDrag.current = { active: true, moved: false, sx: e.clientX, sy: e.clientY, ox: catPos.x, oy: catPos.y, id: e.pointerId, suppressClick: false }
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* 个别内核不支持捕获，靠 click/touchend 兜底 */ }
  }
  const onCatMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = catDrag.current
    if (!d.active || e.pointerId !== d.id) return
    const dx = e.clientX - d.sx
    const dy = e.clientY - d.sy
    if (!d.moved && Math.abs(dx) + Math.abs(dy) > 10) d.moved = true
    if (!d.moved) return
    setCatPos({
      x: Math.min(Math.max(8, d.ox + dx), window.innerWidth - 72),
      y: Math.min(Math.max(8, d.oy + dy), window.innerHeight - 72),
    })
  }
  const onCatUp = (e: React.PointerEvent<HTMLElement>) => {
    const d = catDrag.current
    if (!d.active || e.pointerId !== d.id) return
    d.active = false
    if (d.moved) d.suppressClick = true
    else openWhisperNow()
  }
  const onCatTouchEnd = (e: React.TouchEvent<HTMLElement>) => {
    // 老 WebView 内核没有 PointerEvents 时靠 touchend 开窗；preventDefault 顺带拦掉这次的幽灵 click
    const d = catDrag.current
    if (!d.moved && !d.suppressClick) openWhisperNow()
    e.preventDefault()
  }
  const onCatClick = () => {
    const d = catDrag.current
    if (d.suppressClick) { d.suppressClick = false; return }
    openWhisperNow()
  }

  /** 带头像框的头像：框图按 130% 居中叠在头像之上；新建账号组无自定义头像时显示空白占位（点击即上传） */
  const renderAvatar = (name: string, mine: boolean) => {
    const frame = frameById(framesState.equipped[name])
    const fallback = mine
      ? user.avatar
      : isDefault
        ? (MEMBER_AVATARS[name] ?? '')
        : ''
    return (
      <button
        type="button"
        onClick={mine ? () => setFramesOpen(true) : undefined}
        className={`relative ${mine ? 'transition-transform active:scale-95' : 'cursor-default'}`}
        title={mine ? '换头像/头像框' : name}
      >
        <AvatarView
          name={name}
          fallback={fallback}
          size={80}
          uploadHint={mine && !avatars[name] && !fallback}
          className="border-4 border-white shadow-xl shadow-pink-300/40"
        />
        {frame && (
          <img
            src={frame.img}
            alt=""
            className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
            style={{ width: '130%', height: '130%', maxWidth: 'none' }}
          />
        )}
        {mine && (
          <span className="absolute -bottom-1 -right-1 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-pink-400 to-rose-400 shadow-md">
            <Sparkles className="h-3 w-3 text-white" />
          </span>
        )}
      </button>
    )
  }

  const toggleLockdown = () => {
    if (gardenLocked) {
      setGardenLockedCloud(user.name, false)
    } else if (
      window.confirm('要把花园暂时关上吗？🌙\n关上后两个人都用不了，只有你能重新打开。')
    ) {
      setGardenLockedCloud(user.name, true)
    }
  }

  const tryUnlock = () => {
    // 只有本人输本人密码才能进（账号表可能按名称或按密码作键，统一按密码字段匹配）
    const account = Object.values(getUserMap()).find((u) => u.password === gatePwd.trim())
    if (account && account.name === user.name) {
      setGateOpen(false)
      setGatePwd('')
      setGateError(false)
      onOpenSecret()
    } else {
      setGateError(true)
      setGatePwd('')
    }
  }

  return (
    <div className="garden-bg min-h-dvh">
      {/* ===== 顶部背景区 ===== */}
      <div className="relative h-[46dvh] max-h-[430px] min-h-[300px]">
        <img
          src={bgHero}
          alt="背景"
          className="absolute inset-0 h-full w-full object-cover object-[center_30%]"
        />
        {/* 双层光晕：顶部压暗 + 底部暖粉晕，比单层黑光更有层次 */}
        <div
          className="absolute inset-0"
          style={{ background: 'linear-gradient(180deg, rgba(30,10,25,0.22) 0%, transparent 45%)' }}
        />
        <div
          className="absolute inset-0"
          style={{ background: 'radial-gradient(120% 70% at 50% 100%, rgba(255,190,220,0.38) 0%, transparent 70%)' }}
        />
        {/* 飘落花瓣（装饰层，低动态偏好自动关闭） */}
        <PetalParticles />

        {/* 欢迎语：3.5 秒后自动淡出 */}
        <div
          className={`absolute inset-x-0 top-8 flex justify-center transition-all duration-700 ${
            showWelcome ? 'opacity-100' : 'pointer-events-none -translate-y-2 opacity-0'
          }`}
        >
          <div className="glass-chip flex items-center gap-2 rounded-full px-5 py-2">
            <Sparkles className="h-4 w-4 text-white" />
            <span className="text-sm font-medium tracking-widest text-white drop-shadow">
              欢迎回来，{user.name}
            </span>
          </div>
        </div>

        {/* 花园停用开关：仅管理员可见，右上角 */}
        {user.name === GARDEN_KEEPER && (
          <button
            onClick={toggleLockdown}
            title={gardenLocked ? '花园已关闭，点我重新打开' : '暂时关闭花园'}
            className="glass-chip absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full transition-transform active:scale-90"
          >
            {gardenLocked ? (
              <Lock className="h-4 w-4 text-white drop-shadow" />
            ) : (
              <LockOpen className="h-4 w-4 text-white drop-shadow" />
            )}
          </button>
        )}

        {/* 题诗：夜景明月，正合此句 */}
        <div className="absolute inset-x-0 top-[38%] -translate-y-1/2 text-center">
          <p
            className="text-[26px] leading-relaxed tracking-[0.35em] text-white"
            style={{
              fontFamily: "'Ma Shan Zheng', 'STKaiti', 'KaiTi', cursive",
              textShadow: '0 2px 12px rgba(60,20,60,0.55), 0 0 26px rgba(255,190,220,0.45)',
            }}
          >
            一别两地同风雨
          </p>
          <p
            className="mt-1 text-[26px] leading-relaxed tracking-[0.35em] text-white"
            style={{
              fontFamily: "'Ma Shan Zheng', 'STKaiti', 'KaiTi', cursive",
              textShadow: '0 2px 12px rgba(60,20,60,0.55), 0 0 26px rgba(255,190,220,0.45)',
            }}
          >
            我望明月月望你
          </p>
        </div>

        {/* 底部双层波：后层浅粉错位，前层页面色，衔接更柔 */}
        <svg
          viewBox="0 0 1440 110"
          preserveAspectRatio="none"
          className="absolute -bottom-px left-0 h-[60px] w-full"
        >
          <path
            d="M0,55 C240,110 480,108 720,80 C960,52 1200,18 1440,48 L1440,110 L0,110 Z"
            fill="#fbd9e8"
            opacity="0.5"
            transform="translate(0,-14)"
          />
          <path
            d="M0,55 C240,110 480,108 720,80 C960,52 1200,18 1440,48 L1440,110 L0,110 Z"
            fill="#fff5f8"
          />
        </svg>

        {/* 用户头像 + 爱心 */}
        <div className="absolute inset-x-0 -bottom-12 flex items-end justify-center gap-8">
          <div className="flex flex-col items-center gap-2">
            {renderAvatar(user.name, true)}
            <span className="text-sm font-bold tracking-wider text-[#c44d7d]">{user.name}</span>
            <span className="-mt-1 flex items-center gap-1 rounded-full bg-white/70 px-2.5 py-0.5 shadow-sm">
              <Gem className="h-3 w-3 text-emerald-500" />
              <span className="text-[10px] font-bold tabular-nums text-emerald-600">富贵值 {wealth[user.name] ?? 0}</span>
            </span>
            <span className="-mt-1 flex items-center gap-1 rounded-full bg-white/80 px-2.5 py-0.5 shadow-sm">
              <Coins className="h-3 w-3 text-amber-500" />
              <span className="text-[11px] font-bold tabular-nums text-amber-600">{balanceOf(user.name)}</span>
            </span>
          </div>

          <div className="mb-9 flex flex-col items-center gap-1.5">
            <button
              onClick={onOpenRecords}
              className="flex items-center gap-1 rounded-full bg-white/90 px-3 py-1 text-[10px] font-bold tracking-wider text-amber-600 shadow-md shadow-pink-200/50 transition-transform active:scale-95"
              title="时元记录"
            >
              <ScrollText className="h-3 w-3" />
              记录
            </button>
            {/* 秘密空间入口：仅白名单账号组（默认组）可点入；其他账号组只展示浮动的爱心，不可进入 */}
            {canOpenHidden ? (
              <button
                onClick={openGate}
                className="transition-transform active:scale-125"
                title="秘密空间"
              >
                <Heart className="h-7 w-7 animate-[beat_1.2s_ease-in-out_infinite] fill-red-500 text-red-500 drop-shadow-lg" />
              </button>
            ) : (
              <div className="cursor-default" aria-hidden>
                <Heart className="h-7 w-7 animate-[beat_1.2s_ease-in-out_infinite] fill-red-500 text-red-500 drop-shadow-lg" />
              </div>
            )}
          </div>

          {/* 显示另一方的账号作为参考（当前数据空间里的搭档） */}
          {(() => {
            const partnerName = partnerOf(user.name)
            if (!partnerName) return null
            return (
              <div key={partnerName} className="flex flex-col items-center gap-2">
                {renderAvatar(partnerName, false)}
                <span className="text-sm font-bold tracking-wider text-[#c44d7d]">{partnerName}</span>
                <span className="-mt-1 flex items-center gap-1 rounded-full bg-white/70 px-2.5 py-0.5 shadow-sm">
                  <Gem className="h-3 w-3 text-emerald-500" />
                  <span className="text-[10px] font-bold tabular-nums text-emerald-600">富贵值 {wealth[partnerName] ?? 0}</span>
                </span>
                <span className="-mt-1 flex items-center gap-1 rounded-full bg-white/80 px-2.5 py-0.5 shadow-sm">
                  <Coins className="h-3 w-3 text-amber-500" />
                  <span className="text-[11px] font-bold tabular-nums text-amber-600">{balanceOf(partnerName)}</span>
                </span>
              </div>
            )
          })()}
        </div>
      </div>

      {/* ===== 内容区 ===== */}
      <div className="mx-auto max-w-md px-6 pb-0 pt-24">
        {/* 在一起时钟：默认账号组写死纪念日；新建账号组初始留空，由双方自己设置、双方可见 */}
        <div className="mb-8 text-center">
          {needSetup ? (
            <div className="rounded-3xl border border-dashed border-pink-300/70 bg-gradient-to-br from-pink-50 to-rose-100 px-5 py-6 shadow-sm">
              <p className="text-base font-semibold tracking-wide text-[#c44d7d]">先定下我们在一起的时间</p>
              <p className="mt-1.5 text-xs leading-relaxed text-[#a4698a]">
                设置之后，你和 TA 的手机显示同一份计时
                <br />
                只属于你们俩，以后随时可以修改
              </p>
              <button
                type="button"
                onClick={openTimeEdit}
                className="mt-4 rounded-full bg-gradient-to-r from-pink-400 to-rose-400 px-6 py-2.5 text-sm font-bold text-white shadow-lg shadow-pink-300 transition-transform active:scale-95"
              >
                设置在一起的时间
              </button>
            </div>
          ) : (
            <>
              <div className="mb-3 flex items-center justify-center gap-1.5">
                <p className="text-lg font-semibold tracking-wide text-[#c44d7d]">今天，是我们在一起的</p>
                {!isDefault && (
                  <button
                    type="button"
                    onClick={openTimeEdit}
                    title="修改在一起的时间"
                    className="rounded-full bg-white/80 p-1 text-[#c44d7d] shadow-sm transition-transform active:scale-90"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <p className="text-2xl font-bold tabular-nums tracking-wide text-[#8a4a68]">
                第 {days} 天 {hours} 小时 {minutes} 分钟 {seconds} 秒
              </p>
            </>
          )}
        </div>

        {/* 爱情树：时钟下方、功能区上方 */}
        <TreeSection who={user.name} />

        {/* 存钱罐独立板块：横幅入口，点击进入存钱罐页面 */}
        <button
          onClick={onOpenJar}
          className="relative mb-5 flex w-full items-center gap-4 overflow-hidden rounded-3xl bg-gradient-to-r from-amber-50/70 via-rose-50/70 to-pink-100/70 px-5 py-4 text-left shadow-lg shadow-pink-200/60 ring-1 ring-amber-200/60 backdrop-blur-[10px] transition-transform active:scale-[0.98]"
        >
          {/* 背景装饰硬币 */}
          <Coins className="absolute -right-3 -top-3 h-16 w-16 rotate-12 text-amber-200/50" />
          <Coins className="absolute right-10 -bottom-4 h-10 w-10 -rotate-12 text-rose-200/50" />

          <div className="relative flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-300 via-pink-400 to-rose-400 shadow-md shadow-rose-200">
            <PiggyBank className="h-7 w-7 text-white drop-shadow" />
          </div>

          <div className="relative min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-[15px] font-bold tracking-wide text-[#c44d7d]">
              我们的存钱罐
              <span className="animate-pulse">🐷</span>
            </p>
          </div>

          <div className="relative shrink-0 text-right">
            <p className="text-[10px] tracking-widest text-amber-500">共同基金</p>
            <p className="flex items-center justify-end gap-1 text-xl font-bold tabular-nums text-amber-600">
              <Coins className="h-4 w-4 text-amber-500" />
              {jarBalance(jarTxs).toFixed(2)}
            </p>
          </div>
        </button>

        {/* 问答待办条：有待处理时显示，点了直达时元申请 */}
        {todoTotal > 0 && (
          <button
            onClick={onOpenAsk}
            className="mb-4 flex w-full items-center gap-2.5 rounded-2xl bg-gradient-to-r from-violet-400/90 to-fuchsia-400/90 px-4 py-3 text-left shadow-lg shadow-violet-200 transition-transform active:scale-[0.98]"
          >
            <BellRing className="h-4 w-4 shrink-0 animate-pulse text-white" />
            <p className="flex-1 text-xs font-medium text-white">
              有问答等你处理：
              {todoAnswer > 0 && ` ${todoAnswer} 题等你回答`}
              {todoAnswer > 0 && todoJudge > 0 && '，'}
              {todoJudge > 0 && ` ${todoJudge} 题等你审核`}
            </p>
            <span className="text-xs font-bold text-white/90">去处理 →</span>
          </button>
        )}

        {/* 盲盒待开条：有纪念日盲盒时显示（新建账号组已停用盲盒） */}
        {isDefault && boxCount > 0 && (
          <button
            onClick={() => setBoxOpen(true)}
            className="mb-4 flex w-full items-center gap-2.5 rounded-2xl bg-gradient-to-r from-amber-400/90 to-orange-400/90 px-4 py-3 text-left shadow-lg shadow-amber-200 transition-transform active:scale-[0.98]"
          >
            <Gift className="h-4 w-4 shrink-0 animate-bounce text-white" />
            <p className="flex-1 text-xs font-medium text-white">
              有 {boxCount} 个纪念日盲盒待开启
            </p>
            <span className="text-xs font-bold text-white/90">开盲盒 →</span>
          </button>
        )}

        {/* 六个功能位：见闻打分 / 默契挑战 / 开心农场 / 打卡地图，其余预留 */}
        <div className="grid grid-cols-2 gap-4">
          <button
            onClick={onOpenRatings}
            className="glass-card relative flex h-28 flex-col items-center justify-center gap-2 rounded-2xl ring-1 ring-rose-200/50 transition-transform active:scale-95"
          >
            {unrated > 0 && (
              <span className="absolute -top-1.5 -right-1.5 flex h-6 min-w-6 items-center justify-center rounded-full bg-red-500 px-1.5 text-[11px] font-bold text-white ring-2 ring-white">
                {unrated > 99 ? '99+' : unrated}
              </span>
            )}
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-pink-400 to-rose-400 shadow-md shadow-pink-200">
              <Star className="h-5 w-5 fill-white text-white" />
            </div>
            <p className="text-sm font-semibold text-[#c44d7d]">见闻打分</p>
          </button>

          <button
            onClick={onOpenAsk}
            className="glass-card relative flex h-28 flex-col items-center justify-center gap-2 rounded-2xl ring-1 ring-amber-200/60 transition-transform active:scale-95"
          >
            {todoTotal + wishApproveCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 flex h-6 min-w-6 items-center justify-center rounded-full bg-red-500 px-1.5 text-[11px] font-bold text-white ring-2 ring-white">
                {todoTotal + wishApproveCount > 99 ? '99+' : todoTotal + wishApproveCount}
              </span>
            )}
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-yellow-500 text-lg shadow-md shadow-amber-200">
              ✨
            </div>
            <p className="text-sm font-semibold text-[#c44d7d]">许愿池</p>
          </button>

          <button
            onClick={onOpenQuiz}
            className="glass-card flex h-28 flex-col items-center justify-center gap-2 rounded-2xl ring-1 ring-violet-200/50 transition-transform active:scale-95"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-violet-400 to-fuchsia-400 shadow-md shadow-violet-200">
              <Sparkles className="h-5 w-5 text-white" />
            </div>
            <p className="text-sm font-semibold text-[#c44d7d]">默契挑战</p>
          </button>

          <button
            onClick={onOpenFarm}
            className="glass-card relative flex h-28 flex-col items-center justify-center gap-2 rounded-2xl ring-1 ring-emerald-200/50 transition-transform active:scale-95"
          >
            {hasMature && (
              <span className="absolute -top-1 -right-1 h-3.5 w-3.5 animate-pulse rounded-full bg-red-500 ring-2 ring-white" />
            )}
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-lime-500 text-lg shadow-md shadow-emerald-200">
              🌱
            </div>
            <p className="text-sm font-semibold text-[#c44d7d]">开心农场</p>
          </button>

          {/* 打卡地图暂时隐藏（2026-09-16 用户要求先不用了），保留入口逻辑不删 */}
          {false && (
          <button
            onClick={onOpenMap}
            className="glass-card flex h-28 flex-col items-center justify-center gap-2 rounded-2xl ring-1 ring-sky-200/50 transition-transform active:scale-95"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-sky-400 to-cyan-500 shadow-md shadow-sky-200">
              <MapPinned className="h-5 w-5 text-white" />
            </div>
            <p className="text-sm font-semibold text-[#c44d7d]">打卡地图</p>
            <p className="text-xs text-pink-300">走到哪 · 记到哪</p>
          </button>
          )}

          <button
            onClick={onOpenWishShop}
            className="glass-card relative flex h-28 flex-col items-center justify-center gap-2 rounded-2xl ring-1 ring-orange-200/50 transition-transform active:scale-95"
          >
            {wishConfirmCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 flex h-6 min-w-6 items-center justify-center rounded-full bg-red-500 px-1.5 text-[11px] font-bold text-white ring-2 ring-white">
                {wishConfirmCount > 99 ? '99+' : wishConfirmCount}
              </span>
            )}
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-orange-500 shadow-md shadow-amber-200">
              <Gift className="h-5 w-5 text-white" />
            </div>
            <p className="text-sm font-semibold text-[#c44d7d]">心愿商店</p>
          </button>

          <button
            onClick={onOpenStory}
            className="glass-card flex h-28 flex-col items-center justify-center gap-2 rounded-2xl ring-1 ring-purple-200/50 transition-transform active:scale-95"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-indigo-400 to-purple-500 shadow-md shadow-indigo-200">
              <BookOpen className="h-5 w-5 text-white" />
            </div>
            <p className="text-sm font-semibold text-[#c44d7d]">剧情工坊</p>
          </button>

          <button
            onClick={onOpenMemoir}
            className="glass-card flex h-28 flex-col items-center justify-center gap-2 rounded-2xl ring-1 ring-rose-200/50 transition-transform active:scale-95"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-rose-400 to-pink-500 shadow-md shadow-rose-200">
              <BookHeart className="h-5 w-5 text-white" />
            </div>
            <p className="text-sm font-semibold text-[#c44d7d]">回忆录</p>
          </button>

          <button
            onClick={onOpenWhisper}
            className="glass-card flex h-28 flex-col items-center justify-center gap-2 rounded-2xl ring-1 ring-fuchsia-200/50 transition-transform active:scale-95"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-pink-400 to-rose-400 shadow-md shadow-pink-200">
              <MessageCircleHeart className="h-5 w-5 text-white" />
            </div>
            <p className="text-sm font-semibold text-[#c44d7d]">悄悄话</p>
          </button>

          <button
            onClick={onOpenJade}
            className="glass-card flex h-28 flex-col items-center justify-center gap-2 rounded-2xl ring-1 ring-teal-200/50 transition-transform active:scale-95"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 shadow-md shadow-emerald-200 text-lg">
              🪨
            </div>
            <p className="text-sm font-semibold text-[#c44d7d]">玉石鉴定</p>
          </button>

          <button
            onClick={onOpenAuction}
            className="glass-card flex h-28 flex-col items-center justify-center gap-2 rounded-2xl ring-1 ring-amber-200/60 transition-transform active:scale-95"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-amber-500 to-yellow-600 shadow-md shadow-amber-200 text-lg">
              🔨
            </div>
            <p className="text-sm font-semibold text-[#c44d7d]">玉缘拍卖会</p>
          </button>

          <button
            onClick={onOpenStock}
            className="glass-card flex h-28 flex-col items-center justify-center gap-2 rounded-2xl ring-1 ring-red-200/40 transition-transform active:scale-95"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-red-500 to-rose-600 shadow-md shadow-red-200">
              <TrendingUp className="h-5 w-5 text-white" />
            </div>
            <p className="text-sm font-semibold text-[#c44d7d]">时元股交所</p>
          </button>

          <button
            onClick={onOpenDrawGuess}
            className="glass-card col-span-2 flex h-20 items-center justify-center gap-3 rounded-2xl ring-1 ring-violet-200/50 transition-transform active:scale-95"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-400 to-fuchsia-400 shadow-md shadow-violet-200">
              <Palette className="h-5 w-5 text-white" />
            </div>
            <p className="text-sm font-semibold text-[#c44d7d]">你画我猜</p>
          </button>
        </div>

        {/* 退出登录 + ICP：收束带，让页面"关得上"（通栏出血） */}
        <div className="-mx-6 mt-12 rounded-t-[32px] border-t border-[#efb4cf] bg-gradient-to-b from-transparent to-[#f2c9de] px-6 pb-8 pt-8">
          <button
            onClick={onLogout}
            className="mx-auto flex items-center gap-1.5 text-xs tracking-widest text-[#c44d7d]/70 transition-colors active:text-pink-500"
          >
            <LogOut className="h-3.5 w-3.5" />
            退出登录
          </button>

          {/* ICP 备案号（配置 VITE_ICP 提供；留空则不显示，中国大陆自建站才需要） */}
          {ICP && (
            <p className="mt-4 text-center">
              <a
                href="https://beian.miit.gov.cn"
                target="_blank"
                rel="noreferrer"
                className="text-[10px] tracking-wider text-[#c44d7d]/45"
              >
                {ICP}
              </a>
            </p>
          )}
        </div>
      </div>

      {/* 头像框商店 */}
      {framesOpen && (
        <FramesModal
          user={user}
          avatar={avatars[user.name] ?? user.avatar}
          balance={balanceOf(user.name)}
          onAvatarChange={() => {
            // 头像更新后会通过订阅自动同步，不需要额外处理
          }}
          onClose={() => setFramesOpen(false)}
        />
      )}

      {/* 纪念日盲盒弹窗（新建账号组不挂载：连订阅都省掉） */}
      {isDefault && (
        <BlindBoxModal
          open={boxOpen}
          onClose={() => setBoxOpen(false)}
          user={user}
          days={days}
          treeExp={treeTotal}
          warehouseCount={warehouseCount}
          balance={balanceOf(user.name)}
          dexCount={myFarm.dex?.length ?? 0}
          dexTotal={DEX_TOTAL}
        />
      )}



      {/* 在一起时间设置弹窗（新建账号组：双方自己定，保存后同步给对方） */}
      {timeEditing && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-8 backdrop-blur-sm">
          <div className="w-full max-w-xs rounded-3xl bg-white p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <span className="text-sm font-bold tracking-widest text-[#c44d7d]">在一起的时间</span>
              <button
                type="button"
                onClick={() => setTimeEditing(false)}
                className="rounded-full p-1 text-gray-400 transition-colors hover:bg-gray-100"
                title="关闭"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <label className="mb-1.5 block text-xs font-semibold text-[#8a4a68]">日期</label>
            <input
              type="date"
              value={draftDate}
              onChange={(e) => setDraftDate(e.target.value)}
              className="mb-3 w-full rounded-2xl border border-pink-200 bg-pink-50/60 px-3 py-2.5 text-sm text-[#5c3a52] outline-none focus:border-pink-400"
            />
            <label className="mb-1.5 block text-xs font-semibold text-[#8a4a68]">时间</label>
            <input
              type="time"
              value={draftTime}
              onChange={(e) => setDraftTime(e.target.value)}
              className="mb-4 w-full rounded-2xl border border-pink-200 bg-pink-50/60 px-3 py-2.5 text-sm text-[#5c3a52] outline-none focus:border-pink-400"
            />
            <button
              type="button"
              onClick={() => {
                const d = new Date()
                setDraftDate(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`)
                setDraftTime(`${pad2(d.getHours())}:${pad2(d.getMinutes())}`)
              }}
              className="mb-4 w-full rounded-2xl border border-dashed border-pink-300 bg-pink-50/40 py-2 text-xs font-semibold text-[#c44d7d] transition-colors active:scale-95"
            >
              填成现在这一刻
            </button>
            <button
              type="button"
              onClick={saveLoveTime}
              className="w-full rounded-2xl bg-gradient-to-r from-pink-400 to-rose-400 py-3 text-sm font-semibold text-white shadow-lg shadow-pink-200 transition-all active:scale-95"
            >
              保存
            </button>
          </div>
        </div>
      )}

      {/* 秘密空间密码门弹窗 */}
      {gateOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-8 backdrop-blur-sm">
          <div className="w-full max-w-xs rounded-3xl bg-white p-6 shadow-2xl">
            <div className="mb-5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Lock className="h-4 w-4 text-[#c44d7d]" />
                <span className="text-sm font-bold tracking-widest text-[#c44d7d]">秘密空间</span>
              </div>
              <button
                onClick={() => {
                  setGateOpen(false)
                  setGatePwd('')
                  setGateError(false)
                }}
                className="text-pink-300 transition-colors active:text-pink-500"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <p className="mb-4 text-center text-xs leading-relaxed text-pink-400">
              请输入 {user.name} 的登录密码进入
            </p>

            <input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={8}
              autoFocus
              value={gatePwd}
              onChange={(e) => {
                setGatePwd(e.target.value)
                setGateError(false)
              }}
              onKeyDown={(e) => e.key === 'Enter' && tryUnlock()}
              placeholder="密码"
              className="mb-3 w-full rounded-2xl border border-pink-200 bg-pink-50/60 px-4 py-3 text-center text-lg tracking-[0.4em] text-[#8a4a68] outline-none placeholder:text-sm placeholder:tracking-normal placeholder:text-pink-300 focus:border-pink-400 focus:bg-white"
            />

            {gateError && <p className="mb-3 text-center text-xs text-red-400">密码不对哦</p>}

            <button
              onClick={tryUnlock}
              className="w-full rounded-2xl bg-gradient-to-r from-pink-400 to-rose-400 py-3 text-sm font-semibold text-white shadow-lg shadow-pink-200 transition-all active:scale-95"
            >
              开启
            </button>
          </div>
        </div>
      )}

      <style>{`
        @keyframes beat {
          0%, 100% { transform: scale(1); }
          25% { transform: scale(1.25); }
          40% { transform: scale(1); }
          60% { transform: scale(1.18); }
        }
        @keyframes dmk-drift {
          from { transform: translateX(0); opacity: 0.95; }
          6% { opacity: 1; }
          90% { opacity: 1; }
          to { transform: translateX(calc(-100vw - 100%)); opacity: 0.85; }
        }
        @keyframes dmk-in {
          from { opacity: 0; transform: translateY(-6px); }
          to { opacity: 1; transform: none; }
        }
        @keyframes cat-bob {
          0%, 100% { transform: translateY(0) rotate(-2deg); }
          50% { transform: translateY(-7px) rotate(2deg); }
        }
        @keyframes cat-wiggle {
          0%, 100% { transform: rotate(-6deg); }
          25% { transform: rotate(6deg) scale(1.06); }
          50% { transform: rotate(-6deg); }
          75% { transform: rotate(6deg); }
        }
      `}</style>

      {/* ===== 悄悄话 · 主页实时弹幕（2026-10-20）===== */}

      {/* 对方正在打的字：顶部实时浮现的输入条 */}
      {liveDraft && (
        <div className="pointer-events-none fixed inset-x-0 top-[104px] z-40 flex justify-center">
          <div
            className="flex max-w-[86%] items-center gap-1.5 rounded-full bg-white/30 px-3.5 py-1.5 backdrop-blur-md"
            style={{ animation: 'dmk-in .25s ease' }}
          >
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-white/95" />
            <span className="shrink-0 text-[11px] font-black tracking-wide" style={{ color: dmkColor(liveDraft.who) }}>{liveDraft.who}</span>
            <span className="min-w-0 truncate text-[11px] font-medium text-white/95 drop-shadow">{liveDraft.text}</span>
            <span className="shrink-0 animate-pulse text-xs text-white/75">✎</span>
          </div>
        </div>
      )}

      {/* 正式发言 → 飘屏弹幕（自右向左，飘完自动回收） */}
      {dmks.map((d) => (
        <div
          key={d.key}
          onAnimationEnd={() => setDmks((old) => old.filter((x) => x.key !== d.key))}
          className="pointer-events-none fixed left-full z-40 flex items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-1.5 shadow-md shadow-pink-200/60"
          style={{
            top: `${[38, 46, 54][d.lane]}dvh`,
            animation: `dmk-drift ${d.dur}s linear forwards`,
            background: d.mine ? 'rgba(255,255,255,0.92)' : 'rgba(255,214,232,0.95)',
          }}
        >
          <span className="shrink-0 text-[10px] font-black tracking-wide" style={{ color: dmkColor(d.who) }}>{d.who}</span>
          <span className="max-w-[58vw] truncate text-xs font-medium text-[#5c3a52]">{d.text}</span>
        </div>
      ))}

      {/* 打开输入框时才出现胶囊；平时只有狸花猫挂件蹲在屏幕上 */}
      {!guestView && !whisperOpen && (
        <button
          onPointerDown={onCatDown}
          onPointerMove={onCatMove}
          onPointerUp={onCatUp}
          onPointerCancel={onCatUp}
          onTouchEnd={onCatTouchEnd}
          onClick={onCatClick}
          onContextMenu={(e) => e.preventDefault()}
          aria-label="说句悄悄话"
          className="fixed z-40 h-16 w-16 touch-none select-none active:scale-90 transition-transform"
          style={{ left: catPos.x, top: catPos.y }}
        >
          <img
            src={lihuaCat}
            alt=""
            draggable={false}
            className="h-16 w-16 drop-shadow-lg"
            style={{ animation: liveDraft ? 'cat-wiggle .7s ease-in-out infinite' : 'cat-bob 3s ease-in-out infinite' }}
          />
        </button>
      )}
      {!guestView && whisperOpen && (
        <div className={`fixed bottom-5 z-40 flex ${user.name === ADMIN_NAME ? 'left-4 right-[5.5rem]' : 'left-4 right-4'}`}>
          <div className={`flex w-full items-center gap-2.5 rounded-full bg-white/85 px-3 py-2.5 shadow-lg shadow-pink-200/70 ring-1 ${sendFailed ? 'ring-red-300' : 'ring-pink-200/70'} backdrop-blur transition-shadow`}>
            <button
              onClick={closeWhisper}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-pink-100 text-[#b0678c] shadow-sm transition-transform active:scale-90"
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <input
              ref={whisperInputRef}
              value={whisperInput}
              onChange={onWhisperChange}
              onKeyDown={(e) => { if (e.key === 'Enter') whisperSend(); else if (e.key === 'Escape') closeWhisper() }}
              maxLength={120}
              placeholder="说句悄悄话…"
              className="min-w-0 flex-1 bg-transparent text-sm text-[#5c3a52] outline-none placeholder:text-pink-300"
            />
            <button
              onClick={whisperSend}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-r from-pink-400 to-rose-400 text-white shadow active:scale-95"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* 管理入口：只有管理员可见 */}
      {user.name === ADMIN_NAME && (
        <button
          onClick={onOpenAdmin}
          className="fixed bottom-6 right-6 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-r from-purple-400 to-pink-400 text-white shadow-lg shadow-purple-200 transition-transform active:scale-95 z-50"
        >
          <Users className="h-6 w-6" />
        </button>
      )}

    </div>
  )
}
