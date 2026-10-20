// 一次性：把 9/12 农场快照以 Lamport max+1 版本回补到 emqx 主 broker（retained）
const mqtt = require('mqtt')
const fs = require('fs')
const TOPIC = 'lovesite/farm/state'
const snap = JSON.parse(fs.readFileSync(process.argv[2] ?? 'rescue/farm-state-20260912.json', 'utf8'))
const now = Date.now()
const state = {
  farms: snap.farms,
  vv: Object.fromEntries(Object.keys(snap.farms).map((u) => [u, now + 1])),
  v: now,
}
const c = mqtt.connect('wss://broker.emqx.io:8084/mqtt', { reconnectPeriod: 0, connectTimeout: 15000 })
const done = (code) => { try { c.end() } catch {} ; process.exit(code) }
setTimeout(() => { console.log('TIMEOUT'); done(2) }, 25000)
c.on('connect', () => {
  console.log('publishing rescue state, users:', Object.keys(state.farms).join(','), 'v =', now)
  c.publish(TOPIC, JSON.stringify(state), { retain: true, qos: 1 }, (err) => {
    if (err) { console.log('publish err', err); done(2) }
    console.log('PUBLISHED ok')
    done(0)
  })
})
c.on('error', (e) => { console.log('err', e.message); done(2) })
