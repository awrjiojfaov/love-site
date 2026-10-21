/* 查找 油菜花 的 5000g / 金沙种 / 纯度60 石头 —— 先列证据再删 */
const mqtt = require('mqtt');
const PREFIX = 'lovesite-sj-ych-9f7e2/';

const client = mqtt.connect('wss://mqtt.sanjin-youchaihua.top/mqtt', {
  username: 'lovesite', password: 'Ls-9f7e2-mqtt-Xk72Qp',
  clientId: 'diag-brickfind-' + Math.random().toString(36).slice(2, 8),
  clean: true, connectTimeout: 15000, reconnectPeriod: 3000,
});
let jade = null;
client.on('connect', () => { client.subscribe([PREFIX + 'jade/state'], { qos: 1 }); });
client.on('message', (t, p) => { if (t === PREFIX + 'jade/state' && p.length > 100000) jade = p; });
setTimeout(() => { if (!jade) { console.log('NO JADE'); process.exit(1); } run(); }, 18000);

function run() {
  const j = JSON.parse(jade.toString());
  const all = Object.values(j.stones || {});
  const isTerminal = (s) => s.status === 'sold' || s.status === 'crafted';
  const alive = all.filter((s) => !isTerminal(s)).sort((a, b) => a.ts - b.ts);

  // 1) 全部 5000g 的石头
  console.log('=== 活体中 grams=5000 的石头 ===');
  for (const s of alive.filter((s) => s.grams === 5000)) {
    const d = new Date(s.ts);
    console.log(JSON.stringify({
      id: s.id, by: s.by, ts: `${d.toISOString()}`, tier: s.tierId, 
      varietyId: s.varietyId, purity: s.purity, grams: s.grams, val: s.value, st: s.status,
    }));
  }

  // 2) 油菜花 brick- 全部（看 5000g / 金沙在里面）
  console.log('=== 油菜花 brick- 全部 ===');
  const bricks = alive.filter((s) => s.by === '油菜花' && s.id.startsWith('brick-'));
  for (const s of bricks) {
    const d = new Date(s.ts);
    console.log(JSON.stringify({ id: s.id.slice(0, 40), tier: s.tierId, varietyId: s.varietyId, purity: s.purity, grams: s.grams, val: s.value, ts: `${d.toISOString()}` }));
  }

  // 3) state 里是否有 varieties 名称表
  console.log('=== state keys ===', Object.keys(j));
  if (j.varieties) {
    const hit = Object.entries(j.varieties).filter(([id, v]) => (v.name || '').includes('金沙') || (v && String(v).includes('金沙')));
    console.log('varieties 金沙 hits:', JSON.stringify(hit).slice(0, 2000));
  }
  process.exit(0);
}
