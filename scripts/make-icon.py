"""生成钥巢应用图标。

# 旧版为什么显得粗糙

1. **直接在 256 上画**，没有超采样 —— 斜边全是锯齿，
   在小尺寸（任务栏 16/24px）下尤其糊。
2. **盾牌偏小**（0.46×0.56），四周留白太多，看着像一张白纸贴上去。
3. **钥匙孔比例失真** —— 圆头配几乎等宽的柄，像灯泡。
4. **底色只有纵向渐变**，没有层次，扁平。

# 新版做了四件事

1. **4 倍超采样**（1024 → 缩到 256），边缘干净。
2. **盾牌放大到 0.58×0.62**，加投影 —— 有「浮起来」的层次。
3. **钥匙孔按真实比例**：圆头 + 明显收窄的柄 + 圆角底，
   16px 下也能认出是钥匙孔而不是一个点。
4. **底部里加顶部柔光**，从靛蓝渐变到深紫，比纯蓝有质感。

输出 build/icon.png（256）与 build/icon.ico（七档尺寸）。
"""
import os

from PIL import Image, ImageDraw, ImageFilter

SS = 1024          # 超采样基准
FINAL = 256
OUT = os.path.join(os.path.dirname(__file__), "..", "build")

# 品牌色：靛蓝 → 深紫
BG_TOP = (40, 48, 150)
BG_BOTTOM = (74, 28, 128)
# 钥匙孔用底色的深版而不是纯黑 —— 纯黑在深色壁纸下像「洞穿了」
KEYHOLE = (44, 48, 132)


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def vertical_gradient(size, top, bottom):
    img = Image.new("RGB", (size, size), top)
    d = ImageDraw.Draw(img)
    for y in range(size):
        d.line([(0, y), (size, y)], fill=lerp(top, bottom, y / max(1, size - 1)))
    return img


def shield_points(cx, top, w, h):
    """盾牌轮廓：上边平、两侧竖直到肩部，然后收成尖底。

    肩部定在 55% 高度：太靠下像圆角矩形，太靠上像倒三角。
    """
    half = w / 2
    shoulder = top + h * 0.55
    return [
        (cx - half, top),
        (cx + half, top),
        (cx + half, shoulder),
        (cx, top + h),
        (cx - half, shoulder),
    ]


