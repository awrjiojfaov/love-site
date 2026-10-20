// 一次性：查看树主题 retained 状态（可指定 broker 序号）
const mqtt = require('mqtt')
const TOPIC = 'lovesite/tree/state'
const BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
]
const idx = Number(process.argv[2] ?? 0)
const c = mqtt.connect(BROKERS[idx], { reconnectPeriod: 0, connectTimeout: 15000 })
const done = (code) => { try { c.end() } catch {} ; process.exit(code) }
setTimeout(() => { console.log('TIMEOUT'); done(2) }, 25000)
c.on('connect', () => {
  console.log('connected:', BROKERS[idx])
  c.subscribe(TOPIC)
})
c.on('message', (t, payload) => {
  if (t !== TOPIC) return
  console.log('RECEIVED bytes:', payload.length)
  if (payload.length === 0) { console.log('EMPTY RETAINED'); done(1) }
  try {
    const s = JSON.parse(payload.toString())
    console.log(JSON.stringify({ total: s.total, day: s.day, dayBy: s.dayBy, loginDay: s.loginDay, contrib: s.contrib, v: s.v }))
    done(0)
  } catch (e) { console.log('parse err', e.message); done(2) }
})
c.on('error', (e) => { console.log('conn error:', e.message); done(2) })
