// 验证 MQTT 公共代理的发布/订阅/保留消息链路（框架自带诊断脚本）
// 用法：
//   node test_mqtt.mjs
//   MQTT_URL=wss://broker.emqx.io:8084/mqtt MQTT_TOPIC_PREFIX=demo/ node test_mqtt.mjs
import mqtt from 'mqtt'

// 默认连公共 broker（无需鉴权）；如需测自建 broker，用 MQTT_URL 覆盖
const url = process.env.MQTT_URL || 'wss://broker.emqx.io:8084/mqtt'
// 主题前缀默认用通用占位符，避免误写进真实数据空间
const PREFIX = process.env.MQTT_TOPIC_PREFIX || 'demo/'
const TOPIC = `${PREFIX}ratings/state`
// 测试数据里的成员名用通用占位符
const WHO = process.env.MQTT_WHO || 'member-a'

const client = mqtt.connect(url, {
  clientId: `test-${Math.random().toString(16).slice(2, 10)}`,
  connectTimeout: 15000,
})

const timer = setTimeout(() => {
  console.log('TIMEOUT')
  client.end(true)
  process.exit(1)
}, 30000)

client.on('connect', () => {
  console.log('connected, url =', url, 'topic =', TOPIC)
  client.subscribe(TOPIC, { qos: 1 }, (err) => {
    if (err) {
      console.log('subscribe error', err.message)
      process.exit(1)
    }
    const state = { items: [{ id: 'r_mqtt', who: WHO, title: 'MQTT测试', score: 5, note: '', ts: Date.now() }], v: Date.now() }
    client.publish(TOPIC, JSON.stringify(state), { retain: true, qos: 1 }, () => {
      console.log('published retained')
    })
  })
})

client.on('message', (topic, payload) => {
  console.log('received on', topic)
  console.log('payload:', payload.toString())
  clearTimeout(timer)
  // 清空保留消息，恢复干净状态
  client.publish(TOPIC, '', { retain: true, qos: 1 }, () => {
    console.log('retained cleared')
    client.end()
    process.exit(0)
  })
})

client.on('error', (e) => {
  console.log('error:', e.message)
  clearTimeout(timer)
  process.exit(1)
})
