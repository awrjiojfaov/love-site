"""离线合成 20 块地 × 3 级土壤的成品图：
- 新土壤的颜色纹理（平面土地图）
- × 原生土地的明暗光影（枕形立体感的来源）
- ∩ 原生土地的精确轮廓（连通域 mask，羽化 1px）
另输出一张对比预览图到 tools/soil_preview.png。"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).parent
ASSETS = ROOT.parent / "src" / "assets"
OUT_DIR = ASSETS / "tiles"
OUT_DIR.mkdir(exist_ok=True)

# ============ 1. 颜色分割找 20 块地（同 refine_tiles.py） ============
im = Image.open(ASSETS / "farm-scene-portrait.webp").convert("RGB")
W, H = im.size
arr = np.array(im).astype(np.float32)
r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
samples = np.array([[133, 76, 0], [135, 79, 7], [161, 99, 15]])
dist = np.sqrt(((arr[:, :, None, :] - samples[None, None, :, :]) ** 2).sum(axis=3)).min(axis=2)
mask = (dist < 42) & (r > g) & (g > b) & (r > 90) & (r < 200) & (b < 120)

visited = np.zeros_like(mask)
blobs = []
h, w = mask.shape
for y0 in range(0, h, 4):
    for x0 in range(0, w, 4):
        if not mask[y0, x0] or visited[y0, x0]:
            continue
        seeds = np.zeros_like(mask)
        seeds[y0, x0] = True
        region = seeds & mask
        frontier = region.copy()
        while True:
            grown = frontier.copy()
            grown[1:, :] |= frontier[:-1, :]
            grown[:-1, :] |= frontier[1:, :]
            grown[:, 1:] |= frontier[:, :-1]
            grown[:, :-1] |= frontier[:, 1:]
            new = grown & mask & ~region
            if not new.any():
                break
            region |= new
            frontier = new
        visited |= region
        if region.sum() >= 8000:
            blobs.append(region)

centers = []
for reg in blobs:
    ys, xs = np.where(reg)
    centers.append((float(ys.mean()), float(xs.mean()), reg))
rows = {}
for cy, cx, reg in centers:
    rows.setdefault(int(cy // 100), []).append((cx, reg))
ordered = []
for key in sorted(rows):
    ordered.extend(reg for _, reg in sorted(rows[key], key=lambda t: t[0]))
assert len(ordered) == 20, f"expect 20 tiles, got {len(ordered)}"

# ============ 1.5 轮廓向下延伸：补上分割漏掉的深色枕形底边（碰到草地就停） ============
for reg in ordered:
    ys, xs = np.where(reg)
    for x in range(int(xs.min()), int(xs.max()) + 1):
        col = reg[:, x]
        idx = np.where(col)[0]
        if len(idx) == 0:
            continue
        bottom = int(idx.max())
        for yy in range(bottom + 1, min(bottom + 10, h)):
            rr, gg, bb = arr[yy, x]
            if gg > rr + 12:  # 绿色草地，停
                break
            reg[yy, x] = True

# ============ 2. 精修轮廓（边缘主直线，2px 出血，与 tileRects.ts 一致） ============
rects = []
blob_masks = []
for reg in ordered:
    ys, xs = np.where(reg)
    y_min, y_max, x_min, x_max = ys.min(), ys.max(), xs.min(), xs.max()
    height, width = y_max - y_min + 1, x_max - x_min + 1
    band = reg[y_min + int(height * 0.2): y_max - int(height * 0.2) + 1, :]
    lp, rp = [], []
    for row in band:
        idx = np.where(row)[0]
        if len(idx) > width * 0.5:
            lp.append(idx.min()); rp.append(idx.max())
    band_cols = reg[:, x_min + int(width * 0.2): x_max - int(width * 0.2) + 1]
    tp, bp = [], []
    for col in band_cols.T:
        idx = np.where(col)[0]
        if len(idx) > height * 0.5:
            tp.append(idx.min()); bp.append(idx.max())
    x0 = max(0, int(np.median(lp)) - 2); x1 = min(W, int(np.median(rp)) + 2)
    y0 = max(0, int(np.median(tp)) - 2); y1 = min(H, int(np.median(bp)) + 2)
    rects.append((x0, y0, x1, y1))
    blob_masks.append(reg[y0:y1, x0:x1])

# ============ 2.5 同步重生成 tileRects.ts（与成品图同一份轮廓，永远对齐） ============
ts_lines = []
for x0, y0, x1, y1 in rects:
    ts_lines.append(
        "  { left: %.2f, top: %.2f, width: %.2f, height: %.2f },"
        % (x0 / W * 100, y0 / H * 100, (x1 - x0) / W * 100, (y1 - y0) / H * 100)
    )
ts = (
    "/** 场景 20 块原生土地的精修轮廓（tools/gen_tile_soils.py 自动生成：颜色分割\n"
    " *  + 底边延伸 + 边缘主直线）。与 src/assets/tiles/ 成品图同一份数据，单位 %%。 */\n"
    "export const TILE_RECTS = [\n%s\n] as const\n" % "\n".join(ts_lines)
)
(ROOT.parent / "src" / "lib" / "tileRects.ts").write_text(ts, encoding="utf-8")
print("updated src/lib/tileRects.ts")

# ============ 3. 合成 ============
soils = [
    np.array(Image.open(ASSETS / "soil-flat-1.webp").convert("RGBA"), dtype=np.float32),
    np.array(Image.open(ASSETS / "soil-flat-2.webp").convert("RGBA"), dtype=np.float32),
    np.array(Image.open(ASSETS / "soil-flat-3.webp").convert("RGBA"), dtype=np.float32),
]
native = arr  # 场景图 float32

lum_map = np.array(im.convert("L"), dtype=np.float32)

for ti, (x0, y0, x1, y1) in enumerate(rects):
    tw, th = x1 - x0, y1 - y0
    tile_lum = lum_map[y0:y1, x0:x1]
    median_lum = float(np.median(tile_lum[blob_masks[ti]]))
    # 明暗系数：以该地块中位亮度为 1，限制在 0.62~1.38，保留枕形光影
    shade = np.clip(tile_lum / max(median_lum, 1), 0.62, 1.38)[..., None]
    # 轮廓 alpha：blob 膨胀一点点后羽化 1px
    a = Image.fromarray(np.where(blob_masks[ti], 255, 0).astype(np.uint8), "L")
    a = a.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(1.0))
    alpha = np.array(a, dtype=np.float32)[..., None] / 255.0

    for lv in range(3):
        tex = np.array(
            Image.fromarray(soils[lv].astype(np.uint8), "RGBA").resize((tw, th), Image.LANCZOS),
            dtype=np.float32,
        )
        # 纹理透明角的残留黑像素 → 用不透明部分的中位色填充
        transparent = tex[..., 3] < 128
        if transparent.any():
            opaque_rgb = tex[..., :3][~transparent]
            if len(opaque_rgb) > 0:
                tex[..., :3][transparent] = np.median(opaque_rgb, axis=0)
        out_rgb = np.clip(tex[..., :3] * shade, 0, 255)
        out = np.concatenate([out_rgb, alpha * 255.0], axis=2).astype(np.uint8)
        Image.fromarray(out, "RGBA").save(OUT_DIR / f"soil-{lv + 1}-t{ti}.webp", "WEBP", quality=85)

print(f"generated {20 * 3} tile images in src/assets/tiles/")

# ============ 4. 预览图：第一行 银灰/金色/紫金/原生，第二行第一个金色 ============
scene = Image.open(ASSETS / "farm-scene-portrait.webp").convert("RGBA")
assign = {0: 0, 1: 1, 2: 2, 4: 1}
for idx, lv in assign.items():
    x0, y0, x1, y1 = rects[idx]
    patch = Image.open(OUT_DIR / f"soil-{lv + 1}-t{idx}.webp").convert("RGBA")
    scene.alpha_composite(patch, (x0, y0))
crop = scene.crop((0, int(0.22 * H), W, int(0.72 * H)))
crop.save(ROOT / "soil_preview.png")
print("saved tools/soil_preview.png")
