/**
 * 开心农场云端同步：MQTT 独立主题，两人各自种植、互相可查看、可偷菜。
 * - 土地：初始 3 块，200 时元开垦一块，上限 20；每种作物按身价有固定生长周期（约 3~6 小时，不对外显示）
 * - 鱼塘：初始 3 个位置，200 时元开一个，上限 20；鱼按品种固定时长
 * - 收获：作物/时元分别独立暴击（2x 10% / 3x 5% / 5x 2% / 10x 0.5%）
 * - 时元奖励 = 作物成本 × 1.0~1.5 取整；洒水 -2 时元加速 1 小时（每日 30 次）
 * - 预留：额外掉落物、合成功能（数据结构已带 warehouse，后续直接扩展）
 */
import { sharedPublish, sharedSubscribe, sharedResync, onSharedConnect, onSharedStatus, onSharedResync } from './mqttClient'
import { setTopicFullOnly } from './syncDelta'
import { publishPartial, subscribePartial, partialSeenAt, type PartialEnvelope } from './syncPartial'

import { addTx } from './wallet'
import { addTreeXp } from './tree'
import { grantReagent, seedStones } from './jade'
import { isPairMember, membersKnown, resolveTopic } from './space'

/** 清理混入的外组账号数据：farms/vv 只保留当前空间成员 */
function scrubForeign(parsed: { farms?: Record<string, unknown>; vv?: Record<string, unknown> }): number {
  if (!membersKnown()) return 0
  let removed = 0
  for (const field of ['farms', 'vv'] as const) {
    const rec = parsed?.[field]
    if (rec && typeof rec === 'object') {
      for (const k of Object.keys(rec)) {
        if (!isPairMember(k)) {
          delete (rec as Record<string, unknown>)[k]
          removed++
        }
      }
    }
  }
  return removed
}

/** 本地已合并进来的外组农场也要清掉（历史混入的数据留在本地备份里） */
function scrubLocal(): number {
  if (!membersKnown()) return 0
  let removed = 0
  for (const k of Object.keys(farms)) {
    if (!isPairMember(k)) {
      delete farms[k]
      removed++
    }
  }
  for (const k of Object.keys(vv)) {
    if (!isPairMember(k)) {
      delete vv[k]
      removed++
    }
  }
  for (const k of Object.keys(cloudFarms)) {
    if (!isPairMember(k)) delete cloudFarms[k]
  }
  for (const k of Object.keys(cloudVv)) {
    if (!isPairMember(k)) delete cloudVv[k]
  }
  freshUsers = new Set([...freshUsers].filter((k) => isPairMember(k)))
  return removed
}

/** 清理后回发干净状态（不动成员的 Lamport 版本，只抬整包版本号） */
function publishCleaned(): void {
  if (Object.keys(farms).length === 0) return // 清理后空了也不发空包，避免误清时抹掉全量数据
  const payload = outboundFarms([])
  if (payload === null) return // 不具备安全条件就不发（清理不是紧急功能，等下次正常发布）
  lastV = Date.now()
  const state: State = { farms: payload, vv, v: lastV }
  sharedPublish(TOPIC, JSON.stringify(state))
}

/** 收到云端快照后，把此前因「不具备安全发布条件」而挂起的用户补发出去 */
function flushPublishQueue(): void {
  if (pendingPublish.size === 0) return
  if (!cloudSnapshotSeen) return
  const users = [...pendingPublish]
  pendingPublish = new Set()
  publishState(users)
}

const TOPIC = 'lovesite/farm/state'
const LS_KEY = 'lovesite-farm-backup'

export const UNLOCK_COST = 200
export const MAX_PLOTS = 20
export const MAX_POND = 20
export const WATER_COST = 2
export const WATER_DAILY_MAX = 30
/** 偷菜血本无归：20% 概率失手，赔仓库随机两件给对方；仓库空空则扣 20 时元 */
export const STEAL_FAIL_RATE = 0.2
export const STEAL_PENALTY = 20
/** 星月夜偷菜失手率大幅降低 */
export const STEAL_FAIL_RATE_MOON = 0.02
/** 种子价格倍率：种植花费翻倍，但收获时元仍按作物原始成本计算（不变） */
export const SEED_PRICE_MULT = 2
/** 虫害概率：种植时 8% 被虫子盯上、4% 被旁边猫踩到，收获时减产 */
const PEST_BUG_RATE = 0.08
const PEST_CAT_RATE = 0.04
/** 种植时判定虫害/猫骚扰（旧数据无 pest 字段） */
function rollPest(): Plot['pest'] {
  const r = Math.random()
  if (r < PEST_BUG_RATE) return 'bug'
  if (r < PEST_BUG_RATE + PEST_CAT_RATE) return 'cat'
  return undefined
}

// ===================== 每日天气（按日期确定性随机，两人看到的一样） =====================
export type Weather = { id: string; emoji: string; name: string; desc: string }
const WEATHERS: Array<Weather & { w: number }> = [
  { id: 'sunny', emoji: '☀️', name: '大晴天', desc: '收获时元 +20%', w: 25 },
  { id: 'rain', emoji: '🌧️', name: '下雨天', desc: '浇水免费 · 加速 2 小时', w: 20 },
  { id: 'rainbow', emoji: '🌈', name: '彩虹天', desc: '暴击概率翻倍', w: 10 },
  { id: 'breeze', emoji: '🍃', name: '微风天', desc: '浇水效果翻倍', w: 15 },
  { id: 'snow', emoji: '❄️', name: '飘雪天', desc: '收获数量 +1', w: 15 },
  { id: 'moon', emoji: '🌙', name: '星月夜', desc: '偷菜失手率降至 30%', w: 15 },
]

/** 今日天气：日期字符串哈希取加权随机，两台手机结果一致 */
export function weatherToday(): Weather {
  const d = new Date()
  const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  // 雪崩混合：日期只变个位数时结果也会剧烈变化（否则天气会一连十几天不变）
  h = (h ^ (h >>> 16)) >>> 0
  h = (h * 0x7feb352d) >>> 0
  h = (h ^ (h >>> 15)) >>> 0
  let r = h % 100
  for (const wx of WEATHERS) {
    if (r < wx.w) return wx
    r -= wx.w
  }
  return WEATHERS[0]
}

// ===================== 土地等级 =====================
/** 0 普通 / 1 银灰 / 2 金色 / 3 紫金 / 4 青色 / 5 天蓝 */
export const LEVEL_NAMES = ['普通土地', '银灰土地', '金色土地', '紫金土地', '青色土地', '天蓝土地']
/** 升到下一级的花费：0→1 200，1→2 300，2→3 400，3→4 1000，4→5 3000 */
export const UPGRADE_COSTS = [200, 300, 400, 1000, 3000]
export const MAX_LEVEL = 5
/** 各级暴击概率倍率加成：升级同时加暴击（含未来特殊奖励掉率），天蓝最高 */
const LEVEL_CRIT_BONUS = [0, 0.3, 0.6, 1.2, 2.0, 3.2]
/** 各级产量加成：升级带来数量增产，每级 +1（普通 +0 …… 天蓝 +5） */
const LEVEL_YIELD_BONUS = [0, 1, 2, 3, 4, 5]
const WATER_SPEEDUP_MS = 3600_000
/** 仙品（进阶作物）掉率：普通 1% / 银灰 2% / 金色 3% / 紫金 5% / 青色 8% / 天蓝 14%，彩虹天翻倍 */
export const RARE_RATES = [0.01, 0.02, 0.03, 0.05, 0.08, 0.14]
/** 进阶作物 id：x_{作物id}，如 x_rose = 仙品·玫瑰 */
export const rareId = (cropId: string): string => `x_${cropId}`
export const isRareId = (id: string): boolean => id.startsWith('x_')

// ===================== 图鉴 =====================
export type Crop = { id: string; name: string; emoji: string; cost: number; group: string; fusionOnly?: boolean }
export type Fish = { id: string; name: string; emoji: string; cost: number; hours: number; group: string }

export const CROPS: Crop[] = [
  // 花卉
  { id: 'rose', name: '玫瑰', emoji: '🌹', cost: 7, group: '花卉' },
  { id: 'tulip', name: '郁金香', emoji: '🌷', cost: 6, group: '花卉' },
  { id: 'sunflower', name: '向日葵', emoji: '🌻', cost: 5, group: '花卉' },
  { id: 'sakura', name: '樱花', emoji: '🌸', cost: 9, group: '花卉' },
  { id: 'lavender', name: '薰衣草', emoji: '🪻', cost: 7, group: '花卉' },
  { id: 'lily', name: '百合', emoji: '💐', cost: 8, group: '花卉' },
  { id: 'daisy', name: '雏菊', emoji: '🌼', cost: 4, group: '花卉' },
  { id: 'carnation', name: '康乃馨', emoji: '🌺', cost: 5, group: '花卉' },
  { id: 'babysbreath', name: '满天星', emoji: '💮', cost: 4, group: '花卉' },
  { id: 'peony', name: '牡丹', emoji: '🏵️', cost: 17, group: '花卉' },
  { id: 'jasmine', name: '茉莉', emoji: '🪷', cost: 6, group: '花卉' },
  { id: 'gardenia', name: '栀子花', emoji: '🌼', cost: 6, group: '花卉' },
  { id: 'hyacinth', name: '风信子', emoji: '🟣', cost: 6, group: '花卉' },
  { id: 'violet', name: '紫罗兰', emoji: '🟪', cost: 5, group: '花卉' },
  { id: 'pansy', name: '三色堇', emoji: '🌈', cost: 4, group: '花卉' },
  { id: 'bellflower', name: '桔梗', emoji: '💜', cost: 5, group: '花卉' },
  { id: 'poppy', name: '虞美人', emoji: '🥀', cost: 6, group: '花卉' },
  { id: 'begonia', name: '海棠', emoji: '🌺', cost: 10, group: '花卉' },
  { id: 'hibiscus', name: '木槿', emoji: '🌸', cost: 4, group: '花卉' },
  { id: 'lycoris', name: '彼岸花', emoji: '🏮', cost: 13, group: '花卉' },
  // 果蔬香草
  { id: 'strawberry', name: '草莓', emoji: '🍓', cost: 5, group: '果蔬香草' },
  { id: 'tomato', name: '番茄', emoji: '🍅', cost: 3, group: '果蔬香草' },
  { id: 'carrot', name: '胡萝卜', emoji: '🥕', cost: 3, group: '果蔬香草' },
  { id: 'pumpkin', name: '南瓜', emoji: '🎃', cost: 7, group: '果蔬香草' },
  { id: 'watermelon', name: '西瓜', emoji: '🍉', cost: 9, group: '果蔬香草' },
  { id: 'grape', name: '葡萄', emoji: '🍇', cost: 10, group: '果蔬香草' },
  { id: 'blueberry', name: '蓝莓', emoji: '🫐', cost: 8, group: '果蔬香草' },
  { id: 'cherry', name: '樱桃', emoji: '🍒', cost: 11, group: '果蔬香草' },
  { id: 'peach', name: '桃子', emoji: '🍑', cost: 7, group: '果蔬香草' },
  { id: 'apple', name: '苹果', emoji: '🍎', cost: 6, group: '果蔬香草' },
  { id: 'lemon', name: '柠檬', emoji: '🍋', cost: 4, group: '果蔬香草' },
  { id: 'mint', name: '薄荷', emoji: '🌿', cost: 3, group: '果蔬香草' },
  { id: 'rosemary', name: '迷迭香', emoji: '🌱', cost: 4, group: '果蔬香草' },
  { id: 'basil', name: '罗勒', emoji: '☘️', cost: 3, group: '果蔬香草' },
  { id: 'mushroom', name: '香菇', emoji: '🍄', cost: 5, group: '果蔬香草' },
  { id: 'corn', name: '玉米', emoji: '🌽', cost: 4, group: '果蔬香草' },
  { id: 'potato', name: '土豆', emoji: '🥔', cost: 3, group: '果蔬香草' },
  { id: 'sweetpotato', name: '红薯', emoji: '🍠', cost: 3, group: '果蔬香草' },
  { id: 'pepper', name: '青椒', emoji: '🫑', cost: 4, group: '果蔬香草' },
  { id: 'eggplant', name: '茄子', emoji: '🍆', cost: 4, group: '果蔬香草' },
  { id: 'cucumber', name: '黄瓜', emoji: '🥒', cost: 3, group: '果蔬香草' },
  { id: 'lettuce', name: '生菜', emoji: '🥬', cost: 3, group: '果蔬香草' },
  { id: 'spinach', name: '菠菜', emoji: '🥗', cost: 3, group: '果蔬香草' },
  { id: 'onion', name: '洋葱', emoji: '🧅', cost: 4, group: '果蔬香草' },
  { id: 'pea', name: '豌豆', emoji: '🫛', cost: 4, group: '果蔬香草' },
  { id: 'tea', name: '茶树', emoji: '🍵', cost: 15, group: '果蔬香草' },
  { id: 'clover', name: '四叶草', emoji: '🍀', cost: 20, group: '果蔬香草' },
  { id: 'succulent', name: '多肉', emoji: '🌵', cost: 5, group: '果蔬香草' },
  // 新增
  { id: 'peanut', name: '花生', emoji: '🥜', cost: 4, group: '新增作物' },
  { id: 'chestnut', name: '栗子', emoji: '🌰', cost: 5, group: '新增作物' },
  { id: 'rice', name: '水稻', emoji: '🌾', cost: 6, group: '新增作物' },
  { id: 'sugarcane', name: '甘蔗', emoji: '🎋', cost: 8, group: '新增作物' },
  { id: 'cocoa', name: '可可豆', emoji: '🍫', cost: 10, group: '新增作物' },
  { id: 'coffee', name: '咖啡豆', emoji: '☕', cost: 12, group: '新增作物' },
  { id: 'mimosa', name: '含羞草', emoji: '🍃', cost: 6, group: '新增作物' },
  { id: 'bamboo', name: '竹子', emoji: '🎋', cost: 8, group: '新增作物' },
  // 融合作物（特殊种子，仅大融合产出，不能用时元购买）
  { id: 'moonberry', name: '月光莓', emoji: '🌙', cost: 22, group: '融合作物', fusionOnly: true },
  { id: 'stardust_corn', name: '星尘玉米', emoji: '🌟', cost: 24, group: '融合作物', fusionOnly: true },
  { id: 'crystal_grape', name: '水晶葡萄', emoji: '💎', cost: 26, group: '融合作物', fusionOnly: true },
  { id: 'aurora_lily', name: '极光百合', emoji: '🌺', cost: 28, group: '融合作物', fusionOnly: true },
  { id: 'void_pumpkin', name: '虚空南瓜', emoji: '🖤', cost: 30, group: '融合作物', fusionOnly: true },
  { id: 'sun_peach', name: '太阳蜜桃', emoji: '☀️', cost: 32, group: '融合作物', fusionOnly: true },
  { id: 'nebula_tea', name: '星云茶', emoji: '🌠', cost: 34, group: '融合作物', fusionOnly: true },
  { id: 'cosmic_carrot', name: '宇宙胡萝卜', emoji: '🪐', cost: 36, group: '融合作物', fusionOnly: true },
]

export const FISH: Fish[] = [
  // 淡水鱼
  { id: 'goldfish', name: '金鱼', emoji: '🐠', cost: 3, hours: 3, group: '淡水鱼' },
  { id: 'guppy', name: '孔雀鱼', emoji: '🦚', cost: 4, hours: 3.5, group: '淡水鱼' },
  { id: 'bitterling', name: '鳑鲏', emoji: '🐟', cost: 5, hours: 4, group: '淡水鱼' },
  { id: 'mandarinfish', name: '鳜鱼', emoji: '🐟', cost: 6, hours: 4.5, group: '淡水鱼' },
  { id: 'betta', name: '斗鱼', emoji: '🥊', cost: 7, hours: 4.5, group: '淡水鱼' },
  { id: 'moonfish', name: '月光鱼', emoji: '🌙', cost: 8, hours: 5, group: '淡水鱼' },
  { id: 'koi', name: '锦鲤', emoji: '🎏', cost: 9, hours: 5, group: '淡水鱼' },
  { id: 'luohan', name: '罗汉鱼', emoji: '🐡', cost: 12, hours: 5.5, group: '淡水鱼' },
  { id: 'dragonfish', name: '龙鱼', emoji: '🐉', cost: 15, hours: 6, group: '淡水鱼' },
  { id: 'piranha', name: '食人鱼', emoji: '🦷', cost: 22, hours: 7, group: '淡水鱼' },
  // 咸水鱼
  { id: 'clownfish', name: '小丑鱼', emoji: '🐠', cost: 10, hours: 5, group: '咸水鱼' },
  { id: 'bluetang', name: '蓝吊鱼', emoji: '💙', cost: 13, hours: 6, group: '咸水鱼' },
  { id: 'butterflyfish', name: '蝴蝶鱼', emoji: '🦋', cost: 15, hours: 6.5, group: '咸水鱼' },
  { id: 'puffer', name: '河豚', emoji: '🎈', cost: 17, hours: 7, group: '咸水鱼' },
  { id: 'lionfish', name: '狮子鱼', emoji: '🦁', cost: 20, hours: 7.5, group: '咸水鱼' },
  { id: 'grouper', name: '石斑鱼', emoji: '🪨', cost: 24, hours: 8, group: '咸水鱼' },
  { id: 'tuna', name: '金枪鱼', emoji: '🔱', cost: 30, hours: 8.5, group: '咸水鱼' },
  { id: 'ray', name: '鳐鱼', emoji: '🪁', cost: 40, hours: 9, group: '咸水鱼' },
  { id: 'shark', name: '鲨鱼', emoji: '🦈', cost: 60, hours: 10, group: '咸水鱼' },
  { id: 'whale', name: '鲸鱼', emoji: '🐳', cost: 100, hours: 12, group: '咸水鱼' },
  // 新增水产
  { id: 'crayfish', name: '小龙虾', emoji: '🦞', cost: 8, hours: 5, group: '新增水产' },
  { id: 'crab', name: '螃蟹', emoji: '🦀', cost: 12, hours: 6, group: '新增水产' },
  { id: 'turtle', name: '乌龟', emoji: '🐢', cost: 15, hours: 6.5, group: '新增水产' },
  { id: 'oyster', name: '珍珠蚌', emoji: '🦪', cost: 20, hours: 8, group: '新增水产' },
]

