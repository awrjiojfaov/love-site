// 示例脚本：把默认空间的樱花树总经验强制写入一个指定值（两人平分终身贡献）。
// 用途：公共 broker 的 retained 被清空、云端账本丢失后的一次性找回。
// 使用前把 TOTAL 改成你要恢复的经验值（下面用 1000 作示例），并确认 TOPIC 前缀。
import mqtt from 'mqtt'

const TOPIC = 'lovesite/tree/state'
const TOTAL = 1000
const PER = TOTAL / 2

const client = mqtt.connect('wss://broker.emqx.io:8084/mqtt', {
  clientId: `restore-tree-${Math.random().toString(16).slice(2, 10)}`,
  connectTimeout: 15000,
})

const timer = setTimeout(() => {
  console.log('TIMEOUT: 没收到云端保留消息，按空白状态直接写入')
  publish(null)
}, 10000)

let done = false

function publish(current) {
  if (done) return
  done = true
  clearTimeout(timer)
  const base = current && typeof current === 'object' ? current : {}
  const state = {
    total: TOTAL,
    day: typeof base.day === 'string' ? base.day : '',
    dayBy: base.dayBy && typeof base.dayBy === 'object' ? base.dayBy : {},
    loginDay: base.loginDay && typeof base.loginDay === 'object' ? base.loginDay : {},
    contrib: { 成员A: PER, 成员B: PER },
    v: Date.now(),
  }
  client.publish(TOPIC, JSON.stringify(state), { retain: true, qos: 1 }, () => {
    console.log('已恢复樱花树：total=' + TOTAL + ', contrib=', JSON.stringify(state.contrib), 'v=', state.v)
    client.end()
    process.exit(0)
  })
}

client.on('connect', () => {
  console.log('connected')
  client.subscribe(TOPIC, { qos: 1 })
})

client.on('message', (topic, payload) => {
  const s = payload.toString()
  if (!s) return
  try {
    const parsed = JSON.parse(s)
    console.log('当前云端状态：total=', parsed.total, 'contrib=', JSON.stringify(parsed.contrib), 'v=', parsed.v)
    publish(parsed)
  } catch {
    publish(null)
  }
})

client.on('error', (e) => {
  console.log('error:', e.message)
  clearTimeout(timer)
  process.exit(1)
})
