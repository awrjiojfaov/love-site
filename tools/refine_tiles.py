"""地块精修坐标：在颜色分割基础上，对每块地取边缘“主直线”位置（中位值），
避免透视斜边/圆角把包围盒拉歪——20 块地的左边缘互相平行，覆盖后不凸出。"""
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).parent
SCENE = ROOT.parent / "src" / "assets" / "farm-scene-portrait.webp"

im = Image.open(SCENE).convert("RGB")
W, H = im.size
arr = np.array(im).astype(np.int16)
r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]

samples = np.array([[133, 76, 0], [135, 79, 7], [161, 99, 15]])
dist = np.sqrt(((arr[:, :, None, :] - samples[None, None, :, :]) ** 2).sum(axis=3)).min(axis=2)
brownish = (r > g) & (g > b) & (r > 90) & (r < 200) & (b < 120)
mask = (dist < 42) & brownish

# 连通域
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
        if region.sum() < 8000:
            continue
        blobs.append(region)

print(f"{len(blobs)} blobs")

# 按质心排序成行优先
centers = []
for reg in blobs:
    ys, xs = np.where(reg)
    centers.append((float(ys.mean()), float(xs.mean()), reg))
centers.sort(key=lambda t: (round(t[0] / 100), t[1]))
# 修正：按 y 分行，每行按 x 排序
rows = {}
for cy, cx, reg in centers:
    key = int(cy // 100)
    rows.setdefault(key, []).append((cx, reg))
ordered = []
for key in sorted(rows):
    ordered.extend(reg for _, reg in sorted(rows[key], key=lambda t: t[0]))
print(f"ordered {len(ordered)}")

PAD = 2  # 主直线外只留 2px 出血
lines = []
for i, reg in enumerate(ordered):
    ys, xs = np.where(reg)
    y_min, y_max = ys.min(), ys.max()
    x_min, x_max = xs.min(), xs.max()
    height = y_max - y_min + 1
    width = x_max - x_min + 1

    # 左/右边缘主直线：取中间 60% 行的最左/最右像素的 median（避开上下圆角和斜角）
    band = reg[y_min + int(height * 0.2): y_max - int(height * 0.2) + 1, :]
    left_profile = []
    right_profile = []
    for row in band:
        idx = np.where(row)[0]
        if len(idx) > width * 0.5:  # 该行足够满，才计入
            left_profile.append(idx.min())
            right_profile.append(idx.max())
    left_edge = int(np.median(left_profile)) if left_profile else x_min
    right_edge = int(np.median(right_profile)) if right_profile else x_max

    # 上/下边缘主直线：取中间 60% 列
    band_cols = reg[:, x_min + int(width * 0.2): x_max - int(width * 0.2) + 1]
    top_profile = []
    bottom_profile = []
    for col in band_cols.T:
        idx = np.where(col)[0]
        if len(idx) > height * 0.5:
            top_profile.append(idx.min())
            bottom_profile.append(idx.max())
    top_edge = int(np.median(top_profile)) if top_profile else y_min
    bottom_edge = int(np.median(bottom_profile)) if bottom_profile else y_max

    x0 = max(0, left_edge - PAD)
    x1 = min(W, right_edge + PAD)
    y0 = max(0, top_edge - PAD)
    y1 = min(H, bottom_edge + PAD)
    lines.append(
        "  { left: %.2f, top: %.2f, width: %.2f, height: %.2f },"
        % (x0 / W * 100, y0 / H * 100, (x1 - x0) / W * 100, (y1 - y0) / H * 100)
    )
    if i < 4:
        print(f"tile{i}: bbox x{x_min}-{x_max} y{y_min}-{y_max} -> core x{x0}-{x1} y{y0}-{y1}")

out = (
    "/** 场景 20 块原生土地的精修轮廓（tools/refine_tiles.py：颜色分割 + 边缘主直线）。\n"
    " *  左/右/上/下取中间 60%% 区域的中位边缘，20 块地边缘互相平行；含 2px 出血。单位 %%。 */\n"
    "export const TILE_RECTS = [\n%s\n] as const\n" % "\n".join(lines)
)
(ROOT.parent / "src" / "lib" / "tileRects.ts").write_text(out, encoding="utf-8")
print("written src/lib/tileRects.ts")