export const cropById = (id: string) => CROPS.find((c) => c.id === id)
export const fishById = (id: string) => FISH.find((f) => f.id === id)

/** 稀有鱼：钓鱼玩法产出（约 5%）+ 转盘/大融合产出；不可时元购买，但可用鱼苗在鱼塘养殖 */
export const RARE_FISH: Fish[] = [
  { id: 'rf_golddragon', name: '金龙鱼', emoji: '🐲', cost: 0, hours: 12, group: '稀有鱼' },
  { id: 'rf_sturgeon', name: '长江鲟鱼', emoji: '🐋', cost: 0, hours: 10, group: '稀有鱼' },
  { id: 'rf_angelfish', name: '七彩神仙鱼', emoji: '🐬', cost: 0, hours: 8, group: '稀有鱼' },
  { id: 'rf_jelly', name: '荧光水母', emoji: '🪼', cost: 0, hours: 6, group: '稀有鱼' },
  { id: 'rf_squid', name: '深海巨鱿', emoji: '🦑', cost: 0, hours: 9, group: '稀有鱼' },
]
export const rareFishById = (id: string) => RARE_FISH.find((f) => f.id === id)
/** 普通水产或稀有鱼（鱼塘里可能养两种，统一查找） */
export const anyFishById = (id: string) => fishById(id) ?? rareFishById(id)

/**
 * 种子/鱼苗与成品分离：
 * - 融合作物：大融合/转盘产出的是「种子」（seed_ 前缀），种下后收获的是「成品」（作物本身）。
 * - 稀有鱼：转盘产出的是「鱼苗」（fry_ 前缀），放养后收获的是「成品鱼」（鱼本身）。
 * 成品不可再当种子/鱼苗重复种植/养殖，杜绝「越种越多」的无限复制。
 */
export const seedId = (cropId: string): string => `seed_${cropId}`
export const fryId = (fishId: string): string => `fry_${fishId}`
export const isSeedId = (id: string): boolean => id.startsWith('seed_')
export const isFryId = (id: string): boolean => id.startsWith('fry_')

/** 稀有鱼售价（按时元，不低于 150，按稀有程度递增）：可在仓库直接出售 */
export const RARE_FISH_SELL: Record<string, number> = {
  rf_jelly: 150, // 荧光水母
  rf_angelfish: 200, // 七彩神仙鱼
  rf_squid: 260, // 深海巨鱿
  rf_sturgeon: 350, // 长江鲟鱼
  rf_golddragon: 500, // 金龙鱼
}

/**
 * 每种作物的固定生长周期（小时）：越贵的作物成熟越慢，约 3~6 小时。
 *  deterministic——两台手机看到完全一致，不在界面上显示。
 */
export const cropHours = (crop: Crop): number => 3 + Math.min(crop.cost, 30) / 10

/** 合成产出的特殊物品（不可种植/养殖，可收藏展示） */
export const SPECIAL_ITEMS: Record<string, { name: string; emoji: string }> = {
  legend: { name: '传说之证', emoji: '🏆' },
}

export const itemInfo = (id: string): { name: string; emoji: string } => {
  const sp = SPECIAL_ITEMS[id]
  if (sp) return sp
  if (isSeedId(id)) {
    const c = cropById(id.slice('seed_'.length))
    if (c) return { name: `${c.name}种子`, emoji: c.emoji }
  }
  if (isFryId(id)) {
    const f = rareFishById(id.slice('fry_'.length))
    if (f) return { name: `${f.name}鱼苗`, emoji: f.emoji }
  }
  if (isRareId(id)) {
    const rc = cropById(id.slice(2))
    if (rc) return { name: `仙品·${rc.name}`, emoji: rc.emoji }
  }
  const rf = rareFishById(id)
  if (rf) return { name: rf.name, emoji: rf.emoji }
  const c = cropById(id)
  if (c) return { name: c.name, emoji: c.emoji }
  const f = fishById(id)
  if (f) return { name: f.name, emoji: f.emoji }
  const r = recipeById(id)
  if (r) return { name: r.name, emoji: r.emoji }
  return { name: id, emoji: '📦' }
}

// ===================== 图鉴 =====================
/** 图鉴解锁奖励：作物/水产 8，一阶合成 20，二阶 50，三阶 150，仙品作物 50，仙品合成 100，稀有鱼 100 */
export function dexRewardOf(id: string): number {
  if (isRareId(id)) return cropById(id.slice(2)) ? 50 : 0
  if (rareFishById(id)) return 100
  if (id.startsWith('sr') || id.startsWith('xr')) return 100
  const r = recipeById(id)
  if (r) return r.tier === 1 ? 20 : r.tier === 2 ? 50 : 150
  if (cropById(id) || fishById(id)) return 8
  return 0
}

/** 图鉴收录：首次获得某物品返回奖励时元（0 = 已收录或不在图鉴），直接在传入的农场对象上改 */
function dexUnlock(f: FarmOf, id: string): number {
  const cur = f.dex ?? []
  if (cur.includes(id)) return 0
  const reward = dexRewardOf(id)
  if (reward <= 0) return 0
  f.dex = [...cur, id]
  return reward
}

// ===================== 状态 =====================
export type Plot = {
  id: number
  cropId: string | null
  plantedAt: number
  matureAt: number
  stolen: boolean
  /** 土地等级 0~3（旧数据没有此字段，按 0 处理） */
  level?: number
  /** 虫害/猫骚扰：bug=被虫子啃、cat=被旁边猫踩，收获时减产（旧数据无此字段） */
  pest?: 'bug' | 'cat'
  /** 偷菜社交反馈：记录偷菜者（供对方查看） */
  stolenBy?: string
  /** 偷菜社交反馈：偷菜时间戳（供对方展示"X分钟前被偷"） */
  stolenAt?: number
}
export type PondSlot = { id: number; fishId: string | null; startedAt: number; matureAt: number }
export type FarmOf = {
  plots: Plot[]
  pond: PondSlot[]
  warehouse: Record<string, number>
  waterDay: string
  waterCount: number
  /** 追踪中的合成配方 id（旧数据没有此字段，按空数组处理） */
  tracking?: string[]
  /** 图鉴：已解锁的物品 id（旧数据没有此字段，按空数组处理） */
  dex?: string[]
  /** 免费土地升级券（转盘奖励）：1 张可免费升级任意土地一级 */
  upgradeTokens?: number
  /** 今日帮助浇水次数：{ [targetId]: count }，防止滥用 */
  helpsToday?: Record<string, number>
  /** 每日打卡：某人最近一次在樱花树打卡的日期串 YYYY-M-D（旧数据无此字段 = 没打过） */
  checkinDay?: string
}
type State = { farms: Record<string, FarmOf>; vv?: Record<string, number>; v: number }

let initialized = false
let farms: Record<string, FarmOf> = {}
/** 每个用户农场的独立版本号：A 发布时即使带着过期的 B 农场，也不会盖掉 B 刚做的操作 */
let vv: Record<string, number> = {}
let stateReceived = false
let cloudReady = false
/** 本会话真的收到过云端状态包（区别于 3 秒兜底置位）：
 *  assertFarm 只在它成立后才重新发布，避免慢网/云端 retained 丢失时
 *  用过期本地备份以 Lamport max+1 版本盖掉对方刚做的合法操作（如偷菜） */
let cloudSynced = false
/** 已见状态的最大版本号：旧 retained / 自己的回声一律忽略，防止旧数据回滚新操作 */
let lastV = 0
/** 云端已知用户名单（真收到包才更新）：本地没有却要给云端已有的人"新建空农场"时坚决拒绝 */
let cloudUsers = new Set<string>()
/**
 * 本地可担保为「新鲜」的农场主名单（2026-10-10 修数据回退）。
 * retained 主题全站只有一个槽位：任何一次发布都会整包覆盖云端。
 * 若把「本机从未收到过、内存里还是旧版」的对方农场一起发出去，就把对方
 * 刚做的操作（打卡 / 种地 / 收获）从云端抹掉了——新设备/换手机首连时
 * 拿到的就是这份旧包，表现为「打卡记录、作物凭空回退」。
 * 规则：只有 (a) 本机自己改过 或 (b) 本会话真的从云端采纳过 的用户，
 * 其农场内容才允许被发布；其余用户一律用云端快照里的版本（拿不到就不发该用户）。
 */
let freshUsers = new Set<string>()
/** 本会话收到过的最后一份云端农场快照（按人存，供上面 freshUsers 之外的用户兜底引用） */
let cloudFarms: Record<string, FarmOf> = {}
/** 云端快照里每个人的版本号（按人存）：与本地 vv 比大小，决定「谁的内容更新」 */
let cloudVv: Record<string, number> = {}
/** 云端快照的整包版本（救云判定用） */
let cloudPackV = 0
/** 暂不具备安全发布条件的待发用户（收到云端快照后自动补发） */
let pendingPublish = new Set<string>()
/** 本会话是否已处理过至少一份云端包（即使内容是空的）：
 *  broker 确实回了空包 → 我们发布全量是正当的回补，不算「抹掉对方」 */
let cloudSnapshotSeen = false
let subscribers: Array<(f: Record<string, FarmOf>) => void> = []
let errorListeners: Array<(msg: string) => void> = []

function emptyFarm(): FarmOf {
  return {
    plots: [0, 1, 2].map((id) => ({ id, cropId: null, plantedAt: 0, matureAt: 0, stolen: false })),
    pond: [0, 1, 2].map((id) => ({ id, fishId: null, startedAt: 0, matureAt: 0 })),
    warehouse: {},
    waterDay: '',
    waterCount: 0,
    helpsToday: {},
  }
}

export function farmOf(farmsMap: Record<string, FarmOf>, who: string): FarmOf {
  return farmsMap[who] ?? emptyFarm()
}
function loadBackup(): State | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as State
    if (!parsed.farms || typeof parsed.farms !== 'object') return null
    scrubForeign(parsed) // 本地备份也清掉外组数据
    return { farms: parsed.farms, vv: parsed.vv ?? {}, v: parsed.v ?? 0 }
  } catch {
    return null
  }
}

function saveBackup() {
  try {
    // 版本号与当前状态版本一致（而非保存时间），重载后版本守卫才能精确比对
    localStorage.setItem(LS_KEY, JSON.stringify({ farms, vv, v: lastV }))
  } catch {
    /* ignore */
  }
}

function notify() {
  const snapshot = { ...farms }
  subscribers.forEach((cb) => cb(snapshot))
}

function emitError(msg: string) {
  errorListeners.forEach((cb) => cb(msg))
}

function ensureClient() {
  if (initialized) return
  initialized = true

  // ── 全量直通登记（2026-10-11 修「农场数据回退」）──────────────────────────
  // 农场把「发布」当「写云端真相」用：救云回发、assertFarm 自我声明、清理后回发，
  // 都是**内容不变也要再发一遍**，靠覆盖 broker retained 把被别的设备用旧包顶掉的
  // 云端真相抢回来。而增量同步层会把超过 4KB 的包降级成 `/~d`（retain=false）一次性
  // 信令——retained 于是停在被覆盖的旧版本上：新设备/换浏览器冷启动直接拿到旧农场，
  // 再用 Lamport max(vv, now)+1 反向覆盖，所有人一起回退到旧版本。
  // 实测农场包体：3 块地 ≈ 3.6KB，解锁到 6 块 ≈ 4.2KB —— 越过 4096 门槛后必现。
  // 因此农场主题登记为「全量直通」：每个发布原样 retain=true 落盘，语义与本层引入前一致。
  // 2026-10-18 关键修正：登记的必须是**解析后的真实主题**。sharedPublish 会先把
  // 'lovesite/farm/state' 改写成 '<空间前缀>/farm/state'，旧代码登记的是改名前那个串，
  // 白名单永远匹配不上 → 这份「修回退」的修复自上线起就没生效过（农场一直在走差量）。
  setTopicFullOnly(resolveTopic(TOPIC))

  // 本地缓存先行：先用上次的备份立刻渲染，云端数据到了再覆盖
  if (!stateReceived && Object.keys(farms).length === 0) {
    const backup = loadBackup()
    if (backup) {
      farms = backup.farms
      vv = backup.vv ?? {}
      lastV = backup.v ?? 0
    }
  }

  sharedSubscribe(TOPIC, (payload) => {
    if (payload.length === 0) return
    try {
      const state = JSON.parse(payload.toString()) as State
      if (!state.farms || typeof state.farms !== 'object') return
      const removedForeign = scrubForeign(state) + scrubLocal() // 外组农场入口清掉（云端+本地）
      stateReceived = true
      cloudReady = true
      cloudSynced = true // 真收到云端包才允许 assertFarm 重发布
      cloudUsers = new Set(Object.keys(state.farms)) // 云端已知用户名单：commit 凭空建空农场会顶掉他们
      const pv = state.v ?? 0
      // 逐人版本守卫：只采纳比我们更新的那个人的农场。
      // 旧数据没有 vv 字段时退回整包 v 比较（兼容老版本发布的消息）。
      const incVv = state.vv ?? {}
      let changed = false
      const next = { ...farms }
      cloudSnapshotSeen = true // 本会话已处理过一份云端包（空包也算）
      for (const [u, fo] of Object.entries(state.farms)) {
        // 云端快照按人记下（发布时给「本机未采纳」的用户兜底，避免发旧内容）
        cloudFarms[u] = fo
        const iv = incVv[u] ?? pv
        cloudVv[u] = Math.max(cloudVv[u] ?? 0, iv)
        if (iv > (vv[u] ?? 0)) {
          next[u] = fo
          vv[u] = iv
          freshUsers.add(u) // 本会话采纳过 → 内容可担保，允许后续发布
          changed = true
        }
      }
      cloudPackV = Math.max(cloudPackV, pv)
      // 2026-10-18 修「农场数据回退」根因：
      // 旧实现只有「本次采纳过云端」的人才进 freshUsers。可当本地备份比云端**更新或同版本**时
      // （换设备/断线重连/云端被旧包顶过），一个人都进不了担保名单 → outboundFarms 判定
      // 「缺人」→ 整包拒绝发布 → 操作只留在本机，云端 retained 一直是旧版本 →
      // 对方或新设备看到的就是「作物/打卡凭空回退」。
      // 版本号本身就是新旧的定义：本地 vv[u] ≥ 云端 iv[u] 说明本地这份不比云端旧，
      // 天然可担保（发布出去不会把云端更新内容盖掉），直接补进 freshUsers。
      for (const u of Object.keys(farms)) {
        if ((vv[u] ?? 0) >= (cloudVv[u] ?? 0)) freshUsers.add(u)
      }
      if (pv > lastV) lastV = pv
      // 云端农场被清空（retained 丢失 / 被空包覆盖）且本地备份还有数据 → 自动回补重发。
      // 云已经是空的，回补只会更好不会更差；publishState 的 Lamport max+1 让双端都采纳。
      if (Object.keys(state.farms).length === 0) {
        const backup = loadBackup()
        const backupUsers = Object.keys(backup?.farms ?? {})
        const restored = backupUsers.filter((u) => !farms[u])
        if (restored.length > 0) {
          const bf = backup!.farms
          farms = { ...farms, ...Object.fromEntries(restored.map((u) => [u, bf[u]] as [string, FarmOf])) }
          saveBackup()
          notify()
          publishState(restored)
          flushPublishQueue()
          return
        }
      }
      // 救云：收到的包比本机旧（对方设备带着过期副本发布，覆盖了云端真相）。
      // 本机对某些用户持有更高版本 → 立即回发本机较新状态，把云端覆盖回来。
      // 这是「换手机后打卡/作物回退」的兜底修复：必须有人把正确的版本重新推上去。
      if (!changed && pv < lastV) {
        const staleUsers = Object.keys(farms).filter((u) => (vv[u] ?? 0) > (incVv[u] ?? 0))
        if (staleUsers.length > 0 && freshUsers.size > 0) {
          // 用本机版本原样回发（不动 Lamport 链，避免与对方互刷）
          const payload = outboundFarms([])
          if (payload) {
            sharedPublish(TOPIC, JSON.stringify({ farms: payload, vv, v: lastV } satisfies State))
          }
        }
      }
      if (!changed) {
        if (removedForeign > 0) {
          saveBackup()
          notify()
          publishCleaned() // 回发清理后的状态
        }
        flushPublishQueue() // 之前挂起的发布，此刻已有云端快照，可以安全补发
        return // 旧 retained / 自己的回声 / 带着过期他人农场的包
      }
      farms = next
      saveBackup()
      notify()
      if (removedForeign > 0) publishCleaned() // 回发清理后的状态
      flushPublishQueue()
    } catch {
      /* ignore */
    }
  })

  onSharedConnect(() => {
    setTimeout(() => {
      if (!stateReceived) {
        const backup = loadBackup()
        cloudReady = true
        if (backup && Object.keys(backup.farms).length > 0) {
          farms = backup.farms
          vv = { ...vv, ...(backup.vv ?? {}) }
          lastV = Math.max(lastV, backup.v ?? 0)
          // 不再把可能过期的本地备份发布上云（会盖掉对方刚做的操作），仅本地展示
        }
        notify()
      }
    }, 3000)
  })

  onSharedStatus((status, msg) => {
    if (status === 'error') emitError(`连接消息服务器失败：${msg}`)
    else if (status === 'offline') emitError('消息服务器连接中断，正在自动重连…')
    else if (status === 'reconnect') emitError('')
  })

  // 分片通道：点「同步」时只收「对方那一片农场」，不必等整包
  subscribePartial<{ farm?: FarmOf; ver?: number }>(TOPIC, onFarmSide)

  // 断线重连后本地「可担保」名单可能已过期（掉线期间对方改了农场）：
  // 清空担保，强制从新收到的云端包重新采纳——避免拿旧内容发布把对方的改动顶掉
  onSharedResync(() => {
    freshUsers = new Set()
    cloudFarms = {}
    cloudVv = {}
    cloudSnapshotSeen = false
    // 2026-10-18：清空担保后必须**主动要一份 retained**。持久会话（clean:false）下
    // 重连不会重发 retained，旧实现清完就干等一份可能永远不来的包 → 本会话任何操作
    // 都被判定「不具备安全发布条件」而挂起 → 云端停旧版本 → 对端看到回退。
    try { sharedResync(TOPIC) } catch { /* ignore */ }
  })
}

