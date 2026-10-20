/* 玉缘拍卖会：双方各自上拍（成品/切开的料子），AI 买家举牌竞价，两人围观落槌。
 * 设计要点：
 * - 整场拍卖是一份「剧本」：开槌者以 session.id 为种子确定性生成完整出价时间线，
 *   两台设备各自对齐 liveStartAt 播放同一剧本 → 画面天然同步，不需要逐条信令对时；
 * - 价格高低以「隐藏真实价值 V」为锚：V = 估值 × 行情系数 × 主题系数 × 个体波动 × 瑕疵系数，
 *   落槌价 ≥1.15V 溢价 / ≥0.85V 正常 / 低于保留价或未达价则流拍；
 * - 保留价由卖家自己设：不设必成交但可能贱卖，设太高可能流拍——贪心 vs 稳妥是核心张力；
 * - 验货打灯：每件拍品确定性带完美/疑似暗裂/暗裂，卖家上拍前可验（对方看不到结果），
 *   暗裂会被 AI 大幅压价，呼应「玉石鉴定」主题；
 * - 同步三件套（铁律 2）：Lamport lastV + 按 id/按人合并 + 墓碑（lot 状态推进序 / paid 幂等）；
 * - 货物安全：上拍即锁货（stone→'auction' / product.status='auction'），成交 sold、流拍退回 kept；
 * - 2026-10-17 修「下一把主题又变了」：拍卖结束后一方点返回、另一方还停在战报页，
 *   两台设备各开一场就会分叉（合并按 createdAt 取新者赢 → 输的那台专场名当场跳变）。
 *   三道保险：开新场前先向云端探路（探到进行中的场次就不开）、主题/行情按上一场 id
 *   确定性派生（真分叉了两端也摇到同一主题）、双开时胜方接管败方已上拍的拍品（货不丢）。
 */
import { sharedSubscribe, sharedPublish, sharedResync, onSharedResync } from './mqttClient';
import { publishPartial, subscribePartial, partialSeenAt, type PartialEnvelope } from './syncPartial';
import { getUserSession } from './auth';
import { isGuestSession } from './guest';
import { isPairMember, membersKnown, getSpaceId } from './space';
import { addTx } from './wallet';
import {
  JADE_VARIETIES, varietyById, craftTypeById,
  auctionSendStone, auctionResolveStone, auctionSendProduct, auctionResolveProduct,
  ingestStone, type OwnedStone,
} from './jade';
import {
  spendWarehouseItem, grantWarehouse, spendUpgradeToken, grantUpgradeToken,
  warehouseItemValue, UPGRADE_TOKEN_VALUE, itemInfo, CROPS, seedId,
} from './farm';

const TOPIC = 'lovesite/auction/state';
const BACKUP = 'lovesite-auction-backup';

/* ---------- 行情与主题 ---------- */
export type MarketTemp = 'cold' | 'normal' | 'hot';

export interface AuctionTheme {
  id: string;
  name: string;
  emoji: string;
  desc: string;          // 征集公告语（专场直接官宣，不再有假小道消息）
  typeIds: string[];     // 命中加成的器型
  varietyIds: string[];  // 命中加成的品种
  mult: number;          // 命中 ×mult，未命中 ×0.88（百花齐放全场命中）
  /** 器型到场兴趣加成：命中器型的拍品更不容易流拍（如戒指专场人人抢戒指） */
  typeInterest?: Record<string, number>;
  /** 品质联动：命中主题时按品种稀有度追加的隐藏价值倍率（品质越高拍得越贵） */
  rarityMult?: Record<string, number>;
}

export const AUCTION_THEMES: AuctionTheme[] = [
  { id: 'bangle-night', name: '玉镯之夜', emoji: '⭕', desc: '今晚玉镯专场，镯类行情看涨，圈口合适就是缘分', typeIds: ['bangle'], varietyIds: [], mult: 1.35, typeInterest: { bangle: 0.25 } },
  { id: 'ring-night', name: '戒指专场', emoji: '💍', desc: '今晚只认戒指——指间一点翠，件件有人抢；品质越高争得越凶', typeIds: ['ring'], varietyIds: [], mult: 1.45, typeInterest: { ring: 0.38 }, rarityMult: { '常见': 1, '少见': 1.05, '稀有': 1.2, '传说': 1.45 } },
  { id: 'earring-breeze', name: '耳坠清风', emoji: '🎐', desc: '耳坠轻摇专场，小巧精致的最招女买家喜欢', typeIds: ['earrings'], varietyIds: [], mult: 1.35, typeInterest: { earrings: 0.28 } },
  { id: 'pendant-moon', name: '吊坠映月', emoji: '🌙', desc: '吊坠挂牌专场，寓意好的题材被追着加价', typeIds: ['pendant'], varietyIds: [], mult: 1.32, typeInterest: { pendant: 0.25 } },
  { id: 'beads', name: '珠串雅集', emoji: '📿', desc: '串珠手链正当季，珠串好出货', typeIds: ['bracelet'], varietyIds: [], mult: 1.3, typeInterest: { bracelet: 0.25 } },
  { id: 'ice-night', name: '冰种高货夜', emoji: '💠', desc: '高冰玻璃种买家云集，硬货别错过', typeIds: [], varietyIds: ['ice', 'highice', 'glass', 'emperor'], mult: 1.4, rarityMult: { '稀有': 1.1, '传说': 1.3 } },
  { id: 'violet-vow', name: '紫罗兰秘约', emoji: '🟪', desc: '紫罗兰与墨翠的雅集，懂行的藏家今夜必到', typeIds: [], varietyIds: ['violet', 'mo'], mult: 1.38, rarityMult: { '稀有': 1.12, '传说': 1.25 } },
  { id: 'ornament', name: '摆件大观', emoji: '🏔️', desc: '大件摆件有老板扫货', typeIds: ['ornament'], varietyIds: [], mult: 1.3, typeInterest: { ornament: 0.22 } },
  { id: 'brick-night', name: '玉砖大观', emoji: '🧱', desc: '今晚玉砖金砖专场，大户按块扫货', typeIds: ['brick'], varietyIds: [], mult: 1.35, typeInterest: { brick: 0.25 } },
  { id: 'open', name: '百花齐放', emoji: '🌸', desc: '无主题杂项场，各凭眼力', typeIds: [], varietyIds: [], mult: 1.12 },
];

export const themeById = (id: string): AuctionTheme =>
  AUCTION_THEMES.find((t) => t.id === id) ?? AUCTION_THEMES[AUCTION_THEMES.length - 1];

export const MARKET_LABEL: Record<MarketTemp, string> = { cold: '人气低迷', normal: '人流如常', hot: '人气火爆' };
export const MARKET_EMOJI: Record<MarketTemp, string> = { cold: '🌧️', normal: '🌤️', hot: '🔥' };

/* ---------- AI 买家 ---------- */
type AiStyle = 'bold' | 'careful' | 'pro' | 'scalper' | 'rookie' | 'mystery';

interface AIBidder {
  id: string;
  name: string;
  emoji: string;
  style: AiStyle;
  /** 预算区间（× 隐藏真实价值 V） */
  lo: number;
  hi: number;
  likeTypeIds?: string[];
  likeVarietyIds?: string[];
  /** 偏好命中时的预算加成 */
  likeMult: number;
}

export const AI_BIDDERS: AIBidder[] = [
  { id: 'wang', name: '王老板', emoji: '🎩', style: 'bold', lo: 0.9, hi: 1.35, likeMult: 1 },
  { id: 'li', name: '李姐', emoji: '👜', style: 'careful', lo: 0.7, hi: 1.1, likeTypeIds: ['bangle', 'pendant'], likeMult: 1.3 },
  { id: 'chen', name: '香港陈生', emoji: '🕶️', style: 'pro', lo: 0.95, hi: 1.08, likeMult: 1 },
  { id: 'north', name: '北地玉商', emoji: '🧥', style: 'bold', lo: 0.85, hi: 1.3, likeTypeIds: ['ornament', 'bangle'], likeMult: 1.3 },
  { id: 'zhou', name: '收藏家周老', emoji: '🧓', style: 'pro', lo: 0.9, hi: 1.2, likeVarietyIds: ['mo', 'violet', 'ice', 'highice', 'glass', 'emperor'], likeMult: 1.25 },
  { id: 'live', name: '直播间代购', emoji: '📱', style: 'rookie', lo: 0.75, hi: 1.25, likeTypeIds: ['ring', 'earrings'], likeMult: 1.3 },
  { id: 'mine', name: '缅甸矿主', emoji: '⛏️', style: 'bold', lo: 0.8, hi: 1.4, likeVarietyIds: ['highice', 'glass', 'emperor'], likeMult: 1.35 },
  { id: 'lin', name: '新手小林', emoji: '🧢', style: 'rookie', lo: 0.6, hi: 0.9, likeMult: 1 },
  { id: 'tan', name: '典当行老谭', emoji: '🔍', style: 'scalper', lo: 0.55, hi: 0.85, likeMult: 1 },
  { id: 'phone', name: '神秘电话买家', emoji: '📞', style: 'mystery', lo: 0.85, hi: 1.5, likeVarietyIds: ['glass', 'emperor'], likeMult: 1.5 },
  // 2026-10-05 新增：到场买家太单一（总是那几张熟脸），扩充买家池让举牌的人更丰富
  { id: 'designer', name: '珠宝设计师苏', emoji: '💎', style: 'careful', lo: 0.8, hi: 1.2, likeTypeIds: ['ring', 'earrings', 'pendant'], likeMult: 1.35 },
  { id: 'fund', name: '外资基金代表', emoji: '💼', style: 'pro', lo: 1.0, hi: 1.45, likeVarietyIds: ['glass', 'emperor', 'highice'], likeMult: 1.3 },
  { id: 'aunt', name: '老街坊赵婶', emoji: '🧺', style: 'rookie', lo: 0.55, hi: 0.95, likeTypeIds: ['bangle', 'bracelet'], likeMult: 1.25 },
  { id: 'middle', name: '玉料中间商', emoji: '📦', style: 'scalper', lo: 0.6, hi: 0.95, likeVarietyIds: ['ice', 'highice', 'nuo'], likeMult: 1.2 },
  { id: 'traveler', name: '旅行收藏家', emoji: '🎒', style: 'mystery', lo: 0.75, hi: 1.3, likeTypeIds: ['pendant', 'ornament'], likeMult: 1.3 },
  { id: 'anchor', name: '直播间榜一', emoji: '👑', style: 'bold', lo: 0.85, hi: 1.4, likeTypeIds: ['ring', 'earrings', 'bracelet'], likeMult: 1.3 },
];

