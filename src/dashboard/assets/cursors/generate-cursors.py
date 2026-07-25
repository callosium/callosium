#!/usr/bin/env python3
"""Generate the Callosium dashboard "COIN OP" 8-bit cursor set.

Recreates the owner's reference arcade cursor set as crisp 32x32 pixel art:
black outline, hot pink fill, mint secondary outline, dark cores, halftone
pink stipple accents. Every cursor is written twice:

    <name>.png       32x32  (the 1x runtime art)
    <name>@2x.png    64x64  (nearest-neighbour upscale, retina sharpness)

The runtime path is CSS data-URIs: this script also rewrites the block between
/* __CURSORS_START__ */ and /* __CURSORS_END__ */ in ../../ui.html.base with
the freshly encoded images + hotspots, and writes cursors.css alongside the
PNGs for provenance. Re-run after editing the art:

    python src/dashboard/assets/cursors/generate-cursors.py
    node src/dashboard/build-ui.mjs

Hotspots (32x32 coordinate space): arrow tip ~ (1,1), hand fingertip (10,1),
I-beams dead center, busy arrow tip, resize/disabled center.
"""
import base64
import io
import os
import re
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
UI_BASE = os.path.normpath(os.path.join(HERE, '..', '..', 'ui.html.base'))

# ── palette (sampled from the reference; pink/mint/dark are the brand hexes) ──
PINK   = (0xFF, 0x2E, 0x88, 255)   # hot pink fill
MINT   = (0x4F, 0xE0, 0xB5, 255)   # mint outline / secondary
DARK   = (0x1B, 0x1C, 0x30, 255)   # dark core fill
BLACK  = (0x0B, 0x0A, 0x14, 255)   # near-black outline (reads black at size)
STIP   = (0xC4, 0x13, 0x67, 255)   # halftone dark-pink stipple inside pink

W = H = 32

# ── pixel helpers ─────────────────────────────────────────────────────────────

def poly_fill(pts, w=W, h=H):
    """Even-odd scanline fill over pixel CENTERS: classic cursor jaggies."""
    inside = set()
    n = len(pts)
    for y in range(h):
        for x in range(w):
            cx, cy = x + 0.5, y + 0.5
            inn = False
            j = n - 1
            for i in range(n):
                xi, yi = pts[i]
                xj, yj = pts[j]
                if (yi > cy) != (yj > cy) and cx < (xj - xi) * (cy - yi) / (yj - yi) + xi:
                    inn = not inn
                j = i
            if inn:
                inside.add((x, y))
    return inside


def outline_of(fill, w=W, h=H):
    """1px 8-neighbour dilation ring around a fill set."""
    out = set()
    for (x, y) in fill:
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                p = (x + dx, y + dy)
                if p not in fill and 0 <= p[0] < w and 0 <= p[1] < h:
                    out.add(p)
    return out


class Art:
    """A 32x32 RGBA pixel canvas addressed by integer art pixels."""
    def __init__(self):
        self.px = {}

    def set(self, x, y, c):
        if 0 <= x < W and 0 <= y < H:
            self.px[(x, y)] = c

    def paint(self, cells, c):
        for (x, y) in cells:
            self.set(x, y, c)

    def image(self, scale=1):
        im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        for (x, y), c in self.px.items():
            im.putpixel((x, y), c)
        if scale != 1:
            im = im.resize((W * scale, H * scale), Image.NEAREST)
        return im


def arrow_art(tail_mint=True, left_mint=False):
    """The shared arrow silhouette. tip at (1,1)."""
    fill = poly_fill([(1, 1), (1, 22), (6, 17), (9, 17), (14, 26), (17, 24), (12, 15), (19, 15)])
    ring = outline_of(fill)
    a = Art()
    a.paint(ring, BLACK)
    a.paint(fill, PINK)
    if tail_mint:
        # mint edge along the tail's lower/right outline (reference accent)
        for (x, y) in sorted(ring):
            if y >= 22 or (x >= 15 and y >= 18):
                a.set(x, y, MINT)
        # and just the outermost pixel pair capping the tail tip
        for (x, y) in sorted(fill):
            if x >= 14 and y >= 24:
                a.set(x, y, MINT)
    if left_mint:
        # busy: the "mint underline mark", the whole left edge goes mint
        for (x, y) in sorted(ring):
            if x <= 1 and 2 <= y <= 22:
                a.set(x, y, MINT)
    return a


