# 玉器工坊生图：13 品种 x 6 器型 x N 个变体，压到 512px 存 src/assets/jade/
# 用法: set DOUBAO_KEY=xxx && python tools/gen_jade_crafts.py [varietyId ...] [--n 2] [--types bangle,ring] [--force]
#   --n N     每个 {器型}-{品种} 生成 N 个变体（默认 2；第 1 张沿用老命名 craft-t-v.jpg，第 k 张 craft-t-v-k.jpg）
#   --force   已存在的图也重新生成
#   --types   只跑指定器型（逗号分隔）
# 断点续跑：已存在的文件自动跳过
#
# 关键点：同一器型不再"千篇一律"——场景/角度/光影三个池子按 {器型}|{品种}|{变体} 确定性抽签，
# 每个组合都拿到不同的布景，且多端可复现（前端 jadeArt.craftArt 按成品 id 从变体里稳定挑一张）。
import argparse
import base64
import io
import os
import sys
import time
from pathlib import Path

import requests
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "assets" / "jade"
OUT.mkdir(parents=True, exist_ok=True)

# 品种外观描述（与 gen_jade_images.py 保持一致）
VARIETIES = {
    "marble": "dull white gray marble with faint veins, matte, low value",
    "doudi": "opaque pea-green jadeite, bean-green coarse texture",
    "nuo": "waxy translucent pale green jadeite, milky glutinous texture",
    "bingnuo": "translucent icy-waxy pale green jadeite, half see-through",
    "qingshui": "clear aqua blue-green jadeite, serene water color",
    "yellow": "warm honey-yellow jadeite, golden amber glow",
    "red": "vivid vermilion red jadeite, fiery russet tone",
    "mo": "deep ink-black jadeite with dark green inner glow",
    "violet": "soft lavender violet jadeite, dreamy purple",
    "ice": "highly translucent icy colorless-pale-green jadeite, frost-like clarity",
    "highice": "near-glass transparency icy jadeite, brilliant inner glow",
    "glass": "flawless glass-transparent colorless jadeite, crystal clear like a drop of water",
    "emperor": "legendary imperial emerald-green jadeite, intense saturated vivid green, glowing",
}

# 稀有度点睛：传说/稀有的成品给博物馆级布光与氛围
RARITY_FLAVOR = {
    "marble": "",
    "doudi": "",
    "nuo": "",
    "bingnuo": "",
    "qingshui": "",
    "yellow": "",
    "red": "",
    "mo": "mysterious low-key mood, faint inner glow",
    "violet": "dreamy soft focus haze, ethereal glow",
    "ice": "frosty cool atmosphere, tiny sparkle in the air",
    "highice": "brilliant inner light, subtle lens flare",
    "glass": "museum-grade presentation, ethereal glow, faint sparkle in the air",
    "emperor": "museum-grade presentation, dramatic green light spill, faint sparkle in the air",
}

# 器型主体（不含背景，背景交给场景池）
TYPES = {
    "bangle": "a single polished jadeite bangle bracelet, perfect smooth circular ring shape standing upright",
    "bracelet": "a jadeite bead bracelet, string of round polished jade beads, coiled elegantly",
    "pendant": "a jadeite pendant, round lucky donut-shaped ping-an-kou disc with a small bail loop",
    "ring": "a jadeite ring, smooth polished simple band, standing upright",
    "earrings": "a pair of jadeite drop earrings with tiny hooks",
    "ornament": "a small carved jadeite ornament sculpture, auspicious cloud motif, on a tiny wooden stand",
}

# 场景池：布景/承托物
SCENES = [
    "on dark charcoal velvet with soft folds",
    "on pale ivory silk fabric with gentle ripples",
    "on a black marble slab with subtle veining",
    "on a warm walnut wood tray beside a sprig of greenery",
    "on a sunlit linen surface near a window",
    "on an icy translucent glass surface with delicate reflections",
    "on deep emerald-green silk with a luxe sheen",
    "on a weathered stone pedestal outdoors with soft bokeh greenery",
    "floating above a mirror-like water surface with gentle ripples",
    "on a bed of white cotton clouds with dust motes in the air",
    "on antique rice paper with a faint ink-wash landscape",
    "on rough beige clay with a few scattered jade pebbles",
]

