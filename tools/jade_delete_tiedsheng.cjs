/* 动态删除：油菜花名下 全部铁龙生(tiedsheng) 活体石头 —— 墓碑 + 物理剔除 */
const mqtt = require('mqtt');
const PREFIX = 'lovesite-sj-ych-9f7e2/';
const V = 'tiedsheng';

const client = mqtt.connect('wss://mqtt.sanjin-youchaihua.top/mqtt', {
  username: 'lovesite', password: 'Ls-9f7e2-mqtt-Xk72Qp',
  clientId: 'tls-del-' + Math.random().toString(36).slice(2, 8),
  clean: true, connectTimeout: 15000, reconnectPeriod: 3000,
});
let jade = null;
client.on('connect', () => { client.subscribe([PREFIX + 'jade/state'], { qos: 1 }); });
client.on('message', (t, p) => { if (t === PREFIX + 'jade/state' && p.length > 100000) jade = p; });
setTimeout(() => { if (!jade) { console.log('NO JADE'); process.exit(1); } run(); }, 18000);

function run() {
  const j = JSON.parse(jade.toString());
  const tomb = new Set((j.arch && j.arch.ids) || []);
  const isTerminal = (s) => s.status === 'sold' || s.status === 'crafted';
  const targets = [];
  const stonesOut = {};
  let removedVal = 0, phys = 0;
  for (const [id, s] of Object.entries(j.stones || {})) {
    if (!(s.by === '油菜花' && s.varietyId === V && !isTerminal(s))) { stonesOut[id] = s; continue; }
    targets.push(id);
    if (!tomb.has(id)) tomb.add(id);
    phys++; removedVal += s.value || 0;
  }
  console.log(`匹配 油菜花|${V}|非终结 = ${targets.length} 块，删除面值合计 = ${removedVal}`);
  for (const id of targets.sort()) {
    const s = (j.stones || {})[id];
    console.log('  [del]', id.slice(0, 50), s.tier || s.tierId, 'purity', s.purity, 'grams', s.grams, 'val', s.value, 'st', s.status);
  }
  if (targets.length === 0) { console.log('已是 0 块活体，无需操作'); process.exit(0); }

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
  console.log(`[publish] v=${v} archIds=${tombArr.length} 物理剔除=${phys} bytes=${payload.length}`);
  client.publish(PREFIX + 'jade/state', payload, { qos: 1, retain: true }, () => {
    console.log('[publish ok]');
    setTimeout(() => process.exit(0), 1500);
  });
}
