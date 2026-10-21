/* v2: 订 jade/wallet/farm 相关主题，等设备上线，记录每一条消息然后体检 jade 全量包 */
const mqtt = require('mqtt');
const PREFIX = 'lovesite-sj-ych-9f7e2/';

const client = mqtt.connect('wss://mqtt.sanjin-youchaihua.top/mqtt', {
  username: 'lovesite',
  password: 'Ls-9f7e2-mqtt-Xk72Qp',
  clientId: 'diag-jade2-' + Math.random().toString(36).slice(2, 8),
  clean: true,
  connectTimeout: 15000,
  reconnectPeriod: 3000,
});

const received = [];
const retainedFinal = new Map();
client.on('connect', () => {
  console.log('[connect]', new Date().toISOString());
  client.subscribe([PREFIX + 'jade/#', PREFIX + 'wallet/#', PREFIX + 'farm/#'], { qos: 1 });
});
client.on('error', (e) => console.log('[error]', e.message));
client.on('message', (topic, payload, packet) => {
  received.push({ t: Date.now(), topic, len: payload.length, retain: !!packet.retain, head: payload.slice(0, 120).toString() });
});

const WAIT = 150000;
const dump = setTimeout(() => {
  console.log('================ LIVE TRAFFIC LOG ================');
  for (const r of received) {
    console.log(new Date(r.t).toISOString().slice(11, 23), r.retain ? 'R' : ' ', r.len, r.topic, '|', r.head.replace(/\s+/g, ' ').slice(0, 100));
  }
  console.log('total messages:', received.length);

  // 找出最像全量 jade 包的：jade/state 且 JSON 有 stones
  let jstate = null, jv = null;
  for (const r of received) {
    if (!r.topic.includes('jade/state')) continue;
    try {
      const s = JSON.parse(String(Buffer.from([])));
    } catch {}
  }
  // 重新订阅一瞬拿 retained（也把这条作为候选）。本身就在会话里，直接再 subs 一次会重发
  client.unsubscribe(PREFIX + 'jade/#', () => {
    client.subscribe(PREFIX + 'jade/#', { qos: 1 });
    let got = null;
    const grab = (topic, payload) => {
      if (topic === PREFIX + 'jade/state' && payload.length > 10000) got = payload;
    };
    client.on('message', grab);
    setTimeout(() => {
      client.off('message', grab);
      if (!got) { console.log('NO FULL JADE STATE (retained missing, no device published)'); client.end(true); process.exit(0); }
      const j = JSON.parse(got.toString());
      analyze(j, got.length);
      client.end(true);
      process.exit(0);
    }, 9000);
  });
}, WAIT);

function analyze(j, size) {
  const stones = Object.values(j.stones || {});
  const products = Object.values(j.products || {});
  const members = ['三金宝宝', '油菜花'];
  console.log('================ JADE STATE ANALYSIS ================');
  console.log('payload', size, 'v=', j.v, 'live stones=', stones.length, 'products=', products.length);
  const byStatus = {};
  for (const s of stones) { const k = s.by + '/' + s.status; byStatus[k] = (byStatus[k] || 0) + 1; }
  console.log('-- stones by user/status --');
  for (const [k, n] of Object.entries(byStatus).sort()) console.log('  ', k, n);
  console.log('-- arch --');
  console.log('  earned:', JSON.stringify((j.arch || {}).earned || {}));
  console.log('  spent :', JSON.stringify((j.arch || {}).spent || {}));
  console.log('  archIds=', ((j.arch || {}).ids || []).length, ' soldProducts=', JSON.stringify((j.arch || {}).soldProducts || {}), ' productIds=', ((j.arch || {}).productIds || []).length);

  console.log('-- t4(帝王料) 非终结 按 日期 聚类 --');
  const dayMap = {};
  for (const s of stones) {
    if (s.tierId !== 't4' || s.status === 'sold' || s.status === 'crafted') continue;
    const d = new Date(s.ts).toISOString().slice(0, 10);
    dayMap[d] = (dayMap[d] || 0) + 1;
  }
  for (const [k, n] of Object.entries(dayMap).sort()) console.log('  ', k, n);

  console.log('-- 同 ts+variety+tier 簇 x>=2 --');
  const sig = new Map();
  for (const s of stones) {
    if (s.status === 'sold' || s.status === 'crafted') continue;
    const k = s.by + '|' + s.ts + '|' + s.varietyId + '|' + s.tierId + '|' + (s.grams ?? '?');
    sig.set(k, (sig.get(k) || 0) + 1);
  }
  let dup = 0;
  for (const [k, n] of [...sig.entries()].sort()) if (n >= 2) { console.log('  ', k, 'x' + n); dup += n - 1; }
  console.log('  dupExtra=', dup);

  console.log('-- 离谱值 --');
  for (const s of stones) {
    if ((s.grams ?? 0) > 6000) console.log('  grams!', s.id, s.grams, s.varietyId, s.value);
    if ((s.value || 0) > 5e8) console.log('  value!', s.id, s.value);
  }

  console.log('-- reagents --', JSON.stringify(j.reagents || {}));
  for (const m of members) {
    const ss = stones.filter((x) => x.by === m);
    const non = ss.filter((x) => x.status !== 'sold' && x.status !== 'crafted');
    console.log('  ', m, 'nonTerminal=', non.length,
      'sumValueWealth=', non.reduce((a, s) => a + (s.value || 0), 0),
      't4=', non.filter((s) => s.tierId === 't4').length,
      't5=', non.filter((s) => s.tierId === 't5').length);
    const prod = products.filter((p) => p.by === m && !p.status);
    console.log('    products:', prod.length, 'sumValue=', prod.reduce((a, p) => a + (p.value || 0), 0));
  }
}
