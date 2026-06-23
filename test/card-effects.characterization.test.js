'use strict';
/*
 * Characterization tests for the card-effect registry + dispatcher
 * (client/public/card-effects.js), introduced in Etape 2.
 *
 * getCardEffects(card) returns explicit effect DATA from the CARD_EFFECTS
 * registry (keyed by real Scryfall card name) when present, and otherwise falls
 * back to parseSpellEffects(card). The effect objects use the same schema the
 * resolvers in index.html already consume, so resolvers are untouched.
 *
 * These tests pin the dispatch contract: registry-hit, fallback, clone safety
 * (resolvers must not be able to mutate the shared registry), and empty input.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  getCardEffects, CARD_EFFECTS,
  getETBEffects, ETB_EFFECTS,
  getPlaneswalkerAbilities, PW_ABILITIES,
} = require('../client/public/card-effects.js');

test('registry hit: a seeded card returns its explicit effect data', () => {
  // Lightning Strike is a preset card and is seeded in the registry.
  assert.ok(Object.prototype.hasOwnProperty.call(CARD_EFFECTS, 'Lightning Strike'),
    'Lightning Strike should be in the registry');
  const fx = getCardEffects({ name: 'Lightning Strike', type_line: 'Instant', oracle_text: 'Lightning Strike deals 3 damage to any target.' });
  assert.deepEqual(fx, CARD_EFFECTS['Lightning Strike']);
  assert.ok(fx.some(e => e.type === 'damage' && e.amount === 3), JSON.stringify(fx));
});

test('fallback: an unknown card is parsed from oracle text', () => {
  // Not in the registry -> parseSpellEffects handles it.
  const fx = getCardEffects({ name: 'Totally Made Up Card', type_line: 'Instant', oracle_text: 'Totally Made Up Card deals 5 damage to any target.' });
  assert.deepEqual(fx, [
    { type: 'damage', amount: 5, targetDesc: 'any target', description: 'Deal 5 damage to any target' },
  ]);
});

test('clone safety: mutating the returned effects does not corrupt the registry', () => {
  const a = getCardEffects({ name: 'Lightning Strike' });
  a.push({ type: 'bogus' });
  a[0].amount = 999;
  const b = getCardEffects({ name: 'Lightning Strike' });
  assert.equal(b.length, CARD_EFFECTS['Lightning Strike'].length, 'second call unaffected by mutation');
  assert.equal(b[0].amount, 3, 'registry value intact');
});

test('fix: Farewell includes the graveyards category', () => {
  const fx = getCardEffects({ name: 'Farewell' });
  const farewell = fx.find(e => e.type === 'farewell');
  assert.ok(farewell, 'has a farewell effect');
  assert.deepEqual(farewell.categories, ['artifacts', 'creatures', 'enchantments', 'graveyards']);
});

test('fix: Get Lost can target creature, enchantment, or planeswalker', () => {
  const fx = getCardEffects({ name: 'Get Lost' });
  const destroy = fx.find(e => e.type === 'destroy');
  assert.ok(destroy, 'has a destroy effect');
  // targetType is matched by substring in the targeting UI (getLegalTargetTypes).
  assert.match(destroy.targetType, /creature/);
  assert.match(destroy.targetType, /enchantment/);
  assert.match(destroy.targetType, /planeswalker/);
});

test('empty / missing input returns an empty effect list', () => {
  assert.deepEqual(getCardEffects(null), []);
  assert.deepEqual(getCardEffects({ name: 'Grizzly Bears', type_line: 'Creature — Bear', oracle_text: '' }), []);
});

// ── ETB dispatcher ────────────────────────────────────────────
test('getETBEffects: registry hit returns seeded ETB reminder (clone)', () => {
  assert.ok(ETB_EFFECTS['Viashino Pyromancer'], 'Viashino seeded');
  const fx = getETBEffects({ name: 'Viashino Pyromancer' });
  assert.deepEqual(fx, ETB_EFFECTS['Viashino Pyromancer']);
  fx.push({ icon: 'x' });
  assert.equal(getETBEffects({ name: 'Viashino Pyromancer' }).length, ETB_EFFECTS['Viashino Pyromancer'].length, 'clone safety');
});

test('getETBEffects: unknown card falls back to parseETBEffects', () => {
  const fx = getETBEffects({ name: 'Nobody', oracle_text: 'When Nobody enters, gain 3 life.' });
  assert.ok(fx.some(e => /gain 3 life/i.test(e.text)), JSON.stringify(fx));
});

// ── Planeswalker ability dispatcher ───────────────────────────
test('getPlaneswalkerAbilities: registry hit returns seeded ability list (clone)', () => {
  assert.ok(PW_ABILITIES["Elspeth, Sun's Champion"], 'Elspeth seeded');
  const ab = getPlaneswalkerAbilities({ name: "Elspeth, Sun's Champion" });
  assert.deepEqual(ab, PW_ABILITIES["Elspeth, Sun's Champion"]);
  assert.equal(ab[0].cost, '+1');
  ab.pop();
  assert.equal(getPlaneswalkerAbilities({ name: "Elspeth, Sun's Champion" }).length, PW_ABILITIES["Elspeth, Sun's Champion"].length, 'clone safety');
});

test('getPlaneswalkerAbilities: unknown PW falls back to the parser', () => {
  const ab = getPlaneswalkerAbilities({ name: 'Made Up Walker', type_line: 'Planeswalker', oracle_text: '[+2]: Draw a card.' });
  assert.deepEqual(ab, [{ cost: '+2', text: 'Draw a card.' }]);
});

test('registry is keyed by real Scryfall name (reskins keep card.name)', () => {
  // A reskinned card keeps its real name in card.name (the skin only overrides
  // display), so a reskinned Lightning Strike still hits the registry entry.
  const reskinned = { name: 'Lightning Strike', _reskin: { customName: 'Pikachu Shock' }, type_line: 'Instant' };
  assert.deepEqual(getCardEffects(reskinned), CARD_EFFECTS['Lightning Strike']);
});
