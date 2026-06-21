#!/usr/bin/env python3
"""Parse Buddyfight Area GameMaker `Text/*.txt` card data into cards.json.

Source: C:/Users/vibar/Downloads/Buddyfight Area 1.38/Text/*.txt
Each card block looks like:

    CardStat = 446
    {
    global.CardName[CardStat] = "Astral Force"
    global.CardText[CardStat] = "line1
    line2 "+chr(171)+"Armordragon"+chr(187)+" tail"
    global.CardType[CardStat] = 3
    global.Dragon[CardStat] = 1
    }

Card* fields are typed; every other flag is a binary tag (attribute or set code).
"""
import os, re, json, sys

SRC = r"C:/Users/vibar/Downloads/Buddyfight Area 1.38/Text"
OUT = os.path.join(os.path.dirname(__file__), "..", "data")

CARD_FIELDS = {
    "CardName": "name", "CardText": "text", "CardFlavor": "flavor",
    "CardType": "type", "CardWorld": "world", "CardWorld2": "world2",
    "CardPower": "power", "CardCrit": "crit", "CardDefense": "defense",
    "CardSize": "size",
}
NUM_FIELDS = {"type", "world", "world2", "power", "crit", "defense", "size"}

TYPE_NAMES = {1: "Monster", 2: "Item", 3: "Spell", 4: "Impact", 5: "Flag"}

# value evaluator: GML string expr of "..." and chr(N) joined by +
tok_re = re.compile(r'"([^"]*)"|chr\((\d+)\)')

def eval_value(raw):
    raw = raw.strip()
    # pure integer?
    if re.fullmatch(r"-?\d+", raw):
        return int(raw)
    # string expression
    out = []
    for m in tok_re.finditer(raw):
        if m.group(1) is not None:
            out.append(m.group(1))
        else:
            out.append(chr(int(m.group(2))))
    return "".join(out)

block_re = re.compile(r"CardStat\s*=\s*(\d+)\s*\{(.*?)\}", re.S)
prop_re = re.compile(
    r"global\.(\w+)\[CardStat\]\s*=\s*(.*?)(?=\n\s*global\.|\n\s*\}|\Z)", re.S)

def parse_file(path):
    txt = open(path, encoding="utf-8", errors="replace").read()
    # normalise: collapse the "{" onto blocks; block_re tolerates whitespace
    cards = []
    for bm in block_re.finditer(txt):
        cid = int(bm.group(1))
        body = bm.group(2)
        card = {"id": cid, "tags": []}
        for pm in prop_re.finditer(body):
            prop, raw = pm.group(1), pm.group(2)
            if prop in CARD_FIELDS:
                key = CARD_FIELDS[prop]
                val = eval_value(raw)
                if key in NUM_FIELDS and isinstance(val, str):
                    try: val = int(val)
                    except ValueError: continue
                card[key] = val
            else:
                # binary flag tag
                card["tags"].append(prop)
        cards.append(card)
    return cards

def main():
    all_cards = {}
    file_world = {}  # filename -> dominant world number
    for fn in sorted(os.listdir(SRC)):
        if not fn.endswith(".txt"): continue
        cards = parse_file(os.path.join(SRC, fn))
        wcount = {}
        for c in cards:
            all_cards[c["id"]] = c
            w = c.get("world")
            if w is not None:
                wcount[w] = wcount.get(w, 0) + 1
        if wcount:
            dom = max(wcount, key=wcount.get)
            label = fn[:-4]
            file_world.setdefault(dom, label)
        print(f"  {fn}: {len(cards)} cards", file=sys.stderr)

    # world number -> name map (from dominant file)
    worlds = {int(k): v for k, v in file_world.items()}

    # classify tags into set-codes vs attributes (heuristic)
    set_re = re.compile(r"^[A-Z]+\d|^(PR|Promo|CR|DCBT|EB|SD|TD|SS|CP|RR|BR)$")
    all_tags = {}
    for c in all_cards.values():
        for t in c["tags"]:
            all_tags[t] = all_tags.get(t, 0) + 1
    sets = sorted([t for t in all_tags if set_re.match(t)])
    attrs = sorted([t for t in all_tags if not set_re.match(t)])

    cards_list = sorted(all_cards.values(), key=lambda c: c["id"])
    # strip empty optional fields to shrink json
    for c in cards_list:
        if not c["tags"]:
            c.pop("tags", None)
        if c.get("flavor") in (None, "", "No flavor text."):
            c.pop("flavor", None)

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "cards.json"), "w", encoding="utf-8") as f:
        json.dump(cards_list, f, ensure_ascii=False, separators=(",", ":"))
    meta = {
        "worlds": worlds,
        "types": TYPE_NAMES,
        "sets": sets,
        "attributes": attrs,
        "count": len(cards_list),
    }
    with open(os.path.join(OUT, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)

    print(f"\nTotal cards: {len(cards_list)}", file=sys.stderr)
    print(f"Worlds: {worlds}", file=sys.stderr)
    print(f"Sets ({len(sets)}): {sets}", file=sys.stderr)
    print(f"Attributes: {len(attrs)}", file=sys.stderr)

if __name__ == "__main__":
    main()