def build():
    S = SS
    cx = S / 2

    # ---- 底：纵向渐变 + 顶部柔光 ----
    bg = vertical_gradient(S, BG_TOP, BG_BOTTOM).convert("RGBA")
    soft = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(soft).ellipse(
        [-S * 0.25, -S * 0.9, S * 1.25, S * 0.40], fill=(255, 255, 255, 22)
    )
    bg = Image.alpha_composite(bg, soft.filter(ImageFilter.GaussianBlur(S * 0.04)))

    # ---- 盾牌几何 ----
    sh_w = S * 0.58
    sh_top = S * 0.175
    sh_h = S * 0.62
    pts = shield_points(cx, sh_top, sh_w, sh_h)

    # 投影：让它「浮」在底上
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    off = S * 0.012
    ImageDraw.Draw(shadow).polygon(
        [(x + off * 0.4, y + off * 2.0) for x, y in pts], fill=(10, 6, 40, 115)
    )
    bg = Image.alpha_composite(bg, shadow.filter(ImageFilter.GaussianBlur(S * 0.018)))

    # 本体：上亮下暗，像金属牌
    body_mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(body_mask).polygon(pts, fill=255)
    body = vertical_gradient(S, (255, 255, 255), (212, 220, 246)).convert("RGBA")
    bg = Image.composite(body, bg, body_mask)

    # 内侧高光边：金属倒角
    inner = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    inset = S * 0.011
    inner_pts = shield_points(cx, sh_top + inset, sh_w - inset * 2, sh_h - inset * 2)
    ImageDraw.Draw(inner).line(
        inner_pts + [inner_pts[0]], fill=(255, 255, 255, 140), width=max(2, int(S * 0.007))
    )
    inner = inner.filter(ImageFilter.GaussianBlur(S * 0.0022))
    bg = Image.alpha_composite(bg, inner)

    # ---- 盾牌上的斜向高光 ----
    #
    # 一条从左上的柔和光带。没有它，盾牌就是一个均匀的白块；
    # 有了它，同样的白色会读成「受光的金属面」。
    sheen = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sheen)
    sd.polygon(
        [
            (cx - sh_w * 0.62, sh_top - sh_h * 0.05),
            (cx + sh_w * 0.10, sh_top - sh_h * 0.05),
            (cx - sh_w * 0.20, sh_top + sh_h * 0.85),
            (cx - sh_w * 0.78, sh_top + sh_h * 0.85),
        ],
        fill=(255, 255, 255, 58),
    )
    sheen = sheen.filter(ImageFilter.GaussianBlur(S * 0.020))
    sheen.putalpha(
        Image.composite(sheen.getchannel("A"), Image.new("L", (S, S), 0), body_mask)
    )
    bg = Image.alpha_composite(bg, sheen)

    # ---- 钥匙孔：圆头 + 收窄柄 + 圆角底 ----
    #
    # 比例要点（第一版做成了「一根针」，不像钥匙孔）：
    #   * 柄不能太长：从圆头下沿到柄底，长度约等于 2.2 个圆头半径；
    #     超过 3 倍就会像图钉。
    #   * 底端要**明显**比顶端宽一点点再收圆，这样看着是「孔」而不是「棍」；
    #     但也不能等宽，等宽就回到「灯泡」了。
    r_head = S * 0.082
    ky_head = sh_top + sh_h * 0.36
    stem_top = ky_head + r_head * 0.30
    stem_bot = stem_top + r_head * 2.15
    w_top = S * 0.050
    w_bot = S * 0.042

    hole = Image.new("L", (S, S), 0)
    hd = ImageDraw.Draw(hole)
    hd.ellipse([cx - r_head, ky_head - r_head, cx + r_head, ky_head + r_head], fill=255)
    hd.polygon(
        [
            (cx - w_top / 2, stem_top),
            (cx + w_top / 2, stem_top),
            (cx + w_bot / 2, stem_bot),
            (cx - w_bot / 2, stem_bot),
        ],
        fill=255,
    )
    hd.ellipse(
        [cx - w_bot / 2, stem_bot - w_bot / 2, cx + w_bot / 2, stem_bot + w_bot / 2], fill=255
    )
    # 只在盾牌范围内挖孔
    hole = Image.composite(hole, Image.new("L", (S, S), 0), body_mask)
    bg = Image.composite(Image.new("RGBA", (S, S), KEYHOLE + (255,)), bg, hole)

    # 孔内高光：让凹陷有体积感
    hl = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(hl).ellipse(
        [cx - r_head * 0.52, ky_head - r_head * 0.70, cx + r_head * 0.02, ky_head - r_head * 0.12],
        fill=(255, 255, 255, 48),
    )
    bg = Image.alpha_composite(bg, hl.filter(ImageFilter.GaussianBlur(S * 0.004)))

    # ---- 裁成圆角方形 ----
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255
    )
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(bg, (0, 0), mask)

    os.makedirs(OUT, exist_ok=True)
    final = out.resize((FINAL, FINAL), Image.LANCZOS)
    png = os.path.join(OUT, "icon.png")
    final.save(png, "PNG")
    print("wrote", png, final.size)

    sizes = [16, 24, 32, 48, 64, 128, 256]
    ico = os.path.join(OUT, "icon.ico")
    final.save(ico, format="ICO", sizes=[(s, s) for s in sizes])
    print("wrote", ico, os.path.getsize(ico), "bytes,", len(sizes), "sizes")


if __name__ == "__main__":
    build()
