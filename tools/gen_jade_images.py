# 玉石鉴定生图：调豆包 Seedream 生成 4 石头 + 13 玉石，压到 512px 存 src/assets/jade/
# 用法: set DOUBAO_KEY=xxx && python tools/gen_jade_images.py
# 断点续跑：已存在的文件自动跳过
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

STYLE_STONE = ("photorealistic uncut jadeite gamble rough stone, weathered dark brown "
               "leather-like skin with subtle pale streaks, sitting on dark velvet, dramatic "
               "side lighting, museum specimen photo, centered, square composition, no text, no watermark")
STYLE_JADE = ("photorealistic polished jadeite gemstone cabochon on black velvet, macro jewelry "
              "photography, soft studio light, centered, square composition, no text, no watermark")

IMAGES = {
    "stone-t1": f"small humble mountain jade rough stone, grayish-green tone, {STYLE_STONE}",
    "stone-t2": f"river-washed jade rough stone, smooth water-worn skin, sandy gray-brown, {STYLE_STONE}",
    "stone-t3": f"large old-pit jade boulder, heavy dark crust, mysterious, {STYLE_STONE}",
    "stone-t4": f"imperial grade jade rough boulder, premium dark leather skin with a tiny tempting green window patch, {STYLE_STONE}",
    "jade-marble": f"dull white gray marble stone with faint veins, matte, low value, {STYLE_JADE}",
    "jade-doudi": f"opaque pea-green jadeite, bean-green coarse texture, {STYLE_JADE}",
    "jade-nuo": f"waxy translucent pale green jadeite, milky glutinous texture like rice porridge, {STYLE_JADE}",
    "jade-bingnuo": f"translucent icy-waxy pale green jadeite, half see-through, {STYLE_JADE}",
    "jade-qingshui": f"clear aqua blue-green jadeite, serene water color, {STYLE_JADE}",
    "jade-yellow": f"warm honey-yellow jadeite, golden amber glow, {STYLE_JADE}",
    "jade-red": f"vivid vermilion red jadeite, fiery russet tone, {STYLE_JADE}",
    "jade-mo": f"deep ink-black jadeite with dark green inner glow, mysterious, {STYLE_JADE}",
    "jade-violet": f"soft lavender violet jadeite, dreamy purple, {STYLE_JADE}",
    "jade-ice": f"highly translucent icy colorless-pale-green jadeite, frost-like clarity, {STYLE_JADE}",
    "jade-highice": f"near-glass transparency icy jadeite, brilliant inner glow, {STYLE_JADE}",
    "jade-glass": f"flawless glass-transparent colorless jadeite, crystal clear like a drop of water, {STYLE_JADE}",
    "jade-emperor": f"legendary imperial emerald-green jadeite, intense saturated vivid green, glowing, {STYLE_JADE}",
}

KEY = os.environ.get("DOUBAO_KEY", "")
EP = os.environ.get("DOUBAO_IMAGE_EP", "ep-20260826135342-vjp9g")
URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations"


def gen_one(name: str, prompt: str) -> bool:
    target = OUT / f"{name}.jpg"
    if target.exists() and target.stat().st_size > 10000:
        print(f"SKIP {name} (exists)")
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
    if not KEY:
        sys.exit("DOUBAO_KEY not set")
    only = sys.argv[1:] or list(IMAGES)
    ok = all(gen_one(n, IMAGES[n]) for n in only if n in IMAGES)
    print("DONE" if ok else "SOME_FAILED")


if __name__ == "__main__":
    main()
