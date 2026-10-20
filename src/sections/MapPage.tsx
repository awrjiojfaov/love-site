import { useEffect, useRef, useState, type ReactNode } from 'react';
import { loadChinaMap, loadProvinceMap, type GeoMap } from '../lib/geo';
import {
  subscribeMap, recordsFor, countsByProvince, countsByCity,
  saveRecord, deleteRecord, resolvePhotos, photoUrl, type PlaceRecord,
} from '../lib/mapStore';

/* ---------- 照片压缩：≤640px webp ---------- */
async function compressPhoto(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 640 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  cv.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
  return cv.toDataURL('image/webp', 0.65);
}

/* 省份颜色：按打卡数由浅到深 */
function provFill(count: number, max: number): string {
  if (count <= 0 || max <= 0) return '#ffe9f3';
  const t = Math.min(1, count / Math.max(3, max));
  const from = [255, 183, 213], to = [214, 51, 122];
  const c = from.map((f, i) => Math.round(f + (to[i] - f) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/* 名称简写：新疆维吾尔自治区→新疆、无锡市→无锡 */
function shortName(name: string): string {
  return name
    .replace(/(维吾尔|壮族|回族)?自治区$/, '')
    .replace(/特别行政区$/, '')
    .replace(/[省市]$/, '');
}

/* 标签可读性：底色浅 → 深紫字 + 白光晕；底色深（已打卡）→ 白字 + 深紫光晕。
   地图填充色全是粉色系，单靠字体颜色必然撞色，光晕才是正解 */
function mapLabelProps(count: number): Record<string, string | number> {
  return count > 0
    ? { fill: '#ffffff', stroke: '#8a1f52', strokeWidth: 3, paintOrder: 'stroke', strokeLinejoin: 'round', fontWeight: 'bold' }
    : { fill: '#5f3547', stroke: 'rgba(255,255,255,0.92)', strokeWidth: 3, paintOrder: 'stroke', strokeLinejoin: 'round' };
}

/* 全国图拥挤省份的标签偏移（viewBox 单位，W=1000） */
const CN_LABEL_OFFSET: Record<number, [number, number]> = {
  110000: [-8, -20],  // 北京 ↑
  120000: [22, 14],   // 天津 →↓
  130000: [4, 44],    // 河北 ↓ 挪到南部平原（避开山西/京津/山东）
  140000: [-6, -4],   // 山西 略偏西，远离河北新位置
  310000: [26, 8],    // 上海 →
  320000: [4, -14],   // 江苏 ↑
  340000: [-12, -6],  // 安徽 ←
  500000: [-18, -4],  // 重庆 ←
  440000: [-4, -18],  // 广东 ↑（让出港澳）
  810000: [20, 12],   // 香港 →↓
  820000: [-20, 12],  // 澳门 ←↓
  450000: [-8, 12],   // 广西 ↓
  370000: [6, -10],   // 山东 ↑
};

/* 地图顺时针旋转 90°：横握手机查看，地图放大、标签不再重合。
   外层宽高比 = H/W（旋转后的视觉比例），内层尺寸对调后 rotate(90deg) 居中，
   SVG 内部坐标不受影响，点击省份照常命中 */
function RotatedMap({ geo, children }: { geo: GeoMap; children: ReactNode }) {
  return (
    <div
      className="relative w-full select-none"
      style={{ aspectRatio: `${geo.height} / ${geo.width}`, touchAction: 'manipulation' }}
    >
      <div
        className="absolute left-1/2 top-1/2"
        style={{
          width: `${(100 * geo.width) / geo.height}%`,
          height: `${(100 * geo.height) / geo.width}%`,
          transform: 'translate(-50%, -50%) rotate(90deg)',
        }}
      >
        <svg viewBox={geo.viewBox} className="h-full w-full">
          {children}
        </svg>
      </div>
    </div>
  );
}

type View =
  | { kind: 'china' }
  | { kind: 'province'; adcode: number; name: string }
  | { kind: 'city'; provAdcode: number; provName: string; adcode: number; name: string };

export default function MapPage({ user, onBack }: { user: { name: string }; onBack: () => void }) {
  const [view, setView] = useState<View>({ kind: 'china' });
  const [china, setChina] = useState<GeoMap | null>(null);
  const [prov, setProv] = useState<GeoMap | null>(null);
  const [places, setPlaces] = useState<Record<string, PlaceRecord[]>>({});
  const [loadErr, setLoadErr] = useState(false);
  const [editing, setEditing] = useState<PlaceRecord | 'new' | null>(null);
  // 大图查看器：{ 这一组照片, 起始张, 标题 }
  const [viewer, setViewer] = useState<{ photos: string[]; index: number; title: string } | null>(null);
  const provCache = useRef<Record<number, GeoMap>>({});

  useEffect(() => {
    const un = subscribeMap((p) => setPlaces(p));
    loadChinaMap().then(setChina).catch(() => setLoadErr(true));
    return un;
  }, []);

  const openProvince = async (adcode: number, name: string) => {
    try {
      if (!provCache.current[adcode]) provCache.current[adcode] = await loadProvinceMap(adcode);
      setProv(provCache.current[adcode]);
      setView({ kind: 'province', adcode, name });
    } catch {
      alert(`「${name}」暂无更细的市级数据哦`);
    }
  };
  const openCity = (adcode: number, name: string) => {
    if (view.kind !== 'province') return;
    setView({ kind: 'city', provAdcode: view.adcode, provName: view.name, adcode, name });
  };

  const provCounts = countsByProvince(places);
  const maxProv = Math.max(0, ...Object.values(provCounts));

  /* ================= 中国地图视图 ================= */
  const renderChina = () => (
    <div className="px-1 pt-2">
      {!china && !loadErr && <p className="text-center text-xs text-gray-400 py-20">地图加载中…</p>}
      {loadErr && (
        <div className="text-center py-20">
          <p className="text-sm text-gray-500 mb-3">地图加载失败</p>
          <button onClick={() => { setLoadErr(false); loadChinaMap().then(setChina).catch(() => setLoadErr(true)); }}
            className="px-4 py-1.5 rounded-full text-xs text-white" style={{ background: '#c44d7d' }}>点我重试</button>
        </div>
      )}
      {china && (
        <RotatedMap geo={china}>
          {/* 十段线插图框 */}
          {china.inset && (
            <rect x={china.inset.x - 8} y={china.inset.y - 8} width={china.inset.w + 16} height={china.inset.h + 16}
              rx={10} fill="rgba(255,255,255,0.45)" stroke="#e9a8c6" strokeWidth={1} strokeDasharray="4 3" />
          )}
          {/* 第一遍：所有省份板块（互不遮挡） */}
          {china.features.map((f) => {
            const isNum = typeof f.adcode === 'number';
            const c = isNum ? (provCounts[f.adcode as number] ?? 0) : 0;
            return (
              <path key={String(f.adcode)} d={f.path}
                fill={isNum ? provFill(c, maxProv) : 'none'}
                stroke={isNum ? '#fff' : '#e9a8c6'} strokeWidth={1.4} strokeLinejoin="round"
                strokeDasharray={isNum ? undefined : '4 3'}
                onClick={isNum ? () => openProvince(f.adcode as number, f.name) : undefined}
                className={isNum ? 'cursor-pointer' : 'pointer-events-none'} />
            );
          })}
          {/* 第二遍：所有标签 + 角标，统一画在最上层，绝不会被板块挡住 */}
          {china.features.map((f) => {
            if (typeof f.adcode !== 'number') return null;
            const off = CN_LABEL_OFFSET[f.adcode] ?? [0, 0];
            const c = provCounts[f.adcode] ?? 0;
            return (
              <g key={`lb${f.adcode}`} pointerEvents="none">
                {c > 0 && (
                  <>
                    <circle cx={f.label[0] + off[0] + 11} cy={f.label[1] + off[1] - 11} r={12} fill="#c44d7d" stroke="#fff" strokeWidth={1.5} />
                    <text x={f.label[0] + off[0] + 11} y={f.label[1] + off[1] - 7} textAnchor="middle" fontSize={13} fill="#fff" fontWeight="bold">{c}</text>
                  </>
                )}
                <text x={f.label[0] + off[0]} y={f.label[1] + off[1]} textAnchor="middle" fontSize={16}
                  {...mapLabelProps(c)}>{shortName(f.name)}</text>
              </g>
            );
          })}
        </RotatedMap>
      )}
    </div>
  );

  /* ================= 省份视图 ================= */
  const renderProvince = () => {
    if (view.kind !== 'province') return null;
    const cityCounts = countsByCity(places);
    const maxCity = Math.max(0, ...Object.values(cityCounts));
    return (
      <div className="px-1 pt-2">
        {!prov && <p className="text-center text-xs text-gray-400 py-20">加载中…</p>}
        {prov && prov.features.length === 0 && (
          <p className="text-center text-sm text-gray-400 py-20">{view.name} 暂无可下钻的城市</p>
        )}
        {prov && (
          <RotatedMap geo={prov}>
            {/* 第一遍：板块 */}
            {prov.features.map((f) => {
              const c = cityCounts[f.adcode as number] ?? 0;
              return (
                <path key={String(f.adcode)} d={f.path}
                  fill={provFill(c, maxCity)} stroke="#fff" strokeWidth={1.5} strokeLinejoin="round"
                  onClick={() => openCity(f.adcode as number, f.name)} className="cursor-pointer" />
              );
            })}
            {/* 第二遍：标签最上层 */}
            {prov.features.map((f) => {
              const c = cityCounts[f.adcode as number] ?? 0;
              return (
                <g key={`lb${f.adcode}`} pointerEvents="none">
                  {c > 0 && (
                    <>
                      <circle cx={f.label[0] + 9} cy={f.label[1] - 9} r={10} fill="#c44d7d" stroke="#fff" strokeWidth={1.5} />
                      <text x={f.label[0] + 9} y={f.label[1] - 5.5} textAnchor="middle" fontSize={11} fill="#fff" fontWeight="bold">{c}</text>
                    </>
                  )}
                  <text x={f.label[0]} y={f.label[1]} textAnchor="middle" fontSize={16}
                    {...mapLabelProps(c)}>{shortName(f.name)}</text>
                </g>
              );
            })}
          </RotatedMap>
        )}
      </div>
    );
  };

  /* ================= 城市记录视图 ================= */
  const renderCity = () => {
    if (view.kind !== 'city') return null;
    const recs = [...recordsFor(places, view.adcode)].sort((a, b) => {
      // 按游玩日期倒序（最新出游排最前），没填日期的按记录时间
      const da = a.visitDate ?? new Date(a.updatedAt).toISOString().slice(0, 10);
      const db = b.visitDate ?? new Date(b.updatedAt).toISOString().slice(0, 10);
      return db.localeCompare(da) || b.updatedAt - a.updatedAt;
    });
    return (
      <div className="px-3 pt-2 pb-6">
        {recs.length === 0 && <p className="text-center text-xs text-gray-400 py-12">还没有打卡，留下第一条回忆吧 📍</p>}
        <div className="space-y-3">
          {recs.map((r) => (
            <div key={r.id} className="rounded-2xl bg-white/80 p-3 shadow-sm">
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold" style={{ color: '#8a1f52' }}>{r.title}</p>
                <div className="flex gap-2">
                  <button onClick={() => setEditing(r)} className="text-[11px] text-gray-400">编辑</button>
                  <button onClick={() => { if (confirm(`删除「${r.title}」？`)) deleteRecord(view.adcode, r.id); }}
                    className="text-[11px] text-red-300">删除</button>
                </div>
              </div>
              {r.photos.length > 0 && (
                <div className="flex gap-2 mt-2 overflow-x-auto">
                  {resolvePhotos(r).map((p, i) => (
                    <img key={i} src={p} alt="" onClick={() => setViewer({ photos: resolvePhotos(r), index: i, title: r.title })}
                      className="w-24 h-24 object-cover rounded-xl flex-shrink-0 cursor-pointer active:opacity-80" />
                  ))}
                </div>
              )}
              {r.text && <p className="text-xs text-gray-600 mt-2 whitespace-pre-wrap leading-relaxed">{r.text}</p>}
              <p className="text-[10px] text-gray-400 mt-2">
                {r.visitDate && <span className="font-medium" style={{ color: '#c44d7d' }}>📅 {r.visitDate} · </span>}
                {r.by} 记于 {new Date(r.updatedAt).toLocaleDateString('zh-CN')}
              </p>
            </div>
          ))}
        </div>
        <button onClick={() => setEditing('new')}
          className="w-full mt-4 py-2.5 rounded-2xl text-white text-sm font-medium shadow"
          style={{ background: 'linear-gradient(135deg,#e0487f,#c44d7d)' }}>
          ＋ 添加打卡
        </button>
      </div>
    );
  };

  /* ================= 编辑表单 ================= */
  const renderEditor = () => {
    if (view.kind !== 'city' || editing === null) return null;
    return (
      <RecordEditor
        initial={editing === 'new' ? null : editing}
        by={user.name}
        onCancel={() => setEditing(null)}
        onSave={(title, text, photos, visitDate) => {
          const base: PlaceRecord = editing === 'new'
            ? { id: `p${Date.now()}`, title: '', text: '', photos: [], by: user.name, updatedAt: Date.now() }
            : editing;
          const res = saveRecord(user.name, view.adcode, { ...base, title, text, photos, visitDate, by: user.name, updatedAt: Date.now() });
          if (!res.ok) alert(res.msg);
          else setEditing(null);
        }}
      />
    );
  };

  const title =
    view.kind === 'china' ? '打卡地图' :
    view.kind === 'province' ? view.name : view.name;

  return (
    <div className="min-h-screen pb-8" style={{ background: 'linear-gradient(180deg,#fff0f6 0%,#ffe3ef 45%,#ffd6e8 100%)' }}>
      <div className="sticky top-0 z-10 flex items-center gap-2 px-3 py-3"
        style={{ background: 'rgba(255,240,246,0.9)', backdropFilter: 'blur(8px)' }}>
        <button
          onClick={() => {
            if (editing !== null) { setEditing(null); return; }
            if (view.kind === 'city') { setView({ kind: 'province', adcode: view.provAdcode, name: view.provName }); setProv(provCache.current[view.provAdcode] ?? null); return; }
            if (view.kind === 'province') { setView({ kind: 'china' }); return; }
            onBack();
          }}
          className="w-8 h-8 rounded-full bg-white/70 flex items-center justify-center text-sm shadow-sm"
          style={{ color: '#c44d7d' }}>‹</button>
        <h1 className="text-base font-bold" style={{ color: '#8a1f52' }}>
          {title}{view.kind !== 'china' && ' · 打卡地图'}
        </h1>
      </div>
      {editing !== null ? renderEditor() : view.kind === 'china' ? renderChina() : view.kind === 'province' ? renderProvince() : renderCity()}
      {viewer && (
        <PhotoViewer
          photos={viewer.photos}
          initial={viewer.index}
          title={viewer.title}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
}

/* ================= 大图查看器：点击放大 · 左右滑动翻页 · 点空白关闭 ================= */
function PhotoViewer({ photos, initial, title, onClose }: {
  photos: string[];
  initial: number;
  title: string;
  onClose: () => void;
}) {
  const [i, setI] = useState(initial);
  const touchX = useRef<number | null>(null);
  const prev = () => setI((v) => (v - 1 + photos.length) % photos.length);
  const next = () => setI((v) => (v + 1) % photos.length);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/95"
      onClick={onClose}
      onTouchStart={(e) => { touchX.current = e.touches[0].clientX; }}
      onTouchEnd={(e) => {
        if (touchX.current == null) return;
        const dx = e.changedTouches[0].clientX - touchX.current;
        touchX.current = null;
        if (dx > 50) prev();
        else if (dx < -50) next();
      }}
    >
      {/* 顶栏：标题 + 页码 + 关闭 */}
      <div className="flex items-center justify-between px-4 py-3" onClick={(e) => e.stopPropagation()}>
        <p className="text-sm font-medium text-white/90 truncate">{title}</p>
        <div className="flex items-center gap-3">
          {photos.length > 1 && <span className="text-xs text-white/60 tabular-nums">{i + 1} / {photos.length}</span>}
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-white/15 text-white text-sm flex items-center justify-center">✕</button>
        </div>
      </div>
      {/* 大图 */}
      <div className="relative flex-1 flex items-center justify-center overflow-hidden px-2">
        <img src={photos[i]} alt="" onClick={(e) => e.stopPropagation()}
          className="max-w-full max-h-full object-contain rounded-lg select-none" draggable={false} />
        {photos.length > 1 && (
          <>
            <button onClick={(e) => { e.stopPropagation(); prev(); }}
              className="absolute left-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-white/15 text-white text-lg flex items-center justify-center">‹</button>
            <button onClick={(e) => { e.stopPropagation(); next(); }}
              className="absolute right-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-white/15 text-white text-lg flex items-center justify-center">›</button>
          </>
        )}
      </div>
      {/* 底部圆点 */}
      {photos.length > 1 && (
        <div className="flex justify-center gap-1.5 pb-6" onClick={(e) => e.stopPropagation()}>
          {photos.map((_, j) => (
            <span key={j} className={`h-1.5 rounded-full transition-all ${j === i ? 'w-4 bg-white' : 'w-1.5 bg-white/40'}`} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ================= 记录编辑表单组件 ================= */
function RecordEditor({ initial, by, onSave, onCancel }: {
  initial: PlaceRecord | null;
  by: string;
  onSave: (title: string, text: string, photos: string[], visitDate: string) => void;
  onCancel: () => void;
}) {
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const [title, setTitle] = useState(initial?.title ?? '');
  const [text, setText] = useState(initial?.text ?? '');
  const [photos, setPhotos] = useState<string[]>(initial?.photos ?? []);
  const [visitDate, setVisitDate] = useState(initial?.visitDate ?? today());
  const [busy, setBusy] = useState(false);
  void by;

  const pickPhotos = async (files: FileList | null) => {
    if (!files) return;
    setBusy(true);
    try {
      const next = [...photos];
      for (const f of Array.from(files)) {
        if (next.length >= 3) break;
        next.push(await compressPhoto(f));
      }
      setPhotos(next);
    } finally { setBusy(false); }
  };

  return (
    <div className="px-3 pt-2 pb-6">
      <div className="rounded-2xl bg-white/85 p-4 shadow-sm space-y-3">
        <div>
          <p className="text-[11px] text-gray-400 mb-1">地点 / 店名</p>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="比如：张三烧烤"
            className="w-full rounded-xl border border-pink-100 px-3 py-2 text-sm outline-none focus:border-pink-300 bg-white" />
        </div>
        <div>
          <p className="text-[11px] text-gray-400 mb-1">照片（最多 3 张）</p>
          <div className="flex gap-2 flex-wrap">
            {photos.map((p, i) => (
              <div key={i} className="relative">
                {photoUrl(p) ? (
                  <img src={photoUrl(p)} alt="" className="w-20 h-20 object-cover rounded-xl" />
                ) : (
                  <div className="w-20 h-20 rounded-xl bg-pink-50 flex items-center justify-center text-pink-200 text-xs">加载中</div>
                )}
                <button onClick={() => setPhotos(photos.filter((_, j) => j !== i))}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-black/60 text-white text-[10px]">✕</button>
              </div>
            ))}
            {photos.length < 3 && (
              <label className="w-20 h-20 rounded-xl border-2 border-dashed border-pink-200 flex items-center justify-center text-pink-300 text-xl cursor-pointer">
                {busy ? '…' : '＋'}
                <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => pickPhotos(e.target.files)} />
              </label>
            )}
          </div>
        </div>
        <div>
          <p className="text-[11px] text-gray-400 mb-1">游玩日期（补记就选实际去的那天）</p>
          <input type="date" value={visitDate} onChange={(e) => setVisitDate(e.target.value)}
            className="w-full rounded-xl border border-pink-100 px-3 py-2 text-sm outline-none focus:border-pink-300 bg-white" />
        </div>
        <div>
          <p className="text-[11px] text-gray-400 mb-1">评价 / 回忆</p>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5}
            placeholder="这家店怎么样？那天发生了什么…"
            className="w-full rounded-xl border border-pink-100 px-3 py-2 text-sm outline-none focus:border-pink-300 bg-white resize-none" />
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={onCancel} className="flex-1 py-2.5 rounded-2xl text-sm text-gray-500 bg-gray-100">取消</button>
          <button
            onClick={() => { if (!title.trim()) { alert('写个地点名吧'); return; } onSave(title.trim(), text.trim(), photos, visitDate); }}
            className="flex-1 py-2.5 rounded-2xl text-sm text-white font-medium shadow"
            style={{ background: 'linear-gradient(135deg,#e0487f,#c44d7d)' }}>保存</button>
        </div>
      </div>
    </div>
  );
}
