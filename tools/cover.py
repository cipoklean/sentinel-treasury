"""Sentinel cover image: 1600x900, editorial technical style.
Design memory palette: cream bg, ink, muted, rust accent in 4 places.
"""
from PIL import Image, ImageDraw, ImageFont
import random

W, H = 1600, 900
BG = (245, 241, 234)      # --bg cream
INK = (25, 22, 19)        # --ink
MUTED = (110, 103, 95)    # --muted
ACCENT = (180, 73, 10)    # --accent rust
LINE = (25, 22, 19)

FONT_DIR = r"C:\Windows\Fonts"
def f(name, size):
    return ImageFont.truetype(rf"{FONT_DIR}\{name}", size)

display = f("segoeuib.ttf", 150)
display2 = f("segoeui.ttf", 46)
mono_lg = f("consolab.ttf", 30)
mono = f("consola.ttf", 24)
mono_sm = f("consola.ttf", 20)

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# subtle grain (<=3%)
random.seed(7)
for _ in range(14000):
    x, y = random.randrange(W), random.randrange(H)
    base = img.getpixel((x, y))
    delta = random.choice((-6, -5, 5, 6))
    img.putpixel((x, y), tuple(max(0, min(255, c + delta)) for c in base))
d = ImageDraw.Draw(img)

M = 96

# eyebrow
d.text((M, 72), "// QORECHAIN-DIANA", font=mono_lg, fill=ACCENT)
d.text((M + 340, 72), " BUILD BEFORE Q-DAY  ·  ADVANCED TRACK A", font=mono, fill=MUTED)

# headline
d.text((M, 150), "SENTINEL", font=display, fill=INK)
d.text((M, 340), "the treasury agent that", font=display2, fill=INK)
d.text((M, 398), "cannot", font=display2, fill=ACCENT)
w_cannot = d.textlength("cannot", font=display2)
d.text((M + w_cannot + 16, 398), "overspend", font=display2, fill=INK)

def centered(text, cx, y, font, fill):
    d.text((cx - d.textlength(text, font=font) / 2, y), text, font=font, fill=fill)

# three nested bounds
cx, cy = 1180, 500
d.ellipse((cx - 300, cy - 300, cx + 300, cy + 300), outline=INK, width=3)
d.ellipse((cx - 215, cy - 215, cx + 215, cy + 215), outline=MUTED, width=2)
d.ellipse((cx - 140, cy - 140, cx + 140, cy + 140), outline=ACCENT, width=4)

# band labels (glyphs never under rings)
centered("SCOPED EVM WINDOW", cx, cy - 300 - 60, mono_lg, INK)
centered("allowed_targets · blocks · max_txs", cx, cy - 300 - 26, mono_sm, MUTED)
centered("SPENDING RULES", cx, cy + 168, mono, MUTED)
centered("POLICY", cx, cy + 74, mono, ACCENT)
centered("VAULT", cx, cy + 100, mono, ACCENT)

# center: the agent key
r = 58
d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=INK)
centered("AGENT", cx, cy - 14, mono_sm, BG)
centered("KEY", cx, cy + 8, mono_sm, BG)

# the drill line (left column, below the headline)
d.line((M, 540, M + 560, 540), fill=MUTED, width=1)
d.text((M, 556), "→ hand the classical key to an attacker;", font=mono_sm, fill=ACCENT)
d.text((M, 584), "  it stops at the protocol.", font=mono_sm, fill=MUTED)

# bottom strip
y = H - 110
d.line((M, y, W - M, y), fill=LINE, width=1)
d.text((M, y + 22), "ML-DSA-87", font=mono, fill=INK)
d.text((M + 210, y + 22), "0X0A01 PQCVERIFY", font=mono, fill=ACCENT)
d.text((M + 540, y + 22), "WINDOW · ABSTRACT ACCT · VAULT", font=mono_sm, fill=MUTED)
d.text((W - M - 300, y + 22), "cipoklean/sentinel-treasury", font=mono_sm, fill=MUTED)

import os
out = os.path.join(os.path.dirname(__file__), "..", "cover.png")
img.save(out)
print("wrote", os.path.abspath(out), img.size)
