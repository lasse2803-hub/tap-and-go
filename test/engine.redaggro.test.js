/**
 * M2 — Red Aggro: one rules scenario per card (exact oracle behavior), plus the engine
 * machinery they need (triggers, tokens, delayed triggers, adventure, spectacle,
 * impulse draw, replacement effects, activated abilities, scry and choices).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const G = require('../server/engine/game');
const K = require('../server/engine/testkit');

const life = (s, p) => s.players[p].life;
const P1 = { kind: 'player', player: 1 };
const resolveTop = (s) => { K.pass(s); K.pass(s); };
const toTop = (s, p, card) => { const lib = s.players[p].library; lib.splice(lib.indexOf(card), 1); lib.unshift(card); };

test('Monastery Swiftspear: prowess +1/+1 on noncreature spells only, until end of turn', () => {
  const s = K.setup();
  K.lands(s, 0, 'Mountain', 3);
  const sw = K.add(s, 0, 'Monastery Swiftspear');
  const mage = K.add(s, 0, 'Soul-Scar Mage', 'hand');
  K.act(s, { type: 'cast', cardId: mage.id });
  assert.equal(s.stack.length, 1, 'creature spell: no prowess trigger');
  resolveTop(s);
  const ls = K.add(s, 0, 'Lightning Strike', 'hand');
  K.act(s, { type: 'cast', cardId: ls.id, targets: [P1] });
  assert.equal(s.stack.length, 3, 'two prowess triggers above Lightning Strike');
  resolveTop(s); resolveTop(s);
  assert.equal(G.powerOf(s, sw), 2);
  assert.equal(G.toughOf(s, sw), 3);
  resolveTop(s);
  assert.equal(life(s, 1), 17);
  K.skipTo(s, x => x.turn === 4);
  assert.equal(s.turn, 4);
  assert.equal(G.powerOf(s, sw), 1, 'prowess wears off at cleanup');
});

test('Soul-Scar Mage: noncombat damage to opposing creatures becomes -1/-1 counters', () => {
  const s = K.setup();
  K.lands(s, 0, 'Mountain', 4);
  K.add(s, 0, 'Soul-Scar Mage');
  const theirs = K.add(s, 1, 'T Trampler'); // 5/5
  const mine = K.add(s, 0, 'T Bear');
  const ls1 = K.add(s, 0, 'Lightning Strike', 'hand');
  const ls2 = K.add(s, 0, 'Lightning Strike', 'hand');
  K.act(s, { type: 'cast', cardId: ls1.id, targets: [{ kind: 'perm', id: theirs.id }] });
  resolveTop(s); resolveTop(s); // prowess, then the Strike
  assert.equal(theirs.counters['-1/-1'], 3);
  assert.equal(theirs.damage, 0, 'no damage was dealt');
  assert.equal(G.toughOf(s, theirs), 2);
  K.act(s, { type: 'cast', cardId: ls2.id, targets: [{ kind: 'perm', id: mine.id }] });
  resolveTop(s); resolveTop(s);
  assert.equal(K.where(s, mine), 'graveyard', 'own creature takes normal damage');

  // Combat damage is not replaced.
  const c = K.setup({ step: 'beginCombat' });
  K.add(c, 0, 'Soul-Scar Mage');
  const bear = K.add(c, 0, 'T Bear');
  const wall = K.add(c, 1, 'T Wall');
  K.combat(c, [bear.id], [{ blocker: wall.id, attacker: bear.id }]);
  assert.equal(wall.damage, 2);
  assert.equal(wall.counters['-1/-1'], undefined);
});

test('Kari Zev: attacking creates Ragavan tapped and attacking; exiled at end of combat', () => {
  const s = K.setup({ step: 'beginCombat' });
  const kari = K.add(s, 0, 'Kari Zev, Skyship Raider');
  K.passUntil(s, x => x.pending.kind === 'attackers');
  K.act(s, { type: 'declareAttackers', attackers: [{ id: kari.id, target: 'player' }] });
  assert.equal(s.stack.length, 1, 'attack trigger on the stack');
  resolveTop(s);
  const rag = s.battlefield.find(c => c.name === 'Ragavan');
  assert.ok(rag && rag.token, 'Ragavan token created');
  assert.ok(rag.tapped);
  assert.ok(s.combat.attackers.some(a => a.id === rag.id), 'Ragavan is attacking');
  K.passUntil(s, x => x.step === 'endCombat');
  assert.equal(life(s, 1), 17, 'Kari 1 + Ragavan 2');
  K.passUntil(s, x => x.step === 'main2');
  assert.ok(!s.battlefield.some(c => c.name === 'Ragavan'), 'Ragavan exiled at end of combat');
});

test('Viashino Pyromancer: enters → 2 damage to target player or planeswalker (chosen)', () => {
  const s = K.setup();
  K.lands(s, 0, 'Mountain', 2);
  const pw = K.add(s, 1, 'Liliana, the Necromancer');
  const v = K.add(s, 0, 'Viashino Pyromancer', 'hand');
  K.act(s, { type: 'cast', cardId: v.id });
  resolveTop(s);
  assert.equal(s.pending.kind, 'triggerTargets');
  const opts = G.legalActions(s).map(a => a.targets[0]);
  assert.equal(opts.length, 3, 'either player or the planeswalker');
  K.act(s, { type: 'chooseTargets', targets: [{ kind: 'perm', id: pw.id }] });
  const loyalty = pw.counters.loyalty;
  resolveTop(s);
  assert.equal(pw.counters.loyalty, loyalty - 2);
  assert.equal(life(s, 1), 20);
});

test('Bonecrusher Giant: Stomp → exile on adventure → cast the Giant from exile; targeting it hurts', () => {
  const s = K.setup();
  K.lands(s, 0, 'Mountain', 5);
  K.lands(s, 1, 'Mountain', 2);
  const bc = K.add(s, 0, 'Bonecrusher Giant', 'hand');
  assert.ok(G.legalActions(s).some(a => a.cardId === bc.id && a.face === 'adventure'));
  K.act(s, { type: 'cast', cardId: bc.id, face: 'adventure', targets: [P1] });
  resolveTop(s);
  assert.equal(life(s, 1), 18);
  assert.equal(s.noPrevention, true, "Stomp: damage can't be prevented this turn");
  assert.equal(K.where(s, bc), 'exile');
  assert.ok(bc.onAdventure);
  assert.ok(!G.legalActions(s).some(a => a.cardId === bc.id && a.face === 'adventure'), 'no second adventure from exile');
  K.act(s, { type: 'cast', cardId: bc.id, targets: [] });
  resolveTop(s);
  assert.equal(K.where(s, bc), 'battlefield');

  K.pass(s); // P1 gets priority and targets the Giant
  const ls = K.add(s, 1, 'Lightning Strike', 'hand');
  K.act(s, { type: 'cast', cardId: ls.id, targets: [{ kind: 'perm', id: bc.id }] });
  assert.equal(s.stack.length, 2, 'becomes-target trigger above the Strike');
  resolveTop(s);
  assert.equal(life(s, 1), 16, "2 damage to the Strike's controller");
  resolveTop(s);
  assert.equal(K.where(s, bc), 'graveyard');
});

test('Bonecrusher Giant: a Stomp that fizzles goes to the graveyard, not on an adventure', () => {
  const s = K.setup();
  K.lands(s, 0, 'Mountain', 2);
  K.lands(s, 1, 'Swamp', 2);
  const bear = K.add(s, 1, 'T Bear');
  const bc = K.add(s, 0, 'Bonecrusher Giant', 'hand');
  const grasp = K.add(s, 1, 'Infernal Grasp', 'hand');
  K.act(s, { type: 'cast', cardId: bc.id, face: 'adventure', targets: [{ kind: 'perm', id: bear.id }] });
  K.pass(s);
  K.act(s, { type: 'cast', cardId: grasp.id, targets: [{ kind: 'perm', id: bear.id }] });
  resolveTop(s); resolveTop(s);
  assert.equal(K.where(s, bc), 'graveyard');
  assert.ok(!bc.onAdventure);
});

test("Phoenix Chick: can't block; returns from graveyard attacking when you attack with 3+", () => {
  const b = K.setup({ step: 'beginCombat' });
  const atk = K.add(b, 0, 'T Bear');
  const chick = K.add(b, 1, 'Phoenix Chick');
  const wall = K.add(b, 1, 'T Wall'); // a creature that CAN block, so a block decision is offered
  K.passUntil(b, x => x.pending.kind === 'attackers');
  K.act(b, { type: 'declareAttackers', attackers: [{ id: atk.id, target: 'player' }] });
  K.passUntil(b, x => x.pending.kind === 'blockers');
  const offer = G.legalActions(b)[0];
  assert.ok(offer.eligible.includes(wall.id));
  assert.ok(!offer.eligible.includes(chick.id), 'Phoenix Chick is not offered as a blocker');
  assert.throws(() => K.act(b, { type: 'declareBlockers', blocks: [{ blocker: chick.id, attacker: atk.id }] }), /cannot block/);

  const s = K.setup({ step: 'beginCombat' });
  K.lands(s, 0, 'Mountain', 2);
  const ph = K.add(s, 0, 'Phoenix Chick', 'graveyard');
  const bears = [K.add(s, 0, 'T Bear'), K.add(s, 0, 'T Bear'), K.add(s, 0, 'T Bear')];
  K.passUntil(s, x => x.pending.kind === 'attackers');
  K.act(s, { type: 'declareAttackers', attackers: bears.map(c => ({ id: c.id, target: 'player' })) });
  assert.equal(s.stack.length, 1, 'graveyard trigger');
  resolveTop(s);
  assert.equal(s.pending.kind, 'choice');
  K.act(s, { type: 'choose', option: 'pay' });
  assert.equal(K.where(s, ph), 'battlefield');
  assert.ok(ph.tapped);
  assert.equal(G.powerOf(s, ph), 2, '+1/+1 counter');
  assert.ok(s.combat.attackers.some(a => a.id === ph.id));
  K.passUntil(s, x => x.step === 'endCombat');
  assert.equal(life(s, 1), 12, '3 bears + Phoenix');

  const two = K.setup({ step: 'beginCombat' });
  K.lands(two, 0, 'Mountain', 2);
  K.add(two, 0, 'Phoenix Chick', 'graveyard');
  const b2 = [K.add(two, 0, 'T Bear'), K.add(two, 0, 'T Bear')];
  K.passUntil(two, x => x.pending.kind === 'attackers');
  K.act(two, { type: 'declareAttackers', attackers: b2.map(c => ({ id: c.id, target: 'player' })) });
  assert.equal(two.stack.length, 0, 'two attackers: no trigger');
});

test('Play with Fire: scry 1 only when a player is dealt damage', () => {
  const s = K.setup();
  K.lands(s, 0, 'Mountain', 2);
  const top = s.players[0].library[0];
  const pwf = K.add(s, 0, 'Play with Fire', 'hand');
  K.act(s, { type: 'cast', cardId: pwf.id, targets: [P1] });
  resolveTop(s);
  assert.equal(s.pending.kind, 'scry');
  assert.deepEqual(s.pending.cards, [top.id]);
  K.act(s, { type: 'scry', top: [], bottom: [top.id] });
  assert.equal(s.players[0].library[s.players[0].library.length - 1], top, 'scryed to the bottom');
  assert.equal(life(s, 1), 18);
  assert.equal(K.where(s, pwf), 'graveyard');
  assert.equal(s.pending.kind, 'priority');

  const bear = K.add(s, 1, 'T Bear');
  const pwf2 = K.add(s, 0, 'Play with Fire', 'hand');
  K.act(s, { type: 'cast', cardId: pwf2.id, targets: [{ kind: 'perm', id: bear.id }] });
  resolveTop(s);
  assert.equal(s.pending.kind, 'priority', 'no scry for a creature target');
  assert.equal(K.where(s, bear), 'graveyard');
});

test('Skewer the Critics: spectacle {R} only after an opponent lost life this turn', () => {
  const s = K.setup();
  K.lands(s, 0, 'Mountain', 2);
  const sk = K.add(s, 0, 'Skewer the Critics', 'hand');
  const pwf = K.add(s, 0, 'Play with Fire', 'hand');
  assert.ok(!G.legalActions(s).some(a => a.cardId === sk.id), 'full cost {2}{R} unaffordable, no spectacle yet');
  K.act(s, { type: 'cast', cardId: pwf.id, targets: [P1] });
  resolveTop(s);
  K.act(s, { type: 'scry', top: s.pending.cards, bottom: [] });
  const opts = G.legalActions(s).filter(a => a.cardId === sk.id);
  assert.ok(opts.length && opts.every(a => a.alt === 'spectacle'));
  K.act(s, { type: 'cast', cardId: sk.id, alt: 'spectacle', targets: [P1] });
  resolveTop(s);
  assert.equal(life(s, 1), 15);
  K.passUntil(s, x => x.turn === 4);
  assert.equal(s.players[1].lostLifeThisTurn, false, '"this turn" resets each turn');
});

test('Light Up the Stage: exile top two, playable until the end of your next turn', () => {
  const s = K.setup();
  K.lands(s, 0, 'Mountain', 3);
  const ls = K.add(s, 0, 'Lightning Strike', 'library');
  const mtn = K.add(s, 0, 'Mountain', 'library');
  toTop(s, 0, mtn); toTop(s, 0, ls);
  const lus = K.add(s, 0, 'Light Up the Stage', 'hand');
  K.act(s, { type: 'cast', cardId: lus.id });
  resolveTop(s);
  assert.equal(K.where(s, ls), 'exile');
  assert.equal(K.where(s, mtn), 'exile');
  assert.ok(G.legalActions(s).some(a => a.type === 'playLand' && a.cardId === mtn.id));
  K.act(s, { type: 'playLand', cardId: mtn.id });
  assert.equal(K.where(s, mtn), 'battlefield');
  assert.equal(s.players[0].landsPlayed, 1, 'uses the land drop');

  K.skipTo(s, x => x.turn === 5 && x.step === 'main1');
  assert.equal(s.turn, 5);
  assert.ok(G.legalActions(s).some(a => a.type === 'cast' && a.cardId === ls.id), 'still playable on your next turn');
  K.skipTo(s, x => x.turn === 6 && x.step === 'main1');
  assert.equal(s.turn, 6);
  K.pass(s); // P0 has priority on P1's turn — Lightning Strike is an instant
  assert.equal(s.pending.player, 0);
  assert.ok(!G.legalActions(s).some(a => a.cardId === ls.id), 'expired after the end of your next turn');
  assert.equal(K.where(s, ls), 'exile');
});

test('Den of the Bugbear: enters tapped with 2+ other lands; animates and makes attacking Goblins', () => {
  const t = K.setup();
  K.lands(t, 0, 'Mountain', 2);
  const den = K.add(t, 0, 'Den of the Bugbear', 'hand');
  K.act(t, { type: 'playLand', cardId: den.id });
  assert.equal(den.tapped, true);

  const u = K.setup();
  K.lands(u, 0, 'Mountain', 1);
  const den2 = K.add(u, 0, 'Den of the Bugbear', 'hand');
  K.act(u, { type: 'playLand', cardId: den2.id });
  assert.equal(den2.tapped, false);

  const s = K.setup({ step: 'beginCombat' });
  K.lands(s, 0, 'Mountain', 4);
  const d = K.add(s, 0, 'Den of the Bugbear');
  const act = G.legalActions(s).find(a => a.type === 'activate' && a.cardId === d.id);
  assert.ok(act, 'ability available with {3}{R}');
  K.act(s, act);
  assert.equal(d.tapped, false, 'paid with the other lands');
  resolveTop(s);
  assert.ok(G.isType(d, 'Creature') && G.isType(d, 'Land'));
  assert.equal(G.powerOf(s, d), 3);
  assert.equal(G.toughOf(s, d), 2);
  K.passUntil(s, x => x.pending.kind === 'attackers');
  K.act(s, { type: 'declareAttackers', attackers: [{ id: d.id, target: 'player' }] });
  resolveTop(s);
  const gob = s.battlefield.find(c => c.name === 'Goblin');
  assert.ok(gob && gob.tapped && s.combat.attackers.some(a => a.id === gob.id));
  K.passUntil(s, x => x.step === 'endCombat');
  assert.equal(life(s, 1), 16, 'Den 3 + Goblin 1');
  K.passUntil(s, x => x.turn === 4);
  assert.equal(G.isType(d, 'Creature'), false, 'back to just a land');
  assert.ok(s.battlefield.includes(gob), 'the Goblin token stays');
});

test('Red Aggro: every card in the deck is fully implemented', () => {
  const db = require('../server/engine/cardDb');
  const missing = db.getDeck('Red Aggro').cards.filter(c => G.unimplementedText(c.name)).map(c => c.name);
  assert.deepEqual(missing, []);
});
