/* 主页悬浮小宠物：狸花猫挂件（透明 PNG，挂件含金色小环）。
 * 手绘 SVG 分层（耳朵/头/奶油下巴/狸花条纹/琥珀眼/胡须），sharp 渲染成 PNG。
 * 运行：node tools/gen_lihua_cat.mjs
 */
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets', 'pet', 'lihua-cat.png');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<defs>
<radialGradient id="fur" cx="50%" cy="36%" r="78%">
<stop offset="0%" stop-color="#a98a66"/>
<stop offset="62%" stop-color="#95754f"/>
<stop offset="100%" stop-color="#7b6141"/>
</radialGradient>
<linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
<stop offset="0%" stop-color="#f2d489"/>
<stop offset="55%" stop-color="#d9ae4f"/>
<stop offset="100%" stop-color="#a97f2c"/>
</linearGradient>
<linearGradient id="eye" x1="0" y1="0" x2="0" y2="1">
<stop offset="0%" stop-color="#f8d257"/>
<stop offset="100%" stop-color="#e0a52e"/>
</linearGradient>
</defs>

<!-- 挂件金环 -->
<circle cx="256" cy="56" r="24" fill="none" stroke="url(#gold)" stroke-width="13"/>
<circle cx="249" cy="48" r="6" fill="#ffffff" opacity="0.55"/>

<!-- 耳朵（后层） -->
<path d="M 118 216 L 100 96 L 216 148 Z" fill="#8a6d48"/>
<path d="M 136 196 L 126 124 L 196 154 Z" fill="#d9a0a6"/>
<path d="M 394 216 L 412 96 L 296 148 Z" fill="#8a6d48"/>
<path d="M 376 196 L 386 124 L 316 154 Z" fill="#d9a0a6"/>

<!-- 头 -->
<ellipse cx="256" cy="298" rx="188" ry="168" fill="url(#fur)"/>
<ellipse cx="256" cy="298" rx="188" ry="168" fill="none" stroke="#6d573b" stroke-opacity="0.35" stroke-width="6"/>

<!-- 下巴奶油区 -->
<ellipse cx="256" cy="366" rx="130" ry="96" fill="#efe3cd"/>
<ellipse cx="256" cy="428" rx="80" ry="32" fill="#f6eddc"/>

<!-- 狸花条纹：额头 M + 头顶 + 两颊 -->
<g stroke="#4c3a27" stroke-width="15" stroke-linecap="round" fill="none" opacity="0.92">
<path d="M 256 176 L 256 84"/>
<path d="M 196 178 L 176 96"/>
<path d="M 316 178 L 336 96"/>
<path d="M 156 200 Q 128 186 108 160"/>
<path d="M 356 200 Q 384 186 404 160"/>
<path d="M 132 244 Q 106 236 92 218"/>
<path d="M 380 244 Q 406 236 420 218"/>
</g>
<g stroke="#4c3a27" stroke-width="13" stroke-linecap="round" fill="none" opacity="0.55">
<path d="M 222 106 Q 238 128 224 152"/>
<path d="M 290 106 Q 274 128 288 152"/>
</g>

<!-- 眼睛 -->
<circle cx="182" cy="280" r="52" fill="url(#eye)" stroke="#5f4a30" stroke-width="5"/>
<circle cx="330" cy="280" r="52" fill="url(#eye)" stroke="#5f4a30" stroke-width="5"/>
<ellipse cx="182" cy="288" rx="22" ry="30" fill="#2e2318"/>
<ellipse cx="330" cy="288" rx="22" ry="30" fill="#2e2318"/>
<circle cx="170" cy="266" r="10" fill="#ffffff" opacity="0.9"/>
<circle cx="318" cy="266" r="10" fill="#ffffff" opacity="0.9"/>
<circle cx="196" cy="302" r="4" fill="#ffffff" opacity="0.55"/>
<circle cx="344" cy="302" r="4" fill="#ffffff" opacity="0.55"/>

<!-- 鼻子 + 嘴 -->
<path d="M 236 344 Q 256 330 276 344 Q 256 360 236 344 Z" fill="#e2949a"/>
<path d="M 256 356 L 256 374" stroke="#8a6b52" stroke-width="5" stroke-linecap="round"/>
<path d="M 256 374 Q 234 394 214 378" stroke="#8a6b52" stroke-width="5" fill="none" stroke-linecap="round"/>
<path d="M 256 374 Q 278 394 298 378" stroke="#8a6b52" stroke-width="5" fill="none" stroke-linecap="round"/>

<!-- 腮红 -->
<ellipse cx="136" cy="336" rx="26" ry="15" fill="#efb3ad" opacity="0.5"/>
<ellipse cx="376" cy="336" rx="26" ry="15" fill="#efb3ad" opacity="0.5"/>

<!-- 胡须 -->
<g stroke="#f6efdf" stroke-width="5" stroke-linecap="round" opacity="0.9" fill="none">
<path d="M 116 330 Q 74 320 44 306"/>
<path d="M 116 356 Q 72 356 40 352"/>
<path d="M 118 380 Q 76 392 48 402"/>
<path d="M 396 330 Q 438 320 468 306"/>
<path d="M 396 356 Q 440 356 472 352"/>
<path d="M 394 380 Q 436 392 464 402"/>
</g>
</svg>`;

const png = await sharp(Buffer.from(svg)).resize(512, 512).png().toBuffer();
const { writeFile, mkdir } = await import('node:fs/promises');
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, png);
console.log('written', OUT, png.length, 'bytes');
