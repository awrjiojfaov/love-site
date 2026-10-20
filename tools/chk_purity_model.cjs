// 提纯模型验证（2026-10-10 第三批新模型 · 三档差距版）：
// ① 三档效果拉开：草木 +5 / 寒泉 +12 / 龙涎 +25，且到顶只数递减
// ② 各档从任意起点到顶的只数上限
// ③ 提纯后估值单调不降
// ④ 玉砖纯度 = 入炉料加权平均
// ⑤ 账本不变量 available = max(0, produced - consumed) 只减不增（防刷）
const STEP = { basic: 5, fine: 12, supreme: 25 };
const GOAL_MIN = 0.95, GOAL_MAX = 1.0;
const purityCoef = (p) => { p = Math.min(1, Math.max(0, p)); return Math.round((0.6 + p * 0.8 + 0.2 * p * p) * 10000) / 10000; };
const round4 = (n) => Math.round(n * 10000) / 10000;
const V = [['大理石纹',9],['豆种翡翠',32],['糯种翡翠',36],['铁龙生',37],['冰糯种',82],['蓝水翡翠',84],['晴水翡翠',88],['黄翡',95],['白银',97],['红翡',102],['墨翠',195],['天空蓝',205],['紫罗兰',215],['深海蓝',222],['桃花春',232],['冰种翡翠',235],['黄金',250],['高冰种',258],['帝王紫',470],['金砂种',500],['玻璃种',545],['鎏金翡翠',562],['帝王绿',598],['血玉',680],['赤霞',720],['炫彩玉',950]];

let fatal = 0;
console.log('=== ① 三档效果差距 ===');
const b = STEP.basic, f = STEP.fine, s = STEP.supreme;
console.log(`  草木 +${b}% / 寒泉 +${f}% / 龙涎 +${s}%`);
console.log(b < f && f < s ? '  ✅ 草木 < 寒泉 < 龙涎（越高级抬得越多）' : (fatal++, '  ❌ 档位未拉开'));
console.log(s === b * 5 && f / b === 2.4 ? '  ✅ 龙涎 是 草木的 5 倍、寒泉的 ~2 倍' : '  ℹ️ 倍数关系');

console.log('\n=== ② 各档从任意起点到顶的只数（越小越强） ===');
let allOk = true;
const worst = {};
for (const [id, step] of Object.entries(STEP)) {
  let mx = 0, mxCase = '';
  for (const p0 of [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.94, 0.949]) {
    for (const goal of [GOAL_MIN, 0.96, 0.97, 0.98, 0.99, GOAL_MAX]) {
      let cur = p0, n = 0;
      while (cur < goal - 1e-9 && n < 200) {
        const gain = Math.min(step, Math.max(0, (goal - cur) * 100));
        cur = round4(Math.min(goal, cur + gain / 100));
        n++;
      }
      if (n > mx) { mx = n; mxCase = `${(p0*100).toFixed(1)}%→${(goal*100).toFixed(0)}%`; }
      if (cur < goal - 1e-6) { allOk = false; console.log(`  ❌ ${id} 未到顶`); }
    }
  }
  worst[id] = mx;
  console.log(`  ${id.padEnd(8)} +${step}% → 最多 ${mx} 只到顶（最坏 ${mxCase}）`);
}
console.log(worst.basic > worst.fine && worst.fine > worst.supreme
  ? `  ✅ 到顶只数递减：草木 ${worst.basic} > 寒泉 ${worst.fine} > 龙涎 ${worst.supreme}`
  : (fatal++, '  ❌ 到顶只数未递减'));
console.log(allOk ? '  ✅ 各档都能到顶' : (fatal++, '  ❌ 有档位到不了顶'));

console.log('\n=== ③ 提纯后估值不降（真实缩放公式） ===');
let vBad = 0;
const valueAfter = (value, cur, next) => {
  const scaled = Math.max(50, Math.round((value * (purityCoef(next) / purityCoef(cur))) / 50) * 50);
  return next > cur ? Math.max(value, scaled) : scaled;
};
for (const [name, gp] of V) {
  for (const grams of [10, 50, 200, 1000, 5000]) {
    for (const p0 of [0.2, 0.4, 0.6, 0.8, 0.9]) {
      const value = Math.round(grams * gp * purityCoef(p0));
      for (const step of Object.values(STEP)) {
        const next = round4(Math.min(1, p0 + step / 100));
        const nv = valueAfter(value, p0, next);
        if (nv < value) { vBad++; console.log(`  ❌ ${name} ${grams}g ${p0} +${step}% 后 ${nv} < ${value}`); }
      }
    }
  }
}
console.log(vBad === 0 ? '✅ 提纯后估值单调不降' : `❌ ${vBad} 例下降`);

console.log('\n=== ④ 玉砖纯度 = 入炉料加权平均 ===');
const bricks = [[500, 0.6], [500, 0.9]];
const totG = bricks.reduce((a, [g]) => a + g, 0);
const wavg = round4(bricks.reduce((a, [g, p]) => a + g * p, 0) / totG);
console.log(`加权平均 ${(wavg*100).toFixed(1)}%（期望 75.0%）${Math.abs(wavg - 0.75) < 0.001 ? '✅' : '❌'}`);

console.log('\n=== ⑤ 账本不变量 available = max(0, produced-consumed) 只减不增 ===');
let produced = 5, consumed = 0, prevAvail = 5, err = 0;
for (let i = 0; i < 7; i++) { consumed += 1; const avail = Math.max(0, produced - consumed); if (avail > prevAvail) err++; prevAvail = avail; }
const finalAvail = Math.max(0, produced - consumed);
console.log(`  合成 ${produced} 只 / 使用 ${consumed} 只 → 剩 ${finalAvail} 只 ${err === 0 && finalAvail === 0 ? '✅（不为负、不凭空回涨）' : '❌'}`);
console.log(fatal === 0 && vBad === 0 && err === 0 ? '\n════ 全部通过 ════' : '\n════ 有失败项 ════');
process.exit(fatal || vBad || err ? 1 : 0);

