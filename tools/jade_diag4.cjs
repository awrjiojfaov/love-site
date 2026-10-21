/* v4: 细看 10-08 17:05:35 与 10-10 15:38:40 两批同毫秒 t4 石头的完整记录 + 钱包相关 ticker */
const mqtt = require('mqtt');
const PREFIX = 'lovesite-sj-ych-9f7e2/';

const client = mqtt.connect('wss://mqtt.sanjin-youchaihua.top/mqtt', {
  username: 'lovesite', password: 'Ls-9f7e2-mqtt-Xk72Qp',
  clientId: 'diag-jade4-' + Math.random().toString(36).slice(2, 8),
  clean: true, connectTimeout: 15000, reconnectPeriod: 3000,
});
let jade = null, wallet = null;
client.on('connect', () => { client.subscribe([PREFIX + 'jade/state', PREFIX + 'wallet/state'], { qos: 1 }); });
client.on('message', (topic, payload) => {
  if (topic === PREFIX + 'jade/state' && payload.length > 100000) jade = payload;
  if (topic === PREFIX + 'wallet/state') wallet = payload;
});
setTimeout(() => { if (!jade) { console.log('NO JADE'); process.exit(1); } run(); }, 18000);

function run() {
  const j = JSON.parse(jade.toString());
  const w = wallet ? JSON.parse(wallet.toString()) : { tx: [] };
  const stones = Object.values(j.stones || {});
  const B = [
    1791644735000, // placeholder — 实际用窗口扫
  ];
  // 收集 10-08 17:05:3x 及 10-10 15:38:4x 附近 ±2s 的 t4 全部石头
  const win = [
    { from: '2026-10-08T17:05:30+08:00', to: '2026-10-08T17:05:45+08:00' },
    { from: '2026-10-10T15:38:30+08:00', to: '2026-10-10T15:38:50+08:00' },
  ].map((x) => ({ f: new Date(x.from).getTime(), t: new Date(x.to).getTime() }));
  const hits = stones.filter((s) => s.tierId === 't4' && win.some((W) => s.ts >= W.f && s.ts <= W.t));
  console.log('hits in windows =', hits.length);
  hits.sort((a, b) => a.ts - b.ts);
  for (const s of hits) {
    const d = new Date(s.ts);
    console.log(JSON.stringify({
      id: s.id, ts: `${d.toISOString()} (l=${d.getTime()})`, st: s.status, by: s.by,
      v: s.varietyId, g: s.grams, val: s.value, upd: s.upd != null ? new Date(s.upd).toISOString() : undefined,
      pu: s.purity, gp: s.goalPurity, void: s.void, kids: s.id.includes('~'),
    }));
  }
  console.log('=== 全部钱包 tx 原因/关键词统计 ===');
  const rc = {};
  for (const t of w.tx || []) rc[t.reason] = (rc[t.reason] || 0) + 1;
  for (const [r, n] of Object.entries(rc).sort((a, b) => b[1] - a[1])) console.log('   x' + n, r);
  process.exit(0);
}
