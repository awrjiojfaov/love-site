/* 玉石数据清理（2026-10-21）：
 * 问题的"凭空增多"= 重复送料/打卡竞态堆出的海量 t4 帝王料（两人合计 800+ 块活体，
 * 每块切割再翻出 2-3 块伴生小料永远留在收藏柜）。本脚本按墓碑（state.arch.ids，两端
 * mergeArchive 原生支持，跨设备防复活）批量删除异常坯料：
 *  - 仅删 tierId=t4、非终结态（uncut/cut/kept/auction）；
 *  - 保护：① 砖（brick- 前缀）② 当天新发的料 ③ 6 秒内匹配到「赌石·买下/购入」
 *    或「玉缘拍卖会·购得」钱包账的交易石（真金白银买的东西）及其拆出的小料；
 *  - 其余（打卡/送料凭空堆出、以及它们的伴生小料）全部删除。
 * PURGE_DRY=1 只出报告不发布。 */
const mqtt = require('mqtt');
const PREFIX = 'lovesite-sj-ych-9f7e2/';
const DRY = process.env.PURGE_DRY === '1';

const client = mqtt.connect('wss://mqtt.sanjin-youchaihua.top/mqtt', {
  username: 'lovesite',
  password: 'Ls-9f7e2-mqtt-Xk72Qp',
  clientId: 'purge-jade-' + Math.random().toString(36).slice(2, 8),
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
  if (topic === PREFIX + 'jade/state' && payload.length > 50000) jade = payload;
  if (topic === PREFIX + 'wallet/state' && payload.length > 2000) wallet = payload;
});

const done = (code) => { try { client.end(true); } catch { /* */ } process.exit(code); };
setTimeout(() => {
  if (!jade) { console.log('NO JADE RETAINED'); done(1); }
  else if (!wallet) { console.log('NO WALLET RETAINED — 不敢删，需钱包做保护窗'); done(1); }
  else run();
}, 16000);

function run() {
  const j = JSON.parse(jade.toString());
  const w = JSON.parse(wallet.toString());
  const stones = j.stones || {};
  const arch = j.arch || { earned: {}, spent: {}, ids: [], soldProducts: {}, productIds: {} };

  // 保护窗：钱包里玉石类「真实花钱」交易的 ts（±6s）
  const purchaseTs = {}; // who -> number[]
  for (const t of w.tx || []) {
    const r = String(t.reason || '');
    const jadeBuy = r.startsWith('赌石·买下') || r.startsWith('赌石·购入') || r.startsWith('玉缘拍卖会·购得');
    if (!jadeBuy || !t.who) continue;
    (purchaseTs[t.who] ??= []).push(t.ts);
  }

  // 当天起点（UTC+8）
  const todayStart = Math.floor((Date.now() + 8 * 3600_000) / 86_400_000) * 86_400_000 - 8 * 3600_000;
  const nearPurchase = (who, ts) => {
    const wts = purchaseTs[who];
    return Array.isArray(wts) && wts.some((t) => Math.abs(t - ts) <= 6000);
  };

  const deleted = []; const byWhoStatus = {}; const protectedN = {}; let deletedValue = 0;
  for (const [id, s] of Object.entries(stones)) {
    if (s.tierId !== 't4') continue;
    if (s.status === 'sold' || s.status === 'crafted') continue; // 终结态已折叠，不动
    if (id.startsWith('brick-')) continue;                       // 砖不删
    if (Number(s.ts) >= todayStart) { protectedN[s.by + '|今天新发的'] = (protectedN[s.by + '|今天新发的'] ?? 0) + 1; continue; }
    // 石头的时间戳（child 的 id 复用父 id，第 2 段就是创建时刻；brick- 上面已跳过）
    const seg = String(id).split('-');
    const parsedTs = Number(seg[1]);
    const ts = Number.isFinite(parsedTs) && parsedTs > 1e12 ? parsedTs : Number(s.ts) || 0;
    if (nearPurchase(s.by, ts)) { protectedN[s.by + '|钱包购入匹配'] = (protectedN[s.by + '|钱包购入匹配'] ?? 0) + 1; continue; }
    deleted.push(id);
    if (s.value) deletedValue += s.value;
    const k = s.by + '|' + s.status;
    byWhoStatus[k] = (byWhoStatus[k] ?? 0) + 1;
  }

  console.log('=== 目标删除（t4 非终结坯料） ===');
  for (const [k, n] of Object.entries(byWhoStatus).sort()) console.log('  删', k, 'x' + n);
  console.log('  合计删除 =', deleted.length, '删除面值合计 =', deletedValue);
  console.log('=== 保留（保护名单） ===');
  for (const [k, n] of Object.entries(protectedN).sort()) console.log('  留', k, 'x' + n);

  // 删除前统计各用户活体 t4 数
  const aliveBefore = {};
  for (const [, s] of Object.entries(stones)) {
    if (s.tierId === 't4' && s.status !== 'sold' && s.status !== 'crafted') aliveBefore[s.by] = (aliveBefore[s.by] ?? 0) + 1;
  }

  if (DRY) { console.log('[DRY] 不发布'); done(0); }
  if (deleted.length === 0) { console.log('无可删除项'); done(0); }

  // 墓碑合并（保持 app 相同的 FIFO 4000 上限语义）
  const tomb = new Set(arch.ids || []);
  const addIds = deleted.filter((id) => !tomb.has(id));
  for (const id of addIds) tomb.add(id);
  let tombArr = [...tomb];
  let trimmed = 0;
  while (tombArr.length > 4000) { tombArr.shift(); trimmed++; }

  // 物理剔除：把已墓碑的活体从发布包的 stones 里去掉（新端设备 + 服务端备份都干净）。
  // 旧代码设备上的副本会在各自升级到新包后由 mergeJade 的墓碑剪除逻辑清掉。
  const stonesOut = {};
  const tombSet = new Set(tombArr);
  let physically = 0;
  for (const [id, s] of Object.entries(stones)) {
    if (tombSet.has(id)) { physically++; continue; }
    stonesOut[id] = s;
  }

  const v = Math.max(Number(j.v) || 0, Date.now()) + 1;
  const out = {
    stones: stonesOut,
    products: j.products || {},
    reagents: j.reagents || {},
    arch: { ...arch, ids: tombArr },
    grants: j.grants || {},
    v,
  };
  const payload = JSON.stringify(out);
  console.log(`[publish] v=${v} archIds ${(arch.ids || []).length} -> ${tombArr.length}${trimmed ? ` (超出 4000 裁掉最旧 ${trimmed})` : ''} 物理剔除活体=${physically} bytes=${payload.length}`);
  client.publish(PREFIX + 'jade/state', payload, { qos: 1, retain: true }, (err) => {
    if (err) { console.log('[publish error]', err.message); done(1); return; }
    console.log('[publish ok] 等 1.5s 让 retained 落盘…');
    setTimeout(() => done(0), 1500);
  });
}
