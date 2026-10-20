// 一次性诊断脚本：查看农场 retained 状态还在不在
const mqtt = require('mqtt')
const TOPIC = 'lovesite/farm/state'
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
  c.subscribe(TOPIC, (err) => { if (err) { console.log('sub err', err); done(2) } })
})
c.on('message', (t, payload) => {
  if (t !== TOPIC) return
  const len = payload.length
  console.log('RECEIVED bytes:', len)
  if (len === 0) { console.log('EMPTY RETAINED'); done(1) }
  try {
    const s = JSON.parse(payload.toString())
    console.log('v =', s.v, ' vv =', JSON.stringify(s.vv))
    for (const [u, f] of Object.entries(s.farms ?? {})) {
      const wh = Object.entries(f.warehouse ?? {}).reduce((a, [, n]) => a + n, 0)
      const plots = (f.plots ?? []).filter((p) => p.cropId).length
      const pond = (f.pond ?? []).filter((p) => p.fishId).length
      console.log(`user=${u} plots=${(f.plots ?? []).length}(${plots} planted) pond=${(f.pond ?? []).length}(${pond} fishing) warehouseItems=${Object.keys(f.warehouse ?? {}).length} warehouseQty=${wh} dex=${(f.dex ?? []).length} coins? wallet不在本主题`)
    }
    done(0)
  } catch (e) { console.log('parse err', e.message); done(2) }
})
c.on('error', (e) => { console.log('conn error:', e.message); done(2) })
