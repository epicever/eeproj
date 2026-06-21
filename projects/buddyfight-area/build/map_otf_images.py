#!/usr/bin/env python3
"""Crawl opentheflag.com world listings to map our cards -> their high-res art.

Their pages are /world/<slug>?page=N listing /card/<id>/<name-slug> links.
Card art:  https://opentheflag.com/storage/cards/<id>-<slug>.png
Thumb:     https://opentheflag.com/storage/cards/thumbs/<id>-<slug>.png

We match our cards by a Laravel-Str::slug-compatible slug of the card name.
Output: data/images.json  ->  { "<ourId>": "<otfId>-<slug>", ... }
Cards with no match keep their local cards/n<id>.webp at runtime.
"""
import os, re, json, time, unicodedata, urllib.request, sys

HERE = os.path.dirname(__file__)
DATA = os.path.join(HERE, "..", "data")
BASE = "https://opentheflag.com"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

WORLDS = [
    "generic", "dragon-world", "magic-world", "danger-world", "darkness-dragon-world",
    "ancient-world", "hero-world", "dungeon-world", "katana-world", "legend-world",
    "star-dragon-world", "lost-world", "bio-lab-dungeon", "ragnarok",
    "bang-dream-girls-band-partypico", "detective-conan", "gegege-no-kitaro",
    "medabots", "ssssgridman", "sword-art-online",
    "the-idolm-at-ster-cinderella-girls-theater",
]

LINK_RE = re.compile(r'/card/(\d+)/([a-z0-9-]+)')

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")

def slugify(name):
    s = name.replace("@", " at ")
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    s = s.replace("'", "").replace("`", "")
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s

def crawl():
    by_slug = {}   # slug -> "id-slug" (first/lowest id wins for stability)
    for w in WORLDS:
        page, seen_pages = 1, 0
        prev = None
        while True:
            url = f"{BASE}/world/{w}?page={page}"
            try:
                html = fetch(url)
            except Exception as e:
                print(f"  {w} p{page} ERR {e}", file=sys.stderr); break
            links = LINK_RE.findall(html)
            uniq = sorted(set(links), key=lambda t: int(t[0]))
            if not uniq or uniq == prev:
                break
            for cid, slug in uniq:
                by_slug.setdefault(slug, f"{cid}-{slug}")
            prev = uniq
            print(f"  {w} p{page}: {len(uniq)} cards (total slugs {len(by_slug)})", file=sys.stderr)
            page += 1; seen_pages += 1
            if seen_pages > 80:  # safety
                break
            time.sleep(0.25)
    return by_slug

def main():
    print("Crawling opentheflag worlds…", file=sys.stderr)
    by_slug = crawl()
    print(f"Collected {len(by_slug)} unique card slugs", file=sys.stderr)

    cards = json.load(open(os.path.join(DATA, "cards.json"), encoding="utf-8"))
    out, miss = {}, []
    for c in cards:
        s = slugify(c.get("name", ""))
        if s in by_slug:
            out[str(c["id"])] = by_slug[s]
        else:
            miss.append((c["id"], c.get("name", "")))

    json.dump(out, open(os.path.join(DATA, "images.json"), "w", encoding="utf-8"),
              ensure_ascii=False, separators=(",", ":"))
    matched = len(out)
    print(f"\nMatched {matched}/{len(cards)} ({matched*100//len(cards)}%)", file=sys.stderr)
    print(f"Unmatched: {len(miss)} (keep local webp)", file=sys.stderr)
    for cid, nm in miss[:40]:
        print(f"   miss {cid}: {nm} -> {slugify(nm)}", file=sys.stderr)
    # save miss list for image pruning
    json.dump([m[0] for m in miss], open(os.path.join(DATA, "_unmatched_ids.json"), "w"),
              separators=(",", ":"))

if __name__ == "__main__":
    main()