/* ---------- 拍品与场次 ---------- */
export type LotKind = 'product' | 'stone' | 'warehouse';
/** held = 流拍滞留保管仓（货仍锁定），赎回需付保管溢价 → returned */
export type LotStatus = 'listed' | 'withdrawn' | 'held' | 'hammered' | 'returned';
export type Flaw = 'none' | 'suspect' | 'crack';
export type Tag = 'premium' | 'fair' | 'cheap' | 'unsold';

/** 土地升级券在拍卖会里的物品 id（仓库物品用真实 id，升级券单独用这个哨兵值） */
export const UPGRADE_TOKEN_REF = '__upgrade_token__';

export interface AuctionLot {
  id: string;
  kind: LotKind;
  refId: string;          // 成品 id / 石头 id / 仓库物品 id（升级券 = UPGRADE_TOKEN_REF）
  seller: string;
  name: string;
  varietyId: string;
  typeId?: string;        // 成品器型（原石无）
  emoji: string;
  artKey?: string;        // 成品 AI 图 key
  value: number;          // 上拍时估值快照
  grams?: number;
  /** 仓库物品上拍数量（成品/原石无此字段） */
  qty?: number;
  /** AI 卖家的私藏货：虚拟货，无 jade 实物交割 */
  ai?: boolean;
  /** AI 私藏中的农场特殊种子：拍下后入农场仓库（仓库物品 id，如 seed_moonberry），全场至多一件 */
  aiSeed?: string;
  reserve: number;        // 保留价，0 = 不设（必成交但可能被贱买）
  inspected: boolean;     // 卖家是否已打灯验货
  flaw: Flaw;             // 真实瑕疵（确定性，验不验它都在；只展示给卖家）
  status: LotStatus;
  ts: number;
  /** 仓库货交割墓碑：流拍已退回 / 成交已交割，防双端并发重复处理（仓库货专用） */
  delivered?: boolean;
}

export interface BidEvent { t: number; ai: string; emoji: string; price: number; delta?: number }

export interface LotScript {
  lotId: string;
  introAt: number;        // 相对 session 起点的拍品展示时刻
  firstBidAt: number;
  bids: BidEvent[];
  hammerAt: number;
  result: 'sold' | 'unsold';
  buyer: string;
  price: number;          // 落槌价（unsold = 0）
  tag: Tag;
  comment: string;
  hiddenV: number;        // 隐藏真实价值（结算战报揭示「行家估价」用）
}

export interface AuctionScript {
  sessionId: string;
  total: number;          // 整场总时长 ms
  lots: LotScript[];
}

export interface SellerSummary {
  total: number; sold: number; unsold: number;
  bestName?: string; bestPrice?: number; bestTag?: Tag;
}

export interface SettledSummary {
  id: string;
  at: number;
  bySeller: Record<string, SellerSummary>;
}

export interface AuctionSession {
  id: string;
  status: 'prep' | 'live' | 'settled';
  createdBy: string;
  createdAt: number;
  themeId: string;
  market: MarketTemp;
  lots: Record<string, AuctionLot>;
  /** AI 卖家的私藏拍品（开槌时确定性生成；虚拟货无实物交割） */
  aiLots: Record<string, AuctionLot>;
  /** AI 货已被谁收下（lotId → 先到先得墓碑） */
  aiBuys: Record<string, { who: string; ts: number }>;
  ready: Record<string, number>;
  liveStartAt: number;    // 本地时钟锚点：两端各自对齐播放
  script?: AuctionScript;
  settledAt: number;
  paid: Record<string, number>;  // who → 领取成交款的时间（幂等墓碑）
}

interface AuctionState {
  session: AuctionSession | null;
  archives: Record<string, SettledSummary>;
  /** 跨场不丢的流拍保管仓：lotId → 滞留拍品（货仍锁定在 jade/farm，付溢价赎回后移除） */
  heldVault: Record<string, AuctionLot>;
  v: number;
}

