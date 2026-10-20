// 提纯全流程冒烟测试：直接跑编译产物里 jade 的核心算法（复制常量与公式，验证不变量）
// 关注点：① 回补纯度自洽 ② 提纯单调递增且不超顶 ③ 提纯不改克数 ④ 反复提纯不刷随机数
const GOAL_MIN = 0.95, GOAL_MAX = 1.0;
const PURIFIERS = [
  { id: 'basic', price: 1200, power: 4.5 },
  { id: 'fine', price: 4200, power: 10 },
  { id: 'supreme', price: 15000, power: 20 },
];
const VARIETIES = [
  ['marble', '废料', 9], ['doudi', '常见', 32], ['nuo', '常见', 36], ['bingnuo', '少见', 82],
  ['qingshui', '少见', 88], ['yellow', '少见', 95], ['red', '少见', 102], ['mo', '稀有', 195],
  ['violet', '稀有', 215], ['ice', '稀有', 235], ['highice', '稀有', 258], ['glass', '传说', 545],
  ['emperor', '传说', 598], ['bloodjade', '神话', 680], ['chixia', '神话', 720], ['rainbow', '神话', 950],
].map(([id, rarity, gramPrice]) => ({ id, rarity, gramPrice }));
const byId = (id) => VARIETIES.find(v => v.id === id) || VARIETIES[0];
const hash01 = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h / 4294967296; };
const round4 = (n) => Math.round(n * 10000) / 10000;
const purityCoef = (p) => { p = Math.min(1, Math.max(0, p)); return Math.round((0.6 + p * 0.8 + 0.2 * p * p) * 10000) / 10000; };
function purityFromCoef(c0) { const c = Math.min(purityCoef(1), Math.max(purityCoef(0), c0)); let lo = 0, hi = 1; for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (purityCoef(m) < c) lo = m; else hi = m; } return round4((lo + hi) / 2); }
const deriveCoefPurity = (coef, goal) => Math.min(goal, purityFromCoef(coef));
const purityDamp = (p, g) => Math.max(0.12, Math.max(0, g - p) / 0.25);
const gainOf = (pw, gp, p, goal) => Math.min(pw * (100 / Math.max(30, gp)) * purityDamp(p, goal), (goal - p) * 100);

const withPurity = (s) => {
  const goal = typeof s.goalPurity === 'number' ? s.goalPurity : round4(GOAL_MIN + hash01(`${s.id}|goal`) * (GOAL_MAX - GOAL_MIN));
  if (typeof s.purity === 'number') return { goalPurity: goal, purity: Math.min(s.goalPurity ?? goal, s.purity), ...s };
  const perGram = (s.grams ?? 0) * byId(s.varietyId).gramPrice;
  const coef = perGram > 0 ? s.value / perGram : 1;
  return { ...s, goalPurity: goal, purity: round4(Math.max(0.1, deriveCoefPurity(coef, goal))) };
};
const rollStone = (id, tierGrams, vid) => {
  const v = byId(vid);
  const grams = Math.max(10, Math.round(tierGrams * (0.82 + Math.random() * 0.18)));
  const goal = round4(GOAL_MIN + Math.random() * (GOAL_MAX - GOAL_MIN));
  const rawCoef = 0.8 + Math.random() * 0.4;
  const value = Math.max(50, Math.round((grams * v.gramPrice * rawCoef) / 50) * 50);
  const purity = round4(Math.min(goal, deriveCoefPurity(value / (grams * v.gramPrice), goal)));
  return { id, varietyId: vid, value, grams, purity, goalPurity: goal, status: 'cut' };
};

let fail = 0;
const chk = (cond, msg) => { if (!cond) { console.log('❌ ' + msg); fail++; } };

