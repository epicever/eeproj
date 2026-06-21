#!/usr/bin/env python3
"""Recompress Buddyfight card art (PNG 250x347, 373MB) to mid-res WebP.

Only converts ids that exist in cards.json. Output -> ../cards/n{id}.webp
"""
import os, json, sys
from PIL import Image

SRC = r"C:/Users/vibar/Downloads/Buddyfight Area 1.38/CardSprite"
HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, "..", "cards")
WIDTH = 190
QUALITY = 72

os.makedirs(OUT, exist_ok=True)
cards = json.load(open(os.path.join(HERE, "..", "data", "cards.json"), encoding="utf-8"))
ids = [c["id"] for c in cards]

done = 0; missing = 0; skipped = 0
for i, cid in enumerate(ids):
    dst = os.path.join(OUT, f"n{cid}.webp")
    if os.path.exists(dst):
        skipped += 1; continue
    src = os.path.join(SRC, f"n{cid}.png")
    if not os.path.exists(src):
        missing += 1; continue
    try:
        im = Image.open(src).convert("RGB")
        w, h = im.size
        nh = round(h * WIDTH / w)
        im = im.resize((WIDTH, nh), Image.LANCZOS)
        im.save(dst, "WEBP", quality=QUALITY, method=4)
        done += 1
    except Exception as e:
        print(f"ERR {cid}: {e}", file=sys.stderr)
    if (i + 1) % 500 == 0:
        print(f"  {i+1}/{len(ids)} (done {done}, missing {missing})", file=sys.stderr)

print(f"DONE converted={done} skipped={skipped} missing={missing}", file=sys.stderr)
