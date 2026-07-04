from PIL import Image, ImageChops, ImageDraw, ImageFilter
import math
import random

random.seed(42)

W, H = 1000, 600
CX, CY = W // 2, H // 2
RX, RY = 430, 230


def inside_ellipse(x, y):
    return ((x - CX) / RX) ** 2 + ((y - CY) / RY) ** 2 <= 1.0


def ellipse_falloff(x, y):
    d = math.sqrt(((x - CX) / RX) ** 2 + ((y - CY) / RY) ** 2)
    return max(0.0, 1.0 - d ** 2.4)


# ---------- Stamp texture ----------
# Build the brush mask as grayscale first, then promote to RGBA so the
# shader can sample the alpha channel as the stamp mask.
stamp_gray = Image.new("L", (W, H), 0)
draw = ImageDraw.Draw(stamp_gray, "L")

# Bright soft base
for y in range(H):
    for x in range(W):
        if inside_ellipse(x, y):
            stamp_gray.putpixel((x, y), int(ellipse_falloff(x, y) * 235 + 20))

# Natural flat-bristle strokes: mostly horizontal, slight curve, parallel-ish
num_bristles = 350
for _ in range(num_bristles):
    # Pick a y position biased toward center
    t = random.random() * 2 - 1
    y = CY + t * RY * (abs(t) ** 0.4)

    # Horizontal extent at this y
    if abs(y - CY) >= RY:
        continue
    x_extent = RX * math.sqrt(1 - ((y - CY) / RY) ** 2)
    x = CX + random.uniform(-x_extent * 0.9, x_extent * 0.9)

    if not inside_ellipse(x, y):
        continue

    length = random.uniform(60, 160) * (0.5 + 0.5 * ellipse_falloff(x, y))
    thickness = random.randint(1, 3)
    opacity = int(random.uniform(30, 90) * ellipse_falloff(x, y))

    # Slight random angle and curve
    angle = random.gauss(0, 0.08)
    curve = random.gauss(0, 8)

    x1 = x - math.cos(angle) * length * 0.5
    y1 = y - math.sin(angle) * length * 0.5
    x2 = x + math.cos(angle) * length * 0.5
    y2 = y + math.sin(angle) * length * 0.5
    xc = (x1 + x2) / 2 + curve
    yc = (y1 + y2) / 2 + random.gauss(0, 4)

    draw.line([(x1, y1), (xc, yc), (x2, y2)], fill=opacity, width=thickness, joint="curve")

# Very subtle noise
noise = Image.effect_noise((W, H), 8).convert("L")
noise = noise.point(lambda p: p - 128)
stamp_gray = Image.blend(stamp_gray, ImageChops.add(stamp_gray, noise), 0.04)

# Light blur for natural edges
stamp_gray = stamp_gray.filter(ImageFilter.GaussianBlur(radius=1.0))

stamp_rgba = Image.merge("RGBA", (stamp_gray, stamp_gray, stamp_gray, stamp_gray))
stamp_rgba.save("src/assets/brush-stamp.png")

# ---------- Outline mask ----------
# Build a clean outer outline from a filled ellipse, then store it in the
# alpha channel so CSS masking uses the shape rather than the rectangle.
outline_gray = Image.new("L", (W, H), 0)
outline_draw = ImageDraw.Draw(outline_gray)
outline_draw.ellipse([CX - RX, CY - RY, CX + RX, CY + RY], fill=255)
inner = Image.new("L", (W, H), 0)
inner_draw = ImageDraw.Draw(inner)
inner_draw.ellipse([CX - RX + 10, CY - RY + 10, CX + RX - 10, CY + RY - 10], fill=255)
outline_gray = ImageChops.subtract(outline_gray, inner)
outline_gray = outline_gray.filter(ImageFilter.GaussianBlur(radius=0.5))

white = Image.new("L", (W, H), 255)
outline_rgba = Image.merge("RGBA", (white, white, white, outline_gray))
outline_rgba.save("src/assets/brush-stamp-outline.png")

print("Generated brush-stamp.png and brush-stamp-outline.png")
