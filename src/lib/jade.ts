/* 玉石鉴定（赌石）：买料 → 手动打磨切割 → 开出玉石品种 → 卖出得时元 / 收藏进柜
 * 玉器工坊：切开的料子可DIY打磨成成品（手镯/手链/吊坠/戒指/耳坠/摆件），可转赠对方；
 * 打磨只扣这一件的用料克数，剩下的算余料——可继续打磨，也可直接卖出
 * 提纯工坊（2026-10-10）：任何一颗玉石都有「纯度」，投提纯剂可把纯度往上提，
 * 越接近该石头的「极限纯度」（95%~100%）单克价越高，提到顶就是它这一生的天花板价
 * 同步三件套：版本守卫 lastV + 按 id 合并 + 状态墓碑（uncut→cut→sold/kept/crafted，永不复活）
 */
import { sharedSubscribe, sharedPublish, onSharedResync } from './mqttClient';
import { isGuestSession } from './guest';
import { addTx } from './wallet';
import { isPairMember, membersKnown, partnerOf } from './space';

/* ---------- 石头档位 ---------- */
export interface StoneTier {
  id: string;
  name: string;
  price: number;
  emoji: string;          // 兜底占位，正常显示 AI 生图
  /** 切割小游戏难度：绿区宽度百分比（越小越难） */
  zone: number;
}

/* 2026-10-02 原石基础价翻四倍：买料门槛抬高，开出垃圾更肉疼，好料更值钱
 * 2026-10-02 晚：帝王料降 2w（12w→10w）；绿区统一加宽到占轨道一半（zone=50），按住好对齐
 * 2026-10-03 克价重定价后回调：估值 = 克数 × 品种克价 × (0.8~1.2)，四档「期望回收 ÷ 料价」
 * 对齐到 ~21%（t1 0.22 / t2 0.21 / t3 0.21 / t4 0.22）：高等级料单块更值钱（克重大+高稀有度概率高），
 * 但每块钱期望值不再倒挂——旧倍数区间下帝王料期望回收超过料价，沦为印钞机 */
export const STONE_TIERS: StoneTier[] = [
  { id: 't1', name: '山料小石', price: 5000, emoji: '🪨', zone: 50 },
  { id: 't2', name: '水翻砂石', price: 15000, emoji: '🪨', zone: 50 },
  { id: 't3', name: '老坑蒙头料', price: 40000, emoji: '🪨', zone: 50 },
  { id: 't4', name: '帝王料', price: 80000, emoji: '🪨', zone: 50 },
  /* 2026-10-20 星陨料：天外来石。九成切空（血本无归），一成必出神话档，
   * 且伴生小料全是神话/传说系（多玉融合）。zone 调窄一点，切的时候更紧张 */
  { id: 't5', name: '星陨料', price: 80000, emoji: '☄️', zone: 44 },
];

/** 星陨料切空的概率（其余必出神话档主料） */
export const T5_VOID_RATE = 0.9;

/* ---------- 玉石品种表（常见 → 罕见） ---------- */
export interface JadeVariety {
  id: string;
  name: string;
  rarity: '废料' | '常见' | '少见' | '稀有' | '传说' | '神话';
  emoji: string;          // 框架期占位，后续换豆包生图
  /** 克价（时元/克）：2026-10-03 重定价，估值 = 克数 × 克价 × (0.8~1.2)，
   *  同稀有度内各品种克价差异 ≤ ±15%，等级越高的料越值钱；炫彩玉 = 全场最高克价（950，神话档） */
  gramPrice: number;
  color: string;          // 展示主色
}

export const JADE_VARIETIES: JadeVariety[] = [
  { id: 'marble', name: '大理石纹', rarity: '废料', emoji: '⬜', gramPrice: 9, color: '#b8b2aa' },
  { id: 'doudi', name: '豆种翡翠', rarity: '常见', emoji: '🟩', gramPrice: 32, color: '#7fae6e' },
  { id: 'nuo', name: '糯种翡翠', rarity: '常见', emoji: '🍚', gramPrice: 36, color: '#cfe0b8' },
  { id: 'bingnuo', name: '冰糯种', rarity: '少见', emoji: '🧊', gramPrice: 82, color: '#d8ece2' },
  { id: 'qingshui', name: '晴水翡翠', rarity: '少见', emoji: '🏞️', gramPrice: 88, color: '#9fd4c8' },
  { id: 'yellow', name: '黄翡', rarity: '少见', emoji: '🟨', gramPrice: 95, color: '#e8b84a' },
  { id: 'red', name: '红翡', rarity: '少见', emoji: '🟥', gramPrice: 102, color: '#c94f38' },
  { id: 'mo', name: '墨翠', rarity: '稀有', emoji: '⬛', gramPrice: 195, color: '#2e3b35' },
  { id: 'violet', name: '紫罗兰', rarity: '稀有', emoji: '🟪', gramPrice: 215, color: '#a98fd0' },
  { id: 'ice', name: '冰种翡翠', rarity: '稀有', emoji: '💠', gramPrice: 235, color: '#bfe3ea' },
  { id: 'highice', name: '高冰种', rarity: '稀有', emoji: '💎', gramPrice: 258, color: '#d6f0f5' },
  { id: 'glass', name: '玻璃种', rarity: '传说', emoji: '🔮', gramPrice: 545, color: '#eaf7fb' },
  { id: 'emperor', name: '帝王绿', rarity: '传说', emoji: '👑', gramPrice: 598, color: '#1f7a3d' },
  /* —— 新矿脉（2026-10）：金银双色 + 春彩紫 + 蓝水系 —— */
  { id: 'tiedsheng', name: '铁龙生', rarity: '常见', emoji: '🌿', gramPrice: 37, color: '#3f9d4e' },
  { id: 'silvermetal', name: '白银', rarity: '少见', emoji: '🥈', gramPrice: 97, color: '#c9ccd4' },
  { id: 'bluewater', name: '蓝水翡翠', rarity: '少见', emoji: '💧', gramPrice: 84, color: '#4f9fd8' },
  { id: 'spring', name: '桃花春', rarity: '稀有', emoji: '🌸', gramPrice: 232, color: '#e59ec4' },
  { id: 'skyblue', name: '天空蓝', rarity: '稀有', emoji: '🩵', gramPrice: 205, color: '#87ceeb' },
  { id: 'deepblue', name: '深海蓝', rarity: '稀有', emoji: '🌊', gramPrice: 222, color: '#1e4f8f' },
  { id: 'goldmetal', name: '黄金', rarity: '稀有', emoji: '🥇', gramPrice: 250, color: '#d4a017' },
  { id: 'royalviolet', name: '帝王紫', rarity: '传说', emoji: '💜', gramPrice: 470, color: '#7b2d8b' },
  { id: 'goldsand', name: '金砂种', rarity: '传说', emoji: '✨', gramPrice: 500, color: '#e6c25a' },
  { id: 'gilded', name: '鎏金翡翠', rarity: '传说', emoji: '🌟', gramPrice: 562, color: '#f0d060' },
  /* —— 神话档（2026-10-05 红色新档，高于帝王绿；任何石头都有可能开出，炫彩玉单次≥150g） —— */
  { id: 'bloodjade', name: '血玉', rarity: '神话', emoji: '🩸', gramPrice: 680, color: '#8f1220' },
  { id: 'chixia', name: '赤霞', rarity: '神话', emoji: '🌇', gramPrice: 720, color: '#d94f2b' },
  { id: 'rainbow', name: '炫彩玉', rarity: '神话', emoji: '🌈', gramPrice: 950, color: '#c9a6e8' },
];

export const varietyById = (id: string): JadeVariety =>
  JADE_VARIETIES.find((v) => v.id === id) ?? JADE_VARIETIES[0];

/* ---------- 每日运势（按本地日期字符串哈希，多端同一天结果一致） ---------- */
function dayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 2026-10-02 修「今日高价/今日好料天天不换」：相邻日期的 h*31 原始哈希差只有
 *  1/2^32 量级，直接 floor(×N) 取模几乎永远落同一桶——取模前先做一次雪崩混洗
 *  （mulberry32 同款 finalizer），让相差一个字符的输入也均匀散开。
 *  注意：只用于「按日取值」；hash01 本身保持原样（老石头克重回补靠它确定性）。 */
