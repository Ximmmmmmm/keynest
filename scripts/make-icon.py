"""生成钥巢应用图标：深蓝底 + 盾牌 + 钥匙孔。

输出 build/icon.ico（多尺寸）与 build/icon.png（256×256，便于查看）。
纯 PIL 绘制，不依赖外部素材。
"""
import os
import math
from PIL import Image, ImageDraw

SIZE = 256
OUT = os.path.join(os.path.dirname(__file__), "..", "build")
os.makedirs(OUT, exist_ok=True)

# 品牌色：与界面主色一致（深蓝 #3a4fd4 附近）
BG_TOP = (58, 79, 212)
BG_BOTTOM = (42, 56, 158)
SHIELD = (255, 255, 255)
KEYHOLE = (42, 56, 158)


def rounded_rect_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def vertical_gradient(size, top, bottom):
    img = Image.new("RGB", (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / (size - 1)
        color = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        d.line([(0, y), (size, y)], fill=color)
    return img


def shield_points(cx, cy, w, h):
    """盾牌轮廓：上方平直，两侧竖直，下方收成尖角。"""
    half = w / 2
    top = cy - h / 2
    shoulder = cy + h * 0.18
    return [
        (cx - half, top),
        (cx + half, top),
        (cx + half, shoulder),
        (cx, cy + h / 2),
        (cx - half, shoulder),
    ]


def draw_icon(size):
    img = vertical_gradient(size, BG_TOP, BG_BOTTOM).convert("RGBA")

    # 圆角遮罩，让图标在任务栏里是圆角方块
    mask = rounded_rect_mask(size, int(size * 0.22))
    img.putalpha(mask)

    d = ImageDraw.Draw(img)

    cx = size / 2
    cy = size / 2
    sw = size * 0.46
    sh = size * 0.56

    # 盾牌主体
    d.polygon(shield_points(cx, cy, sw, sh), fill=SHIELD)

    # 钥匙孔：上圆 + 下梯形（梯形要细长，否则会看成灯泡）
    hole_r = size * 0.052
    hole_cy = cy - size * 0.06
    d.ellipse(
        [cx - hole_r, hole_cy - hole_r, cx + hole_r, hole_cy + hole_r],
        fill=KEYHOLE,
    )
    stem_w_top = hole_r * 0.62
    stem_w_bottom = hole_r * 0.42
    stem_top = hole_cy + hole_r * 0.35
    stem_bottom = hole_cy + size * 0.155
    d.polygon(
        [
            (cx - stem_w_top, stem_top),
            (cx + stem_w_top, stem_top),
            (cx + stem_w_bottom, stem_bottom),
            (cx - stem_w_bottom, stem_bottom),
        ],
        fill=KEYHOLE,
    )

    return img


def main():
    base = draw_icon(SIZE)

    png_path = os.path.join(OUT, "icon.png")
    base.save(png_path, "PNG")
    print("wrote", png_path)

    # ICO 需要多尺寸，Windows 会按 DPI 选择
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    ico_path = os.path.join(OUT, "icon.ico")
    base.save(ico_path, format="ICO", sizes=sizes)
    print("wrote", ico_path, os.path.getsize(ico_path), "bytes")


if __name__ == "__main__":
    main()
