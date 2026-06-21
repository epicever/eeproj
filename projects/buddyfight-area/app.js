'use strict';
/* Buddyfight Area — browser recreation: deck builder + manual play-test sandbox.
   Data: data/cards.json (parsed from the original GameMaker Text/*.txt),
   art:  cards/n{id}.webp (re-encoded from CardSprite). */

const IMG = id => `cards/n${id}.webp`;   // local WebP — high-res scan where available, baked in at build time
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };

let CARDS = [];            // array
let BY_ID = new Map();     // id -> card
let META = {};
const TYPE = { 1: 'Monster', 2: 'Item', 3: 'Spell', 4: 'Impact', 5: 'Flag' };
const GENERIC_WORLD = 8;

/* ---------- load ---------- */
async function load() {
  try {
    const [c, m] = await Promise.all([
      fetch('data/cards.json').then(r => r.json()),
      fetch('data/meta.json').then(r => r.json()),
    ]);
    CARDS = c; META = m;
    CARDS.forEach(card => BY_ID.set(card.id, card));
    $('#loadStatus').textContent = `${CARDS.length} cards`;
    initFilters();
    renderGallery();
    loadSavedList();
    routeFromHash();
  } catch (e) {
    $('#loadStatus').textContent = 'Failed to load card data';
    console.error(e);
  }
}

function worldName(n) { return (META.worlds && META.worlds[n]) || `World ${n}`; }

function initFilters() {
  const fw = $('#fWorld');
  Object.entries(META.worlds).sort((a, b) => a[1].localeCompare(b[1]))
    .forEach(([n, name]) => fw.append(new Option(name, n)));
  const ft = $('#fType');
  Object.entries(TYPE).forEach(([n, name]) => ft.append(new Option(name, n)));
  const fs = $('#fSet');
  (META.sets || []).forEach(s => fs.append(new Option(s, s)));
  const fa = $('#fAttr');
  (META.attributes || []).forEach(a => fa.append(new Option(a, a)));
  ['#q', '#fWorld', '#fType', '#fSize', '#fSet', '#fAttr', '#fLegal']
    .forEach(s => $(s).addEventListener('input', renderGallery));
}

/* ---------- deck state ---------- */
const deck = { name: '', flag: null, buddy: new Set(), cards: new Map() }; // cards: id->qty
function mainCount() { let n = 0; for (const q of deck.cards.values()) n += q; return n; }
function flagCard() { return deck.flag ? BY_ID.get(deck.flag) : null; }

function legalUnderFlag(card) {
  const f = flagCard();
  if (!f) return true;
  const worlds = new Set([f.world, f.world2].filter(Boolean));
  return card.world === GENERIC_WORLD || worlds.has(card.world) ||
    (card.world2 && (card.world2 === GENERIC_WORLD || worlds.has(card.world2)));
}

/* ---------- gallery ---------- */
function filtered() {
  const q = $('#q').value.trim().toLowerCase();
  const w = $('#fWorld').value, t = $('#fType').value, sz = $('#fSize').value;
  const set = $('#fSet').value, attr = $('#fAttr').value, legal = $('#fLegal').checked;
  return CARDS.filter(c => {
    if (q && !(c.name && c.name.toLowerCase().includes(q)) && !(c.text && c.text.toLowerCase().includes(q))) return false;
    if (w && c.world != w && c.world2 != w) return false;
    if (t && c.type != t) return false;
    if (sz !== '' && c.size != sz) return false;
    if (set && !(c.tags && c.tags.includes(set))) return false;
    if (attr && !(c.tags && c.tags.includes(attr))) return false;
    if (legal && !legalUnderFlag(c)) return false;
    return true;
  });
}

/* gallery renders in batches and grows as you scroll (no 600-card cap) */
const GAL_BATCH = 120;
let galList = [], galShown = 0, galIO = null;