function dayHash01(s: string): number {
  let h = (hash01(s) * 4294967296) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 今日爆单品：当天这个品种的回收价翻倍（卖出时自然体现在报价上，不广而告之） */
export function hotVarietyOfDay(): string {
  return JADE_VARIETIES[Math.floor(dayHash01(`hot|${dayKey()}`) * JADE_VARIETIES.length) % JADE_VARIETIES.length].id;
}

/** 今日高概率档：该档原石开出稀有/传说品种的概率翻倍（自由探索，不标注） */
export function luckyTierOfDay(): string {
  return STONE_TIERS[Math.floor(dayHash01(`lucky|${dayKey()}`) * STONE_TIERS.length) % STONE_TIERS.length].id;
}

/* ---------- 克重：按档位 + 品种稀有度滚动；老数据按 id 确定性回补 ---------- */

const TIER_GRAMS: Record<string, [number, number]> = {
  t1: [20, 80],
  t2: [60, 160],
  t3: [100, 260],
  t4: [150, 380],
  t5: [300, 520],
};

const RARITY_GRAM_FACTOR: Record<string, number> = {
  废料: 0.7, 常见: 1, 少见: 1.1, 稀有: 1.2, 传说: 1.3, 神话: 1.5,
};

/** id 字符串哈希 → [0,1)，存量石头补克重时 deterministic，多端一致 */
function hash01(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h / 4294967296;
}

/** 品种保底克重（2026-10-05 炫彩玉单次开出不少于 150g） */
const MIN_GRAMS: Record<string, number> = {
  rainbow: 150,
};

function gramsFor(tierId: string, varietyId: string, seed: string): number {
  const [lo, hi] = TIER_GRAMS[tierId] ?? TIER_GRAMS.t1;
  const f = RARITY_GRAM_FACTOR[varietyById(varietyId).rarity] ?? 1;
  const g = Math.round((lo + hash01(seed) * (hi - lo)) * f);
  return Math.max(MIN_GRAMS[varietyId] ?? 0, g);
}

/** 克数缺失（老石头）时按 id 回补，保证两台设备算出来一致；0 = 已整块打完，不回补 */
function withGrams(s: OwnedStone): OwnedStone {
  return typeof s.grams === 'number' && s.grams >= 0
    ? s
    : { ...s, grams: gramsFor(s.tierId, s.varietyId, s.id) };
}

/* ---------- 提纯（2026-10-10）---------------------------------------------
 * 一颗玉石的价值 = 克数 × 品种克价 × 纯度系数
 *  · 纯度系数 = purityCoef(purity)：0.6 → 1.6。purity=100% 时 1.6，
 *    也就是「克数 × 品种克价 × 1.6」= 这个品种能达到的最高价（天花板）
 *  · 极限纯度 goalPurity ∈ [0.95, 1.00]：这颗石头一生能达到的天花板（95%~100% 纯度不等）
 *  · 提纯只往上抬 purity，直到 goalPurity 封顶；封顶后再投料纯属浪费，UI 会拦住
 *
 * ★ 与老数据强一致的核心口径（务必看懂再改）★
 *  老石头的 value 是「克数 × 品种克价 × (0.8~1.2)」算出来的，这个数**绝不能变**。
 *  所以纯度不是凭空抽的，而是**从 value 反解出来**：
 *     价值系数 = value / (克数 × 品种克价)     ∈ 0.8~1.2（老石头）
 *     纯度     = purityCoef⁻¹(价值系数)        落在 25%~58% 区间
 *  等价地说：老石头天生纯度就不高，提纯正好有「把它养到 100%」的空间；
 *  而提纯前后同一块石头的价值一分钱都不会凭空涨跌（纯属新增字段）。
 * ------------------------------------------------------------------------ */

/** 提纯上限的浮动范围（= 用户说的「95% 到 100% 纯度不等」） */
export const GOAL_MIN = 0.95;
export const GOAL_MAX = 1.0;

/**
 * 提纯剂：**不花时元，改去农场自己合成**（配方见 lib/farm.ts 的提纯剂合成线）。
 *  · 三档效果拉开差距（越高级抬得越多）：
 *      草木 +5 点 → 从任意起点最多 20 只到顶
 *      寒泉 +12 点 → 最多 9 只到顶
 *      龙涎 +25 点 → 最多 4 只到顶（最强，也最难合）
 *  · 每次提纯固定消耗 1 只（doses 恒为 1），差距直接体现在纯度涨幅上。
 *  · 三种剂还区别在「好不好合出来」——越高级的剂，合成越依赖仙品作物 / 特殊种子作物。
 */
export type PurifierId = 'basic' | 'fine' | 'supreme';

export interface Purifier {
  id: PurifierId;
  name: string;
  emoji: string;
  desc: string;
  /** 一次提纯抬升的纯度百分点（草木 5 / 寒泉 12 / 龙涎 25） */
  power: number;
}

/** 草木提纯剂：每次 +5 点纯度 */
export const PURIFY_STEP_BASIC = 5;
/** 寒泉提纯剂：每次 +12 点纯度 */
export const PURIFY_STEP_FINE = 12;
/** 龙涎提纯剂：每次 +25 点纯度 */
export const PURIFY_STEP_SUPREME = 25;
/** 兜底默认步长（兼容未指定剂型的调用） */
export const PURIFY_STEP_PCT = PURIFY_STEP_BASIC;

/** 按剂型取每次抬升的百分点：越高级抬得越多 */
export const purifyStepOf = (purifierId: string): number =>
  purifierId === 'supreme' ? PURIFY_STEP_SUPREME
    : purifierId === 'fine' ? PURIFY_STEP_FINE
      : PURIFY_STEP_BASIC;

export const PURIFIERS: Purifier[] = [
  { id: 'basic', name: '草木提纯剂', emoji: '🌿', desc: '山涧草木灰熬的土方，灵田常见作物就能合 · 每次 +5% 纯度', power: PURIFY_STEP_BASIC },
  { id: 'fine', name: '寒泉提纯剂', emoji: '💧', desc: '雪山寒泉配的方子，要几味仙品作物才熬得出 · 每次 +12%', power: PURIFY_STEP_FINE },
  { id: 'supreme', name: '龙涎提纯剂', emoji: '🔥', desc: '传说中的龙涎玉髓，靠特殊种子作物的仙品才提得动 · 每次 +25%', power: PURIFY_STEP_SUPREME },
];

export const purifierById = (id: string): Purifier =>
  PURIFIERS.find((p) => p.id === id) ?? PURIFIERS[0];

/** 纯度 → 价格系数：线性主项 + 一段凹曲线做每级加成（1~1.6，p=1 即品种天花板）。
 *  修约成 4 位小数，避免不同设备浮点尾数差在同步包里互相判「内容变了」而无限回发。 */
export function purityCoef(purity: number): number {
  const p = Math.min(1, Math.max(0, purity));
  return Math.round((0.6 + p * 0.8 + 0.2 * (p * p)) * 10000) / 10000;
}

/** 纯度系数反解：给定隐含倍数（value / 基准单克价，理论 0.8~1.2）求对应纯度。
 *  用二分求逆（purityCoef 单调递增），保证与 purityCoef 严格互逆。 */
function purityFromCoef(coef: number): number {
  const c = Math.min(purityCoef(1), Math.max(purityCoef(0), coef));
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (purityCoef(mid) < c) lo = mid; else hi = mid;
  }
  return round4((lo + hi) / 2);
}

/** 由价值系数反解纯度并夹到 [0, goal]（老石头/新石头共用同一条「价值↔纯度」换算） */
function deriveCoefPurity(coef: number, goal: number): number {
  return Math.min(goal, purityFromCoef(coef));
}

/** 纯度高低的展示分档 */
export type PurityGrade = '粗' | '普' | '净' | '润' | '莹' | '灵' | '通' | '绝';

