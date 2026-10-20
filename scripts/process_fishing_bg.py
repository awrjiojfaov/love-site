# -*- coding: utf-8 -*-
"""钓鱼背景处理：抹掉静态鱼线和鱼钩（用左右像素插值填充），转 webp"""
from PIL import Image
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 仓库根
SRC = os.environ.get('FISHING_BG_SRC', os.path.join(ROOT, 'assets_src', 'fishing-bg.jpg'))
DST = os.path.join(ROOT, 'src', 'assets', 'fishing-bg.webp')

im = Image.open(SRC).convert('RGB')
W, H = im.size
print('size', W, H)
px = im.load()

# 鱼线+鱼钩区域（按 1706x1279 原图估算，中心线 x≈850）
x0, x1 = int(W * 0.487), int(W * 0.520)   # 覆盖线宽和钩子摆幅
y0, y1 = int(H * 0.295), int(H * 0.580)   # 从船底到钩子下方
xl, xr = x0 - 12, x1 + 12                 # 采样左右干净水域
for y in range(y0, y1):
    cl = px[xl, y]
    cr = px[xr, y]
    for x in range(x0, x1):
        t = (x - x0) / max(1, x1 - x0)
        px[x, y] = tuple(round(cl[i] * (1 - t) + cr[i] * t) for i in range(3))

im.save(DST, 'WEBP', quality=88, method=6)
print('saved', DST, os.path.getsize(DST))
