/* 最终核验：retained jade 现状快照 —— v/archIds/存活石/各层累积 + 保护对象 */
const mqtt = require('mqtt');
const PREFIX = 'lovesite-sj-ych-9f7e2/';

const client = mqtt.connect('wss://mqtt.sanjin-youchaihua.top/mqtt', {
  username: 'lovesite', password: 'Ls-9f7e2-mqtt-Xk72Qp',
  clientId: 'diag-jadev-' + Math.random().toString(36).slice(2, 8),
  clean: true, connectTimeout: 15000, reconnectPeriod: 3000,
});
let jade = null;
client.on('connect', () => { client.subscribe([PREFIX + 'jade/state'], { qos: 1 }); });
client.on('message', (t, p) => { if (t === PREFIX + 'jade/state' && p.length > 100000) jade = p; });
setTimeout(() => { if (!jade) { console.log('NO JADE'); process.exit(1); } run(); }, 18000);

function run() {
  const j = JSON.parse(jade.toString());
  const all = Object.values(j.stones || {});
  const tomb = new Set((j.arch && j.arch.ids) || []);
  const isTerminal = (s) => s.status === 'sold' || s.status === 'crafted';
  const alive = all.filter((s) => !isTerminal(s));

  console.log('v=', j.v, 'archIds=', (j.arch && j.arch.ids || []).length, 'liveStones=', alive.length, 'bytes=', jade.toString().length);
  console.log('grants keys=', Object.keys(j.grants || {}).length);

  // 存活按 用户×层级×类别（parent / child(~) / brick / reagent)
  const bucket = {};
  for (const s of alive) {
    const kind = s.id.startsWith('brick-') ? 'brick' : s.id.startsWith('re-') ? 'reagent' : s.id.includes('~') ? 'child' : 'seed';
    const k = [s.by, s.tierId, kind].join(' | ');
    bucket[k] = (bucket[k] || { n: 0, val: 0 });
    bucket[k].n++; bucket[k].val += s.value || 0;
  }
  for (const [k, v] of Object.entries(bucket).sort()) {
    console.log(' ', k.padEnd(30), 'x', String(v.n).padStart(4), 'val=', v.val);
  }

  // 今日新石头（UTC+8 0 点后）应是唯一合法的非石头来源
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const today = all.filter((s) => s.ts >= dayStart.getTime() && !isTerminal(s) && !s.id.startsWith('brick-'));
  console.log('--- 今日新增(非 brick) ---');
  for (const s of today.sort((a, b) => a.ts - b.ts)) {
    const d = new Date(s.ts);
    console.log(' ', s.by, d.toTimeString().slice(0, 8), s.tierId, s.id.slice(0, 24), s.status, s.value);
  }

  // 试算“投入/富贵值”两个口径（新逻辑：child/re- 不计价）
  let spentNew = 0, spentOld = 0, liveVal = 0;
  const price = { t1: 5000, t2: 30000, t3: 50000, t4: 80000, t5: 200000, t6: 500000 };
  for (const s of alive) {
    if (s.id.startsWith('brick-')) continue;
    liveVal += s.value || 0;
    const p = price[s.tierId] || 0;
    spentOld += p;
    if (!s.id.includes('~') && !s.id.startsWith('re-')) spentNew += p;
  }
  console.log('原口径 投入=', spentOld, ' 新口径 投入=', spentNew, ' 存活面值=', liveVal);
  process.exit(0);
}
