// 临时脚本：桌面「玉石」文件夹 21 张图 → 裁水印 → 512px → 按规范命名进 src/assets/jade/
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'

const IN = 'tmp/jade-incoming'
const OUT = 'src/assets/jade'

// 看图识别结果（品种=颜色：血玉深红 / 赤霞橙红带金砂 / 炫彩乳白虹彩；器型=形状）
const MAP = {
  'jade-bloodjade.jpg': 'jade-bloodjade.jpg',
  '5bd12bf7b82e36b24a3aee839bbab91b.png': 'jade-chixia.jpg', // 橙红金砂蛋面·黑绒
  '881ecfe4327c7849433dd3ff0466cecd.png': 'jade-rainbow.jpg', // 欧泊虹彩蛋面·黑绒
  'craft-bangle-bloodjade.jpg': 'craft-bangle-bloodjade.jpg',
  '6a65f9e22a9fd8f3bf83df9f7b8b19ef.png': 'craft-bangle-chixia.jpg', // 橙红金砂手镯
  '1d8be323402fcac6222121982dfcb84a.png': 'craft-bangle-rainbow.jpg', // 虹彩手镯·冰面
  '36b8ba5cd3f75dcd7644afab9d013dc5.png': 'craft-bracelet-bloodjade.jpg', // 深红珠串·宣纸
  'fb80d4c642f10fbc5e4496fac4832540.png': 'craft-bracelet-chixia.jpg', // 橙红金砂珠串·白绸
  '356b9c4473e7a1bc8960d683590bc1dd.png': 'craft-bracelet-rainbow.jpg', // 虹彩珠串·水面
  '98b260e67e6cd7d91573cc0a637db2b4.png': 'craft-pendant-bloodjade.jpg', // 深红平安扣·木盘
  '5eb56f92d812cd6cc416c045225430d2.png': 'craft-pendant-chixia.jpg', // 金云平安扣·冰面
  '8edf748ece67b9553df0c3713e7af669.png': 'craft-pendant-chixia-2.jpg', // 赤霞平安扣微距（变体）
  'c0b5264aac430a22ce3aa852b922c893.png': 'craft-pendant-rainbow.jpg', // 虹彩平安扣·冰面
  '58615c861a4aaf5c4138782a879e4ebf.png': 'craft-ring-bloodjade.jpg', // 深红戒指·冰面
  'fff1b5e6c99d27774a4cd6ea744a8b73.png': 'craft-ring-chixia.jpg', // 橙红金砂戒指·黑缎
  'cd14a1b33271ebb2a03d9a311413ba92.png': 'craft-ring-rainbow.jpg', // 虹彩戒指·绿绸
  'e487f72ff6949187e0384a29469ebf8a.png': 'craft-earrings-bloodjade.jpg', // 深红耳坠·窗台
  'fef752db35b1b2906f53d24f66583f22.png': 'craft-earrings-rainbow.jpg', // 虹彩耳坠·宣纸
  '6aae6b1792e3420bb05d59a066599acd.png': 'craft-ornament-bloodjade.jpg', // 深红祥云摆件·大理石
  '057a14283dcba082f2ba81b021b50e52.png': 'craft-ornament-chixia.jpg', // 金砂祥云摆件·石台
  'eeba1d7d25893e01a968dc9ce11d5014.png': 'craft-ornament-rainbow.jpg', // 虹彩祥云摆件·云朵
}
// 缺：craft-earrings-chixia.jpg（赤霞耳坠，前端 emoji 兜底，可后补）

await mkdir(OUT, { recursive: true })
for (const [src, dst] of Object.entries(MAP)) {
  // 384px 原图，右下角"豆包AI生成"水印：裁掉底部 42px → cover 到 512 方图
  const buf = await sharp(join(IN, src))
    .extract({ left: 0, top: 0, width: 384, height: 342 })
    .resize(512, 512, { fit: 'cover' })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer()
  await writeFile(join(OUT, dst), buf)
  console.log(`OK ${dst} (${Math.round(buf.length / 1024)}KB)`)
}
console.log('DONE, 缺 craft-earrings-chixia')
