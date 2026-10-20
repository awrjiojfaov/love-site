# -*- coding: utf-8 -*-
"""头像框批处理：去 AI 水印角标 → 统一打圆形透明孔（58% 直径）→ 320px webp"""
from PIL import Image, ImageDraw
import os

SRC = os.environ.get('FRAMES_SRC', os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src', 'assets', 'frames'))
DST = SRC  # 输出同目录，webp

NAME_MAP = {
    '头像框_萌系猫耳.png': 'catear',
    '头像框_糖果甜心.png': 'candy',
    '头像框_圣诞雪夜.png': 'snow',
    '头像框_樱花少女.png': 'sakura',
    '头像框_万圣南瓜.png': 'pumpkin',
    '头像框_森林精灵.png': 'forest',
    '头像框_深海人鱼.png': 'mermaid',
    '头像框_梦幻星空.png': 'starry',
    '头像框_蒸汽朋克.png': 'steampunk',
    '头像框_赛博朋克.png': 'cyberpunk',
    '头像框_暗黑哥特.png': 'gothic',
    '头像框_古风玉佩.png': 'jade',
    '头像框_华贵金冠.png': 'crown',
    '头像框_敦煌飞天.png': 'dunhuang',
}

W = 1024
HOLE_R = int(W * 0.29)  # 孔半径 29% → 直径 58%

for fn, fid in NAME_MAP.items():
    im = Image.open(os.path.join(SRC, fn)).convert('RGBA')
    assert im.size == (W, W), fn
    px = im.load()
    # 1) 去左下角 "AI生成" 水印（区域清空透明）
    d = ImageDraw.Draw(im)
    d.rectangle([0, 915, 150, W], fill=(0, 0, 0, 0))
    # 2) 打圆形透明孔（带 3px 羽化，边缘不生硬）
    mask = Image.new('L', (W, W), 0)
    md = ImageDraw.Draw(mask)
    md.ellipse([W//2 - HOLE_R, W//2 - HOLE_R, W//2 + HOLE_R, W//2 + HOLE_R], fill=255)
    # 用孔的反向 mask 把中心区域 alpha 清零
    alpha = im.getchannel('A')
    from PIL import ImageChops
    new_alpha = ImageChops.subtract(alpha, mask)
    im.putalpha(new_alpha)
    # 3) 缩到 320px webp
    im = im.resize((320, 320), Image.LANCZOS)
    out = os.path.join(DST, f'{fid}.webp')
    im.save(out, 'WEBP', quality=88, method=6)
    print(fid, os.path.getsize(out))
print('done')
