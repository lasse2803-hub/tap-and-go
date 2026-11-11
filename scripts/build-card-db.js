#!/usr/bin/env node
/**
 * Build the engine's offline card database + deck list.
 *
 *   node scripts/build-card-db.js
 *
 * - Decks: the client's PRESET_DECKS (extracted from index.html — single source of
 *   truth) + server/engine/data/level3-decks.js.
 * - Cards: fetched ONCE from Scryfall's /cards/collection (batched) and written to
 *   server/engine/data/cards.json, trimmed to the fields the engine uses. The engine
 *   reads Scryfall's STRUCTURED fields (keywords, produced_mana, loyalty, ...) — it
 *   never guesses rules from oracle text.
 * - Legality (project rule, decided by the owner 2026-11-11): a card is allowed unless it
 *   is BANNED in the Historic format. Nothing else counts — a card that is merely
 *   "not legal" in Historic (never released on MTG Arena) is allowed, and other formats
 *   (Modern, Pioneer, …) are not consulted. Banned cards are reported and the script
 *   exits non-zero.
 *
 * Outputs are committed so tests and the simulator run offline and deterministically.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'server', 'engine', 'data');
const UA = 'TapAndGoEngine/1.0 (card-db build script)';

function loadPresetDecks() {
  const src = fs.readFileSync(path.join(ROOT, 'client', 'public', 'index.html'), 'utf8');
  const marker = 'const PRESET_DECKS = ';
  const start = src.indexOf(marker);
  const end = src.indexOf('\n];', start);
  if (start === -1 || end === -1) throw new Error('PRESET_DECKS not found in index.html');
  // The array is plain object literals + template strings — safe to evaluate.
  return eval(src.slice(start + marker.length, end + 3)); // eslint-disable-line no-eval
}

/** "4 Llanowar Elves (PDMU) 1★ >> Reskin||||url" → { qty: 4, name: 'Llanowar Elves' } */
function parseLine(line) {
  const m = line.trim().match(/^(\d+)\s+(.+)$/);
  if (!m) return null;
  let name = m[2].split('>>')[0].trim();
  name = name.replace(/\s*\([A-Z0-9]+\)\s*[\w★-]*\s*$/, '').trim();
  return { qty: parseInt(m[1], 10), name };
}

function parseDeck(d) {
  const cards = [];
  for (const line of d.list.split('\n')) {
    const c = parseLine(line);
    if (!c) continue;
    const ex = cards.find(x => x.name === c.name);
    if (ex) ex.qty += c.qty; else cards.push(c);
  }
  return { name: d.name, level: d.level || 1, description: d.description || '', cards };
}

const FACE_FIELDS = ['name', 'mana_cost', 'type_line', 'oracle_text', 'power', 'toughness', 'loyalty', 'colors', 'produced_mana'];
function trimCard(c) {
  const out = {
    name: c.name,
    layout: c.layout,
    mana_cost: c.mana_cost,
    cmc: c.cmc,
    type_line: c.type_line,
    oracle_text: c.oracle_text,
    power: c.power,
    toughness: c.toughness,
    loyalty: c.loyalty,
    colors: c.colors,
    keywords: c.keywords || [],
    produced_mana: c.produced_mana,
    legalities: { modern: c.legalities?.modern, historic: c.legalities?.historic, pioneer: c.legalities?.pioneer },
  };
  if (Array.isArray(c.card_faces)) {
    out.card_faces = c.card_faces.map(f => Object.fromEntries(FACE_FIELDS.filter(k => f[k] !== undefined).map(k => [k, f[k]])));
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchCollection(names) {
  const found = {};
  const notFound = [];
  for (let i = 0; i < names.length; i += 75) {
    const batch = names.slice(i, i + 75);
    const res = await fetch('https://api.scryfall.com/cards/collection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ identifiers: batch.map(name => ({ name })) }),
    });
    if (!res.ok) throw new Error(`Scryfall ${res.status}: ${await res.text()}`);
    const json = await res.json();
    for (const c of json.data) found[c.name] = c;
    for (const nf of json.not_found || []) notFound.push(nf.name);
    await sleep(120);
  }
  // Double-faced cards come back under "Front // Back" — index them by front name too.
  for (const full of Object.keys(found)) {
    if (full.includes(' // ')) found[full.split(' // ')[0]] = found[full];
  }
  // Retry misses with Scryfall's exact-name endpoint (handles odd face names).
  for (const name of notFound.slice()) {
    const r = await fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`, { headers: { Accept: 'application/json', 'User-Agent': UA } });
    if (r.ok) { found[name] = await r.json(); notFound.splice(notFound.indexOf(name), 1); }
    await sleep(120);
  }
  return { found, notFound };
}

(async () => {
  const decks = [...loadPresetDecks(), ...require(path.join(OUT_DIR, 'level3-decks.js'))].map(parseDeck);
  const names = [...new Set(decks.flatMap(d => d.cards.map(c => c.name)))].sort();
  console.log(`${decks.length} decks, ${names.length} unique cards — fetching from Scryfall…`);

  const { found, notFound } = await fetchCollection(names);
  if (notFound.length) { console.error('NOT FOUND:', notFound); process.exit(1); }

  const cards = {};
  for (const n of names) cards[n] = trimCard(found[n]);

  // Project legality rule: only "banned in Historic" disqualifies a card (see header).
  const banned = names.filter(n => cards[n].legalities.historic === 'banned');
  const notOnArena = names.filter(n => cards[n].legalities.historic === 'not_legal');
  const badCount = decks.filter(d => d.cards.reduce((s, c) => s + c.qty, 0) !== 60);

  fs.writeFileSync(path.join(OUT_DIR, 'cards.json'), JSON.stringify(cards, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, 'decks.json'), JSON.stringify(decks, null, 1));
  console.log(`Wrote cards.json (${names.length} cards) and decks.json (${decks.length} decks).`);

  if (badCount.length) console.error('Decks not 60 cards:', badCount.map(d => d.name));
  if (notOnArena.length) console.log(`Info (allowed): ${notOnArena.length} card(s) not on Arena / not in Historic's pool: ${notOnArena.join(', ')}`);
  if (banned.length) {
    console.error('BANNED IN HISTORIC:', banned);
    process.exit(2);
  }
  console.log('Legality: no card is banned in Historic.');
})().catch(e => { console.error(e); process.exit(1); });
