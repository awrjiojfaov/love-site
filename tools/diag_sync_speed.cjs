// 一次性诊断：量各主题 retained 体积 + 小消息端到端延迟 + 大包是否堵住快车道
// 用法: node tools/diag_sync_speed.cjs
const fs = require('fs')
const path = require('path')
const mqtt = require('mqtt')

const envPath = path.join(__dirname, '..', '.env.local')
const env = {}
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
  if (m) env[m[1]] = m[2]
}
const PREFIX = env.VITE_TOPIC_PREFIX || 'lovesite/'
const URL = env.VITE_MQTT_PRIMARY_URL
const USER = env.VITE_MQTT_PRIMARY_USER
const PASS = env.VITE_MQTT_PRIMARY_PASS
if (!URL) { console.log('缺少 VITE_MQTT_PRIMARY_URL'); process.exit(1) }

const c = mqtt.connect(URL, {
  username: USER || undefined,
  password: PASS || undefined,
  connectTimeout: 12000,
  reconnectPeriod: 0,
  protocolVersion: 5,
  clientId: 'diag-' + Math.random().toString(16).slice(2, 8),
})

const seen = new Map()
let t0 = 0

c.on('connect', () => {
  console.log('已连接:', URL)
  console.log('主题前缀:', PREFIX)
  c.subscribe(PREFIX + '#', { qos: 0 })
  t0 = Date.now()
  setTimeout(report, 9000)
})

c.on('message', (topic, payload) => {
  if (topic.endsWith('/__probe')) {
    const t = Number(payload.toString().split('|')[1])
    probeLatency.push(Date.now() - t)
    return
  }
  seen.set(topic, { bytes: payload.length, at: Date.now(), payload })
})

function report() {
  console.log('\n===== 各主题 retained 体积（9 秒内收到） =====')
  const rows = [...seen.entries()].sort((a, b) => b[1].bytes - a[1].bytes)
  let total = 0
  for (const [t, v] of rows) {
    total += v.bytes
    const kb = (v.bytes / 1024).toFixed(1)
    console.log(`  ${kb.padStart(8)} KB  ${t.replace(PREFIX, '')}`)
  }
  console.log(`  合计 ${(total / 1024).toFixed(1)} KB / ${rows.length} 个主题`)

  console.log('\n===== 关键状态内容 =====')
  for (const key of ['wallet/state', 'auction/state', 'jade/state', 'farm/state', 'ask/state']) {
    const v = seen.get(PREFIX + key)
    if (!v) { console.log(`  ${key}: 无`); continue }
    try {
      const s = JSON.parse(v.payload.toString())
      console.log(`  ${key}: v=${s.v} t=${s.t ? new Date(s.t).toLocaleString('zh-CN') : '-'} ` +
        `tx=${(s.tx || []).length} session=${s.session ? s.session.status + '/' + s.session.id : '-'} ` +
        `lots=${s.session ? Object.keys(s.session.lots || {}).length : '-'} ` +
        `held=${Object.keys(s.heldVault || {}).length} archives=${Object.keys(s.archives || {}).length}`)
    } catch (e) { console.log(`  ${key}: 解析失败 ${e.message}`) }
  }

  // ---- 延迟测量 ----
  const probeTopic = PREFIX + '__probe'
  c.subscribe(probeTopic, { qos: 0 }, () => {
    console.log('\n===== 延迟测量（本机 → broker → 本机） =====')
    let i = 0
    const N = 15
    const send = () => {
      if (i++ >= N) { bigTest(); return }
      c.publish(probeTopic, `p${i}|${Date.now()}`, { qos: 1, retain: false })
      setTimeout(send, 120)
    }
    setTimeout(send, 300)
  })
}

let probeLatency = []
function stats(arr) {
  if (!arr.length) return '无数据'
  const s = [...arr].sort((a, b) => a - b)
  const avg = Math.round(arr.reduce((x, y) => x + y, 0) / arr.length)
  return `min=${s[0]}ms 中位=${s[Math.floor(s.length / 2)]}ms 平均=${avg}ms max=${s[s.length - 1]}ms (n=${arr.length})`
}

function bigTest() {
  console.log('  小消息（~20B）:', stats(probeLatency))
  // 大包阻塞测试：先发一个 700KB，紧跟着发小包，看小包被推迟多久
  const probeTopic = PREFIX + '__probe'
  probeLatency = []
  const big = JSON.stringify({ pad: 'x'.repeat(700 * 1024) })
  console.log('  发送 700KB 大包后紧接 8 个小包…')
  c.publish(PREFIX + '__bigprobe', big, { qos: 1, retain: false })
  let i = 0
  const send = () => {
    if (i++ >= 8) { setTimeout(finish, 3000); return }
    c.publish(probeTopic, `b${i}|${Date.now()}`, { qos: 1, retain: false })
    setTimeout(send, 60)
  }
  send()
}

function finish() {
  console.log('  大包后的小消息:', stats(probeLatency))
  console.log('\n（大包后小包明显变慢 = 队头阻塞；自建 broker 上行 4M 是硬瓶颈）')
  c.end(true)
  process.exit(0)
}

setTimeout(() => { console.log('TIMEOUT'); process.exit(2) }, 60000)