/* ---------- 确定性随机 ---------- */
function hash01(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h / 4294967296;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round50 = (n: number) => Math.max(50, Math.round(n / 50) * 50);
export const fmtMoney = (n: number) => n.toLocaleString('zh-CN');
export { round50 };

/** 价格步进档位：小件（估值 < 800）用 10 元档、大件用 50 元档。
 *  50 元档对几百块的小玩意太粗——起拍价被 50 的下限顶到估值以上、一手就是百分之十几，
 *  几手就到顶，「一手接一手」的热闹完全看不出来 */
export const priceGrid = (value: number): number => (value < 800 ? 10 : 50);

/** 按档位取整（含档位下限） */
export const roundGrid = (n: number, grid: number): number => Math.max(grid, Math.round(n / grid) * grid);

/** 拍品瑕疵：由 lotId 确定性决定（两端一致），验货只是「让卖家看见」 */
export function flawOf(lotId: string): Flaw {
  const h = hash01(`flaw|${lotId}`);
  if (h < 0.2) return 'crack';
  if (h < 0.36) return 'suspect';
  return 'none';
}

/* ---------- 剧本生成（开槌者本地跑一遍，两端播放同一份） ---------- */
function hiddenValue(lot: AuctionLot, theme: AuctionTheme, market: MarketTemp, rng: () => number): number {
  const m = market === 'hot' ? 1.22 : market === 'cold' ? 0.8 : 1;
  const hit = theme.id === 'open'
    ? true
    : (lot.typeId ? theme.typeIds.includes(lot.typeId) : false) || theme.varietyIds.includes(lot.varietyId);
  const t = hit ? theme.mult : 0.88;
  // 品质联动：命中主题时品种稀有度追加倍率（如戒指专场，传说品质戒指拍得飞起）
  const rm = hit && theme.rarityMult ? (theme.rarityMult[varietyById(lot.varietyId).rarity] ?? 1) : 1;
  const fl = 0.8 + rng() * 0.45;
  const flaw = lot.flaw === 'crack' ? 0.55 : lot.flaw === 'suspect' ? 0.85 : 1;
  // 不在这里取整：档位由拍品估值决定（小件 10 元档），调用方 roundGrid
  return lot.value * m * t * rm * fl * flaw;
}

/** 各稀有度的到场兴趣（2026-10-02 整体下调：流拍变多，上拍不再稳赚） */
const RARITY_INTEREST: Record<string, number> = { '废料': 0.12, '常见': 0.3, '少见': 0.48, '稀有': 0.62, '传说': 0.78, '神话': 0.92 };

const COMMENTS: Record<Tag, string[]> = {
  premium: ['全场沸腾！{b}志在必得 🔥', '天价落槌，今晚的标王诞生了 ✨', '{b}举到手酸也不肯放'],
  fair: ['行情价出手，稳稳的幸福 😌', '不亏不赚，缘分到位'],
  cheap: ['被{b}捡了个大漏 😭', '心疼…这价出手亏大了', '{b}笑得合不拢嘴'],
  unsold: ['无人识货，抱回家吧 🕊️', '市场不认，待价而沽'],
};

function pick<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

/** 每次加价的幅度区间（× 当前价）——「少量多次」：一手只咬 0.6%~7.5%，
 *  但 0.2~1 秒就举一手，一路咬到落槌前 0.1 秒，价格像爬楼梯一样一点点顶上去：
 *  bold 步子大 / careful 一口一口磨 / pro 老手克制 / scalper 压价收 /
 *  rookie 忽大忽小 / mystery 永远猜不透（2026-10-08 整体上调 ~25%：常态成交价太贴估值） */
const INC_RANGE: Record<AiStyle, [number, number]> = {
  bold: [0.025, 0.065],
  careful: [0.006, 0.025],
  pro: [0.012, 0.04],
  scalper: [0.006, 0.02],
  rookie: [0.012, 0.05],
  mystery: [0.012, 0.075],
};

/** 全场最高价天花板：落槌价最多翻到隐藏估价的 10 倍（2026-10-08 由 5 倍上调，与品质无关） */
const MAX_PRICE_MULT = 10;

/** 疯抢概率：每件拍品独立掷一次（不看品种/品质/估值大小，小物件同样有天价命） */
const FRENZY_CHANCE = 0.18;
/** 疯抢买家的预算区间（× 隐藏估价 V），上限即全场天花板 */
const FRENZY_BUDGET: [number, number] = [3.5, 10];

function buildLotScript(lot: AuctionLot, startAt: number, theme: AuctionTheme, market: MarketTemp, rng: () => number): LotScript {
  const grid = priceGrid(lot.value);
  const rg = (n: number) => roundGrid(n, grid);
  const V = rg(hiddenValue(lot, theme, market, rng));
  // 到场 AI：2026-10-05 人数上调（举牌老那几个人太单调），每场 6~10 位到场，行情再增减
  const present = Math.min(10, Math.max(5, 6 + Math.floor(rng() * 3) + (market === 'hot' ? 1 : market === 'cold' ? -1 : 0)));
  const pool = [...AI_BIDDERS].sort(() => rng() - 0.5).slice(0, present);

  interface Cand { name: string; emoji: string; budget: number; style: AiStyle; hot?: boolean }
  const cands: Cand[] = [];
  for (const ai of pool) {
    const like = (lot.typeId && ai.likeTypeIds?.includes(lot.typeId)) || ai.likeVarietyIds?.includes(lot.varietyId);
    // 仓库货没有玉石品种，按「少见」档的人气对待
    const rarity = lot.kind === 'warehouse' ? '少见' : varietyById(lot.varietyId).rarity;
    // 专场器型加成：命中主题的器型（如戒指专场的戒指）更不容易流拍
    const themeLike = lot.typeId ? (theme.typeInterest?.[lot.typeId] ?? 0) : 0;
    const p = (RARITY_INTEREST[rarity] ?? 0.5) + (like ? 0.22 : 0) + themeLike + (market === 'hot' ? 0.12 : market === 'cold' ? -0.12 : 0);
    if (rng() > p) continue;
    // 整体预算上浮（×1.15~1.55）：常态成交价不再贴着估值走
    const b = (ai.lo + rng() * (ai.hi - ai.lo)) * (like ? ai.likeMult : 1) * (1.15 + rng() * 0.4);
    cands.push({ name: ai.name, emoji: ai.emoji, budget: rg(V * b), style: ai.style });
  }
  // 大买家志在必得：约 20% 的拍品有一位买家预算加码——但全场天花板 = 10 倍隐藏估价
  // （确定性 rng：两端跑同一段生成同一份剧本，互刷择优也不会分叉）
  if (cands.length > 0 && rng() < 0.2) {
    const whale = cands[Math.floor(rng() * cands.length) % cands.length];
    whale.budget = Math.min(rg(V * MAX_PRICE_MULT), rg(whale.budget * (1.8 + rng() * 2.2)));
  }
  // 疯抢天价：与品质/估值大小无关，每件独立 18% 概率杀出一位志在必得的神秘买家，
  // 预算直接开到估值 3.5~10 倍——小物件拍出天价的惊喜感就从这里来
  let frenzy = false;
  if (cands.length > 0 && rng() < FRENZY_CHANCE) {
    frenzy = true;
    const star = cands[Math.floor(rng() * cands.length) % cands.length];
    star.hot = true;
    star.budget = Math.max(star.budget, rg(V * (FRENZY_BUDGET[0] + rng() * (FRENZY_BUDGET[1] - FRENZY_BUDGET[0]))));
    // 其余买家跟着起哄抬轿，价才会一层层顶上去（不然只是一个人自嗨）
    for (const c of cands) {
      if (c === star) continue;
      c.budget = Math.min(rg(V * MAX_PRICE_MULT), rg(c.budget * (1.15 + rng() * 0.45)));
    }
    // 再扶一位「陪咬到底」的对手（预算约为疯抢者的 55%~85%）：
    // 天价是两个人一路互抬出来的，一个买家自喊自接看不出热闹
    if (cands.length > 1) {
      const rivals = cands.filter((c) => c !== star && !c.hot);
      const rival = rivals[Math.floor(rng() * rivals.length) % rivals.length];
      rival.budget = Math.min(rg(V * MAX_PRICE_MULT), Math.max(rival.budget, rg(star.budget * (0.55 + rng() * 0.3))));
    }
  }
  for (const c of cands) c.budget = Math.min(c.budget, rg(V * MAX_PRICE_MULT));

  const reserve = lot.reserve;
  const introAt = startAt;
  const firstBidAt = startAt + 1600;
  // 起拍价整体上移（0.38~0.58V）：更多人望而却步，流拍率上升
  const startPrice = rg(Math.max(reserve, V * (0.38 + rng() * 0.2)));
  const bids: BidEvent[] = [];
  // 竞价窗口 9.5~12s：加价少量多次，一直咬到落槌前 0.1 秒，最后几秒还有人在举手；
  // 疯抢场延长到 13~16s——天价要一手一手咬上去，窗口太短爬不到高位就被预算封了顶
  let hammerAt = firstBidAt + (frenzy ? 13000 + rng() * 3000 : 9500 + rng() * 2500);
  let result: 'sold' | 'unsold' = 'unsold';
  let buyer = '';
  let price = 0;

  const live = cands.filter((c) => c.budget >= startPrice * 1.02);
  if (live.length > 0) {
    let cur = startPrice;
    let t = firstBidAt;
    while (t < hammerAt - 100) { // 最后 0.1 秒前都能举
      const willing = live.filter((c) => c.budget > cur * 1.01);
      if (!willing.length) break;
      // 积极性 = 剩余预算空间 + 噪音；越怕错过越敢跟
      const weights = willing.map((c) => 0.4 + (c.budget - cur) / c.budget + rng() * 0.6);
      const sum = weights.reduce((a, b) => a + b, 0);
      let r = rng() * sum;
      let idx = 0;
      while (idx < weights.length - 1 && r > weights[idx]) { r -= weights[idx]; idx++; }
      const c = willing[idx];
      const [ilo, ihi] = INC_RANGE[c.style] ?? [0.01, 0.03];
      let inc: number;
      if (c.hot) {
        // 疯抢买家：一口咬 12%~44%，天价才可能在竞价窗口里爬到 3.5~10 倍
        inc = 0.12 + rng() * 0.32;
        if (c.budget - cur < cur * 0.25) inc = Math.min(inc, 0.06); // 逼近自己预算时收着点，别一口咬穿
      } else {
        inc = ilo + rng() * (ihi - ilo);
        // 偶发跳价：小概率在风格上限基础上再加一口（惊喜感）
        if (rng() < 0.1) inc = Math.min(ihi + 0.03, inc * 1.6 + 0.01);
        // 快摸到预算天花板时敢梭一把
        if (c.budget - cur < cur * 0.15) inc *= 1.3;
      }
      const prev = cur;
      // 按档位取整：小件估值低时 cur×(1+加价) 取整可能原地不动（旧实现直接 break →
      // 小物件整场无人举牌、成交率崩到个位数）。改为「取整后若没抬起来，至少抬一手档位」，预算封顶照旧
      let next = Math.round((cur * (1 + inc)) / grid) * grid;
      if (next <= prev) next = prev + grid;
      cur = Math.min(c.budget, next);
      if (cur <= prev) break; // 预算见顶，这一手举不动了
      bids.push({ t, ai: c.name, emoji: c.emoji, price: cur, delta: cur - prev });
      t += 200 + rng() * 800; // 0.2~1s 一手，密密麻麻
    }
    if (bids.length > 0 && cur >= reserve) {
      result = 'sold';
      price = cur;
      buyer = bids[bids.length - 1]?.ai ?? '';
    }
    // 预算咬穿就落槌：把落槌点收到最后一手之后 2.2~3.1s（正好走完一/二/三次读秒），别让价格挂在那里干等
    if (result === 'sold' && bids.length > 0) {
      const lastT = bids[bids.length - 1].t;
      hammerAt = Math.max(firstBidAt + 3000, Math.min(hammerAt, lastT + 2200 + rng() * 900));
    }
  }

  // 2026-10-02 非玉石货（仓库物品/升级券）流拍率封顶 10%：注定流拍时 90% 概率有兜底买家
  // 按「保留价 / 最后出价 / 起拍价」三者最高一口接走（确定性 rng，两端生成同一份剧本）
  if (result === 'unsold' && lot.kind === 'warehouse' && rng() < 0.9) {
    const fb = pick(pool, rng);
    const base = bids.length > 0 ? bids[bids.length - 1].price : startPrice;
    const fbPrice = rg(Math.max(reserve, base));
    bids.push({ t: hammerAt - 400, ai: fb.name, emoji: fb.emoji, price: fbPrice, delta: Math.max(0, fbPrice - base) });
    result = 'sold';
    price = fbPrice;
    buyer = fb.name;
  }
  // 2026-10-02 流拍不读秒：注定没人接手的拍品不再空等 8~10s 倒计时（叫价/秒数全免），
  // 开拍后约 1 秒内直接落槌切下一件；尾段超出新城窗的出价一并裁掉
  if (result === 'unsold') {
    hammerAt = firstBidAt + 600 + rng() * 400;
    for (let i = bids.length - 1; i >= 0; i--) {
      if (bids[i].t >= hammerAt) bids.splice(i, 1);
      else break;
    }
  }

  const tag: Tag = result === 'unsold' ? 'unsold' : price >= V * 1.15 ? 'premium' : price >= V * 0.85 ? 'fair' : 'cheap';
  const pool2 = result === 'unsold' && bids.length > 0
    ? ['差一口价没到保留价，可惜了 🕊️', '举了牌又缩回去，流拍']
    : COMMENTS[tag];
  const comment = pick(pool2, rng).replace('{b}', buyer || '买家');

  return { lotId: lot.id, introAt, firstBidAt, bids, hammerAt, result, buyer, price, tag, comment, hiddenV: V };
}

export function generateScript(session: AuctionSession): AuctionScript {
  const rng = mulberry32(Math.floor(hash01(session.id) * 4294967296));
  const theme = themeById(session.themeId);
  const lots = [
    ...Object.values(session.lots).filter((l) => l.status === 'listed'),
    ...Object.values(session.aiLots ?? {}).filter((l) => l.status === 'listed'),
  ];
  // Fisher–Yates 洗牌（rng 确定性）：AI 私藏与玩家拍品穿插出场
  for (let i = lots.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [lots[i], lots[j]] = [lots[j], lots[i]];
  }
  let at = 0;
  const scripts: LotScript[] = [];
  for (const lot of lots) {
    const ls = buildLotScript(lot, at, theme, session.market, rng);
    scripts.push(ls);
    at = ls.hammerAt + 2200; // 落槌展示 2.2s 后切换下一件
  }
  return { sessionId: session.id, total: at + 600, lots: scripts };
}

/** 两位神秘拍卖者：每场各带 2 件私藏登场（虚拟货，落槌后双方可按成交价抢收） */
const MYSTERY_SELLERS = [
  { name: '蒙面卖家', emoji: '🎭' },
  { name: '深夜来客', emoji: '🌙' },
];

/** 农场特殊种子池（融合作物，平时只能大融合产出） */
const FUSION_SEED_IDS = CROPS.filter((c) => c.fusionOnly).map((c) => seedId(c.id));

/** AI 卖家的私藏拍品：以 session.id 为种子确定性生成 4 件（两位神秘卖家各 2 件；
 *  约一半场次会有一件换成农场特殊种子，每场至多一次——全部由 session.id 种子决定，两端一致）。
 *  与剧本同一套 rng 口径，双开槌互刷择优也不会分叉。 */
function buildAiLots(session: AuctionSession, rng: () => number): Record<string, AuctionLot> {
  const theme = themeById(session.themeId);
  const out: Record<string, AuctionLot> = {};
  // 特殊种子是否登场（50%）、登场在第几位：先掷好，保证「每场至多一件」且确定性
  const seedAppears = rng() < 0.5;
  const seedSlot = Math.floor(rng() * 4);
  for (let i = 0; i < 4; i++) {
    const id = `ailot-${session.id}-${i}`;
    const seller = MYSTERY_SELLERS[Math.floor(i / 2) % MYSTERY_SELLERS.length];
    if (seedAppears && i === seedSlot && FUSION_SEED_IDS.length > 0) {
      const seedRef = FUSION_SEED_IDS[Math.floor(rng() * FUSION_SEED_IDS.length) % FUSION_SEED_IDS.length];
      const info = itemInfo(seedRef);
      out[id] = {
        id, kind: 'warehouse', refId: seedRef,
        seller: `${seller.emoji} ${seller.name}`,
        name: `农场秘藏 · ${info.name}`,
        varietyId: '',
        emoji: info.emoji,
        value: warehouseItemValue(seedRef), qty: 1,
        ai: true, aiSeed: seedRef,
        reserve: 0, inspected: true, flaw: 'none',
        status: 'listed',
        ts: session.createdAt + i,
      };
      continue;
    }
    const variety = theme.varietyIds.length > 0 && rng() < 0.5
      ? varietyById(theme.varietyIds[Math.floor(rng() * theme.varietyIds.length)])
      : JADE_VARIETIES[Math.floor(rng() * JADE_VARIETIES.length) % JADE_VARIETIES.length];
    const grams = Math.round(30 + rng() * 170);
    // 2026-10-03 与赌石同一克价口径：估值 = 克数 × 品种克价 × (0.8~1.2)（旧「随机基数 × 倍数区间」
    // 在新口径下会系统性偏离玩家手里同品种料子的行情，AI 货贱卖/贵卖都不合理）
    const value = round50(grams * variety.gramPrice * (0.8 + rng() * 0.4));
    // 2026-10-02 起不做共生拆分：克数/估值整块记在该品种名下（与工坊/收藏柜同一口径）
    out[id] = {
      id, kind: 'stone', refId: id,
      seller: `${seller.emoji} ${seller.name}`,
      name: `${variety.name}原石 · ${grams}g`,
      varietyId: variety.id,
      emoji: variety.emoji,
      value, grams, ai: true,
      reserve: 0, inspected: true, flaw: flawOf(id),
      status: 'listed',
      ts: session.createdAt + i,
    };
  }
  return out;
}

/** 播放帧：两端用同一 script + elapsed 算同一画面（elapsed = 本地now - liveStartAt） */
export type LivePhase = 'wait' | 'intro' | 'bidding' | 'hammer' | 'unsold' | 'done';

export interface LiveFrame {
  phase: LivePhase;
  lotIdx: number;
  lot: AuctionLot | null;
  ls: LotScript | null;
  /** 当前价（0=未开拍） */
  price: number;
  leader: string;
  leaderEmoji: string;
  /** 已发生的出价（含当前帧） */
  bidsSoFar: BidEvent[];
  /** 落槌前叫价：'' | 第一次 | 第二次 | 第三次 */
  callout: string;
  done: boolean;
}

export function liveFrame(session: AuctionSession | null, elapsed: number): LiveFrame {
  const empty: LiveFrame = { phase: 'done', lotIdx: -1, lot: null, ls: null, price: 0, leader: '', leaderEmoji: '', bidsSoFar: [], callout: '', done: true };
  const sc = session?.script;
  if (!session || !sc || sc.lots.length === 0) return empty;
  if (elapsed < 0) return { ...empty, phase: 'wait', done: false };
  if (elapsed >= sc.total) return empty;
  let idx = sc.lots.findIndex((l) => elapsed < l.hammerAt + 2200);
  if (idx === -1) return empty;
  const ls = sc.lots[idx];
  const lot = session.lots[ls.lotId] ?? session.aiLots?.[ls.lotId] ?? null;
  const bidsSoFar = ls.bids.filter((b) => b.t <= elapsed);
  const last = bidsSoFar[bidsSoFar.length - 1];
  if (elapsed < ls.firstBidAt) {
    return { phase: 'intro', lotIdx: idx, lot, ls, price: 0, leader: '', leaderEmoji: '', bidsSoFar, callout: '', done: false };
  }
  if (elapsed < ls.hammerAt) {
    const left = ls.hammerAt - elapsed;
    const callout = left <= 1000 ? '第三次' : left <= 2000 ? '第二次' : left <= 3000 ? '第一次' : '';
    return {
      phase: 'bidding', lotIdx: idx, lot, ls,
      price: last?.price ?? 0, leader: last?.ai ?? '', leaderEmoji: last?.emoji ?? '',
      bidsSoFar, callout, done: false,
    };
  }
  return {
    phase: ls.result === 'sold' ? 'hammer' : 'unsold', lotIdx: idx, lot, ls,
    price: ls.price, leader: ls.buyer, leaderEmoji: ls.result === 'sold' ? '🏆' : '',
    bidsSoFar: ls.bids, callout: '', done: false,
  };
}

/* ---------- 播放时钟锚定 ----------
 * elapsed 以「开槌者本机时钟」为准：各端收到 live 状态时估算自己与开槌者的时钟差并修正，
 * 避免两台手机系统时间不一致（差几分钟很常见）导致一个播到第二件、另一个还在第一件，
 * 甚至某端提前走完触发结算把整场掐断。
 * 2026-10-02 修「进度不一样」：旧估算法假设收到的第一条 live 消息是开槌瞬间（liveStartAt−2500）
 * 发出的——可 retained 可能是开槌后任何一次重发，估算会被「开播至今已有多久」污染，
 * 后进的一方整整落后那么多秒。现在每条消息自带发送方时钟 t，任意时刻的重发都能给出
 * 干净的时钟差样本；取近期最小值（抗网络抖动），每条 live 消息持续校准。 */
interface ClockAnchor { sessionId: string; startAt: number; best: number; n: number; locked?: boolean }
let clockAnchor: ClockAnchor | null = null;
/** 本实例 id：跳过自己回声造成的假样本 */
const CLIENT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const ONE_WAY_MS = 150;            // 单程时延估计（移动网 MQTT 典型 100~400ms）
const SKEW_CLAMP = 10 * 60_000;    // 时钟差保护限幅（±10 分钟，超过基本是脏数据）

/** 收到 live 消息时喂一个时钟差样本（offset = 本端时钟 − 开槌者时钟，ms） */
function anchorClock(session: AuctionSession | null, sentAt?: number, from?: string) {
  if (!session || session.status !== 'live' || !session.liveStartAt) return;
  // 开槌者本机就是基准（locked，只吃自己种的 0 样本）——用对方的时钟反推反而会把自己带偏
  if (clockAnchor && clockAnchor.locked && clockAnchor.sessionId === session.id) return;
  let raw: number;
  if (typeof sentAt === 'number' && from !== CLIENT_ID) {
    raw = Date.now() - sentAt - ONE_WAY_MS;
  } else {
    // 旧端兼容（消息没有 t）：退回旧假设——这条是开槌瞬间（liveStartAt − 1500）发出的
    raw = Date.now() - (session.liveStartAt - 1500) - ONE_WAY_MS;
  }
  raw = Math.max(-SKEW_CLAMP, Math.min(SKEW_CLAMP, raw));
  if (!clockAnchor || clockAnchor.sessionId !== session.id || clockAnchor.startAt !== session.liveStartAt) {
    clockAnchor = { sessionId: session.id, startAt: session.liveStartAt, best: raw, n: 1 };
    return;
  }
  clockAnchor.n++;
  // 2026-10-03 修「播放回退」：旧实现取最近 8 个样本的最小值，每条 live 消息重估时 offset 会反复上跳，
  // elapsed 跟着一次次往回退（画面回退）。时钟差一场拍卖内基本不变，offset 锁历史最小、只降不升 → elapsed 单调
  if (raw < clockAnchor.best) clockAnchor.best = raw;
}

/** 本场已播放时长（对齐开槌者时钟；未锚定时退回本机时钟） */
export function liveElapsed(session: AuctionSession | null): number {
  if (!session?.liveStartAt) return -9999;
  const ok = clockAnchor && clockAnchor.sessionId === session.id && clockAnchor.startAt === session.liveStartAt;
  const off = ok && clockAnchor ? clockAnchor.best : 0;
  return Date.now() - session.liveStartAt - off;
}

/* ---------- 状态（同步三件套：Lamport 版本守卫 + 按 id 合并 + 墓碑） ---------- */
let state: AuctionState = { session: null, archives: {}, heldVault: {}, v: 0 };
let lastV = 0;
let started = false;
const listeners = new Set<() => void>();

function emit() { listeners.forEach((f) => f()); }
function saveBackup() { try { localStorage.setItem(BACKUP, JSON.stringify(state)); } catch { /* ignore */ } }
/* 消息洪峰（如同播不同本互刷期）里把备份合并成尾部防抖写；用户操作的 commit() 仍同步写 */
let backupTimer: ReturnType<typeof setTimeout> | null = null;
function saveBackupSoon() {
  if (backupTimer) return;
  backupTimer = setTimeout(() => { backupTimer = null; saveBackup(); }, 400);
}

function bumpV(): number {
  lastV = Math.max(lastV, Date.now()) + 1;
  state = { ...state, v: lastV };
  return lastV;
}

const SESSION_ORDER: Record<AuctionSession['status'], number> = { prep: 0, live: 1, settled: 2 };
const LOT_ORDER: Record<LotStatus, number> = { listed: 0, withdrawn: 1, held: 2, hammered: 3, returned: 3 };

/** 跨场（session id 不同）取舍：2026-10-02 修「一方开槌另一方还没进去」——
 *  旧逻辑纯比 createdAt，拿着较新空场（prep）的设备会把对方正在进行的 live 场直接盖掉，
 *  两端各自分裂成两场。现在按 status 优先级：live > prep > settled，同级才比 createdAt。
 *  （同一场的状态流转仍走 SESSION_ORDER，两者不混用） */
const SESSION_PRIORITY: Record<AuctionSession['status'], number> = { settled: 0, prep: 1, live: 2 };
function betterSession(a: AuctionSession, b: AuctionSession): AuctionSession {
  const pa = SESSION_PRIORITY[a.status] ?? 0, pb = SESSION_PRIORITY[b.status] ?? 0;
  if (pa !== pb) return pa > pb ? a : b;
  return a.createdAt > b.createdAt ? a : b;
}

/** 2026-10-17 修「下一把主题又变了」：两台设备各开一场（一台还停在上一场战报、
 *  另一台已经开了新场）时，胜方场次收下败方场次里已上拍的拍品与「已准备」标记——
 *  否则败方场次被整份丢弃，那些货锁在 auction 状态里没人认领 = 永久丢失。
 *  规则是纯函数：两端拿到同样的两份场次，算出的合并结果逐字段一致，收敛后不再互刷。
 *  只在「两场都还在征集期」时接管（已开槌/已结算的场次剧本已定，塞不进新拍品）。
 *  无变化时必须原样返回 winner 引用（调用方靠引用相等走零序列化快速路径） */
function adoptLots(winner: AuctionSession, loser: AuctionSession): AuctionSession {
  if (winner.status !== 'prep' || loser.status !== 'prep') return winner;
  const move = Object.values(loser.lots).filter((l) => l.status === 'listed' && !winner.lots[l.id]);
  const readyAdd = Object.entries(loser.ready).filter(([who, ts]) => ts > (winner.ready[who] ?? 0));
  if (move.length === 0 && readyAdd.length === 0) return winner;
  const lots = { ...winner.lots };
  for (const lot of move) lots[lot.id] = lot;
  const ready = { ...winner.ready };
  for (const [who, ts] of readyAdd) ready[who] = ts;
  return { ...winner, lots, ready };
}

function orderedListedLots(session: AuctionSession): AuctionLot[] {
  return Object.values(session.lots)
    .filter((l) => l.status === 'listed')
    .sort((a, b) => a.ts - b.ts);
}

/** 两个时钟锚点取较小正值；都没有（0/undefined）返回 0。
 *  2026-10-03 修旧算式 Math.min(∞,∞)||… 在两端都没设过锚点时产出 Infinity，
 *  JSON.stringify(Infinity) = null，云端 settledAt 从此变 null */
function minPositive(a?: number, b?: number): number {
  const vals = [a, b].filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0);
  return vals.length ? Math.min(...vals) : 0;
}

