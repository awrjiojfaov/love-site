/* 回忆录：双人日记本。双方都能写/改/删自己的篇章，MQTT 全量同步，逐条 LWW 合并 */
import { sharedSubscribe, sharedPublish, onSharedConnect } from './mqttClient';
import { isGuestSession } from './guest';
import { isPairMember, membersKnown } from './space';

/** 清理混入的外组账号数据：篇章只保留当前空间成员写的 */
function scrubForeign(parsed: { entries?: Record<string, { author?: string }> }): number {
  if (!membersKnown() || !parsed?.entries || typeof parsed.entries !== 'object') return 0
  let removed = 0
  for (const [id, e] of Object.entries(parsed.entries)) {
    if (!isPairMember(String(e?.author ?? ''))) {
      delete parsed.entries[id]
      removed++
    }
  }
  return removed
}

export interface MemoirEntry {
  id: string;
  author: string;      // '成员A' | '成员B'
  title: string;
  content: string;
  mood: string;        // 心情 emoji
  date: string;        // YYYY-MM-DD，写日记那天，可改
  createdAt: number;
  updatedAt: number;
}

interface MemoirState {
  entries: Record<string, MemoirEntry>;
  deleted: Record<string, number>; // 删除墓碑：id -> 删除时间戳
  v: number;
}

const TOPIC = 'lovesite/memoir/state';
const BACKUP = 'lovesite-memoir-backup';
let state: MemoirState = { entries: {}, deleted: {}, v: 0 };
let lastV = 0;
let started = false;
const listeners = new Set<() => void>();

function emit() { listeners.forEach((f) => f()); }
function saveBackup() { try { localStorage.setItem(BACKUP, JSON.stringify(state)); } catch { /* ignore */ } }

/** 合并：逐条按 updatedAt 取新；删除墓碑按时间戳取新，墓碑比条目新则条目视为已删 */
function mergeState(local: MemoirState, remote: MemoirState): MemoirState {
  const deleted: Record<string, number> = { ...(local.deleted ?? {}) };
  for (const [id, ts] of Object.entries(remote.deleted ?? {})) {
    if (!deleted[id] || ts > deleted[id]) deleted[id] = ts;
  }
  const entries: Record<string, MemoirEntry> = {};
  for (const src of [remote.entries ?? {}, local.entries ?? {}]) {
    for (const [id, e] of Object.entries(src)) {
      if (deleted[id] && deleted[id] >= e.updatedAt) continue; // 已删
      if (!entries[id] || e.updatedAt > entries[id].updatedAt) entries[id] = e;
    }
  }
  return { entries, deleted, v: Math.max(local.v, remote.v) };
}

/** 两个状态的内容是否一致（忽略 v；逐记录比对，key 集合不同也算不同） */
function sameMemoirState(a: MemoirState, b: MemoirState): boolean {
  const eqRec = <T,>(x: Record<string, T>, y: Record<string, T>): boolean => {
    const kx = Object.keys(x);
    if (kx.length !== Object.keys(y).length) return false;
    return kx.every((k) => k in y && JSON.stringify(x[k]) === JSON.stringify(y[k]));
  };
  return eqRec(a.entries, b.entries) && eqRec(a.deleted ?? {}, b.deleted ?? {});
}

/** Lamport 版本：max(已见版本, 本地时钟) + 1，版本只认先后不认两台手机的时钟（jade/farm 同款修法） */
function bumpV(): number {
  lastV = Math.max(lastV, Date.now()) + 1;
  state = { ...state, v: lastV };
  return lastV;
}