/** 组装允许发布的农场地图。
 *  返回 null = 不可安全发布（发布出去会把云端其他成员抹掉），调用方应延后重发。
 *
 *  安全不变式：**每个已知用户要么用「本机确实不比云端旧」的内容，要么用云端快照的那一份**。
 *  - 本机改过的（changedUsers）、本会话采纳过的（freshUsers）、本地版本 ≥ 云端版本的 → 可信；
 *  - 其余情况（本地副本可能过期）→ 用 cloudFarms 里的云端快照补齐，
 *    绝不再把本机旧副本推上去（这是「打卡/作物回退」的元凶）。
 *  2026-10-18：旧实现在「有一个用户不可信」时**整包拒绝发布**，于是本地的新操作永远
 *  上不了云，云端 retained 停在旧版本 —— 对端和新设备看到的就是回退。改用云端快照兜底后
 *  永远能发布，且任何一份内容都不会比云端更旧。
 *  唯一保留的严格分支：本会话还没收到过任何云端快照（新连上）时不补齐，宁可挂起。 */
function outboundFarms(changedUsers: string[]): Record<string, FarmOf> | null {
  const names = [...new Set([...Object.keys(farms), ...cloudUsers])]
  const out: Record<string, FarmOf> = {}
  for (const u of names) {
    const lv = vv[u] ?? 0
    const cv = cloudVv[u] ?? 0
    const trustLocal = changedUsers.includes(u) || freshUsers.has(u) || lv >= cv
    if (trustLocal && farms[u]) out[u] = farms[u]
    else if (cloudFarms[u]) out[u] = cloudFarms[u]
  }
  if (!cloudSnapshotSeen && names.some((u) => !out[u])) return null
  return Object.keys(out).length > 0 ? out : null
}

function publishState(changedUsers: string[]) {
  // 最后一道保险：空农场地图绝不发布——空包 retained 会抹掉所有人的农场数据
  if (Object.keys(farms).length === 0) return
  const payload = outboundFarms(changedUsers)
  if (payload === null) {
    // 暂不具备安全发布条件（还没拿到云端快照，发出去会抹掉对方农场）：
    // 记账进待发队列，收到云端包后自动重发（见 flushPublishQueue）
    for (const u of changedUsers) pendingPublish.add(u)
    return
  }
  const now = Date.now()
  // Lamport 版本：永远 = max(已见过的版本, 本地时钟) + 1。
  // 旧版直接用本地时钟，偷菜/浇水会由对方设备代写版本号——
  // 两台手机时钟一旦有偏差，版本号被推到"未来"，农场主自己的发布反被忽略，
  // 表现为"对方种的我看不见 / 种下的东西消失"。+1 链条让版本只认先后顺序，不认时钟。
  for (const u of changedUsers) {
    vv[u] = Math.max(vv[u] ?? 0, now) + 1
    freshUsers.add(u)
  }
  lastV = now // 自己的回声会被版本守卫忽略
  const state: State = { farms: payload, vv, v: now }
  sharedPublish(TOPIC, JSON.stringify(state))
}

/** 农场主自我声明：进农场页时延迟调用一次，以本地合并后的本人农场为准重新发布。
 *  版本号是 Lamport max+1，必然大于云端任何残留的旧值，可修复历史时钟偏差造成的
 *  "对方看不见我的农场"卡死状态；同时本地内容已含云端最新合并，不会丢对方的合法操作。 */
export function assertFarm(who: string): void {
  ensureClient()
  // 必须本会话真收到过云端合并后的状态，否则本地备份可能过期，
  // 以 max+1 版本发布会把对方最近的合法操作（偷菜/收获等）顶掉
  if (!cloudSynced) return
  // 本地没有这个人的农场就无可断言——空地图发布会把云端所有人的数据抹掉
  //（2026-10-01 事故：空本地备份 + assertFarm 空包覆盖全量农场数据）
  if (!farms[who]) return
  publishState([who])
}

/* ---------- 分片同步 + 手动刷新（2026-10-18） ----------
 * 农场每个操作都发整包（4~10KB 全量直通），弱网下要一两秒；对方想立刻看到
 * 只能等下一包。点「同步」时走 <topic>/~p 只发「我这一片农场」（1~2KB），
 * 对方立刻合并显示；本机仍照常把整包写回 retained，刷新/换设备不丢。
 * 安全边界：只并「发送者自己的农场」，且必须版本号更大才采纳——
 * 迟到的旧分片绝不覆盖新数据（回退的另一种入口）。 */
export function syncMyFarm(who: string): { ok: boolean; msg: string } {
  ensureClient()
  const mine = farms[who]
  if (!mine) return { ok: false, msg: '还没拿到你的农场数据，稍等一下' }
  publishPartial<{ farm: FarmOf; ver: number }>(TOPIC, who, { farm: mine, ver: vv[who] ?? 0 }, { req: true })
  return { ok: true, msg: '已同步你的农场，对方秒收 ⚡' }
}

/** 手动刷新：重新拉云端 retained（退订重订），再请对方报一份分片。
 *  不清理 freshUsers——那会让本会话的写操作被判定「不可安全发布」而挂起。 */
export function resyncFarm(who: string): void {
  ensureClient()
  try { sharedResync(TOPIC) } catch { /* ignore */ }
  const mine = farms[who]
  if (mine) publishPartial<{ farm: FarmOf; ver: number }>(TOPIC, who, { farm: mine, ver: vv[who] ?? 0 }, { req: true })
}

/** 本机最近一次收到某人分片的时刻（0 = 本会话没收到过） */
export function farmSideSeenAt(who: string): number {
  return partialSeenAt(TOPIC, who)
}

/** 收到对方分片：只并他自己那片农场，版本号守卫防回退 */
function onFarmSide(msg: PartialEnvelope): void {
  const data = msg.data as { farm?: FarmOf; ver?: number } | undefined
  if (!data?.farm || !isPairMember(msg.who)) return
  const rv = Number(data.ver ?? 0)
  if (rv <= (vv[msg.who] ?? 0)) return
  farms = { ...farms, [msg.who]: data.farm }
  vv[msg.who] = rv
  freshUsers.add(msg.who) // 本机采纳过 → 内容可担保
  saveBackup()
  notify()
  // 顺手把合并结果写回云端（对方那包可能还堵在发送队列里）；版本不变，不会互刷
  setTimeout(() => { try { publishState([]) } catch { /* ignore */ } }, 900)
}

export function subscribeFarm(
  onData: (f: Record<string, FarmOf>) => void,
  onError?: (msg: string) => void,
): () => void {
  subscribers.push(onData)
  if (onError) errorListeners.push(onError)
  ensureClient()
  onData({ ...farms })
  return () => {
    subscribers = subscribers.filter((cb) => cb !== onData)
    if (onError) errorListeners = errorListeners.filter((cb) => cb !== onError)
  }
}

/** 统一修改入口：先改农场状态，再记账，最后发布（账本失败则整体放弃，防丢账） */
function commit(who: string, mutate: (f: FarmOf) => void, txs: Array<[number, string]>): boolean {
  ensureClient()
  if (!cloudReady) return false
  // 防"空农场顶号"：本地没有这个人的农场时，先用本地备份回补；
  // 备份也没有、而云端明明有他 → 拒绝操作。此时发布等于用空农场盖掉他的真实数据。
  if (!farms[who]) {
    const backup = loadBackup()
    if (backup?.farms?.[who]) {
      farms = { ...farms, [who]: backup.farms[who] }
      vv[who] = Math.max(vv[who] ?? 0, backup.vv?.[who] ?? 0)
    } else if (cloudSynced && cloudUsers.has(who)) {
      return false // 等下一次合并拿到云端农场后再操作
    }
  }
  const mine = farmOf(farms, who)
  const copy: FarmOf = JSON.parse(JSON.stringify(mine))
  // 图鉴回填：历史库存静默收录（不发奖励），保证老玩家图鉴不为空
  copy.dex = [...new Set([...(copy.dex ?? []), ...Object.keys(copy.warehouse)])]
  mutate(copy)
  for (const [delta, reason] of txs) {
    if (!addTx(who, delta, reason)) return false
  }
  farms = { ...farms, [who]: copy }
  saveBackup()
  publishState([who])
  notify()
  return true
}

function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/**
 * 暴击判定（基础概率已调低）：2x 5% / 3x 2% / 5x 0.8% / 10x 0.2%。
 * mult 为概率倍率（土地等级加成 × 彩虹天翻倍），普通土地晴天 = 1。
 */
export function rollCrit(mult = 1): number {
  const r = Math.random()
  if (r < 0.002 * mult) return 10
  if (r < 0.008 * mult) return 5
  if (r < 0.02 * mult) return 3
  if (r < 0.05 * mult) return 2
  return 1
}

/** 地块暴击倍率：土地等级加成，彩虹天翻倍 */
function plotCritMult(plot: Plot, wx: Weather): number {
  return (1 + LEVEL_CRIT_BONUS[plot.level ?? 0]) * (wx.id === 'rainbow' ? 2 : 1)
}

export type ActionResult = { ok: boolean; msg: string }

// ===================== 操作 =====================

export function unlockPlot(who: string, balance: number): ActionResult {
  const mine = farmOf(farms, who)
  if (mine.plots.length >= MAX_PLOTS) return { ok: false, msg: '土地已到上限 20 块' }
  if (balance < UNLOCK_COST) return { ok: false, msg: `时元不足（需要 ${UNLOCK_COST}）` }
  const id = mine.plots.length
  const ok = commit(who, (f) => {
    f.plots.push({ id, cropId: null, plantedAt: 0, matureAt: 0, stolen: false })
  }, [[-UNLOCK_COST, '开垦土地']])
  return ok ? { ok: true, msg: '开垦成功，多了一块地！' } : { ok: false, msg: '同步中，请稍后再试' }
}

export function unlockPond(who: string, balance: number): ActionResult {
  const mine = farmOf(farms, who)
  if (mine.pond.length >= MAX_POND) return { ok: false, msg: '养殖位置已到上限 20 个' }
  if (balance < UNLOCK_COST) return { ok: false, msg: `时元不足（需要 ${UNLOCK_COST}）` }
  const id = mine.pond.length
  const ok = commit(who, (f) => {
    f.pond.push({ id, fishId: null, startedAt: 0, matureAt: 0 })
  }, [[-UNLOCK_COST, '开通养殖位']])
  return ok ? { ok: true, msg: '开通成功，可以多养一条鱼！' } : { ok: false, msg: '同步中，请稍后再试' }
}

export function plant(who: string, plotId: number, cropId: string, balance: number): ActionResult {
  const crop = cropById(cropId)
  if (!crop) return { ok: false, msg: '未知作物' }
  if (crop.fusionOnly) return { ok: false, msg: '融合作物不能时元购买，需用融合种子' }
  const price = crop.cost * SEED_PRICE_MULT
  if (balance < price) return { ok: false, msg: `时元不足（需要 ${price}）` }
  const now = Date.now()
  const hours = cropHours(crop)
  const ok = commit(who, (f) => {
    const plot = f.plots.find((p) => p.id === plotId)
    if (!plot || plot.cropId) return
    Object.assign(plot, { cropId, plantedAt: now, matureAt: now + hours * 3600_000, stolen: false, pest: rollPest() })
  }, [[-price, `种下${crop.name}`]])
  if (ok) addTreeXp(who) // 种植行为：爱情树 +2
  return ok ? { ok: true, msg: `${crop.emoji} ${crop.name} 种下了` } : { ok: false, msg: '同步中，请稍后再试' }
}

export function stockFish(who: string, slotId: number, fishId: string, balance: number): ActionResult {
  const fish = fishById(fishId)
  if (!fish) return { ok: false, msg: '未知水产' }
  if (balance < fish.cost) return { ok: false, msg: `时元不足（需要 ${fish.cost}）` }
  const now = Date.now()
  const ok = commit(who, (f) => {
    const slot = f.pond.find((s) => s.id === slotId)
    if (!slot || slot.fishId) return
    Object.assign(slot, { fishId, startedAt: now, matureAt: now + fish.hours * 3600_000 })
  }, [[-fish.cost, `放养${fish.name}`]])
  if (ok) addTreeXp(who) // 养殖行为：爱情树 +2
  return ok ? { ok: true, msg: `${fish.emoji} ${fish.name} 入水了` } : { ok: false, msg: '同步中，请稍后再试' }
}

/** 用稀有鱼鱼苗放养（消耗仓库里 1 只「鱼苗」，不用时元；收获得到的是「成品鱼」，不可再当鱼苗） */
export function stockRareFish(who: string, slotId: number, fishId: string): ActionResult {
  const fish = rareFishById(fishId)
  if (!fish) return { ok: false, msg: '不是稀有鱼' }
  const fid = fryId(fishId)
  const mine = farmOf(farms, who)
  if ((mine.warehouse[fid] ?? 0) < 1) return { ok: false, msg: `没有 ${fish.name} 的鱼苗` }
  const now = Date.now()
  const ok = commit(who, (f) => {
    const slot = f.pond.find((s) => s.id === slotId)
    if (!slot || slot.fishId) return
    f.warehouse[fid] -= 1
    if (f.warehouse[fid] <= 0) delete f.warehouse[fid]
    Object.assign(slot, { fishId, startedAt: now, matureAt: now + fish.hours * 3600_000 })
  }, [])
  if (ok) addTreeXp(who)
  return ok ? { ok: true, msg: `${fish.emoji} ${fish.name} 入水了` } : { ok: false, msg: '同步中，请稍后再试' }
}

