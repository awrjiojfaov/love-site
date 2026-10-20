/* 玉石鉴定 · 图像资源：4 块石头 + 13 个品种，全部由豆包 Seedream 生成（tools/gen_jade_images.py）
 * 静态打包进站点，玩家无需配 Key、零等待、零 token 消耗
 */
import stoneT1 from '../assets/jade/stone-t1.jpg';
import stoneT2 from '../assets/jade/stone-t2.jpg';
import stoneT3 from '../assets/jade/stone-t3.jpg';
import stoneT4 from '../assets/jade/stone-t4.jpg';
import stoneT5 from '../assets/jade/stone-t5.jpg';
import jadeMarble from '../assets/jade/jade-marble.jpg';
import jadeDoudi from '../assets/jade/jade-doudi.jpg';
import jadeNuo from '../assets/jade/jade-nuo.jpg';
import jadeBingnuo from '../assets/jade/jade-bingnuo.jpg';
import jadeQingshui from '../assets/jade/jade-qingshui.jpg';
import jadeYellow from '../assets/jade/jade-yellow.jpg';
import jadeRed from '../assets/jade/jade-red.jpg';
import jadeMo from '../assets/jade/jade-mo.jpg';
import jadeViolet from '../assets/jade/jade-violet.jpg';
import jadeIce from '../assets/jade/jade-ice.jpg';
import jadeHighice from '../assets/jade/jade-highice.jpg';
import jadeGlass from '../assets/jade/jade-glass.jpg';
import jadeEmperor from '../assets/jade/jade-emperor.jpg';
import jadeTiedsheng from '../assets/jade/jade-tiedsheng.jpg';
import jadeSilvermetal from '../assets/jade/jade-silvermetal.jpg';
import jadeBluewater from '../assets/jade/jade-bluewater.jpg';
import jadeSpring from '../assets/jade/jade-spring.jpg';
import jadeSkyblue from '../assets/jade/jade-skyblue.jpg';
import jadeDeepblue from '../assets/jade/jade-deepblue.jpg';
import jadeGoldmetal from '../assets/jade/jade-goldmetal.jpg';
import jadeRoyalviolet from '../assets/jade/jade-royalviolet.jpg';
import jadeGoldsand from '../assets/jade/jade-goldsand.jpg';
import jadeGilded from '../assets/jade/jade-gilded.jpg';
import jadeBloodjade from '../assets/jade/jade-bloodjade.jpg';
import jadeChixia from '../assets/jade/jade-chixia.jpg';
import jadeRainbow from '../assets/jade/jade-rainbow.jpg';

export const STONE_ART: Record<string, string> = {
  t1: stoneT1,
  t2: stoneT2,
  t3: stoneT3,
  t4: stoneT4,
  t5: stoneT5,
};

export const JADE_ART: Record<string, string> = {
  marble: jadeMarble,
  doudi: jadeDoudi,
  nuo: jadeNuo,
  bingnuo: jadeBingnuo,
  qingshui: jadeQingshui,
  yellow: jadeYellow,
  red: jadeRed,
  mo: jadeMo,
  violet: jadeViolet,
  ice: jadeIce,
  highice: jadeHighice,
  glass: jadeGlass,
  emperor: jadeEmperor,
  tiedsheng: jadeTiedsheng,
  silvermetal: jadeSilvermetal,
  bluewater: jadeBluewater,
  spring: jadeSpring,
  skyblue: jadeSkyblue,
  deepblue: jadeDeepblue,
  goldmetal: jadeGoldmetal,
  royalviolet: jadeRoyalviolet,
  goldsand: jadeGoldsand,
  gilded: jadeGilded,
  bloodjade: jadeBloodjade,
  chixia: jadeChixia,
  rainbow: jadeRainbow,
};

/* 工坊成品图：craft-{器型}-{品种}[-{变体号}].jpg 共 78+ 张（tools/gen_jade_crafts.py 生成），用 glob 自动登记。
 * 同一 {器型}-{品种} 可以有多张变体（craft-bangle-ice.jpg / craft-bangle-ice-2.jpg …），
 * 传 seed（一般用成品 id）就能为每件成品稳定挑一张，避免"每件都长一样"。
 */
const craftFiles = import.meta.glob('../assets/jade/craft-*.jpg', {
  eager: true,
  import: 'default',
}) as Record<string, string>

export const CRAFT_ART: Record<string, string> = {}
const groups: Record<string, { key: string; url: string }[]> = {}
for (const [path, url] of Object.entries(craftFiles)) {
  const key = path.split('/').pop()!.replace(/^craft-/, '').replace(/\.jpg$/, '')
  CRAFT_ART[key] = url
  const base = key.replace(/-\d+$/, '')
  ;(groups[base] ??= []).push({ key, url })
}
// 按 key 排序（基础图没有 -N 后缀，天然排在变体前），保证多端选图一致
const CRAFT_VARIANTS: Record<string, string[]> = {}
for (const [base, list] of Object.entries(groups)) {
  list.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  CRAFT_VARIANTS[base] = list.map((x) => x.url)
}

function hash01(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h / 4294967296
}

/** 成品图查询：{器型}-{品种}，同款多变体时按 seed 稳定挑选；缺图返回 undefined（UI 用 emoji 兜底） */
export const craftArt = (typeId: string, varietyId: string, seed?: string): string | undefined => {
  const list = CRAFT_VARIANTS[`${typeId}-${varietyId}`]
  if (!list || list.length === 0) return undefined
  if (list.length === 1 || !seed) return list[0]
  return list[Math.floor(hash01(seed) * list.length)]
}
