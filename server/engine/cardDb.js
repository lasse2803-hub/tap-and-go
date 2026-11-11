/**
 * Card characteristics for the engine, derived from Scryfall's STRUCTURED fields in
 * data/cards.json (built by scripts/build-card-db.js). No rules are inferred from
 * oracle text here: anything a card does beyond these characteristics must be an
 * explicit implementation in ./cards (and is reported as missing until it is).
 */
const CARDS = require('./data/cards.json');
const DECKS = require('./data/decks.json');

// Mana-producing creatures with a plain "{T}: Add …" ability. Explicit on purpose:
// Scryfall's produced_mana also lists cards that make mana in other ways
// (planeswalker loyalty, auras, devotion), which must not become tap-for-mana.
const MANA_CREATURES = {
  'Llanowar Elves': ['G'],
  'Elvish Mystic': ['G'],
  'Birds of Paradise': ['W', 'U', 'B', 'R', 'G'],
  'Fanatic of Rhonas': ['G'], // also {G}{G}{G}{G} with 4+ power — M2
};

// Lands whose produced_mana overstates their plain tap ability.
const LAND_MANA_OVERRIDES = {
  'Nykthos, Shrine to Nyx': ['C'], // devotion ability — M2
};

const TYPE_WORDS = ['Land', 'Creature', 'Instant', 'Sorcery', 'Enchantment', 'Artifact', 'Planeswalker', 'Battle'];
const SUPERTYPE_WORDS = ['Legendary', 'Basic', 'Snow', 'World'];

/** Characteristics of the face a card has when cast / played (front face). */
function buildChar(d) {
  const front = (Array.isArray(d.card_faces) && d.card_faces.length) ? d.card_faces[0] : {};
  // Adventure: the creature is face 0, but Scryfall keeps keywords etc. on the card.
  const pickF = (k) => (front[k] !== undefined ? front[k] : d[k]);
  const typeLine = (d.layout === 'normal' || d.layout === 'saga') ? d.type_line : (front.type_line || d.type_line || '');
  const [left, right = ''] = typeLine.split(' — ');
  const words = left.split(/\s+/);
  const ch = {
    name: d.name.includes(' // ') ? (front.name || d.name.split(' // ')[0]) : d.name,
    fullName: d.name,
    layout: d.layout,
    manaCost: (d.layout === 'normal' || d.layout === 'saga') ? (d.mana_cost || '') : (front.mana_cost !== undefined ? front.mana_cost : (d.mana_cost || '')),
    cmc: d.cmc || 0,
    typeLine,
    types: words.filter(w => TYPE_WORDS.includes(w)),
    supertypes: words.filter(w => SUPERTYPE_WORDS.includes(w)),
    subtypes: right ? right.split(/\s+/) : [],
    oracle: pickF('oracle_text') || '',
    power: pickF('power'),
    toughness: pickF('toughness'),
    loyalty: pickF('loyalty'),
    keywords: (d.keywords || []).map(k => k.toLowerCase()),
    producedMana: d.produced_mana || [],
  };
  ch.is = (t) => ch.types.includes(t);
  ch.isPermanent = ch.types.some(t => ['Land', 'Creature', 'Enchantment', 'Artifact', 'Planeswalker', 'Battle'].includes(t));
  ch.isLegendary = ch.supertypes.includes('Legendary');
  return ch;
}

const CHARS = {};
for (const [name, d] of Object.entries(CARDS)) CHARS[name] = buildChar(d);

function char(name) {
  const c = CHARS[name];
  if (!c) throw new Error(`Unknown card: ${name}`);
  return c;
}

/** Colors a permanent can tap for (array, may be empty), or null if not a mana source. */
function manaOptions(name) {
  const c = char(name);
  if (c.is('Land')) {
    const opts = LAND_MANA_OVERRIDES[name] || c.producedMana;
    return opts && opts.length ? opts.slice() : null;
  }
  if (c.is('Creature') && MANA_CREATURES[name]) return MANA_CREATURES[name].slice();
  return null;
}

/** Numeric base P/T; '*'-based values are 0 until the card is implemented (M2). */
const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };

function getDeck(name) {
  const d = DECKS.find(x => x.name === name);
  if (!d) throw new Error(`Unknown deck: ${name}`);
  return d;
}

/** TEST SEAM: register a synthetic card (Scryfall-shaped) for rules scenario tests. */
function _registerTestCard(def) {
  const d = { layout: 'normal', mana_cost: '', cmc: 0, oracle_text: '', keywords: [], legalities: {}, ...def };
  CARDS[d.name] = d;
  CHARS[d.name] = buildChar(d);
  return CHARS[d.name];
}

module.exports = { CARDS, DECKS, char, manaOptions, num, getDeck, MANA_CREATURES, _registerTestCard };