function cardNode(c) {
  const qty = deck.cards.get(c.id) || 0;
  const card = el('div', 'card' + (qty ? ' has' : ''));
  card.dataset.id = c.id;
  card.innerHTML =
    `<img loading="lazy" src="${IMG(c.id)}" alt="${escapeAttr(c.name)}" onerror="this.style.opacity=.15">` +
    `<span class="qty">${qty}</span><span class="nm">${escapeHtml(c.name || '#' + c.id)}</span>`;
  return card;
}

function galAppend() {
  const g = $('#gallery'), sentinel = $('#galMore');
  const end = Math.min(galShown + GAL_BATCH, galList.length);
  const frag = document.createDocumentFragment();
  for (let i = galShown; i < end; i++) frag.append(cardNode(galList[i]));
  g.insertBefore(frag, sentinel);
  galShown = end;
  if (galShown >= galList.length) {
    sentinel.textContent = galList.length ? '' : 'No cards match.';
    galIO.disconnect();
  } else {
    sentinel.textContent = `${galShown} of ${galList.length}…`;
  }
}

function renderGallery() {
  galList = filtered();
  $('#resultCount').textContent = `${galList.length} cards`;
  const g = $('#gallery');
  if (galIO) galIO.disconnect();
  g.innerHTML = '';
  galShown = 0;
  const sentinel = el('div', 'galmore'); sentinel.id = 'galMore';
  g.append(sentinel);
  galAppend();                                  // first batch
  galIO = new IntersectionObserver(
    es => { if (es.some(e => e.isIntersecting)) galAppend(); },
    { root: g, rootMargin: '800px' }            // prefetch before the sentinel is reached
  );
  galIO.observe(sentinel);
  g.scrollTop = 0;
}

$('#gallery').addEventListener('click', e => {
  const card = e.target.closest('.card'); if (!card) return;
  addToDeck(+card.dataset.id);
});
$('#gallery').addEventListener('mousemove', e => {
  const card = e.target.closest('.card');
  if (card) showPreview(+card.dataset.id, e); else hidePreview();
});
$('#gallery').addEventListener('mouseleave', hidePreview);

function addToDeck(id) {
  const c = BY_ID.get(id); if (!c) return;
  if (c.type === 5) { // flag
    deck.flag = (deck.flag === id) ? null : id;
  } else {
    const q = deck.cards.get(id) || 0;
    if (q >= 4) return;
    deck.cards.set(id, q + 1);
  }
  renderDeck(); renderGallery();
}
function removeFromDeck(id) {
  const q = deck.cards.get(id) || 0;
  if (q <= 1) { deck.cards.delete(id); deck.buddy.delete(id); }
  else deck.cards.set(id, q - 1);
  renderDeck(); renderGallery();
}

/* ---------- deck panel ---------- */
function renderDeck() {
  // flag slot
  const fs = $('#flagSlot');
  const f = flagCard();
  fs.classList.toggle('filled', !!f);
  fs.innerHTML = `<span class="slotlabel">FLAG</span>` + (f
    ? `<img src="${IMG(f.id)}"><span class="fname">${escapeHtml(f.name)}</span><button class="rm" data-flag>✕</button>`
    : `<span class="slotempty">click a flag card to set</span>`);

  // counts
  const mc = mainCount();
  $('#cMain').textContent = `${mc}/50`;
  $('#cMain').className = 'badge' + (mc === 50 ? ' ok' : mc > 50 ? ' warn' : '');
  $('#cFlag').textContent = f ? 'flag ✓' : 'no flag';
  $('#cFlag').className = 'badge' + (f ? ' ok' : ' warn');
  $('#cBuddy').textContent = deck.buddy.size ? `buddy ${deck.buddy.size}` : 'no buddy';
  $('#cBuddy').className = 'badge' + (deck.buddy.size ? ' ok' : '');

  // list grouped by type
  const dl = $('#decklist'); dl.innerHTML = '';
  const groups = { 1: [], 2: [], 3: [], 4: [] };
  [...deck.cards.keys()].sort((a, b) => (BY_ID.get(a).name || '').localeCompare(BY_ID.get(b).name || ''))
    .forEach(id => { const c = BY_ID.get(id); (groups[c.type] || (groups[c.type] = [])).push(id); });
  for (const [ty, ids] of Object.entries(groups)) {
    if (!ids.length) continue;
    const sub = ids.reduce((n, id) => n + deck.cards.get(id), 0);
    dl.append(el('div', 'dgroup', `${TYPE[ty] || 'Other'} (${sub})`));
    for (const id of ids) {
      const c = BY_ID.get(id), q = deck.cards.get(id);
      const isBud = deck.buddy.has(id);
      const row = el('div', 'drow' + (isBud ? ' buddy' : ''));
      row.dataset.id = id;
      row.innerHTML =
        `<span class="dq">${q}</span><span class="dn" title="${escapeAttr(c.name)}">${escapeHtml(c.name)}</span>` +
        `<span class="dctl">` +
        (c.type === 1 ? `<button data-buddy title="toggle buddy">★</button>` : '') +
        `<button data-minus>−</button><button data-plus>+</button></span>`;
      dl.append(row);
    }
  }
  validateDeck();
}

