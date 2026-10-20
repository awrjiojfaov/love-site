/* 星陨料（t5）原石图：深空陨石风，与现有四块石头图（暗背景、皮箱台面）风格协调。
 * 手绘 SVG 分层（锯齿轮廓 + 噪点岩石肌理 + 七彩裂纹玉光），sharp 渲染成 JPG。
 * 运行：node tools/gen_stone_t5.mjs
 */
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets', 'jade', 'stone-t5.jpg');

/* ---------- 随机（固定种子，可重复生成） ---------- */
let s = 8261020;
const rand = () => {
  s = (s * 1103515245 + 12345) % 2147483648;
  return s / 2147483648;
};

const W = 512, H = 512;
const CX = 264, CY = 268;
const R = 152;

/* ---------- 1. 锯齿状陨石轮廓：极坐标 + 半径扰动 ---------- */
const N = 26;
const pts = [];
for (let i = 0; i < N; i++) {
  const a = (i / N) * Math.PI * 2;
  // 基础椭圆（横宽竖扁）+ 角部大扰动 + 小抖动
  const base = 1 + 0.18 * Math.sin(a * 3 + 1.2) + 0.1 * Math.sin(a * 7 + 0.5);
  const r = R * base * (0.88 + rand() * 0.26);
  pts.push([CX + Math.cos(a) * r * 1.08, CY + Math.sin(a) * r * 0.94]);
}
/* 用 Catmull-Rom -> bezier 的近似：直接折线 + 用小圆角软化（stroke-linejoin round 加粗描边法）。
 * 简化方案：折线本身 + 外层模糊描边软化边缘。 */
const poly = pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L ');
const rockPath = `M ${poly} Z`;

/* ---------- 2. 陨坑 ---------- */
function crater(cx, cy, rx, ry, o, rot) {
  return `<g opacity="${o}" transform="rotate(${rot} ${cx} ${cy})">
    <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#141318"/>
    <path d="M ${cx - rx * 0.85} ${cy - ry * 0.62} Q ${cx} ${cy - ry * 1.4} ${cx + rx * 0.85} ${cy - ry * 0.62}"
      stroke="#6e6a5e" stroke-width="1.8" fill="none" opacity="0.6"/>
    <path d="M ${cx - rx * 0.85} ${cy + ry * 0.5} Q ${cx} ${cy + ry * 1.15} ${cx + rx * 0.85} ${cy + ry * 0.5}"
      stroke="#000" stroke-width="2.4" fill="none" opacity="0.5"/>
  </g>`;
}

/* ---------- 3. 裂纹：锯齿折线 ---------- */
function crack(x0, y0, x1, y1, jag, n) {
  const seg = [[x0, y0]];
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const px = x0 + (x1 - x0) * t + (rand() - 0.5) * jag;
    const py = y0 + (y1 - y0) * t + (rand() - 0.5) * jag * 0.7;
    seg.push([px, py]);
  }
  seg.push([x1, y1]);
  return 'M ' + seg.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L ');
}

const cracks = [
  crack(230, 178, 286, 322, 30, 7),
  crack(310, 216, 336, 372, 26, 7),
  crack(196, 288, 250, 398, 22, 6),
  crack(276, 322, 344, 298, 20, 4),
  crack(258, 210, 272, 288, 14, 5),
];

/* 星空点 */
const stars = [];
for (let i = 0; i < 70; i++) {
  const x = rand() * W, y = rand() * (H * 0.6 + 40);
  const r = 0.35 + rand() * 0.9;
  const o = 0.1 + rand() * 0.4;
  stars.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}" fill="#cdd8f5" opacity="${o.toFixed(2)}"/>`);
}

/* 尘粒 */
const dust = [];
for (let i = 0; i < 16; i++) {
  const x = 130 + rand() * 260, y = 170 + rand() * 230;
  const r = 0.6 + rand() * 1.2;
  const c = ['#a8e8d8', '#b6a8ec', '#e8c88a'][Math.floor(rand() * 3)];
  dust.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}" fill="${c}" opacity="${(0.2 + rand() * 0.35).toFixed(2)}"/>`);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <radialGradient id="bg" cx="50%" cy="40%" r="75%">
    <stop offset="0%" stop-color="#191524"/>
    <stop offset="55%" stop-color="#0d0a16"/>
    <stop offset="100%" stop-color="#040306"/>
  </radialGradient>
  <radialGradient id="rock" cx="36%" cy="26%" r="95%">
    <stop offset="0%" stop-color="#3c3c42"/>
    <stop offset="40%" stop-color="#26262c"/>
    <stop offset="75%" stop-color="#141419"/>
    <stop offset="100%" stop-color="#08080b"/>
  </radialGradient>
  <linearGradient id="fusion" x1="0.1" y1="0" x2="0.7" y2="1">
    <stop offset="0%" stop-color="#4a463c" stop-opacity="0.75"/>
    <stop offset="100%" stop-color="#17171c" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="aurora" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#59e2c2"/>
    <stop offset="35%" stop-color="#8b7cf6"/>
    <stop offset="70%" stop-color="#d883d8"/>
    <stop offset="100%" stop-color="#ecc46e"/>
  </linearGradient>
  <radialGradient id="halo" cx="50%" cy="50%" r="50%">
    <stop offset="0%" stop-color="#958cff" stop-opacity="0.22"/>
    <stop offset="55%" stop-color="#6c5cff" stop-opacity="0.08"/>
    <stop offset="100%" stop-color="#6c5cff" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="gem" cx="45%" cy="40%" r="65%">
    <stop offset="0%" stop-color="#eafffa" stop-opacity="0.95"/>
    <stop offset="45%" stop-color="#9fd8f6" stop-opacity="0.85"/>
    <stop offset="80%" stop-color="#a895ee" stop-opacity="0.8"/>
    <stop offset="100%" stop-color="#eecb84" stop-opacity="0.7"/>
  </radialGradient>
  <filter id="soft" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="6"/></filter>
  <filter id="soft2" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="2.4"/></filter>
  <filter id="soft4" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="0.9"/></filter>
  <filter id="rugged" x="-15%" y="-15%" width="130%" height="130%">
    <feTurbulence type="fractalNoise" baseFrequency="0.055" numOctaves="4" seed="11" result="t"/>
    <feDisplacementMap in="SourceGraphic" in2="t" scale="10" xChannelSelector="R" yChannelSelector="G"/>
  </filter>
  <filter id="tex">
    <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" seed="4" result="n"/>
    <feColorMatrix in="n" type="matrix" values="0 0 0 0 0.55  0 0 0 0 0.53  0 0 0 0 0.5  0 0 0 0.5 0"/>
    <feComposite operator="in" in2="SourceGraphic"/>
  </filter>
  <clipPath id="rockClip"><path d="${rockPath}"/></clipPath>
