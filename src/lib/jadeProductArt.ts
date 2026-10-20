/* 玉器工坊 · AI 定制成品图：
 * 打磨完成后可用豆包 Seedream（剧情工坊同款接入点，Key 存本机 localStorage）为这件成品单独生一张图，
 * 刻字 / 金属 / 绳链 / 场景 / 角度都不同，成品柜里不再"千篇一律"。
 * 同步照抄打卡地图照片的成熟方案：每件成品一条独立 retained 消息（jade/art/<成品id>），
 * 成品记录里只放 key；本机 IndexedDB 持久缓存 + 每天首连回补 + 求援频道应答，broker 清了也能自愈。
 */
import { generateImage } from './deepseek';
import { sharedPublish, sharedSubscribe, onSharedConnect } from './mqttClient';
import { markProductArt, metalById, varietyById, cordById, type JadeProduct } from './jade';

const TOPIC = 'lovesite/jade/art/';
const REQ_TOPIC = 'lovesite/jade/art/req';
const REPUSH_KEY = 'lovesite-jade-art-repush';

/* ---------- 本地缓存（内存 + IndexedDB） ---------- */
const cache = new Map<string, string>();
const pending = new Set<string>();
const listeners = new Set<() => void>();
const IDB_NAME = 'lovesite-jade-art';
const IDB_STORE = 'art';
let idbPromise: Promise<IDBDatabase | null> | null = null;

function idb(): Promise<IDBDatabase | null> {
  if (!idbPromise) {
    idbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  return idbPromise;
}

async function idbGet(id: string): Promise<string | null> {
  const db = await idb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const rq = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(id);
      rq.onsuccess = () => resolve(typeof rq.result === 'string' ? rq.result : null);
      rq.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function idbPut(id: string, data: string): Promise<void> {
  const db = await idb();
  if (!db) return;
  try { db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(data, id); } catch { /* ignore */ }
}

async function idbKeys(): Promise<string[]> {
  const db = await idb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const rq = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).getAllKeys();
      rq.onsuccess = () => resolve((rq.result as IDBValidKey[]).map(String));
      rq.onerror = () => resolve([]);
    } catch { resolve([]); }
  });
}

function notify() { listeners.forEach((f) => f()); }

/** 订阅成品图变化（立即回放缓存现值，别等下一次到达） */
export function subscribeProductArt(fn: () => void): () => void {
  start();
  listeners.add(fn);
  fn();
  return () => { listeners.delete(fn); };
}

/** 拿某件成品的 AI 图（本机没有会自动去云端/本地库找，找到后触发刷新） */
export function productArt(pid: string): string | undefined {
  const hit = cache.get(pid);
  if (hit) return hit;
  ensureProductArt(pid);
  return undefined;
}

function accept(pid: string, data: string): void {
  if (!data || !data.startsWith('data:')) return;
  if (cache.get(pid) === data) return;
  cache.set(pid, data);
  void idbPut(pid, data);
  notify();
}

function ensureProductArt(pid: string): void {
  start();
  if (cache.has(pid) || pending.has(pid)) return;
  pending.add(pid);
  void idbGet(pid).then((local) => {
    if (local) { accept(pid, local); pending.delete(pid); return; }
    sharedSubscribe(TOPIC + pid, (payload) => {
      const s = payload.toString();
      if (!s) return;
      accept(pid, s);
      pending.delete(pid);
    });
    // 云端可能已被 broker 清掉：8 秒没等到就求援（一次性信令，retain=false，
    // 否则残留的 retained 求援会让每台新上线的设备都白应答一次），持有该图的设备会补发
    setTimeout(() => { if (!cache.has(pid)) sharedPublish(REQ_TOPIC, pid, false); }, 8000);
  });
}

/** 求援应答：我本地有这张图就立刻补发 */
function answerNeed(pid: string): void {
  const cached = cache.get(pid);
  if (cached) { sharedPublish(TOPIC + pid, cached); return; }
  void idbGet(pid).then((d) => { if (d) { cache.set(pid, d); sharedPublish(TOPIC + pid, d); } });
}

