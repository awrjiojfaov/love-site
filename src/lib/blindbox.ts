/* 纪念日盲盒：每月15号 / 100天 / 1周年，双方各自开启，MQTT 同步开启状态与内容 */
import { sharedSubscribe, sharedPublish, onSharedConnect } from './mqttClient';
import { isGuestSession } from './guest';
import { addTx } from './wallet';
import { giftItems } from './farm';
import { isPairMember, membersKnown, isDefaultSpace } from './space';
import { LOVE_START } from '../config';

/** 清理混入的外组账号数据：开启记录/盲盒内容只保留当前空间成员的 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scrubForeign(parsed: any): number {
  if (!membersKnown() || !parsed || typeof parsed !== 'object') return 0;
  let removed = 0;
  if (parsed.opened && typeof parsed.opened === 'object') {
    for (const k of Object.keys(parsed.opened)) {
      if (!isPairMember(k)) { delete parsed.opened[k]; removed++; }
    }
  }
  if (parsed.boxes && typeof parsed.boxes === 'object') {
    for (const k of Object.keys(parsed.boxes)) {
      const who = k.split(':')[0] ?? '';
      if (!isPairMember(who)) { delete parsed.boxes[k]; removed++; }
    }
  }
  return removed;
}

export type Who = string;

export interface BoxContent { coins: number; items: [string, number][] }
interface BlindboxState {
  opened: Record<string, string[]>;        // who -> milestoneId[]
  boxes: Record<string, BoxContent>;       // "who:milestoneId" -> content
  v: number;
}

const TOPIC = 'lovesite/blindbox/state';
const BACKUP = 'lovesite-blindbox-backup';
let state: BlindboxState = { opened: {}, boxes: {}, v: 0 };
let lastV = 0;
let started = false;
const listeners = new Set<() => void>();

function emit() { listeners.forEach((f) => f()); }
function saveBackup() { try { localStorage.setItem(BACKUP, JSON.stringify(state)); } catch { /* ignore */ } }

/** 合并：开启记录按人求并集，盲盒内容按 key 求并集（内容生成后不变，先到先得） */
function mergeBox(local: BlindboxState, remote: BlindboxState): BlindboxState {
  const opened: Record<string, string[]> = {};
  for (const who of new Set([...Object.keys(local.opened ?? {}), ...Object.keys(remote.opened ?? {})])) {
    opened[who] = [...new Set([...(remote.opened?.[who] ?? []), ...(local.opened?.[who] ?? [])])];
  }
  const boxes: Record<string, BoxContent> = { ...(remote.boxes ?? {}), ...(local.boxes ?? {}) };
  return { opened, boxes, v: Math.max(local.v, remote.v) };
}

/** 被版本守卫拦下的旧包里是否有本地没有的开启记录（时钟偏差兜底） */
function remoteHasExtra(local: BlindboxState, remote: BlindboxState): boolean {
  for (const [who, ids] of Object.entries(remote.opened ?? {})) {
    const mine = new Set(local.opened?.[who] ?? []);
    if (ids.some((id) => !mine.has(id))) return true;
  }
  return Object.keys(remote.boxes ?? {}).some((k) => !(k in (local.boxes ?? {})));
}

function start() {
  if (started) return;
  started = true;
  // 新建账号组：纪念日盲盒停用（里程碑日期是写死的，新组一上来就有盒子 + 天数也对不上，容易出 bug）
  if (!isDefaultSpace()) return;
  try {
    const raw = localStorage.getItem(BACKUP);
    if (raw) { const b = JSON.parse(raw) as BlindboxState; if (b && typeof b.v === 'number') { scrubForeign(b); state = b; lastV = b.v; } }
  } catch { /* ignore */ }
  sharedSubscribe(TOPIC, (payload) => {
    if (payload.length === 0) return;
    try {
      const s = JSON.parse(payload.toString()) as BlindboxState;
      if (!s || typeof s.v !== 'number') return;
      const removedForeign = scrubForeign(s); // 外组开启记录入口清掉
      if (s.v <= lastV) {
        // 时钟偏差兜底：旧版本号里若夹着本地没有的开启记录，照样合并
        if (remoteHasExtra(state, s)) {
          state = mergeBox(state, s);
          saveBackup();
          emit();
        }
        if (removedForeign > 0) {
          state = { ...state, v: Date.now() };
          lastV = state.v;
          saveBackup();
          sharedPublish(TOPIC, JSON.stringify(state)); // 回发清理后的状态（升版本防止脏 retained 回魂）
        } else if (s.v < lastV) {
          // 云端落后于本地（代理丢数据）→ 回发自愈
          sharedPublish(TOPIC, JSON.stringify({ ...state, v: lastV }));
        }
        return;
      }
      lastV = s.v;
      const localExtra = remoteHasExtra(s, state);
      state = mergeBox(state, s);
      saveBackup();
      emit();
      if (localExtra || removedForeign > 0) sharedPublish(TOPIC, JSON.stringify({ ...state, v: lastV })); // 反熵回发/清理回发
    } catch { /* ignore */ }
  });
  onSharedConnect(() => { /* 只读，不主动发布旧备份 */ });
}

export function subscribeBlindbox(fn: () => void): () => void {
  start();
  listeners.add(fn);
  fn(); // 立即回放缓存现值（富贵值 0 事故同款：不回放就只等下一次发布）
  return () => { listeners.delete(fn); };
}

