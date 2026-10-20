// 一次性：把 hivemq 备 broker 上的农场 retained 完整dump到本地文件
const mqtt = require('mqtt')
const fs = require('fs')
const TOPIC = 'lovesite/farm/state'
const c = mqtt.connect('wss://broker.hivemq.com:8884/mqtt', { reconnectPeriod: 0, connectTimeout: 15000 })
const done = (code) => { try { c.end() } catch {} ; process.exit(code) }
setTimeout(() => { console.log('TIMEOUT'); done(2) }, 25000)
c.on('connect', () => c.subscribe(TOPIC))
c.on('message', (t, payload) => {
  if (t !== TOPIC) return
  fs.writeFileSync(process.argv[2] ?? 'farm-rescue.json', payload.toString())
  console.log('saved', payload.length, 'bytes')
  done(0)
})
c.on('error', (e) => { console.log('err', e.message); done(2) })