function start() {
  if (started) return;
  started = true;
  try {
    const raw = localStorage.getItem(BACKUP);
    if (raw) { const b = JSON.parse(raw) as MemoirState; if (b && typeof b.v === 'number') { scrubForeign(b); state = b; lastV = b.v; } }
  } catch { /* ignore */ }
  sharedSubscribe(TOPIC, (payload) => {
    if (payload.length === 0) return;
    try {
      const s = JSON.parse(payload.toString()) as MemoirState;
      if (!s || typeof s.v !== 'number') return;
      const removedForeign = scrubForeign(s); // 外组篇章入口清掉
      // 无论版本新旧都先按内容合并（条目 updatedAt / 墓碑时间戳取新），有实际变化才采纳——
      // 旧逻辑在旧包里只看"有没有新 key"，更新的墓碑和条目编辑会被整包丢弃（jade 同款 bug）
      const merged = mergeState(state, s);
      const changed = removedForeign > 0 || !sameMemoirState(state, merged);
      state = merged;
      if (s.v > lastV) lastV = s.v;
      if (changed) {
        saveBackup();
        emit();
        bumpV(); // 升版本回发合并结果，时钟偏大的设备也能立刻收到
        sharedPublish(TOPIC, JSON.stringify(state));
      } else if (s.v < lastV) {
        sharedPublish(TOPIC, JSON.stringify({ ...state, v: lastV })); // 云端落后 → 回发自愈
      }
    } catch { /* ignore */ }
  });
  onSharedConnect(() => { /* 只读，不主动发布旧备份 */ });
}

export function subscribeMemoir(fn: () => void): () => void {
  start();
  listeners.add(fn);
  fn(); // 立即回放缓存现值
  return () => { listeners.delete(fn); };
}

function commit() {
  bumpV();
  saveBackup();
  sharedPublish(TOPIC, JSON.stringify(state));
  emit();
}

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** 全部篇章：按日记日期倒序（同日期按更新时间倒序） */
export function listMemoir(): MemoirEntry[] {
  start();
  return Object.values(state.entries).sort((a, b) =>
    a.date === b.date ? b.updatedAt - a.updatedAt : b.date.localeCompare(a.date)
  );
}

export function addEntry(
  author: string,
  draft: { title: string; content: string; mood: string; date: string },
): { ok: boolean; msg?: string } {
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' };
  start();
  const now = Date.now();
  const entry: MemoirEntry = {
    id: uid(),
    author,
    title: draft.title.trim() || '无题',
    content: draft.content.trim(),
    mood: draft.mood,
    date: draft.date,
    createdAt: now,
    updatedAt: now,
  };
  if (!entry.content) return { ok: false, msg: '写点什么再保存吧' };
  state = { ...state, entries: { ...state.entries, [entry.id]: entry } };
  commit();
  return { ok: true };
}

export function updateEntry(
  id: string,
  byWho: string,
  draft: { title: string; content: string; mood: string; date: string },
): { ok: boolean; msg?: string } {
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' };
  start();
  const cur = state.entries[id];
  if (!cur) return { ok: false, msg: '这篇日记不存在了' };
  if (cur.author !== byWho) return { ok: false, msg: '只能改自己写的篇章哦' };
  const content = draft.content.trim();
  if (!content) return { ok: false, msg: '写点什么再保存吧' };
  state = {
    ...state,
    entries: {
      ...state.entries,
      [id]: { ...cur, title: draft.title.trim() || '无题', content, mood: draft.mood, date: draft.date, updatedAt: Date.now() },
    },
  };
  commit();
  return { ok: true };
}

export function removeEntry(id: string, byWho: string): { ok: boolean; msg?: string } {
  if (isGuestSession()) return { ok: false, msg: '游客只能参观哦' };
  start();
  const cur = state.entries[id];
  if (!cur) return { ok: true };
  if (cur.author !== byWho) return { ok: false, msg: '只能删自己写的篇章哦' };
  const entries = { ...state.entries };
  delete entries[id];
  state = { ...state, entries, deleted: { ...state.deleted, [id]: Date.now() } };
  commit();
  return { ok: true };
}

/** 心情备选 */
export const MOODS = ['😊', '🥰', '😆', '😴', '😭', '😤', '🤒', '🌧️', '🌈', '✨', '🍀', '💤'];
