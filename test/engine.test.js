/**
 * Rules-engine tests (M1). Scenario tests assert exact Magic rules outcomes; the
 * invariant tests prove the checker actually catches corruption (a checker that can't
 * fail is worthless); the simulation tests run whole games across all decks.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../server/engine/cardDb');
const G = require('../server/engine/game');
const { parseCost, solvePayment } = require('../server/engine/mana');
const { checkInvariants } = require('../server/engine/invariants');
const { runGame } = require('../server/engine/sim');
const K = require('../server/engine/testkit');

const life = (s, p) => s.players[p].life;

// ─── Card data ───────────────────────────────────────────────────────────────
// Project legality rule (owner's decision): a card is allowed unless it is BANNED in
// Historic. "Not legal" in Historic (not on Arena) is fine; other formats don't count.
test('card db: all decks are 60 cards, every card known and not banned in Historic', () => {
  assert.ok(db.DECKS.length >= 15);
  for (const d of db.DECKS) {
    assert.equal(d.cards.reduce((n, c) => n + c.qty, 0), 60, d.name);
    for (const c of d.cards) {
      const def = db.CARDS[c.name];
      assert.ok(def, `${c.name} in cards.json`);
      assert.notEqual(def.legalities.historic, 'banned', `${c.name} is banned in Historic`);
    }
  }
});

test('card db: every land taps for mana; non-dork creatures and planeswalkers do not', () => {
  for (const name of Object.keys(db.CARDS)) {
    const c = db.char(name);
    if (c.is('Land')) assert.ok(db.manaOptions(name), `${name} should produce mana`);
  }
  assert.equal(db.manaOptions('Old-Growth Troll'), null, 'Troll makes mana only via its aura');
  assert.equal(db.manaOptions('Nissa, Who Shakes the World'), null, 'planeswalker mana is an ability, not a tap');
  assert.deepEqual(db.manaOptions('Nykthos, Shrine to Nyx'), ['C']);
  assert.deepEqual(db.manaOptions('Llanowar Elves'), ['G']);
});

// ─── Mana ────────────────────────────────────────────────────────────────────
test('mana: parseCost handles generic, colors, X and Phyrexian', () => {
  assert.deepEqual(parseCost('{2}{R}{R}'), { generic: 2, colored: { W: 0, U: 0, B: 0, R: 2, G: 0, C: 0 }, phyrexian: [], hasX: false });
  assert.equal(parseCost('{X}{G}', 3).generic, 3);
  assert.equal(parseCost('{X}{G}', 3).hasX, true);
  assert.deepEqual(parseCost('{3}{G/P}').phyrexian, ['G']);
  assert.throws(() => parseCost('{G/W}'), /Unsupported/);
});

test('mana: solver is exact and saves flexible sources', () => {
  const src = (id, options) => ({ id, options });
  assert.ok(solvePayment(parseCost('{1}{G}{G}'), [src('a', ['G']), src('b', ['G']), src('c', ['R'])]));
  assert.equal(solvePayment(parseCost('{1}{G}{G}'), [src('a', ['G']), src('b', ['R']), src('c', ['R'])]), null);
  // W must come from the dual, so G must come from the Forest — greedy-by-order would fail.
  const pay = solvePayment(parseCost('{W}{G}'), [src('dual', ['W', 'G']), src('forest', ['G'])]);
  assert.deepEqual(pay.tap.sort(), ['dual', 'forest']);
  assert.equal(solvePayment(parseCost('{2}'), [src('a', ['R'])]), null);
});

test('mana: Phyrexian paid with life only above 2 life, mana preferred', () => {
  assert.deepEqual(solvePayment(parseCost('{G/P}'), [], 20), { tap: [], life: 2 });
  assert.equal(solvePayment(parseCost('{G/P}'), [], 4), null);
  assert.deepEqual(solvePayment(parseCost('{G/P}'), [{ id: 'f', options: ['G'] }], 20), { tap: ['f'], life: 0 });
});

// ─── Turn structure & priority ───────────────────────────────────────────────
test('turn: starting player skips the first draw; the other player draws', () => {
  const s = G.createGame({ decks: ['Red Aggro', 'Blue Control'], seed: 3 });
  const first = s.firstPlayer, second = 1 - first;
  K.act(s, { type: 'keep' }); K.act(s, { type: 'keep' });
  assert.equal(s.turn, 1);
  assert.equal(s.step, 'upkeep');
  K.passUntil(s, x => x.step === 'main1');
  assert.equal(s.players[first].hand.length, 7, 'no draw on turn 1');
  K.passUntil(s, x => x.turn === 2 && x.step === 'main1');
  assert.equal(s.active, second);
  assert.equal(s.players[second].hand.length, 8, 'second player drew');
});

test('turn: one land per turn, sorcery speed only in own main phase with empty stack', () => {
  const s = K.setup();
  const l1 = K.add(s, 0, 'Forest', 'hand');
  const l2 = K.add(s, 0, 'Forest', 'hand');
  K.act(s, { type: 'playLand', cardId: l1.id });
  assert.ok(!G.legalActions(s).some(a => a.type === 'playLand'), 'second land not allowed');
  assert.throws(() => K.act(s, { type: 'playLand', cardId: l2.id }), /Illegal/);

  // A creature can't be cast on the opponent's turn; a flash creature can.
  const t = K.setup({ active: 1 });
  K.lands(t, 0, 'Forest', 3);
  const bear = K.add(t, 0, 'T Bear', 'hand');
  const flash = K.add(t, 0, 'T Flash Bear', 'hand');
  K.pass(t); // P1 passes → P0 has priority on P1's turn
  const acts = G.legalActions(t);
  assert.ok(!acts.some(a => a.cardId === bear.id), 'no sorcery-speed creature on opp turn');
  assert.ok(acts.some(a => a.cardId === flash.id), 'flash creature castable');
});

test('stack: last in, first out; both players must pass to resolve', () => {
  const s = K.setup();
  K.lands(s, 0, 'Mountain', 2);
  K.lands(s, 1, 'Mountain', 2);
  const a = K.add(s, 0, 'Lightning Strike', 'hand');
  const b = K.add(s, 1, 'Lightning Strike', 'hand');
  K.act(s, { type: 'cast', cardId: a.id, targets: [{ kind: 'player', player: 1 }] });
  K.pass(s); // P0 passes, P1 responds
  K.act(s, { type: 'cast', cardId: b.id, targets: [{ kind: 'player', player: 0 }] });
  assert.equal(s.stack.length, 2);
  K.pass(s); K.pass(s); // resolves P1's Strike (top)
  assert.equal(life(s, 0), 17);
  assert.equal(life(s, 1), 20, "P0's spell not resolved yet");
  K.pass(s); K.pass(s);
  assert.equal(life(s, 1), 17);
  assert.equal(s.stack.length, 0);
  assert.equal(K.where(s, a), 'graveyard');
});

// ─── Combat ──────────────────────────────────────────────────────────────────
const combatSetup = () => K.setup({ step: 'beginCombat' });

test('combat: unblocked damage; summoning-sick creatures cannot attack, haste can', () => {
  const s = combatSetup();
  const bear = K.add(s, 0, 'T Bear');
  const sick = K.add(s, 0, 'T Bear', 'battlefield', { sick: true });
  const hasty = K.add(s, 0, 'T Haste', 'battlefield', { sick: true });
  K.passUntil(s, x => x.pending.kind === 'attackers');
  const elig = G.legalActions(s)[0].eligible;
  assert.ok(elig.includes(bear.id) && elig.includes(hasty.id) && !elig.includes(sick.id));
  K.act(s, { type: 'declareAttackers', attackers: [{ id: bear.id, target: 'player' }, { id: hasty.id, target: 'player' }] });
  K.passUntil(s, x => x.step === 'endCombat');
  assert.equal(life(s, 1), 16);
  assert.ok(bear.tapped);
});

test('combat: flying can only be blocked by flying or reach', () => {
  const s = combatSetup();
  const flyer = K.add(s, 0, 'T Flyer');
  const bear = K.add(s, 1, 'T Bear');
  const reach = K.add(s, 1, 'T Reach');
  K.passUntil(s, x => x.pending.kind === 'attackers');
  K.act(s, { type: 'declareAttackers', attackers: [{ id: flyer.id, target: 'player' }] });
  K.passUntil(s, x => x.pending.kind === 'blockers');
  assert.throws(() => K.act(s, { type: 'declareBlockers', blocks: [{ blocker: bear.id, attacker: flyer.id }] }), /evasion/);
  K.act(s, { type: 'declareBlockers', blocks: [{ blocker: reach.id, attacker: flyer.id }] });
  K.passUntil(s, x => x.step === 'endCombat');
  assert.equal(life(s, 1), 20);
  assert.equal(reach.damage, 2); // 1/3 survives 2 damage
});

test('combat: first strike kills the blocker before it deals damage', () => {
  const s = combatSetup();
  const fs = K.add(s, 0, 'T First Striker');
  const bear = K.add(s, 1, 'T Bear');
  K.combat(s, [fs.id], [{ blocker: bear.id, attacker: fs.id }]);
  assert.equal(K.where(s, bear), 'graveyard');
  assert.equal(K.where(s, fs), 'battlefield');
  assert.equal(fs.damage, 0);
});

test('combat: double strike deals damage in both steps', () => {
  const s = combatSetup();
  const ds = K.add(s, 0, 'T Double Striker');
  K.combat(s, [ds.id]);
  assert.equal(life(s, 1), 16);
});

test('combat: trample assigns lethal to the blocker and the rest to the player', () => {
  const s = combatSetup();
  const t = K.add(s, 0, 'T Trampler');
  const bear = K.add(s, 1, 'T Bear');
  K.combat(s, [t.id], [{ blocker: bear.id, attacker: t.id }]);
  assert.equal(life(s, 1), 17);
  assert.equal(K.where(s, bear), 'graveyard');
});

test('combat: deathtouch + trample needs only 1 damage on each blocker', () => {
  const s = combatSetup();
  const t = K.add(s, 0, 'T DT Trampler');
  const wall = K.add(s, 1, 'T Wall');
  K.combat(s, [t.id], [{ blocker: wall.id, attacker: t.id }]);
  assert.equal(life(s, 1), 16, '4 tramples over');
  assert.equal(K.where(s, wall), 'graveyard', 'deathtouch kills a 0/5');
});

test('combat: deathtouch blocker kills a big attacker; lifelink gains life', () => {
  const s = combatSetup();
  const ll = K.add(s, 0, 'T Lifelinker');
  const big = K.add(s, 0, 'T Trampler');
  const dt = K.add(s, 1, 'T Deathtoucher');
  K.combat(s, [ll.id, big.id], [{ blocker: dt.id, attacker: big.id }]);
  assert.equal(K.where(s, big), 'graveyard', 'deathtouch');
  assert.equal(life(s, 0), 23, 'lifelink +3');
  assert.equal(life(s, 1), 20 - 3 - 4, 'lifelinker 3 + trample excess 4');
});

test('combat: menace needs two blockers; vigilance does not tap', () => {
  const s = combatSetup();
  const m = K.add(s, 0, 'T Menace');
  const v = K.add(s, 0, 'T Vigilant');
  const b1 = K.add(s, 1, 'T Bear');
  const b2 = K.add(s, 1, 'T Bear');
  K.passUntil(s, x => x.pending.kind === 'attackers');
  K.act(s, { type: 'declareAttackers', attackers: [{ id: m.id, target: 'player' }, { id: v.id, target: 'player' }] });
  assert.equal(v.tapped, false);
  assert.equal(m.tapped, true);
  K.passUntil(s, x => x.pending.kind === 'blockers');
  assert.throws(() => K.act(s, { type: 'declareBlockers', blocks: [{ blocker: b1.id, attacker: m.id }] }), /menace/);
  K.act(s, { type: 'declareBlockers', blocks: [{ blocker: b1.id, attacker: m.id }, { blocker: b2.id, attacker: m.id }] });
  K.passUntil(s, x => x.step === 'endCombat');
  assert.equal(life(s, 1), 18, 'only the vigilant 2/2 connected');
  assert.equal(K.where(s, m), 'graveyard', '3/3 menace takes 4');
});

test('combat: indestructible survives lethal damage; damage wears off at cleanup', () => {
  const s = combatSetup();
  const ind = K.add(s, 0, 'T Indestructible');
  const big = K.add(s, 1, 'T Trampler');
  K.combat(s, [ind.id], [{ blocker: big.id, attacker: ind.id }]);
  assert.equal(K.where(s, ind), 'battlefield');
  assert.equal(ind.damage, 5);
  K.passUntil(s, x => x.turn === 4);
  assert.equal(ind.damage, 0);
});

test('combat: attacking a planeswalker removes loyalty; 0 loyalty → graveyard', () => {
  const s = combatSetup();
  const big = K.add(s, 0, 'T Trampler');
  const pw = K.add(s, 1, 'Liliana, the Necromancer');
  assert.ok(pw.counters.loyalty <= 5);
  K.combat(s, [{ id: big.id, target: pw.id }]);
  assert.equal(K.where(s, pw), 'graveyard');
  assert.equal(life(s, 1), 20);
});

// ─── State-based actions & game end ─────────────────────────────────────────
test('sba: legend rule keeps the newest copy', () => {
  const s = K.setup();
  K.lands(s, 0, 'Forest', 2);
  const old = K.add(s, 0, 'T Legend');
  const fresh = K.add(s, 0, 'T Legend', 'hand');
  K.act(s, { type: 'cast', cardId: fresh.id });
  K.pass(s); K.pass(s);
  assert.equal(K.where(s, fresh), 'battlefield');
  assert.equal(K.where(s, old), 'graveyard');
});

test('sba: 0 life ends the game; drawing from an empty library loses', () => {
  const s = K.setup({ life: [20, 3] });
  K.lands(s, 0, 'Mountain', 2);
  const ls = K.add(s, 0, 'Lightning Strike', 'hand');
  K.act(s, { type: 'cast', cardId: ls.id, targets: [{ kind: 'player', player: 1 }] });
  K.pass(s); K.pass(s);
  assert.equal(s.over, true);
  assert.equal(s.winner, 0);

  const d = K.setup({ active: 0, step: 'end', library: 0 });
  K.passUntil(d, x => x.over);
  assert.equal(d.over, true);
  assert.equal(d.winner, 0, 'P1 drew from an empty library on turn 4');
  assert.match(d.reason, /empty library/);
});

// ─── Card implementations ───────────────────────────────────────────────────
test('spells: Lightning Strike kills a 3-toughness creature; fizzles if target leaves', () => {
  const s = K.setup();
  K.lands(s, 0, 'Mountain', 2);
  K.lands(s, 1, 'Swamp', 2);
  const victim = K.add(s, 1, 'T Reach'); // 1/3
  const ls = K.add(s, 0, 'Lightning Strike', 'hand');
  const grasp = K.add(s, 1, 'Infernal Grasp', 'hand');
  K.act(s, { type: 'cast', cardId: ls.id, targets: [{ kind: 'perm', id: victim.id }] });
  K.pass(s);
  // P1 kills their own creature in response → Lightning Strike has no legal target.
  K.act(s, { type: 'cast', cardId: grasp.id, targets: [{ kind: 'perm', id: victim.id }] });
  K.pass(s); K.pass(s);
  assert.equal(K.where(s, victim), 'graveyard');
  assert.equal(life(s, 1), 18, 'Infernal Grasp: caster loses 2');
  K.pass(s); K.pass(s);
  assert.equal(K.where(s, ls), 'graveyard', 'fizzled Strike still goes to the graveyard');
  assert.equal(life(s, 1), 18);
});

test('spells: hexproof blocks opponent targeting; Damnation spares only indestructible', () => {
  const s = K.setup();
  K.lands(s, 0, 'Swamp', 4);
  const hx = K.add(s, 1, 'T Hexproof');
  const ind = K.add(s, 1, 'T Indestructible');
  const mine = K.add(s, 0, 'T Bear');
  const grasp = K.add(s, 0, 'Infernal Grasp', 'hand');
  const casts = G.legalActions(s).filter(a => a.cardId === grasp.id);
  assert.ok(!casts.some(a => a.targets[0].id === hx.id), 'hexproof not targetable by opponent');
  assert.ok(casts.some(a => a.targets[0].id === mine.id), 'own creature targetable');
  const damn = K.add(s, 0, 'Damnation', 'hand');
  K.act(s, { type: 'cast', cardId: damn.id });
  K.pass(s); K.pass(s);
  assert.deepEqual(s.battlefield.filter(c => db.char(c.name).is('Creature')).map(c => c.id), [ind.id]);
});

// ─── Invariant checker must catch corruption ────────────────────────────────
test('invariants: a duplicated card is caught', () => {
  const s = K.setup();
  const c = K.add(s, 0, 'T Bear');
  s.players[0].hand.push(c);
  assert.match(checkInvariants(s).join('\n'), /is in/);
});

test('invariants: a vanished card is caught', () => {
  const s = K.setup();
  s.players[0].library.pop();
  assert.match(checkInvariants(s).join('\n'), /cards, expected/);
});

test('invariants: skipped state-based actions, land on stack, extra land drop are caught', () => {
  const s = K.setup();
  K.add(s, 0, 'T Bear', 'battlefield', { damage: 2 });
  assert.match(checkInvariants(s).join('\n'), /should have died/);

  const t = K.setup();
  const land = K.add(t, 0, 'Forest', 'hand');
  t.players[0].hand.pop();
  t.stack.push({ kind: 'spell', card: land, controller: 0, face: 'main', targets: [], x: 0 });
  t.players[0].landsPlayed = 2;
  const msg = checkInvariants(t).join('\n');
  assert.match(msg, /land Forest on the stack/);
  assert.match(msg, /played 2 lands/);

  const u = K.setup({ life: [0, 20] });
  assert.match(checkInvariants(u).join('\n'), /at 0 life but game continues/);
});

test('engine rejects illegal actions instead of corrupting state', () => {
  const s = K.setup();
  const bear = K.add(s, 0, 'T Bear', 'hand');
  assert.throws(() => K.act(s, { type: 'cast', cardId: bear.id }), /cannot pay/);
  assert.throws(() => G.applyAction(s, { type: 'pass', player: 1 }), /P0's decision/);
  assert.throws(() => K.act(s, { type: 'playLand', cardId: bear.id }), /cannot play that land/);
  assert.deepEqual(checkInvariants(s), []);
});

// ─── Whole games ─────────────────────────────────────────────────────────────
test('sim: games are deterministic per seed', () => {
  const run = () => {
    const s = runGame({ decks: ['Gruul Dinosaurs', 'Golgari Nissa Control'], seed: 99, policies: ['sensible', 'chaos'] });
    return JSON.stringify({ w: s.winner, t: s.turn, l: s.players.map(p => p.life), a: s.stats.actions, bf: s.battlefield.map(c => c.name) });
  };
  assert.equal(run(), run());
});

test('sim: 300 games across all deck pairings finish with zero invariant violations', () => {
  const names = db.DECKS.map(d => d.name);
  let finished = 0;
  for (let g = 0; g < 300; g++) {
    const i = g % (names.length * names.length);
    const policies = [['sensible', 'sensible'], ['chaos', 'chaos'], ['sensible', 'chaos']][g % 3];
    const s = runGame({ decks: [names[Math.floor(i / names.length)], names[i % names.length]], seed: 5000 + g, policies });
    if (s.over) finished++;
  }
  assert.equal(finished, 300);
});