$('#decklist').addEventListener('click', e => {
  const row = e.target.closest('.drow'); if (!row) return;
  const id = +row.dataset.id;
  if (e.target.matches('[data-plus]')) addToDeck(id);
  else if (e.target.matches('[data-minus]')) removeFromDeck(id);
  else if (e.target.matches('[data-buddy]')) { deck.buddy.has(id) ? deck.buddy.delete(id) : deck.buddy.add(id); renderDeck(); }
  else if (e.target.matches('.dn')) showPreviewFixed(id);
});
$('#decklist').addEventListener('mousemove', e => {
  const row = e.target.closest('.drow'); if (row) showPreview(+row.dataset.id, e); else hidePreview();
});
$('#decklist').addEventListener('mouseleave', hidePreview);
$('#flagSlot').addEventListener('click', e => { if (e.target.matches('[data-flag]')) { deck.flag = null; renderDeck(); renderGallery(); } });
$('#deckName').addEventListener('input', e => deck.name = e.target.value);

function validateDeck() {
  const v = $('#deckValidate'); const errs = [];
  const mc = mainCount();
  if (!deck.flag) errs.push('Needs a flag.');
  if (mc !== 50) errs.push(`Main deck is ${mc} (standard is 50).`);
  for (const [id, q] of deck.cards) if (q > 4) errs.push(`${BY_ID.get(id).name}: ${q} copies (max 4).`);
  if (deck.flag) {
    const bad = [...deck.cards.keys()].filter(id => !legalUnderFlag(BY_ID.get(id)));
    if (bad.length) errs.push(`${bad.length} card(s) not legal under this flag.`);
  }
  if (!deck.buddy.size) errs.push('No buddy chosen (★ a monster).');
  v.className = 'deckvalidate' + (errs.length ? '' : ' ok');
  v.textContent = errs.length ? errs.join(' ') : 'Deck is tournament-legal ✓';
}