def hand_art():
    """Pointing hand: mint outline, dark fist, pink index finger with halftone
    stipple, pink stipple thumb patch, halftone pink shading bottom-right.
    Fingertip at (10,1)."""
    body = set()
    body |= {(x, y) for x in range(9, 13) for y in range(1, 16)}    # index finger
    body |= {(x, y) for x in range(14, 18) for y in range(8, 16)}   # middle finger
    body |= {(x, y) for x in range(19, 23) for y in range(9, 16)}   # ring finger
    body |= {(x, y) for x in range(24, 27) for y in range(11, 16)}  # pinky
    body |= {(x, y) for x in range(7, 28) for y in range(14, 28)}   # fist
    body |= poly_fill([(2, 16), (8, 14), (10, 18), (7, 23), (2, 21)])  # thumb
    # knuckle notches between the fingers (bite back into the body top edge)
    body -= {(13, y) for y in range(8, 12)}
    body -= {(18, y) for y in range(9, 12)}
    body -= {(23, y) for y in range(11, 13)}
    ring = outline_of(body)
    a = Art()
    a.paint(ring, MINT)
    a.paint(body, DARK)
    # pink index finger (top of the finger) with a halftone stipple column
    for (x, y) in sorted(body):
        if 9 <= x <= 12 and y <= 9:
            a.set(x, y, PINK)
    for (x, y) in sorted(body):
        if 10 <= x <= 11 and 3 <= y <= 9 and (x + y) % 2 == 0:
            a.set(x, y, STIP)
    # stipple fade where the pink finger meets the dark hand
    for (x, y) in sorted(body):
        if 9 <= x <= 12 and 10 <= y <= 11 and (x + y) % 2 == 1:
            a.set(x, y, STIP)
    # thumb tip stipple patch (pink with dark dots)
    for (x, y) in sorted(body):
        if 3 <= x <= 5 and 16 <= y <= 19:
            a.set(x, y, STIP if (x + y) % 2 == 0 else PINK)
    # halftone pink shading, dense bottom-right, fading up-left
    for (x, y) in sorted(body):
        if 15 <= x <= 27 and 19 <= y <= 27:
            density = max(0.0, min(0.4, (x + y - 38) / 30.0))
            if ((x * 7 + y * 13) % 9) / 9.0 < density:
                a.set(x, y, PINK)
    return a


def ibeam_art(solid):
    """I-beam. solid=True: all-mint I (text edit). solid=False: mint outline
    around a dark core stem (outlined I). Hotspot dead center."""
    bars = {(x, y) for x in range(10, 22) for y in list(range(4, 7)) + list(range(25, 28))}
    stem = {(x, y) for x in range(14, 18) for y in range(6, 26)}
    fill = bars | stem
    ring = outline_of(fill)
    a = Art()
    a.paint(ring, BLACK)
    a.paint(fill, MINT)
    if not solid:
        for (x, y) in sorted(stem):
            if 15 <= x <= 16 and 7 <= y <= 24:
                a.set(x, y, DARK)
    return a


