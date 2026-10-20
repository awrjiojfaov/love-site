// 示例脚本：向多个 broker 双写一份「账本保底」状态。
// 用途：多个 broker 的 retained 互相分叉、低值会把高值刷没时的一次性找回。
// 使用前把 CONTRIB 改成你要保底的值（下面用 1000 / 1000 作示例），并确认 TOPIC 前缀。
const mqtt = require('mqtt')
const TOPIC = 'lovesite/tree/state'
const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt']

// 保底账本：只增不减，任何设备合并时按人取最大，不会与自然增长冲突
const CONTRIB = { 成员A: 1000, 成员B: 1000 }

function readState(broker) {
  return new Promise((resolve) => {
    const c = mqtt.connect(broker, { reconnectPeriod: 0, connectTimeout: 12000 })
    const timer = setTimeout(() => { try { c.end() } catch {} ; resolve(null) }, 20000)
    c.on('connect', () => c.subscribe(TOPIC))
    c.on('message', (t, payload) => {
      if (t !== TOPIC) return
      clearTimeout(timer)
      try { c.end() } catch {}
      if (payload.length === 0) return resolve({})
      try { resolve(JSON.parse(payload.toString())) } catch { resolve({}) }
    })
    c.on('error', () => { clearTimeout(timer); try { c.end() } catch {} ; resolve(null) })
  })
}

function writeState(broker, state) {
  return new Promise((resolve) => {
    const c = mqtt.connect(broker, { reconnectPeriod: 0, connectTimeout: 12000 })
    const timer = setTimeout(() => { try { c.end() } catch {} ; resolve(false) }, 20000)
    c.on('connect', () => {
      c.publish(TOPIC, JSON.stringify(state), { retain: true, qos: 1 }, (err) => {
        clearTimeout(timer)
        try { c.end() } catch {}
        resolve(!err)
      })
    })
    c.on('error', () => { clearTimeout(timer); try { c.end() } catch {} ; resolve(false) })
  })
}

;(async () => {
  // 以 emqx（主 broker）现有状态为底：保住"今日已登录/已用额度"的记录，避免重复领登录经验
  const base = (await readState(BROKERS[0])) ?? (await readState(BROKERS[1])) ?? {}
  const now = Date.now()
  const state = {
    total: Object.values(CONTRIB).reduce((a, b) => a + b, 0),
    day: base.day ?? '',
    dayBy: base.dayBy ?? {},
    loginDay: base.loginDay ?? {},
    contrib: CONTRIB,
    v: now + 1, // +1 确保大于任何刚发的包，所有设备都会收账
  }
  console.log('target state:', JSON.stringify(state))
  for (const b of BROKERS) {
    const ok = await writeState(b, state)
    console.log(ok ? 'PUBLISHED ok  ' : 'PUBLISH FAIL', b)
  }
  process.exit(0)
})()
