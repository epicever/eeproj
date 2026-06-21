#!/usr/bin/env python3
"""Download opentheflag.com high-res scans for matched cards and store as
742px WebP, replacing the low-res local images.  Resumable & polite.

Usage: python download_hires.py [LIMIT]
  LIMIT (optional) = only process the first N matched cards (for testing).

Matched cards (data/images.json) get their cards/n<ourId>.webp replaced with a
742px q82 WebP made from the opentheflag PNG.  Unmatched cards keep their
existing 190px WebP.  Re-running skips files already >=700px wide.
"""
import os, sys, io, json, time, random, threading
import urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
from PIL import Image

HERE = os.path.dirname(__file__)
DATA = os.path.join(HERE, "..", "data")
CARDS = os.path.join(HERE, "..", "cards")
OTF = "https://opentheflag.com/storage/cards"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
QUALITY = 82
MAXW = 742
WORKERS = 5

imgmap = json.load(open(os.path.join(DATA, "images.json"), encoding="utf-8"))
items = list(imgmap.items())               # (ourId, "otfId-slug")
limit = int(sys.argv[1]) if len(sys.argv) > 1 else None
if limit:
    items = items[:limit]

lock = threading.Lock()
stats = {"done": 0, "skip": 0, "fail": 0}

def already_hires(path):
    # low-res originals are exactly 190px wide; anything wider is already upgraded
    try:
        with Image.open(path) as im:
            return im.size[0] >= 300
    except Exception:
        return False

def fetch(url, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.read()
        except Exception as e:
            if i == tries - 1:
                raise
            time.sleep(0.6 * (2 ** i) + random.random() * 0.4)

def work(item):
    our_id, slug = item
    dst = os.path.join(CARDS, f"n{our_id}.webp")
    if already_hires(dst):
        with lock: stats["skip"] += 1
        return
    try:
        data = fetch(f"{OTF}/{slug}.png")
        im = Image.open(io.BytesIO(data)).convert("RGB")
        if im.size[0] > MAXW:
            h = round(im.size[1] * MAXW / im.size[0])
            im = im.resize((MAXW, h), Image.LANCZOS)
        im.save(dst, "WEBP", quality=QUALITY, method=6)
        with lock:
            stats["done"] += 1
            n = stats["done"]
        if n % 100 == 0:
            print(f"  {n} done / {stats['skip']} skip / {stats['fail']} fail "
                  f"({n + stats['skip']}/{len(items)})", file=sys.stderr)
        time.sleep(0.05 + random.random() * 0.1)
    except Exception as e:
        with lock: stats["fail"] += 1
        print(f"  FAIL n{our_id} {slug}: {e}", file=sys.stderr)

print(f"Processing {len(items)} matched cards with {WORKERS} workers…", file=sys.stderr)
with ThreadPoolExecutor(max_workers=WORKERS) as ex:
    list(ex.map(work, items))
print(f"DONE done={stats['done']} skip={stats['skip']} fail={stats['fail']}", file=sys.stderr)
