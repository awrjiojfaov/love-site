// 一次性诊断：查看拍卖会 retained 状态在三个 broker 上的实况
const mqtt = require('mqtt')
const TOPIC = 'lovesite/auction/state'
const BROKERS = [
  ['emqx', 'wss://broker.emqx.io:8084/mqtt'],
  ['hivemq', 'wss://broker.hivemq.com:8884/mqtt'],
  ['mosquitto', 'wss://test.mosquitto.org:8081/mqtt'],
]
let remaining = BROKERS.length
const timer = setTimeout(() => { console.log('TIMEOUT'); process.exit(2) }, 40000)
for (const [name, url] of BROKERS) {
  const c = mqtt.connect(url, { reconnectPeriod: 0, connectTimeout: 12000 })
  const kill = () => { try { c.end() } catch {} if (--remaining === 0) { clearTimeout(timer); process.exit(0) } }
  setTimeout(kill, 15000)
  c.on('connect', () => c.subscribe(TOPIC))
  c.on('message', (t, payload) => {
    console.log(`--- ${name} : ${payload.length} bytes`)
    if (payload.length === 0) { console.log('  (空 retained)'); kill(); return }
    try {
      const s = JSON.parse(payload.toString())
      const sess = s.session
      console.log('  v:', s.v, ' t:', s.t, ' from:', s.from)
      if (!sess) console.log('  session: null')
      else {
        const lots = Object.values(sess.lots ?? {})
        console.log(`  session: id=${sess.id} status=${sess.status} createdAt=${sess.createdAt} createdBy=${sess.createdBy}`)
        console.log(`  theme=${sess.themeId} market=${sess.market} liveStartAt=${sess.liveStartAt} settledAt=${sess.settledAt}`)
        console.log(`  ready:`, JSON.stringify(sess.ready), ' paid:', JSON.stringify(sess.paid))
        console.log(`  lots: ${lots.length} 件`, lots.map((l) => `${l.name}(${l.seller},${l.status})`).join(' | '))
        console.log(`  aiLots: ${Object.keys(sess.aiLots ?? {}).length}  script: ${sess.script ? sess.script.lots.length + '件' : '无'}`)
      }
      console.log(`  archives: ${Object.keys(s.archives ?? {}).length}  heldVault: ${Object.keys(s.heldVault ?? {}).length}`)
    } catch (e) { console.log('  parse err', e.message) }
    kill()
  })
  c.on('error', (e) => { console.log(`${name} conn error:`, e.message); kill() })
}
