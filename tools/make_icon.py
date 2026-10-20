# 处理新 App 图标：去右下角「豆包AI生成」水印 + 裁正方形 + 生成多尺寸
# 用法：把源图放到 assets_src/（或设 ICON_SRC 环境变量），再跑本脚本
import os
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 仓库根
SRC = os.environ.get('ICON_SRC', os.path.join(ROOT, 'assets_src', 'icon-src.png'))
OUT = os.path.join(ROOT, 'public')

img = Image.open(SRC).convert('RGB')
W, H = img.size
print('原图', W, H)

# 水印区域（目检）：右下角 x 0.83W~0.995W, y 0.966H~0.993H，留点余量
x0, x1 = int(0.820 * W), int(0.998 * W)
y0, y1 = int(0.962 * H), int(0.995 * H)
ww, hh = x1 - x0, y1 - y0

# 用左侧相邻地面纹理做补丁（同一水平带，左移 1.15 倍宽度取图，纹理连续）
patch = img.crop((x0 - int(ww * 1.15), y0, x0 - int(ww * 1.15) + ww, y0 + hh))
patch = patch.transpose(Image.FLIP_LEFT_RIGHT)  # 镜像让边缘纹理更自然衔接
img.paste(patch, (x0, y0))

# 接缝处轻微高斯模糊（只模糊补丁及其周边一圈）
region = img.crop((x0 - 24, y0 - 24, min(W, x1 + 24), min(H, y1 + 24)))
region = region.filter(ImageFilter.GaussianBlur(3))
img.paste(region, (x0 - 24, y0 - 24))

os.makedirs(OUT, exist_ok=True)
img.save(os.path.join(OUT, 'icon-source-clean.png'))

# 正方形裁剪：以情侣为主体（头像/夕阳/栏杆），y 800~2400
sq = img.crop((0, 800, 1600, 2400))

for name, size in [('icon-512.png', 512), ('icon-192.png', 192), ('apple-touch-icon.png', 180), ('favicon.png', 64)]:
    sq.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, name))
    print('已生成', name, size)
