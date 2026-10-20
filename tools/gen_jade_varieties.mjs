// 新矿脉品种生图（Node 版）：10 个新品种各 1 张 cabochon 主图，压到 512px 存 src/assets/jade/
// 用法: $env:DOUBAO_KEY='ark-xxx'; node tools/gen_jade_varieties.mjs [varietyId ...] [--force]
// 断点续跑：已存在且 >10KB 的文件自动跳过
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'src', 'assets', 'jade')

const STYLE_JADE =
  'photorealistic polished gemstone cabochon on black velvet, macro jewelry photography, ' +
  'soft studio light, centered, square composition, no text, no watermark'

const IMAGES = {
  'jade-tiedsheng': `opaque vivid emerald-green jadeite, dense dark-green speckled texture like spinach leaves, ${STYLE_JADE}`,
  'jade-silvermetal': `polished lustrous white silver nugget, soft mirror shine with cool metallic gleam, ${STYLE_JADE}`,
  'jade-bluewater': `translucent deep watery blue jadeite, clear calm ocean-water blue tone, ${STYLE_JADE}`,
  'jade-spring': `soft cherry-blossom pink jadeite, tender spring pink with waxy translucency, romantic, ${STYLE_JADE}`,
  'jade-skyblue': `clear airy sky-blue jadeite, light cerulean blue, fresh and translucent, ${STYLE_JADE}`,
  'jade-deepblue': `deep sapphire dark blue jadeite, rich ocean-depth blue with mysterious inner glow, ${STYLE_JADE}`,
  'jade-goldmetal': `polished pure gold nugget, rich warm 24k golden luster, soft mirror shine, ${STYLE_JADE}`,
  'jade-royalviolet': `royal deep purple jadeite, intense saturated violet, regal inner glow, ${STYLE_JADE}`,
  'jade-goldsand': `translucent pale jadeite glittering with golden sand flecks suspended inside, gold-spangled texture, ${STYLE_JADE}`,
  'jade-gilded': `emerald-green jadeite with flowing gilded gold veins and shimmering golden highlights, luxurious, ${STYLE_JADE}`,
  'jade-bloodjade': `deep blood-red jadeite cabochon, vivid crimson with a glowing molten ruby core, highly translucent, ${STYLE_JADE}`,
  'jade-chixia': `brilliant vermilion cinnabar-red jadeite cabochon with shimmering golden mineral flecks suspended inside, like glowing sunset clouds, highly translucent, ${STYLE_JADE}`,
  'jade-rainbow': `translucent milky-white jadeite cabochon filled with vivid iridescent rainbow play-of-color, swirling aurora-like hues shimmering inside like liquid opal, ${STYLE_JADE}`,
}

const KEY = process.env.DOUBAO_KEY ?? ''
const EP = process.env.DOUBAO_IMAGE_EP || 'ep-20260826135342-vjp9g'
const API = 'https://ark.cn-beijing.volces.com/api/v3/images/generations'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let fatal = false

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

async function main() {
  if (!KEY) {
    console.error('DOUBAO_KEY not set')
    process.exit(1)
  }
  const args = process.argv.slice(2)
  const force = args.includes('--force')
  const only = args.filter((a) => !a.startsWith('-'))
  const names = (only.length ? only : Object.keys(IMAGES)).filter((n) => n in IMAGES)
  let failed = 0
  for (const n of names) {
    const ok = await genOne(n, IMAGES[n], force)
    if (!ok) failed++
  }
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
