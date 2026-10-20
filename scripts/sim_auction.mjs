// 拍卖概率 A/B 仿真：旧参数 vs 新参数（各跑 20000 件拍品）
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const round50 = (n) => Math.max(50, Math.round(n / 50) * 50);
const AI = [
  { id: 'wang', lo: 0.9, hi: 1.35 },
  { id: 'li', lo: 0.7, hi: 1.1, like: ['bangle', 'pendant'], lm: 1.3 },
  { id: 'chen', lo: 0.95, hi: 1.08 },
  { id: 'north', lo: 0.85, hi: 1.3, like: ['ornament', 'bangle'], lm: 1.3 },
  { id: 'zhou', lo: 0.9, hi: 1.2, lv: ['mo', 'violet', 'ice', 'highice', 'glass', 'emperor'], lm: 1.25 },
  { id: 'live', lo: 0.75, hi: 1.25, like: ['ring', 'earrings'], lm: 1.3 },
  { id: 'mine', lo: 0.8, hi: 1.4, lv: ['highice', 'glass', 'emperor'], lm: 1.35 },
  { id: 'lin', lo: 0.6, hi: 0.9 },
  { id: 'tan', lo: 0.55, hi: 0.85 },
  { id: 'phone', lo: 0.85, hi: 1.5, lv: ['glass', 'emperor'], lm: 1.5 },
];
const RAR = ['废料', '常见', '少见', '稀有', '传说'];
const RARITY_W = { t1: { '废料': 45, '常见': 40, '少见': 12, '稀有': 2.8, '传说': 0.2 }, t2: { '废料': 38, '常见': 36, '少见': 20, '稀有': 5.5, '传说': 0.5 }, t3: { '废料': 38, '常见': 32, '少见': 24, '稀有': 5, '传说': 1 }, t4: { '废料': 48, '常见': 24, '少见': 19, '稀有': 7.5, '传说': 1.5 } };

function simulate(version, n) {
  let unsold = 0, sold = 0, premium = 0, fair = 0, cheap = 0, totalRatio = 0, premRatioSum = 0, premCount = 0;
  for (let i = 0; i < n; i++) {
    const rng = mulberry32(i * 2654435761 + 7);
    const V = round50(2000 + rng() * 20000); // 隐藏价值
    const market = rng() < 0.25 ? 'cold' : rng() < 0.75 ? 'normal' : 'hot';
    const rarity = RAR[Math.floor(rng() * 5)];
    let present, interest, likeB, startLo, startSpan, whale;
    if (version === 'old') {
      present = Math.min(8, Math.max(3, 4 + Math.floor(rng() * 3) + (market === 'hot' ? 1 : market === 'cold' ? -1 : 0)));
      interest = { '废料': 0.25, '常见': 0.5, '少见': 0.7, '稀有': 0.85, '传说': 0.95 }[rarity];
      likeB = 0.3; startLo = 0.3; startSpan = 0.15; whale = false;
    } else {
      present = Math.min(7, Math.max(2, 3 + Math.floor(rng() * 3) + (market === 'hot' ? 1 : market === 'cold' ? -1 : 0)));
      interest = { '废料': 0.12, '常见': 0.3, '少见': 0.48, '稀有': 0.62, '传说': 0.78 }[rarity];
      likeB = 0.22; startLo = 0.38; startSpan = 0.2; whale = true;
    }
    const pool = [...AI].sort(() => rng() - 0.5).slice(0, present);
    const cands = [];
    for (const ai of pool) {
      const like = (ai.like && ai.like.includes('bangle')) || (ai.lv && ai.lv.includes('ice'));
      const p = interest + (like ? likeB : 0) + (market === 'hot' ? 0.12 : market === 'cold' ? -0.12 : 0);
      if (rng() > p) continue;
      const b = (ai.lo + rng() * (ai.hi - ai.lo)) * (like ? (ai.lm || 1) : 1);
      cands.push({ budget: round50(V * b) });
    }
    if (whale && cands.length > 0 && rng() < 0.18) {
      const w = cands[Math.floor(rng() * cands.length) % cands.length];
      w.budget = round50(w.budget * (1.5 + rng() * 1.3));
    }
    const startPrice = round50(V * (startLo + rng() * startSpan));
    const live = cands.filter((c) => c.budget >= startPrice * 1.02);
    let cur = startPrice, result = 'unsold', price = 0;
    if (live.length > 0) {
      const maxHands = 3 + Math.floor(rng() * 6);
      for (let hand = 0; hand < maxHands; hand++) {
        const willing = live.filter((c) => c.budget > cur * 1.02);
        if (!willing.length) break;
        const c = willing[Math.floor(rng() * willing.length)];
        const inc = 0.04 + rng() * 0.2;
        cur = round50(Math.min(c.budget, Math.round(cur * (1 + inc))));
        if (!live.some((x) => x.budget > cur * 1.02)) break;
      }
      result = 'sold'; price = cur;
    }
    if (result === 'unsold') unsold++;
    else {
      sold++;
      const r = price / V;
      totalRatio += r;
      if (r >= 1.15) { premium++; premRatioSum += r; premCount++; }
      else if (r >= 0.85) fair++;
      else cheap++;
    }
  }
  const n2 = n;
  console.log(`[${version}] 流拍率 ${(unsold / n2 * 100).toFixed(1)}% | 成交 ${(sold / n2 * 100).toFixed(1)}%（premium ${(premium / n2 * 100).toFixed(1)}% / fair ${(fair / n2 * 100).toFixed(1)}% / cheap ${(cheap / n2 * 100).toFixed(1)}%）| 成交均价/V ${(totalRatio / Math.max(1, sold)).toFixed(2)} | 溢价单均价/V ${premCount ? (premRatioSum / premCount).toFixed(2) : '-'}`);
}
simulate('old', 20000);
simulate('new', 20000);
