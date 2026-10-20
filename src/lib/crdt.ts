/**
 * CRDT 同步层（Yjs over MQTT）——全站通用文档同步。
 * 2026-10-05 随存钱罐模块首验引入；跑通后逐步替换各模块的
 * 「lastV 版本守卫 + 按 id 合并 + 删除墓碑」手工三件套。
 *
 * 协议设计（为什么 retained 一条消息就够）：
 * - 每次变更发布「全量快照」encodeStateAsUpdate(doc)，retained 只留最新一份，
 *   新设备订阅即得完整状态；Yjs update 幂等可重放，本地快照与云端 retained 谁先到都行。
 * - 反熵：收到远端更新后比对 state vector，若带来了本地没有的操作，合并完成自动回发
 *   全量快照——两台设备离线各改各的，重连后各自合并、各自回发，最终一致，无需 lastV。
 * - 可靠性全部委托 mqttClient：断线 outbox 暂存、puback 重试、跨 broker 故障转移，
 *   本层不重复造轮子。
 * - 快照同时落 localStorage（space.ts 补丁已按数据空间隔离键名），首屏零等待。
 *
 * 将来数据量大的模块（回忆录 / 农场）可升级为「增量 update + 定期快照压实」模式，
 * provider 接口不变。
 */
import * as Y from 'yjs'
import { sharedSubscribe, sharedPublish, sharedResync, onSharedConnect } from './mqttClient'

function topicFor(name: string): string {
  return `lovesite/crdt/${name}`
}
function lsKeyFor(name: string): string {
  return `lovesite-crdt-${name}`
}

function u8ToB64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}
function b64ToU8(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

interface DocEntry {
  doc: Y.Doc
  topic: string
  lsKey: string
  publishTimer: ReturnType<typeof setTimeout> | null
  /** 收到远端新内容后待回发的反熵标记 */
  republishPending: boolean
}

const entries = new Map<string, DocEntry>()

function saveSnapshot(e: DocEntry) {
  try {
    localStorage.setItem(e.lsKey, u8ToB64(Y.encodeStateAsUpdate(e.doc)))
  } catch {
    /* ignore */
  }
}

function publishNow(e: DocEntry) {
  e.republishPending = false
  saveSnapshot(e)
  sharedPublish(e.topic, u8ToB64(Y.encodeStateAsUpdate(e.doc)), true)
}

/** 300ms 防抖合并连续编辑；离线时 outbox 只留最新一份全量，天然去重 */
function schedulePublish(e: DocEntry) {
  if (e.publishTimer) return
  e.publishTimer = setTimeout(() => {
    e.publishTimer = null
    publishNow(e)
  }, 300)
}

/**
 * 按名字打开（或复用）一份 CRDT 文档。
 * 同一页面生命周期内同名文档全局唯一，多模块/多组件可安全重复调用。
 */
export function getCrdtDoc(name: string): Y.Doc {
  let e = entries.get(name)
  if (e) return e.doc
  const doc = new Y.Doc()
  e = { doc, topic: topicFor(name), lsKey: lsKeyFor(name), publishTimer: null, republishPending: false }
  entries.set(name, e)

  // 本地快照先行：立刻恢复上次状态用于首屏渲染；云端 retained 到了再合并（幂等）
  try {
    const snap = localStorage.getItem(e.lsKey)
    if (snap) Y.applyUpdate(doc, b64ToU8(snap), 'local-snapshot')
  } catch {
    /* ignore */
  }

  sharedSubscribe(e.topic, (payload) => {
    if (payload.length === 0) return
    try {
      const before = Y.encodeStateVector(doc)
      Y.applyUpdate(doc, b64ToU8(payload.toString()), 'remote')
      // 反熵：远端更新若带来了本地没有的操作（state vector 有变化），
      // 合并后回发全量快照，让对方也补齐——回声会在两端状态一致后自然停止
      if (!bytesEqual(before, Y.encodeStateVector(doc))) {
        e.republishPending = true
        schedulePublish(e)
      }
    } catch {
      /* 非法 payload 忽略 */
    }
  })

  doc.on('update', (_update: Uint8Array, origin: unknown) => {
    saveSnapshot(e)
    // remote：对方内容；local-snapshot：本地恢复——两者都不触发回发，防回声风暴
    if (origin === 'remote' || origin === 'local-snapshot') return
    schedulePublish(e)
  })

  onSharedConnect(() => {
    // 重连必须主动拉一次 retained：持久会话 + QoS0 订阅下，断线期间对方发的更新
    // 既不会重投、也不会因会话还在而触发 retained 重发——不拉就永远错过。
    // 这里刻意不挪到 onSharedResync 门控：CRDT 的反熵只能「收到新内容才回发」，
    // 拉不到就补不了；且目前只有存钱罐在用，快照几 KB，代价可忽略
    sharedResync(e.topic)
    if (e.republishPending) schedulePublish(e)
  })

  return doc
}