export function water(who: string, plotId: number, balance: number): ActionResult {
  const wx = weatherToday()
  const cost = wx.id === 'rain' ? 0 : WATER_COST
  const speedup =
    wx.id === 'rain' || wx.id === 'breeze' ? WATER_SPEEDUP_MS * 2 : WATER_SPEEDUP_MS
  if (balance < cost) return { ok: false, msg: `时元不足（需要 ${cost}）` }
  const day = todayKey()
  const mine = farmOf(farms, who)
  const used = mine.waterDay === day ? mine.waterCount : 0
  if (used >= WATER_DAILY_MAX) return { ok: false, msg: '今天浇水次数用完啦（30 次）' }
  const plot = mine.plots.find((p) => p.id === plotId)
  if (!plot || !plot.cropId) return { ok: false, msg: '这块地还没种东西' }
  if (plot.matureAt <= Date.now()) return { ok: false, msg: '已经成熟，直接收获吧' }
  const willMature = plot.matureAt - speedup <= Date.now()
  const ok = commit(who, (f) => {
    const p = f.plots.find((x) => x.id === plotId)!
    p.matureAt = Math.max(Date.now(), p.matureAt - speedup)
    f.waterDay = day
    f.waterCount = used + 1
  }, cost > 0 ? [[-cost, '浇水加速']] : [])
  const hours = speedup / 3600_000
  const freeText = cost === 0 ? '（雨天免费）' : ''
  return ok
    ? {
        ok: true,
        msg: willMature
          ? `💧 浇透了，已经成熟，快收获吧${freeText}`
          : `💧 生长加速 ${hours} 小时${freeText}`,
      }
    : { ok: false, msg: '同步中，请稍后再试' }
}

export function curePest(who: string, plotId: number, balance: number): ActionResult {
  const mine = farmOf(farms, who)
  const plot = mine.plots.find((p) => p.id === plotId)
  if (!plot || !plot.cropId) return { ok: false, msg: '这块地还没种东西' }
  if (!plot.pest) return { ok: false, msg: '这块地没有虫害或猫骚扰' }
  const cost = 5 // 花费 5 时元清除害虫
  if (balance < cost) return { ok: false, msg: `时元不足（需要 ${cost}）` }
  const ok = commit(who, (f) => {
    const p = f.plots.find((x) => x.id === plotId)!
    p.pest = undefined
  }, [[-cost, '清除害虫']])
  return ok
    ? { ok: true, msg: `✅ 已清除${plot.pest === 'bug' ? '虫害' : '猫骚扰'}！` }
    : { ok: false, msg: '同步中，请稍后再试' }
}

export function helpWater(who: string, target: string, plotId: number, balance: number): ActionResult {
  ensureClient()
  // 跨用户写：对方农场必须新鲜，否则会基于旧副本改写（回退源之一）
  if (cloudSynced && !freshUsers.has(target)) {
    return { ok: false, msg: '正在同步对方农场，请稍后再试' }
  }
  const mine = farmOf(farms, who)
  const targetFarm = farmOf(farms, target)
  const plot = targetFarm.plots.find((p) => p.id === plotId)
  if (!plot || !plot.cropId) return { ok: false, msg: '这块地还没种东西' }
  if (plot.matureAt <= Date.now()) return { ok: false, msg: '已经成熟，直接收获吧' }

  // 检查今日帮助次数限制（每日最多 5 次）
  const helpsToday = mine.helpsToday ?? {}
  if (helpsToday[target] && helpsToday[target] >= 5) {
    return { ok: false, msg: '今天帮助浇水次数已用完（最多 5 次）' }
  }

  const cost = 2 // 花费 2 时元帮助浇水
  if (balance < cost) return { ok: false, msg: `时元不足（需要 ${cost}）` }
  if (!cloudReady) return { ok: false, msg: '同步中，请稍后再试' }

  const speedup = WATER_SPEEDUP_MS // 加速 1 小时
  const willMature = plot.matureAt - speedup <= Date.now()
  // 两处修改：自己的帮助次数 + 对方的作物成熟时间。两边都走深拷贝后整体替换，
  // 并各自抬版本号，避免「改了对方农场却只给自己抬版本」导致对方端回退。
  const myCopy: FarmOf = JSON.parse(JSON.stringify(mine))
  const targetCopy: FarmOf = JSON.parse(JSON.stringify(targetFarm))
  myCopy.helpsToday = { ...myCopy.helpsToday, [target]: (myCopy.helpsToday?.[target] ?? 0) + 1 }
  const tp = targetCopy.plots.find((x) => x.id === plotId)!
  tp.matureAt = Math.max(Date.now(), tp.matureAt - speedup)
  if (!addTx(who, -cost, '帮助浇水')) return { ok: false, msg: '同步中，请稍后再试' }
  farms = { ...farms, [who]: myCopy, [target]: targetCopy }
  saveBackup()
  publishState([who, target])
  notify()

  return {
    ok: true,
    msg: willMature
      ? `💧 你帮 ${target} 浇了水，TA 的作物已经成熟！`
      : `💧 你帮 ${target} 浇了水，加速 1 小时`,
  }
}

export type HarvestGain = {
  emoji: string
  name: string
  qty: number
  qtyCrit: number
  coins: number
  coinCrit: number
}

function harvestOne(f: FarmOf, plot: Plot, gains: HarvestGain[]): [number, string][] {
  const crop = cropById(plot.cropId!)
  const now = Date.now()
  if (!crop || plot.matureAt > now) return []
  const wx = weatherToday()
  const mult = plotCritMult(plot, wx)
  const qtyCrit = rollCrit(mult)
  const coinCrit = rollCrit(mult)
  // 基础产量 1~2 朵（被偷 -1，飘雪天 +1，土地等级每级再 +1 增产）
  const baseQty = Math.max(
    1,
    1 + Math.floor(Math.random() * 2) - (plot.stolen ? 1 : 0) + (wx.id === 'snow' ? 1 : 0) + LEVEL_YIELD_BONUS[plot.level ?? 0],
  )
  let qty = baseQty * qtyCrit
  // 虫害/猫骚扰：被虫子啃减产 1，被旁边猫踩减产 2（保底 1）
  if (plot.pest === 'bug') qty = Math.max(1, qty - 1)
  else if (plot.pest === 'cat') qty = Math.max(1, qty - 2)
  const coins =
    Math.floor(crop.cost * (1 + Math.random() * 0.5) * (wx.id === 'sunny' ? 1.2 : 1)) * coinCrit
  f.warehouse[crop.id] = (f.warehouse[crop.id] ?? 0) + qty
  gains.push({ emoji: crop.emoji, name: crop.name, qty, qtyCrit, coins, coinCrit })
  const txs: [number, string][] = [[coins, `收获${crop.name}`]]
  const dexCrop = dexUnlock(f, crop.id)
  if (dexCrop > 0) txs.push([dexCrop, `图鉴解锁·${crop.name}`])
  // 仙品掉落：土地等级越高概率越大，彩虹天翻倍，独立额外掉落
  const rareRate = RARE_RATES[plot.level ?? 0] * (wx.id === 'rainbow' ? 2 : 1)
  if (Math.random() < rareRate) {
    const rid = rareId(crop.id)
    f.warehouse[rid] = (f.warehouse[rid] ?? 0) + 1
    gains.push({ emoji: crop.emoji, name: `仙品·${crop.name}`, qty: 1, qtyCrit: 1, coins: 0, coinCrit: 1 })
    const dexRare = dexUnlock(f, rid)
    if (dexRare > 0) txs.push([dexRare, `图鉴解锁·仙品${crop.name}`])
  }
  Object.assign(plot, { cropId: null, plantedAt: 0, matureAt: 0, stolen: false, pest: undefined })
  return txs
}

export function harvest(who: string, plotId: number): { ok: boolean; msg: string; gain: HarvestGain | null } {
  const gains: HarvestGain[] = []
  let txs: [number, string][] = []
  const mine = farmOf(farms, who)
  const plot = mine.plots.find((p) => p.id === plotId)
  if (!plot || !plot.cropId) return { ok: false, msg: '这块地是空的', gain: null }
  if (plot.matureAt > Date.now()) return { ok: false, msg: '还没成熟', gain: null }
  const ok = commit(who, (f) => {
    const p = f.plots.find((x) => x.id === plotId)!
    txs = harvestOne(f, p, gains)
  }, [])
  if (!ok) return { ok: false, msg: '同步中，请稍后再试', gain: null }
  // 单独记时元账（commit 内不放账，避免收益未知时先扣账）
  for (const [delta, reason] of txs) addTx(who, delta, reason)
  const g = gains[0]
  const critText = g.coinCrit > 1 || g.qtyCrit > 1 ? ` 🎉暴击 x${Math.max(g.qtyCrit, g.coinCrit)}！` : ''
  return { ok: true, msg: `收获 ${g.emoji}${g.name}×${g.qty} +${g.coins}时元${critText}`, gain: g }
}

export function harvestFish(who: string, slotId: number): { ok: boolean; msg: string; gain: HarvestGain | null } {
  const mine = farmOf(farms, who)
  const slot = mine.pond.find((s) => s.id === slotId)
  if (!slot || !slot.fishId) return { ok: false, msg: '这个位置是空的', gain: null }
  if (slot.matureAt > Date.now()) return { ok: false, msg: '还没养好', gain: null }
  const fish = anyFishById(slot.fishId)!
  const wx = weatherToday()
  const mult = wx.id === 'rainbow' ? 2 : 1
  const qtyCrit = rollCrit(mult)
  const coinCrit = rollCrit(mult)
  const qty = qtyCrit + (wx.id === 'snow' ? 1 : 0)
  const coins =
    Math.floor(fish.cost * (1 + Math.random() * 0.5) * (wx.id === 'sunny' ? 1.2 : 1)) * coinCrit
  const gain: HarvestGain = { emoji: fish.emoji, name: fish.name, qty, qtyCrit, coins, coinCrit }
  let dexGain = 0
  const ok = commit(who, (f) => {
    const s = f.pond.find((x) => x.id === slotId)!
    f.warehouse[fish.id] = (f.warehouse[fish.id] ?? 0) + qty
    dexGain = dexUnlock(f, fish.id)
    Object.assign(s, { fishId: null, startedAt: 0, matureAt: 0 })
  }, [])
  if (!ok) return { ok: false, msg: '同步中，请稍后再试', gain: null }
  addTx(who, coins, `收鱼·${fish.name}`)
  if (dexGain > 0) addTx(who, dexGain, `图鉴解锁·${fish.name}`)
  const critText = qtyCrit > 1 || coinCrit > 1 ? ` 🎉暴击 x${Math.max(qtyCrit, coinCrit)}！` : ''
  return { ok: true, msg: `收鱼 ${fish.emoji}${fish.name}×${qty} +${coins}时元${critText}`, gain }
}

export function steal(thief: string, owner: string, plotId: number): ActionResult {
  ensureClient()
  // 跨用户写：必须确保对方农场是本会话从云端采纳过的新鲜内容。
  // 否则本地可能还是旧副本（对方刚收获过），偷菜会基于旧数据改写并把它当真相发布（回退源之一）。
  if (cloudSynced && !freshUsers.has(owner)) {
    return { ok: false, msg: '正在同步对方农场，请稍后再试' }
  }
  const target = farmOf(farms, owner)
  const plot = target.plots.find((p) => p.id === plotId)
  if (!plot || !plot.cropId) return { ok: false, msg: '这块地是空的' }
  if (plot.matureAt > Date.now()) return { ok: false, msg: '还没成熟，偷不了哦' }
  if (plot.stolen) return { ok: false, msg: '这块已经被偷过啦' }
  const crop = cropById(plot.cropId)!
  if (!cloudReady) return { ok: false, msg: '同步中，请稍后再试' }

  // 触发血本无归判定：默认 50%，星月夜手更稳降到 30%
  if (Math.random() < (weatherToday().id === 'moon' ? STEAL_FAIL_RATE_MOON : STEAL_FAIL_RATE)) {
    const myFarm: FarmOf = JSON.parse(JSON.stringify(farmOf(farms, thief)))
    // 仓库摊平成单件池，随机抽最多 2 件（合成物、仙品合成物不进池，只赔种植物和鱼）
    const pool: string[] = []
    for (const [id, n] of Object.entries(myFarm.warehouse)) {
      if (recipeById(id) || SPECIAL_ITEMS[id]) continue
      for (let i = 0; i < n; i++) pool.push(id)
    }
    if (pool.length === 0) {
      // 没有可赔的：扣 20 时元
      if (!addTx(thief, -STEAL_PENALTY, '偷菜失手，血本无归被罚')) {
        return { ok: false, msg: '同步中，请稍后再试' }
      }
      return { ok: true, msg: `😱 血本无归！没偷成，没有可赔的作物水产，被扣 ${STEAL_PENALTY} 时元` }
    }
    const ownerCopy: FarmOf = JSON.parse(JSON.stringify(target))
    const lost: string[] = []
    for (let i = 0; i < 2 && pool.length > 0; i++) {
      const idx = Math.floor(Math.random() * pool.length)
      lost.push(pool.splice(idx, 1)[0])
    }
    let ownerDexGain = 0
    for (const id of lost) {
      myFarm.warehouse[id] -= 1
      if (myFarm.warehouse[id] <= 0) delete myFarm.warehouse[id]
      ownerCopy.warehouse[id] = (ownerCopy.warehouse[id] ?? 0) + 1
      ownerDexGain += dexUnlock(ownerCopy, id) // 对方首次获得也算图鉴解锁
    }
    farms = { ...farms, [owner]: ownerCopy, [thief]: myFarm }
    saveBackup()
    publishState([owner, thief])
    notify()
    if (ownerDexGain > 0) addTx(owner, ownerDexGain, '图鉴解锁（来自对方罚没）')
    const lostText = lost
      .map((id) => {
        const info = itemInfo(id)
        return `${info.emoji}${info.name}×1`
      })
      .join('、')
    return { ok: true, msg: `😱 血本无归！没偷成，还赔了 ${lostText} 给对方` }
  }

  // 偷菜成功：对方整株消失，1~2 个进自己仓库
  const qty = 1 + Math.floor(Math.random() * 2)
  const ownerCopy: FarmOf = JSON.parse(JSON.stringify(target))
  Object.assign(ownerCopy.plots.find((p) => p.id === plotId)!, {
    cropId: null,
    plantedAt: 0,
    matureAt: 0,
    stolen: false,
    stolenBy: thief, // 记录偷菜者
    stolenAt: Date.now(), // 记录偷菜时间
  })
  const myFarm: FarmOf = JSON.parse(JSON.stringify(farmOf(farms, thief)))
  myFarm.warehouse[crop.id] = (myFarm.warehouse[crop.id] ?? 0) + qty
  const dexGain = dexUnlock(myFarm, crop.id)
  farms = { ...farms, [owner]: ownerCopy, [thief]: myFarm }
  saveBackup()
  publishState([owner, thief])
  notify()
  if (dexGain > 0) addTx(thief, dexGain, `图鉴解锁·${crop.name}`)
  return { ok: true, msg: `🥷 偷到 ${crop.emoji}${crop.name}×${qty}！TA 的这块地空了` }
}

// ===================== 钓鱼玩法 =====================

/** 钓鱼从池塘捞走一条成熟鱼（自家=收走，对方家=钓走 TA 的）。
 *  返回被捞走的鱼 id；鱼未成熟/已被捞走返回 null。渔获入仓由 grantFishingLoot 负责。 */
export function pondFishCaught(owner: string, slotId: number): string | null {
  ensureClient()
  if (!cloudReady) return null
  // 跨用户写：对方农场必须新鲜（钓鱼从对方塘里捞鱼同理，旧副本会把对方刚捞走的鱼复活）
  if (cloudSynced && !freshUsers.has(owner)) return null
  const target = farmOf(farms, owner)
  const slot = target.pond.find((s) => s.id === slotId)
  if (!slot || !slot.fishId) return null
  if (slot.matureAt > Date.now()) return null
  const fishId = slot.fishId
  const ownerCopy: FarmOf = JSON.parse(JSON.stringify(target))
  Object.assign(ownerCopy.pond.find((s) => s.id === slotId)!, { fishId: null, startedAt: 0, matureAt: 0 })
  farms = { ...farms, [owner]: ownerCopy }
  saveBackup()
  publishState([owner])
  notify()
  return fishId
}

/** 钓鱼渔获入仓（含图鉴解锁奖励）；每次出钩结算一次，防止中途关页面丢渔获 */
export function grantFishingLoot(who: string, loot: Record<string, number>): boolean {
  const entries = Object.entries(loot).filter(([, n]) => n > 0)
  if (entries.length === 0) return true
  let dexGain = 0
  const dexNames: string[] = []
  const ok = commit(who, (f) => {
    for (const [id, n] of entries) {
      f.warehouse[id] = (f.warehouse[id] ?? 0) + n
      const g = dexUnlock(f, id)
      if (g > 0) {
        dexGain += g
        dexNames.push(itemInfo(id).name)
      }
    }
  }, [])
  if (!ok) return false
  if (dexGain > 0) addTx(who, dexGain, `图鉴解锁·${dexNames.join('、')}`)
  return true
}

/** 互赠礼物：从赠送者仓库扣除物品（任一不足则不动仓，返回 false） */
export function removeFromWarehouse(who: string, items: Record<string, number>): boolean {
  ensureClient()
  if (!cloudReady) return false
  const mine = farmOf(farms, who)
  for (const [id, n] of Object.entries(items)) {
    if ((mine.warehouse[id] ?? 0) < n) return false
  }
  return commit(who, (f) => {
    for (const [id, n] of Object.entries(items)) {
      f.warehouse[id] -= n
      if (f.warehouse[id] <= 0) delete f.warehouse[id]
    }
  }, [])
}

