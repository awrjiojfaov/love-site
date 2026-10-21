/* 玉石数据线上诊断：连 MQTT，抓 jade/state retained 包，打印体检查报告 */
const mqtt = require('mqtt');
const { PREFIX, URL, USER, PASS } = {
  PREFIX: 'lovesite-sj-ych-9f7e2/',
  URL: 'wss://mqtt.sanjin-youchaihua.top/mqtt',
  USER: 'lovesite',
  PASS: 'Ls-9f7e2-mqtt-Xk72Qp',
};

const client = mqtt.connect(URL, {
  username: USER,
  password: PASS,
  clientId: 'diag-jade-' + Math.random().toString(36).slice(2, 8),
  clean: true,
  connectTimeout: 15000,
  reconnectPeriod: 3000,
});

const msgs = new Map();
client.on('connect', () => {
  console.log('[connect] ok, subscribing', PREFIX + '#');
  client.subscribe(PREFIX + '#', { qos: 1 });
});
client.on('error', (e) => console.log('[error]', e.message));
client.on('message', (topic, payload) => {
  const prev = msgs.get(topic);
  msgs.set(topic, payload);
});

setTimeout(() => {
  console.log('================ TOPIC INVENTORY ================');
  for (const [t, p] of [...msgs.entries()].sort()) console.log(String(p.length).padStart(8), t);

  const JADE_T = PREFIX + 'lovesite/jade/state';
  const jadeRaw = msgs.get(JADE_T);
  if (!jadeRaw) { console.log('NO JADE STATE'); client.end(true); process.exit(0); }
  const j = JSON.parse(jadeRaw.toString());
  const stones = Object.values(j.stones || {});
  const products = Object.values(j.products || {});
  const members = ['三金宝宝', '油菜花'];

  console.log('================ JADE SUMMARY ================');
  console.log('v =', j.v, ' live stones =', stones.length, ' live products =', products.length);
  const byStatus = {};
  for (const s of stones) {
    const k = s.by + '/' + s.status;
    byStatus[k] = (byStatus[k] || 0) + 1;
  }
  console.log('-- stones by user/status --');
  for (const [k, n] of Object.entries(byStatus).sort()) console.log('  ', k, n);
  console.log('-- arch counters --');
  console.log('  earned:', JSON.stringify(j.arch && j.arch.earned || {}));
  console.log('  spent :', JSON.stringify(j.arch && j.arch.spent || {}));
  console.log('  archIds:', (j.arch && j.arch.ids || []).length, ' soldProducts:', JSON.stringify(j.arch && j.arch.soldProducts || {}), ' productIds:', (j.arch && j.arch.productIds || []).length);

  // 帝王料(t4) 未切 stones：按天聚类（打卡签名：同一天同档大量）
  console.log('-- t4(帝王料) uncut/cut/kept 按 t ier·status·日 聚类 --');
  const dayMap = {};
  for (const s of stones) {
    if (s.tierId !== 't4' || s.status === 'sold' || s.status === 'crafted') continue;
    const d = new Date(s.ts).toISOString().slice(0, 10);
    const k = d + '/' + s.status;
    dayMap[k] = (dayMap[k] || 0) + 1;
  }
  for (const [k, n] of Object.entries(dayMap).sort()) console.log('  ', k, n);

  // 同秒同品种同克数簇：打卡/送料重复发放的签名
  console.log('-- 同 ts+variety+grams 簇 (>=2 即为可疑重复发放) --');
  const sig = new Map();
  for (const s of stones) {
    if (s.status === 'sold' || s.status === 'crafted') continue;
    const k = s.by + '|' + s.ts + '|' + s.varietyId + '|' + s.grams;
    sig.set(k, (sig.get(k) || 0) + 1);
  }
  let susDup = 0;
  for (const [k, n] of [...sig.entries()].sort()) {
    if (n >= 2) { console.log('  ', k, 'x' + n); susDup += n - 1; }
  }
  console.log('  suspicious extra count =', susDup);

  // 异物字段/离谱值
  console.log('-- 离谱值体检 --');
  let bad = 0;
  for (const s of stones) {
    if (s.grams != null && s.grams > 6000) { console.log('  grams!', s.id, s.grams, s.varietyId); bad++; }
    if (s.value > 5e8) { console.log('  value!', s.id, s.value); bad++; }
  }
  console.log('  bad =', bad);

  console.log('-- reagents ledger --');
  console.log('  ', JSON.stringify(j.reagents || {}));

  // products 概览
  const pbyst = {};
  for (const p of products) {
    const k = p.by + '/' + (p.status || 'live');
    pbyst[k] = (pbyst[k] || 0) + 1;
  }
  console.log('-- products by user/status --');
  for (const [k, n] of Object.entries(pbyst).sort()) console.log('  ', k, n);

  // 全量石头按用户合计价值
  console.log('-- 合计 --');
  for (const m of members) {
    const ss = stones.filter((s) => s.by === m);
    const nonTerm = ss.filter((s) => s.status !== 'sold' && s.status !== 'crafted');
    console.log('  ', m, 'live(nonterm)=', nonTerm.length,
      'wealthSum=', nonTerm.reduce((a, s) => a + (s.value || 0), 0),
      't4nonterm=', nonTerm.filter((s) => s.tierId === 't4').length);
  }
  client.end(true);
  process.exit(0);
}, 15000);
