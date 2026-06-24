'use strict';
/*
 * Characterization tests for the PURE rules helpers (client/public/rules-core.js).
 *
 * As of Etape 1 these functions live in a real module and are require()d
 * directly. The goal is to PIN current behavior — including known quirks — so
 * that Etape 2 (replacing regex parsing with card data) cannot change behavior
 * silently.
 *
 * These same tests proved the Etape 1 extraction was faithful: they previously
 * loaded the functions out of index.html via the vm-sandbox seam
 * (helpers/extract-fn.js) and stayed green when re-pointed at the new module.
 *
 * If a refactor intentionally changes one of these behaviors, update the
 * assertion in the same commit and note why. A surprise failure means the
 * refactor changed something it should not have.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const R = require('../client/public/rules-core.js');

const emptyPool = () => ({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });

// ─────────────────────────────────────────────────────────────
// Mana cost parsing
// ─────────────────────────────────────────────────────────────
test('parseManaCost: generic + colored', () => {
  assert.deepEqual(R.parseManaCost('{2}{R}{R}'), { generic: 2, R: 2 });
  assert.deepEqual(R.parseManaCost('{W}{U}{B}{R}{G}'), { generic: 0, W: 1, U: 1, B: 1, R: 1, G: 1 });
  assert.deepEqual(R.parseManaCost('{0}'), { generic: 0 });
});

test('parseManaCost: empty / missing cost is generic 0', () => {
  assert.deepEqual(R.parseManaCost(''), { generic: 0 });
  assert.deepEqual(R.parseManaCost(null), { generic: 0 });
  assert.deepEqual(R.parseManaCost(undefined), { generic: 0 });
});

test('parseManaCost: X is ignored for validation (player chooses)', () => {
  // {X}{R} -> X contributes nothing, only the R is recorded.
  assert.deepEqual(R.parseManaCost('{X}{R}'), { generic: 0, R: 1 });
});

test('parseManaCost: hybrid mana captured under _hybrid', () => {
  const cost = R.parseManaCost('{W/U}{W/U}');
  assert.deepEqual(cost._hybrid, [['W', 'U'], ['W', 'U']]);
});

// ─────────────────────────────────────────────────────────────
// Paying / deducting mana
// ─────────────────────────────────────────────────────────────
test('canPayManaCost: colored requirement enforced', () => {
  const cost = R.parseManaCost('{2}{R}{R}'); // {generic:2, R:2}
  assert.equal(R.canPayManaCost({ ...emptyPool(), R: 2, C: 2 }, cost), true);
  assert.equal(R.canPayManaCost({ ...emptyPool(), R: 1, C: 3 }, cost), false, 'not enough R');
  assert.equal(R.canPayManaCost({ ...emptyPool(), R: 2, C: 1 }, cost), false, 'not enough total for generic');
});

test('canPayManaCost: generic can be paid by any color', () => {
  const cost = R.parseManaCost('{3}'); // generic 3
  assert.equal(R.canPayManaCost({ ...emptyPool(), W: 1, U: 1, G: 1 }, cost), true);
  assert.equal(R.canPayManaCost({ ...emptyPool(), W: 1, U: 1 }, cost), false);
});

test('deductManaCost: removes colored then generic from largest pool first', () => {
  const cost = R.parseManaCost('{1}{R}'); // {generic:1, R:1}
  const after = R.deductManaCost({ ...emptyPool(), R: 2, G: 1 }, cost);
  // One R spent on the colored pip; the generic 1 comes from the largest
  // remaining pool (R has 1 left, G has 1 -> ties resolve to R's position).
  assert.equal(after.R + after.G, 1, 'exactly one mana left after paying {1}{R} from RRG');
});

// ─────────────────────────────────────────────────────────────
// Spell effect parsing from oracle text  (the fragile regex engine)
// These lock CURRENT behavior. Quirks are noted, not "fixed" here.
// ─────────────────────────────────────────────────────────────
test('parseSpellEffects: direct damage to any target', () => {
  const bolt = { name: 'Lightning Bolt', type_line: 'Instant', oracle_text: 'Lightning Bolt deals 3 damage to any target.' };
  assert.deepEqual(R.parseSpellEffects(bolt), [
    { type: 'damage', amount: 3, targetDesc: 'any target', description: 'Deal 3 damage to any target' },
  ]);
});

test('parseSpellEffects: destroy target creature', () => {
  const murder = { name: 'Murder', type_line: 'Instant', oracle_text: 'Destroy target creature.' };
  const fx = R.parseSpellEffects(murder);
  assert.ok(fx.some(e => e.type === 'destroy' && e.targetType === 'creature'), JSON.stringify(fx));
});

test('parseSpellEffects: exile target creature', () => {
  const path = { name: 'Path to Exile', type_line: 'Instant', oracle_text: 'Exile target creature.' };
  const fx = R.parseSpellEffects(path);
  assert.ok(fx.some(e => e.type === 'exile'), JSON.stringify(fx));
});

test('parseSpellEffects: draw cards', () => {
  const div = { name: 'Divination', type_line: 'Sorcery', oracle_text: 'Draw two cards.' };
  const fx = R.parseSpellEffects(div);
  assert.ok(fx.some(e => e.type === 'draw'), JSON.stringify(fx));
});

test('parseSpellEffects: no-effect / vanilla card yields no parsed effects', () => {
  const bear = { name: 'Grizzly Bears', type_line: 'Creature — Bear', oracle_text: '' };
  assert.deepEqual(R.parseSpellEffects(bear), []);
});

// ─────────────────────────────────────────────────────────────
// Card type predicates
// ─────────────────────────────────────────────────────────────
test('type predicates classify by type_line substring', () => {
  const creature = { type_line: 'Creature — Goblin' };
  const land = { type_line: 'Basic Land — Mountain' };
  const instant = { type_line: 'Instant' };
  const artifact = { type_line: 'Artifact' };
  const ench = { type_line: 'Enchantment — Aura' };
  const pw = { type_line: 'Legendary Planeswalker — Jace' };

  assert.equal(R.isCreature(creature), true);
  assert.equal(R.isLand(land), true);
  assert.equal(R.isInstant(instant), true);
  assert.equal(R.isArtifact(artifact), true);
  assert.equal(R.isEnchantment(ench), true);
  assert.equal(R.isPlaneswalker(pw), true);

  // Cross-checks: a creature is not a land/instant
  assert.equal(R.isLand(creature), false);
  assert.equal(R.isInstant(creature), false);
});

test('type predicates: artifact creature is BOTH artifact and creature', () => {
  const ac = { type_line: 'Artifact Creature — Golem' };
  assert.equal(R.isArtifact(ac), true);
  assert.equal(R.isCreature(ac), true);
});

// ─────────────────────────────────────────────────────────────
// Arena decklist parsing
// ─────────────────────────────────────────────────────────────
test('parseArenaDecklist: qty + name, set, collector number', () => {
  const list = [
    '4 Lightning Bolt',
    '4 Island (ZNR) 271',
    '2 Mountain (ZNR)',
  ].join('\n');
  const entries = R.parseArenaDecklist(list);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], { qty: 4, name: 'Lightning Bolt', set: null, collectorNumber: null, reskin: null, inSideboard: false });
  assert.deepEqual(entries[1], { qty: 4, name: 'Island', set: 'znr', collectorNumber: '271', reskin: null, inSideboard: false });
  assert.deepEqual(entries[2], { qty: 2, name: 'Mountain', set: 'znr', collectorNumber: null, reskin: null, inSideboard: false });
});

test('parseArenaDecklist: comments and blank-only lines are skipped', () => {
  const list = ['// my deck', '#notes', '3 Llanowar Elves'].join('\n');
  const entries = R.parseArenaDecklist(list);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'Llanowar Elves');
});

test('parseArenaDecklist: reskin via ">>" splits name and custom fields', () => {
  const entries = R.parseArenaDecklist('1 Goblin Token >> Pikachu|http://img/pika.png');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'Goblin Token');
  assert.equal(entries[0].reskin.customName, 'Pikachu');
  assert.equal(entries[0].reskin.customImage, 'http://img/pika.png');
});

// ─────────────────────────────────────────────────────────────
// getOracleText — combines main + faces, lowercased
// ─────────────────────────────────────────────────────────────
test('getOracleText: joins main + card_faces oracle, lowercased', () => {
  assert.equal(R.getOracleText({ oracle_text: 'Flying' }), 'flying');
  assert.equal(
    R.getOracleText({ oracle_text: 'CreatureA', card_faces: [{ oracle_text: 'FaceB' }, { oracle_text: 'FaceC' }] }),
    'creaturea\nfaceb\nfacec',
  );
  assert.equal(R.getOracleText({}), '');
});

// ─────────────────────────────────────────────────────────────
// parsePlaneswalkerAbilities — loyalty ability list
// ─────────────────────────────────────────────────────────────
test('parsePlaneswalkerAbilities: bracketed loyalty costs', () => {
  const abilities = R.parsePlaneswalkerAbilities({
    type_line: 'Planeswalker',
    oracle_text: '[+1]: Draw a card.\n[-2]: Create a 3/3 Beast.\n[-7]: You win.',
  });
  assert.deepEqual(abilities, [
    { cost: '+1', text: 'Draw a card.' },
    { cost: '-2', text: 'Create a 3/3 Beast.' },
    { cost: '-7', text: 'You win.' },
  ]);
});

test('parsePlaneswalkerAbilities: no-bracket fallback + unicode minus normalized', () => {
  const abilities = R.parsePlaneswalkerAbilities({
    type_line: 'Planeswalker',
    oracle_text: '+1: Gain 2 life.\n−2: Deal 3 damage.',
  });
  assert.deepEqual(abilities, [
    { cost: '+1', text: 'Gain 2 life.' },
    { cost: '-2', text: 'Deal 3 damage.' },
  ]);
});

// ─────────────────────────────────────────────────────────────
// parseETBEffects — reminder objects ({icon,text,actionType?})
// ─────────────────────────────────────────────────────────────
test('parseETBEffects: damage to target player or planeswalker is auto-resolvable', () => {
  const fx = R.parseETBEffects({ name: 'Viashino Pyromancer', oracle_text: 'When this creature enters, it deals 2 damage to target player or planeswalker.' });
  assert.deepEqual(fx, [
    { icon: '🔥', text: 'Deal 2 damage to target player or planeswalker', actionType: 'etb_damage_player_pw', damage: 2 },
  ]);
});

test('parseETBEffects: target opponent loses life', () => {
  const fx = R.parseETBEffects({ name: "Geralf's Messenger", oracle_text: 'This creature enters tapped. When this creature enters, target opponent loses 2 life.' });
  assert.ok(fx.some(e => /loses 2 life/.test(e.text)), JSON.stringify(fx));
  // Importantly NOT parsed as a discard (the spell parser's mistake).
  assert.ok(!fx.some(e => /discard/i.test(e.text)), JSON.stringify(fx));
});

test('parseETBEffects: returns [] for a card with no ETB trigger', () => {
  assert.deepEqual(R.parseETBEffects({ name: 'Grizzly Bears', oracle_text: '' }), []);
});

// ─────────────────────────────────────────────────────────────
// Etape 4 groundwork: devotion, base P/T, type predicates, lands
// ─────────────────────────────────────────────────────────────
test('getLandManaColors: produced_mana wins, else basic-type fallback', () => {
  assert.deepEqual(R.getLandManaColors({ produced_mana: ['G', 'C'], type_line: 'Land' }), ['G', 'C']);
  assert.deepEqual(R.getLandManaColors({ type_line: 'Basic Land — Forest' }), ['G']);
  assert.deepEqual(R.getLandManaColors({ type_line: 'Artifact' }), ['C'], 'no land type -> colorless');
});

test('calculateDevotion: counts colored pips on nonland permanents (hybrid both)', () => {
  const bf = [
    { mana_cost: '{B}{B}', type_line: 'Creature' },
    { mana_cost: '{1}{B}', type_line: 'Creature' },
    { type_line: 'Swamp' }, // land contributes nothing
    { mana_cost: '{B/G}', type_line: 'Creature' }, // hybrid counts both
  ];
  const dev = R.calculateDevotion(bf);
  assert.equal(dev.B, 4);
  assert.equal(dev.G, 1);
});

test('parseDevotionText / getDevotionInfo: extract color + threshold', () => {
  assert.deepEqual(R.parseDevotionText('your devotion to black'), { color: 'B', colorName: 'black', threshold: null });
  assert.deepEqual(R.parseDevotionText('as long as your devotion to white is five or more'),
    { color: 'W', colorName: 'white', threshold: 5 });
  assert.equal(R.getDevotionInfo({ oracle_text: 'A vanilla creature.' }), null);
  assert.equal(R.getDevotionInfo({ oracle_text: 'X is your devotion to black.' }).color, 'B');
});

test('getBasePower / getBaseToughness / hasBasePT: handle plain + card_faces', () => {
  assert.equal(R.getBasePower({ power: '2', toughness: '3' }), '2');
  assert.equal(R.getBaseToughness({ card_faces: [{ power: '4', toughness: '5' }] }), '5');
  assert.equal(R.hasBasePT({ power: '0', toughness: '1' }), true);
  assert.equal(R.hasBasePT({ type_line: 'Instant' }), false);
});

test('type predicates: isSorcery / isSpellCard / isAdventureCard / isSaga', () => {
  assert.equal(R.isSorcery({ type_line: 'Sorcery' }), true);
  assert.equal(R.isSpellCard({ type_line: 'Instant' }), true);
  assert.equal(R.isSpellCard({ type_line: 'Sorcery' }), true);
  assert.equal(R.isSpellCard({ type_line: 'Creature — Bear' }), false);
  assert.equal(R.isAdventureCard({ layout: 'adventure', card_faces: [{}, {}] }), true);
  assert.equal(R.isAdventureCard({ layout: 'normal' }), false);
  assert.equal(R.isSaga({ type_line: 'Enchantment — Saga' }), true);
});

// ─────────────────────────────────────────────────────────────
// Etape 4 groundwork (batch 2): display / cycling / foretell / saga / delirium
// ─────────────────────────────────────────────────────────────
test('getDisplayName / getReskinArt honor reskin overrides', () => {
  assert.equal(R.getDisplayName({ name: 'Goblin Token' }), 'Goblin Token');
  assert.equal(R.getDisplayName({ name: 'Goblin Token', _reskin: { customName: 'Pikachu' } }), 'Pikachu');
  assert.equal(R.getReskinArt({ _reskin: { customImage: 'http://x/pika.png' } }), 'http://x/pika.png');
  assert.equal(R.getReskinArt({ name: 'X' }), null);
});

test('getCyclingCost / getForetellCost gate on card.keywords, then parse the cost', () => {
  // The function requires the Scryfall keyword to be present before parsing.
  assert.equal(R.getCyclingCost({ keywords: ['Cycling'], oracle_text: 'Cycling {2}' }), '{2}');
  assert.equal(R.getCyclingCost({ oracle_text: 'Cycling {2}' }), null, 'no keyword -> null');
  assert.ok(R.getForetellCost({ keywords: ['Foretell'], oracle_text: 'Foretell {1}{U}' }));
});

test('hasDelirium / countGraveyardTypes count distinct card types in graveyard', () => {
  const gy = { graveyard: [{ type_line: 'Creature — Bear' }, { type_line: 'Instant' }, { type_line: 'Sorcery' }, { type_line: 'Land' }] };
  assert.equal(R.countGraveyardTypes(gy), 4);
  assert.equal(R.hasDelirium(gy), true);
  assert.equal(R.hasDelirium({ graveyard: [{ type_line: 'Creature' }, { type_line: 'Instant' }] }), false);
});

test('shuffle returns a permutation (same multiset)', () => {
  const out = R.shuffle([1, 2, 3, 4, 5]);
  assert.equal(out.length, 5);
  assert.deepEqual([...out].sort(), [1, 2, 3, 4, 5]);
});

// ─────────────────────────────────────────────────────────────
// Static/triggered permanent-ability detectors (Roiling Vortex et al.)
// ─────────────────────────────────────────────────────────────
test('Roiling Vortex: all three abilities detected (incl. curly apostrophe)', () => {
  const rv = {
    name: 'Roiling Vortex',
    oracle_text: 'Players can’t gain life.\nAt the beginning of your upkeep, Roiling Vortex deals 1 damage to each player.\nWhenever a player casts a spell, if no mana was spent to cast it, Roiling Vortex deals 5 damage to that player.',
  };
  assert.equal(R.preventsLifeGain(rv), true);
  assert.equal(R.upkeepDamageEachPlayer(rv), 1);
  // Must pick the free-cast clause's 5, NOT the upkeep clause's 1.
  assert.equal(R.freeCastPunishDamage(rv), 5);
});

test('detectors: name fallback when oracle text has not synced', () => {
  const rv = { name: 'Roiling Vortex' };
  assert.equal(R.preventsLifeGain(rv), true);
  assert.equal(R.upkeepDamageEachPlayer(rv), 1);
  assert.equal(R.freeCastPunishDamage(rv), 5);
});

test('detectors: a vanilla card matches none of them', () => {
  const bear = { name: 'Grizzly Bears', oracle_text: '' };
  assert.equal(R.preventsLifeGain(bear), false);
  assert.equal(R.upkeepDamageEachPlayer(bear), 0);
  assert.equal(R.freeCastPunishDamage(bear), 0);
});

test('preventsLifeGain: generic match works for other anti-lifegain cards', () => {
  assert.equal(R.preventsLifeGain({ name: 'Tibalt thing', oracle_text: "players can't gain life." }), true);
});