/** 拍卖会锁定仓库物品：扣除物品（任一不足则不动仓，返回 false） */
export function spendWarehouseItem(who: string, items: Record<string, number>): boolean {
  return removeFromWarehouse(who, items)
}

/** 拍卖会退回仓库物品（流拍）：直接加回仓库，不触发图鉴奖励 */
export function grantWarehouse(who: string, items: Record<string, number>): boolean {
  ensureClient()
  if (!cloudReady) return false
  return commit(who, (f) => {
    for (const [id, n] of Object.entries(items)) {
      f.warehouse[id] = (f.warehouse[id] ?? 0) + n
    }
  }, [])
}

/** 土地升级券（转盘奖励）单张估值：升级任意土地一级（200~3000 时元），取中间锚定值 */
export const UPGRADE_TOKEN_VALUE = 1000

/** 拍卖会锁定土地升级券：扣除 n 张（不足返回 false） */
export function spendUpgradeToken(who: string, n: number): boolean {
  ensureClient()
  if (!cloudReady) return false
  const mine = farmOf(farms, who)
  if ((mine.upgradeTokens ?? 0) < n) return false
  return commit(who, (f) => {
    f.upgradeTokens = Math.max(0, (f.upgradeTokens ?? 0) - n)
  }, [])
}

/** 拍卖会退回土地升级券（流拍） */
export function grantUpgradeToken(who: string, n: number): boolean {
  ensureClient()
  if (!cloudReady) return false
  return commit(who, (f) => {
    f.upgradeTokens = (f.upgradeTokens ?? 0) + n
  }, [])
}

/** 仓库物品估值（拍卖会锚定用）：稀有鱼按售价，作物按成本×2，水产按成本，配方按奖励 */
export function warehouseItemValue(id: string): number {
  if (isFryId(id)) {
    const f = rareFishById(id.slice('fry_'.length))
    return f ? (RARE_FISH_SELL[f.id] ?? 150) : 150
  }
  const rf = rareFishById(id)
  if (rf) return RARE_FISH_SELL[id] ?? 150
  if (isRareId(id)) {
    const c = cropById(id.slice(2))
    return c ? c.cost * 6 : 60 // 仙品锚定价 = 非仙品（成本×2）的 3 倍
  }
  if (isSeedId(id)) {
    const c = cropById(id.slice('seed_'.length))
    return c ? c.cost * 2 : 20
  }
  const c = cropById(id)
  if (c) return c.fusionOnly ? FUSION_CROP_VALUE * 2 : c.cost * 2
  const f = fishById(id)
  if (f) return f.cost
  const r = recipeById(id)
  if (r) return r.reward
  return 20
}

/** 出售稀有鱼：从仓库卖出换时元（1 只起卖） */
export function sellRareFish(who: string, fishId: string, n = 1): ActionResult {
  const fish = rareFishById(fishId)
  if (!fish) return { ok: false, msg: '只有稀有鱼可以直接出售' }
  const price = RARE_FISH_SELL[fishId] ?? 150
  const mine = farmOf(farms, who)
  const owned = mine.warehouse[fishId] ?? 0
  if (owned < n) return { ok: false, msg: `${fish.name} 不够（有 ${owned} 只）` }
  const ok = commit(who, (f) => {
    f.warehouse[fishId] -= n
    if (f.warehouse[fishId] <= 0) delete f.warehouse[fishId]
  }, [[price * n, `出售稀有鱼·${fish.name}×${n}`]])
  return ok
    ? { ok: true, msg: `💰 卖出 ${fish.emoji}${fish.name}×${n}，+${price * n} 时元` }
    : { ok: false, msg: '同步中，请稍后再试' }
}

/**
 * 一键种植：把选中的作物种满当前所有空地。
 *
 * 两种作物走两条完全不同的结算路径：
 *  - 普通作物：按时元购买种子（单价 ×2），扣 balance；
 *  - 特殊种子（融合作物，fusionOnly）：不花时元，消耗仓库里的 `seed_<cropId>`，
 *    一块地只能种一株，因此批量数量 = min(空地数, 持有种子数)，种子不够时只种得下的那几株
 *    （不报错、不空转，剩余空地留给下一次操作）。成熟时间 / 虫害 / 爱情树经验与单块种植一致。
 */
export function plantAll(who: string, cropId: string, balance: number): ActionResult {
  const crop = cropById(cropId)
  if (!crop) return { ok: false, msg: '未知作物' }
  const mine = farmOf(farms, who)
  const empties = mine.plots.filter((p) => !p.cropId)
  if (empties.length === 0) return { ok: false, msg: '没有空地了' }
  const now = Date.now()
  const hours = cropHours(crop)
  const matureAt = now + hours * 3600_000

  // ── 特殊种子（融合作物）：消耗仓库种子，不走时元 ──
  if (crop.fusionOnly) {
    const sid = seedId(cropId)
    const owned = mine.warehouse[sid] ?? 0
    if (owned < 1) return { ok: false, msg: `没有 ${crop.name} 的种子` }
    const n = Math.min(empties.length, owned)
    const ok = commit(who, (f) => {
      let left = n
      for (const p of f.plots) {
        if (left <= 0) break
        if (p.cropId) continue
        const have = f.warehouse[sid] ?? 0
        if (have <= 0) break // 理论上不会发生（n 已按持有量收口），防御性兜底
        f.warehouse[sid] = have - 1
        if (f.warehouse[sid] <= 0) delete f.warehouse[sid]
        Object.assign(p, { cropId, plantedAt: now, matureAt, stolen: false, pest: rollPest() })
        left--
      }
    }, [])
    if (ok) addTreeXp(who) // 一键种植：爱情树 +2（与普通作物一致）
    if (!ok) return { ok: false, msg: '同步中，请稍后再试' }
    const short = n < empties.length ? `，种子只够种 ${n} 块空地` : ''
    return { ok: true, msg: `${crop.emoji} 一键种下 ${n} 株${crop.name}（🌱 种子 -${n}）${short}` }
  }

  // ── 普通作物：时元购买 ──
  const total = crop.cost * empties.length * SEED_PRICE_MULT
  if (balance < total) return { ok: false, msg: `种满需要 ${total} 时元，余额不足` }
  const ok = commit(who, (f) => {
    for (const p of f.plots) {
      if (p.cropId) continue
      Object.assign(p, { cropId, plantedAt: now, matureAt, stolen: false, pest: rollPest() })
    }
  }, [[-total, `一键种满${crop.name}×${empties.length}`]])
  if (ok) addTreeXp(who) // 一键种植：爱情树 +2
  return ok
    ? { ok: true, msg: `${crop.emoji} 一键种满 ${empties.length} 块地（-${total} 时元）` }
    : { ok: false, msg: '同步中，请稍后再试' }
}

export function harvestAll(who: string): { ok: boolean; msg: string; gains: HarvestGain[] } {
  const mine = farmOf(farms, who)
  const now = Date.now()
  const maturePlots = mine.plots.filter((p) => p.cropId && p.matureAt <= now)
  const matureFish = mine.pond.filter((s) => s.fishId && s.matureAt <= now)
  if (maturePlots.length === 0 && matureFish.length === 0)
    return { ok: false, msg: '还没有可收获的', gains: [] }
  const gains: HarvestGain[] = []
  let fishCoins = 0
  let fishCount = 0
  let txList: [number, string][] = []
  const wx = weatherToday()
  const fishMult = wx.id === 'rainbow' ? 2 : 1
  const ok = commit(who, (f) => {
    txList = []
    for (const p of f.plots) {
      if (p.cropId && p.matureAt <= now) txList.push(...harvestOne(f, p, gains))
    }
    for (const s of f.pond) {
      if (s.fishId && s.matureAt <= now) {
        const fish = anyFishById(s.fishId)!
        const qtyCrit = rollCrit(fishMult)
        const coinCrit = rollCrit(fishMult)
        const qty = qtyCrit + (wx.id === 'snow' ? 1 : 0)
        const coins =
          Math.floor(fish.cost * (1 + Math.random() * 0.5) * (wx.id === 'sunny' ? 1.2 : 1)) *
          coinCrit
        f.warehouse[fish.id] = (f.warehouse[fish.id] ?? 0) + qty
        gains.push({ emoji: fish.emoji, name: fish.name, qty, qtyCrit, coins, coinCrit })
        fishCoins += coins
        fishCount += qty
        Object.assign(s, { fishId: null, startedAt: 0, matureAt: 0 })
      }
    }
  }, [])
  if (!ok) return { ok: false, msg: '同步中，请稍后再试', gains: [] }
  for (const [delta, reason] of txList) addTx(who, delta, reason)
  if (fishCoins > 0) addTx(who, fishCoins, `一键收鱼×${fishCount}`)
  const totalCoins = gains.reduce((s, g) => s + g.coins, 0)
  const best = Math.max(...gains.map((g) => Math.max(g.qtyCrit, g.coinCrit)))
  const critText = best > 1 ? ` 🎉最高暴击 x${best}！` : ''
  return { ok: true, msg: `⛏️ 一键收获 ${gains.length} 份 +${totalCoins}时元${critText}`, gains }
}

// ===================== 每日打卡（樱花树） =====================
/**
 * 每日打卡：主页面樱花树上挂一个礼物入口，每人每天可领一次，奖励**固定不变**：
 *   · 5 块帝王料（t4 未切原石）
 *   · 3 只龙涎提纯剂（supreme）
 *   · 每种特殊种子（融合作物种子 seed_{cropId}）各 1 个
 * 打卡日期写在农场对象的 checkinDay 上（按人整对象替换 + 逐人版本号守卫，天然收敛），
 * 跨天自动可再领；重复调用同一天直接拒绝，杜绝刷奖。
 */
export const CHECKIN_TIER = 't4'          // 帝王料
export const CHECKIN_STONE_COUNT = 5      // 5 块
export const CHECKIN_REAGENT = 'supreme'  // 龙涎提纯剂
export const CHECKIN_REAGENT_COUNT = 3    // 3 只

/** 某人今天是否已在樱花树打过卡 */
export function hasCheckedIn(farmsMap: Record<string, FarmOf>, who: string): boolean {
  return farmOf(farmsMap, who).checkinDay === todayKey()
}

export type CheckinResult = {
  ok: boolean
  msg: string
  /** 打卡发放的种子清单（供 UI 展示「特殊种子各一个」到底给了啥） */
  seeds?: Array<{ id: string; name: string; emoji: string }>
}

/**
 * 打卡领奖：先写 checkinDay（幂等），再依次发帝王料 / 龙涎提纯剂 / 特殊种子。
 * 玉石与提纯剂各有自己的同步通道（jade.ts），种子进农场仓库（farm.ts）。
 */
export function doCheckin(who: string): CheckinResult {
  const mine = farmOf(farms, who)
  if (mine.checkinDay === todayKey()) return { ok: false, msg: '今天已经打过卡啦，明天再来 🌸' }
  const seedCrops = CROPS.filter((c) => c.fusionOnly)
  const seeds = seedCrops.map((c) => ({ id: seedId(c.id), name: `${c.name}种子`, emoji: c.emoji }))
  // 先把打卡日期写进农场（唯一写点，失败即整体放弃）
  const ok = commit(who, (f) => {
    f.checkinDay = todayKey()
    for (const s of seeds) f.warehouse[s.id] = (f.warehouse[s.id] ?? 0) + 1
  }, [])
  if (!ok) return { ok: false, msg: '同步中，请稍后再试' }
  // 帝王料直接进玉石鉴定（seedStones 是 jade 侧 API，不扣时元）
  seedStones(who, CHECKIN_TIER, CHECKIN_STONE_COUNT)
  // 龙涎提纯剂进提纯剂库存
  grantReagent(who, CHECKIN_REAGENT, CHECKIN_REAGENT_COUNT)
  addTreeXp(who) // 打卡也顺手给爱情树 +2
  return {
    ok: true,
    msg: `🌸 打卡成功！帝王料 ×${CHECKIN_STONE_COUNT} · 龙涎提纯剂 ×${CHECKIN_REAGENT_COUNT} · 特殊种子各 1`,
    seeds,
  }
}

// ===================== 合成工坊（配方书） =====================
/** 配方：mats 为 [物品id, 数量]，产物即配方 id 本身（进仓库，可作高阶材料） */
export type Recipe = {
  id: string
  name: string
  emoji: string
  reward: number
  tier: 1 | 2 | 3
  mats: Array<[string, number]>
}

