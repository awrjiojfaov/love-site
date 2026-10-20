// 玉器工坊生图（Node 版）：13 品种 x 6 器型 x N 变体，压到 512px 存 src/assets/jade/
// 用法: $env:DOUBAO_KEY='ark-xxx'; node tools/gen_jade_crafts.mjs [varietyId ...] [--n 2] [--types bangle,ring] [--force]
//   --n N           每个 {器型}-{品种} 生成 N 个变体（默认 2；第 1 张沿用老命名 craft-t-v.jpg，第 k 张 craft-t-v-k.jpg）
//   --force         已存在的图也重新生成
//   --types         只跑指定器型（逗号分隔）
//   --concurrency   并发数（默认 3）
// 断点续跑：已存在且 >10KB 的文件自动跳过
//
// 关键点：同一器型不再"千篇一律"——场景/角度/光影三个池子按 {器型}|{品种}|{变体} 确定性抽签，
// 每个组合都拿到不同的布景，且多端可复现（前端 jadeArt.craftArt 按成品 id 从变体里稳定挑一张）。
// 这是 tools/gen_jade_crafts.py 的等价 Node 移植（本机没装 Python，改用已安装的 sharp 压图）。
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'src', 'assets', 'jade')

const VARIETIES = {
  marble: 'dull white gray marble with faint veins, matte, low value',
  doudi: 'opaque pea-green jadeite, bean-green coarse texture',
  nuo: 'waxy translucent pale green jadeite, milky glutinous texture',
  bingnuo: 'translucent icy-waxy pale green jadeite, half see-through',
  qingshui: 'clear aqua blue-green jadeite, serene water color',
  yellow: 'warm honey-yellow jadeite, golden amber glow',
  red: 'vivid vermilion red jadeite, fiery russet tone',
  mo: 'deep ink-black jadeite with dark green inner glow',
  violet: 'soft lavender violet jadeite, dreamy purple',
  ice: 'highly translucent icy colorless-pale-green jadeite, frost-like clarity',
  highice: 'near-glass transparency icy jadeite, brilliant inner glow',
  glass: 'flawless glass-transparent colorless jadeite, crystal clear like a drop of water',
  emperor: 'legendary imperial emerald-green jadeite, intense saturated vivid green, glowing',
  tiedsheng: 'opaque vivid emerald-green jadeite, dense dark-green speckled texture like spinach leaves',
  silvermetal: 'polished lustrous white silver metal, soft mirror shine with cool metallic gleam',
  bluewater: 'translucent deep watery blue jadeite, clear calm ocean-water blue tone',
  spring: 'soft cherry-blossom pink jadeite, tender spring pink with waxy translucency',
  skyblue: 'clear airy sky-blue jadeite, light cerulean blue, fresh and translucent',
  deepblue: 'deep sapphire dark blue jadeite, rich ocean-depth blue with mysterious inner glow',
  goldmetal: 'polished pure gold metal, rich warm 24k golden luster, soft mirror shine',
  royalviolet: 'royal deep purple jadeite, intense saturated violet, regal inner glow',
  goldsand: 'translucent pale jadeite glittering with golden sand flecks suspended inside',
  gilded: 'emerald-green jadeite with flowing gilded gold veins and shimmering golden highlights',
  bloodjade: 'deep blood-red jadeite, vivid crimson with a glowing molten ruby core, highly translucent',
  chixia: 'brilliant vermilion cinnabar-red jadeite with shimmering golden mineral flecks suspended inside, like glowing sunset clouds, highly translucent',
  rainbow: 'translucent milky-white jadeite filled with vivid iridescent rainbow play-of-color, swirling aurora-like hues of red orange gold green blue and violet shimmering inside like liquid opal, otherworldly dazzling beauty',
}