/* ---------- save / load / export ---------- */
const LS = 'bfa.decks';
function allDecks() { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } }
function serialize() {
  return { name: deck.name || 'Untitled deck', flag: deck.flag, buddy: [...deck.buddy], cards: [...deck.cards.entries()] };
}
function deserialize(d) {
  deck.name = d.name || ''; deck.flag = d.flag ?? null;
  deck.buddy = new Set(d.buddy || []);
  deck.cards = new Map(d.cards || []);
  $('#deckName').value = deck.name;
  renderDeck(); renderGallery();
}
function loadSavedList() {
  const names = Object.keys(allDecks());
  const sel = $('#savedDecks'); sel.innerHTML = '<option value="">Saved decks…</option>';
  names.forEach(n => sel.append(new Option(n, n)));
  for (const [id, lead] of [['#playDeckYou', '— current build —'], ['#playDeckOpp', '— none —']]) {
    const pd = $(id); const keep = pd.value;
    pd.innerHTML = `<option value="">${lead}</option>`;
    names.forEach(n => pd.append(new Option(n, n)));
    pd.value = keep;
  }
}
$('#btnSave').onclick = () => {
  if (!deck.name) deck.name = $('#deckName').value || prompt('Deck name?') || 'Untitled deck';
  $('#deckName').value = deck.name;
  const d = allDecks(); d[deck.name] = serialize();
  localStorage.setItem(LS, JSON.stringify(d)); loadSavedList();
  flash('#deckValidate', `Saved “${deck.name}”.`);
};
$('#savedDecks').onchange = e => { if (e.target.value) deserialize(allDecks()[e.target.value]); };
$('#btnDelete').onclick = () => {
  const n = $('#savedDecks').value; if (!n) return;
  const d = allDecks(); delete d[n]; localStorage.setItem(LS, JSON.stringify(d)); loadSavedList();
};
$('#btnNew').onclick = () => { deck.name = ''; deck.flag = null; deck.buddy = new Set(); deck.cards = new Map(); $('#deckName').value = ''; renderDeck(); renderGallery(); };
$('#btnExport').onclick = () => {
  const blob = new Blob([JSON.stringify(serialize(), null, 1)], { type: 'application/json' });
  const a = el('a'); a.href = URL.createObjectURL(blob); a.download = (deck.name || 'deck') + '.bfdeck.json'; a.click();
};
$('#btnImport').onclick = () => {
  const inp = el('input'); inp.type = 'file'; inp.accept = '.json,.bfdeck.json,application/json';
  inp.onchange = () => { const f = inp.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { try { deserialize(JSON.parse(r.result)); } catch { alert('Bad deck file'); } }; r.readAsText(f); };
  inp.click();
};
$('#btnPlay').onclick = () => { $('#btnSave').click(); $('#playDeckYou').value = deck.name; switchView('play'); };

/* ---------- export deck images as ZIP (one file per copy) ---------- */
function safeName(s) {
  return (s || 'card').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'card';
}
function decklistText() {
  const lines = [`# ${deck.name || 'Untitled deck'}`, ''];
  const f = flagCard(); if (f) lines.push(`Flag: ${f.name}`);
  const buds = [...deck.buddy].map(id => BY_ID.get(id)?.name).filter(Boolean);
  if (buds.length) lines.push(`Buddy: ${buds.join(', ')}`);
  lines.push('', `Main deck (${mainCount()}):`);
  const groups = {};
  for (const [id, q] of deck.cards) { const t = TYPE[BY_ID.get(id).type] || 'Other'; (groups[t] ||= []).push([id, q]); }
  for (const [t, arr] of Object.entries(groups)) {
    lines.push('', `[${t}]`);
    arr.sort((a, b) => (BY_ID.get(a[0]).name || '').localeCompare(BY_ID.get(b[0]).name || ''));
    for (const [id, q] of arr) lines.push(`${q}x ${BY_ID.get(id).name}`);
  }
  return lines.join('\r\n');
}
async function exportZip() {
  if (typeof JSZip === 'undefined') { alert('ZIP library not loaded.'); return; }
  const entries = [];
  if (deck.flag) entries.push([deck.flag, 1]);
  for (const [id, q] of deck.cards) entries.push([id, q]);
  if (!entries.length) { alert('Add some cards to the deck first.'); return; }
  const btn = $('#btnZip'), label = btn.textContent; btn.disabled = true;
  const zip = new JSZip();
  const used = new Set();
  let totalCopies = 0, failed = 0, i = 0;
  for (const [id, q] of entries) {
    i++;
    btn.textContent = `…${i}/${entries.length}`;
    const c = BY_ID.get(id);
    let blob = null;
    try { const r = await fetch(IMG(id)); if (r.ok) blob = await r.blob(); } catch {}
    if (!blob) { failed++; continue; }
    let base = safeName(c.name);
    if (used.has(base.toLowerCase())) base += ` #${id}`;   // disambiguate same-named cards
    used.add(base.toLowerCase());
    for (let n = 1; n <= q; n++) {
      const fn = q > 1 ? `${base}_${n}.webp` : `${base}.webp`;
      zip.file(fn, blob);
      totalCopies++;
    }
  }
  zip.file('decklist.txt', decklistText());
  btn.textContent = 'zipping…';
  const out = await zip.generateAsync({ type: 'blob' }, m => { btn.textContent = `zipping ${m.percent | 0}%`; });
  const a = el('a'); a.href = URL.createObjectURL(out); a.download = safeName(deck.name || 'deck') + '.zip'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  btn.disabled = false; btn.textContent = label;
  flash('#deckValidate', `Exported ${totalCopies} image${totalCopies !== 1 ? 's' : ''}` + (failed ? `, ${failed} missing` : '') + '.');
}
$('#btnZip').onclick = exportZip;