const BASE_RECIPES: Recipe[] = [
  // 🌱 一阶合成 · 作物鲜鱼的初遇
  { id: 'r1', name: '花束', emoji: '💐', reward: 26, tier: 1, mats: [['rose', 1], ['tulip', 1], ['lily', 1]] },
  { id: 'r2', name: '花环', emoji: '🌸', reward: 24, tier: 1, mats: [['daisy', 3], ['babysbreath', 2]] },
  { id: 'r3', name: '干花香囊', emoji: '🪻', reward: 26, tier: 1, mats: [['lavender', 2], ['jasmine', 1]] },
  { id: 'r4', name: '百花蜜', emoji: '🍯', reward: 38, tier: 1, mats: [['sakura', 1], ['peony', 1], ['hibiscus', 1]] },
  { id: 'r5', name: '鲜花饼', emoji: '🥮', reward: 36, tier: 1, mats: [['rose', 2], ['tea', 1]] },
  { id: 'r6', name: '水果捞', emoji: '🍨', reward: 30, tier: 1, mats: [['watermelon', 1], ['strawberry', 1], ['grape', 1]] },
  { id: 'r7', name: '蔬菜沙拉', emoji: '🥗', reward: 13, tier: 1, mats: [['lettuce', 1], ['tomato', 1], ['cucumber', 1]] },
  { id: 'r8', name: '南瓜派', emoji: '🥧', reward: 23, tier: 1, mats: [['pumpkin', 2], ['corn', 1]] },
  { id: 'r9', name: '莓果果酱', emoji: '🫙', reward: 34, tier: 1, mats: [['blueberry', 2], ['cherry', 1]] },
  { id: 'r10', name: '农家炖菜', emoji: '🍲', reward: 18, tier: 1, mats: [['potato', 1], ['carrot', 1], ['onion', 1], ['pepper', 1]] },
  { id: 'r11', name: '提神花茶', emoji: '🍵', reward: 29, tier: 1, mats: [['tea', 1], ['mint', 1], ['lemon', 1]] },
  { id: 'r12', name: '鲜鱼汤', emoji: '🥣', reward: 15, tier: 1, mats: [['bitterling', 1], ['mandarinfish', 1]] },
  { id: 'r13', name: '月光烤鱼', emoji: '🎏', reward: 16, tier: 1, mats: [['moonfish', 1], ['guppy', 1]] },
  { id: 'r14', name: '刺身盛合', emoji: '🍣', reward: 70, tier: 1, mats: [['tuna', 1], ['grouper', 1]] },
  { id: 'r15', name: '海鲜拼盘', emoji: '🦞', reward: 70, tier: 1, mats: [['puffer', 1], ['grouper', 1], ['bluetang', 1]] },
  { id: 'r16', name: '龙宫锦鲤宴', emoji: '🐉', reward: 46, tier: 1, mats: [['dragonfish', 1], ['koi', 1], ['luohan', 1]] },
  { id: 'r17', name: '海洋之心', emoji: '💙', reward: 145, tier: 1, mats: [['whale', 1], ['butterflyfish', 1]] },
  { id: 'r18', name: '浪漫晚餐', emoji: '🕯️', reward: 28, tier: 1, mats: [['rose', 1], ['strawberry', 1], ['clownfish', 1]] },
  { id: 'r19', name: '田园大餐', emoji: '🧺', reward: 32, tier: 1, mats: [['pumpkin', 1], ['corn', 1], ['mandarinfish', 1], ['daisy', 1]] },
  { id: 'r20', name: '大白鲨', emoji: '🦈', reward: 280, tier: 1, mats: [['shark', 1], ['whale', 1], ['ray', 1], ['lionfish', 1]] },
  { id: 'r21', name: '早安花篮', emoji: '🌼', reward: 20, tier: 1, mats: [['daisy', 2], ['carnation', 1]] },
  { id: 'r22', name: '香草茶包', emoji: '🫖', reward: 15, tier: 1, mats: [['mint', 2], ['rosemary', 1]] },
  { id: 'r23', name: '烤玉米串', emoji: '🌽', reward: 17, tier: 1, mats: [['corn', 2], ['pepper', 1]] },
  { id: 'r24', name: '田园蔬菜浓汤', emoji: '🍲', reward: 15, tier: 1, mats: [['tomato', 1], ['potato', 1], ['onion', 1]] },
  { id: 'r25', name: '莓果挞', emoji: '🧁', reward: 21, tier: 1, mats: [['blueberry', 1], ['strawberry', 2]] },
  { id: 'r26', name: '蜜桃乌龙', emoji: '🍑', reward: 24, tier: 1, mats: [['peach', 1], ['tea', 1]] },
  { id: 'r27', name: '柠檬薄荷冰饮', emoji: '🍹', reward: 14, tier: 1, mats: [['lemon', 2], ['mint', 1]] },
  { id: 'r28', name: '四叶幸运符', emoji: '🍀', reward: 32, tier: 1, mats: [['clover', 1], ['babysbreath', 2]] },
  { id: 'r29', name: '樱花茶点', emoji: '🍡', reward: 26, tier: 1, mats: [['sakura', 1], ['tea', 1]] },
  { id: 'r30', name: '海鲜粥', emoji: '🍚', reward: 32, tier: 1, mats: [['grouper', 1], ['bitterling', 1]] },
  { id: 'r31', name: '炽热爱意·88朵玫瑰花束', emoji: '💐', reward: 1314, tier: 1, mats: [['rose', 88]] },
  { id: 'r32', name: '至死不渝·188玫瑰花海', emoji: '🌹', reward: 3344, tier: 1, mats: [['rose', 188]] },
  { id: 'r33', name: '阳光能量饮', emoji: '🌻', reward: 18, tier: 1, mats: [['sunflower', 2], ['lemon', 1]] },
  { id: 'r34', name: '芬芳花园礼篮', emoji: '🪷', reward: 24, tier: 1, mats: [['gardenia', 1], ['hyacinth', 1], ['violet', 1]] },
  { id: 'r35', name: '春日花笺', emoji: '💌', reward: 15, tier: 1, mats: [['pansy', 2], ['bellflower', 1]] },
  { id: 'r36', name: '美人花酌', emoji: '🍷', reward: 22, tier: 1, mats: [['poppy', 1], ['begonia', 1]] },
  { id: 'r37', name: '彼岸灯影', emoji: '🏮', reward: 24, tier: 1, mats: [['lycoris', 1], ['hibiscus', 1]] },
  { id: 'r38', name: '苹果玫瑰卷', emoji: '🍎', reward: 24, tier: 1, mats: [['apple', 2], ['rose', 1]] },
  { id: 'r39', name: '罗勒蘑菇意面', emoji: '🍝', reward: 15, tier: 1, mats: [['basil', 1], ['mushroom', 1], ['tomato', 1]] },
  { id: 'r40', name: '暖冬烤红薯', emoji: '🍠', reward: 9, tier: 1, mats: [['sweetpotato', 2]] },
  { id: 'r41', name: '地三鲜', emoji: '🍆', reward: 16, tier: 1, mats: [['eggplant', 1], ['potato', 1], ['pepper', 1]] },
  { id: 'r42', name: '翡翠时蔬卷', emoji: '🥬', reward: 14, tier: 1, mats: [['spinach', 1], ['pea', 1], ['carrot', 1]] },
  { id: 'r43', name: '萌肉小盆栽', emoji: '🪴', reward: 22, tier: 1, mats: [['succulent', 2], ['mimosa', 1]] },
  { id: 'r44', name: '竹韵清风礼', emoji: '🎋', reward: 32, tier: 1, mats: [['bamboo', 1], ['tea', 1]] },
  { id: 'r45', name: '金斗鱼圆舞曲', emoji: '🎶', reward: 14, tier: 1, mats: [['goldfish', 1], ['betta', 1]] },
  { id: 'r46', name: '食人鱼狂想曲', emoji: '🎼', reward: 52, tier: 1, mats: [['piranha', 1], ['puffer', 1]] },
  // 🌱 补充配方 · 让每一样作物水产都能参与
  { id: 'r47', name: '糖炒栗子', emoji: '🌰', reward: 18, tier: 1, mats: [['chestnut', 2], ['sugarcane', 1]] },
  { id: 'r48', name: '花生糖', emoji: '🥜', reward: 16, tier: 1, mats: [['peanut', 2], ['sugarcane', 1]] },
  { id: 'r49', name: '可可摩卡', emoji: '☕', reward: 32, tier: 1, mats: [['cocoa', 1], ['coffee', 1]] },
  { id: 'r50', name: '麻辣小龙虾', emoji: '🦞', reward: 26, tier: 1, mats: [['crayfish', 2], ['pepper', 1]] },
  { id: 'r51', name: '柠檬清蒸蟹', emoji: '🦀', reward: 30, tier: 1, mats: [['crab', 1], ['lemon', 1]] },
  { id: 'r52', name: '仙草龟苓膏', emoji: '🍮', reward: 28, tier: 1, mats: [['turtle', 1], ['sugarcane', 1]] },
  { id: 'r53', name: '珍珠奶茶', emoji: '🧋', reward: 36, tier: 1, mats: [['oyster', 1], ['tea', 1], ['sugarcane', 1]] },
  { id: 'r54', name: '香米饭团', emoji: '🍙', reward: 14, tier: 1, mats: [['rice', 2], ['cucumber', 1]] },
  // ✨ 二阶合成 · 合成物的华丽蜕变
  { id: 'r55', name: '心动花漾礼盒', emoji: '💕', reward: 66, tier: 2, mats: [['r1', 1], ['r2', 1]] },
  { id: 'r56', name: '鎏金花韵甜匣', emoji: '🎁', reward: 102, tier: 2, mats: [['r5', 1], ['r4', 1]] },
  { id: 'r57', name: '翡翠田园轻食宴', emoji: '🥗', reward: 58, tier: 2, mats: [['r6', 1], ['r7', 1]] },
  { id: 'r58', name: '星河渔火船宴', emoji: '🎆', reward: 44, tier: 2, mats: [['r12', 1], ['r13', 1]] },
  { id: 'r59', name: '碧波龙宫御膳', emoji: '🍱', reward: 196, tier: 2, mats: [['r14', 1], ['r15', 1]] },
  { id: 'r60', name: '星野烛光誓约宴', emoji: '🕯️', reward: 82, tier: 2, mats: [['r18', 1], ['r19', 1]] },
  { id: 'r61', name: '浮香入梦香礼', emoji: '🌺', reward: 74, tier: 2, mats: [['r3', 1], ['r11', 1]] },
  { id: 'r62', name: '金秋丰收盛宴', emoji: '🎃', reward: 56, tier: 2, mats: [['r8', 1], ['r10', 1]] },
  { id: 'r63', name: '深渊之心·沧海誓约', emoji: '💎', reward: 620, tier: 2, mats: [['r20', 1], ['r17', 1]] },
  { id: 'r64', name: '晨露花语秘匣', emoji: '🌅', reward: 75, tier: 2, mats: [['r21', 1], ['r9', 1]] },
  { id: 'r65', name: '锦鲤跃龙门贺礼', emoji: '🎏', reward: 108, tier: 2, mats: [['r16', 1], ['r28', 1]] },
  { id: 'r66', name: '风雅茶事礼盒', emoji: '🫖', reward: 58, tier: 2, mats: [['r22', 1], ['r29', 1]] },
  { id: 'r67', name: '烟火田园便当', emoji: '🍱', reward: 46, tier: 2, mats: [['r23', 1], ['r24', 1]] },
  { id: 'r68', name: '甜心午后茶宴', emoji: '🧁', reward: 64, tier: 2, mats: [['r25', 1], ['r26', 1]] },
  { id: 'r69', name: '清凉海陆双拼', emoji: '🍨', reward: 66, tier: 2, mats: [['r27', 1], ['r30', 1]] },
  { id: 'r70', name: '挚爱永恒玫瑰圣殿', emoji: '👑', reward: 6666, tier: 2, mats: [['r31', 1], ['r32', 1]] },
  { id: 'r71', name: '曦光花园宝匣', emoji: '🌄', reward: 60, tier: 2, mats: [['r33', 1], ['r34', 1]] },
  { id: 'r72', name: '春日心动信笺', emoji: '💘', reward: 52, tier: 2, mats: [['r35', 1], ['r36', 1]] },
  { id: 'r73', name: '幽灯苹果夜宴', emoji: '🌃', reward: 68, tier: 2, mats: [['r37', 1], ['r38', 1]] },
  { id: 'r74', name: '意式乡野风味集', emoji: '🥫', reward: 44, tier: 2, mats: [['r39', 1], ['r41', 1]] },
  { id: 'r75', name: '暖冬田园甜匣', emoji: '🔥', reward: 34, tier: 2, mats: [['r40', 1], ['r42', 1]] },
  { id: 'r76', name: '森系治愈小筑', emoji: '🌿', reward: 48, tier: 2, mats: [['r43', 1], ['r44', 1]] },
  { id: 'r77', name: '深海狂想礼盒', emoji: '🌊', reward: 52, tier: 2, mats: [['r45', 1], ['r46', 1]] },
  // 👑 三阶合成 · 传说的顶点
  { id: 'r78', name: '繁花圣殿·三生三世', emoji: '💒', reward: 8000, tier: 3, mats: [['r55', 1], ['r70', 1]] },
  { id: 'r79', name: '鎏金岁月臻藏', emoji: '⏳', reward: 240, tier: 3, mats: [['r56', 1], ['r64', 1]] },
  { id: 'r80', name: '茶禅一味·风雅颂', emoji: '🍶', reward: 145, tier: 3, mats: [['r66', 1], ['r76', 1]] },
  { id: 'r81', name: '田园狂想丰收祭', emoji: '🎪', reward: 188, tier: 3, mats: [['r57', 1], ['r67', 1], ['r75', 1]] },
  { id: 'r82', name: '甜梦环游蜜恋纪', emoji: '🍭', reward: 168, tier: 3, mats: [['r68', 1], ['r71', 1]] },
  { id: 'r83', name: '冰火之歌海陆宴', emoji: '⚡', reward: 208, tier: 3, mats: [['r69', 1], ['r58', 1], ['r74', 1]] },
  { id: 'r84', name: '深海龙宫·君临天下', emoji: '🐲', reward: 334, tier: 3, mats: [['r59', 1], ['r77', 1]] },
  { id: 'r85', name: '幽夜灯会·彼岸之约', emoji: '🎇', reward: 162, tier: 3, mats: [['r73', 1], ['r72', 1]] },
  { id: 'r86', name: '金秋风物诗', emoji: '🍂', reward: 222, tier: 3, mats: [['r62', 1], ['r65', 1]] },
  { id: 'r87', name: '宇宙级浪漫·星河长明', emoji: '🌌', reward: 1048, tier: 3, mats: [['r60', 1], ['r63', 1], ['r61', 1]] },
]

/** 仙品在合成奖励补算中的估值：按作物成本 ×3（仙品价格 = 非仙品 3 倍） */
const rareValue = (rid: string): number => (cropById(rid.slice(2))?.cost ?? 10) * 3

/** 三阶配方的仙品门槛：最高阶合成物必须用进阶作物才能合 */
const TIER3_RARE: Record<string, Array<[string, number]>> = {
  r78: [['x_rose', 3]],
  r79: [['x_peony', 2]],
  r80: [['x_tea', 2]],
  r81: [['x_pumpkin', 2], ['x_sweetpotato', 2]],
  r82: [['x_strawberry', 2]],
  r83: [['x_lemon', 2]],
  r84: [['x_clover', 1]],
  r85: [['x_lycoris', 2]],
  r86: [['x_chestnut', 2]],
  r87: [['x_rose', 5], ['x_sakura', 3]],
}

/** 大宗单品配方：热门作物都有自己的"花海"之路（不再只有玫瑰有 88/188） */
const BULK_RECIPES: Recipe[] = [
  { id: 'r88', name: '莓好时光·88草莓', emoji: '🍓', reward: 1314, tier: 1, mats: [['strawberry', 88]] },
  { id: 'r89', name: '樱落成诗·88樱花', emoji: '🌸', reward: 1588, tier: 1, mats: [['sakura', 88]] },
  { id: 'r90', name: '郁见你·88郁金香', emoji: '🌷', reward: 1314, tier: 1, mats: [['tulip', 88]] },
  { id: 'r91', name: '百合誓约·66百合', emoji: '💐', reward: 1099, tier: 1, mats: [['lily', 66]] },
  { id: 'r92', name: '追光约定·66向日葵', emoji: '🌻', reward: 999, tier: 1, mats: [['sunflower', 66]] },
  { id: 'r93', name: '幸运满仓·20四叶草', emoji: '🍀', reward: 1888, tier: 1, mats: [['clover', 20]] },
  { id: 'r94', name: '丰收礼赞·88水稻', emoji: '🌾', reward: 1314, tier: 1, mats: [['rice', 88]] },
  { id: 'r95', name: '茶香四季·66茶树', emoji: '🍵', reward: 1666, tier: 1, mats: [['tea', 66]] },
  { id: 'r96', name: '萄醉星河·88葡萄', emoji: '🍇', reward: 1666, tier: 1, mats: [['grape', 88]] },
  { id: 'r97', name: '咖啡物语·66咖啡豆', emoji: '☕', reward: 1520, tier: 1, mats: [['coffee', 66]] },
  // 🐟 鱼类大宗合成 · 江河湖海的馈赠
  { id: 'r98', name: '千鳞福袋', emoji: '🧧', reward: 520, tier: 1, mats: [['bitterling', 20], ['guppy', 20]] },
  { id: 'r99', name: '蟹虾满堂', emoji: '🦐', reward: 900, tier: 1, mats: [['crab', 15], ['crayfish', 15]] },
  { id: 'r100', name: '鱼龙百变', emoji: '🎏', reward: 1200, tier: 1, mats: [['koi', 12], ['dragonfish', 8], ['luohan', 8]] },
  { id: 'r101', name: '深海鱼王煲', emoji: '🍲', reward: 1500, tier: 1, mats: [['tuna', 10], ['grouper', 10], ['shark', 2]] },
  { id: 'r102', name: '鳞光宝匣', emoji: '🎁', reward: 1600, tier: 1, mats: [['puffer', 10], ['bluetang', 10], ['lionfish', 8], ['piranha', 6]] },
  { id: 'r103', name: '鲸歌海螺', emoji: '🐚', reward: 2000, tier: 1, mats: [['whale', 3], ['ray', 6], ['butterflyfish', 10]] },
  { id: 'r104', name: '万鳞朝凤·188鳑鲏', emoji: '🦚', reward: 2888, tier: 1, mats: [['bitterling', 188]] },
  { id: 'r105', name: '月满西楼·99月光鱼', emoji: '🌙', reward: 1666, tier: 1, mats: [['moonfish', 99]] },
  { id: 'r106', name: '鲸落星海·188鲸鱼', emoji: '🐳', reward: 6888, tier: 1, mats: [['whale', 188]] },
  { id: 'r107', name: '鲨海狂澜·388鲨鱼', emoji: '🦈', reward: 8888, tier: 1, mats: [['shark', 388]] },
  // 🐲 稀有鱼合成线 · 传说之海的秘宝（稀有鱼只能靠钓鱼获得）
  { id: 'r108', name: '龙门盛宴', emoji: '🐲', reward: 2888, tier: 3, mats: [['rf_golddragon', 1], ['koi', 20], ['dragonfish', 10]] },
  { id: 'r109', name: '鲟龙鱼子酱', emoji: '🍱', reward: 2666, tier: 3, mats: [['rf_sturgeon', 1], ['tuna', 10], ['rice', 66]] },
  { id: 'r110', name: '七彩琉璃缸', emoji: '🌈', reward: 2288, tier: 3, mats: [['rf_angelfish', 1], ['butterflyfish', 15], ['bluetang', 15]] },
  { id: 'r111', name: '荧光梦幻瓶', emoji: '🫙', reward: 2288, tier: 3, mats: [['rf_jelly', 1], ['moonfish', 20], ['clover', 20]] },
  { id: 'r112', name: '深海霸王宴', emoji: '🦑', reward: 2888, tier: 3, mats: [['rf_squid', 1], ['shark', 5], ['tuna', 10]] },
]

/**
 * 配方平衡：一阶材料 ×5 / 奖励 ×4（88、188 大配方除外），
 * 二阶材料 ×2 / 奖励 ×3，三阶追加仙品门槛并按估值补奖励。
 */
function balanceRecipe(r: Recipe): Recipe {
  if (r.tier === 1 && r.id !== 'r31' && r.id !== 'r32') {
    return { ...r, mats: r.mats.map(([id, n]) => [id, n * 5] as [string, number]), reward: r.reward * 4 }
  }
  if (r.tier === 2) {
    return { ...r, mats: r.mats.map(([id, n]) => [id, n * 2] as [string, number]), reward: r.reward * 3 }
  }
  if (r.tier === 3) {
    const rares = TIER3_RARE[r.id] ?? []
    const extra = rares.reduce((s, [id, n]) => s + rareValue(id) * n, 0)
    return { ...r, mats: [...r.mats, ...rares], reward: r.reward + extra }
  }
  return r
}

