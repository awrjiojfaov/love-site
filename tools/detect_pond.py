"""分析农场场景图：颜色分割识别鱼塘水面的真实边界，输出 10x2 养殖位的精确百分比坐标。
结果生成 src/lib/pondRects.ts 供 FarmPage 使用。"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).parent
SCENE = ROOT.parent / "src" / "assets" / "farm-scene-portrait.webp"

im = Image.open(SCENE).convert("RGB")
W, H = im.size
arr = np.array(im).astype(np.int16)
print(f"scene {W}x{H}")

# 采样水面颜色（目测鱼塘中部）
for fx, fy in [(0.5, 0.75), (0.35, 0.78), (0.65, 0.76)]:
    px = arr[int(fy * H), int(fx * W)]
    print(f"sample ({fx},{fy}) -> RGB {px}")

r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
# 水：蓝分量显著最高，且饱和度够（排除天空：天空在上方且更浅）
water = (b > 150) & (b - r > 60) & (b - g > 40) & (g > 100)
# 只看场景下半部分（避开天空/湖泊远景）
water[: int(0.66 * H), :] = False
print(f"water coverage {water.mean():.4f}")

# 最大连通域 = 鱼塘水面
visited = np.zeros_like(water)
best = None
h, w = water.shape
ys_all, xs_all = np.where(water)
for y0, x0 in zip(ys_all[::97], xs_all[::97]):
    if visited[y0, x0]:
        continue
    seeds = np.zeros_like(water)
    seeds[y0, x0] = True
    region = seeds & water
    frontier = region.copy()
    while True:
        grown = frontier.copy()
        grown[1:, :] |= frontier[:-1, :]
        grown[:-1, :] |= frontier[1:, :]
        grown[:, 1:] |= frontier[:, :-1]
        grown[:, :-1] |= frontier[:, 1:]
        new = grown & water & ~region
        if not new.any():
            break
        region |= new
        frontier = new
    visited |= region
    if best is None or region.sum() > best.sum():
        best = region

ys, xs = np.where(best)
x0, x1, y0, y1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
print(f"water bbox x{x0}-{x1} y{y0}-{y1}  ({x0/W*100:.2f}%-{x1/W*100:.2f}%, {y0/H*100:.2f}%-{y1/H*100:.2f}%)")

# 可视化
vis = im.copy()
dr = ImageDraw.Draw(vis)
dr.rectangle([x0, y0, x1, y1], outline=(255, 0, 0), width=3)
vis.save(ROOT / "pond_detect_debug.png")
print("debug image saved to tools/pond_detect_debug.png")

# 10x2 养殖位：水面内缩边距后均匀排布
mx = (x1 - x0) * 0.06  # 左右内缩 6%
my = (y1 - y0) * 0.10  # 上下内缩 10%
ix0, ix1 = x0 + mx, x1 - mx
iy0, iy1 = y0 + my, y1 - my
slot_w = (ix1 - ix0) / 10
slot_h = (iy1 - iy0) / 2
lines = []
for row in range(2):
    for col in range(10):
        sx = ix0 + col * slot_w + slot_w * 0.12
        sy = iy0 + row * slot_h + slot_h * 0.08
        sw = slot_w * 0.76
        sh = slot_h * 0.84
        lines.append(
            "  { left: %.2f, top: %.2f, width: %.2f, height: %.2f },"
            % (sx / W * 100, sy / H * 100, sw / W * 100, sh / H * 100)
        )
out = (
    "/** 鱼塘 20 个养殖位的像素级实测排布（tools/detect_pond.py 水面分割自动生成）。\n"
    " *  水面真实边界 x%.1f%%-%.1f%% y%.1f%%-%.1f%%，10x2 均匀内缩排布，单位 %%。 */\n"
    "export const POND_RECTS = [\n%s\n] as const\n"
    % (x0 / W * 100, x1 / W * 100, y0 / H * 100, y1 / H * 100, "\n".join(lines))
)
(ROOT.parent / "src" / "lib" / "pondRects.ts").write_text(out, encoding="utf-8")
print(out)