/** 两份剧本择优：只一份就取那份；两份都在时取 JSON 序列化较小者。
 *  两端跑同一段比较逻辑 → 无论谁收谁的版本，收敛结果都是同一份剧本
 * （否则双方同时开槌时两台各播各的，且状态永远不等、互相广播刷个不停）。 */
function pickScript(a?: AuctionScript, b?: AuctionScript): AuctionScript | undefined {
  if (!a) return b;
  if (!b) return a;
  return JSON.stringify(a) < JSON.stringify(b) ? a : b;
}

/** 同一 session 的两份状态逐字段合并（两边可能各自推进了不同部分）。
 *  2026-10-03 性能关键：每条 MQTT 消息都会跑这里，合并结果「什么都没变」时必须原样返回 a 的引用——
 *  调用方靠引用相等走快速路径，跳过全量 JSON.stringify 比对（大状态下那是主线程卡顿主因） */
function mergeSessionFields(a: AuctionSession, b: AuctionSession): AuctionSession {
  let lotsTouched = false;
  let lots: Record<string, AuctionLot> = { ...a.lots };
  for (const [id, lot] of Object.entries(b.lots)) {
    const r = lots[id];
    if (!r) { lots[id] = lot; lotsTouched = true; continue; }
    if (r !== lot && (LOT_ORDER[lot.status] ?? 0) > (LOT_ORDER[r.status] ?? 0)) { lots[id] = lot; lotsTouched = true; }
  }
  if (!lotsTouched) lots = a.lots;
  // AI 私藏只增不覆盖：内容以 session.id 确定性生成，同 id 必然一致，先到的赢
  let aiLotsTouched = false;
  let aiLots: Record<string, AuctionLot> = { ...(a.aiLots ?? {}) };
  for (const [id, lot] of Object.entries(b.aiLots ?? {})) {
    if (!aiLots[id]) { aiLots[id] = lot; aiLotsTouched = true; }
  }
  if (!aiLotsTouched) aiLots = a.aiLots ?? {};
  // AI 货购买先到先得：同 lotId 冲突按（ts, who）字典序定胜负（时间戳小 = 先点的赢）。
  //  2026-10-03 修旧「先写的赢」在双方同毫秒点击时两端各认各的赢家、状态不收口
  let aiBuysTouched = false;
  let aiBuys: Record<string, { who: string; ts: number }> = { ...(a.aiBuys ?? {}) };
  for (const [id, buy] of Object.entries(b.aiBuys ?? {})) {
    const cur = aiBuys[id];
    if (!cur || buy.ts < cur.ts || (buy.ts === cur.ts && buy.who < cur.who)) { aiBuys[id] = buy; aiBuysTouched = true; }
  }
  if (!aiBuysTouched) aiBuys = a.aiBuys ?? {};
  let readyTouched = false;
  let ready: Record<string, number> = { ...a.ready };
  for (const [who, ts] of Object.entries(b.ready)) {
    if (!ready[who] || ts > ready[who]) { ready[who] = ts; readyTouched = true; }
  }
  if (!readyTouched) ready = a.ready;
  let paidTouched = false;
  let paid: Record<string, number> = { ...a.paid };
  for (const [who, ts] of Object.entries(b.paid)) {
    if (!paid[who] || ts > paid[who]) { paid[who] = ts; paidTouched = true; }
  }
  if (!paidTouched) paid = a.paid;
  // 剧本择优：同一份就复用引用（常态）；两份都有且不同才 JSON 比较（仅双开槌的罕见场景）
  let script = a.script;
  if (!script) script = b.script;
  else if (b.script && b.script !== script) script = pickScript(a.script, b.script);
  const liveStartAt = minPositive(a.liveStartAt, b.liveStartAt);
  const settledAt = minPositive(a.settledAt, b.settledAt);
  if (!lotsTouched && !aiLotsTouched && !aiBuysTouched && !readyTouched && !paidTouched
    && script === a.script && liveStartAt === a.liveStartAt && settledAt === a.settledAt) return a;
  return {
    ...a,
    lots,
    aiLots,
    aiBuys,
    ready,
    paid,
    script,
    liveStartAt,
    settledAt,
  };
}

