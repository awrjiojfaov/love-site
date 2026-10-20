# -*- coding: utf-8 -*-
"""从干净原图重新生成带版本号的图标，压缩体积减轻手机端卡顿。"""
from pathlib import Path
from PIL import Image

SRC = Path(__file__).parent / "icon-source-clean.png"
OUT = Path(__file__).parent.parent / "public"

img = Image.open(SRC).convert("RGB")
w, h = img.size
# 正方形裁剪（取上半部分人像区域，与上一版一致的取景）
top = 800
side = 1600
if h - top >= side:
    crop = img.crop((0, top, side, top + side))
else:
    side = min(w, h)
    crop = img.crop(((w - side) // 2, (h - side) // 2, (w + side) // 2, (h + side) // 2))

def save_icon(size, name, quantize=False):
    im = crop.resize((size, size), Image.LANCZOS)
    if quantize:
        q = im.quantize(colors=256, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG)
        q.save(OUT / name, "PNG", optimize=True)
    else:
        im.save(OUT / name, "PNG", optimize=True)
    print(name, (OUT / name).stat().st_size)

save_icon(512, "icon-v2-512.png", quantize=True)
save_icon(192, "icon-v2-192.png", quantize=True)
save_icon(180, "apple-touch-icon-v2.png", quantize=True)
save_icon(64, "favicon-v2.png", quantize=True)
