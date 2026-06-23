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

const { getCardEffects, CARD_EFFECTS } = require('../client/public/card-effects.js');

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

test('empty / missing input returns an empty effect list', () => {
  assert.deepEqual(getCardEffects(null), []);
  assert.deepEqual(getCardEffects({ name: 'Grizzly Bears', type_line: 'Creature — Bear', oracle_text: '' }), []);
});

test('registry is keyed by real Scryfall name (reskins keep card.name)', () => {
  // A reskinned card keeps its real name in card.name (the skin only overrides
  // display), so a reskinned Lightning Strike still hits the registry entry.
  const reskinned = { name: 'Lightning Strike', _reskin: { customName: 'Pikachu Shock' }, type_line: 'Instant' };
  assert.deepEqual(getCardEffects(reskinned), CARD_EFFECTS['Lightning Strike']);
});