function flash(sel, msg) { const e = $(sel); const o = e.textContent, c = e.className; e.textContent = msg; e.className = 'deckvalidate ok'; setTimeout(() => { e.textContent = o; e.className = c; }, 1500); }

/* ---------- preview tooltip ---------- */
const prev = $('#preview');
function statLine(c) {
  const bits = [];
  bits.push(`<span class="pstat">${TYPE[c.type] || '?'}</span> · ${worldName(c.world)}${c.world2 ? ' / ' + worldName(c.world2) : ''}`);
  if (c.size != null) bits.push(`Size ${c.size}`);
  if (c.power != null) bits.push(`Power ${c.power}`);
  if (c.defense != null) bits.push(`Def ${c.defense}`);
  if (c.crit != null) bits.push(`Crit ${c.crit}`);
  let s = bits.join(' · ');
  if (c.tags && c.tags.length) s += `\n<${c.tags.join('/')}>`;
  if (c.text) s += `\n\n${c.text}`;
  return s;
}
function showPreview(id, e) {
  const c = BY_ID.get(id); if (!c) return;
  const pi = $('#previewImg');
  pi.onerror = () => { pi.onerror = null; pi.style.opacity = .15; };
  pi.style.opacity = 1;
  pi.src = IMG(id);
  $('#previewInfo').innerHTML = `<b>${escapeHtml(c.name)}</b>\n${statLine(c)}`;
  prev.classList.remove('hidden');
  const pad = 14, w = 320, h = prev.offsetHeight || 440;
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + w > innerWidth) x = e.clientX - w - pad;
  if (y + h > innerHeight) y = Math.max(8, innerHeight - h - 8);
  prev.style.left = x + 'px'; prev.style.top = y + 'px';
}
function showPreviewFixed(id) { const c = BY_ID.get(id); if (!c) return; showPreview(id, { clientX: innerWidth / 2, clientY: 80 }); setTimeout(hidePreview, 2500); }
function hidePreview() { prev.classList.add('hidden'); }

/* ---------- view routing ---------- */
function switchView(v) {
  $$('.view').forEach(x => x.classList.add('hidden'));
  $('#view-' + v).classList.remove('hidden');
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  $('#deckToggle').classList.toggle('hidden', v !== 'builder');   // drawer toggle only in builder
  if (v !== 'builder') $('.deckpanel').classList.remove('open');
  location.hash = v;
}
$$('.tab').forEach(t => t.onclick = () => switchView(t.dataset.view));
$('#deckToggle').onclick = () => $('.deckpanel').classList.toggle('open');
function routeFromHash() { switchView(location.hash.replace('#', '') === 'play' ? 'play' : 'builder'); }

/* =========================================================
   TEST MODE — two-sided sandbox (prep for multiplayer)
   game = { players:{you,opp}, active }
   player = { inst:Map uid->{uid,id,zone,rested,facedown}, deckOrder:[], life }
   Each player owns its own zones; the board mirrors them vertically.
   ========================================================= */
const ZONES = ['flag', 'buddy', 'left', 'center', 'right', 'item', 'gauge', 'drop', 'soul', 'deck', 'hand'];
const ZONE_LABELS = { flag: 'Flag', buddy: 'Buddy', left: 'Left', center: 'Center', right: 'Right', item: 'Item', gauge: 'Gauge', drop: 'Drop', soul: 'Soul / Set', deck: 'Deck', hand: 'Hand' };
const SIDES = [['opp', 'Opponent'], ['you', 'You']];   // render order: opponent on top
let game = null;
let uidSeq = 1;