function commit() {
  state = { ...state, v: Date.now() };
  lastV = state.v;
  saveBackup();
  sharedPublish(TOPIC, JSON.stringify(state));
  emit();
}

/* ---------- 里程碑 ---------- */
export interface Milestone { id: string; label: string; date: string } // date: YYYY-MM-DD

const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 纪念日盲盒里程碑：全部从「在一起的起始时刻」（配置 VITE_LOVE_START）推导。
 *  未配置起始时刻 → 返回空列表，盲盒整体停用。 */
export function allMilestones(now = new Date()): Milestone[] {
  // 总闸：新建账号组直接没有里程碑 → availableFor 为空、openBox 找不到 m 自然失败
  if (!isDefaultSpace()) return [];
  if (!LOVE_START) return [];
  const s = new Date(LOVE_START);
  const day = s.getDate();
  const list: Milestone[] = [];
  // 每月纪念盲盒：从起始月的次月起，每月同一日
  const first = new Date(s.getFullYear(), s.getMonth() + 1, day);
  for (let i = 0; i < 600; i++) {
    const d = new Date(first.getFullYear(), first.getMonth() + i, day);
    if (d > now) break;
    list.push({ id: `m${d.getFullYear()}-${d.getMonth() + 1}`, label: `${d.getMonth() + 1} 月纪念盲盒`, date: fmt(d) });
  }
  const d100 = new Date(LOVE_START + 100 * 86400000); // 在一起 100 天
  if (d100 <= now) list.push({ id: 'd100', label: '百日纪念盲盒 💯', date: fmt(d100) });
  const y1 = new Date(s.getFullYear() + 1, s.getMonth(), day); // 一周年
  if (y1 <= now) list.push({ id: 'y1', label: '周年典藏盲盒 💍', date: fmt(y1) });
  return list.sort((a, b) => a.date.localeCompare(b.date));
}

export function availableFor(who: Who, now = new Date()): Milestone[] {
  start();
  const opened = state.opened[who] ?? [];
  return allMilestones(now).filter((m) => !opened.includes(m.id));
}

/* ---------- 内容生成 ---------- */
// 普通作物/鱼（低价值，cost≤20）
const COMMON_ITEMS: [string, number][] = [
  ['corn', 4], ['carrot', 3], ['tomato', 3], ['strawberry', 5],
  ['rose', 7], ['sakura', 9], ['goldfish', 3], ['bitterling', 5],
  ['mandarinfish', 6], ['koi', 9],
];
// 一阶合成物（价值中等）
const R1_ITEMS: [string, number][] = [
  ['r1', 26], ['r5', 36], ['r10', 18], ['r15', 70], ['r18', 28], ['r28', 32], ['r36', 22], ['r44', 32], ['r52', 28],
];
// 二阶合成物（高价值）
const R2_ITEMS: [string, number][] = [
  ['r55', 66], ['r58', 44], ['r62', 56], ['r66', 58], ['r65', 108], ['r74', 44], ['r77', 52],
];
const RARE_FISH: [string, number][] = [
  ['grouper', 24], ['tuna', 30], ['ray', 40],
];

const rnd = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
function pick<T>(arr: T[], n: number): T[] {
  const a = [...arr]; const out: T[] = [];
  while (a.length && out.length < n) out.push(a.splice(Math.floor(Math.random() * a.length), 1)[0]);
  return out;
}

function genContent(milestoneId: string): BoxContent {
  if (milestoneId === 'y1') {
    const items: [string, number][] = pick(R2_ITEMS, 2).map(([id]) => [id, 1] as [string, number]);
    items.push(...pick(RARE_FISH, 2).map(([id]) => [id, rnd(2, 3)] as [string, number]));
    items.push(...pick(COMMON_ITEMS, 4).map(([id]) => [id, rnd(3, 8)] as [string, number]));
    return { coins: rnd(4500, 6000), items };
  }
  if (milestoneId === 'd100') {
    const items: [string, number][] = pick(R1_ITEMS, rnd(2, 3)).map(([id]) => [id, 1] as [string, number]);
    items.push(...pick(COMMON_ITEMS, rnd(4, 6)).map(([id]) => [id, rnd(2, 4)] as [string, number]));
    return { coins: rnd(2000, 2800), items };
  }
  // 月度
  const items: [string, number][] = pick(COMMON_ITEMS, rnd(4, 6)).map(([id]) => [id, rnd(1, 3)] as [string, number]);
  return { coins: rnd(400, 700), items };
}

/* ---------- 开启：先标记，后发奖 ---------- */
export function openBox(who: Who, milestoneId: string): BoxContent | null {
  if (isGuestSession()) return null
  if (!isDefaultSpace()) return null // 新建账号组：不发纪念日盲盒
  start();
  const opened = state.opened[who] ?? [];
  if (opened.includes(milestoneId)) return null;
  const m = allMilestones().find((x) => x.id === milestoneId);
  if (!m) return null;
  const key = `${who}:${milestoneId}`;
  const content = state.boxes[key] ?? genContent(milestoneId);
  // 先持久化 opened + content
  state = {
    ...state,
    opened: { ...state.opened, [who]: [...opened, milestoneId] },
    boxes: { ...state.boxes, [key]: content },
  };
  commit();
  // 再发奖
  try { giftItems(who, content.items); } catch { /* ignore */ }
  try { addTx(who, content.coins, `盲盒·${m.label}`); } catch { /* ignore */ }
  return content;
}