/** 每天首连把本机存过的成品图全部回补云端（retained 幂等覆盖，broker 不能当可靠存储） */
let repushedOn = ''; // localStorage 不可用时的内存兜底：退化成「每连一发」就等于没去重
async function republishArts(force = false): Promise<void> {
  const today = new Date().toDateString();
  if (!force && repushedOn === today) return;
  try {
    if (!force && localStorage.getItem(REPUSH_KEY) === today) { repushedOn = today; return; }
    localStorage.setItem(REPUSH_KEY, today);
  } catch { /* ignore */ }
  repushedOn = today;
  for (const id of await idbKeys()) {
    const data = cache.get(id) ?? (await idbGet(id));
    if (data) { cache.set(id, data); sharedPublish(TOPIC + id, data); }
  }
}

let started = false;
function start(): void {
  if (started) return;
  started = true;
  sharedSubscribe(REQ_TOPIC, (payload) => {
    const id = payload.toString();
    if (id) answerNeed(id);
  });
  onSharedConnect(() => { setTimeout(() => void republishArts(), 2500); });
  setTimeout(() => void republishArts(), 3000);
}

/* ---------- 生图 ---------- */

const VARIETY_DESC: Record<string, string> = {
  marble: 'dull white-gray marble with faint veins, matte, low value',
  doudi: 'opaque pea-green jadeite, coarse bean-green texture',
  nuo: 'waxy translucent pale-green jadeite, milky glutinous texture',
  bingnuo: 'translucent icy-waxy pale-green jadeite, half see-through',
  qingshui: 'clear aqua blue-green jadeite, serene water color',
  yellow: 'warm honey-yellow jadeite, golden amber glow',
  red: 'vivid vermilion red jadeite, fiery russet tone',
  mo: 'deep ink-black jadeite with a dark green inner glow',
  violet: 'soft lavender violet jadeite, dreamy purple',
  ice: 'highly translucent icy pale-green jadeite, frost-like clarity',
  highice: 'near-glass transparency icy jadeite, brilliant inner glow',
  glass: 'flawless glass-transparent jadeite, crystal clear like a drop of water',
  emperor: 'legendary imperial emerald-green jadeite, intense saturated vivid green, glowing',
  bloodjade: 'deep blood-red jadeite, vivid crimson with a glowing molten ruby core, highly translucent',
  chixia: 'brilliant vermilion cinnabar-red jadeite with shimmering golden mineral flecks inside, like glowing sunset clouds, highly translucent',
  rainbow: 'translucent milky-white jadeite filled with vivid iridescent rainbow play-of-color, swirling aurora-like hues shimmering inside like liquid opal',
};

const TYPE_DESC: Record<string, string> = {
  bangle: 'a single perfectly smooth circular jadeite bangle standing upright',
  bracelet: 'a jadeite bead bracelet of round polished beads coiled elegantly',
  pendant: 'a round ping-an-kou lucky-donut jadeite pendant with a small bail loop',
  ring: 'a simple polished jadeite band ring standing upright',
  earrings: 'a pair of matching jadeite drop earrings with fine hooks',
  ornament: 'a small carved jadeite ornament sculpture on a tiny wooden stand',
};

/** 场景池：同一个器型换场景就换一张脸 */
const SCENES = [
  'on dark charcoal velvet with soft folds',
  'on pale ivory silk fabric with gentle ripples',
  'on a black marble slab with subtle veining',
  'on a warm walnut wood tray beside a sprig of greenery',
  'on a sunlit linen surface near a window',
  'on an icy translucent glass surface with delicate reflections',
  'on deep emerald-green silk with a luxe sheen',
  'on a weathered stone pedestal outdoors',
  'floating above a mirror-like water surface with ripples',
  'on a bed of soft white clouds of cotton with dust motes in the air',
  'on antique rice paper with a faint ink-wash landscape',
  'on rough beige clay with scattered jade pebbles',
];

const ANGLES = [
  'three-quarter view', 'top-down flat lay', 'macro close-up detail',
  'low side profile view', 'slight overhead angle', 'close hero shot with shallow depth of field',
];

const LIGHTS = [
  'soft diffused studio lighting', 'warm golden-hour rim light', 'cool moonlight glow',
  'dramatic single spotlight', 'backlit to reveal translucency',
  'bright clean daylight', 'moody low-key lighting with deep shadows', 'gentle bounce light from above',
];

function hash01(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h / 4294967296;
}
const pick = <T,>(arr: T[], seed: string): T => arr[Math.floor(hash01(seed) * arr.length) % arr.length];

/**
 * 为这件成品拼一段专属生图提示词：品种 + 器型 + 金属 + 绳链 + 刻字 + 场景/角度/光影都参与。
 * seed 默认用成品 id（每件都不同）；传 variant 再换一套场景 = 换一张图。
 */