/** 2026-10-03 保管仓保存上限：跨场只留最新 60 条，老记录不无限堆积（同步包越滚越大是拍卖页卡顿主因） */
const HELD_VAULT_CAP = 60;
function pruneHeldVault(vault: Record<string, AuctionLot>): Record<string, AuctionLot> {
  const ids = Object.keys(vault);
  if (ids.length <= HELD_VAULT_CAP) return vault;
  ids.sort((x, y) => vault[y].ts - vault[x].ts);
  return Object.fromEntries(ids.slice(0, HELD_VAULT_CAP).map((id) => [id, vault[id]]));
}

function mergeAuction(local: AuctionState, remote: AuctionState): AuctionState {
  let session = local.session;
  const rs = remote.session;
  if (rs && !session) session = rs;
  else if (rs && session && rs.id !== session.id) {
    // 不同场：进行中的场永远赢（status 优先级），不能让对方被本地的较新空场盖掉
    const winner = betterSession(rs, session);
    // 2026-10-17：双开（各开一场）时把败方的拍品/准备标记并进胜方，货不丢
    session = adoptLots(winner, winner === rs ? session : rs);
  } else if (rs && session) {
    if (SESSION_ORDER[rs.status] > SESSION_ORDER[session.status]) session = rs;
    else if (SESSION_ORDER[rs.status] < SESSION_ORDER[session.status]) session = session;
    else session = mergeSessionFields(session, rs);
  }
  // 战报并集：本地为底、只补远端的新 id（同 id 保留本地副本）。
  // 2026-10-04 修「拍卖页挂着就周期性卡」：旧实现以远端为底，收到的消息哪怕与本地
  // 零变化（心跳常态），archives 引用也必然变成远端解析副本 ≠ 本地引用，
  // sameAuctionState 的零序列化快速路径被每条消息击穿，全量双份 JSON.stringify
  // （含整场剧本，50KB+×2）每 3~6s 跑一次主线程。本地为底后无变化时三字段引用全等，
  // mergeAuction 直接返回 local，心跳接收端零序列化成本
  let archives: Record<string, SettledSummary> = local.archives;
  let archivesTouched = false;
  {
    const tmp: Record<string, SettledSummary> = { ...local.archives };
    for (const [id, s] of Object.entries(remote.archives ?? {})) {
      if (!tmp[id]) { tmp[id] = s; archivesTouched = true; }
    }
    if (archivesTouched) {
      const keepIds = Object.keys(tmp).sort((x, y) => (tmp[y].at ?? 0) - (tmp[x].at ?? 0)).slice(0, 3);
      archives = Object.fromEntries(keepIds.map((id) => [id, tmp[id]]));
    }
  }
  // 保管仓并集：本地为底（同上，保引用相等快速路径）；远端同 id 只有状态更推进
  // （held→returned 赎回墓碑）才覆盖，两端各自按 LOT_ORDER 算出的胜负必然一致
  let heldVault: Record<string, AuctionLot> = local.heldVault;
  let vaultTouched = false;
  {
    const tmp: Record<string, AuctionLot> = { ...local.heldVault };
    for (const [id, lot] of Object.entries(remote.heldVault ?? {})) {
      const cur = tmp[id];
      if (!cur) { tmp[id] = lot; vaultTouched = true; }
      else if ((LOT_ORDER[cur.status] ?? 0) < (LOT_ORDER[lot.status] ?? 0)) { tmp[id] = lot; vaultTouched = true; }
    }
    if (vaultTouched) heldVault = pruneHeldVault(tmp);
  }
  if (session === local.session && archives === local.archives && heldVault === local.heldVault) return local;
  return {
    session,
    archives,
    heldVault,
    v: Math.max(local.v, remote.v),
  };
}

function sameAuctionState(a: AuctionState, b: AuctionState): boolean {
  // 快速路径：merge 无变化时返回原引用，引用全等即相等，零序列化成本
  if (a.session === b.session && a.archives === b.archives && a.heldVault === b.heldVault) return true;
  // 单次序列化比较（剧本较大，双倍 stringify 在消息互刷期是主线程开销大头之一）
  return JSON.stringify([a.session, a.archives, a.heldVault]) === JSON.stringify([b.session, b.archives, b.heldVault]);
}

function scrubForeign(parsed: AuctionState): number {
  if (!membersKnown() || !parsed) return 0;
  let removed = 0;
  const s = parsed.session;
  if (s) {
    for (const [k, lot] of Object.entries(s.lots)) {
      if (!isPairMember(lot?.seller ?? '')) { delete s.lots[k]; removed++; }
    }
    for (const key of ['ready', 'paid'] as const) {
      for (const who of Object.keys(s[key] ?? {})) {
        if (!isPairMember(who)) { delete s[key][who]; removed++; }
      }
    }
    if (s.createdBy && !isPairMember(s.createdBy)) { s.createdBy = ''; removed++; }
  }
  for (const [k, lot] of Object.entries(parsed.heldVault ?? {})) {
    if (!isPairMember(lot?.seller ?? '')) { delete parsed.heldVault[k]; removed++; }
  }
  return removed;
}

/* ---------- 分片同步：点「同步」只发我这一份（2026-10-18） ----------
 * 征集期最痛的动作是「上拍 → 对方看到」。旧路径：listLot → commit → 整包 16KB+
 * （含剧本/保管仓/战报）→ 增量层压一遍 → 大包通道还要给快车道让路 1.5s →
 * 对方 2~4 秒后才看见；丢一条就只能干等 3s 心跳或手动刷新。
 * 现在多一条 <topic>/~p 轻量通道：点「同步」只发「我名下的拍品 + 我的准备时间戳」
 * （几百字节），对方几十毫秒拿到并立刻合并；合并结果再由常规全量/差量写回 retained，
 * 保证刷新 / 换设备时云端有这份新拍品。
 * 安全边界：只并「发送者自己名下的 listed 拍品」和「他的准备时间戳」，
 * 别人的拍品、剧本、战报、保管仓一概不碰；跨场次（sid 不同）直接忽略。 */