/** 仙品二阶合成线：覆盖全部 56 种仙品作物，奖励按仙品估值 ×1.35 自动计算 */
const mkRareRecipe = (id: string, name: string, emoji: string, mats: Array<[string, number]>): Recipe => ({
  id,
  name,
  emoji,
  tier: 2,
  mats,
  reward: Math.round(mats.reduce((s, [rid, n]) => s + rareValue(rid) * n, 0) * 1.35),
})
const RARE_RECIPES: Recipe[] = [
  // 仙品花卉（20 种全覆盖）
  mkRareRecipe('sr1', '仙品百花束', '💐', [['x_rose', 1], ['x_tulip', 1], ['x_lily', 1], ['x_daisy', 1]]),
  mkRareRecipe('sr2', '仙品朝阳园', '🌻', [['x_sunflower', 1], ['x_sakura', 1], ['x_peony', 1], ['x_begonia', 1]]),
  mkRareRecipe('sr3', '仙品香氛阁', '🪻', [['x_lavender', 1], ['x_jasmine', 1], ['x_gardenia', 1], ['x_hyacinth', 1]]),
  mkRareRecipe('sr4', '仙品紫韵匣', '🟪', [['x_violet', 1], ['x_pansy', 1], ['x_bellflower', 1], ['x_hibiscus', 1]]),
  mkRareRecipe('sr5', '仙品芳华录', '🏮', [['x_carnation', 1], ['x_babysbreath', 1], ['x_poppy', 1], ['x_lycoris', 1]]),
  // 仙品果蔬（28 种全覆盖）
  mkRareRecipe('sr6', '仙品莓果宴', '🍓', [['x_strawberry', 1], ['x_blueberry', 1], ['x_cherry', 1], ['x_grape', 1]]),
  mkRareRecipe('sr7', '仙品瓜果铺', '🍉', [['x_watermelon', 1], ['x_peach', 1], ['x_apple', 1], ['x_lemon', 1]]),
  mkRareRecipe('sr8', '仙品田园筐', '🎃', [['x_tomato', 1], ['x_carrot', 1], ['x_pumpkin', 1], ['x_corn', 1]]),
  mkRareRecipe('sr9', '仙品根茎集', '🥔', [['x_potato', 1], ['x_sweetpotato', 1], ['x_pepper', 1], ['x_eggplant', 1]]),
  mkRareRecipe('sr10', '仙品青蔬篮', '🥬', [['x_cucumber', 1], ['x_lettuce', 1], ['x_spinach', 1], ['x_onion', 1], ['x_pea', 1]]),
  mkRareRecipe('sr11', '仙品茗香室', '🍵', [['x_tea', 1], ['x_mint', 1], ['x_rosemary', 1], ['x_basil', 1]]),
  mkRareRecipe('sr12', '仙品珍奇斋', '🍄', [['x_mushroom', 1], ['x_clover', 1], ['x_succulent', 1], ['x_mimosa', 1]]),
  // 仙品新增作物（8 种全覆盖）
  mkRareRecipe('sr13', '仙品谷香坊', '🌾', [['x_peanut', 1], ['x_chestnut', 1], ['x_rice', 1], ['x_sugarcane', 1]]),
  mkRareRecipe('sr14', '仙品醇饮铺', '☕', [['x_cocoa', 1], ['x_coffee', 1], ['x_bamboo', 1]]),
]

/**
 * 🌟 仙品秘宝线：每件合成物固定需要 5 株仙品作物（主材 ×2 + 辅材 ×3），
 * 是仙品作物的专属消耗路径；奖励由 rewardOf 按仙品估值（成本 ×3）自动计算。
 */
const RARE_TREASURE_RECIPES: Recipe[] = [
  { id: 'xr1', name: '仙品·百花蜜酿', emoji: '🍯', tier: 2, reward: 0, mats: [['x_rose', 2], ['x_lavender', 1], ['x_jasmine', 1], ['x_sakura', 1]] },
  { id: 'xr2', name: '仙品·锦绣良缘匣', emoji: '💝', tier: 2, reward: 0, mats: [['x_tulip', 2], ['x_peony', 1], ['x_begonia', 1], ['x_carnation', 1]] },
  { id: 'xr3', name: '仙品·暖阳丰收囤', emoji: '🌅', tier: 2, reward: 0, mats: [['x_sunflower', 2], ['x_pumpkin', 1], ['x_corn', 1], ['x_tomato', 1]] },
  { id: 'xr4', name: '仙品·百果圣盏', emoji: '🍧', tier: 2, reward: 0, mats: [['x_strawberry', 2], ['x_grape', 1], ['x_peach', 1], ['x_cherry', 1]] },
  { id: 'xr5', name: '仙品·冰雪玲珑盏', emoji: '🧊', tier: 2, reward: 0, mats: [['x_lily', 2], ['x_watermelon', 1], ['x_lemon', 1], ['x_apple', 1]] },
  { id: 'xr6', name: '仙品·金玉满堂宴', emoji: '🏵️', tier: 2, reward: 0, mats: [['x_rice', 2], ['x_tea', 1], ['x_cocoa', 1], ['x_coffee', 1]] },
  { id: 'xr7', name: '仙品·长青仙露', emoji: '🎍', tier: 2, reward: 0, mats: [['x_bamboo', 2], ['x_mint', 1], ['x_succulent', 1], ['x_clover', 1]] },
  { id: 'xr8', name: '仙品·百草仙丹', emoji: '🫚', tier: 2, reward: 0, mats: [['x_mushroom', 1], ['x_potato', 1], ['x_carrot', 1], ['x_onion', 1], ['x_spinach', 1]] },
]

/**
 * 🧪 提纯剂合成线（2026-10-10）：提纯剂不再用时元购买，改由农场自己合。
 * 产物 id 与 lib/jade.ts 的 PurifierId 一一对应（basic / fine / supreme），
 * 合成成功后调 grantReagent() 直接进提纯剂库存（不进仓库，避免被当成材料二次消耗）。
 *
 * 难度梯度（用户选「硬核」）：
 *  · 草木提纯剂 basic  —— 常见作物为主，可量产，新手就能开线
 *  · 寒泉提纯剂 fine   —— 必须有几味**仙品作物**（x_ 前缀），要种很多轮才凑得出
 *  · 龙涎提纯剂 supreme —— 硬核天花板：**特殊种子作物**（融合作物）+ 它们的仙品
 *  一炉出 1 只，一块玉最多吃 10 只到顶，所以拉满一块玉的代价是实打实的长期目标。
 */
const PURIFIER_RECIPES: Recipe[] = [
  // 🌿 草木提纯剂：只要灵田常见作物（每组都是能日常种出来的量）
  { id: 'pz_basic', name: '草木提纯剂', emoji: '🌿', reward: 60, tier: 1,
    mats: [['daisy', 20], ['mint', 20], ['clover', 10], ['babysbreath', 15]] },
  // 💧 寒泉提纯剂：必须下几味仙品作物，量产门槛陡升
  { id: 'pz_fine', name: '寒泉提纯剂', emoji: '💧', reward: 260, tier: 2,
    mats: [['x_mint', 2], ['x_lettuce', 2], ['x_tea', 2], ['mushroom', 30], ['succulent', 20]] },
  // 🔥 龙涎提纯剂：特殊种子作物 + 它们的仙品，一炉难求
  { id: 'pz_supreme', name: '龙涎提纯剂', emoji: '🔥', reward: 900, tier: 3,
    mats: [['moonberry', 1], ['crystal_grape', 1], ['x_moonberry', 1], ['x_crystal_grape', 1], ['x_sun_peach', 1]] },
]

/** 配方 id → 提纯剂 id（合成时用来识别该发哪只剂） */
const PURIFIER_OF_RECIPE: Record<string, string> = {
  pz_basic: 'basic',
  pz_fine: 'fine',
  pz_supreme: 'supreme',
}

/** 融合作物专属合成线：新作物只能靠大融合获得，因此它们的合成物也足够稀有 */
const FUSION_RECIPES: Recipe[] = [
  // 一阶 · 融合作物的初加工
  { id: 'r113', name: '星月莓果挞', emoji: '🌙', reward: 0, tier: 1, mats: [['moonberry', 1], ['blueberry', 1]] },
  { id: 'r114', name: '星尘爆米花', emoji: '🌟', reward: 0, tier: 1, mats: [['stardust_corn', 1], ['corn', 1]] },
  { id: 'r115', name: '水晶葡萄酿', emoji: '💎', reward: 0, tier: 1, mats: [['crystal_grape', 1], ['grape', 1]] },
  { id: 'r116', name: '极光花茶', emoji: '🌺', reward: 0, tier: 1, mats: [['aurora_lily', 1], ['tea', 1]] },
  { id: 'r117', name: '虚空南瓜汤', emoji: '🖤', reward: 0, tier: 1, mats: [['void_pumpkin', 1], ['potato', 1]] },
  { id: 'r118', name: '太阳蜜桃派', emoji: '☀️', reward: 0, tier: 1, mats: [['sun_peach', 1], ['peach', 1]] },
  { id: 'r119', name: '星云奶茶', emoji: '🌠', reward: 0, tier: 1, mats: [['nebula_tea', 1], ['sugarcane', 1]] },
  { id: 'r120', name: '宇宙胡萝卜汁', emoji: '🪐', reward: 0, tier: 1, mats: [['cosmic_carrot', 1], ['carrot', 1]] },
  { id: 'r121', name: '星际水果拼盘', emoji: '🍽️', reward: 0, tier: 1, mats: [['moonberry', 1], ['crystal_grape', 1], ['sun_peach', 1]] },
  { id: 'r122', name: '银河蔬菜浓汤', emoji: '🥣', reward: 0, tier: 1, mats: [['stardust_corn', 1], ['cosmic_carrot', 1], ['void_pumpkin', 1]] },
  { id: 'r123', name: '极光星尘沙拉', emoji: '🌌', reward: 0, tier: 1, mats: [['aurora_lily', 1], ['stardust_corn', 1], ['lettuce', 1]] },
  { id: 'r124', name: '暗夜莓果冰饮', emoji: '🍹', reward: 0, tier: 1, mats: [['moonberry', 1], ['void_pumpkin', 1], ['lemon', 1]] },
  // 二阶 · 融合物的华丽蜕变
  { id: 'r125', name: '星月交织礼盒', emoji: '🎁', reward: 0, tier: 2, mats: [['r113', 1], ['r118', 1]] },
  { id: 'r126', name: '晶核能量饮', emoji: '⚡', reward: 0, tier: 2, mats: [['r115', 1], ['r120', 1]] },
  { id: 'r127', name: '极光之夜晚宴', emoji: '🌃', reward: 0, tier: 2, mats: [['r116', 1], ['r119', 1]] },
  { id: 'r128', name: '虚空星海盛宴', emoji: '🪐', reward: 0, tier: 2, mats: [['r117', 1], ['r122', 1]] },
  { id: 'r129', name: '星际花漾臻藏', emoji: '✨', reward: 0, tier: 2, mats: [['r121', 1], ['r114', 1]] },
  { id: 'r130', name: '银河第一佳酿', emoji: '🍷', reward: 0, tier: 2, mats: [['moonberry', 1], ['crystal_grape', 1]] },
  { id: 'r131', name: '宇宙能量满汉全席', emoji: '🍱', reward: 0, tier: 2, mats: [['r122', 1], ['r121', 1]] },
  { id: 'r132', name: '星尘茶香礼盒', emoji: '🫖', reward: 0, tier: 2, mats: [['r119', 1], ['r114', 1]] },
]

/**
 * 合成时元奖励重算：奖励 = 0.4 × 原料估值总和（取整，最低 1）。
 * 原料估值：作物/水产 = 种子成本；仙品作物 = 成本 ×3（仙品价格 = 非仙品 3 倍）；稀有鱼 = 售价；合成物 = 其自身配方奖励（递归带记忆）。
 * 融合作物（特殊种子）成本很高，按固定 300 时元折算进合成估值。
 */
export const FUSION_CROP_VALUE = 300
const RAW_RECIPES: Recipe[] = [...BASE_RECIPES.map(balanceRecipe), ...FUSION_RECIPES.map((r) => balanceRecipe({ ...r, mats: r.mats.map(([id, n]) => [id, n * 2] as [string, number]) })), ...BULK_RECIPES, ...RARE_RECIPES, ...RARE_TREASURE_RECIPES, ...PURIFIER_RECIPES]
const rewardMemo = new Map<string, number>()
function matValueOf(id: string): number {
  if (isRareId(id)) return (cropById(id.slice(2))?.cost ?? 10) * 3 // 仙品价格 = 非仙品 3 倍
  if (rareFishById(id)) return RARE_FISH_SELL[id] ?? 150
  const c = cropById(id)
  if (c) return c.fusionOnly ? FUSION_CROP_VALUE : c.cost // 融合作物（特殊种子）按 300 时元折算
  const f = fishById(id)
  if (f) return f.cost
  const r = RAW_RECIPES.find((x) => x.id === id)
  if (r) return rewardOf(r)
  return 10
}
function rewardOf(r: Recipe): number {
  const memo = rewardMemo.get(r.id)
  if (memo !== undefined) return memo
  rewardMemo.set(r.id, 1) // 防循环引用
  const v = Math.max(1, Math.round(0.4 * r.mats.reduce((s, [id, n]) => s + matValueOf(id) * n, 0)))
  rewardMemo.set(r.id, v)
  return v
}
export const RECIPES: Recipe[] = RAW_RECIPES.map((r) => ({ ...r, reward: rewardOf(r) }))

/** 图鉴总条目：作物 + 水产 + 仙品 + 合成 */
export const DEX_TOTAL = CROPS.length * 2 + FISH.length + RECIPES.length

export const recipeById = (id: string): Recipe | undefined => RECIPES.find((r) => r.id === id)

/** 配方材料是否集齐（缺哪个返回哪个） */
export function recipeMissing(warehouse: Record<string, number>, recipe: Recipe): string | null {
  for (const [id, qty] of recipe.mats) {
    if ((warehouse[id] ?? 0) < qty) return id
  }
  return null
}

/** 合成：消耗配方材料，产物 ×1 进仓库 + 时元奖励。
 *  提纯剂配方（pz_*）例外：产物不进仓库，而是直接发到提纯剂库存（grantReagent）。 */
export function synthesize(who: string, recipeId: string): ActionResult {
  const recipe = recipeById(recipeId)
  if (!recipe) return { ok: false, msg: '没有这个配方' }
  const mine = farmOf(farms, who)
  const missing = recipeMissing(mine.warehouse, recipe)
  if (missing) {
    const info = itemInfo(missing)
    const need = recipe.mats.find(([id]) => id === missing)![1]
    return { ok: false, msg: `${info.emoji}${info.name} 不够（${mine.warehouse[missing] ?? 0}/${need}）` }
  }
  const purifierId = PURIFIER_OF_RECIPE[recipeId]
  let dexGain = 0
  const ok = commit(who, (f) => {
    for (const [id, qty] of recipe.mats) {
      f.warehouse[id] -= qty
      if (f.warehouse[id] <= 0) delete f.warehouse[id]
    }
    // 普通产物进仓库；提纯剂改走提纯剂库存（见下），避免提纯剂又被当材料消耗
    if (!purifierId) f.warehouse[recipe.id] = (f.warehouse[recipe.id] ?? 0) + 1
    dexGain = dexUnlock(f, recipe.id)
    // 合成成功后自动取消该配方的追踪
    f.tracking = (f.tracking ?? []).filter((r) => r !== recipeId)
  }, [[recipe.reward, `合成·${recipe.name}`]])
  if (!ok) return { ok: false, msg: '同步中，请稍后再试' }
  // 提纯剂入库：grantReagent 自己走 jade 的 commit，和农场 commit 是两个 topic，顺序无关
  if (purifierId) grantReagent(who, purifierId, 1)
  if (dexGain > 0) addTx(who, dexGain, `图鉴解锁·${recipe.name}`)
  addTreeXp(who) // 合成行为：爱情树 +2
  return {
    ok: true,
    msg: purifierId
      ? `${recipe.emoji} 炼制成功「${recipe.name}」×1！（已入提纯剂库存）`
      : `${recipe.emoji} 合成成功「${recipe.name}」！+${recipe.reward} 时元`,
  }
}

/** 追踪/取消追踪一个配方（追踪后种植/养鱼选择时会有提示） */
export function toggleTrack(who: string, recipeId: string): void {
  commit(who, (f) => {
    const cur = f.tracking ?? []
    f.tracking = cur.includes(recipeId) ? cur.filter((r) => r !== recipeId) : [...cur, recipeId]
  }, [])
}

// ===================== 大融合系统（每日配方） =====================
/** 融合作物（特殊种子，只能靠融合获得，不可时元购买） */
export const FUSION_CROPS: Crop[] = CROPS.filter((c) => c.fusionOnly)
/** 普通作物池（融合未命中配方的保底掉落） */
const NORMAL_CROPS: Crop[] = CROPS.filter((c) => !c.fusionOnly)
/** 命中每日配方的固定奖励：100% 得 5 个特殊种子 */
export const FUSION_RECIPE_REWARD = 5

export type FusionResult = {
  gained: Array<{ id: string; name: string; emoji: string; qty: number }>
  special: boolean
  rareFish: boolean
  /** 是否命中了今日配方 */
  matchedRecipe: boolean
}

