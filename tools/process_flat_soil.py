"""平面土地图处理：去黑底（边缘洪水填充）、最大连通域去水印、羽化、裁切、缩 360 宽 webp。
输出直接作为地块背景 100%x100% 填充使用。"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).parent
SRC = ROOT / "soil_src"
DST = ROOT.parent / "src" / "assets"

JOBS = [
    ("平面土地_灰.png", "soil-flat-1.webp"),
    ("平面土地_金色.png", "soil-flat-2.webp"),
    ("平面土地_紫金.png", "soil-flat-3.webp"),
]


def flood(mask: np.ndarray, seeds: np.ndarray) -> np.ndarray:
    visited = seeds & mask
    frontier = visited.copy()
    while True:
        grown = frontier.copy()
        grown[1:, :] |= frontier[:-1, :]
        grown[:-1, :] |= frontier[1:, :]
        grown[:, 1:] |= frontier[:, :-1]
        grown[:, :-1] |= frontier[:, 1:]
        new = grown & mask & ~visited
        if not new.any():
            return visited
        visited |= new
        frontier = new


for src_name, out_name in JOBS:
    im = Image.open(SRC / src_name).convert("RGBA")
    arr = np.array(im)
    h, w = arr.shape[:2]
    lum = arr[..., :3].astype(np.int16).max(axis=2)

    dark = lum < 18
    border = np.zeros((h, w), dtype=bool)
    border[0, :] = border[-1, :] = True
    border[:, 0] = border[:, -1] = True
    bg = flood(dark, border & dark)

    alpha = np.where(bg, 0, 255).astype(np.uint8)
    # 左下角“AI生成”水印区域清零
    yy, xx = np.mgrid[0:h, 0:w]
    alpha[(xx < 0.24 * w) & (yy > 0.86 * h)] = 0

    # 最大连通域（土壤本体），噪点清掉
    fg_mask = alpha > 0
    seeds = np.zeros((h, w), dtype=bool)
    seeds[h // 2, w // 2] = True
    keep = flood(fg_mask, seeds)
    alpha = np.where(keep, alpha, 0).astype(np.uint8)

    # 边缘羽化
    alpha = np.array(Image.fromarray(alpha, "L").filter(ImageFilter.GaussianBlur(1.4)))

    arr[..., 3] = alpha
    out = Image.fromarray(arr, "RGBA")
    solid = np.where(alpha >= 40, 255, 0).astype(np.uint8)
    bbox = Image.fromarray(solid, "L").getbbox()
    if bbox:
        pad = 4
        bbox = (
            max(0, bbox[0] - pad),
            max(0, bbox[1] - pad),
            min(w, bbox[2] + pad),
            min(h, bbox[3] + pad),
        )
        out = out.crop(bbox)
    ratio = 360 / out.width
    out = out.resize((360, max(1, round(out.height * ratio))), Image.LANCZOS)
    out.save(DST / out_name, "WEBP", quality=88)
    print(f"{src_name} -> {out_name}  {out.size[0]}x{out.size[1]}  bg={bg.mean():.2f} keep={keep.mean():.2f}")
