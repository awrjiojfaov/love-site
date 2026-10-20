/**
 * 花园停用（歇园）云端同步：共享 MQTT 连接，独立主题。
 * - 只有管理员（昵称见配置 VITE_ADMIN_NAME）可以停用 / 解封，另一位成员只接收状态
 * - 停用后全站所有人不可用，直到管理员解封
 * - 单一写入者 + 版本号守卫，latest wins；本地备份防止重启闪烁
 */
import { sharedPublish, sharedSubscribe, onSharedConnect } from './mqttClient'
import { ADMIN_NAME } from '../config'

const TOPIC = 'lovesite/lockdown/state'
/** 求援频道：没拿到云端状态的设备在这里喊一声，持有最新状态的设备原样重发 */
const TOPIC_REQ = 'lovesite/lockdown/req'
const LS_KEY = 'lovesite-lockdown-backup'

/** 唯一有权限停用/解封的人（管理员） */
export const GARDEN_KEEPER = ADMIN_NAME

export type LockdownState = {
  locked: boolean
  /** 操作人（总是管理员） */
  by: string
  /** 操作时间 */
  ts: number
}

type State = LockdownState & { v: number }

let initialized = false
let state: LockdownState = { locked: false, by: '', ts: 0 }
let lastV = 0
let stateReceived = false
let subscribers: Array<(s: LockdownState) => void> = []

function loadBackup(): State | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as State
    if (typeof parsed.locked !== 'boolean') return null
    return parsed
  } catch {
    return null
  }
}

function saveBackup() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ ...state, v: lastV }))
  } catch {
    /* ignore */
  }
}

function notify() {
  subscribers.forEach((cb) => cb({ ...state }))
}

function publishState() {
  const v = Date.now()
  lastV = v
  sharedPublish(TOPIC, JSON.stringify({ ...state, v } satisfies State))
}

/** 原样重发当前状态（版本号不变）：用于自愈/应答求援。
 *  绝不加新版本号——旧状态不会顶掉别处更新的真实状态，版本守卫会把它拦下 */
function republishCurrent() {
  if (lastV <= 0) return
  sharedPublish(TOPIC, JSON.stringify({ ...state, v: lastV } satisfies State))
}

function ensureClient() {
  if (initialized) return
  initialized = true

  const backup = loadBackup()
  if (backup) {
    state = { locked: backup.locked, by: backup.by ?? '', ts: backup.ts ?? 0 }
    lastV = backup.v ?? 0
  }

  sharedSubscribe(TOPIC, (payload) => {
    if (payload.length === 0) return
    try {
      const parsed = JSON.parse(payload.toString()) as State
      if (typeof parsed.locked !== 'boolean') return
      const pv = parsed.v ?? 0
      if (pv <= lastV) {
        stateReceived = true
        // 云端落后于本地就回发自愈（不限于本会话首次收包）：
        // 否则陈旧 retained（如别的设备用过期备份回补的"已关闭"）会永久卡住另一端
        if (pv < lastV) publishState()
        return
      }
      lastV = pv
      stateReceived = true
      state = { locked: parsed.locked, by: parsed.by ?? '', ts: parsed.ts ?? 0 }
      saveBackup()
      notify()
    } catch {
      /* ignore */
    }
  })

  // 求援应答：任何持有状态的设备原样重发（版本号不变），版本守卫保证收敛到最新
  sharedSubscribe(TOPIC_REQ, () => {
    if (lastV > 0) republishCurrent()
  })

  onSharedConnect(() => {
    // 3 秒没收到云端状态：原样重发本地状态（修空 retained）+ 发求援（拉别人手里的最新）；
    // 7 秒再求援一次，覆盖"对方晚几秒才上线"的情况
    setTimeout(() => {
      if (!stateReceived) {
        stateReceived = true
        republishCurrent()
        sharedPublish(TOPIC_REQ, String(Date.now()), false)
        setTimeout(() => {
          sharedPublish(TOPIC_REQ, String(Date.now()), false)
        }, 4000)
      }
    }, 3000)
  })
}

/** 订阅停用状态；返回取消订阅函数 */
export function subscribeLockdown(onData: (s: LockdownState) => void): () => void {
  subscribers.push(onData)
  ensureClient()
  onData({ ...state })
  return () => {
    subscribers = subscribers.filter((cb) => cb !== onData)
  }
}

/** 停用 / 解封。只有管理员有权操作，其他人调用直接拒绝。 */
export function setGardenLocked(who: string, locked: boolean): boolean {
  ensureClient()
  if (who !== GARDEN_KEEPER) return false
  if (state.locked === locked) return true
  state = { locked, by: who, ts: Date.now() }
  publishState()
  saveBackup()
  notify()
  return true
}
