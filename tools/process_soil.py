"""土地升级图处理：去黑底（边缘洪水填充）、去 AI生成 水印、最大连通域、羽化、裁切、缩 360 宽 webp。"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).parent
SRC = ROOT / "soil_src"
DST = ROOT.parent / "src" / "assets"

JOBS = [
    ("土地_银灰.png", "soil-1.webp"),
    ("土地_金色.png", "soil-2.webp"),
    ("土地_紫金.png", "soil-3.webp"),
]


def flood(mask: np.ndarray, seeds: np.ndarray) -> np.ndarray:
    """4 邻域洪水填充：从 seeds（bool 数组）出发，在 mask 内扩散，返回填充区域。"""
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

    # 真背景 = 与图像边缘相连的近黑区域
    dark = lum < 18
    border = np.zeros((h, w), dtype=bool)
    border[0, :] = border[-1, :] = True
    border[:, 0] = border[:, -1] = True
    bg = flood(dark, border & dark)

    alpha = np.where(bg, 0, 255).astype(np.uint8)
    # 左下角“AI生成”水印区域清零
    yy, xx = np.mgrid[0:h, 0:w]
    alpha[(xx < 0.22 * w) & (yy > 0.84 * h)] = 0

    # 只保留与画面中心相连的最大前景块（土壤本体），噪点、悬浮物清掉
    fg_mask = alpha > 0
    seeds = np.zeros((h, w), dtype=bool)
    cy, cx = int(h * 0.55), w // 2
    if not fg_mask[cy, cx]:
        for r in range(10, w // 3, 10):
            for dy, dx in [(0, r), (0, -r), (r, 0), (-r, 0)]:
                if fg_mask[cy + dy, cx + dx]:
                    cy, cx = cy + dy, cx + dx
                    break
            if seeds.any() or fg_mask[cy, cx]:
                break
    seeds[cy, cx] = True
    keep = flood(fg_mask, seeds)
    alpha = np.where(keep, alpha, 0).astype(np.uint8)

    # 边缘羽化，避免硬边穿模
    alpha = np.array(Image.fromarray(alpha, "L").filter(ImageFilter.GaussianBlur(1.4)))

    arr[..., 3] = alpha
    out = Image.fromarray(arr, "RGBA")
    # 用较高的 alpha 阈值求内容包围盒，忽略残留的微弱噪点
    solid = np.where(alpha >= 40, 255, 0).astype(np.uint8)
    bbox = Image.fromarray(solid, "L").getbbox()
    if bbox:
        pad = 6
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

    # 另出一张“纯表面纹理”：只裁土壤上表面的中心带（不要立体侧面），
    # 并自动向内收缩直到矩形内 100% 不透明——背景填充法要求没有任何透明边
    tw, th = out.size
    alpha_full = np.array(out)[..., 3]
    x0, y0, x1, y1 = int(tw * 0.22), int(th * 0.14), int(tw * 0.78), int(th * 0.54)
    while x1 - x0 > 40 and y1 - y0 > 24:
        if alpha_full[y0:y1, x0:x1].min() >= 250:
            break
        x0 += 2
        x1 -= 2
        y0 += 2
        y1 -= 2
    band = out.crop((x0, y0, x1, y1))
    band = band.resize((480, 264), Image.LANCZOS)
    # 保险：纹理一律拉成全不透明矩形
    band.putalpha(255)
    tex_name = out_name.replace("soil-", "soil-tex-")
    band.save(DST / tex_name, "WEBP", quality=88)
    print(f"  + {tex_name}  {band.size[0]}x{band.size[1]}  crop=({x0},{y0},{x1},{y1})")
