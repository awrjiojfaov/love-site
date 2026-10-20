"""生成升级土地效果预览图：真实场景 + 真实坐标，把银灰/金色/紫金叠到不同地块上对比。"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).parent
ASSETS = ROOT.parent / "src" / "assets"

RECTS = [
    (18.26, 25.72, 14.55, 6.64), (34.18, 25.72, 14.55, 6.71), (50.00, 25.72, 14.55, 6.64), (65.82, 25.72, 14.55, 6.64),
    (16.60, 33.07, 15.33, 7.23), (33.40, 33.07, 15.14, 7.23), (49.90, 33.07, 15.14, 7.23), (66.50, 33.07, 15.14, 7.23),
    (15.14, 41.15, 15.82, 7.81), (32.62, 41.15, 15.82, 7.81), (49.90, 41.08, 15.72, 7.88), (67.09, 41.15, 16.02, 7.81),
    (13.28, 49.87, 16.50, 8.33), (31.54, 49.87, 16.60, 8.27), (49.80, 49.80, 16.41, 8.33), (67.87, 49.80, 16.70, 8.33),
    (11.23, 59.11, 17.48, 9.18), (30.57, 59.11, 17.29, 9.11), (49.71, 59.18, 17.19, 9.05), (68.65, 59.18, 17.58, 9.05),
]

scene = Image.open(ASSETS / "farm-scene-portrait.webp").convert("RGBA")
W, H = scene.size

soils = [
    Image.open(ASSETS / "soil-flat-1.webp").convert("RGBA"),
    Image.open(ASSETS / "soil-flat-2.webp").convert("RGBA"),
    Image.open(ASSETS / "soil-flat-3.webp").convert("RGBA"),
]

# 第一行：银灰、金色、紫金、原生对比；第二行第一个再来一个金色
assign = {0: 0, 1: 1, 2: 2, 4: 1}

for idx, lv in assign.items():
    l, t, w, h = RECTS[idx]
    px = (round(l / 100 * W), round(t / 100 * H), round(w / 100 * W), round(h / 100 * H))
    patch = soils[lv].resize((px[2], px[3]), Image.LANCZOS)
    scene.alpha_composite(patch, (px[0], px[1]))

# 裁到农田区域方便看
crop = scene.crop((0, int(0.22 * H), W, int(0.72 * H)))
crop.save(ROOT / "soil_preview.png")
print("saved tools/soil_preview.png", crop.size)
