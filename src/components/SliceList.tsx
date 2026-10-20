/* 长列表「分批展示」通用件：玉石/拍品一多，一路下拉很费时间。
 * 一次先给 STEP 条，点一下多给 STEP 条；列表变短（卖掉/合成掉）时自动收敛回一屏。
 * 翡翠页（浅色）和拍卖页（深色）共用，靠 tone 切换配色。
 */
import { useEffect, useState } from 'react';

export const LIST_STEP = 8;

/** 分批展示的状态：shown 是当前显示条数，more 再放一批，all 一键全开，reset 收回一屏 */
export function useSlice(count: number, step = LIST_STEP) {
  const [n, setN] = useState(step);
  // 列表变短时把上限收回来（保持「余量不超过一屏」；也不重置成 0 以避免同步抖动导致列表闪烁）
  useEffect(() => {
    setN((cur) => (count <= step ? step : Math.min(Math.max(cur, step), count)));
  }, [count, step]);
  return {
    shown: Math.min(n, count),
    hasMore: n < count,
    more: () => setN((cur) => Math.min(count, cur + step)),
    all: () => setN(count),
    reset: () => setN(step),
  };
}

type Tone = 'light' | 'dark';

const TONE: Record<Tone, { bar: string; text: string; more: string; ghost: string }> = {
  light: {
    bar: 'bg-white/70 shadow-sm ring-1 ring-emerald-100',
    text: 'text-emerald-500',
    more: 'bg-emerald-500 text-white shadow',
    ghost: 'bg-emerald-50 text-emerald-600 shadow-sm',
  },
  dark: {
    bar: 'bg-white/5 ring-1 ring-white/10',
    text: 'text-amber-200/60',
    more: 'bg-amber-300 text-[#0d231c] shadow',
    ghost: 'bg-white/10 text-amber-100',
  },
};

/**
 * 长列表底部的「再看 N 条 / 一键展开 / 收起」控制条。
 * 只有超过一屏（> STEP）时才出现，短列表完全不受影响。
 */
export function ListMoreBar({ shown, total, hasMore, onMore, onAll, onCollapse, label = '项', tone = 'light' }: {
  shown: number; total: number; hasMore: boolean;
  onMore: () => void; onAll: () => void; onCollapse: () => void;
  label?: string; tone?: Tone;
}) {
  if (total <= LIST_STEP) return null;
  const c = TONE[tone];
  return (
    <div className={`flex items-center gap-2 rounded-2xl px-3 py-2 ${c.bar}`}>
      <span className={`min-w-0 flex-1 truncate text-[11px] ${c.text}`}>
        共 {total} {label} · 已显示 {shown}
      </span>
      {hasMore ? (
        <>
          <button onClick={onMore}
            className={`shrink-0 rounded-full px-3 py-1.5 text-[11px] font-bold active:scale-95 ${c.more}`}>
            再看 {Math.min(LIST_STEP, total - shown)} 条
          </button>
          <button onClick={onAll}
            className={`shrink-0 rounded-full px-3 py-1.5 text-[11px] font-bold active:scale-95 ${c.ghost}`}>
            一键展开 ⇣
          </button>
        </>
      ) : (
        <button onClick={onCollapse}
          className={`shrink-0 rounded-full px-3 py-1.5 text-[11px] font-bold active:scale-95 ${c.ghost}`}>
          收起 ⇡
        </button>
      )}
    </div>
  );
}

/**
 * 悬浮「回到顶部」：列表长了以后，翻到下面想回顶部不用一路往上滑。
 * 滚过一屏（400px）才出现，避免刚开始就挡视线。
 */
export function ScrollTopButton({ tone = 'light' }: { tone?: Tone }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 400);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  if (!show) return null;
  const c = TONE[tone];
  return (
    <button
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      aria-label="回到顶部"
      className={`fixed bottom-24 right-4 z-30 flex h-10 w-10 items-center justify-center rounded-full shadow-lg backdrop-blur active:scale-90 ${c.ghost}`}>
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.4"
        strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 19V5M5 12l7-7 7 7" />
      </svg>
    </button>
  );
}
