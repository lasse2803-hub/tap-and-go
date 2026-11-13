/**
 * M2 — White Knight: one rules scenario per card (exact oracle behavior), plus the engine
 * machinery they need (planeswalker loyalty, devotion, state-dependent types and P/T,
 * cost increases, life-gain triggers, linked exile, graveyard targets, "up to one",
 * sacrifice and counter-removal costs, Clues, "for as long as" restrictions).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const G = require('../server/engine/game');
const db = require('../server/engine/cardDb');
const K = require('../server/engine/testkit');

const life = (s, p) => s.players[p].life;
const P1 = { kind: 'player', player: 1 };
const perm = (c) => ({ kind: 'perm', id: c.id });
const resolveTop = (s) => { K.pass(s); K.pass(s); };
const named = (s, name) => s.battlefield.find(c => c.name === name);

test('Hopeful Initiate: training, and {2}{W} + two +1/+1 counters destroys an artifact', () => {
  const s = K.setup({ step: 'beginCombat' });
  const ini = K.add(s, 0, 'Hopeful Initiate'); // 1/2
  const bear = K.add(s, 0, 'T Bear');          // 2/2
  K.passUntil(s, x => x.pending.kind === 'attackers');
  K.act(s, { type: 'declareAttackers', attackers: [ini, bear].map(c => ({ id: c.id, target: 'player' })) });
  assert.equal(s.stack.length, 1, 'training triggers: attacks with a creature with greater power');
  resolveTop(s);
  assert.equal(ini.counters['+1/+1'], 1);

  const alone = K.setup({ step: 'beginCombat' });
  const ini2 = K.add(alone, 0, 'Hopeful Initiate');
  K.passUntil(alone, x => x.pending.kind === 'attackers');
  K.act(alone, { type: 'declareAttackers', attackers: [{ id: ini2.id, target: 'player' }] });
  assert.equal(alone.stack.length, 0, 'no training when attacking alone');

  const equal = K.setup({ step: 'beginCombat' });
  const ini4 = K.add(equal, 0, 'Hopeful Initiate');       // power 1
  const peer = K.add(equal, 0, 'T Deathtoucher');         // power 1 — not greater
  K.passUntil(equal, x => x.pending.kind === 'attackers');
  K.act(equal, { type: 'declareAttackers', attackers: [ini4, peer].map(c => ({ id: c.id, target: 'player' })) });
  assert.equal(equal.stack.length, 0, 'no training with an attacker of equal power');

  const t = K.setup();
  K.lands(t, 0, 'Plains', 3);
  const i3 = K.add(t, 0, 'Hopeful Initiate', 'battlefield', { counters: { '+1/+1': 1 } });
  const b3 = K.add(t, 0, 'T Bear', 'battlefield', { counters: { '+1/+1': 1 } });
  const hole = K.add(t, 1, 'Portable Hole');
  const acts = G.legalActions(t).filter(a => a.type === 'activate' && a.cardId === i3.id);
  assert.equal(acts.length, 1, 'one way to pay: a counter from each creature');
  assert.deepEqual(acts[0].removeFrom.slice().sort(), [i3.id, b3.id].sort());
  K.act(t, acts[0]);
  resolveTop(t);
  assert.equal(K.where(t, hole), 'graveyard');
  assert.equal(i3.counters['+1/+1'], 0);
  assert.equal(b3.counters['+1/+1'], 0);
});

test('Thalia: noncreature spells cost {1} more — for every player; creature spells do not', () => {
  const s = K.setup();
  K.add(s, 0, 'Thalia, Guardian of Thraben');
  K.lands(s, 0, 'Mountain', 2);
  K.lands(s, 1, 'Mountain', 2);
  const ls = K.add(s, 0, 'Lightning Strike', 'hand');
  const bear = K.add(s, 0, 'T Bear', 'hand');
  const theirs = K.add(s, 1, 'Lightning Strike', 'hand');
  assert.ok(!G.legalActions(s).some(a => a.cardId === ls.id), 'Strike now costs 3');
  assert.ok(G.legalActions(s).some(a => a.cardId === bear.id), 'creature spell unaffected');
  K.pass(s);
  assert.ok(!G.legalActions(s).some(a => a.cardId === theirs.id), "Thalia taxes the opponent's spells too");
  K.pass(s); // back to P0 (stack empty → next step), return to main
  const t = K.setup();
  K.add(t, 0, 'Thalia, Guardian of Thraben');
  K.lands(t, 0, 'Mountain', 3);
  const ls2 = K.add(t, 0, 'Lightning Strike', 'hand');
  K.act(t, { type: 'cast', cardId: ls2.id, targets: [P1] });
  assert.equal(t.battlefield.filter(c => c.name === 'Mountain' && c.tapped).length, 3);
});

test('Luminarch Aspirant: +1/+1 counter at the beginning of combat on your turn only', () => {
  const s = K.setup();
  const lum = K.add(s, 0, 'Luminarch Aspirant');
  K.passUntil(s, x => x.step === 'beginCombat');
  assert.equal(s.stack.length, 1);
  resolveTop(s);
  assert.equal(G.powerOf(s, lum), 2);

  const t = K.setup();
  K.add(t, 0, 'Luminarch Aspirant');
  const bear = K.add(t, 0, 'T Bear');
  const theirs = K.add(t, 1, 'T Bear');
  K.passUntil(t, x => x.pending.kind === 'triggerTargets');
  const opts = G.legalActions(t).map(a => a.targets[0].id);
  assert.ok(opts.includes(bear.id) && !opts.includes(theirs.id), 'target creature you control');
  K.act(t, { type: 'chooseTargets', targets: [perm(bear)] });
  resolveTop(t);
  assert.equal(G.powerOf(t, bear), 3);
  K.skipTo(t, x => x.turn === 4 && x.step === 'beginCombat');
  assert.equal(t.turn, 4);
  assert.equal(t.step, 'beginCombat');
  assert.equal(t.pending.kind, 'priority', 'no trigger waiting for a target');
  assert.equal(t.triggerQueue.length + t.stack.length, 0, "no trigger on the opponent's turn");
});

test("Adeline: power = creatures you control; whenever you attack, a 1/1 Human attacks too", () => {
  const s = K.setup({ step: 'beginCombat' });
  const ad = K.add(s, 0, 'Adeline, Resplendent Cathar');
  const bear = K.add(s, 0, 'T Bear');
  assert.equal(G.powerOf(s, ad), 2);
  K.passUntil(s, x => x.pending.kind === 'attackers');
  K.act(s, { type: 'declareAttackers', attackers: [{ id: bear.id, target: 'player' }] });
  assert.equal(s.stack.length, 1, 'triggers even though Adeline does not attack');
  resolveTop(s);
  const human = named(s, 'Human');
  assert.ok(human && human.tapped && s.combat.attackers.some(a => a.id === human.id));
  assert.equal(G.powerOf(s, ad), 3);
  K.passUntil(s, x => x.step === 'endCombat');
  assert.equal(life(s, 1), 17);
  assert.throws(() => G.powerOf(undefined, ad), /depends on the game state/);
});

test('Accorder Paladin: battle cry gives each OTHER attacker +1/+0', () => {
  const s = K.setup({ step: 'beginCombat' });
  const pal = K.add(s, 0, 'Accorder Paladin');
  const bear = K.add(s, 0, 'T Bear');
  K.passUntil(s, x => x.pending.kind === 'attackers');
  K.act(s, { type: 'declareAttackers', attackers: [pal, bear].map(c => ({ id: c.id, target: 'player' })) });
  resolveTop(s);
  assert.equal(G.powerOf(s, bear), 3);
  assert.equal(G.powerOf(s, pal), 3, 'not itself');
  K.passUntil(s, x => x.step === 'endCombat');
  assert.equal(life(s, 1), 14);
});

test('Skyclave Apparition: exiles up to one nonland nontoken MV≤4; leaving makes an X/X Illusion', () => {
  const s = K.setup();
  K.lands(s, 0, 'Plains', 3);
  K.lands(s, 1, 'Swamp', 2);
  const lum = K.add(s, 1, 'Luminarch Aspirant');
  const big = K.add(s, 1, 'Elder Gargaroth');
  const sky = K.add(s, 0, 'Skyclave Apparition', 'hand');
  K.act(s, { type: 'cast', cardId: sky.id });
  resolveTop(s);
  assert.equal(s.pending.kind, 'triggerTargets');
  const opts = G.legalActions(s).map(a => a.targets[0]);
  assert.ok(opts.includes(null), '"up to one": choosing nothing is allowed');
  const ids = opts.filter(Boolean).map(t => t.id);
  assert.ok(ids.includes(lum.id));
  assert.ok(!ids.includes(big.id), 'mana value 5 is too big');
  assert.ok(!s.battlefield.some(c => c.controller === 1 && c.name === 'Swamp' && ids.includes(c.id)), 'no lands');
  K.act(s, { type: 'chooseTargets', targets: [perm(lum)] });
  resolveTop(s);
  assert.equal(K.where(s, lum), 'exile');

  K.pass(s); // P1 kills the Apparition
  const grasp = K.add(s, 1, 'Infernal Grasp', 'hand');
  K.act(s, { type: 'cast', cardId: grasp.id, targets: [perm(sky)] });
  resolveTop(s);
  assert.equal(K.where(s, sky), 'graveyard');
  resolveTop(s); // leaves-the-battlefield trigger
  const ill = named(s, 'Illusion');
  assert.ok(ill, 'Illusion token created');
  assert.equal(ill.controller, 1, "for the exiled card's owner");
  assert.equal(G.powerOf(s, ill), 2);
  assert.equal(G.toughOf(s, ill), 2);
});

test("Extraction Specialist: reanimates MV≤2; it can't attack while you control the Specialist", () => {
  const s = K.setup();
  K.lands(s, 0, 'Plains', 3);
  K.lands(s, 0, 'Swamp', 2);
  const bear = K.add(s, 0, 'T Bear', 'graveyard');
  K.add(s, 0, 'Heliod, Sun-Crowned', 'graveyard'); // creature card, MV 3: not a legal target
  const ex = K.add(s, 0, 'Extraction Specialist', 'hand');
  K.act(s, { type: 'cast', cardId: ex.id });
  resolveTop(s);
  assert.equal(s.stack.length, 1, 'single legal target chosen automatically');
  resolveTop(s);
  assert.equal(K.where(s, bear), 'battlefield');
  K.skipTo(s, x => x.turn === 5 && x.step === 'main1');
  assert.equal(s.turn, 5);
  const attackers = () => G.eligibleAttackers(s).map(c => c.id);
  assert.ok(!attackers().includes(bear.id), "can't attack while the Specialist is under your control");
  assert.ok(attackers().includes(ex.id));
  const grasp = K.add(s, 0, 'Infernal Grasp', 'hand');
  K.act(s, { type: 'cast', cardId: grasp.id, targets: [perm(ex)] });
  resolveTop(s);
  assert.ok(attackers().includes(bear.id), 'restriction ends when the Specialist leaves');
});

test('Portable Hole: exiles MV≤2 until it leaves — destroying it returns the card', () => {
  const s = K.setup();
  K.lands(s, 0, 'Plains', 1);
  const lum = K.add(s, 1, 'Luminarch Aspirant');
  K.add(s, 1, 'Skyclave Apparition'); // MV 3: not a legal target
  const hole = K.add(s, 0, 'Portable Hole', 'hand');
  K.act(s, { type: 'cast', cardId: hole.id });
  resolveTop(s);
  resolveTop(s); // one legal target → straight onto the stack
  assert.equal(K.where(s, lum), 'exile');

  K.lands(s, 1, 'Plains', 3);
  const ini = K.add(s, 1, 'Hopeful Initiate', 'battlefield', { counters: { '+1/+1': 2 } });
  K.pass(s);
  const act = G.legalActions(s).find(a => a.type === 'activate' && a.cardId === ini.id);
  K.act(s, act);
  resolveTop(s);
  assert.equal(K.where(s, hole), 'graveyard');
  assert.equal(K.where(s, lum), 'battlefield', 'returns when the Hole leaves');
  assert.equal(lum.controller, 1);
});

test('Fateful Absence: destroys; the controller investigates; a Clue draws a card', () => {
  const s = K.setup();
  K.lands(s, 0, 'Plains', 2);
  K.lands(s, 1, 'Swamp', 2);
  const bear = K.add(s, 1, 'T Bear');
  const fa = K.add(s, 0, 'Fateful Absence', 'hand');
  K.act(s, { type: 'cast', cardId: fa.id, targets: [perm(bear)] });
  resolveTop(s);
  assert.equal(K.where(s, bear), 'graveyard');
  const clue = named(s, 'Clue');
  assert.ok(clue && clue.controller === 1, "the destroyed creature's controller gets the Clue");
  K.pass(s);
  const crack = G.legalActions(s).find(a => a.type === 'activate' && a.cardId === clue.id);
  assert.ok(crack);
  K.act(s, crack);
  assert.ok(!named(s, 'Clue'), 'sacrificed as a cost');
  resolveTop(s);
  assert.equal(s.players[1].hand.length, 1);
});

test('The Wandering Emperor: flash, instant-speed loyalty the turn she enters, once per turn', () => {
  const s = K.setup({ active: 1, step: 'beginCombat' });
  const bear = K.add(s, 1, 'T Bear');
  K.lands(s, 0, 'Plains', 4);
  const emp = K.add(s, 0, 'The Wandering Emperor', 'hand');
  K.passUntil(s, x => x.pending.kind === 'attackers');
  K.act(s, { type: 'declareAttackers', attackers: [{ id: bear.id, target: 'player' }] });
  K.pass(s); // P0 gets priority during the opponent's combat
  K.act(s, { type: 'cast', cardId: emp.id });
  resolveTop(s);
  assert.equal(K.where(s, emp), 'battlefield');
  K.pass(s);
  const exile = G.legalActions(s).find(a => a.type === 'activate' && a.ability === 'exile');
  assert.ok(exile, 'loyalty ability at instant speed on the turn she entered');
  assert.deepEqual(exile.targets, [perm(bear)], 'target tapped creature');
  K.act(s, exile);
  assert.equal(emp.counters.loyalty, 1);
  resolveTop(s);
  assert.equal(K.where(s, bear), 'exile');
  assert.equal(life(s, 0), 22);
  assert.ok(!G.legalActions(s).some(a => a.type === 'activate' && a.cardId === emp.id), 'one loyalty ability per turn');

  K.skipTo(s, x => x.turn === 4 && x.step === 'main1');
  assert.equal(s.turn, 4);
  const mine = K.add(s, 0, 'T Bear');
  const plus = G.legalActions(s).find(a => a.type === 'activate' && a.ability === 'plus' && a.targets[0] && a.targets[0].id === mine.id);
  K.act(s, plus);
  resolveTop(s);
  assert.equal(G.powerOf(s, mine), 3);
  assert.ok(G.hasKw(mine, 'first strike'));
  K.skipTo(s, x => x.turn === 5 && x.step === 'main1');
  K.pass(s);
  assert.equal(s.pending.player, 0);
  assert.ok(!G.legalActions(s).some(a => a.type === 'activate' && a.cardId === emp.id), "not at instant speed on later turns");
});

test('Heliod: a creature only at devotion to white ≥ 5', () => {
  const s = K.setup();
  const hel = K.add(s, 0, 'Heliod, Sun-Crowned');
  assert.equal(G.isType(hel, 'Creature', s), false);
  assert.equal(G.isType(hel, 'Enchantment', s), true);
  K.add(s, 0, 'Thalia, Guardian of Thraben');
  K.add(s, 0, 'Adeline, Resplendent Cathar');
  assert.equal(G.devotion(s, 0, 'W'), 4);
  assert.equal(G.isType(hel, 'Creature', s), false);
  K.add(s, 0, 'Luminarch Aspirant');
  assert.equal(G.devotion(s, 0, 'W'), 5);
  assert.equal(G.isType(hel, 'Creature', s), true);
  assert.equal(G.powerOf(s, hel), 5);
  assert.throws(() => G.isType(hel, 'Creature'), /depends on the game state/);
});

test('Heliod: one life-gain event from simultaneous lifelink → one counter; {1}{W} grants lifelink', () => {
  const s = K.setup({ step: 'beginCombat' });
  K.add(s, 0, 'Heliod, Sun-Crowned');
  const l1 = K.add(s, 0, 'T Lifelinker');
  const l2 = K.add(s, 0, 'T Lifelinker');
  K.passUntil(s, x => x.pending.kind === 'attackers');
  K.act(s, { type: 'declareAttackers', attackers: [l1, l2].map(c => ({ id: c.id, target: 'player' })) });
  K.passUntil(s, x => x.pending.kind === 'triggerTargets' || x.step === 'endCombat');
  assert.equal(life(s, 0), 26);
  assert.equal(s.pending.kind, 'triggerTargets');
  K.act(s, { type: 'chooseTargets', targets: [perm(l1)] });
  assert.equal(s.triggerQueue.length, 0);
  assert.equal(s.stack.length, 1, 'exactly one Heliod trigger');
  resolveTop(s);
  assert.equal(l1.counters['+1/+1'], 1);

  const t = K.setup();
  K.lands(t, 0, 'Plains', 2);
  const hel = K.add(t, 0, 'Heliod, Sun-Crowned');
  const bear = K.add(t, 0, 'T Bear');
  const grant = G.legalActions(t).filter(a => a.type === 'activate' && a.cardId === hel.id);
  assert.deepEqual(grant.map(a => a.targets[0].id), [bear.id], 'another target creature');
  K.act(t, grant[0]);
  resolveTop(t);
  assert.ok(G.hasKw(bear, 'lifelink'));
});

test('Mutavault: {1} makes it a 2/2 creature land until end of turn', () => {
  const s = K.setup({ step: 'beginCombat' });
  K.lands(s, 0, 'Plains', 1);
  const mv = K.add(s, 0, 'Mutavault');
  const act = G.legalActions(s).find(a => a.type === 'activate' && a.cardId === mv.id);
  K.act(s, act);
  assert.equal(mv.tapped, false, 'paid with the Plains');
  resolveTop(s);
  assert.ok(G.isType(mv, 'Creature', s) && G.isType(mv, 'Land', s));
  K.passUntil(s, x => x.pending.kind === 'attackers');
  K.act(s, { type: 'declareAttackers', attackers: [{ id: mv.id, target: 'player' }] });
  K.passUntil(s, x => x.step === 'endCombat');
  assert.equal(life(s, 1), 18);
  K.skipTo(s, x => x.turn === 4);
  assert.equal(G.isType(mv, 'Creature', s), false);
});

test('White Knight: every card in the deck is fully implemented', () => {
  const missing = db.getDeck('White Knight').cards.filter(c => G.unimplementedText(c.name)).map(c => c.name);
  assert.deepEqual(missing, []);
});