export function productArtPrompt(p: JadeProduct, variant = 0): string {
  const variety = varietyById(p.varietyId);
  const metal = metalById(p.metalId);
  const cord = p.cordId ? cordById(p.cordId) : null;
  const seed = `${p.id}|${variant}`;
  const parts: string[] = [];

  parts.push(TYPE_DESC[p.typeId] ?? 'a polished jadeite jewelry piece');
  parts.push(`made of ${VARIETY_DESC[p.varietyId] ?? 'translucent green jadeite'}`);
  if (metal.id === 'silver') parts.push('set in sterling silver');
  if (metal.id === 'gold') parts.push('set in warm 18k gold');
  if (cord) parts.push(`on a ${cord.name === '红绳' ? 'red' : cord.name === '黑绳' ? 'black' : cord.name === '皮绳' ? 'brown leather' : cord.name === '银链' ? 'silver chain' : cord.name === '金链' ? 'gold chain' : 'white elastic'} cord`);
  if (p.engraving) parts.push(`with a tiny delicate engraving of "${p.engraving}" carved on it`);
  if (variety.rarity === '神话' || variety.rarity === '传说' || variety.rarity === '稀有') {
    parts.push('museum-grade presentation, ethereal inner glow, faint sparkle in the air');
  }
  parts.push(pick(SCENES, seed));
  parts.push(pick(ANGLES, seed + 'a'));
  parts.push(pick(LIGHTS, seed + 'l'));
  parts.push('photorealistic fine jewelry product photography, ultra detailed, crisp focus, square composition, no text, no watermark, no hands');
  return parts.join(', ');
}

/** 压到 ≤45KB 再上传，retained 消息保持轻量（和地图照片同一口径）。
 *  2026-10-10 修「单张成品图 636KB」：旧实现只降 JPEG/WebP 质量、从不缩尺寸，
 *  珠宝细节图的字节数对质量不敏感（0.75→0.35 仍可能上百 KB），循环退出后不做兜底校验，
 *  于是 636KB 的大包直接上云——它会把同一条 MQTT 连接后面所有小状态消息堵住数秒。
 *  现在：先按质量扫一遍，仍超限就**逐级降分辨率**（512→384→288→216），最后硬校验。 */
const ART_HARD_MAX = 45 * 1024;
export async function compressArt(dataUrl: string): Promise<string> {
  const img = new Image();
  const loaded = new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('图片解码失败'));
  });
  img.src = dataUrl;
  await loaded;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;
  const encodeAt = (size: number, type: string, q: number): string | null => {
    canvas.width = size;
    canvas.height = size;
    try {
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(img, 0, 0, size, size);
      return canvas.toDataURL(type, q);
    } catch {
      return null;
    }
  };
  // 尺寸逐级下探：同一尺寸内先扫质量，仍不够就缩一档再扫
  for (const size of [512, 384, 288, 216]) {
    let best: string | null = null;
    for (const q of [0.75, 0.65, 0.55, 0.45, 0.35]) {
      const out = encodeAt(size, 'image/webp', q) ?? encodeAt(size, 'image/jpeg', q);
      if (!out) continue;
      best = out;
      if (out.length <= ART_HARD_MAX) return out;
    }
    if (best && best.length <= ART_HARD_MAX) return best;
    // 该尺寸全部质量都不达标 → 用当前最优结果继续缩
    if (size === 216) return best ?? dataUrl;
  }
  return dataUrl;
}

/**
 * 保存成品的 AI 图：压缩 → 本机缓存 → 发布独立 retained 消息 → 成品记录打标（同步给对方）。
 * 返回 false = 没权限（游客 / 不是本人的成品）。
 */
export async function saveProductArt(who: string, p: JadeProduct, raw: string): Promise<boolean> {
  start();
  const small = await compressArt(raw);
  accept(p.id, small);
  sharedPublish(TOPIC + p.id, small);
  return markProductArt(who, p.id);
}

/** 生成 + 保存一步到位；出错抛给调用方提示 */
export async function generateProductArt(who: string, p: JadeProduct, variant = 0): Promise<void> {
  start();
  const raw = await generateImage(productArtPrompt(p, variant), '1024x1024');
  const ok = await saveProductArt(who, p, raw);
  if (!ok) throw new Error('这件成品不在你手上，生成不了');
}