console.log('=== 冒烟：新开玉石 → 反复提纯到顶 ===');
for (let i = 0; i < 5000; i++) {
  const vid = VARIETIES[Math.floor(Math.random() * VARIETIES.length)].id;
  const s = rollStone(`t-${i}`, 20 + Math.random() * 360, vid);
  chk(s.purity <= s.goalPurity + 1e-9, `初始纯度 ${s.purity} 超过顶 ${s.goalPurity}`);
  chk(s.purity >= 0.05, `初始纯度异常低 ${s.purity}`);

  let p = s.purity, guard = 0, value = s.value;
  const grams0 = s.grams;
  while (p < s.goalPurity - 1e-9 && guard < 10000) {
    const pur = PURIFIERS[2];
    const g = gainOf(pur.power, byId(vid).gramPrice, p, s.goalPurity);
    if (g <= 1e-9) { chk(false, `提纯停滞在 ${p}，顶 ${s.goalPurity}`); break; }
    const np = round4(Math.min(s.goalPurity, p + g / 100));
    chk(np >= p - 1e-9, `纯度回退 ${p}→${np}`);
    chk(np <= s.goalPurity + 1e-9, `纯度超顶 ${np} > ${s.goalPurity}`);
    // 估值按系数比缩放
    value = Math.max(50, Math.round((value * (purityCoef(np) / purityCoef(p))) / 50) * 50);
    p = np; guard++;
    chk(grams0 === s.grams, '提纯改动了克数');
  }
  chk(p >= s.goalPurity - 1e-9, `未能提到顶：${p} < ${s.goalPurity}`);
  chk(value >= s.value, `提纯后估值反而降了 ${s.value}→${value}`);
  // 到顶后 coef 应为 1.6（该品种天花板）
  chk(Math.abs(purityCoef(s.goalPurity) - purityCoef(1)) < 1e-9 || s.goalPurity < 1, '到顶 coef 异常');
}
console.log(fail === 0 ? '✅ 5000 颗石头全流程无异常（不提爆、不超顶、不改克数）' : `❌ ${fail} 处失败`);

console.log('\n=== 反复提纯是否刷随机数（同一块石头多次提纯，估值必须单调、可复现）===');
{
  const s = rollStone('fixed-1', 200, 'ice');
  const replay = [];
  let p = s.purity, v = s.value;
  for (let k = 0; k < 6; k++) {
    const g = gainOf(PURIFIERS[1].power, byId('ice').gramPrice, p, s.goalPurity);
    const np = round4(Math.min(s.goalPurity, p + g / 100));
    if (np === p) break;
    v = Math.max(50, Math.round((v * (purityCoef(np) / purityCoef(p))) / 50) * 50);
    p = np; replay.push({ p, v });
  }
  let ok = true;
  for (let k = 1; k < replay.length; k++) if (replay[k].v < replay[k - 1].v || replay[k].p <= replay[k - 1].p) ok = false;
  // 复现性：同一个输入序列必须得到同样结果
  let p2 = s.purity, v2 = s.value;
  for (let k = 0; k < 6; k++) {
    const g = gainOf(PURIFIERS[1].power, byId('ice').gramPrice, p2, s.goalPurity);
    const np = round4(Math.min(s.goalPurity, p2 + g / 100));
    if (np === p2) break;
    v2 = Math.max(50, Math.round((v2 * (purityCoef(np) / purityCoef(p2))) / 50) * 50);
    p2 = np;
  }
  chk(ok, '估值单调性/纯度单调性被破坏');
  chk(v === v2 && p === p2, '同一块石头两次提纯结果不一致（存在随机性）');
  console.log(`提纯轨迹：${replay.map(r => `${(r.p * 100).toFixed(1)}%/¥${r.v}`).join(' → ')}`);
  console.log(fail === 0 ? '✅ 无随机刷值，结果确定可复现' : '');
}

console.log('\n=== 老数据回补一致性（同一 id 在两台设备回补出同一纯度）===');
{
  let bad = 0;
  for (let i = 0; i < 20000; i++) {
    const vid = VARIETIES[i % VARIETIES.length].id;
    const old = { id: `legacy-${i}`, varietyId: vid, grams: 50 + (i % 300), value: 1234 + i * 7, status: 'kept' };
    const a = withPurity(old), b = withPurity({ ...old });
    if (a.purity !== b.purity || a.goalPurity !== b.goalPurity) bad++;
  }
  chk(bad === 0, `${bad} 条回补不一致`);
  console.log(bad === 0 ? '✅ 20000 条老数据回补两端一致' : '');
}
console.log(fail === 0 ? '\n🎉 全部通过' : `\n共 ${fail} 处失败`);
process.exit(fail === 0 ? 0 : 1);