/* build the two mirrored field DOMs once */
function buildBoard() {
  const board = $('#board'); board.innerHTML = '';
  for (const [owner, label] of SIDES) {
    const f = el('section', 'field field-' + owner); f.dataset.owner = owner;
    const counters = ['life', 'gauge', 'hand', 'deck']
      .map(c => `<span class="fc">${c[0].toUpperCase() + c.slice(1)} <b data-c="${c}">0</b></span>`).join('');
    const mat = ZONES.map(z => {
      const cls = (z === 'deck' ? 'pile' : 'zone') + ' z-' + z;
      return `<div class="${cls}" data-owner="${owner}" data-zone="${z}"><span class="zl">${ZONE_LABELS[z]}</span></div>`;
    }).join('');
    f.innerHTML =
      `<div class="fstatus"><span class="fname">${label}</span>${counters}` +
      `<button class="actbtn" data-make="${owner}">Make active</button></div>` +
      `<div class="mat">${mat}</div>`;
    board.append(f);
  }
}

function newPlayer() { return { inst: new Map(), deckOrder: [], life: 10 }; }
function buildDeckInto(p, d) {
  for (const [id, q] of d.cards) for (let i = 0; i < q; i++) {
    const uid = uidSeq++; p.inst.set(uid, { uid, id, rested: false, facedown: true, zone: 'deck' }); p.deckOrder.push(uid);
  }
  shuffle(p.deckOrder);
  if (d.flag) { const uid = uidSeq++; p.inst.set(uid, { uid, id: d.flag, rested: false, facedown: false, zone: 'flag' }); }
  for (let i = 0; i < 2 && p.deckOrder.length; i++) pMoveTo(p, p.deckOrder[0], 'gauge');  // opening gauge
  pDraw(p, 6);                                                                            // opening hand
}

function startGame() {
  const youName = $('#playDeckYou').value, oppName = $('#playDeckOpp').value;
  const youDeck = youName ? allDecks()[youName] : serialize();
  if (!youDeck || !youDeck.cards || !youDeck.cards.length) { alert('Pick a deck for You (or build one in Deck Builder first).'); return; }
  game = { players: { you: newPlayer(), opp: newPlayer() }, active: 'you' };
  buildDeckInto(game.players.you, youDeck);
  const oppDeck = oppName ? allDecks()[oppName] : null;
  if (oppDeck && oppDeck.cards && oppDeck.cards.length) buildDeckInto(game.players.opp, oppDeck);
  renderTable();
}

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } }
function pMoveTo(p, uid, zone, top) {
  const it = p.inst.get(uid); if (!it) return;
  const k = p.deckOrder.indexOf(uid); if (k >= 0) p.deckOrder.splice(k, 1);
  it.zone = zone;
  if (zone === 'deck') { it.facedown = true; it.rested = false; top ? p.deckOrder.unshift(uid) : p.deckOrder.push(uid); }
}
function pDraw(p, n) { for (let i = 0; i < n && p.deckOrder.length; i++) { const uid = p.deckOrder[0]; pMoveTo(p, uid, 'hand'); p.inst.get(uid).facedown = false; } }
function activeP() { return game && game.players[game.active]; }