# 角度池
ANGLES = [
    "three-quarter view",
    "top-down flat lay",
    "macro close-up detail",
    "low side profile view",
    "slight overhead angle",
    "close hero shot with shallow depth of field",
]

# 光影池
LIGHTS = [
    "soft diffused studio lighting",
    "warm golden-hour rim light",
    "cool moonlight glow",
    "dramatic single spotlight",
    "backlit to reveal translucency",
    "bright clean daylight",
    "moody low-key lighting with deep shadows",
    "gentle bounce light from above",
]

BASE_STYLE = (
    "photorealistic fine jewelry product photography, ultra detailed, crisp focus, "
    "square composition, no text, no watermark, no hands"
)

KEY = os.environ.get("DOUBAO_KEY", "")
EP = os.environ.get("DOUBAO_IMAGE_EP", "ep-20260826135342-vjp9g")
URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations"


def _hash01(s: str) -> float:
    """确定性散列 -> [0,1)，保证同一组合每次都抽到同一套布景"""
    h = 0
    for ch in s:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return h / 4294967296


def pick(pool, seed: str) -> str:
    return pool[int(_hash01(seed) * len(pool)) % len(pool)]


def build_prompt(type_id: str, variety_id: str, variant: int) -> str:
    seed = f"{type_id}|{variety_id}|{variant}"
    parts = [
        TYPES[type_id],
        f"made of {VARIETIES[variety_id]}",
        pick(SCENES, seed + "|scene"),
        pick(ANGLES, seed + "|angle"),
        pick(LIGHTS, seed + "|light"),
    ]
    flavor = RARITY_FLAVOR.get(variety_id, "")
    if flavor:
        parts.append(flavor)
    parts.append(BASE_STYLE)
    return ", ".join(parts)


def gen_one(name: str, prompt: str, force: bool = False) -> bool:
    target = OUT / f"{name}.jpg"
    if not force and target.exists() and target.stat().st_size > 10000:
        print(f"SKIP {name}")
        return True
    for attempt in range(3):
        try:
            r = requests.post(URL, headers={"Authorization": f"Bearer {KEY}"}, json={
                "model": EP, "prompt": prompt, "size": "1024x1024",
                "response_format": "b64_json", "watermark": False,
            }, timeout=120)
            if r.status_code != 200:
                print(f"RETRY {name} http {r.status_code}: {r.text[:120]}")
                time.sleep(3 * (attempt + 1))
                continue
            b64 = r.json()["data"][0].get("b64_json")
            if not b64:
                print(f"RETRY {name} empty data")
                time.sleep(3)
                continue
            img = Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")
            img = img.resize((512, 512), Image.LANCZOS)
            img.save(target, "JPEG", quality=85)
            print(f"OK   {name} ({target.stat().st_size // 1024}KB)")
            return True
        except Exception as e:  # noqa: BLE001
            print(f"RETRY {name} {type(e).__name__}: {e}")
            time.sleep(3 * (attempt + 1))
    print(f"FAIL {name}")
    return False


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("varieties", nargs="*", help="只跑这些品种（默认全部）")
    ap.add_argument("--n", type=int, default=2, help="每个组合生成几个变体（默认 2）")
    ap.add_argument("--types", default="", help="只跑这些器型，逗号分隔")
    ap.add_argument("--force", action="store_true", help="已存在的图也重画")
    args = ap.parse_args()

    if not KEY:
        sys.exit("DOUBAO_KEY not set")

    var_ids = [v for v in (args.varieties or list(VARIETIES)) if v in VARIETIES]
    type_ids = [t for t in (args.types.split(",") if args.types else list(TYPES)) if t in TYPES]
    ok = True
    for v in var_ids:
        for t in type_ids:
            for k in range(1, args.n + 1):
                # 第 1 张沿用老命名（78 张存量图直接当变体 1），第 k 张加 -k 后缀
                name = f"craft-{t}-{v}" if k == 1 else f"craft-{t}-{v}-{k}"
                ok = gen_one(name, build_prompt(t, v, k), args.force) and ok
    print("DONE" if ok else "SOME_FAILED")


if __name__ == "__main__":
    main()