</defs>

<rect width="${W}" height="${H}" fill="url(#bg)"/>
${stars.join('\n')}

<!-- 台面 + 落影 -->
<ellipse cx="264" cy="426" rx="162" ry="26" fill="#000" opacity="0.55" filter="url(#soft)"/>
<ellipse cx="264" cy="422" rx="128" ry="17" fill="#231710" opacity="0.9"/>

<!-- 陨石玉光晕 -->
<circle cx="${CX}" cy="${CY}" r="185" fill="url(#halo)"/>

<!-- 陨石本体（锯齿轮廓 + 粗糙边缘） -->
<path d="${rockPath}" fill="url(#rock)" filter="url(#rugged)" stroke="#000" stroke-width="2" stroke-opacity="0.6"/>
<path d="${rockPath}" fill="url(#fusion)" filter="url(#rugged)" opacity="0.55"/>

<!-- 岩石表面颗粒肌理（clip 在轮廓内） -->
<g clip-path="url(#rockClip)" filter="url(#soft4)" opacity="0.85">
  <rect x="80" y="120" width="360" height="330" filter="url(#tex)" opacity="0.28"/>
</g>

<!-- 熔壳高光 / 暗部 -->
<g clip-path="url(#rockClip)">
  <path d="M 150 205 C 180 168 224 148 274 148 C 300 150 322 158 342 172 C 300 168 246 176 200 200 C 182 210 164 224 150 205 Z" fill="#59544a" opacity="0.5" filter="url(#soft2)"/>
  <path d="M 356 350 C 386 322 404 284 402 240 C 414 286 402 330 372 358 C 362 366 350 360 356 350 Z" fill="#000" opacity="0.5" filter="url(#soft2)"/>
</g>

<!-- 陨坑 -->
<g clip-path="url(#rockClip)">
${crater(340, 208, 19, 13, 0.85, -12)}
${crater(184, 322, 14, 10, 0.8, 20)}
${crater(296, 392, 12, 8, 0.7, 0)}
${crater(150, 262, 9, 6, 0.7, 30)}
${crater(360, 300, 8, 6, 0.65, 10)}
</g>

<!-- 七彩玉光裂纹 -->
<g filter="url(#soft)" opacity="0.4">
${cracks.map((d) => `<path d="${d}" stroke="url(#aurora)" stroke-width="7" fill="none" stroke-linejoin="round" stroke-linecap="round"/>`).join('\n')}
</g>
${cracks.map((d) => `<path d="${d}" stroke="url(#aurora)" stroke-width="2.2" fill="none" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>`).join('\n')}
<g opacity="0.6" filter="url(#soft2)">
${cracks.map((d) => `<path d="${d}" stroke="#eafff7" stroke-width="0.7" fill="none" stroke-linejoin="round" stroke-linecap="round"/>`).join('\n')}
</g>

<!-- 裂缝交点的玉光窗口 -->
<g filter="url(#soft2)" opacity="0.9">
  <path d="M 272 312 C 282 300 298 302 302 314 C 306 326 296 338 284 334 C 274 330 268 320 272 312 Z" fill="url(#gem)"/>
  <path d="M 240 190 C 250 180 264 182 266 192 C 268 202 258 210 250 206 C 242 202 236 196 240 190 Z" fill="url(#gem)" opacity="0.75"/>
</g>

${dust.join('\n')}
</svg>`;

await writeFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tmp', 'stone-t5-src.svg'), svg);

const jpg = await sharp(Buffer.from(svg), { density: 96 })
  .resize(512, 512)
  .jpeg({ quality: 84, mozjpeg: true })
  .toBuffer();

await writeFile(OUT, jpg);
console.log('OK', OUT, jpg.length, 'bytes');