export interface AuctionSide { lots: AuctionLot[]; ready: number }

/** 本机当前使用者（收到「请你也报一份」时回发分片用） */
let sideSelf = '';
const sideListeners = new Set<() => void>();

function sideNotify(): void {
  sideListeners.forEach((f) => { try { f(); } catch { /* ignore */ } });
}

/** 我的这一片：本场我在征集期挂着的拍品 + 我的准备时间戳 */
export function mySide(who: string): AuctionSide {
  const s = auctionState().session;
  const lots = s ? Object.values(s.lots).filter((l) => l.seller === who && l.status === 'listed') : [];
  return { lots, ready: s?.ready[who] ?? 0 };
}

/** 收到对端分片：只补「他名下的 listed 拍品」与「他的准备标记」 */
function onSidePacket(msg: PartialEnvelope): void {
  const s = state.session;
  const data = msg.data as AuctionSide | undefined;
  if (s && s.status === 'prep' && (!msg.sid || msg.sid === s.id) && isPairMember(msg.who)) {
    const lots = { ...s.lots };
    let touched = false;
    for (const lot of data?.lots ?? []) {
      if (!lot || lot.seller !== msg.who || lot.status !== 'listed') continue;
      const cur = lots[lot.id];
      if (!cur) { lots[lot.id] = lot; touched = true; continue; }
      // 同 id 只接受状态推进：迟到的分片不能把已撤拍/已成交的拍品拉回 listed
      if ((LOT_ORDER[lot.status] ?? 0) > (LOT_ORDER[cur.status] ?? 0)) { lots[lot.id] = lot; touched = true; }
    }
    const readyTs = Number(data?.ready ?? 0);
    let ready = s.ready;
    if (readyTs > (s.ready[msg.who] ?? 0)) { ready = { ...s.ready, [msg.who]: readyTs }; touched = true; }
    if (touched) {
      state = { ...state, session: { ...s, lots, ready } };
      saveBackupSoon();
      bumpV();
      emit();
      // 合并结果立刻写回云端：对方刷新 / 换设备时 retained 里要有这份新拍品
      sharedPublish(TOPIC, wire(state));
    }
  }
  sideNotify();
  // 「也请把你那份报给我」：刷新时双向对齐（回发一次，不带 req，不会递归）
  if (msg.req && sideSelf && sideSelf !== msg.who) {
    publishPartial<AuctionSide>(TOPIC, sideSelf, mySide(sideSelf), {
      sid: state.session?.id,
      echo: false,
    });
  }
}

/** 点「同步」：只把我的拍品与准备状态发给对方（几百字节，秒到） */
export function syncMySide(who: string): { ok: boolean; msg: string } {
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' };
  start();
  sideSelf = who;
  const s = state.session;
  if (!s) return { ok: false, msg: '还没有拍卖会，先开一场吧' };
  if (s.status !== 'prep') return { ok: false, msg: '征集结束后不用再同步啦' };
  const mine = mySide(who);
  publishPartial<AuctionSide>(TOPIC, who, mine, { sid: s.id, req: true });
  return {
    ok: true,
    msg: mine.lots.length > 0
      ? `已同步你的 ${mine.lots.length} 件拍品${mine.ready ? '与准备状态' : ''}，对方秒收 ⚡`
      : '已请求对方同步，等下他的拍品出现',
  };
}

/** 分片到达 / 「同步」动作时通知 UI（即使主状态没变化也要刷新「x 秒前」） */
export function subscribeAuctionSide(fn: () => void): () => void {
  start();
  sideListeners.add(fn);
  return () => { sideListeners.delete(fn); };
}

/** 本机最近一次收到某人分片的时刻（0 = 本会话没收到过） */
export function sideSeenAt(who: string): number {
  return partialSeenAt(TOPIC, who);
}

function start() {
  if (started) return;
  started = true;
  try {
    const raw = localStorage.getItem(BACKUP);
    if (raw) {
      const b = JSON.parse(raw) as AuctionState;
      if (b && typeof b.v === 'number') {
        scrubForeign(b);
        // 2026-10-03 存量瘦身：老备份里的保管仓可能超大，加载即裁到上限
        state = { session: b.session ?? null, archives: b.archives ?? {}, heldVault: pruneHeldVault(b.heldVault ?? {}), v: b.v };
        lastV = b.v;
      }
    }
  } catch { /* ignore */ }
  sharedSubscribe(TOPIC, (payload) => {
    if (payload.length === 0) return;
    try {
      const s = JSON.parse(payload.toString()) as AuctionState & { t?: number; from?: string };
      if (!s || typeof s.v !== 'number') return;
      const removedForeign = scrubForeign(s);
      const merged = mergeAuction(state, s);
      const changed = removedForeign > 0 || !sameAuctionState(state, merged);
      state = merged;
      anchorClock(state.session, s.t, s.from);
      if (s.v > lastV) lastV = s.v;
      if (changed) {
        // 高频互刷时备份降级为防抖写，避免主线程被大 JSON 同步写卡掉
        saveBackupSoon();
        emit();
        bumpV();
        sharedPublish(TOPIC, wire(state));
      } else if (s.v < lastV) {
        sharedPublish(TOPIC, wire({ ...state, v: lastV }));
      }
    } catch { /* ignore */ }
  });
  // 分片通道：点「同步」时只收「对方那一片」（几百字节），不必等整包
  subscribePartial<AuctionSide>(TOPIC, onSidePacket);
  // 持有者回补（门控触发：掉线超时/切 broker/每日首连）。整包含剧本 50KB+，
  // 旧实现每次重连都发——一天几十次重连 = 持续几十 KB 背景流量堵在发送队列里
  onSharedResync(() => { resyncAuction(); });
  ensureHeartbeat();
}

/* ---------- 全阶段心跳 ----------
 * 2026-10-03 修「双方都准备了却都显示对方没准备」：prep 阶段双方靠互发全量定稿，
 * 但发布是「发一次算一次」——broker 丢包 / 故障转移窗口里一次 setReady 丢失，
 * 对方设备就永远看不到这条准备（当天实况：成员A 14:26:47 的 ready 进了云，
 * 成员B手机却始终没收到，开槌键灰着）。页面打开时周期性重发本地全量
 * （不动 v 不 bump，收到无变化的一方不会回发，不会风暴），无论哪条消息丢了都数秒内收敛。
 * 二期修「上架后总有延迟 / 开槌后对方卡在征集页」：旧心跳只覆盖 prep，
 * 而开槌包（带完整剧本，全场最大的一条消息）和结算包反而没有任何重发兜底——
 * 丢一条对方就干等。现在心跳覆盖 live/settled 全阶段：prep 3s 一拍求快，
 * live/settled 6s 一拍省流量（包大）；live 期间顺手兜底结算（页面挂着但
 * LiveView 已卸载时，播放走完也能自动落战报）。 */
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatBeat = 0;
function ensureHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    try {
      const s = state.session;
      if (!s) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      heartbeatBeat++;
      // settled 是稳态：剧本 + 战报 50KB+ 一包，继续 6s 一拍等于应用开着就永远在
      // 广播全场数据（2026-10-09 查「同步慢」时发现的常驻流量大头）。
      // 结算包有丢的可能，但 30s 兜底足够；live 阶段的自动结算兜底保持 6s 不变
      if (s.status === 'settled' && heartbeatBeat % 10 !== 0) return;
      if (s.status !== 'prep' && heartbeatBeat % 2 !== 0) return; // live 隔拍（6s）
      if (s.status === 'live') settleIfDone(); // 幂等：播放走完自动结算，不依赖 LiveView 存活
      // 征集期心跳改走分片（2026-10-18）：prep 阶段整包 16KB+，每 3 秒重发一次
      // 等于开着页面就一直在往 4M 小水管灌数据，而且大包还要给快车道让路 1.5s。
      // 征集期真正需要兜底的只有「我的拍品 + 我的准备标记」——发分片（几百字节）就够，
      // 整包降到 30 秒一拍，只用来刷新 broker 上的 retained（新设备/刷新时的真相来源）。
      if (s.status === 'prep') {
        const me = sideSelf || (getUserSession()?.name ?? '');
        if (me) publishPartial<AuctionSide>(TOPIC, me, mySide(me), { sid: s.id, echo: false });
        if (heartbeatBeat % 10 !== 0) return;
      }
      sharedPublish(TOPIC, wire({ ...state, v: lastV }));
    } catch { /* ignore */ }
  }, 3000);
}

export function subscribeAuction(fn: () => void): () => void {
  start();
  listeners.add(fn);
  fn();
  return () => { listeners.delete(fn); };
}

export function auctionState(): AuctionState {
  start();
  return state;
}

/** 线上包外壳：状态 + 发送方时钟 t + 实例 id from（时钟锚定采样用） */
function wire(s: AuctionState): string {
  return JSON.stringify({ ...s, t: Date.now(), from: CLIENT_ID });
}

/** 持有者回补：重连即广播本地全量（retained 可能被 broker 清掉）。
 *  全新设备（本地什么数据都没有）不发布：空包会把 broker 上的有效 retained 顶掉，
 *  在「订阅收到旧快照 → 合并回发」之前造出一个空窗，同窗口进入的另一端会拿到空状态 */
export function resyncAuction(): void {
  start();
  const empty = !state.session && lastV === 0
    && Object.keys(state.archives).length === 0 && Object.keys(state.heldVault).length === 0;
  if (empty) return;
  sharedPublish(TOPIC, wire({ ...state, v: lastV }));
}

function commit() {
  bumpV();
  saveBackup();
  sharedPublish(TOPIC, wire(state));
  emit();
}

/* ---------- 玩法动作 ---------- */
const MAX_LOTS_PER_PERSON = 6;
export const MAX_LOTS = MAX_LOTS_PER_PERSON;

/** 主题/行情按「上一场的 id」确定性派生（2026-10-17 修「下一把主题又变了」）：
 *  旧实现两端各摇各的随机数——一旦两台设备各开一场，赢的那场主题跟输的不一样，
 *  先开的那台屏幕上专场名当场跳变（明明已经官宣了「玉镯之夜」）。
 *  改成由上一场 id 派生后，双方各自开新场也摇到同一个主题与行情，谁赢都看不出变化；
 *  首场没有上一场，退化成按「空间 + 今天」派生，两端仍然一致 */
function rollNextTheme(prevId: string): { theme: AuctionTheme; market: MarketTemp } {
  const seed = prevId || `first|${getSpaceId()}|${new Date().toDateString()}`;
  const theme = AUCTION_THEMES[Math.floor(hash01(`theme|${seed}`) * AUCTION_THEMES.length) % AUCTION_THEMES.length];
  const mr = hash01(`market|${seed}`);
  const market: MarketTemp = mr < 0.25 ? 'cold' : mr < 0.75 ? 'normal' : 'hot';
  return { theme, market };
}