const RARITY_FLAVOR = {
  marble: '',
  doudi: '',
  nuo: '',
  bingnuo: '',
  qingshui: '',
  yellow: '',
  red: '',
  mo: 'mysterious low-key mood, faint inner glow',
  violet: 'dreamy soft focus haze, ethereal glow',
  ice: 'frosty cool atmosphere, tiny sparkle in the air',
  highice: 'brilliant inner light, subtle lens flare',
  glass: 'museum-grade presentation, ethereal glow, faint sparkle in the air',
  emperor: 'museum-grade presentation, dramatic green light spill, faint sparkle in the air',
  tiedsheng: '',
  silvermetal: 'cool moonlight glow, mirror-like highlights',
  bluewater: 'gentle ripple reflections like still water',
  spring: 'dreamy soft focus haze, petals drifting in the background',
  skyblue: 'airy high-key lighting, soft daylight',
  deepblue: 'moody low-key lighting, deep ocean atmosphere',
  goldmetal: 'warm golden-hour rim light, rich highlights',
  royalviolet: 'regal museum presentation, soft purple glow',
  goldsand: 'sparkling golden bokeh in the air, festive glow',
  gilded: 'dramatic gold light spill, luxurious glow',
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

const KEY = process.env.DOUBAO_KEY ?? ''
const EP = process.env.DOUBAO_IMAGE_EP || 'ep-20260826135342-vjp9g'
const API = 'https://ark.cn-beijing.volces.com/api/v3/images/generations'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 确定性散列 -> [0,1)，同一组合每次都抽到同一套布景（与 Python 版算法一致）
 * 2026-10-05 修负数索引：JS 位运算返回有符号 32 位，h 为负时 floor(×N)%N 是负下标 → 抽到 undefined；
 * 先 >>> 0 转无符号再除，存量图因 SKIP 断点续跑不受影响 */
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

async function genOne(name, prompt, force) {
  const target = join(OUT, `${name}.jpg`)
  if (!force) {
    try {
      const s = await stat(target)
      if (s.size > 10000) {
        console.log(`SKIP ${name}`)
        return true
      }
    } catch {
      /* 不存在就往下走 */
    }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: EP,
          prompt,
          size: '1024x1024',
          response_format: 'b64_json',
          watermark: false,
        }),
      })
      if (res.status !== 200) {
        const body = (await res.text()).slice(0, 160)
        if (res.status === 401 || res.status === 402 || res.status === 404) {
          const hint =
            res.status === 401
              ? '密钥无效（401）'
              : res.status === 402
                ? '余额不足（402），先去火山引擎充值'
                : '接入点 ID 不对（404），检查 DOUBAO_IMAGE_EP'
          console.error(`FATAL ${name}: ${hint} ${body}`)
          fatal = true
          return false
        }
        console.log(`RETRY ${name} http ${res.status}: ${body}`)
        await sleep(3000 * (attempt + 1))
        continue
      }
      const data = await res.json()
      const b64 = data?.data?.[0]?.b64_json
      if (!b64) {
        console.log(`RETRY ${name} empty data`)
        await sleep(3000)
        continue
      }
      const buf = Buffer.from(b64, 'base64')
      const jpg = await sharp(buf)
        .resize(512, 512, { fit: 'fill' })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer()
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, jpg)
      console.log(`OK   ${name} (${Math.round(jpg.length / 1024)}KB)`)
      return true
    } catch (e) {
      console.log(`RETRY ${name} ${e?.name ?? 'Error'}: ${String(e?.message ?? e).slice(0, 140)}`)
      await sleep(3000 * (attempt + 1))
    }
  }
  console.log(`FAIL ${name}`)
  return false
}

function parseArgs(argv) {
  const args = { varieties: [], n: 2, types: '', force: false, concurrency: 3 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--n') args.n = Number(argv[++i]) || 2
    else if (a === '--types') args.types = argv[++i] ?? ''
    else if (a === '--force') args.force = true
    else if (a === '--concurrency') args.concurrency = Math.max(1, Number(argv[++i]) || 3)
    else if (a === '--help' || a === '-h') {
      console.log(
        '用法: DOUBAO_KEY=ark-xxx node tools/gen_jade_crafts.mjs [品种...] [--n 2] [--types bangle,ring] [--force] [--concurrency 3]',
      )
      process.exit(0)
    } else if (!a.startsWith('-')) args.varieties.push(a)
  }
  return args
}

let fatal = false

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!KEY) {
    console.error('DOUBAO_KEY not set（$env:DOUBAO_KEY=...）')
    process.exit(1)
  }
  const varIds = (args.varieties.length ? args.varieties : Object.keys(VARIETIES)).filter(
    (v) => v in VARIETIES,
  )
  const typeIds = (args.types ? args.types.split(',') : Object.keys(TYPES)).filter((t) => t in TYPES)

  const jobs = []
  for (const v of varIds)
    for (const t of typeIds)
      for (let k = 1; k <= args.n; k++)
        // 第 1 张沿用老命名（78 张存量图直接当变体 1），第 k 张加 -k 后缀
        jobs.push({ name: k === 1 ? `craft-${t}-${v}` : `craft-${t}-${v}-${k}`, prompt: buildPrompt(t, v, k) })

  console.log(`共 ${jobs.length} 张，并发 ${args.concurrency}，输出 ${OUT}`)
  let done = 0
  let failed = 0
  let cursor = 0
  const workers = Array.from({ length: Math.min(args.concurrency, jobs.length) }, async () => {
    for (;;) {
      if (fatal) return
      const i = cursor++
      if (i >= jobs.length) return
      const ok = await genOne(jobs[i].name, jobs[i].prompt, args.force)
      done++
      if (!ok) failed++
      console.log(`[${done}/${jobs.length}]`)
    }
  })
  await Promise.all(workers)
  if (fatal) {
    console.error('ABORT（密钥/接入点/余额问题，已停）')
    process.exit(1)
  }
  console.log(failed === 0 ? 'DONE' : `SOME_FAILED failed=${failed}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
