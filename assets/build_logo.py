import math, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.join(HERE, "fonts")

TILE = 300
PAD = 60
DPADS = TILE + PAD * 2

LETTERS = [
    dict(ch="R", font="AlfaSlabOne.ttf",  size=205, tile="#A9D3EE", ink="#B83B3B",
         accent="#77ADD6", edge="dots",    rot=-7, dy=-6,  tape=None),
    dict(ch="C", font="AbrilFatface.ttf", size=210, tile="#F2C4D4", ink="#9E2B4E",
         accent="#CE7C97", edge="stitch",  rot=5,  dy=18,  tape="blue"),
    dict(ch="h", font="BreeSerif.ttf",    size=225, tile="#F8D2A6", ink="#A5622A",
         accent="#C9884A", edge="scallop", rot=-3, dy=-2,  tape=None),
    dict(ch="a", font="SpecialElite.ttf", size=205, tile="#CDBBEE", ink="#5B3D95",
         accent="#A78FD6", edge="stitch",  rot=6,  dy=16,  tape="kraft"),
    dict(ch="t", font="Anton.ttf",        size=235, tile="#BFE3BF", ink="#2F7D3F",
         accent="#86BE93", edge="dots",    rot=-5, dy=-4,  tape=None),
]


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def perimeter_points(box, r, spacing):
    x0, y0, x1, y1 = box
    pts = []
    edges = [((x0 + r, y0), (x1 - r, y0)), ((x1, y0 + r), (x1, y1 - r)),
             ((x1 - r, y1), (x0 + r, y1)), ((x0, y1 - r), (x0, y0 + r))]
    for (ax, ay), (bx, by) in edges:
        dist = math.hypot(bx - ax, by - ay)
        n = max(1, int(dist // spacing))
        ang = math.atan2(by - ay, bx - ax)
        for i in range(n + 1):
            t = i / n
            pts.append((ax + (bx - ax) * t, ay + (by - ay) * t, ang))
    corners = [((x1 - r, y0 + r), -90, 0), ((x1 - r, y1 - r), 0, 90),
               ((x0 + r, y1 - r), 90, 180), ((x0 + r, y0 + r), 180, 270)]
    for (cx, cy), a0, a1 in corners:
        n = max(1, int(abs(a1 - a0) * math.pi / 180 * r // spacing))
        for i in range(n + 1):
            a = math.radians(a0 + (a1 - a0) * i / n)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a), a + math.pi / 2))
    return pts


def paper(size, color):
    base = Image.new("RGB", size, color)
    noise = Image.effect_noise(size, 22).convert("RGB")
    grain = Image.blend(base, ImageChops.overlay(base, noise), 0.35)
    shade = Image.new("L", size, 0)
    d = ImageDraw.Draw(shade)
    d.ellipse([-size[0] // 3, -size[1] // 3, size[0], size[1]], fill=60)
    shade = shade.filter(ImageFilter.GaussianBlur(size[0] // 4))
    dark = ImageChops.multiply(grain, Image.new("RGB", size, (205, 205, 205)))
    return Image.composite(grain, dark, ImageChops.invert(shade))


def build_tile(spec):
    img = Image.new("RGBA", (DPADS, DPADS), (0, 0, 0, 0))
    box = [PAD, PAD, PAD + TILE, PAD + TILE]
    r = 30
    mask = Image.new("L", (DPADS, DPADS), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle(box, radius=r, fill=255)
    if spec["edge"] == "scallop":
        bump = TILE // 11
        for px, py, _ in perimeter_points(box, r, bump * 2):
            md.ellipse([px - bump, py - bump, px + bump, py + bump], fill=255)

    tile = paper((DPADS, DPADS), hex_rgb(spec["tile"]))
    img.paste(tile, (0, 0), mask)

    d = ImageDraw.Draw(img)
    ib = [PAD + 20, PAD + 20, PAD + TILE - 20, PAD + TILE - 20]
    ac = hex_rgb(spec["accent"])
    if spec["edge"] == "dots":
        for px, py, _ in perimeter_points(ib, r, 26):
            d.ellipse([px - 5, py - 5, px + 5, py + 5], fill=ac + (255,))
    elif spec["edge"] == "stitch":
        for px, py, ang in perimeter_points(ib, r, 30):
            dx, dy = math.cos(ang) * 11, math.sin(ang) * 11
            d.line([px - dx, py - dy, px + dx, py + dy], fill=ac + (255,), width=5)

    font = ImageFont.truetype(os.path.join(FONTS, spec["font"]), spec["size"])
    ch = spec["ch"]
    tb = d.textbbox((0, 0), ch, font=font)
    tw, th = tb[2] - tb[0], tb[3] - tb[1]
    lx = PAD + (TILE - tw) / 2 - tb[0]
    ly = PAD + (TILE - th) / 2 - tb[1] + spec["dy"]
    d.text((lx + 3, ly + 4), ch, font=font, fill=(0, 0, 0, 55))
    d.text((lx, ly), ch, font=font, fill=hex_rgb(spec["ink"]) + (255,))

    if spec["tape"]:
        img.alpha_composite(make_tape(spec["tape"]))
    return img.rotate(spec["rot"], resample=Image.BICUBIC, expand=True)


def make_tape(kind):
    w, h = 150, 62
    t = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(t)
    if kind == "blue":
        d.rectangle([0, 0, w, h], fill=(150, 197, 224, 205))
        for x in range(0, w, 12):
            d.rectangle([x, 0, x + 6, h], fill=(120, 176, 210, 205))
    else:
        d.rectangle([0, 0, w, h], fill=(210, 180, 138, 210))
        for x in range(6, w, 14):
            d.line([x, 0, x, h], fill=(188, 156, 112, 210), width=2)
    layer = Image.new("RGBA", (DPADS, DPADS), (0, 0, 0, 0))
    tp = t.rotate(-32, resample=Image.BICUBIC, expand=True)
    layer.alpha_composite(tp, (PAD + 118, PAD - 30))
    return layer


def shadow_of(tile):
    sil = tile.split()[3].point(lambda a: min(a, 120))
    shadow = Image.new("RGBA", tile.size, (0, 0, 0, 0))
    shadow.paste((40, 30, 40, 255), (0, 0), sil)
    return shadow.filter(ImageFilter.GaussianBlur(11))


def build_r():
    tile = build_tile(LETTERS[0])
    canvas = Image.new("RGBA", (tile.width + 60, tile.height + 60), (0, 0, 0, 0))
    canvas.alpha_composite(shadow_of(tile), (36, 46))
    canvas.alpha_composite(tile, (30, 30))
    bbox = canvas.getbbox()
    canvas = canvas.crop((bbox[0] - 10, bbox[1] - 10, bbox[2] + 10, bbox[3] + 10))
    out = os.path.join(HERE, "rchat_r.png")
    canvas.save(out)
    print("wrote", out, canvas.size)


def main():
    tiles = [build_tile(s) for s in LETTERS]
    step = 322
    x = 200
    cy = 400
    W = x + step * (len(tiles) - 1) + DPADS - PAD
    H = 820
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    for i, (tile, spec) in enumerate(zip(tiles, LETTERS)):
        cx = x + step * i
        top = (cy - tile.height // 2)
        shadow = shadow_of(tile)
        canvas.alpha_composite(shadow, (cx - tile.width // 2 + 6, top + 16))
        canvas.alpha_composite(tile, (cx - tile.width // 2, top))
    bbox = canvas.getbbox()
    canvas = canvas.crop((bbox[0] - 20, bbox[1] - 20, bbox[2] + 20, bbox[3] + 20))
    out = os.path.join(HERE, "rchat_logo.png")
    canvas.save(out)
    print("wrote", out, canvas.size)


if __name__ == "__main__":
    main()
    build_r()
