"""分析农场场景图：颜色分割识别 20 块原生土地的真实轮廓，输出每块地的百分比坐标。
结果直接生成 src/lib/tileRects.ts 供 FarmPage 使用。"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).parent
SCENE = ROOT.parent / "src" / "assets" / "farm-scene-portrait.webp"

im = Image.open(SCENE).convert("RGB")
W, H = im.size
arr = np.array(im).astype(np.int16)
print(f"scene {W}x{H}")

# 采样已知地块中心的颜色（现有目测坐标 row0col0 / row2col2）
samples = []
for fx, fy in [(0.256, 0.29), (0.577, 0.45), (0.3925, 0.63)]:
    px = arr[int(fy * H), int(fx * W)]
    samples.append(px)
    print(f"sample ({fx},{fy}) -> RGB {px}")
samples = np.array(samples)

# 棕色掩码：与样本色接近（欧氏距离阈值），且明显偏棕（R>G>B，且不太绿）
dist = np.sqrt(((arr[:, :, None, :] - samples[None, None, :, :]) ** 2).sum(axis=3)).min(axis=2)
r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
brownish = (r > g) & (g > b) & (r > 90) & (r < 200) & (b < 120)
mask = (dist < 42) & brownish
print(f"mask coverage {mask.mean():.3f}")

# 连通域标记（两遍法的简化：用膨胀洪水太慢，改用按行扫描的简易 BFS 太慢——用洪水填充逐种子）
visited = np.zeros_like(mask)
boxes = []
h, w = mask.shape
for y0 in range(0, h, 4):
    for x0 in range(0, w, 4):
        if not mask[y0, x0] or visited[y0, x0]:
            continue
        # 从该点洪水填充
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
        area = int(region.sum())
        if area < 8000:  # 地块约 140x100=14000 像素，滤掉栅栏/杂物
            continue
        ys, xs = np.where(region)
        boxes.append((int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()), area))

print(f"found {len(boxes)} blobs >= 8000px")
for bx in sorted(boxes, key=lambda v: (v[1], v[0])):
    print(f"  bbox x{bx[0]}-{bx[2]} y{bx[1]}-{bx[3]} area={bx[4]}")

# 可视化：画框输出检查图
vis = im.copy()
dr = ImageDraw.Draw(vis)
for i, (x0, y0, x1, y1, _) in enumerate(boxes):
    dr.rectangle([x0, y0, x1, y1], outline=(255, 0, 0), width=3)
    dr.text((x0 + 4, y0 + 4), str(i), fill=(255, 0, 0))
vis.save(ROOT / "tile_detect_debug.png")
print("debug image saved to tools/tile_detect_debug.png")