function addGain(gained: FusionResult['gained'], id: string, qty: number): void {
  const info = itemInfo(id)
  const ex = gained.find((g) => g.id === id)
  if (ex) ex.qty += qty
  else gained.push({ id, name: info.name, emoji: info.emoji, qty })
}

/**
 * 今日融合配方：按日期确定性生成（两台手机一致），3 种物品、每种至少 2 个，
 * 三样数量之和固定为 100 —— 这样「恰好命中配方」就必然满足总数量 100，100% 出货。
 */
export function dailyFusionRecipe(): Array<[string, number]> {
  const d = new Date()
  const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  const rand = () => {
    h = (h * 9301 + 49297) % 233280
    return h / 233280
  }
  const pool = [...NORMAL_CROPS, ...FISH]
  const picked = new Set<string>()
  const items: Array<[string, number]> = []
  for (let i = 0; i < 3; i++) {
    let it = pool[Math.floor(rand() * pool.length)]
    let guard = 0
    while (picked.has(it.id) && guard++ < 30) it = pool[Math.floor(rand() * pool.length)]
    picked.add(it.id)
    items.push([it.id, 0])
  }
  // 三个正整数之和 = 100，每样都 >= 2（< 100）：r1∈[2,96]，r2∈[2,98-r1]，r3 = 100-r1-r2
  const r1 = 2 + Math.floor(rand() * 95)
  const r2 = 2 + Math.floor(rand() * (97 - r1))
  const r3 = 100 - r1 - r2
  items[0][1] = r1
  items[1][1] = r2
  items[2][1] = r3
  return items
}

/** 判断投入是否恰好等于今日配方 */
function matchesRecipe(items: Record<string, number>, recipe: Array<[string, number]>): boolean {
  const keys = Object.keys(items).filter((id) => (items[id] ?? 0) > 0)
  if (keys.length !== recipe.length) return false
  for (const [id, qty] of recipe) {
    if ((items[id] ?? 0) !== qty) return false
  }
  return true
}

/**
 * 大融合：投入任意若干物品（每样都可以低于 100，几样都行）。
 * - 恰好命中「今日配方」（三样数量之和固定为 100）→ 100% 得 5 个特殊种子
 * - 未命中 → 随机 1~3 个普通种子/鱼苗（保底）
 */
export function fuseItems(who: string, items: Record<string, number>): { ok: boolean; msg: string; result?: FusionResult; matchedRecipe?: boolean } {
  const entries = Object.entries(items).filter(([, n]) => n > 0)
  if (entries.length === 0) return { ok: false, msg: '先投入一些东西再融合' }
  const mine = farmOf(farms, who)
  for (const [id, n] of entries) {
    if ((mine.warehouse[id] ?? 0) < n) {
      return { ok: false, msg: `${itemInfo(id).name} 不够（只有 ${mine.warehouse[id] ?? 0}）` }
    }
  }

  const matched = matchesRecipe(items, dailyFusionRecipe())
  const result: FusionResult = { gained: [], special: false, rareFish: false, matchedRecipe: matched }
  const ok = commit(who, (f) => {
    for (const [id, n] of entries) {
      f.warehouse[id] -= n
      if (f.warehouse[id] <= 0) delete f.warehouse[id]
    }
    if (matched) {
      result.special = true
      for (let i = 0; i < FUSION_RECIPE_REWARD; i++) {
        const c = FUSION_CROPS[Math.floor(Math.random() * FUSION_CROPS.length)]
        f.warehouse[seedId(c.id)] = (f.warehouse[seedId(c.id)] ?? 0) + 1
        addGain(result.gained, seedId(c.id), 1)
      }
    } else {
      const baseN = 1 + Math.floor(Math.random() * 3)
      for (let i = 0; i < baseN; i++) {
        if (Math.random() < 0.5) {
          const c = NORMAL_CROPS[Math.floor(Math.random() * NORMAL_CROPS.length)]
          f.warehouse[c.id] = (f.warehouse[c.id] ?? 0) + 1
          addGain(result.gained, c.id, 1)
        } else {
          const fi = FISH[Math.floor(Math.random() * FISH.length)]
          f.warehouse[fi.id] = (f.warehouse[fi.id] ?? 0) + 1
          addGain(result.gained, fi.id, 1)
        }
      }
    }
  }, [])
  if (!ok) return { ok: false, msg: '同步中，请稍后再试' }
  addTreeXp(who) // 融合行为：爱情树 +2
  return matched
    ? { ok: true, msg: `🎉 命中今日配方！爆出 ${FUSION_RECIPE_REWARD} 个特殊种子`, result, matchedRecipe: true }
    : { ok: true, msg: '融合完成（未命中今日配方，只出了普通种子/鱼苗）', result, matchedRecipe: false }
}

/** 用融合作物的种子直接种植（消耗仓库里 1 个「种子」，不用时元；收获得到的是「成品」，不可再当种子） */
export function plantFromSeed(who: string, plotId: number, cropId: string): ActionResult {
  const crop = cropById(cropId)
  if (!crop || !crop.fusionOnly) return { ok: false, msg: '只有融合作物能用种子种' }
  const sid = seedId(cropId)
  const mine = farmOf(farms, who)
  if ((mine.warehouse[sid] ?? 0) < 1) return { ok: false, msg: `没有 ${crop.name} 的种子` }
  const now = Date.now()
  const hours = cropHours(crop)
  const ok = commit(who, (f) => {
    const plot = f.plots.find((p) => p.id === plotId)
    if (!plot || plot.cropId) return
    f.warehouse[sid] -= 1
    if (f.warehouse[sid] <= 0) delete f.warehouse[sid]
    Object.assign(plot, { cropId, plantedAt: now, matureAt: now + hours * 3600_000, stolen: false, pest: rollPest() })
  }, [])
  if (ok) addTreeXp(who)
  return ok ? { ok: true, msg: `${crop.emoji} ${crop.name} 种子已种下` } : { ok: false, msg: '同步中，请稍后再试' }
}

// ===================== 农场转盘（抽奖） =====================
/** 每次抽奖花费 */
export const WHEEL_COST = 200

export type WheelPrizeType = 'thanks' | 'seed' | 'again' | 'upgrade' | 'coins'
export type WheelPrize = {
  type: WheelPrizeType
  coins?: number
  item?: { id: string; name: string; emoji: string }
  label: string
}

/** 转盘奖池权重：谢谢惠顾 40 / 特殊种子鱼苗 5 / 再来一次 10 / 土地升级券 2 / 时元合计 43（期望值低于成本，基本不赚） */
/** 十连抽：一次扣 2000 时元，逐个 roll 奖池，时元返还合并记账，结果以网格展示 */
export const WHEEL_SLICES: Array<{ type: WheelPrizeType; coins?: number; w: number; label: string }> = [
  { type: 'thanks', w: 40, label: '谢谢惠顾' },
  { type: 'seed', w: 5, label: '特殊种子/鱼苗' },
  { type: 'again', w: 10, label: '再来一次' },
  { type: 'upgrade', w: 2, label: '土地升级券' },
  { type: 'coins', w: 15, coins: 50, label: '50 时元' },
  { type: 'coins', w: 15, coins: 100, label: '100 时元' },
  { type: 'coins', w: 8, coins: 200, label: '200 时元' },
  { type: 'coins', w: 5, coins: 300, label: '300 时元' },
]

function rollWheelSlice(): (typeof WHEEL_SLICES)[number] {
  const total = WHEEL_SLICES.reduce((s, x) => s + x.w, 0)
  let r = Math.random() * total
  for (const s of WHEEL_SLICES) {
    if (r < s.w) return s
    r -= s.w
  }
  return WHEEL_SLICES[0]
}

/** 抽一次转盘：扣 200 时元；再来一次则返还（净零）。返回中奖信息 */
export function spinWheel(who: string, balance: number): { ok: boolean; msg: string; prize: WheelPrize } {
  const prize: WheelPrize = { type: 'thanks', label: '谢谢惠顾' }
  if (balance < WHEEL_COST) return { ok: false, msg: `时元不足（抽一次需要 ${WHEEL_COST}）`, prize }
  const slice = rollWheelSlice()
  if (slice.type === 'again') {
    if (!addTx(who, WHEEL_COST, '🎡 转盘·再来一次返还')) return { ok: false, msg: '同步中，请稍后再试', prize }
    return { ok: true, msg: '🎉 再来一次！200 时元已返还', prize: { type: 'again', label: '再来一次' } }
  }
  if (!addTx(who, -WHEEL_COST, '🎡 抽一次转盘')) return { ok: false, msg: '同步中，请稍后再试', prize }
  if (slice.type === 'coins') {
    const n = slice.coins ?? 0
    addTx(who, n, `🎡 转盘中了 ${n} 时元`)
    return { ok: true, msg: `🎉 中了 ${n} 时元！`, prize: { type: 'coins', coins: n, label: `${n} 时元` } }
  }
  if (slice.type === 'seed') {
    const isFish = Math.random() < 0.5
    if (isFish) {
      const rf = RARE_FISH[Math.floor(Math.random() * RARE_FISH.length)]
      commit(who, (f) => {
        f.warehouse[fryId(rf.id)] = (f.warehouse[fryId(rf.id)] ?? 0) + 1
      }, [])
      return { ok: true, msg: `🎉 爆出稀有鱼苗 ${rf.emoji}${rf.name}！`, prize: { type: 'seed', item: { id: rf.id, name: rf.name, emoji: rf.emoji }, label: '特殊种子/鱼苗' } }
    }
    const c = FUSION_CROPS[Math.floor(Math.random() * FUSION_CROPS.length)]
    commit(who, (f) => {
      f.warehouse[seedId(c.id)] = (f.warehouse[seedId(c.id)] ?? 0) + 1
    }, [])
    return { ok: true, msg: `🎉 爆出特殊种子 ${c.emoji}${c.name}！`, prize: { type: 'seed', item: { id: c.id, name: c.name, emoji: c.emoji }, label: '特殊种子/鱼苗' } }
  }
  if (slice.type === 'upgrade') {
    commit(who, (f) => {
      f.upgradeTokens = (f.upgradeTokens ?? 0) + 1
    }, [])
    return { ok: true, msg: '🎉 中了土地升级券！可免费升级任意土地一级', prize: { type: 'upgrade', label: '土地升级券' } }
  }
  return { ok: true, msg: '😅 谢谢惠顾，下次好运！', prize: { type: 'thanks', label: '谢谢惠顾' } }
}

/** 连抽（十连抽等）：一次扣 N 次费用，逐个 roll 奖池；中奖时元 / 再来一次返还各合并记一笔账。返回全部结果 */
export function spinWheelMulti(
  who: string,
  balance: number,
  times: number,
): { ok: boolean; msg: string; prizes: WheelPrize[] } {
  const prizes: WheelPrize[] = []
  const cost = WHEEL_COST * times
  if (balance < cost) return { ok: false, msg: `时元不足（${times} 连抽需要 ${cost}）`, prizes }
  if (!addTx(who, -cost, `🎡 ${times} 连抽转盘`)) return { ok: false, msg: '同步中，请稍后再试', prizes }
  let coinsWon = 0
  let againCount = 0
  for (let i = 0; i < times; i++) {
    const slice = rollWheelSlice()
    if (slice.type === 'again') {
      againCount++
      prizes.push({ type: 'again', label: '再来一次' })
      continue
    }
    if (slice.type === 'coins') {
      const n = slice.coins ?? 0
      coinsWon += n
      prizes.push({ type: 'coins', coins: n, label: `${n} 时元` })
      continue
    }
    if (slice.type === 'seed') {
      const isFish = Math.random() < 0.5
      if (isFish) {
        const rf = RARE_FISH[Math.floor(Math.random() * RARE_FISH.length)]
        commit(who, (f) => {
          f.warehouse[fryId(rf.id)] = (f.warehouse[fryId(rf.id)] ?? 0) + 1
        }, [])
        prizes.push({ type: 'seed', item: { id: rf.id, name: rf.name, emoji: rf.emoji }, label: '特殊种子/鱼苗' })
      } else {
        const c = FUSION_CROPS[Math.floor(Math.random() * FUSION_CROPS.length)]
        commit(who, (f) => {
          f.warehouse[seedId(c.id)] = (f.warehouse[seedId(c.id)] ?? 0) + 1
        }, [])
        prizes.push({ type: 'seed', item: { id: c.id, name: c.name, emoji: c.emoji }, label: '特殊种子/鱼苗' })
      }
      continue
    }
    if (slice.type === 'upgrade') {
      commit(who, (f) => {
        f.upgradeTokens = (f.upgradeTokens ?? 0) + 1
      }, [])
      prizes.push({ type: 'upgrade', label: '土地升级券' })
      continue
    }
    prizes.push({ type: 'thanks', label: '谢谢惠顾' })
  }
  if (coinsWon > 0) addTx(who, coinsWon, `🎡 ${times} 连转盘共中时元`)
  if (againCount > 0) addTx(who, WHEEL_COST * againCount, `🎡 转盘·再来一次返还 ×${againCount}`)
  const seeds = prizes.filter((p) => p.type === 'seed').length
  const ups = prizes.filter((p) => p.type === 'upgrade').length
  const thanks = prizes.filter((p) => p.type === 'thanks').length
  const parts: string[] = []
  if (coinsWon > 0) parts.push(`${coinsWon} 时元`)
  if (seeds > 0) parts.push(`特殊种子×${seeds}`)
  if (ups > 0) parts.push(`升级券×${ups}`)
  if (againCount > 0) parts.push(`再来一次×${againCount}`)
  if (thanks > 0) parts.push(`谢谢惠顾×${thanks}`)
  return { ok: true, msg: `🎉 ${times} 连抽完成：${parts.join('、')}`, prizes }
}

/** 发放奖励物品到仓库（盲盒等系统赠送，不产生时元账；图鉴解锁单独记奖励账） */
export function giftItems(who: string, items: Array<[string, number]>): boolean {
  let dexGain = 0
  const dexNames: string[] = []
  const ok = commit(who, (f) => {
    for (const [id, qty] of items) {
      f.warehouse[id] = (f.warehouse[id] ?? 0) + qty
      const g = dexUnlock(f, id)
      if (g > 0) {
        dexGain += g
        dexNames.push(itemInfo(id).name)
      }
    }
  }, [])
  if (ok && dexGain > 0) addTx(who, dexGain, `图鉴解锁·${dexNames.slice(0, 3).join('、')}`)
  return ok
}

/** 土地升级：0→1 200，1→2 300，2→3 400，3→4 1000；加暴击概率 + 每级 +1 产量 */
export function upgradePlot(who: string, plotId: number, balance: number): ActionResult {
  const mine = farmOf(farms, who)
  const plot = mine.plots.find((p) => p.id === plotId)
  if (!plot) return { ok: false, msg: '没有这块地' }
  const lv = plot.level ?? 0
  if (lv >= MAX_LEVEL) return { ok: false, msg: '已经是最高级的青色土地啦 ✨' }
  const cost = UPGRADE_COSTS[lv]
  const hasToken = (mine.upgradeTokens ?? 0) > 0
  if (!hasToken && balance < cost) return { ok: false, msg: `时元不足（升级需要 ${cost}）` }
  const ok = commit(who, (f) => {
    const p = f.plots.find((x) => x.id === plotId)!
    p.level = lv + 1
    if (hasToken) f.upgradeTokens = (f.upgradeTokens ?? 0) - 1
  }, hasToken ? [] : [[-cost, `土地升级·${LEVEL_NAMES[lv + 1]}`]])
  return ok
    ? {
        ok: true,
        msg: hasToken
          ? `✨ 用升级券免费升级为${LEVEL_NAMES[lv + 1]}！`
          : `✨ 升级为${LEVEL_NAMES[lv + 1]}！这块地产量 +1、暴击率提升`,
      }
    : { ok: false, msg: '同步中，请稍后再试' }
}

/** 一键养鱼：放满所有空养殖位（鱼版 plantAll） */
export function stockAllFish(who: string, fishId: string, balance: number): ActionResult {
  const fish = fishById(fishId)
  if (!fish) return { ok: false, msg: '未知水产' }
  const mine = farmOf(farms, who)
  const empties = mine.pond.filter((s) => !s.fishId)
  if (empties.length === 0) return { ok: false, msg: '没有空养殖位了' }
  const total = fish.cost * empties.length
  if (balance < total) return { ok: false, msg: `放满需要 ${total} 时元，余额不足` }
  const now = Date.now()
  const ok = commit(who, (f) => {
    for (const s of f.pond) {
      if (s.fishId) continue
      Object.assign(s, { fishId, startedAt: now, matureAt: now + fish.hours * 3600_000 })
    }
  }, [[-total, `一键养满${fish.name}×${empties.length}`]])
  if (ok) addTreeXp(who) // 养殖行为：爱情树 +2
  return ok
    ? { ok: true, msg: `${fish.emoji} 一键放满 ${empties.length} 个养殖位（-${total} 时元）` }
    : { ok: false, msg: '同步中，请稍后再试' }
}
