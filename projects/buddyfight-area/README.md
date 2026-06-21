# Buddyfight Area — Deck Builder & Test Mode

A browser recreation of the classic **Buddyfight Area** simulator for *Future Card
Buddyfight*. Two modes, no build step, no backend — pure static HTML/CSS/JS.

- **Deck Builder** — browse all **6,573 cards** with art, filter by world / type /
  size / set / attribute / text, and assemble a deck. Enforces the standard
  rules (1 flag, 50-card main deck, max 4 copies, a buddy, flag world-legality),
  saves to `localStorage`, imports/exports decks as JSON, and exports every card
  image in the deck as a **ZIP** (one file per copy, for proxy printing).
- **Test Mode** — a manual play-test sandbox: pick a deck, draw an opening hand of
  6, gauge 2, life 10, then drag cards between zones (flag, buddy, monster areas,
  item, gauge, drop, soul, hand, deck). Double-click to rest/stand, right-click
  for actions (flip, send to deck top/bottom, shuffle in, etc.), coin flip and D6.
  Rules are **not** automated — you move cards by hand, like the original.

## Layout

```
index.html          app shell (tabs: Deck Builder / Test Mode)
app.css  app.js     UI + logic
lib/jszip.min.js    JSZip (MIT) — builds the deck-image ZIP in the browser
data/cards.json     parsed card database (id, name, text, type, world, stats, tags)
data/meta.json      world names, type names, set codes, attribute list
data/images.json    our id -> opentheflag.com "id-slug" (build-time art source)
cards/n{id}.webp    local card art — high-res scan where available, else 190px
build/              the scripts used to generate data/ and cards/ (see below)
```

## Regenerating the data

The card text and art come from the original *Buddyfight Area 1.38* install
(`Text/*.txt` GameMaker data + `CardSprite/*.png`). Those source files are **not**
committed here. To rebuild from a local copy, point the paths in `build/` at it:

```
python build/parse_cards.py      # Text/*.txt  -> data/cards.json + data/meta.json
python build/convert_images.py   # CardSprite/*.png -> cards/n{id}.webp  (needs Pillow)
python build/map_otf_images.py   # crawl opentheflag.com -> data/images.json
python build/download_hires.py   # replace matched art with opentheflag hi-res scans
```

## Card art

Most art is the **high-resolution scan** from
[opentheflag.com](https://opentheflag.com), downloaded once at build time and
baked into `cards/n{id}.webp` (up to 742px). About 88% of cards (5,836 / 6,573)
matched by name; the remaining ~12% (mostly flags and naming variants) keep the
190px image from the original install. There is **no runtime dependency** on
opentheflag — the app and the ZIP export use only the local images. Card scans
are © Bushiroad; opentheflag.com is an independent fan database.

## Notes

This is a fan-made sandbox for personal play-testing. All card names, text, and
artwork are property of Bushiroad. No rules engine is implemented — card effects
are free text, applied manually by the players.