function renderTable() {
  if (!game) return;
  for (const [owner] of SIDES) {
    const p = game.players[owner];
    const buckets = {}; ZONES.forEach(z => buckets[z] = []);
    for (const it of p.inst.values()) buckets[it.zone].push(it);
    buckets.deck = p.deckOrder.map(uid => p.inst.get(uid));
    for (const z of ZONES) {
      const zoneEl = document.querySelector(`.field-${owner} [data-zone="${z}"]`);
      [...zoneEl.querySelectorAll('.pcard')].forEach(n => n.remove());
      if (z === 'deck') {
        const n = buckets.deck.length, base = Math.max(0, n - 6);
        for (let i = base; i < n; i++) {
          const c = makePCard(buckets.deck[i], true, owner);
          c.style.left = (i - base) * 3 + 'px'; c.style.top = (i - base) * 2 + 'px';
          zoneEl.append(c);
        }
      } else {
        buckets[z].forEach(it => zoneEl.append(makePCard(it, false, owner)));
      }
    }
    const fs = document.querySelector(`.field-${owner} .fstatus`);
    fs.querySelector('[data-c="life"]').textContent = p.life;
    fs.querySelector('[data-c="gauge"]').textContent = buckets.gauge.length;
    fs.querySelector('[data-c="hand"]').textContent = buckets.hand.length;
    fs.querySelector('[data-c="deck"]').textContent = buckets.deck.length;
  }
  document.querySelectorAll('.field').forEach(f => f.classList.toggle('active', f.dataset.owner === game.active));
  $('#activeName').textContent = game.active === 'you' ? 'You' : 'Opponent';
}
function makePCard(it, asPile, owner) {
  const d = el('div', 'pcard' + (it.rested ? ' rested' : '') + ((it.facedown || asPile) ? ' facedown' : ''));
  d.dataset.uid = it.uid; d.dataset.owner = owner;
  d.draggable = true;
  d.innerHTML = `<img src="${IMG(it.id)}" alt="" onerror="this.style.visibility='hidden'">`;
  return d;
}

/* drag & drop — restricted to the card owner's own zones */
let drag = null; // {uid, owner}
document.addEventListener('dragstart', e => { const p = e.target.closest('.pcard'); if (!p) return; drag = { uid: +p.dataset.uid, owner: p.dataset.owner }; p.classList.add('dragging'); e.dataTransfer.setData('text/plain', drag.uid); });
document.addEventListener('dragend', e => { const p = e.target.closest('.pcard'); if (p) p.classList.remove('dragging'); drag = null; });
$('#board').addEventListener('dragover', e => { const z = e.target.closest('.zone,.pile'); if (z && drag && z.dataset.owner === drag.owner) { e.preventDefault(); z.classList.add('dragover'); } });
$('#board').addEventListener('dragleave', e => { const z = e.target.closest('.zone,.pile'); if (z) z.classList.remove('dragover'); });
$('#board').addEventListener('drop', e => {
  const z = e.target.closest('.zone,.pile'); if (!z || !drag || z.dataset.owner !== drag.owner) return;
  e.preventDefault(); z.classList.remove('dragover');
  const p = game.players[drag.owner]; const it = p.inst.get(drag.uid); const fromDeck = it.zone === 'deck';
  pMoveTo(p, drag.uid, z.dataset.zone);
  if (z.dataset.zone !== 'deck' && fromDeck) it.facedown = false;   // revealed when pulled from deck
  renderTable();
});

/* click: draw from a deck pile, or make a side active */
$('#board').addEventListener('click', e => {
  if (!game) return;
  const pile = e.target.closest('.pile');
  if (pile) { pDraw(game.players[pile.dataset.owner], 1); renderTable(); return; }
  const mk = e.target.closest('[data-make]'); const field = e.target.closest('.field');
  const owner = mk ? mk.dataset.make : field ? field.dataset.owner : null;
  if (owner && owner !== game.active) { game.active = owner; renderTable(); }
});

