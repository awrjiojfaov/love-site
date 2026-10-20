// 临时脚本：为红色新档次（bloodjade 血玉 / chixia 赤霞）打印全套生图提示词
// 逻辑与 tools/gen_jade_crafts.mjs 完全一致（同样的场景/角度/光影池子 + 同样的确定性抽签）
const VARIETIES = {
  bloodjade: 'deep blood-red jadeite, vivid crimson with a glowing molten ruby core, highly translucent',
  chixia: 'brilliant vermilion cinnabar-red jadeite with shimmering golden mineral flecks suspended inside, like glowing sunset clouds, highly translucent',
  rainbow: 'translucent milky-white jadeite filled with vivid iridescent rainbow play-of-color, swirling aurora-like hues of red orange gold green blue and violet shimmering inside like liquid opal, otherworldly dazzling beauty',
}
const RARITY_FLAVOR = {
  bloodjade: 'dramatic red light spill, faint ember sparkle in the air',
  chixia: 'warm sunset glow, golden bokeh in the air, luxurious',
  rainbow: 'dazzling prismatic light spill, rainbow bokeh and tiny sparkles floating in the air, breathtaking luxury',
}
const TYPES = {
  bangle: 'a single polished jadeite bangle bracelet, perfect smooth circular ring shape standing upright',
  bracelet: 'a jadeite bead bracelet, string of round polished jade beads, coiled elegantly',
  pendant: 'a jadeite pendant, round lucky donut-shaped ping-an-kou disc with a small bail loop',
  ring: 'a jadeite ring, smooth polished simple band, standing upright',
  earrings: 'a pair of jadeite drop earrings with tiny hooks',
  ornament: 'a small carved jadeite ornament sculpture, auspicious cloud motif, on a tiny wooden stand',
}
const SCENES = [
  'on dark charcoal velvet with soft folds',
  'on pale ivory silk fabric with gentle ripples',
  'on a black marble slab with subtle veining',
  'on a warm walnut wood tray beside a sprig of greenery',
  'on a sunlit linen surface near a window',
  'on an icy translucent glass surface with delicate reflections',
  'on deep emerald-green silk with a luxe sheen',
  'on a weathered stone pedestal outdoors with soft bokeh greenery',
  'floating above a mirror-like water surface with gentle ripples',
  'on a bed of white cotton clouds with dust motes in the air',
  'on antique rice paper with a faint ink-wash landscape',
  'on rough beige clay with a few scattered jade pebbles',
]
const ANGLES = [
  'three-quarter view',
  'top-down flat lay',
  'macro close-up detail',
  'low side profile view',
  'slight overhead angle',
  'close hero shot with shallow depth of field',
]
const LIGHTS = [
  'soft diffused studio lighting',
  'warm golden-hour rim light',
  'cool moonlight glow',
  'dramatic single spotlight',
  'backlit to reveal translucency',
  'bright clean daylight',
  'moody low-key lighting with deep shadows',
  'gentle bounce light from above',
]
const BASE_STYLE =
  'photorealistic fine jewelry product photography, ultra detailed, crisp focus, ' +
  'square composition, no text, no watermark, no hands'
const STYLE_JADE =
  'photorealistic polished gemstone cabochon on black velvet, macro jewelry photography, ' +
  'soft studio light, centered, square composition, no text, no watermark'

function hash01(s) {
  let h = 0
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)) & 0xffffffff
  return (h >>> 0) / 4294967296
}
const pick = (pool, seed) => pool[Math.floor(hash01(seed) * pool.length) % pool.length]

function buildPrompt(typeId, varietyId, variant) {
  const seed = `${typeId}|${varietyId}|${variant}`
  const parts = [
    TYPES[typeId],
    `made of ${VARIETIES[varietyId]}`,
    pick(SCENES, seed + '|scene'),
    pick(ANGLES, seed + '|angle'),
    pick(LIGHTS, seed + '|light'),
  ]
  const flavor = RARITY_FLAVOR[varietyId] ?? ''
  if (flavor) parts.push(flavor)
  parts.push(BASE_STYLE)
  return parts.join(', ')
}

for (const v of Object.keys(VARIETIES)) {
  console.log(`\n===== ${v} 原石主图 jade-${v}.jpg =====`)
  console.log(`${VARIETIES[v]}, ${STYLE_JADE}`)
  for (const t of Object.keys(TYPES)) {
    for (let k = 1; k <= 2; k++) {
      const name = k === 1 ? `craft-${t}-${v}` : `craft-${t}-${v}-${k}`
      console.log(`\n--- ${name}.jpg ---`)
      console.log(buildPrompt(t, v, k))
    }
  }
}