/** 开新场前的「云端探路」窗口（2026-10-17 修「一方点了返回、另一方还在战报页，
 *  两台各开一场」）：本机状态可能还停在上一场战报（对方早已开了新场，但消息迟到 /
 *  本机刚从离线回来），直接开就分叉。先向 broker 要一份最新 retained 快照并等一会儿：
 *  探到进行中的场次就收手（UI 随即切到那一场），探不到才自己开。
 *  拍卖包（含剧本/保管仓）常超过 4KB，走的是 mqttClient 的大包延迟通道，
 *  这条探路就是专门补这段延迟的 */
const OPEN_PROBE_MS = 1500;
let opening = false;
function probeCloud(): Promise<void> {
  try { sharedResync(TOPIC); } catch { /* ignore */ }
  return new Promise<void>((resolve) => {
    const deadline = Date.now() + OPEN_PROBE_MS;
    const step = () => {
      const s = state.session;
      if (s && s.status !== 'settled') { resolve(); return; } // 探到进行中的场次，立刻收手
      if (Date.now() >= deadline) { resolve(); return; }
      setTimeout(step, 120);
    };
    setTimeout(step, 120);
  });
}

/** 开一场拍卖会（征集开始）；旧场已 settled 才允许开新场 */
export async function openSession(who: string): Promise<{ ok: boolean; msg: string }> {
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' };
  start();
  if (opening) return { ok: false, msg: '正在开新场，稍等一下…' };
  if (state.session && state.session.status !== 'settled') {
    return { ok: false, msg: '有一场拍卖会还在进行中' };
  }
  opening = true;
  try {
    await probeCloud();
    if (state.session && state.session.status !== 'settled') {
      return { ok: false, msg: '对方已经开了一场，直接去上拍吧' };
    }
    const { theme, market } = rollNextTheme(state.session?.id ?? '');
    const session: AuctionSession = {
      id: `auc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      status: 'prep',
      createdBy: who,
      createdAt: Date.now(),
      themeId: theme.id,
      market,
      lots: {},
      aiLots: {},
      aiBuys: {},
      ready: {},
      liveStartAt: 0,
      settledAt: 0,
      paid: {},
    };
    state = { ...state, session };
    commit();
    return { ok: true, msg: `「${theme.name}」专场征集开始！去挑一件宝贝上拍吧` };
  } finally {
    opening = false;
  }
}

export interface ListLotInput {
  lotId: string;         // UI 侧验货时已生成，flaw 与之一致
  kind: LotKind;
  refId: string;
  name: string;
  varietyId: string;
  typeId?: string;
  emoji: string;
  artKey?: string;
  value: number;
  grams?: number;
  qty?: number;          // 仓库物品上拍数量（成品/原石无）
  reserve: number;
  inspected: boolean;
}

/** 仓库货锁定：扣除物品/升级券（升级券用 UPGRADE_TOKEN_REF 哨兵），返回是否成功 */
function lockWarehouse(who: string, refId: string, qty: number): boolean {
  return refId === UPGRADE_TOKEN_REF ? spendUpgradeToken(who, qty) : spendWarehouseItem(who, { [refId]: qty });
}

/** 仓库货退回（流拍/撤拍）：加回物品/升级券 */
function unlockWarehouse(who: string, refId: string, qty: number): boolean {
  return refId === UPGRADE_TOKEN_REF ? grantUpgradeToken(who, qty) : grantWarehouse(who, { [refId]: qty });
}

/** 上拍：先锁货（jade 状态 → auction / 仓库扣货），再写 lot；同一 refId 不可重复上拍 */
export function listLot(who: string, input: ListLotInput): { ok: boolean; msg: string } {
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' };
  start();
  sideSelf = who;
  const s = state.session;
  if (!s || s.status !== 'prep') return { ok: false, msg: '现在不在征集时间' };
  const mine = Object.values(s.lots).filter((l) => l.seller === who && l.status === 'listed');
  if (mine.length >= MAX_LOTS_PER_PERSON) return { ok: false, msg: `每人最多上拍 ${MAX_LOTS_PER_PERSON} 件` };
  if (Object.values(s.lots).some((l) => l.refId === input.refId && l.status === 'listed')) {
    return { ok: false, msg: '这件宝贝已经在拍卖行啦' };
  }
  const locked = input.kind === 'product'
    ? auctionSendProduct(who, input.refId)
    : input.kind === 'stone'
      ? auctionSendStone(who, input.refId)
      : lockWarehouse(who, input.refId, input.qty ?? 1);
  if (!locked) return { ok: false, msg: '这件宝贝不在手上或已在别处锁定' };
  const lot: AuctionLot = {
    id: input.lotId,
    kind: input.kind,
    refId: input.refId,
    seller: who,
    name: input.name,
    varietyId: input.varietyId,
    typeId: input.typeId,
    emoji: input.emoji,
    artKey: input.artKey,
    value: input.value,
    grams: input.grams,
    qty: input.qty,
    reserve: Math.max(0, Math.round(input.reserve)),
    inspected: input.inspected,
    flaw: input.kind === 'warehouse' ? 'none' : flawOf(input.lotId),
    status: 'listed',
    ts: Date.now(),
  };
  state = { ...state, session: { ...s, lots: { ...s.lots, [lot.id]: lot } } };
  commit();
  return { ok: true, msg: `「${lot.name}」已上拍 🔨` };
}

/** 撤拍（仅征集期）：lot 落 withdrawn 墓碑，货物解锁回 cut/kept */
export function withdrawLot(who: string, lotId: string): { ok: boolean; msg: string } {
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' };
  start();
  sideSelf = who;
  const s = state.session;
  const lot = s?.lots[lotId];
  if (!s || s.status !== 'prep' || !lot || lot.seller !== who || lot.status !== 'listed') {
    return { ok: false, msg: '撤不了这件' };
  }
  if (lot.kind === 'product') auctionResolveProduct(who, lot.refId, false);
  else if (lot.kind === 'stone') auctionResolveStone(who, lot.refId, false);
  else unlockWarehouse(who, lot.refId, lot.qty ?? 1);
  // 2026-10-03 修：ready 是「按人取最大时间戳」的并集合并，删除传不到对方设备——
  // 本地 delete 后对方一回发，自己的 ready 又复活，两端视图不一致。撤拍后保留 ready 标记。
  state = {
    ...state,
    session: { ...s, lots: { ...s.lots, [lotId]: { ...lot, status: 'withdrawn' } } },
  };
  commit();
  return { ok: true, msg: '已撤拍，宝贝回到仓库' };
}

/** 准备完毕（双方都 ready 后才能开槌） */
export function setReady(who: string): { ok: boolean; msg: string } {
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' };
  start();
  sideSelf = who;
  const s = state.session;
  if (!s || s.status !== 'prep') return { ok: false, msg: '现在不在征集时间' };
  const mine = Object.values(s.lots).filter((l) => l.seller === who && l.status === 'listed');
  if (mine.length === 0) return { ok: false, msg: '至少上拍 1 件才能准备' };
  state = { ...state, session: { ...s, ready: { ...s.ready, [who]: Date.now() } } };
  commit();
  return { ok: true, msg: '已准备完毕，等对方也准备好' };
}

/** 开槌：生成整场剧本并广播，1.5 秒后两端同步开拍（旧值 2.5s：
 *  live 包已有全阶段心跳兜底，迟到方数秒内自动对齐，不再需要长固定等待） */
export function startLive(_who: string): { ok: boolean; msg: string } {
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' };
  start();
  const s = state.session;
  if (!s || s.status !== 'prep') return { ok: false, msg: '现在开不了槌' };
  if (orderedListedLots(s).length === 0) return { ok: false, msg: '还没有拍品' };
  const members = Object.keys(s.ready);
  const allReady = members.length >= 2 && Object.values(s.lots).every((l) => l.status !== 'listed' || s.ready[l.seller]);
  if (!allReady) return { ok: false, msg: '等双方都点「准备完毕」再开槌' };
  // AI 卖家的两件私藏：与剧本共用 session.id 种子，先确定性生成再写进场次一起广播
  const seedRng = mulberry32(Math.floor(hash01(s.id) * 4294967296));
  const aiLots = buildAiLots(s, seedRng);
  const withAi: AuctionSession = { ...s, aiLots };
  const script = generateScript(withAi);
  const liveStartAt = Date.now() + 1500;
  state = {
    ...state,
    session: { ...withAi, status: 'live', script, liveStartAt },
  };
  // 自己就是时钟锚点（locked，offset 恒 0）；先落锚，2.5 秒后的第一帧即用对齐时钟
  clockAnchor = { sessionId: s.id, startAt: liveStartAt, best: 0, n: 1, locked: true };
  commit();
  return { ok: true, msg: '咚！拍卖会开始 🔨' };
}

/** 结算（幂等）：lot 落 hammered/held 墓碑 + 成交交割 + 流拍进保管仓 + 战报进 archives */
export function settleSession(): void {
  start();
  const s = state.session;
  if (!s || s.status !== 'live' || !s.script) return;
  const now = Date.now();
  const lots = { ...s.lots };
  const aiLots = { ...(s.aiLots ?? {}) };
  const heldVault = { ...state.heldVault };
  const bySeller: Record<string, SellerSummary> = {};
  for (const ls of s.script.lots) {
    const lot = lots[ls.lotId] ?? aiLots[ls.lotId];
    if (!lot || lot.status !== 'listed') continue;
    const sold = ls.result === 'sold';
    if (lot.ai) {
      // 虚拟货：只推进 lot 状态，无 jade 实物交割
      aiLots[ls.lotId] = { ...lot, status: sold ? 'hammered' : 'returned' };
      continue;
    }
    if (sold) {
      if (lot.kind === 'product') auctionResolveProduct(lot.seller, lot.refId, true);
      else if (lot.kind === 'stone') auctionResolveStone(lot.seller, lot.refId, true);
      // 仓库货成交 = 被 AI 买家买走，不再退回
      lots[ls.lotId] = { ...lot, delivered: lot.delivered || lot.kind === 'warehouse', status: 'hammered' };
    } else {
      // 流拍：货不自动回仓库，留在拍卖行保管仓（jade/farm 里仍锁定），赎回要付保管溢价
      lots[ls.lotId] = { ...lot, status: 'held' };
      heldVault[ls.lotId] = { ...lot, status: 'held' };
    }
    const agg = bySeller[lot.seller] ?? { total: 0, sold: 0, unsold: 0 };
    if (sold) {
      agg.total += ls.price;
      agg.sold += 1;
      if (!agg.bestPrice || ls.price > agg.bestPrice) {
        agg.bestName = lot.name; agg.bestPrice = ls.price; agg.bestTag = ls.tag;
      }
    } else {
      agg.unsold += 1;
    }
    bySeller[lot.seller] = agg;
  }
  // 安全网：不在剧本里却仍 listed 的货（极端边界：开槌瞬间新上的货没进剧本、双开槌剧本择优丢件等）
  // 一律按流拍进保管仓，防止货物状态永久锁死在 auction / 仓库扣减不归还
  const inScript = new Set(s.script.lots.map((ls) => ls.lotId));
  for (const [id, lot] of Object.entries(lots)) {
    if (lot.status !== 'listed' || inScript.has(id)) continue;
    lots[id] = { ...lot, status: 'held' };
    heldVault[id] = { ...lot, status: 'held' };
  }
  for (const [id, lot] of Object.entries(aiLots)) {
    if (lot.status === 'listed' && !inScript.has(id)) aiLots[id] = { ...lot, status: 'returned' };
  }
  // settledAt 取「本地已见的对方结算时间」与 now 的较小者：双端同帧各自触发结算时，
  // 两端写出的 archive.at / session.settledAt 收敛到同一值，战报内容逐字节一致
  const settledAt = minPositive(s.settledAt, now);
  const archives = { ...state.archives, [s.id]: { id: s.id, at: settledAt, bySeller } };
  const keepIds = Object.keys(archives).sort((x, y) => archives[y].at - archives[x].at).slice(0, 3);
  state = {
    ...state,
    session: { ...s, lots, aiLots, status: 'settled', settledAt },
    archives: Object.fromEntries(keepIds.map((id) => [id, archives[id]])),
    heldVault: pruneHeldVault(heldVault),
  };
  commit();
}

/** 播放走完任一设备都可以触发结算。
 *  没锚定时钟（如中途杀进程、从备份恢复 live 场次）多等 10s 宽限：
 *  本机系统时钟若比开槌者快，过早结算会把对方还在播放的场直接掐断 */
export function settleIfDone(): void {
  const s = state.session;
  if (!s || s.status !== 'live' || !s.script) return;
  const anchored = !!clockAnchor && clockAnchor.sessionId === s.id && clockAnchor.startAt === s.liveStartAt;
  const grace = anchored ? 0 : 10_000;
  if (liveElapsed(s) >= s.script.total + grace) settleSession();
}

/** 领取本场成交款（幂等墓碑 paid[who]；流拍品已送进保管仓，赎回走 redeemHeldLot） */
export function claimProceeds(who: string): { ok: boolean; msg: string; amount: number } {
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦', amount: 0 };
  start();
  const s = state.session;
  if (!s || s.status !== 'settled' || !s.script) return { ok: false, msg: '还没结算', amount: 0 };
  if (s.paid[who]) return { ok: false, msg: '已经领过啦', amount: 0 };
  let amount = 0;
  let n = 0;
  for (const ls of s.script.lots) {
    const lot = s.lots[ls.lotId];
    if (lot && lot.seller === who && ls.result === 'sold') { amount += ls.price; n++; }
  }
  state = { ...state, session: { ...s, paid: { ...s.paid, [who]: Date.now() } } };
  commit();
  if (amount > 0) {
    // 确定性交易 id：双端同时自动入账也只记一次（钱包按 id 去重）
    try { addTx(who, amount, `玉缘拍卖会·成交 ${n} 件`, `auc-${s.id}-proceeds-${who}`); } catch { /* ignore */ }
  }
  return { ok: true, msg: amount > 0 ? `成交款 +${fmtMoney(amount)} 时元已入袋 💰` : '本场没有成交，流拍的宝贝已送进保管仓 🏦', amount };
}

/* ---------- 流拍保管仓：货仍锁定，付保管溢价赎回 ---------- */

/** 保管溢价：按上拍估值的 25%（最低 500 时元） */
export const redeemFee = (lot: AuctionLot): number => Math.max(500, round50(lot.value * 0.25));

/** 我（或指定人）在保管仓里的滞留拍品：本场 held + 跨场 heldVault */
export function heldLotsOf(who: string): AuctionLot[] {
  start();
  const out: AuctionLot[] = [];
  const seen = new Set<string>();
  const s = state.session;
  if (s) {
    for (const lot of Object.values(s.lots)) {
      if (lot.seller === who && lot.status === 'held' && !seen.has(lot.id)) { out.push(lot); seen.add(lot.id); }
    }
  }
  for (const lot of Object.values(state.heldVault ?? {})) {
    if (lot.seller === who && lot.status === 'held' && !seen.has(lot.id)) { out.push(lot); seen.add(lot.id); }
  }
  return out.sort(byLotValueDesc);
}

/** 赎回：先落 returned 墓碑（防双端重复赎回），再解锁货物、扣保管溢价（交易 id 确定性，钱包按 id 去重） */
export function redeemHeldLot(who: string, lotId: string, balance: number): { ok: boolean; msg: string } {
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' };
  start();
  const s = state.session;
  const inSession = s?.lots[lotId];
  const inVault = state.heldVault?.[lotId];
  const lot = inSession ?? inVault;
  if (!lot || lot.status !== 'held' || lot.seller !== who) return { ok: false, msg: '这件不在保管仓里' };
  const fee = redeemFee(lot);
  if (balance < fee) return { ok: false, msg: `赎回要付 ${fmtMoney(fee)} 时元保管溢价，先去赚一点吧` };
  const settled = s && inSession && s.status === 'settled' && inSession.status === 'held'
    ? { ...s, lots: { ...s.lots, [lotId]: { ...inSession, status: 'returned' as LotStatus } } }
    : s;
  state = {
    ...state,
    session: settled,
    heldVault: { ...state.heldVault, [lotId]: { ...lot, status: 'returned' as LotStatus } },
  };
  commit();
  if (lot.kind === 'product') auctionResolveProduct(who, lot.refId, false);
  else if (lot.kind === 'stone') auctionResolveStone(who, lot.refId, false);
  else unlockWarehouse(who, lot.refId, lot.qty ?? 1);
  try { addTx(who, -fee, `玉缘拍卖会·赎回${lot.name}（保管溢价）`, `auc-redeem-${lotId}`); } catch { /* ignore */ }
  return { ok: true, msg: `已赎回「${lot.name}」，保管溢价 -${fmtMoney(fee)} 时元，宝贝回仓库啦 🏦` };
}

/** 结算后买下 AI 卖家的货：按落槌成交价，双方先到先得，货入自己仓库（调用方先查余额） */
export function buyAiLot(who: string, lotId: string, balance: number): { ok: boolean; msg: string } {
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' };
  start();
  const s = state.session;
  if (!s || s.status !== 'settled' || !s.script) return { ok: false, msg: '还没结算' };
  const lot = s.aiLots?.[lotId];
  const ls = s.script.lots.find((x) => x.lotId === lotId);
  if (!lot?.ai || !ls || ls.result !== 'sold') return { ok: false, msg: '这件货买不了' };
  const taken = s.aiBuys?.[lotId];
  const stoneId = `ai-${lotId}`;
  if (taken && taken.who !== who) return { ok: false, msg: `已被 ${taken.who} 收下啦` };
  if (balance < ls.price) return { ok: false, msg: '时元不够啦，先去赚一点吧' };
  // 先到先得墓碑先落（幂等：同一人重复点不会重复扣款）
  state = { ...state, session: { ...s, aiBuys: { ...(s.aiBuys ?? {}), [lotId]: { who, ts: Date.now() } } } };
  commit();
  try { addTx(who, -ls.price, `玉缘拍卖会·购得${lot.name}`); } catch { /* ignore */ }
  // 特殊种子：直接发进农场仓库；玉石私藏：按 95% 估值合成一块已切原石
  if (lot.aiSeed) {
    grantWarehouse(who, { [lot.aiSeed]: lot.qty ?? 1 });
    return { ok: true, msg: `「${lot.name}」已入农场仓库，-${fmtMoney(ls.price)} 时元 🌱` };
  }
  const stone: OwnedStone = {
    id: stoneId, tierId: 't1', varietyId: lot.varietyId,
    value: Math.max(50, Math.round(lot.value * 0.95)),
    grams: Math.max(1, lot.grams ?? 50),
    status: 'cut', by: who, ts: Date.now(), cutTs: Date.now(),
  };
  ingestStone(stone);
  return { ok: true, msg: `「${lot.name}」已入仓库，-${fmtMoney(ls.price)} 时元` };
}

/* ---------- 查询助手 ---------- */

/** 拍品统一排序口径：**按估值从高到低**（同价再按时间新的靠前） */
export function byLotValueDesc(a: AuctionLot, b: AuctionLot): number {
  return b.value - a.value || b.ts - a.ts;
}

export function listedLotsOf(session: AuctionSession, who: string): AuctionLot[] {
  return Object.values(session.lots)
    .filter((l) => l.seller === who && l.status === 'listed')
    .sort(byLotValueDesc);
}

export function lotCountOf(session: AuctionSession, who: string): number {
  return Object.values(session.lots).filter((l) => l.seller === who && l.status !== 'withdrawn').length;
}

/** 成品展示用器型 emoji（上拍选品卡片复用） */
export const lotEmoji = (lot: AuctionLot): string =>
  lot.kind === 'product' ? craftTypeById(lot.typeId ?? '').emoji : lot.emoji;

/** 仓库物品上拍信息：名称 / emoji / 估值（升级券用哨兵 UPGRADE_TOKEN_REF） */
export function warehouseLotInfo(refId: string, qty: number): { name: string; emoji: string; value: number } {
  const n = Math.max(1, qty);
  if (refId === UPGRADE_TOKEN_REF) {
    return { name: `土地升级券 ×${n}`, emoji: '🎫', value: UPGRADE_TOKEN_VALUE * n };
  }
  const info = itemInfo(refId);
  return { name: `${info.name} ×${n}`, emoji: info.emoji, value: warehouseItemValue(refId) * n };
}

export const FLAW_LABEL: Record<Flaw, string> = { none: '完美无瑕 ✨', suspect: '疑似有暗裂 ⚠️', crack: '有暗裂，压价凶 🚨' };
export const TAG_LABEL: Record<Tag, string> = { premium: '溢价成交 🔥', fair: '行情成交', cheap: '贱卖亏出 😭', unsold: '流拍 🕊️' };
