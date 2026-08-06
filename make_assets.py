#!/usr/bin/env python3
"""Generate icon + splash source assets for @capacitor/assets.
Brand: gold (#FFD700) derrick + water drop on near-black (#0A0A0A)."""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = "/root/wwdm/assets"
os.makedirs(OUT, exist_ok=True)

GOLD = (255, 215, 0, 255)
GOLD_DK = (230, 184, 0, 255)
BLACK = (10, 10, 10, 255)
SS = 4  # supersample factor


def find_font(size, bold=True):
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ]
    for c in candidates:
        if os.path.exists(c):
            try:
                return ImageFont.truetype(c, size)
            except Exception:
                pass
    return ImageFont.load_default()


def draw_mark(size, pad_frac=0.0, color=GOLD):
    """Return an RGBA image (size x size, transparent) with the derrick+drop mark.
    pad_frac shrinks the mark toward the center (for adaptive-icon safe zone)."""
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Work in a 1024 design space, then scale.
    scale = S / 1024.0
    inset = pad_frac  # fraction to shrink
    cx = 512.0

    def P(x, y):
        # apply centered scaling for padding, then supersample scale
        nx = cx + (x - cx) * (1 - inset)
        ny = cx + (y - cx) * (1 - inset)
        return (nx * scale, ny * scale)

    def line(p1, p2, w):
        d.line([P(*p1), P(*p2)], fill=color, width=max(1, int(w * (1 - inset) * scale)),
               joint="curve")

    # Derrick legs
    line((512, 200), (348, 792), 34)
    line((512, 200), (676, 792), 34)
    # crown block
    line((476, 200), (548, 200), 34)
    # horizontal cross braces
    line((430, 356), (594, 356), 20)
    line((404, 502), (620, 502), 20)
    line((378, 648), (646, 648), 20)
    # X braces
    for (a, b, c, e) in [
        (476, 200, 594, 356), (548, 200, 430, 356),
        (430, 356, 620, 502), (594, 356, 404, 502),
        (404, 502, 646, 648), (620, 502, 378, 648),
    ]:
        line((a, b), (c, e), 12)
    # ground line
    line((288, 792), (736, 792), 34)

    # Water drop: circle bulb + triangle point
    bulb_c = (512, 812)
    r = 66
    tip = (512, 686)
    # tangent-ish upper points on the circle
    left = (512 - r * 0.86, 812 - r * 0.5)
    right = (512 + r * 0.86, 812 - r * 0.5)
    # bulb
    bc = P(*bulb_c)
    rr = r * (1 - inset) * scale
    d.ellipse([bc[0] - rr, bc[1] - rr, bc[0] + rr, bc[1] + rr], fill=color)
    # top triangle
    d.polygon([P(*tip), P(*left), P(*right)], fill=color)

    return img.resize((size, size), Image.LANCZOS)


def radial_bg(size, base=BLACK, glow=(60, 50, 10)):
    """Black background with a subtle warm radial glow behind the mark."""
    S = size
    img = Image.new("RGBA", (S, S), base)
    px = img.load()
    cx = cy = S / 2.0
    maxd = (S / 2.0) * 1.05
    for y in range(S):
        for x in range(S):
            dx, dy = x - cx, y - cy
            dist = (dx * dx + dy * dy) ** 0.5
            t = max(0.0, 1.0 - dist / maxd)
            t = t * t
            r = int(base[0] + glow[0] * t)
            g = int(base[1] + glow[1] * t)
            b = int(base[2] + glow[2] * t)
            px[x, y] = (r, g, b, 255)
    return img


# --- Adaptive icon pieces ---
# Foreground: mark with generous safe-zone padding (adaptive icons crop ~25%).
fg = draw_mark(1024, pad_frac=0.30)
fg.save(f"{OUT}/icon-foreground.png")

# Background: warm radial glow on black.
bg = radial_bg(1024)
bg.save(f"{OUT}/icon-background.png")

# icon-only / logo: full legacy icon = background + mark (less padding).
legacy = radial_bg(1024).convert("RGBA")
legacy.alpha_composite(draw_mark(1024, pad_frac=0.14))
legacy.save(f"{OUT}/icon-only.png")
legacy.save(f"{OUT}/logo.png")

# --- Splash screens (2732x2732, mark centered ~ 900px) ---
def make_splash(path):
    S = 2732
    img = radial_bg(S, glow=(45, 38, 8)).convert("RGBA")
    mark = draw_mark(900, pad_frac=0.0)
    img.alpha_composite(mark, ((S - 900) // 2, (S - 900) // 2 - 120))
    d = ImageDraw.Draw(img)
    f1 = find_font(150, bold=True)
    f2 = find_font(70, bold=False)
    t1 = "WATER WELL"
    t2 = "MANAGER"
    sub = "DRILL-PRO"
    def center(text, font, y):
        bb = d.textbbox((0, 0), text, font=font)
        w = bb[2] - bb[0]
        d.text(((S - w) // 2, y), text, font=font, fill=GOLD)
    center(t1, f1, 1720)
    center(t2, f1, 1890)
    # subtitle in muted gold
    bb = d.textbbox((0, 0), sub, font=f2)
    w = bb[2] - bb[0]
    d.text(((S - w) // 2, 2090), sub, font=f2, fill=(180, 150, 40, 255))
    img.convert("RGB").save(path)

make_splash(f"{OUT}/splash.png")
make_splash(f"{OUT}/splash-dark.png")

print("Assets written to", OUT)
for fn in sorted(os.listdir(OUT)):
    p = os.path.join(OUT, fn)
    print(" ", fn, Image.open(p).size)
