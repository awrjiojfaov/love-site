/* v3: t4 帝王料法医式交叉对账 —— 同毫秒密集簇（seedStones 签名） vs 钱包购入记录 */
const mqtt = require('mqtt');
const PREFIX = 'lovesite-sj-ych-9f7e2/';

const client = mqtt.connect('wss://mqtt.sanjin-youchaihua.top/mqtt', {
  username: 'lovesite',
  password: 'Ls-9f7e2-mqtt-Xk72Qp',
  clientId: 'diag-jade3-' + Math.random().toString(36).slice(2, 8),
  clean: true,
  connectTimeout: 15000,
  reconnectPeriod: 3000,
});

let jade = null, wallet = null;
client.on('connect', () => {
  console.log('[connect]');
  client.subscribe([PREFIX + 'jade/state', PREFIX + 'wallet/state'], { qos: 1 });
});
client.on('error', (e) => console.log('[error]', e.message));
client.on('message', (topic, payload) => {
  if (topic === PREFIX + 'jade/state' && payload.length > 100000) jade = payload;
  if (topic === PREFIX + 'wallet/state') wallet = payload;
});

const done = (code) => { try { client.end(true); } catch {} process.exit(code); };
setTimeout(() => { if (!jade) { console.log('NO JADE'); done(1); } else run(); }, 20000);

function run() {
  const j = JSON.parse(jade.toString());
  const w = wallet ? JSON.parse(wallet.toString()) : { tx: [] };
  const stones = Object.values(j.stones || {});
  const members = ['三金宝宝', '油菜花'];
  const T4 = 80000;

  console.log('=== 钱包帝王料购入/购入批量 tx（who/date/count）===');
  const bought = {}; // who|day -> stones bought
  for (const t of w.tx || []) {
    const r = String(t.reason || '');
    const m = r.match(/购入帝王料×(\d+)/);
    if (m) {
      const d = ts2day(t.ts);
      const k = t.who + '|' + d;
      bought[k] = (bought[k] || 0) + Number(m[1]);
    }
  }
  for (const [k, n] of Object.entries(bought).sort()) console.log('  bought', k, n);

  console.log('=== 打卡时机签名：同毫秒 t4 簇（seedStones 一次发 5 块同一毫秒的 ts） ===');
  // seedStones: 所有石头 id=who-ts-rand, ts=Date.now() 同一次调用基本同毫秒
  const msCluster = new Map();
  for (const s of stones) {
    if (s.tierId !== 't4') continue;
    const k = s.by + '|' + s.ts;
    msCluster.set(k, (msCluster.get(k) || 0) + 1);
  }
  const clusters = [...msCluster.entries()].filter(([, n]) => n >= 3).map(([k, n]) => {
    const [who, ts] = k.split('|');
    return { who, ts: Number(ts), n };
  }).sort((a, b) => a.ts - b.ts);
  const perDayWho = {};
  for (const c of clusters) {
    const d = ts2day(c.ts);
    perDayWho[c.who + '|' + d] = (perDayWho[c.who + '|' + d] || 0) + 1;
  }
  console.log('-- 同毫秒簇按 用户/日 计次 --');
  for (const [k, n] of Object.entries(perDayWho).sort()) console.log('  ', k, 'x' + n);
  console.log('-- 簇明细（时间） --');
  for (const c of clusters) console.log('  ', c.who, ts2str(c.ts), 'x' + c.n);

  console.log('=== 每用户/日 t4 账本对账（现存非终结 vs 钱包购入 + 打卡×5/日） ===');
  const alive4 = {};
  for (const s of stones) {
    if (s.tierId !== 't4' || s.status === 'sold' || s.status === 'crafted') continue;
    const d = ts2day(s.ts);
    alive4[s.by + '|' + d] = (alive4[s.by + '|' + d] || 0) + 1;
  }
  for (const m of members) {
    for (let d = 2; d <= 21; d++) {
      const day = '2026-10-' + String(d).padStart(2, '0');
      const k = m + '|' + day;
      const alive = alive4[k] || 0;
      const boughtN = bought[k] || 0;
      const clustersN = (perDayWho[k] || 0) * 5;
      const expected = boughtN + clustersN;
      if (alive === 0 && expected === 0) continue;
      console.log('  ', k, 'alive=', alive, 'bought=', boughtN, 'seedClusters*5=', clustersN, alive - expected >= 5 ? ' <<< 多出 ' + (alive - expected) : '');
    }
  }

  console.log('=== t5 星陨料非终结（伴生/主料） ===');
  const t5s = stones.filter((s) => s.tierId === 't5' && s.status !== 'sold' && s.status !== 'crafted');
  for (const s of t5s) console.log('  ', s.by, ts2str(s.ts), s.status, s.varietyId, s.grams + 'g', s.value);
  console.log('t5 count=', t5s.length);

  function ts2day(ts) { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function ts2str(ts) { const d = new Date(ts); return ts2day(ts) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0'); }
  done(0);
}