def move_art():
    """Disabled/Move: 4-arrow cross, pink, black outline, dark core in each
    shaft (the reference's 'disabled' look). Hotspot center."""
    up    = poly_fill([(15, 3), (20, 9), (11, 9)]) | {(x, y) for x in range(13, 18) for y in range(9, 14)}
    down  = poly_fill([(15, 28), (20, 22), (11, 22)]) | {(x, y) for x in range(13, 18) for y in range(17, 23)}
    left  = poly_fill([(3, 15), (9, 10), (9, 20)]) | {(x, y) for x in range(9, 14) for y in range(13, 18)}
    right = poly_fill([(28, 15), (22, 10), (22, 20)]) | {(x, y) for x in range(17, 23) for y in range(13, 18)}
    center = {(x, y) for x in range(13, 18) for y in range(13, 18)}
    fill = up | down | left | right | center
    ring = outline_of(fill)
    a = Art()
    a.paint(ring, BLACK)
    a.paint(fill, PINK)
    # dark cores inside each shaft
    a.paint({(x, y) for x in range(14, 17) for y in range(10, 13)}, DARK)   # up shaft
    a.paint({(x, y) for x in range(14, 17) for y in range(18, 21)}, DARK)   # down shaft
    a.paint({(x, y) for x in range(10, 13) for y in range(14, 17)}, DARK)   # left shaft
    a.paint({(x, y) for x in range(18, 21) for y in range(14, 17)}, DARK)   # right shaft
    return a


def resize_art(horizontal):
    """Resize double arrow: pink, black outline, mint strip inside the shaft.
    Hotspot center."""
    if horizontal:
        heads = poly_fill([(2, 15), (8, 9), (8, 21)]) | poly_fill([(29, 15), (23, 9), (23, 21)])
        shaft = {(x, y) for x in range(8, 23) for y in range(13, 18)}
        mint_strip = {(x, y) for x in range(9, 22) for y in range(14, 16)}
        caps = {(8, y) for y in range(12, 19)} | {(23, y) for y in range(12, 19)}
    else:
        heads = poly_fill([(15, 2), (9, 8), (21, 8)]) | poly_fill([(15, 29), (9, 23), (21, 23)])
        shaft = {(x, y) for x in range(13, 18) for y in range(8, 23)}
        mint_strip = {(x, y) for x in range(14, 16) for y in range(9, 22)}
        caps = {(x, 8) for x in range(12, 19)} | {(x, 23) for x in range(12, 19)}
    fill = heads | shaft
    ring = outline_of(fill)
    a = Art()
    a.paint(ring, BLACK)
    a.paint(fill, PINK)
    a.paint(mint_strip & fill, MINT)
    a.paint(caps & fill, MINT)
    return a


# name → (art, hotspot x, hotspot y)
CURSORS = {
    'pointer':    (arrow_art(tail_mint=True, left_mint=False), 1, 1),
    'link':       (hand_art(), 10, 1),
    'ibeam':      (ibeam_art(solid=False), 15, 15),
    'ibeam-text': (ibeam_art(solid=True), 15, 15),
    'busy':       (arrow_art(tail_mint=True, left_mint=True), 1, 1),
    'disabled':   (move_art(), 15, 15),
    'resize-h':   (resize_art(horizontal=True), 15, 15),
    'resize-v':   (resize_art(horizontal=False), 15, 15),
}


def data_uri(im):
    buf = io.BytesIO()
    im.save(buf, format='PNG', optimize=True)
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')


