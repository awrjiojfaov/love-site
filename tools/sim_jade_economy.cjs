// 玉石克价重定价 · 蒙特卡洛验证：四档期望回收率是否齐平、同品质单克价波动是否锁死 ±20%
const TIER_GRAMS = { t1: [20, 80], t2: [60, 160], t3: [100, 260], t4: [150, 380] };
const RARITY_GRAM_FACTOR = { '废料': 0.7, '常见': 1, '少见': 1.1, '稀有': 1.2, '传说': 1.3 };
const TIER_WEIGHTS = {
  t1: { '废料': 52, '常见': 40, '少见': 7, '稀有': 0.9, '传说': 0.1 },
  t2: { '废料': 44, '常见': 40, '少见': 14, '稀有': 1.8, '传说': 0.2 },
  t3: { '废料': 36, '常见': 34, '少见': 22, '稀有': 7, '传说': 1 },
  t4: { '废料': 40, '常见': 22, '少见': 22, '稀有': 12, '传说': 4 },
};
const VARIETIES = [
  ['marble', '废料', 9], ['doudi', '常见', 32], ['nuo', '常见', 36], ['bingnuo', '少见', 82],
  ['qingshui', '少见', 88], ['yellow', '少见', 95], ['red', '少见', 102], ['mo', '稀有', 195],
  ['violet', '稀有', 215], ['ice', '稀有', 235], ['highice', '稀有', 258], ['glass', '传说', 545],
  ['emperor', '传说', 598], ['tiedsheng', '常见', 37], ['silvermetal', '少见', 97], ['bluewater', '少见', 84],
  ['spring', '稀有', 232], ['skyblue', '稀有', 205], ['deepblue', '稀有', 222], ['goldmetal', '稀有', 250],
  ['royalviolet', '传说', 470], ['goldsand', '传说', 500], ['gilded', '传说', 562],
].map(([id, rarity, gramPrice]) => ({ id, rarity, gramPrice }));
const PRICES = { t1: 5000, t2: 15000, t3: 40000, t4: 80000 };

function rollVariety(tierId) {
  const w = TIER_WEIGHTS[tierId];
  const bag = [];
  for (const v of VARIETIES) { const n = Math.round((w[v.rarity] ?? 0) * 10); for (let i = 0; i < n; i++) bag.push(v); }
  return bag[Math.floor(Math.random() * bag.length)];
}
function rollStone(tierId) {
  const v = rollVariety(tierId);
  const [lo, hi] = TIER_GRAMS[tierId];
  const grams = Math.max(10, Math.round((lo + Math.random() * (hi - lo)) * RARITY_GRAM_FACTOR[v.rarity] * (0.82 + Math.random() * 0.18)));
  const value = Math.max(50, Math.round((grams * v.gramPrice * (0.8 + Math.random() * 0.4)) / 50) * 50);
  return { v, grams, value };
}
// 稀有度内克价极值检查（品种表静态，直接算）
const byRarity = {};
for (const v of VARIETIES) { (byRarity[v.rarity] ??= []).push(v.gramPrice); }
console.log('=== 同稀有度克价极差 ===');
for (const [r, ps] of Object.entries(byRarity)) {
  const avg = ps.reduce((a, b) => a + b) / ps.length;
  const spread = Math.max(...ps.map((p) => Math.abs(p / avg - 1)));
  console.log(`${r}: ${Math.min(...ps)}~${Math.max(...ps)} /g，均值 ${avg.toFixed(0)}，最大偏离 ±${(spread * 100).toFixed(1)}%`);
}
console.log('\n=== 四档蒙特卡洛（各 20 万块）===');
for (const t of ['t1', 't2', 't3', 't4']) {
  const N = 200000;
  let sumV = 0, sumG = 0, hits = { '稀有': 0, '传说': 0 };
  const pg = {};
  for (let i = 0; i < N; i++) {
    const s = rollStone(t);
    sumV += s.value; sumG += s.grams;
    if (s.v.rarity === '稀有' || s.v.rarity === '传说') hits[s.v.rarity]++;
    (pg[s.v.id] ??= []).push(s.value / s.grams);
  }
  const ev = sumV / N;
  console.log(`${t}: 期望回收 ${ev.toFixed(0)} / 料价 ${PRICES[t]} = ${(ev / PRICES[t] * 100).toFixed(1)}%  均克重 ${(sumG / N).toFixed(0)}g  稀有率 ${(hits['稀有'] / N * 100).toFixed(1)}%  传说率 ${(hits['传说'] / N * 100).toFixed(2)}%`);
  // 抽查两个品种的单克价波动（应恰好 ±20%）
  for (const vid of ['emperor', 'doudi']) {
    if (pg[vid]) {
      const xs = pg[vid];
      console.log(`   ${vid} 单克价实测范围 ${Math.min(...xs).toFixed(0)}~${Math.max(...xs).toFixed(0)}（理论 ±20% = ${(VARIETIES.find(v=>v.id===vid).gramPrice * 0.8).toFixed(0)}~${(VARIETIES.find(v=>v.id===vid).gramPrice * 1.2).toFixed(0)}）`);
    }
  }
}
// 同品种跨等级单克价一致性
console.log('\n=== 同品种跨档位单克价一致（帝王绿 t1 vs t4）===');
for (const t of ['t1', 't4']) {
  const samples = [];
  for (let i = 0; i < 20000; i++) { const s = rollStone(t); if (s.v.id === 'emperor') samples.push(s.value / s.grams); }
  if (samples.length) console.log(`${t} 帝王绿单克价 ${Math.min(...samples).toFixed(0)}~${Math.max(...samples).toFixed(0)} /g（n=${samples.length}）`);
}
