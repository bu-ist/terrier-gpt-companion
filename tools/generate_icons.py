#!/usr/bin/env python3
"""Generate the extension's PNG icons. Standard library only.

Draws a BU-scarlet rounded square with a white "T" at 4x, then box-downsamples
so the edges are antialiased. Run from the project root:

    python3 tools/generate_icons.py
"""
import os
import struct
import zlib

SIZES = (16, 48, 128)
SS = 4                        # supersampling factor
SCARLET = (204, 0, 0)         # BU scarlet
WHITE = (255, 255, 255)
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")


def rounded_square_alpha(n, radius):
    """Coverage mask for a rounded square filling an n x n grid."""
    mask = bytearray(n * n)
    for y in range(n):
        for x in range(n):
            # distance into the nearest corner arc, if any
            cx = radius - 0.5 if x < radius else (n - radius - 0.5 if x > n - radius - 1 else x)
            cy = radius - 0.5 if y < radius else (n - radius - 0.5 if y > n - radius - 1 else y)
            if (x < radius or x > n - radius - 1) and (y < radius or y > n - radius - 1):
                inside = (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
            else:
                inside = True
            mask[y * n + x] = 255 if inside else 0
    return mask


def draw_t(mask, n):
    """Punch a white 'T' into an n x n coverage mask (values become 0 = glyph)."""
    bar_h = round(n * 0.13)
    bar_w = round(n * 0.52)
    stem_w = round(n * 0.145)
    top = round(n * 0.26)
    bottom = round(n * 0.76)
    x0 = (n - bar_w) // 2
    sx0 = (n - stem_w) // 2
    glyph = set()
    for y in range(top, top + bar_h):
        for x in range(x0, x0 + bar_w):
            glyph.add((x, y))
    for y in range(top, bottom):
        for x in range(sx0, sx0 + stem_w):
            glyph.add((x, y))
    return glyph


def render(size):
    n = size * SS
    radius = max(1, round(n * 0.22))
    mask = rounded_square_alpha(n, radius)
    glyph = draw_t(mask, n)

    # Downsample to `size`, averaging each SS x SS block.
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            a_sum = r_sum = g_sum = b_sum = 0
            for dy in range(SS):
                for dx in range(SS):
                    px, py = x * SS + dx, y * SS + dy
                    a = mask[py * n + px]
                    colour = WHITE if (px, py) in glyph else SCARLET
                    a_sum += a
                    # premultiply so transparent corners don't bleed dark
                    r_sum += colour[0] * a
                    g_sum += colour[1] * a
                    b_sum += colour[2] * a
            total = SS * SS
            alpha = a_sum // total
            if a_sum:
                row += bytes((r_sum // a_sum, g_sum // a_sum, b_sum // a_sum, alpha))
            else:
                row += b"\x00\x00\x00\x00"
        rows.append(bytes(row))
    return rows


def write_png(path, rows, size):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUT_DIR, f"icon-{size}.png")
        write_png(path, render(size), size)
        print(f"wrote {path} ({size}x{size})")


if __name__ == "__main__":
    main()