export function purityGrade(purity: number): PurityGrade {
  const p = purity * 100;
  if (p < 50) return '粗';
  if (p < 60) return '普';
  if (p < 70) return '净';
  if (p < 80) return '润';
  if (p < 88) return '莹';
  if (p < 94) return '灵';
  if (p < 99) return '通';
  return '绝';
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** 纯度缺失（老石头/玉砖）时按 id 反解回补，两台设备算出同一个值（value 是同一个数） */
function withPurity(s: OwnedStone): OwnedStone {
  const goal = typeof s.goalPurity === 'number'
    ? round4(Math.min(GOAL_MAX, Math.max(GOAL_MIN, s.goalPurity)))
    : round4(GOAL_MIN + hash01(`${s.id}|goal`) * (GOAL_MAX - GOAL_MIN));
  if (typeof s.purity === 'number') {
    // 纯度恒受 goal 约束：老数据/异常值一律夹到 [0.05, goal]，防止「纯度超顶」破相
    const purity = round4(Math.min(goal, Math.max(0.05, s.purity)));
    return s.goalPurity === goal && s.purity === purity ? s : { ...s, goalPurity: goal, purity };
  }
  // 反解出来的纯度若已超过 goal（提纯过的石头隔代回补），以 goal 为顶
  return { ...s, goalPurity: goal, purity: round4(Math.max(0.1, deriveCoefPurity(deriveCoefOf(s), goal))) };
}

/** 从石头现值反解「价值系数」= value / (克数 × 品种克价) */
function deriveCoefOf(s: OwnedStone): number {
  const perGram = (s.grams ?? 0) * varietyById(s.varietyId).gramPrice;
  if (perGram <= 0) return 1;
  return s.value / perGram;
}

/* ---------- 提纯剂库存 ----------
 * 关键难点：提纯剂是「会减少」的资源，不能像石头那样取 max（否则两台设备各扣各的、
 * 合并时又被 max 顶回来 = 无限刷剂）。这里用「买卖累加器」的标准 CRDT：
 *   produced[type] = 累计合成只数（只增，来自农场合成）
 *   consumed[type] = 累计消耗只数（只增，提纯时消耗）
 *   available[type] = max(0, produced - consumed)
 * 两个计数器都按人、按剂型取 max，天然单调、可交换、可结合，跨端必然收敛，
 * 且「合成了/用了」既不会被顶回，也不会凭空冒出来。
 */
export interface ReagentLedger {
  produced?: Record<string, number>;
  consumed?: Record<string, number>;
}

function normLedger(v: unknown): ReagentLedger {
  // 兼容旧格式（老包里 reagents[who] 直接是「剩余份数」的数字）：当作 produced 处理
  if (typeof v === 'number') return { produced: { basic: Math.max(0, Math.floor(v)) }, consumed: {} };
  if (v && typeof v === 'object') {
    const o = v as { produced?: unknown; consumed?: unknown; bought?: unknown; spent?: unknown };
    // 兼容更早的 {bought, spent} 单剂型账本 → 归到基础剂
    if (typeof o.bought === 'number' || typeof o.spent === 'number') {
      return {
        produced: { basic: Math.max(0, Math.floor(Number(o.bought) || 0)) },
        consumed: { basic: Math.max(0, Math.floor(Number(o.spent) || 0)) },
      };
    }
    const numMap = (m: unknown): Record<string, number> => {
      const out: Record<string, number> = {};
      if (m && typeof m === 'object') {
        for (const [k, n] of Object.entries(m as Record<string, unknown>)) {
          out[k] = Math.max(0, Math.floor(Number(n) || 0));
        }
      }
      return out;
    };
    return { produced: numMap(o.produced), consumed: numMap(o.consumed) };
  }
  return {};
}

function mergeNumMap(a: Record<string, number> | undefined, b: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = { ...(a ?? {}) };
  for (const [k, v] of Object.entries(b ?? {})) out[k] = Math.max(out[k] ?? 0, v ?? 0);
  return out;
}

function mergeReagents(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): Record<string, ReagentLedger> {
  const out: Record<string, ReagentLedger> = {};
  for (const src of [a ?? {}, b ?? {}]) {
    for (const [who, raw] of Object.entries(src)) {
      const cur = normLedger(raw);
      const prev = out[who];
      out[who] = prev
        ? { produced: mergeNumMap(prev.produced, cur.produced), consumed: mergeNumMap(prev.consumed, cur.consumed) }
        : cur;
    }
  }
  return out;
}

/** 从账本算出「某人某种提纯剂还剩几只」 */
function availableOf(ledger: ReagentLedger | undefined, purifierId: string): number {
  if (!ledger) return 0;
  const p = ledger.produced?.[purifierId] ?? 0;
  const c = ledger.consumed?.[purifierId] ?? 0;
  return Math.max(0, p - c);
}

/* ---------- 玉器工坊：器型 / 配件 / 绳链 ---------- */

export interface CraftType {
  id: string;
  name: string;
  emoji: string;
  /** 用料克重：打磨这一件只吃掉这么多克，剩下的全算余料（可继续打磨 / 卖出） */
  useG: number;
  /** 成品价值 = 料子分摊价值 × mult × 配件加成 */
  mult: number;
  /** 是否需要选绳链 */
  cord: boolean;
}

export const CRAFT_TYPES: CraftType[] = [
  { id: 'bangle', name: '玉手镯', emoji: '⭕', useG: 500, mult: 1.2, cord: false },
  { id: 'bracelet', name: '串珠手链', emoji: '📿', useG: 400, mult: 0.9, cord: true },
  { id: 'pendant', name: '平安扣吊坠', emoji: '🧿', useG: 500, mult: 1.1, cord: true },
  { id: 'ring', name: '玉戒指', emoji: '💍', useG: 300, mult: 0.8, cord: false },
  { id: 'earrings', name: '耳坠', emoji: '👂', useG: 200, mult: 0.85, cord: true },
  { id: 'ornament', name: '小摆件', emoji: '🏔️', useG: 2000, mult: 1.3, cord: false },
];

export const craftTypeById = (id: string): CraftType =>
  CRAFT_TYPES.find((t) => t.id === id) ?? CRAFT_TYPES[0];

export const CRAFT_METALS = [
  { id: 'none', name: '素件', mult: 1 },
  { id: 'silver', name: '925银镶', mult: 1.05 },
  { id: 'gold', name: '18K金镶', mult: 1.15 },
] as const;

export const CRAFT_CORDS = [
  { id: 'red', name: '红绳' },
  { id: 'black', name: '黑绳' },
  { id: 'leather', name: '皮绳' },
  { id: 'silver-chain', name: '银链' },
  { id: 'gold-chain', name: '金链' },
  { id: 'elastic', name: '弹力线' },
] as const;

export const metalById = (id: string) => CRAFT_METALS.find((m) => m.id === id) ?? CRAFT_METALS[0];
export const cordById = (id: string) => CRAFT_CORDS.find((c) => c.id === id) ?? CRAFT_CORDS[0];

/* ---------- 每个档位开出各稀有度的权重（期望回收 < 石价，长期必亏，娱乐消耗）
 * 2026-10-02 低品质料子难以开出高品质：t1/t2 的稀有/传说几乎压没，高货集中到老坑/帝王料
 * 2026-10-05 神话档（血玉/赤霞/炫彩玉）：任何石头都有可能开出；权重 ×10 取整，
 *  每档必须 ≥0.05 否则 round 成 0 永远摇不出（t1 也给 0.06 保持"有可能"） */
const TIER_WEIGHTS: Record<string, Record<string, number>> = {
  t1: { '废料': 52, '常见': 40, '少见': 7, '稀有': 0.9, '传说': 0.1, '神话': 0.06 },
  t2: { '废料': 44, '常见': 40, '少见': 14, '稀有': 1.8, '传说': 0.2, '神话': 0.12 },
  t3: { '废料': 36, '常见': 34, '少见': 22, '稀有': 7, '传说': 1, '神话': 0.3 },
  t4: { '废料': 40, '常见': 22, '少见': 22, '稀有': 12, '传说': 4, '神话': 0.8 },
  /* 星陨料的伴生小料只落在高货系（神话/传说/稀有）：开出来就是「多玉融合」 */
  t5: { '废料': 0, '常见': 0, '少见': 0, '稀有': 2, '传说': 3, '神话': 1.4 },
};

/** 玉砖：任意碎料/大料凑满 5000g 合成一块，可挂上拍卖会（黄金 = 金砖）
 *  2026-10-10 提纯上线后：玉砖 = 一块整克重的玉石，同样有纯度，按入炉料子的
 *  加权平均纯度铸成（提纯过的料子铸砖不会白提）
 *  2026-10-20 改 5000g/块 大规格；存量旧 1000g 砖在读取时自动解锁回普通玉石（见 withBrickFix） */
export const BRICK_TIER_ID = 'brick';
export const BRICK_GRAMS = 5000;
/** 旧砖规格（2026-10-20 前）：一块恒为 1000g，读到就解锁回玉料 */
const BRICK_GRAMS_V1 = 1000;
export const isBrick = (s: OwnedStone): boolean => s.tierId === BRICK_TIER_ID;
export const brickNameOf = (varietyId: string): string =>
  varietyId === 'goldmetal' ? '金砖' : varietyId === 'silvermetal' ? '银砖' : '玉砖';

/** 品种稀有度 → 存量旧砖解锁后的档位（粒度按稀有度回档，multi 端纯函数一致） */
const RARITY_TIER: Record<string, string> = {
  废料: 't1', 常见: 't2', 少见: 't3', 稀有: 't4', 传说: 't5', 神话: 't5',
};

/** 2026-10-20 砖改 5000g 规格：存量旧 1000g 砖解锁回普通玉石（同品种同克数同估值，
 *  档位按品种稀有度回档），可重新卖/打磨/入炉。判定只看 grams ≤ 旧规格——
 *  新炉铸出的砖恒为 5000g，不会被误伤；纯函数无副作用，两台设备各自算出同结果。 */
function withBrickFix(s: OwnedStone): OwnedStone {
  if (s.tierId !== BRICK_TIER_ID) return s;
  if ((s.grams ?? BRICK_GRAMS_V1) > BRICK_GRAMS_V1) return s;
  return { ...s, tierId: RARITY_TIER[varietyById(s.varietyId).rarity] ?? 't1' };
}

/* ---------- 状态 ---------- */
/** auction = 已送上拍卖会锁定（玉缘拍卖会专用，cut/kept → auction → sold/kept，单向推进） */
export type StoneStatus = 'uncut' | 'cut' | 'auction' | 'sold' | 'kept' | 'crafted';

/** 本机单调时钟：两台手机系统时间有偏差时，保证本机后写的记录 ts/upd 严格更大 */
let monoTs = 0;
function nowTs(): number {
  monoTs = Math.max(monoTs, Date.now());
  return monoTs;
}

export interface OwnedStone {
  id: string;            // `${who}-${Date.now()}-${rand}`
  tierId: string;
  varietyId: string;     // 开出品种（克数/估值整块都记在它名下，不做共生拆分）
  value: number;         // 回收价（时元，整块余料当前总值）——已含纯度系数
  grams?: number;        // 克重（2026-09 新增；老数据读取时按 id 确定性回补）
  /** 纯度 0~1（2026-10-10 新增；老数据按 id 确定性回补，恒 ≤ goalPurity） */
  purity?: number;
  /** 这块石头一生能达到的极限纯度 [0.95, 1.00]，提纯封顶线，写入后不变 */
  goalPurity?: number;
  /** 最近一次状态/克数变更时间（切/卖/收藏/上拍/打磨都刷新；合并时同状态比它分先后） */
  upd?: number;
  status: StoneStatus;
  by: string;            // 谁买的
  ts: number;            // 购买时间
  cutTs?: number;
  /** 星陨料的「空芯」标记：买下时就已注定切开来什么都没有（切完结成 sold，值归零） */
  void?: boolean;
}

/** 工坊成品：从料子里打磨（只吃用料克数，余料留在原石上），记入成品柜，可转赠对方 */
export interface JadeProduct {
  id: string;            // `p-${who}-${Date.now()}-${rand}`
  by: string;            // 当前持有者
  maker: string;         // 打造者（转赠后仍留名）
  varietyId: string;
  typeId: string;        // CRAFT_TYPES
  grams: number;         // 用料克重（只吃这么多，其余留作余料）
  metalId: string;
  cordId: string | null; // 不需要绳链的器型为 null
  engraving: string;     // 刻字（可空）
  name: string;          // 成品名（已拼好）
  value: number;         // 估值（时元）
  art?: string;          // AI 定制成品图的 key（= 成品 id），图本身走 jade/art/<id> 通道
  ts: number;            // 最近一次变更（打造/转赠/AI 图），合并按新的赢
  giftTs?: number;       // 转赠时间
  /** 拍卖会锁定/已成交：undefined=正常在柜；auction=上拍锁定；sold=拍卖成交交割 */
  status?: 'auction' | 'sold';
}

/** 折叠归档（2026-10-10 新增）：终端态石头的压缩账。
 *  sold / crafted 是单向终点、永不复活（见 ORDER 注释），全量留在状态包里只会把
 *  首登同步拖慢——实测 2349 条石头 738KB，其中 sold+crafted 1798 条占 382KB（52%）。
 *  折叠后：
 *  - `sold` 石头只需要 jadeStats 的 earned（= value）与 spent（= tier.price）：转到计数器；
 *  - `crafted` 石头（grams=0/value=0 纯墓碑）无人读取：只留 id 墓碑防复活。
 *  两端内容一致 → 折掉的是同一批 → 计数器「取大」合并必然收敛。 */
interface JadeArchive {
  /** 已折叠历史收入：sold 石头的 value 合计（每人，只增不减，合并取大） */
  earned: Record<string, number>;
  /** 已折叠历史投入：sold 石头的 tier.price 合计（每人，只增不减，合并取大） */
  spent: Record<string, number>;
  /** 已折叠石头的 id 墓碑：防「计数器 + 活体明细」双算、防旧包重投复活（两端取并集） */
  ids: string[];
  /** 已折叠成品的件数：sold 成品只用于 jadeStats().crafted 计数（每人，只增不减，合并取大）
   *  2026-10-10 新增；老数据无此字段 = 0 */
  soldProducts?: Record<string, number>;
  /** 已折叠成品的 id 墓碑（两端取并集） */
  productIds?: string[];
}

interface JadeState {
  stones: Record<string, OwnedStone>;   // 按 id 合并，状态取“更靠后”的
  products: Record<string, JadeProduct>; // 按 id 合并，ts 新的赢
  /**
   * 提纯剂账本：谁合成了多少 / 用了多少（都是只增累加器，见 ReagentLedger 注释）。
   * 2026-10-10 新增，老数据无此字段 = 都没有
   */
  reagents: Record<string, ReagentLedger>;
  /** 终端态石头折叠归档（2026-10-10 新增，老数据无此字段 = 还没折过） */
  arch?: JadeArchive;
  v: number;
}

const TOPIC = 'lovesite/jade/state';
const BACKUP = 'lovesite-jade-backup';
/** 折叠保留窗口：最近 3 天的终端态石头不折（近期账单留一点可读性，边界由数据本身决定 → 两端一致） */
const FOLD_WINDOW = 3 * 24 * 3600 * 1000;
/** 硬上限兜底：活体石头超这个数就从最老的终端态开始折（极端爆量时） */
const MAX_LIVE_STONES = 900;
/** 折叠墓碑上限（超出丢最旧，仅影响远古记录的极端重投） */
const MAX_ARCH_IDS = 4000;
/** 终端态：单向终点，永不复活（ORDER 里 sold/crafted = 4） */
const isTerminal = (s: OwnedStone): boolean => s.status === 'sold' || s.status === 'crafted';

let state: JadeState = { stones: {}, products: {}, reagents: {}, v: 0 };
let lastV = 0;
/** 折叠归档（与 state.arch 同步，便于频繁读写） */
let archEarned: Record<string, number> = {};
let archSpent: Record<string, number> = {};
let archIds: string[] = [];
const archIdSet = new Set<string>();
let archSoldProducts: Record<string, number> = {};
let archProductIds: string[] = [];
const archProductIdSet = new Set<string>();
let started = false;
const listeners = new Set<() => void>();

function emit() { listeners.forEach((f) => f()); }
function saveBackup() { try { localStorage.setItem(BACKUP, JSON.stringify(state)); } catch { /* ignore */ } }

/** 登记折叠墓碑：已计入归档计数器的石头 id，重投/重折叠时一律跳过 */
function addArchTombstones(ids: string[]) {
  for (const id of ids) {
    if (archIdSet.has(id)) continue;
    archIdSet.add(id);
    archIds.push(id);
  }
  while (archIds.length > MAX_ARCH_IDS) archIdSet.delete(archIds.shift()!);
}

/** 把石头折叠进归档计数器（sold 计收入+投入；crafted 只记墓碑）。
 *  边界由石头数据本身决定（最新终端态石头的 ts 往前 FOLD_WINDOW）：两端内容一致 →
 *  折掉的是同一批 → 计数器取大合并后依然精确。 */
function foldTerminalStones(): number {
  const entries = Object.entries(state.stones);
  if (entries.length === 0) return 0;
  // 折叠时间基准取「最后一次变更」（upd 优先，退回 ts）：刚卖/刚打磨完的石头
  // upd 是新的，必落在窗口内不被折——避免开奖卡/详情页还开着就被抽走
  const lastTouch = (s: OwnedStone): number => s.upd ?? s.ts ?? 0;
  let newestTerminalTs = 0;
  for (const [, s] of entries) {
    if (isTerminal(s) && lastTouch(s) > newestTerminalTs) newestTerminalTs = lastTouch(s);
  }
  const boundary = newestTerminalTs - FOLD_WINDOW;
  const drop = new Set<string>();
  for (const [id, s] of entries) {
    if (!isTerminal(s)) continue;
    if (archIdSet.has(id)) { drop.add(id); continue; } // 已在计数器里，剔除活体副本防双算
    if (lastTouch(s) < boundary) drop.add(id);
  }
  // 硬上限兜底：活体仍超量时，从最老的终端态继续折
  if (entries.length - drop.size > MAX_LIVE_STONES) {
    const rest = entries
      .filter(([id, s]) => isTerminal(s) && !drop.has(id))
      .sort((a, b) => lastTouch(a[1]) - lastTouch(b[1]));
    const need = entries.length - drop.size - MAX_LIVE_STONES;
    for (let i = 0; i < need && i < rest.length; i++) drop.add(rest[i][0]);
  }
  if (drop.size === 0) return 0;
  for (const id of drop) {
    if (archIdSet.has(id)) continue; // 已计入，不再累加
    const s = state.stones[id];
    if (s.status === 'sold') {
      archEarned[s.by] = (archEarned[s.by] ?? 0) + (s.value ?? 0);
      const tier = STONE_TIERS.find((t) => t.id === s.tierId);
      if (tier) archSpent[s.by] = (archSpent[s.by] ?? 0) + tier.price;
    }
  }
  addArchTombstones([...drop]);
  const stones: Record<string, OwnedStone> = {};
  for (const [id, s] of entries) {
    if (drop.has(id)) continue;
    stones[id] = s;
  }
  state = { ...state, stones, arch: archiveSnapshot() };
  return drop.size;
}

/** 折叠 sold 成品：只喂 jadeStats().crafted 计数（productsOf/jadeWealth 都排除 status 成品）。
 *  auction 状态的成品在架，必须留活体；sold 是终点，可安全折。 */
function foldSoldProducts(): number {
  const entries = Object.entries(state.products);
  if (entries.length === 0) return 0;
  const drop = new Set<string>();
  for (const [id, p] of entries) {
    if (archProductIdSet.has(id)) { drop.add(id); continue; }
    if (p.status === 'sold') drop.add(id);
  }
  if (drop.size === 0) return 0;
  for (const id of drop) {
    if (archProductIdSet.has(id)) continue;
    const p = state.products[id];
    if (p) archSoldProducts[p.by] = (archSoldProducts[p.by] ?? 0) + 1;
  }
  for (const id of drop) {
    if (archProductIdSet.has(id)) continue;
    archProductIdSet.add(id);
    archProductIds.push(id);
  }
  while (archProductIds.length > MAX_ARCH_IDS) archProductIdSet.delete(archProductIds.shift()!);
  const products: Record<string, JadeProduct> = {};
  for (const [id, p] of entries) {
    if (drop.has(id)) continue;
    products[id] = p;
  }
  state = { ...state, products, arch: archiveSnapshot() };
  return drop.size;
}

/** 归档快照（写进 state 一起同步） */
function archiveSnapshot(): JadeArchive {
  return {
    earned: { ...archEarned },
    spent: { ...archSpent },
    ids: [...archIds],
    soldProducts: { ...archSoldProducts },
    productIds: [...archProductIds],
  };
}

/** 合并对方的归档计数器（每人单调递增，取大即收敛）+ 折叠墓碑（取并集）；
 *  对方已折叠的石头本地若还挂着活体副本，按墓碑剔除——否则计数器 + 明细各算一次，富贵值/收入虚高 */
function mergeArchive(remote: JadeArchive | undefined): boolean {
  if (!remote || typeof remote !== 'object') return false;
  let changed = false;
  for (const [who, n] of Object.entries(remote.earned ?? {})) {
    if (typeof n === 'number' && n > (archEarned[who] ?? 0)) { archEarned[who] = n; changed = true; }
  }
  for (const [who, n] of Object.entries(remote.spent ?? {})) {
    if (typeof n === 'number' && n > (archSpent[who] ?? 0)) { archSpent[who] = n; changed = true; }
  }
  for (const [who, n] of Object.entries(remote.soldProducts ?? {})) {
    if (typeof n === 'number' && n > (archSoldProducts[who] ?? 0)) { archSoldProducts[who] = n; changed = true; }
  }
  if (Array.isArray(remote.ids) && remote.ids.length > 0) {
    const drop = new Set<string>();
    for (const id of remote.ids) {
      if (archIdSet.has(id)) continue;
      archIdSet.add(id);
      archIds.push(id);
      drop.add(id);
    }
    while (archIds.length > MAX_ARCH_IDS) archIdSet.delete(archIds.shift()!);
    if (drop.size > 0) {
      changed = true;
      const stones: Record<string, OwnedStone> = {};
      for (const [id, s] of Object.entries(state.stones)) {
        if (drop.has(id)) continue;
        stones[id] = s;
      }
      state = { ...state, stones };
    }
  }
  if (Array.isArray(remote.productIds) && remote.productIds.length > 0) {
    const pdrop = new Set<string>();
    for (const id of remote.productIds) {
      if (archProductIdSet.has(id)) continue;
      archProductIdSet.add(id);
      archProductIds.push(id);
      pdrop.add(id);
    }
    while (archProductIds.length > MAX_ARCH_IDS) archProductIdSet.delete(archProductIds.shift()!);
    if (pdrop.size > 0) {
      changed = true;
      const products: Record<string, JadeProduct> = {};
      for (const [id, p] of Object.entries(state.products)) {
        if (pdrop.has(id)) continue;
        products[id] = p;
      }
      state = { ...state, products };
    }
  }
  return changed;
}

/** 状态推进序：墓碑保序。
 *  2026-10-02 修重复卖：sold/crafted 是终端，必须压过 kept——
 *  旧序 sold/kept/crafted 同为 3，平级时按「克数少者赢 + 远端先入库」定胜负，
 *  一台 sold(克数不变) 遇到另一台的 kept 同克数平级时谁后合并谁说了算：
 *  持有 kept 旧包的设备会把 sold 顶回 kept（石头复活、可再卖一次、时元翻倍），
 *  且两端状态永不相等 → 互相广播刷个不停。 */
const ORDER: Record<StoneStatus, number> = { uncut: 0, cut: 1, auction: 2, kept: 3, sold: 4, crafted: 4 };

/** 同一石头两份记录谁更新（g = 候选，r = 已入库） */
function stoneWins(g: OwnedStone, r: OwnedStone): boolean {
  const a = ORDER[g.status] ?? 0, b = ORDER[r.status] ?? 0;
  if (a !== b) {
    // auction 与 kept 双向都合法（kept→auction 上拍 / auction→kept 流拍退回），分不清先后，用 upd 判；
    // 其余不同状态一律状态靠后的赢（单向生命周期 + 终端墓碑不复活）
    if ((g.status === 'auction' && r.status === 'kept') || (g.status === 'kept' && r.status === 'auction')) {
      return (g.upd ?? g.ts ?? 0) > (r.upd ?? r.ts ?? 0);
    }
    return a > b;
  }
  // 同状态：先比 upd（每次写入都刷新），再比克数（更少 = 被打磨/卖得更多，余料扣减不被旧包顶回）
  const gu = g.upd ?? g.ts ?? 0, ru = r.upd ?? r.ts ?? 0;
  if (gu !== ru) return gu > ru;
  return (g.grams ?? 0) < (r.grams ?? 0);
}

function scrubForeign(parsed: { stones?: Record<string, OwnedStone>; products?: Record<string, JadeProduct> }): number {
  if (!membersKnown() || !parsed || typeof parsed !== 'object') return 0;
  let removed = 0;
  if (parsed.stones) {
    for (const k of Object.keys(parsed.stones)) {
      if (!isPairMember(parsed.stones[k]?.by ?? k.split('-')[0])) { delete parsed.stones[k]; removed++; }
    }
  }
  if (parsed.products) {
    for (const k of Object.keys(parsed.products)) {
      if (!isPairMember(parsed.products[k]?.by ?? '')) { delete parsed.products[k]; removed++; }
    }
  }
  return removed;
}

function mergeJade(local: JadeState, remote: JadeState): JadeState {
  const stones: Record<string, OwnedStone> = {};
  for (const src of [remote.stones ?? {}, local.stones ?? {}]) {
    for (const [id, s] of Object.entries(src)) {
      const g = withBrickFix(withPurity(withGrams(s)));
      const r = stones[id];
      if (!r) { stones[id] = g; continue; }
      if (stoneWins(g, r)) stones[id] = g;
    }
  }
  // 成品按 ts 合并（打造/转赠都是单写者，ts 新的赢）
  const products: Record<string, JadeProduct> = { ...(remote.products ?? {}) };
  for (const [id, p] of Object.entries(local.products ?? {})) {
    const r = products[id];
    if (!r || (p.ts ?? 0) >= (r.ts ?? 0)) products[id] = p;
  }
  // 提纯剂库存按人取最大（只增不减，不会互相顶回）
  const reagents = mergeReagents(remote.reagents, local.reagents);
  // 归档计数器取大 + 墓碑取并集（单调，必然收敛）
  const arch = mergeArchObjs(local.arch, remote.arch);
  return { stones, products, reagents, arch, v: Math.max(local.v, remote.v) };
}

/** 纯函数版归档合并（不碰全局变量，供 mergeJade 用） */
function mergeArchObjs(local: JadeArchive | undefined, remote: JadeArchive | undefined): JadeArchive {
  const earned: Record<string, number> = { ...(local?.earned ?? {}) };
  const spent: Record<string, number> = { ...(local?.spent ?? {}) };
  const soldProducts: Record<string, number> = { ...(local?.soldProducts ?? {}) };
  for (const [who, n] of Object.entries(remote?.earned ?? {})) {
    if (typeof n === 'number' && n > (earned[who] ?? 0)) earned[who] = n;
  }
  for (const [who, n] of Object.entries(remote?.spent ?? {})) {
    if (typeof n === 'number' && n > (spent[who] ?? 0)) spent[who] = n;
  }
  for (const [who, n] of Object.entries(remote?.soldProducts ?? {})) {
    if (typeof n === 'number' && n > (soldProducts[who] ?? 0)) soldProducts[who] = n;
  }
  const ids: string[] = [...(local?.ids ?? [])];
  const seen = new Set(ids);
  for (const id of remote?.ids ?? []) {
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  const productIds: string[] = [...(local?.productIds ?? [])];
  const pseen = new Set(productIds);
  for (const id of remote?.productIds ?? []) {
    if (!pseen.has(id)) { pseen.add(id); productIds.push(id); }
  }
  return { earned, spent, ids, soldProducts, productIds };
}

/** 两个状态的内容是否一致（忽略 v；逐记录比对，key 集合不同也算不同） */
function sameJadeState(a: JadeState, b: JadeState): boolean {
  const eqRec = <T,>(x: Record<string, T>, y: Record<string, T>): boolean => {
    const kx = Object.keys(x);
    if (kx.length !== Object.keys(y).length) return false;
    return kx.every((k) => k in y && JSON.stringify(x[k]) === JSON.stringify(y[k]));
  };
  const eqLedger = (x: Record<string, ReagentLedger>, y: Record<string, ReagentLedger>): boolean => {
    const kx = Object.keys(x ?? {});
    if (kx.length !== Object.keys(y ?? {}).length) return false;
    return kx.every((k) => {
      const a = x[k], b = y[k];
      if (!b) return false;
      return JSON.stringify(a.produced ?? {}) === JSON.stringify(b.produced ?? {})
        && JSON.stringify(a.consumed ?? {}) === JSON.stringify(b.consumed ?? {});
    });
  };
  return eqRec(a.stones, b.stones) && eqRec(a.products, b.products)
    && eqLedger(a.reagents ?? {}, b.reagents ?? {})
    && JSON.stringify(a.arch ?? {}) === JSON.stringify(b.arch ?? {});
}

/** Lamport 版本：max(已见版本, 本地时钟) + 1。版本只认先后顺序，不认两台手机的时钟——
 * 直接用 Date.now() 时，慢时钟设备的发布会被对方永远判成"旧包"，对已有石头/成品的
 * 更新（切/卖/收藏/转赠）全部被丢，要等下一块新石头才会捎带同步
 * （farm.ts 2026-09 踩过同款坑，这里照抄修法）。 */
function bumpV(): number {
  lastV = Math.max(lastV, Date.now()) + 1;
  state = { ...state, v: lastV };
  return lastV;
}

function start() {
  if (started) return;
  started = true;
  try {
    const raw = localStorage.getItem(BACKUP);
    if (raw) {
      const b = JSON.parse(raw) as JadeState;
      if (b && typeof b.v === 'number') {
        scrubForeign(b);
        b.stones = Object.fromEntries(
          Object.entries(b.stones ?? {}).map(([k, s]) => [k, withBrickFix(withPurity(withGrams(s)))]),
        );
        b.products = b.products ?? {};
        // 老备份里 reagents[who] 可能是「剩余份数」的数字，统一转成 {bought,spent} 账本
        b.reagents = mergeReagents(b.reagents, undefined);
        state = b; lastV = b.v;
        // 折叠归档从备份恢复
        archEarned = { ...(b.arch?.earned ?? {}) };
        archSpent = { ...(b.arch?.spent ?? {}) };
        archIds = [...(b.arch?.ids ?? [])];
        for (const id of archIds) archIdSet.add(id);
        archSoldProducts = { ...(b.arch?.soldProducts ?? {}) };
        archProductIds = [...(b.arch?.productIds ?? [])];
        for (const id of archProductIds) archProductIdSet.add(id);
      }
    }
  } catch { /* ignore */ }
  // 老包没有 arch 字段（首次升级）：把已到期的终端态石头一次性折进计数器，
  // 顺带把残留墓碑剔出活体——这一步之后 state.stones 只剩非终端态 + 近期终态
  if (foldTerminalStones() > 0) saveBackup();
  if (foldSoldProducts() > 0) saveBackup();
  sharedSubscribe(TOPIC, (payload) => {
    if (payload.length === 0) return;
    try {
      const s = JSON.parse(payload.toString()) as JadeState;
      if (!s || typeof s.v !== 'number') return;
      const removedForeign = scrubForeign(s);
      // 无论版本新旧都先尝试按内容合并（按 id / 状态序 / ts 取新），
      // 合并出实际变化才采纳——旧逻辑在旧包里只看"有没有新 key"，
      // 慢时钟设备对已有石头/成品的更新（切/卖/收藏/转赠）会被整包丢弃
      const merged = mergeJade(state, s);
      // 合并后把对方的折叠墓碑落到本地（剔除已被对方折掉的活体副本，防计数器+明细双算）
      const archChanged = mergeArchive(s.arch);
      const changed = removedForeign > 0 || archChanged || !sameJadeState(state, merged);
      state = merged;
      if (s.v > lastV) lastV = s.v;
      if (changed) {
        state = { ...state, arch: archiveSnapshot() };
        foldTerminalStones(); // 收到远端大包后立即折一次，保持活体瘦身
        foldSoldProducts();
        saveBackup();
        emit();
        bumpV(); // 升版本回发合并结果：时钟偏大的设备也能立刻收到，不再等下一块新石头捎带
        sharedPublish(TOPIC, JSON.stringify(state));
      } else if (s.v < lastV) {
        // 纯旧包（对方时钟慢、在补发）：回发本地较新状态帮它追赶，不升版本避免互刷
        sharedPublish(TOPIC, JSON.stringify({ ...state, v: lastV }));
      }
    } catch { /* ignore */ }
  });
  // 持有者回补（门控触发：掉线超时/切 broker/每日首连）。单条 272KB 是全站最大的
  // 状态包，旧实现每次重连都发一遍——锁屏唤醒、校园网抖动一天几十次，
  // 大包在 QoS1 发送队列里排队，把后面的小消息全堵住（同步慢根因之一）
  onSharedResync(() => { resyncJade(); });
}

export function subscribeJade(fn: () => void): () => void {
  start();
  listeners.add(fn);
  fn(); // 立即回放缓存/备份里的现值，别等下一次发布
  return () => { listeners.delete(fn); };
}

export function jadeState(): JadeState {
  start();
  return state;
}

/** 持有者回补：重连后把本地完整状态发出去（防 broker 清 retained） */
export function resyncJade(): void {
  start();
  sharedPublish(TOPIC, JSON.stringify({ ...state, v: lastV }));
}

function commit() {
  bumpV();
  foldTerminalStones();          // 每次写操作顺手折一次，避免终端态墓碑越积越多
  foldSoldProducts();
  state = { ...state, arch: archiveSnapshot() };
  saveBackup();
  sharedPublish(TOPIC, JSON.stringify(state));
  emit();
}

/* ---------- 玩法 ---------- */
function rollVariety(tierId: string): JadeVariety {
  const w = TIER_WEIGHTS[tierId] ?? TIER_WEIGHTS.t1;
  const lucky = tierId === luckyTierOfDay();
  const bag: JadeVariety[] = [];
  for (const v of JADE_VARIETIES) {
    const boost = lucky && (v.rarity === '稀有' || v.rarity === '传说') ? 2 : 1;
    const n = Math.round((w[v.rarity] ?? 0) * boost * 10);
    for (let i = 0; i < n; i++) bag.push(v);
  }
  return bag[Math.floor(Math.random() * bag.length)] ?? JADE_VARIETIES[0];
}

/* ---------- 共生拆分：一块料切出混合多种玉石（2026-10-02 回归）
 * 完全确定性：种子 = 石头 id，任何一台设备切出同一块料，伴生小料的品种/克数/估值都一致，
 * 两端各自切也不会分叉（子料 id = `${父id}~s${i}`，重复切只是写同样的记录，按 id 合并去重） ---------- */
interface SplitChild { varietyId: string; grams: number; value: number }

function detRng(seed: string): () => number {
  let a = (hash01(seed) * 4294967296) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 按档位权重确定性滚一个伴生品种（吃今日好运档加成） */
function detVariety(tierId: string, seed: string): JadeVariety {
  const w = TIER_WEIGHTS[tierId] ?? TIER_WEIGHTS.t1;
  const lucky = tierId === luckyTierOfDay();
  const bag: JadeVariety[] = [];
  for (const v of JADE_VARIETIES) {
    const boost = lucky && (v.rarity === '稀有' || v.rarity === '传说') ? 2 : 1;
    const n = Math.max(1, Math.round((w[v.rarity] ?? 0.1) * boost * 10));
    for (let i = 0; i < n; i++) bag.push(v);
  }
  const r = detRng(seed);
  return bag[Math.floor(r() * bag.length) % bag.length] ?? JADE_VARIETIES[0];
}

/** 这块料切出的伴生小料计划（不含主体；主体保留原品种） */
function splitPlan(stone: OwnedStone): SplitChild[] {
  const grams = stone.grams ?? 0;
  if (grams < 12) return [];
  const rng = detRng(`${stone.id}|split`);
  const tierN: Record<string, [number, number]> = { t1: [1, 2], t2: [1, 2], t3: [2, 3], t4: [2, 3], t5: [2, 4] };
  const [lo, hi] = tierN[stone.tierId] ?? [1, 2];
  let n = lo + Math.floor(rng() * (hi - lo + 1));
  if (grams < 25) n = Math.min(n, 1);
  const out: SplitChild[] = [];
  let restG = grams;
  let restV = stone.value;
  for (let i = 0; i < n; i++) {
    const slotsLeft = n - i;
    // 每块小料占剩余料的 18%~42%，至少留 5g 给后面的和主体
    const maxShare = Math.max(0, (restG - 5 * slotsLeft) / restG);
    const share = Math.min(maxShare, 0.18 + rng() * 0.24);
    if (share <= 0) break;
    const g = Math.max(2, Math.floor(restG * share));
    const v = Math.max(1, Math.round(restV * (g / restG)));
    out.push({ varietyId: detVariety(stone.tierId, `${stone.id}|v${i}`).id, grams: g, value: v });
    restG -= g;
    restV -= v;
    if (restG < 7) break;
  }
  return out;
}

/** 神话档三兄弟（星陨料唯一能开出的档位） */
const MYTHIC_POOL = JADE_VARIETIES.filter((v) => v.rarity === '神话');

function rollStone(tier: StoneTier, who: string): OwnedStone {
  // 星陨料（2026-10-20）：买下时就注定结局——九成空芯（什么都得不到），
  // 一成必出神话档；伴生小料由 splitPlan 按 TIER_WEIGHTS.t5 派生（多玉融合）。
  const isMeteor = tier.id === 't5';
  const isVoid = isMeteor && Math.random() < T5_VOID_RATE;
  const variety = isMeteor
    ? (isVoid ? JADE_VARIETIES[0] : MYTHIC_POOL[Math.floor(Math.random() * MYTHIC_POOL.length)])
    : rollVariety(tier.id);
  const id = `${who}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  // 总克重 = 基准克重 × (0.82~1.0)：去皮开窗有损耗，长期易亏不赚
  const grams = Math.max(10, Math.round(gramsFor(tier.id, variety.id, id) * (0.82 + Math.random() * 0.18)));
  // 一块石头一生的极限纯度（95%~100% 之间随机，开出即定）
  const goal = round4(GOAL_MIN + Math.random() * (GOAL_MAX - GOAL_MIN));
  // 2026-10-03 重定价口径不变：估值 = 克数 × 品种克价 × (0.8~1.2)；
  // 2026-10-10 提纯上线：把「(0.8~1.2)」直接当作纯度系数反解出初始纯度，
  // 于是「提纯到 100% 纯度」= 价格推到 克数 × 品种克价 × 1.6（该品种天花板），老石头同样适用
  const rawCoef = 0.8 + Math.random() * 0.4;
  // 空芯原石不估值（切完直接 sold，一分钱拿不到）；卖出统计里 void === true 一眼可辨
  const value = isVoid ? 0 : Math.max(50, Math.round((grams * variety.gramPrice * rawCoef) / 50) * 50);
  // 估值经过取整后反解，保证 purity 与 value 严格自洽
  const purity = round4(Math.min(goal, isVoid ? GOAL_MIN : deriveCoefPurity(value / (grams * variety.gramPrice), goal)));
  return {
    id, // 克重种子 = 石头 id：与 withGrams 老数据回补同一口径，两台设备算出来一致
    tierId: tier.id,
    varietyId: variety.id,
    value,
    grams,
    purity,
    goalPurity: goal,
    status: 'uncut',
    by: who,
    ts: Date.now(),
    ...(isVoid ? { void: true } : {}),
  };
}

/** 管理员送料：直接给某人塞 N 块未切原石（不扣时元）。用于补发/回礼等运营场景。 */
export function seedStones(who: string, tierId: string, count: number): { ok: boolean; msg: string } {
  if (isGuestSession()) return { ok: false, msg: '游客不能送料' };
  start();
  const tier = STONE_TIERS.find((t) => t.id === tierId);
  if (!tier) return { ok: false, msg: '石头不存在' };
  const n = Math.max(1, Math.min(100, Math.floor(count) || 1));
  const added: Record<string, OwnedStone> = {};
  for (let i = 0; i < n; i++) {
    const stone = rollStone(tier, who);
    added[stone.id] = stone;
  }
  state = { ...state, stones: { ...state.stones, ...added } };
  commit();
  return { ok: true, msg: `已给 ${who} 送上 ${n} 块${tier.name} 🪨` };
}

/** 买石头：先扣时元，再上石头（调用方先查余额） */
export function buyStone(who: string, tierId: string, currentBalance: number): { ok: boolean; msg: string; stone?: OwnedStone } {
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' };
  start();
  const tier = STONE_TIERS.find((t) => t.id === tierId);
  if (!tier) return { ok: false, msg: '石头不存在' };
  if (currentBalance < tier.price) return { ok: false, msg: '时元不够啦，先去赚一点吧' };
  const stone = rollStone(tier, who);
  state = { ...state, stones: { ...state.stones, [stone.id]: stone } };
  commit();
  try { addTx(who, -tier.price, `赌石·买下${tier.name}`); } catch { /* ignore */ }
  return { ok: true, msg: `${tier.name}已到手，上打磨机！`, stone };
}

/** 批量买石头：一次下单 N 块直接入库（未切态），一次 commit 一个同步包，钱包只记一笔总账 */
export function buyStones(who: string, tierId: string, count: number, currentBalance: number): { ok: boolean; msg: string; stones?: OwnedStone[] } {
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' };
  start();
  const tier = STONE_TIERS.find((t) => t.id === tierId);
  if (!tier) return { ok: false, msg: '石头不存在' };
  const n = Math.max(1, Math.min(99, Math.floor(count) || 1));
  const cost = tier.price * n;
  if (currentBalance < cost) {
    return { ok: false, msg: `${n}块要${cost.toLocaleString()}时元，手里只有${currentBalance.toLocaleString()}，先去赚一点吧` };
  }
  const added: Record<string, OwnedStone> = {};
  for (let i = 0; i < n; i++) {
    const stone = rollStone(tier, who);
    added[stone.id] = stone;
  }
  state = { ...state, stones: { ...state.stones, ...added } };
  commit();
  try { addTx(who, -cost, `赌石·购入${tier.name}×${n}`); } catch { /* ignore */ }
  return { ok: true, msg: `${n}块${tier.name}已入库，共花 ${cost.toLocaleString()} 时元`, stones: Object.values(added) };
}

/** 一刀切开的结果：main 主体 / children 伴生小料 / waste 星陨料切空（什么都得不到） */
export interface CutResult {
  main: OwnedStone;
  children: OwnedStone[];
  waste?: boolean;
}

/** 切割的单步实现（不 commit、不校验重复调用，由上层把状态写回后统一 commit）。
 *  返回 null = 这块料不能由 who 切（不存在 / 不是 TA 的 / 已经切过） */
function cutOnce(stateStones: Record<string, OwnedStone>, who: string, stoneId: string): CutResult | null {
  const s = withPurity(withGrams(stateStones[stoneId]));
  if (!s || s.by !== who || s.status !== 'uncut') return null;
  const now = nowTs();
  const stones: Record<string, OwnedStone> = { ...stateStones };

  // 星陨料·空芯：切开来什么都没有，石块就地结账（sold / 值 0），只在开奖卡上「闪一下」
  if (s.void) {
    const corpse: OwnedStone = { ...s, varietyId: 'marble', value: 0, status: 'sold', cutTs: Date.now(), upd: now };
    return { main: corpse, children: [], waste: true };
  }

  const plan = splitPlan(s);
  const childG = plan.reduce((a, c) => a + c.grams, 0);
  const childV = plan.reduce((a, c) => a + c.value, 0);
  // 主体：保留原品种，扣掉伴生小料占走的克数/估值
  stones[stoneId] = {
    ...s,
    grams: Math.max(1, (s.grams ?? 0) - childG),
    value: Math.max(1, s.value - childV),
    status: 'cut',
    cutTs: Date.now(),
    upd: now,
  };
  // 伴生小料：独立成块（可单独卖/收藏/打磨/上拍），id 确定性，双端重复切也收敛
  const children: OwnedStone[] = [];
  const pStone = s; // 主体纯度
  for (let i = 0; i < plan.length; i++) {
    const c = plan[i];
    const id = `${stoneId}~s${i}`;
    const goal = round4(GOAL_MIN + hash01(`${id}|goal`) * (GOAL_MAX - GOAL_MIN));
    const purity = Math.min(goal, Math.max(0.3, pStone.purity ?? 0.5));
    const child: OwnedStone = {
      id,
      tierId: s.tierId,
      varietyId: c.varietyId,
      value: c.value,
      grams: c.grams,
      purity,
      goalPurity: goal,
      status: 'cut',
      by: who,
      ts: s.ts - (i + 1), // 紧挨主体排在切割台（列表按 ts 倒序，减一点让主体在前）
      cutTs: Date.now(),
      upd: now,
    };
    children.push(child);
    stones[id] = child;
  }
  return { main: stones[stoneId], children };
}

/** 切完一刀：揭开品种 + 伴生小料（结果购买时已定，这里只翻状态；伴生小料确定性派生）。
 *  返回主体 + 全部伴生小料，供开奖画面一次性展示；星陨料切空时 waste=true。 */
export function completeCut(who: string, stoneId: string): CutResult | null {
  if (isGuestSession()) return null;
  start();
  const r = cutOnce(state.stones, who, stoneId);
  if (!r) return null;
  state = { ...state, stones: { ...state.stones, ...pickStones(r, stoneId) } };
  commit();
  return r;
}

/** cutOnce 改动了哪些石头键（主体 + 伴生 + 空芯原地结账），捡出来供合并进大状态 */
function pickStones(r: CutResult, stoneId: string): Record<string, OwnedStone> {
  const out: Record<string, OwnedStone> = { [stoneId]: r.main };
  for (const c of r.children) out[c.id] = c;
  // 空芯原石：伴生不存在，主体就地改 sold（键不变），上面已覆盖
  return out;
}

/** 一键切石：把切割台上最靠前的 N 块（默认 5）一口气全切完，结果合并成一次发布。
 *  返回逐块结果供开奖汇总弹窗展示；空芯原石在结果里 waste=true。 */
export function cutMany(who: string, max = 5): { ok: boolean; msg: string; results: Array<CutResult & { stoneId: string; tierId: string }> } {
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦', results: [] };
  start();
  const targets = stonesOf(who)
    .filter((s) => s.by === who && s.status === 'uncut')
    .sort((a, b) => b.ts - a.ts)
    .slice(0, Math.max(1, Math.min(20, Math.floor(max) || 5)));
  if (targets.length === 0) return { ok: false, msg: '切割台上没有待切的料子', results: [] };
  const stones = { ...state.stones };
  const results: Array<CutResult & { stoneId: string; tierId: string }> = [];
  for (const t of targets) {
    const r = cutOnce(stones, who, t.id);
    if (!r) continue;
    results.push({ ...r, stoneId: t.id, tierId: t.tierId });
    stones[t.id] = r.main;
    for (const c of r.children) stones[c.id] = c;
  }
  if (results.length === 0) return { ok: false, msg: '没有切动的料子', results: [] };
  state = { ...state, stones };
  commit();
  const wasteN = results.filter((r) => r.waste).length;
  return { ok: true, msg: results.length === 1 ? '切完了，看开奖吧' : `一口气切了 ${results.length} 块（${wasteN} 块切空）`, results };
}

/** 今日实收价：整块估值，开出品种是今日爆单品则翻倍（UI 只展示结果，不解释缘由） */
export function sellPrice(s: OwnedStone): number {
  return Math.round(s.value * (s.varietyId === hotVarietyOfDay() ? 2 : 1));
}

/** 某品种今天能否直接卖出（只有今日高价品种能直接卖，其余只能送去拍卖会） */
export function isHotSellable(varietyId: string): boolean {
  return varietyId === hotVarietyOfDay();
}

/* ---------- 提纯工坊 ---------- */

export interface PurifyPreview {
  ok: boolean;
  reason: string;
  purifier: Purifier;
  /** 当前纯度 / 极限纯度 */
  purity: number;
  goal: number;
  /** 本次能提升多少纯度（百分点，例如 10 表示 +10%） */
  gainPct: number;
  /** 提纯后的纯度 */
  nextPurity: number;
  /** 当前估值 / 提纯后估值 */
  value: number;
  nextValue: number;
  /** 本次要消耗的提纯剂数量（固定 1 只） */
  doses: number;
  /** 本次净变化（提纯后估值 - 当前估值，提纯剂自己合成不花时元，故无料钱） */
  net: number;
  /** 是否已提到顶 */
  maxed: boolean;
  /** 我手上这种提纯剂的数量 */
  have: number;
  /** 从当前纯度一路提到顶，最多还要几只（按该剂的步长算：草木≤20 / 寒泉≤9 / 龙涎≤4） */
  leftToMax: number;
}

/** 一次提纯固定投 1 只 */
export const PURIFY_DOSES = 1;

/** 外部可读：这块石头提纯一次要投几只（恒为 1，保留函数供 UI 显示「一次 1 只」） */
export function purifyDoses(): number {
  return PURIFY_DOSES;
}

/** 从某个纯度提到 goal 还差多少只（按该剂型的步长估算，向上取整） */
export function dosesLeftToMax(purity: number, goal: number, purifierId: string): number {
  const step = purifyStepOf(purifierId);
  return Math.max(0, Math.ceil((goal - purity) * 100 / step - 1e-9));
}

/**
 * 一只提纯剂能带来多少纯度提升（百分点）：按剂型取步长（草木 5 / 寒泉 12 / 龙涎 25），
 * 逼近极限时按剩余空间收敛（不会超顶）。这就是三档「效果差距」的唯一来源。
 */
function purityGain(s: OwnedStone, purifierId: string): number {
  const s0 = withPurity(s);
  const goal = s0.goalPurity ?? GOAL_MAX;
  const cur = s0.purity ?? 0.5;
  return Math.min(purifyStepOf(purifierId), Math.max(0, (goal - cur) * 100));
}

/**
 * 提纯后的估值：不重新抽随机数，而是按「纯度系数比值」缩放当前估值——
 * 这块石头开盘时那一次 (0.8~1.2) 的浮动必须原样保留，否则每次提纯都重抽一次，
 * 会变成「反复提纯刷随机数」的漏洞（跟赌石开出即定价的既有规矩一致）。
 */
function valueAfterPurify(s: OwnedStone, purity: number): number {
  const cur = s.purity ?? 0.5;
  if (Math.abs(purity - cur) < 1e-9) return s.value;
  const ratio = purityCoef(purity) / purityCoef(cur);
  // 取整到 50 的倍数（和买料时的整数手感一致）。极端低价料（几十时元）在 ratio≈1 时
  // 四舍五入可能比原值低一档——提纯只该涨不该跌，这里给原值兜底。
  const scaled = Math.max(50, Math.round((s.value * ratio) / 50) * 50);
  return purity > cur ? Math.max(s.value, scaled) : scaled;
}

/**
 * 提纯预览：这块石头投 1 只这个提纯剂，能提多少、值多少。
 * 注意：**不扣任何东西**，纯计算，UI 展示用。
 */
export function purifyPreview(stone: OwnedStone, purifierId: string, have: number): PurifyPreview {
  const s = withPurity(stone);
  const purifier = purifierById(purifierId);
  const variety = varietyById(s.varietyId);
  const goal = s.goalPurity ?? GOAL_MAX;
  const purity = s.purity ?? 0.5;
  const maxed = purity >= goal - 1e-6;
  const gainPct = maxed ? 0 : purityGain(s, purifier.id);
  const nextPurity = round4(Math.min(goal, purity + gainPct / 100));
  const value = s.value;
  const nextValue = maxed ? value : valueAfterPurify(s, nextPurity);
  return {
    ok: !maxed,
    reason: maxed
      ? `${variety.name}已经提纯到顶（${(purity * 100).toFixed(1)}%），再投提纯剂纯属浪费`
      : '',
    purifier, purity, goal,
    gainPct: Math.round(gainPct * 10) / 10,
    nextPurity,
    value, nextValue,
    doses: PURIFY_DOSES,
    net: nextValue - value,
    maxed,
    have,
    leftToMax: dosesLeftToMax(purity, goal, purifier.id),
  };
}

/** 我（who）手上某种提纯剂的数量 = max(0, 累计合成 - 累计消耗) */
export function reagentCountOf(who: string, purifierId: string): number {
  start();
  return availableOf(state.reagents[who], purifierId);
}

/** 我（who）手上全部提纯剂总数（兼容旧调用） */
export function reagentCount(who: string): number {
  start();
  return PURIFIERS.reduce((a, p) => a + reagentCountOf(who, p.id), 0);
}

/**
 * 入库提纯剂：**由农场合成产出**（lib/farm.ts 的提纯剂合成线调用），不花时元。
 * 用「只增累加器 produced」而不是「当前数量」，合并时取 max 即可，跨端必然收敛。
 */
export function grantReagent(who: string, purifierId: string, count = 1): boolean {
  if (isGuestSession()) return false;
  start();
  const n = Math.max(1, Math.floor(count));
  const prev = state.reagents[who] ?? {};
  const produced = { ...(prev.produced ?? {}) };
  produced[purifierId] = (produced[purifierId] ?? 0) + n;
  state = { ...state, reagents: { ...state.reagents, [who]: { ...prev, produced } } };
  commit();
  return true;
}

/**
 * 提纯：消耗 1 只提纯剂，把这块石头的纯度往上抬 10 个点（逼近极限时收敛）。
 *  - 已到顶 / 没料 / 不在手上 → 拒绝
 *  - 纯度提升后按新纯度重算估值（保持克数不变，只抬纯度）
 *  - upd 刷新，保证合并时后写的赢；goalPurity 一经写入不再变
 */
export function purifyStone(who: string, stoneId: string, purifierId: string):
  { ok: boolean; msg: string; stone?: OwnedStone; gainPct?: number } {
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' };
  start();
  const raw = state.stones[stoneId];
  if (!raw) return { ok: false, msg: '这块石头不存在' };
  const s = withPurity(raw);
  if (s.by !== who) return { ok: false, msg: '这块石头不在你手上' };
  if (s.status !== 'cut' && s.status !== 'kept') {
    return { ok: false, msg: '只有切割台/收藏柜里的玉石能提纯' };
  }
  const purifier = purifierById(purifierId);
  const have = reagentCountOf(who, purifier.id);
  const pv = purifyPreview(s, purifier.id, have);
  if (pv.maxed) return { ok: false, msg: pv.reason };
  if (have < pv.doses) {
    return { ok: false, msg: `没有${purifier.name}啦，去农场合成一只吧` };
  }
  const next: OwnedStone = {
    ...s,
    purity: pv.nextPurity,
    value: pv.nextValue,
    upd: nowTs(),
  };
  // 消耗 1 只：从库存扣除（库存为只减项，同步靠 produced/consumed 双累加器收敛）
  const prevLedger = state.reagents[who] ?? {};
  const consumed = { ...(prevLedger.consumed ?? {}) };
  consumed[purifier.id] = (consumed[purifier.id] ?? 0) + pv.doses;
  state = {
    ...state,
    stones: { ...state.stones, [stoneId]: next },
    reagents: { ...state.reagents, [who]: { ...prevLedger, consumed } },
  };
  commit();
  const vn = varietyById(s.varietyId);
  const capped = pv.nextPurity >= (s.goalPurity ?? GOAL_MAX) - 1e-6;
  const left = dosesLeftToMax(pv.nextPurity, s.goalPurity ?? GOAL_MAX, purifier.id);
  return {
    ok: true,
    msg: `${purifier.emoji} ${vn.name}提纯 ${(pv.purity * 100).toFixed(1)}% → ${(pv.nextPurity * 100).toFixed(1)}%`
      + `（耗 1 只，估值 ${next.value.toLocaleString()} 时元）`
      + (capped ? ' 🔥 已达极限纯度！' : `再 ${left} 只到顶`),
    stone: next,
    gainPct: pv.gainPct,
  };
}

/** 可提纯的料子：切割台 + 收藏柜里的（按价值从高到低，好玉先提） */
export function purifiablesOf(who: string): OwnedStone[] {
  start();
  return Object.values(state.stones)
    .filter((s) => s.by === who && (s.status === 'cut' || s.status === 'kept') && (s.grams ?? 0) > 0)
    .map(withPurity)
    .sort(byValueDesc);
}

/** 卖出得时元（整块/余料/柜中皆可）。grams 传了且小于总克数 = 部分卖：按克比例 ×0.92，剩余留柜。
 *  铁律：只有今日高价品种能直接卖，其它玉石一律只能走拍卖会。 */
export function sellStone(who: string, stoneId: string, grams?: number): { ok: boolean; msg: string } {
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' };
  start();
  const s = withPurity(state.stones[stoneId]);
  if (!s || s.by !== who || (s.status !== 'cut' && s.status !== 'kept')) return { ok: false, msg: '这块石头卖不了' };
  if (!isHotSellable(s.varietyId)) {
    return { ok: false, msg: `只有今日高价「${varietyById(hotVarietyOfDay()).name}」能直接卖，其它玉石只能送去拍卖会` };
  }
  const totalG = s.grams ?? 0;
  const portion = typeof grams === 'number' && grams > 0 && grams < totalG;
  if (portion && grams < 5) return { ok: false, msg: '至少卖 5 克' };
  const wasKept = s.status === 'kept';
  let paid: number;
  let stoneNext: OwnedStone;
  let label: string;
  if (!portion) {
    paid = sellPrice(s);
    stoneNext = { ...s, status: 'sold', upd: nowTs() };
    label = varietyById(s.varietyId).name + (wasKept ? '余料' : '');
  } else {
    const f = grams! / totalG;
    paid = Math.max(1, Math.round(sellPrice(s) * f * 0.92));
    const restG = totalG - grams!;
    const restValue = Math.max(1, s.value - Math.max(1, Math.round(s.value * f)));
    stoneNext = {
      ...s,
      grams: restG,
      value: restValue,
      upd: nowTs(),
    };
    label = `${varietyById(s.varietyId).name}${grams}克`;
  }
  state = { ...state, stones: { ...state.stones, [stoneId]: stoneNext } };
  commit();
  try { addTx(who, paid, `赌石·卖出${label}`); } catch { /* ignore */ }
  return {
    ok: true,
    msg: portion ? `卖出 ${grams} 克，+${paid} 时元，还剩 ${stoneNext.grams} 克` : `卖出成功，+${paid} 时元（${totalG} 克）`,
  };
}

/** 收藏进柜（图鉴计数） */
export function keepStone(who: string, stoneId: string): { ok: boolean; msg: string } {
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' };
  start();
  const s = withPurity(state.stones[stoneId]);
  if (!s || s.by !== who || s.status !== 'cut') return { ok: false, msg: '这块石头收藏不了' };
  state = { ...state, stones: { ...state.stones, [stoneId]: { ...s, status: 'kept', upd: nowTs() } } };
  commit();
  return { ok: true, msg: `${varietyById(s.varietyId).name}已放入收藏柜 💎` };
}

/* ---------- 玉器工坊 ---------- */

export interface CraftInput {
  typeId: string;
  metalId: string;
  cordId: string | null;
  engraving: string;
}

export interface CraftPreview {
  ok: boolean;
  reason: string;
  type: CraftType;
  /** 本次用料克数 */
  useG: number;
  /** 打磨完剩下的余料克数 */
  leftG: number;
  /** 余料估值（可直接卖出） */
  leftValue: number;
  /** 成品估值 */
  value: number;
}

/**
 * 打磨预览：只吃 useG 克，剩下全是余料（余料克数/估值原样留在石头上，可继续打磨也可卖出）。
 * 成品价值 = 料子分摊价值（原值 × 用料占比）× 器型倍率 × 配件加成
 */
export function craftPreview(stone: OwnedStone, typeId: string, metalId: string): CraftPreview {
  const type = craftTypeById(typeId);
  const metal = metalById(metalId);
  const grams = stone.grams ?? 0;
  const ok = grams >= type.useG;
  if (!ok) {
    return {
      ok, type, value: 0,
      reason: `${type.name}要用 ${type.useG}g 料，这块只有 ${grams}g`,
      useG: type.useG, leftG: grams, leftValue: stone.value,
    };
  }
  const leftG = grams - type.useG;
  const usedValue = Math.round((stone.value * type.useG) / grams);
  const value = Math.max(10, Math.round((usedValue * type.mult * metal.mult) / 10) * 10);
  return {
    ok, reason: '', type, useG: type.useG, leftG,
    leftValue: leftG > 0 ? Math.max(1, stone.value - usedValue) : 0,
    value,
  };
}

/**
 * 打磨成品：只扣掉这一件的用料克数，余料留在原石上（状态不变，继续可打磨 / 可卖 / 可收藏）。
 * 料子全部用完时才落 crafted 墓碑。
 */
export function craftProduct(who: string, stoneId: string, input: CraftInput): { ok: boolean; msg: string; product?: JadeProduct } {
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' };
  start();
  const raw = state.stones[stoneId];
  if (!raw) return { ok: false, msg: '这块料子不存在' };
  const s = withPurity(withGrams(raw));
  if (s.by !== who || (s.status !== 'cut' && s.status !== 'kept')) {
    return { ok: false, msg: '这块料子不在手上或已经处理过啦' };
  }
  const metal = metalById(input.metalId);
  const pv = craftPreview(s, input.typeId, metal.id);
  if (!pv.ok) return { ok: false, msg: pv.reason };
  const type = pv.type;
  const cord = type.cord ? cordById(input.cordId ?? 'red') : null;
  const engraving = (input.engraving ?? '').trim().slice(0, 6);
  const variety = varietyById(s.varietyId);
  const parts = [variety.name, type.name];
  if (metal.id !== 'none') parts.push(metal.name);
  if (cord) parts.push(cord.name);
  const name = parts.join('·') + (engraving ? `「${engraving}」` : '');
  const product: JadeProduct = {
    id: `p-${who}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    by: who,
    maker: who,
    varietyId: s.varietyId,
    typeId: type.id,
    grams: pv.useG,
    metalId: metal.id,
    cordId: cord?.id ?? null,
    engraving,
    name,
    value: pv.value,
    ts: Date.now(),
  };
  const stoneNext: OwnedStone = pv.leftG > 0
    ? {
        // 余料：状态不变，克数/估值同步扣减（整块统一口径，不再做共生拆分）
        ...s,
        grams: pv.leftG,
        value: pv.leftValue,
        upd: nowTs(),
      }
    : { ...s, status: 'crafted', grams: 0, value: 0, upd: nowTs() }; // 整块用完，落墓碑
  state = {
    ...state,
    stones: { ...state.stones, [stoneId]: stoneNext },
    products: { ...state.products, [product.id]: product },
  };
  commit();
  return {
    ok: true,
    msg: `打磨完成！${name} 入柜 💎（用料 ${pv.useG}g${pv.leftG > 0 ? `，余料 ${pv.leftG}g 还能再磨或卖出` : '，料子用完了'}）`,
    product,
  };
}

/** 成品生成了 AI 定制图：给成品打标记（图本身走 jade/art/<id> 独立通道，状态里只放 key） */
export function markProductArt(who: string, productId: string): boolean {
  if (isGuestSession()) return false;
  start();
  const p = state.products[productId];
  if (!p || p.by !== who || p.status) return false;
  state = { ...state, products: { ...state.products, [productId]: { ...p, art: productId, ts: Date.now() } } };
  commit();
  return true;
}

/** 转赠成品给对方（by 易主，maker 留名） */
export function giftProduct(who: string, productId: string): { ok: boolean; msg: string } {
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' };
  start();
  const p = state.products[productId];
  if (!p || p.by !== who || p.status) return { ok: false, msg: '这件成品不在你手上' };
  const partner = partnerOf(who);
  if (!partner) return { ok: false, msg: '还不知道对方是谁呢' };
  state = {
    ...state,
    products: { ...state.products, [productId]: { ...p, by: partner, giftTs: Date.now(), ts: Date.now() } },
  };
  commit();
  return { ok: true, msg: `已把「${p.name}」赠给 ${partner} 💝` };
}

/** 工坊还原：成品熔回玉料（克数保留，估值回落到料级），成品落 sold 墓碑 */
export function dissolveProduct(who: string, productId: string): { ok: boolean; msg: string; stone?: OwnedStone } {
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' };
  start();
  const p = state.products[productId];
  if (!p || p.by !== who || p.status) return { ok: false, msg: '这件成品不在手上' };
  const v = varietyById(p.varietyId);
  const id = `re-${p.id}`;
  const goal = round4(GOAL_MIN + hash01(`${id}|goal`) * (GOAL_MAX - GOAL_MIN));
  const value = Math.max(10, Math.round(p.value * (0.9 + Math.random() * 0.05)));
  const grams = Math.max(1, p.grams);
  const stone: OwnedStone = {
    id,
    tierId: 't1',
    varietyId: p.varietyId,
    value,
    grams,
    // 还原出的料子：同样由「价值 ÷ 基准单克价」反解纯度，与全局口径一致
    purity: round4(Math.max(0.1, deriveCoefPurity(value / (grams * v.gramPrice), goal))),
    goalPurity: goal,
    status: 'cut',
    by: who,
    ts: Date.now(),
    cutTs: Date.now(),
  };
  state = {
    ...state,
    stones: { ...state.stones, [stone.id]: stone },
    products: { ...state.products, [productId]: { ...p, status: 'sold', ts: Date.now() } },
  };
  commit();
  return { ok: true, msg: `已还原成 ${stone.grams} 克${v.name}玉料，估值 ${stone.value.toLocaleString()} 时元`, stone };
}

/** 成品柜：我手上持有的成品（拍卖锁定/已成交的不在柜） */
export function productsOf(who: string): JadeProduct[] {
  start();
  return Object.values(state.products)
    .filter((p) => p.by === who && !p.status)
    .sort((a, b) => b.value - a.value || b.ts - a.ts);
}

/* ---------- 玉砖合成：同种玉石凑满 1000g 熔铸一块（黄金→金砖），可挂上拍卖会 ---------- */

/** 可入砖的料子：切开的/柜中的非砖料（按单位克价值从低到高排，碎料先进炉） */
export function brickablesOf(who: string): OwnedStone[] {
  start();
  return Object.values(state.stones)
    .filter((s) => s.by === who && !isBrick(s) && (s.status === 'cut' || s.status === 'kept') && (s.grams ?? 0) > 0)
    .map((s) => withPurity(withGrams(s)))
    .sort((a, b) => (a.value / (a.grams ?? 1)) - (b.value / (b.grams ?? 1)));
}

/** 每个品种的可入炉克数（融砖限同种玉石，按品种凑 1000g） */
export function brickOptionsOf(who: string): { varietyId: string; grams: number }[] {
  start();
  const map: Record<string, number> = {};
  for (const s of brickablesOf(who)) {
    map[s.varietyId] = (map[s.varietyId] ?? 0) + (s.grams ?? 0);
  }
  return Object.entries(map)
    .map(([varietyId, grams]) => ({ varietyId, grams: Math.floor(grams) }))
    .sort((a, b) => b.grams - a.grams);
}

export function bricksOf(who: string): OwnedStone[] {
  start();
  return Object.values(state.stones)
    .filter((s) => s.by === who && isBrick(s) && (s.status === 'cut' || s.status === 'kept'))
    .map((s) => withPurity(withGrams(s)))
    .sort(byValueDesc);
}

/** 熔铸玉砖：限同种玉石，从低值碎料开始逐块吃满 1000g；砖值 = 料值 ×1.05 */
export function forgeBrick(who: string, varietyId: string): { ok: boolean; msg: string; brick?: OwnedStone } {
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' };
  start();
  const vn = varietyById(varietyId);
  const pieces = brickablesOf(who).filter((s) => s.varietyId === varietyId);
  const totalG = pieces.reduce((a, s) => a + (s.grams ?? 0), 0);
  if (pieces.length === 0 || totalG < BRICK_GRAMS) {
    return { ok: false, msg: `${vn.name}要凑满 ${BRICK_GRAMS}g 同种料才能铸砖（现在 ${Math.floor(totalG)}g）` };
  }
  const now = nowTs();
  const stones: Record<string, OwnedStone> = { ...state.stones };
  let need = BRICK_GRAMS;
  let sumV = 0;
  let sumPureG = 0; // 入炉料子的「纯度 × 克数」加权，铸砖后按它定砖的纯度
  let usedG = 0;
  for (const raw of pieces) {
    if (need <= 0) break;
    const s = withPurity(stones[raw.id] ?? raw);
    const g = s.grams ?? 0;
    if (g <= 0) continue;
    const take = Math.min(g, need);
    const takeV = take >= g ? s.value : Math.max(1, Math.round((s.value * take) / g));
    sumV += takeV;
    sumPureG += (s.purity ?? 0.5) * take;
    usedG += take;
    need -= take;
    stones[s.id] = take >= g
      ? { ...s, grams: 0, value: 0, status: 'crafted', upd: now } // 整块进炉，落墓碑
      : { ...s, grams: g - take, value: Math.max(1, s.value - takeV), upd: now }; // 部分入炉，余料留石
  }
  const brickGoal = round4(GOAL_MIN + hash01(`brick-${who}-${Date.now()}`) * (GOAL_MAX - GOAL_MIN));
  const brickPurity = round4(Math.min(brickGoal, usedG > 0 ? sumPureG / usedG : 0.5));
  const brick: OwnedStone = {
    id: `brick-${who}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    tierId: BRICK_TIER_ID,
    varietyId,
    value: Math.max(50, Math.round((sumV * 1.05) / 50) * 50),
    grams: BRICK_GRAMS,
    purity: brickPurity,
    goalPurity: brickGoal,
    status: 'cut',
    by: who,
    ts: Date.now(),
    cutTs: Date.now(),
    upd: now,
  };
  stones[brick.id] = brick;
  state = { ...state, stones };
  commit();
  return {
    ok: true,
    msg: `🔥 ${brickNameOf(varietyId)}铸成！${vn.name} ${BRICK_GRAMS}g 整料，估值 ${brick.value.toLocaleString()} 时元，可挂上拍卖会`,
    brick,
  };
}

/* ---------- 查询 ---------- */

/**
 * 统一的排序口径：**按价值从高到低**（同价再按时间新的靠前）。
 * 全站所有玉石列表都走这个比较器，保证玩家在哪个页面看到的顺序都一致。
 */
export function byValueDesc(a: OwnedStone, b: OwnedStone): number {
  return b.value - a.value || b.ts - a.ts;
}

export function stonesOf(who: string): OwnedStone[] {
  start();
  return Object.values(state.stones)
    .filter((s) => s.by === who && s.status !== 'sold')
    .map((s) => withPurity(withGrams(s)))
    .sort(byValueDesc);
}

/** 收藏柜里某品种的每一颗（点开查看用），含克重 + 纯度（按价值从高到低） */
export function keptStonesOf(who: string, varietyId: string): OwnedStone[] {
  start();
  return Object.values(state.stones)
    .filter((s) => s.by === who && s.status === 'kept' && s.varietyId === varietyId)
    .map((s) => withPurity(withGrams(s)))
    .sort(byValueDesc);
}

/** 收藏柜：每品种一格，克数/价值累加 + 平均纯度（开出的整块料直接全额叠到品种总克数上，不做单件细分） */
export function collectionOf(who: string): { varietyId: string; grams: number; value: number; purity: number }[] {
  start();
  const map: Record<string, { grams: number; value: number; pureG: number }> = {};
  const add = (varietyId: string, grams: number, value: number, purity: number) => {
    const m = map[varietyId] ?? { grams: 0, value: 0, pureG: 0 };
    m.grams += grams; m.value += value; m.pureG += purity * grams;
    map[varietyId] = m;
  };
  for (const s of Object.values(state.stones)) {
    if (s.by !== who || s.status !== 'kept') continue;
    const p = withPurity(s);
    add(p.varietyId, p.grams ?? 0, p.value, p.purity ?? 0.5);
  }
  return Object.entries(map)
    .map(([varietyId, m]) => ({
      varietyId,
      grams: Math.round(m.grams),
      value: Math.round(m.value),
      purity: m.grams > 0 ? round4(m.pureG / m.grams) : 0.5,
    }))
    .sort((a, b) => b.value - a.value);
}

export function jadeStats(who: string): { spent: number; earned: number; cut: number; kept: number; crafted: number } {
  start();
  // 投入/收入 = 活体明细累加 + 已折叠归档计数器（sold 石头被折掉后仍要算账）
  let spent = archSpent[who] ?? 0;
  let earned = archEarned[who] ?? 0;
  let cut = 0, kept = 0;
  for (const s of Object.values(state.stones)) {
    if (s.by !== who) continue;
    const tier = STONE_TIERS.find((t) => t.id === s.tierId);
    if (tier) spent += tier.price;
    if (s.status === 'sold') earned += s.value;
    if (s.status !== 'uncut') cut++;
    if (s.status === 'kept') kept++;
  }
  // 成品数按成品柜算（余料打磨后原石状态不变，不能再用 status 计数）；
  // 加上已折叠的 sold 成品计数（sold 成品已从活体剔除）
  const crafted = (archSoldProducts[who] ?? 0)
    + Object.values(state.products).filter((p) => p.by === who).length;
  return { spent, earned, cut, kept, crafted };
}

/** 富贵值：（收藏柜 + 切割台待处理玉石 + 成品柜）总价值 × 0.01（主页展示，1 位小数） */
export function jadeWealth(who: string): number {
  start();
  const stoneSum = Object.values(state.stones)
    .filter((s) => s.by === who && (s.status === 'kept' || s.status === 'cut' || s.status === 'auction'))
    .reduce((acc, s) => acc + s.value, 0);
  const productSum = Object.values(state.products)
    .filter((p) => p.by === who && !p.status)
    .reduce((acc, p) => acc + p.value, 0);
  return Math.round((stoneSum + productSum) * 0.01 * 10) / 10;
}

/* ---------- 玉缘拍卖会：锁货与交割（auction.ts 调用，状态单向推进） ---------- */

/** 外部模块（拍卖会）把一块已成交的货写进仓库（id 由调用方保证确定性唯一） */
export function ingestStone(stone: OwnedStone): void {
  start();
  const s = withPurity(withGrams(stone));
  state = { ...state, stones: { ...state.stones, [s.id]: s } };
  commit();
}

/** 上拍锁货：cut|kept → auction（拍卖期间禁止私下卖出/打磨/收藏/转赠） */
export function auctionSendStone(who: string, stoneId: string): boolean {
  if (isGuestSession()) return false;
  start();
  const s = state.stones[stoneId];
  if (!s || s.by !== who || (s.status !== 'cut' && s.status !== 'kept')) return false;
  state = { ...state, stones: { ...state.stones, [stoneId]: { ...s, status: 'auction', upd: nowTs() } } };
  commit();
  return true;
}

/** 拍卖结算：auction → sold（成交）/ kept（流拍退回）；墓碑推进，旧包顶不回来 */
export function auctionResolveStone(who: string, stoneId: string, sold: boolean): void {
  start();
  const s = state.stones[stoneId];
  if (!s || s.by !== who || s.status !== 'auction') return;
  state = {
    ...state,
    stones: {
      ...state.stones,
      [stoneId]: { ...s, status: sold ? 'sold' : 'kept', upd: nowTs() },
    },
  };
  commit();
}

/** 上拍锁货：成品 → status='auction' */
export function auctionSendProduct(who: string, productId: string): boolean {
  if (isGuestSession()) return false;
  start();
  const p = state.products[productId];
  if (!p || p.by !== who || p.status) return false;
  state = { ...state, products: { ...state.products, [productId]: { ...p, status: 'auction', ts: Date.now() } } };
  commit();
  return true;
}

/** 拍卖结算：auction → sold（成交）/ 清回正常在柜（流拍退回），ts 更新防旧包复活 */
export function auctionResolveProduct(who: string, productId: string, sold: boolean): void {
  start();
  const p = state.products[productId];
  if (!p || p.by !== who || p.status !== 'auction') return;
  state = {
    ...state,
    products: { ...state.products, [productId]: sold ? { ...p, status: 'sold', ts: Date.now() } : { ...p, status: undefined, ts: Date.now() } },
  };
  commit();
}
