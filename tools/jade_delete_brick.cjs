/* 定向删除：油菜花 金沙种(5000g, 纯度~60) 三块 brick —— 墓碑 + 物理剔除 */
const mqtt = require('mqtt');
const PREFIX = 'lovesite-sj-ych-9f7e2/';

const TARGETS = [
  'brick-油菜花-mvgtlydq-b7122', // 纯度 0.6753
  'brick-油菜花-mvgtm52t-xaaup', // 纯度 0.6654
  'brick-油菜花-mvgtm8z6-no4tw', // 纯度 0.6485
];

const client = mqtt.connect('wss://mqtt.sanjin-youchaihua.top/mqtt', {
  username: 'lovesite', password: 'Ls-9f7e2-mqtt-Xk72Qp',
  clientId: 'brick-del-' + Math.random().toString(36).slice(2, 8),
  clean: true, connectTimeout: 15000, reconnectPeriod: 3000,
});
let jade = null;
client.on('connect', () => { client.subscribe([PREFIX + 'jade/state'], { qos: 1 }); });
client.on('message', (t, p) => { if (t === PREFIX + 'jade/state' && p.length > 100000) jade = p; });
setTimeout(() => { if (!jade) { console.log('NO JADE'); process.exit(1); } run(); }, 18000);

function run() {
  const j = JSON.parse(jade.toString());
  const tomb = new Set((j.arch && j.arch.ids) || []);
  const stonesOut = {};
  let removedVal = 0, phys = 0;
  for (const [id, s] of Object.entries(j.stones || {})) {
    if (TARGETS.includes(id)) {
      if (!tomb.has(id)) tomb.add(id);
      phys++; removedVal += s.value || 0;
      console.log('[del]', id, s.tierId || s.tier, s.varietyId, 'purity', s.purity, 'grams', s.grams, 'val', s.value, 'st', s.status);
      continue;
    }
    stonesOut[id] = s;
  }
  if (phys === 0) {
    console.log('retained 中未找到目标（可能已被设备剪除/之前已删除）。统计现存的指定 id：', TARGETS.filter((id) => !(id in (j.stones || {}))));
    // 仍然确保墓碑在案
    let addCnt = 0;
    for (const id of TARGETS) if (!tomb.has(id)) { tomb.add(id); addCnt++; }
    console.log('补墓碑:', addCnt);
    if (addCnt === 0) { console.log('无需发布'); process.exit(0); }
  }
  const tombArr = [...tomb];
  const v = Math.max(Number(j.v) || 0, Date.now()) + 1;
  const out = {
    stones: stonesOut,
    products: j.products || {},
    reagents: j.reagents || {},
    arch: { ...(j.arch || {}), ids: tombArr },
    grants: j.grants || {},
    v,
  };
  const payload = JSON.stringify(out);
  console.log(`[publish] v=${v} archIds=${tombArr.length} 物理剔除=${phys} 删除面值=${removedVal} bytes=${payload.length}`);
  client.publish(PREFIX + 'jade/state', payload, { qos: 1, retain: true }, () => {
    console.log('[publish ok]');
    setTimeout(() => process.exit(0), 1500);
  });
}
