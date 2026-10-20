// 一次性诊断：查看多个 retained 主题是否完好
const mqtt = require('mqtt')
const TOPICS = [
  'lovesite/farm/state',
  'lovesite/wallet/state',
]
const BROKERS = ['wss://broker.emqx.io:8084/mqtt']
const c = mqtt.connect(BROKERS[0], { reconnectPeriod: 0, connectTimeout: 15000 })
const done = (code) => { try { c.end() } catch {} ; process.exit(code) }
setTimeout(() => { console.log('TIMEOUT'); done(2) }, 25000)
c.on('connect', () => {
  TOPICS.forEach((t) => c.subscribe(t))
})
c.on('message', (t, payload) => {
  const i = TOPICS.indexOf(t)
  if (i < 0) return
  console.log(`--- ${t} : ${payload.length} bytes`)
  if (payload.length > 0) {
    try {
      const s = JSON.parse(payload.toString())
      const users = Object.keys(s.ledger ?? s.farms ?? s.wallets ?? {})
      console.log('keys:', Object.keys(s).join(','), ' users:', users.join(','), ' v:', s.v)
      const wl = s.wallets ?? s.ledger ?? {}
      for (const [u, w] of Object.entries(wl)) {
        if (typeof w === 'object' && w) console.log(`  ${u}:`, JSON.stringify(w).slice(0, 200))
      }
    } catch (e) { console.log('parse err', e.message) }
  }
  TOPICS.splice(i, 1)
  if (TOPICS.length === 0) done(0)
})
c.on('error', (e) => { console.log('conn error:', e.message); done(2) })