/* double-click rest/stand; hover preview; right-click menu — all owner-aware */
$('#board').addEventListener('dblclick', e => { const pc = e.target.closest('.pcard'); if (!pc || !game) return; const it = game.players[pc.dataset.owner].inst.get(+pc.dataset.uid); it.rested = !it.rested; renderTable(); });
$('#board').addEventListener('mousemove', e => { const pc = e.target.closest('.pcard'); if (pc && game) { const it = game.players[pc.dataset.owner].inst.get(+pc.dataset.uid); if (it && !it.facedown) showPreview(it.id, e); else hidePreview(); } else hidePreview(); });
$('#board').addEventListener('mouseleave', hidePreview);
$('#board').addEventListener('contextmenu', e => {
  const pc = e.target.closest('.pcard'); if (!pc || !game) return;
  e.preventDefault();
  const p = game.players[pc.dataset.owner]; const uid = +pc.dataset.uid; const it = p.inst.get(uid);
  openCtx(e.clientX, e.clientY, [
    ['Rest / Stand', () => { it.rested = !it.rested; }],
    ['Flip face ' + (it.facedown ? 'up' : 'down'), () => { it.facedown = !it.facedown; }],
    ['To hand', () => pMoveTo(p, uid, 'hand')],
    ['To gauge', () => pMoveTo(p, uid, 'gauge')],
    ['To drop', () => pMoveTo(p, uid, 'drop')],
    ['To soul/set', () => pMoveTo(p, uid, 'soul')],
    ['Deck top', () => pMoveTo(p, uid, 'deck', true)],
    ['Deck bottom', () => pMoveTo(p, uid, 'deck', false)],
    ['Shuffle into deck', () => { pMoveTo(p, uid, 'deck'); shuffle(p.deckOrder); }],
  ]);
});
function openCtx(x, y, items) {
  const m = $('#ctxMenu'); m.innerHTML = '';
  items.forEach(([label, fn]) => { const b = el('button', null, label); b.onclick = () => { fn(); m.classList.add('hidden'); renderTable(); }; m.append(b); });
  m.style.left = Math.min(x, innerWidth - 170) + 'px'; m.style.top = Math.min(y, innerHeight - items.length * 34 - 10) + 'px';
  m.classList.remove('hidden');
}
document.addEventListener('click', e => { if (!e.target.closest('#ctxMenu')) $('#ctxMenu').classList.add('hidden'); });

/* play controls — operate on the active side */
$('#btnStart').onclick = startGame;
$('#btnReset').onclick = startGame;
$('#btnSwitch').onclick = () => { if (game) { game.active = game.active === 'you' ? 'opp' : 'you'; renderTable(); } };
$('#btnDraw').onclick = () => { const p = activeP(); if (p) { pDraw(p, 1); renderTable(); } };
$('#btnShuffleDeck').onclick = () => { const p = activeP(); if (p) { shuffle(p.deckOrder); renderTable(); flashBar('Shuffled ' + game.active + ' deck'); } };
$('#btnMulligan').onclick = () => {
  const p = activeP(); if (!p) return;
  for (const it of [...p.inst.values()]) if (it.zone === 'hand') pMoveTo(p, it.uid, 'deck');
  shuffle(p.deckOrder); pDraw(p, 6); renderTable(); flashBar('Mulligan — redrew 6');
};
$('#btnLifeUp').onclick = () => { const p = activeP(); if (p) { p.life++; renderTable(); } };
$('#btnLifeDn').onclick = () => { const p = activeP(); if (p) { p.life--; renderTable(); } };
$('#btnGaugeUp').onclick = () => { const p = activeP(); if (p && p.deckOrder.length) { pMoveTo(p, p.deckOrder[0], 'gauge'); renderTable(); } };   // charge top of deck
$('#btnGaugeDn').onclick = () => { const p = activeP(); if (!p) return; const g = [...p.inst.values()].find(it => it.zone === 'gauge'); if (g) { pMoveTo(p, g.uid, 'drop'); renderTable(); } };   // pay 1 gauge
$('#btnFlip').onclick = () => flashBar('Coin: ' + (Math.random() < .5 ? 'Heads' : 'Tails'));
$('#btnDie').onclick = () => { $('#dieVal').textContent = 1 + Math.floor(Math.random() * 6); };
function flashBar(msg) { const s = $('#loadStatus'); const o = s.textContent; s.textContent = msg; setTimeout(() => s.textContent = o, 1400); }
buildBoard();

window.addEventListener('hashchange', routeFromHash);

/* utils */
function escapeHtml(s) { return (s || '').replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m])); }
function escapeAttr(s) { return (s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

load();
renderDeck();
