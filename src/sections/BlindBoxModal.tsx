import { useEffect, useState } from 'react';
import { subscribeBlindbox, availableFor, openBox, type BoxContent, type Who } from '../lib/blindbox';
import { itemInfo } from '../lib/farm';
import { heartRain } from '../lib/confetti';

export default function BlindBoxModal({ open, onClose, user, days, treeExp, warehouseCount, balance, dexCount, dexTotal }: {
  open: boolean;
  onClose: () => void;
  user: { name: string };
  days: number;
  treeExp: number;
  warehouseCount: number;
  balance: number;
  dexCount: number;
  dexTotal: number;
}) {
  const [, tick] = useState(0);
  const [opening, setOpening] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ label: string; content: BoxContent } | null>(null);

  useEffect(() => subscribeBlindbox(() => tick((t) => t + 1)), []);
  useEffect(() => { if (!open) { setOpening(null); setRevealed(null); } }, [open]);

  if (!open) return null;
  const who = user.name as Who;
  const boxes = availableFor(who);

  const doOpen = (id: string, label: string) => {
    setOpening(id);
    setTimeout(() => {
      const content = openBox(who, id);
      setOpening(null);
      if (content) {
        setRevealed({ label, content });
        heartRain(content.items.length > 0 ? 80 : 50);
      }
    }, 900);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(60,10,35,0.55)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}>
      <div className="w-full max-w-xs rounded-3xl p-5 shadow-2xl relative overflow-hidden"
        style={{ background: 'linear-gradient(160deg,#fff5fa,#ffe3f0)' }}
        onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} className="absolute top-3 right-3 w-7 h-7 rounded-full bg-white/70 text-gray-400 text-sm z-10">✕</button>

        {!revealed && (
          <>
            <p className="text-center text-lg font-bold mb-1" style={{ color: '#8a1f52' }}>🎁 纪念日盲盒</p>
            <p className="text-center text-[11px] text-gray-400 mb-4">每月 15 号 · 100 天 · 周年，都有惊喜</p>
            {boxes.length === 0 && (
              <p className="text-center text-xs text-gray-400 py-8">现在没有可开启的盲盒<br />下一个纪念日见 💌</p>
            )}
            <div className="space-y-2.5">
              {boxes.map((b) => (
                <div key={b.id} className="flex items-center gap-3 rounded-2xl bg-white/80 p-3 shadow-sm">
                  <span
                    className={`text-3xl ${opening === b.id ? 'animate-bounce' : ''}`}
                    style={opening === b.id ? { animationDuration: '0.3s' } : undefined}>🎁</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold truncate" style={{ color: '#8a1f52' }}>{b.label}</p>
                    <p className="text-[10px] text-gray-400">纪念日 {b.date}</p>
                  </div>
                  <button
                    disabled={opening !== null}
                    onClick={() => doOpen(b.id, b.label)}
                    className="px-3.5 py-1.5 rounded-full text-xs text-white font-medium shadow disabled:opacity-50"
                    style={{ background: 'linear-gradient(135deg,#e0487f,#c44d7d)' }}>
                    {opening === b.id ? '开启中…' : '开启'}
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {revealed && (
          <>
            <p className="text-center text-base font-bold mb-3" style={{ color: '#8a1f52' }}>{revealed.label}</p>
            <div className="rounded-2xl bg-white/85 p-4 shadow-sm mb-3 text-center">
              <p className="text-3xl font-black" style={{ color: '#d4941e' }}>+{revealed.content.coins}</p>
              <p className="text-[11px] text-gray-400 mt-0.5">时元</p>
            </div>
            {revealed.content.items.length > 0 && (
              <div className="rounded-2xl bg-white/85 p-3 shadow-sm mb-3">
                <p className="text-[11px] text-gray-400 mb-2">农场好礼（已放入仓库）</p>
                <div className="grid grid-cols-4 gap-2">
                  {revealed.content.items.map(([id, qty], i) => {
                    const info = itemInfo(id);
                    return (
                      <div key={i} className="flex flex-col items-center rounded-xl bg-pink-50/70 py-1.5">
                        <span className="text-xl">{info.emoji}</span>
                        <span className="text-[10px] text-gray-600 mt-0.5">{info.name}</span>
                        <span className="text-[10px] font-bold" style={{ color: '#c44d7d' }}>×{qty}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="rounded-2xl bg-white/85 p-3 shadow-sm mb-4">
              <p className="text-[11px] text-gray-400 mb-2">✨ 高光记录</p>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px] text-gray-600">
                <span>💞 在一起 <b style={{ color: '#c44d7d' }}>{days}</b> 天</span>
                <span>🌸 爱情树 <b style={{ color: '#c44d7d' }}>{treeExp}</b> 经验</span>
                <span>🏠 仓库 <b style={{ color: '#c44d7d' }}>{warehouseCount}</b> 件</span>
                <span>📖 图鉴 <b style={{ color: '#c44d7d' }}>{dexCount}/{dexTotal}</b></span>
                <span className="col-span-2">⏳ 时元余额 <b style={{ color: '#c44d7d' }}>{balance}</b></span>
              </div>
            </div>
            <button onClick={() => setRevealed(null)}
              className="w-full py-2.5 rounded-2xl text-white text-sm font-medium shadow"
              style={{ background: 'linear-gradient(135deg,#e0487f,#c44d7d)' }}>
              {availableFor(who).length > 0 ? '收下，继续开' : '收下 🎉'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