def css_block(uris):
    """The @media (pointer:fine) cursor wiring. Data-URIs are emitted ONCE as
    custom properties (1x + 2x), then each role gets three declarations:
    plain-url fallback, -webkit-image-set, image-set. Later declarations win
    where supported; invalid ones are dropped per CSS error handling.
    Order matters: disabled after the link catch-all, busy last (it wins)."""
    v = {name: name.replace('-', '') for name in CURSORS}
    def decl(name, imp):
        n = v[name]
        x, y = CURSORS[name][1], CURSORS[name][2]
        bang = '!important' if imp else ''
        return (f'cursor:var(--cu-{n}1) {x} {y},FALLBACK{bang};'
                f'cursor:-webkit-image-set(var(--cu-{n}1) 1x,var(--cu-{n}2) 2x) {x} {y},FALLBACK{bang};'
                f'cursor:image-set(var(--cu-{n}1) 1x,var(--cu-{n}2) 2x) {x} {y},FALLBACK{bang};')
    lines = []
    lines.append('@media (pointer:fine){')
    lines.append('  :root{')
    for name in CURSORS:
        n = v[name]
        lines.append(f'    --cu-{n}1:url("{uris[(name, 1)]}");')
        lines.append(f'    --cu-{n}2:url("{uris[(name, 2)]}");')
    lines.append('  }')
    # default app cursor
    lines.append('  html,body{' + decl('pointer', False).replace('FALLBACK', 'auto') + '}')
    # anything clickable gets the pointing hand (!important beats the many
    # serialized inline cursor:pointer styles in this codebase)
    link_sel = ('a,button,[role="button"],summary,input[type="submit"],input[type="button"],'
                'input[type="checkbox"],input[type="radio"],select,[style*="cursor:pointer"],[style*="cursor: pointer"]')
    lines.append(f'  {link_sel}' + '{' + decl('link', True).replace('FALLBACK', 'pointer') + '}')
    # editable text gets the solid I
    text_sel = ('input[type="text"],input[type="search"],input[type="email"],input[type="password"],'
                'input[type="url"],input[type="tel"],input[type="number"],input:not([type]),textarea,'
                '[contenteditable="true"],[contenteditable=""]')
    lines.append(f'  {text_sel}' + '{' + decl('ibeam-text', True).replace('FALLBACK', 'text') + '}')
    # selectable-but-readonly text (terminal feeds, config boxes, code) gets the outlined I
    lines.append('  pre,code,kbd,samp{' + decl('ibeam', False).replace('FALLBACK', 'text') + '}')
    # disabled controls get the disabled cross (after the link rule so it wins ties)
    dis_sel = 'button:disabled,input:disabled,textarea:disabled,select:disabled,[disabled],[aria-disabled="true"]'
    lines.append(f'  {dis_sel}' + '{' + decl('disabled', True).replace('FALLBACK', 'not-allowed') + '}')
    # busy during re-index / health runs (body.is-busy is toggled by those flows)
    lines.append('  body.is-busy,body.is-busy *{' + decl('busy', True).replace('FALLBACK', 'progress') + '}')
    lines.append('}')
    return '\n  '.join(lines)


def main():
    uris = {}
    sheet_cells = []
    for name, (art, hx, hy) in CURSORS.items():
        im1 = art.image(1)
        im2 = art.image(2)
        im1.save(os.path.join(HERE, f'{name}.png'), optimize=True)
        im2.save(os.path.join(HERE, f'{name}@2x.png'), optimize=True)
        uris[(name, 1)] = data_uri(im1)
        uris[(name, 2)] = data_uri(im2)
        sheet_cells.append((name, art.image(8)))
        print(f'{name:11s} px={len(art.px):4d} hotspot=({hx},{hy})  1x={len(uris[(name,1)])}c  2x={len(uris[(name,2)])}c')

    # contact sheet for visual review (8x, over dark + light)
    pad, cw, ch = 24, 8 * W, 8 * H
    cols = len(sheet_cells)
    for bg, suffix in (((7, 6, 11, 255), 'dark'), ((245, 242, 238, 255), 'light')):
        sheet = Image.new('RGBA', (cols * (cw + pad) + pad, ch + 2 * pad), bg)
        for i, (name, big) in enumerate(sheet_cells):
            sheet.paste(big, (pad + i * (cw + pad), pad), big)
        sheet.save(os.path.join(HERE, f'contact-sheet-{suffix}.png'))
    print('contact sheets written')

    block = css_block(uris)
    with open(os.path.join(HERE, 'cursors.css'), 'w') as f:
        f.write('/* generated by generate-cursors.py, do not edit by hand */\n  ' + block + '\n')

    src = open(UI_BASE, encoding='utf-8').read()
    pat = re.compile(r'/\* __CURSORS_START__ \*/.*?/\* __CURSORS_END__ \*/', re.S)
    repl = '/* __CURSORS_START__ */\n  ' + block + '\n  /* __CURSORS_END__ */'
    if not pat.search(src):
        sys.exit('cursor markers missing in ui.html.base')
    # ui.html.base is a pure-CRLF file: round-trip with CRLF so the diff stays minimal
    open(UI_BASE, 'w', encoding='utf-8', newline='\r\n').write(pat.sub(lambda _: repl, src))
    print(f'ui.html.base cursor block updated ({len(block)} chars)')


if __name__ == '__main__':
    main()
