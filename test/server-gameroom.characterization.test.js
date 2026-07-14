'use strict';
/*
 * Characterization tests for the SERVER game state (GameRoom).
 *
 * GameRoom.js is already a real module, so these tests import it directly and
 * exercise its true behavior — no sandbox needed. They pin the CURRENT
 * "trust-the-client" sync semantics and the few server-authoritative actions
 * (bounce / discard / mill / mulligan / returnToOwnerZone) plus Bo3 scoring.
 *
 * WHY THIS IS THE KEY SAFETY NET FOR THE SYNC REFACTOR (Etape 3):
 * Each test below references a behavior that moving authority to the server must
 * either PRESERVE or CONSCIOUSLY change. Several encode the current desync
 * protections (e.g. "opponent can't overwrite my library", "turnNumber only
 * increases", "spellStack version gating"). When Etape 3 replaces the merge with
 * a real authoritative model, these tests document exactly what behavior is at
 * stake.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

// Silence GameRoom's console logging so test output stays readable.
const origLog = console.log;
const origWarn = console.warn;
console.log = () => {};
console.warn = () => {};

const GameRoom = require('../server/GameRoom.js');

// ── Test fixtures ─────────────────────────────────────────────
function makeDeck(prefix, size = 60) {
  // Raw card objects (flattenDeck adds ids). A few lands so type filters have data.
  const cards = [];
  for (let i = 0; i < size; i++) {
    const isLand = i < 24;
    cards.push({
      name: `${prefix}-${i}`,
      type_line: isLand ? 'Basic Land — Forest' : 'Creature — Test',
    });
  }
  return cards;
}

function startedRoom({ firstPlayer = 0, matchType = 'single' } = {}) {
  const room = new GameRoom('TEST', 'Alice');
  // Seat player 1 directly (addPlayer needs a socket; we set the slot manually).
  room.players[1].nickname = 'Bob';
  room.players[1].playerId = 'bob-id';
  room.submitDeck(0, makeDeck('A'));
  room.submitDeck(1, makeDeck('B'));
  room.startGame(matchType, firstPlayer);
  return room;
}

// ── submitDeck validation ─────────────────────────────────────
test('submitDeck: rejects empty / non-array decks, accepts valid', () => {
  const room = new GameRoom('R', 'Alice');
  assert.deepEqual(room.submitDeck(0, []), { error: 'Invalid deck' });
  assert.deepEqual(room.submitDeck(0, null), { error: 'Invalid deck' });
  assert.deepEqual(room.submitDeck(5, makeDeck('A')), { error: 'Invalid player' });
  assert.deepEqual(room.submitDeck(0, makeDeck('A')), { ok: true });
  assert.equal(room.players[0].ready, true);
});

// ── startGame: initial state shape ───────────────────────────
test('startGame: deals 7-card hands, 20 life, correct library count', () => {
  const room = startedRoom({ firstPlayer: 1 });
  const gs = room.gameState;
  for (const p of gs.players) {
    assert.equal(p.life, 20);
    assert.equal(p.poison, 0);
    assert.equal(p.hand.length, 7);
    assert.equal(p.library.length, 60 - 7);
    assert.deepEqual(p.manaPool, { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });
    assert.deepEqual(p.battlefield, []);
  }
  assert.equal(gs.activePlayer, 1, 'firstPlayer honored');
  assert.equal(gs.currentPhase, 'main1');
  assert.equal(gs.turnNumber, 1);
});

test('startGame: every card gets a unique id', () => {
  const room = startedRoom();
  const gs = room.gameState;
  const ids = new Set();
  for (const p of gs.players) {
    for (const c of [...p.hand, ...p.library]) {
      assert.ok(c.id, 'card has id');
      assert.ok(!ids.has(c.id), 'id is unique');
      ids.add(c.id);
    }
  }
});

// ── getVisibleState: information hiding ───────────────────────
test('getVisibleState: hides opponent hand and library, keeps own', () => {
  const room = startedRoom();
  const view = room.getVisibleState(0);
  // Own zones intact
  assert.equal(view.players[0].hand.length, 7);
  assert.ok(view.players[0].hand[0].name, 'own hand cards have names');
  assert.equal(view.players[0].library.length, 53);
  // Opponent hand replaced with hidden card backs
  assert.equal(view.players[1].hand.length, 7);
  assert.ok(view.players[1].hand.every(c => c.hidden === true), 'opponent hand hidden');
  assert.ok(view.players[1].hand.every(c => !c.name), 'opponent hand has no card identity');
  assert.equal(view.players[1].handCount, 7);
  // Opponent library hidden but counted
  assert.deepEqual(view.players[1].library, []);
  assert.equal(view.players[1].libraryCount, 53);
  assert.equal(view.viewerIndex, 0);
});

// ── stateSync merge: public zones ─────────────────────────────
test('stateSync: public zones (life, battlefield) accepted from either player', () => {
  const room = startedRoom();
  // Player 0 reports that player 1's life dropped (e.g. P0 dealt damage).
  room.processAction(0, {
    type: 'stateSync',
    state: { players: [ {}, { life: 14 } ] },
  });
  assert.equal(room.gameState.players[1].life, 14);
});

// ── stateSync merge: DESYNC-1 protection (owner-only zones) ──
test('stateSync: a player CANNOT overwrite the opponent library/hand', () => {
  const room = startedRoom();
  const realLib = room.gameState.players[1].library.length;
  // Player 0 sends a sync that (as the filtered client would) carries an empty
  // library for player 1. The server must IGNORE it — only the owner (index 1)
  // may update their own library/hand. This is the current desync guard.
  room.processAction(0, {
    type: 'stateSync',
    state: { players: [ {}, { library: [], hand: [] } ] },
  });
  assert.equal(room.gameState.players[1].library.length, realLib, 'opponent library preserved');
  assert.equal(room.gameState.players[1].hand.length, 7, 'opponent hand preserved');
});

test('stateSync: the owning player CAN update their own library/hand', () => {
  const room = startedRoom();
  room.processAction(1, {
    type: 'stateSync',
    state: { players: [ {}, { library: [{ id: 'x', name: 'kept' }], hand: [] } ] },
  });
  assert.equal(room.gameState.players[1].library.length, 1);
  assert.equal(room.gameState.players[1].hand.length, 0);
});

// ── stateSync: monotonic turnNumber ───────────────────────────
test('stateSync: turnNumber only increases (stale regressions ignored)', () => {
  const room = startedRoom();
  room.processAction(0, { type: 'stateSync', state: { turnNumber: 5 } });
  assert.equal(room.gameState.turnNumber, 5);
  room.processAction(0, { type: 'stateSync', state: { turnNumber: 3 } });
  assert.equal(room.gameState.turnNumber, 5, 'lower turnNumber ignored');
});

// ── stateSync: spellStack version gating ─────────────────────
test('stateSync: spellStack only updates with a >= version', () => {
  const room = startedRoom();
  room.processAction(0, { type: 'stateSync', state: { spellStack: [{ id: 's1' }], spellStackVersion: 2 } });
  assert.equal(room.gameState.spellStack.length, 1);
  // Stale (lower version) update is dropped.
  room.processAction(1, { type: 'stateSync', state: { spellStack: [], spellStackVersion: 1 } });
  assert.equal(room.gameState.spellStack.length, 1, 'lower-version spellStack ignored');
  // Equal/higher version applies.
  room.processAction(1, { type: 'stateSync', state: { spellStack: [], spellStackVersion: 2 } });
  assert.equal(room.gameState.spellStack.length, 0);
});

// ── Server-authoritative actions ──────────────────────────────
test('bounce: moves a battlefield card to its owner hand, untapped', () => {
  const room = startedRoom();
  const p1 = room.gameState.players[1];
  p1.battlefield.push({ id: 'bf1', name: 'Bear', type_line: 'Creature', tapped: true });
  const before = p1.hand.length;
  const res = room.processAction(0, { type: 'bounce', targetPlayerIndex: 1, cardId: 'bf1', fromZone: 'battlefield' });
  assert.deepEqual(res, { ok: true });
  assert.equal(p1.battlefield.length, 0);
  assert.equal(p1.hand.length, before + 1);
  assert.equal(p1.hand.at(-1).tapped, false, 'bounced card is untapped');
});

test('bounce: unknown card id returns an error', () => {
  const room = startedRoom();
  const res = room.processAction(0, { type: 'bounce', targetPlayerIndex: 1, cardId: 'nope' });
  assert.deepEqual(res, { error: 'Card not found' });
});

test('bounceAll: returns nonland permanents, leaves lands', () => {
  const room = startedRoom();
  const p1 = room.gameState.players[1];
  p1.battlefield = [
    { id: 'c1', type_line: 'Creature — Bear' },
    { id: 'l1', type_line: 'Basic Land — Island' },
    { id: 'a1', type_line: 'Artifact' },
  ];
  const res = room.processAction(0, { type: 'bounceAll', targetPlayerIndex: 1, filter: 'nonland' });
  assert.equal(res.bouncedCount, 2);
  assert.deepEqual(p1.battlefield.map(c => c.id), ['l1'], 'only the land remains');
});

test('discardFromHand: valid index discards to graveyard; invalid index errors', () => {
  const room = startedRoom();
  const p1 = room.gameState.players[1];
  const target = p1.hand[2];
  const res = room.processAction(0, { type: 'discardFromHand', targetPlayerIndex: 1, cardIndex: 2 });
  assert.equal(res.ok, true);
  assert.equal(res.discardedCard.id, target.id);
  assert.equal(p1.graveyard.at(-1).id, target.id);
  assert.deepEqual(
    room.processAction(0, { type: 'discardFromHand', targetPlayerIndex: 1, cardIndex: 99 }),
    { error: 'Invalid card index' },
  );
});

test('millCards: moves N from library to graveyard, clamped to library size', () => {
  const room = startedRoom();
  const p1 = room.gameState.players[1];
  const res = room.processAction(0, { type: 'millCards', targetPlayerIndex: 1, count: 3 });
  assert.equal(res.ok, true);
  assert.equal(res.milledCards.length, 3);
  assert.equal(p1.graveyard.length, 3);
  assert.equal(p1.library.length, 50);
  // Over-mill clamps to remaining library.
  const res2 = room.processAction(0, { type: 'millCards', targetPlayerIndex: 1, count: 999 });
  assert.equal(res2.milledCards.length, 50);
  assert.equal(p1.library.length, 0);
});

test('mulligan: hand becomes (7 - newCount) and total cards are conserved', () => {
  // QUIRK: despite the name, `newCount` is the number of cards mulliganed AWAY,
  // not the resulting hand size. The server draws (7 - newCount). So newCount=1
  // yields a 6-card hand (one London-style bottomed card). Pinned so the refactor
  // keeps this contract (or changes it deliberately).
  const room = startedRoom();
  const p1 = room.gameState.players[1];
  const total = p1.hand.length + p1.library.length;
  room.processAction(1, { type: 'mulligan', targetPlayerIndex: 1, newCount: 1 });
  assert.equal(p1.hand.length, 6);
  assert.equal(p1.hand.length + p1.library.length, total, 'no cards created or destroyed');
  assert.equal(room.gameState.mulliganCounts[1], 1);
});

test('tuckToLibrary: moves a permanent into its owner library 3rd from top', () => {
  const room = startedRoom({ firstPlayer: 0 });
  const p1 = room.gameState.players[1];
  p1.battlefield.push({ id: 'pw1', name: 'Chandra', type_line: 'Planeswalker', tapped: true });
  const libBefore = p1.library.length;
  // P0 tucks P1's permanent (opponent's hidden library — server does it).
  const res = room.processAction(0, { type: 'tuckToLibrary', targetPlayerIndex: 1, cardId: 'pw1', position: 2 });
  assert.equal(res.ok, true);
  assert.equal(res.cardName, 'Chandra');
  assert.equal(p1.battlefield.find(c => c.id === 'pw1'), undefined, 'removed from battlefield');
  assert.equal(p1.library.length, libBefore + 1, 'added to library');
  assert.equal(p1.library[2].id, 'pw1', 'inserted 3rd from top (index 2)');
  assert.equal(p1.library[2].tapped, false, 'transient state cleaned');
});

test('tuckToLibrary: unknown card returns an error', () => {
  const room = startedRoom();
  assert.deepEqual(room.processAction(0, { type: 'tuckToLibrary', targetPlayerIndex: 1, cardId: 'nope' }), { error: 'Card not on battlefield' });
});

test('returnToOwnerZone: stolen creature returns to original owner', () => {
  const room = startedRoom();
  const p0 = room.gameState.players[0];
  const p1 = room.gameState.players[1];
  // P0 controls a creature originally owned by P1.
  p0.battlefield.push({ id: 'stolen', name: 'Mind Control victim', originalOwner: 1, temporaryControl: true });
  const res = room.processAction(0, { type: 'returnToOwnerZone', controllerIndex: 0, cardId: 'stolen', destinationZone: 'graveyard' });
  assert.equal(res.ok, true);
  assert.equal(p0.battlefield.find(c => c.id === 'stolen'), undefined);
  assert.equal(p1.graveyard.at(-1).id, 'stolen');
});

// ── Match scoring (Bo3) ───────────────────────────────────────
test('gameWon: single match finishes immediately', () => {
  const room = startedRoom({ matchType: 'single' });
  assert.deepEqual(room.gameWon(0), { matchOver: true, winner: 0 });
  assert.equal(room.status, 'finished');
});

// ── Mulligan fields are version-gated (multi-click "Keep Hand" fix) ──
test('stateSync: mulligan fields version-gated — stale sync cannot revert', () => {
  const room = startedRoom({ firstPlayer: 0 });
  // Decider keeps/advances: mulliganPlayer 0 -> 1 at version 1.
  room.processAction(0, { type: 'stateSync', state: { mulliganPhase: true, mulliganPlayer: 1, mulliganVersion: 1 } });
  assert.equal(room.gameState.mulliganPlayer, 1);
  // Waiting player's stale (lower-version) sync must NOT revert it.
  room.processAction(1, { type: 'stateSync', state: { mulliganPlayer: 0, mulliganVersion: 0 } });
  assert.equal(room.gameState.mulliganPlayer, 1, 'stale lower-version ignored');
  // A newer version applies (mulligan ends).
  room.processAction(1, { type: 'stateSync', state: { mulliganPhase: false, mulliganVersion: 2 } });
  assert.equal(room.gameState.mulliganPhase, false);
});

// ── Etape 3.2: server-authoritative turn advancement ─────────
test('advanceTurn: flips active player and resets phase', () => {
  const room = startedRoom({ firstPlayer: 0 });
  const res = room.advanceTurn(0);
  assert.equal(res.ok, true);
  assert.equal(res.activePlayer, 1);
  assert.equal(room.gameState.activePlayer, 1);
  assert.equal(room.gameState.priorityPlayer, 1);
  assert.equal(room.gameState.currentPhase, 'main1');
});

test('advanceTurn: turnNumber increments only when play returns to player 0', () => {
  const room = startedRoom({ firstPlayer: 0 });
  assert.equal(room.gameState.turnNumber, 1);
  room.advanceTurn(0); // -> P1, still turn 1
  assert.equal(room.gameState.turnNumber, 1);
  room.advanceTurn(1); // -> P0, turn 2
  assert.equal(room.gameState.turnNumber, 2);
});

test('advanceTurn: only the active player may advance', () => {
  const room = startedRoom({ firstPlayer: 0 });
  assert.deepEqual(room.advanceTurn(1), { error: 'Not your turn' });
  assert.equal(room.gameState.activePlayer, 0, 'unchanged');
});

test('advanceTurn: non-active player may advance during end-of-turn respond (Proceed)', () => {
  const room = startedRoom({ firstPlayer: 0 });
  room.gameState.endOfTurnRespond = true; // active player passed; opponent confirms
  const res = room.advanceTurn(1); // non-active "Proceed"
  assert.equal(res.ok, true);
  assert.equal(res.activePlayer, 1);
  assert.equal(room.gameState.endOfTurnRespond, false, 'respond window cleared on advance');
});

test('advanceTurn: rejected while the stack is not empty', () => {
  const room = startedRoom({ firstPlayer: 0 });
  room.gameState.spellStack = [{ id: 's1' }];
  assert.deepEqual(room.advanceTurn(0), { error: 'Resolve the stack before passing the turn' });
});

test('advanceTurn via processAction returns the result', () => {
  const room = startedRoom({ firstPlayer: 1 });
  const res = room.processAction(1, { type: 'advanceTurn' });
  assert.equal(res.ok, true);
  assert.equal(res.activePlayer, 0);
  assert.equal(res.turnNumber, 2);
});

// ── Etape 3.4: server-authoritative life / poison ────────────
test('changeLife: applies life and poison deltas', () => {
  const room = startedRoom({ firstPlayer: 0 });
  assert.deepEqual(room.changeLife(1, -3), { ok: true, life: 17, poison: 0, stateBasedLoss: null });
  assert.equal(room.gameState.players[1].life, 17);
  const r = room.changeLife(1, 0, 4);
  assert.equal(r.poison, 4);
});

test('changeLife: dropping to <= 0 records the state-based loss', () => {
  const room = startedRoom({ firstPlayer: 0 });
  const r = room.changeLife(0, -20);
  assert.equal(r.life, 0);
  assert.deepEqual(r.stateBasedLoss, { loserIndex: 0, winnerIndex: 1, reason: 'reached 0 life' });
});

test('changeLife: invalid target rejected', () => {
  const room = startedRoom({ firstPlayer: 0 });
  assert.deepEqual(room.changeLife(5, -1), { error: 'Invalid target player' });
});

test('changeLife via processAction', () => {
  const room = startedRoom({ firstPlayer: 0 });
  const r = room.processAction(0, { type: 'changeLife', targetPlayerIndex: 1, lifeDelta: -5 });
  assert.equal(r.life, 15);
});

// ── Robust Spectacle fix: server-authoritative lostLifeThisTurn ──
test('stateSync: a life DECREASE sets server-owned lostLifeThisTurn', () => {
  const room = startedRoom({ firstPlayer: 0 });
  // P0 reports P1 took damage (life 20 -> 15).
  room.processAction(0, { type: 'stateSync', state: { players: [{}, { life: 15 }] } });
  assert.equal(room.gameState.players[1].lostLifeThisTurn, true);
  assert.ok(!room.gameState.players[0].lostLifeThisTurn, 'untouched player not flagged');
});

test('stateSync: life gain or no-change does NOT set lostLifeThisTurn', () => {
  const room = startedRoom({ firstPlayer: 0 });
  room.processAction(0, { type: 'stateSync', state: { players: [{}, { life: 25 }] } }); // gained
  assert.ok(!room.gameState.players[1].lostLifeThisTurn);
});

test('lostLifeThisTurn is server-owned: a client cannot clear it via stateSync', () => {
  const room = startedRoom({ firstPlayer: 0 });
  room.processAction(0, { type: 'stateSync', state: { players: [{}, { life: 15 }] } });
  assert.equal(room.gameState.players[1].lostLifeThisTurn, true);
  // P1's client tries to re-sync itself with the flag false (the old dual-writer race).
  room.processAction(1, { type: 'stateSync', state: { players: [{}, { life: 15, lostLifeThisTurn: false }] } });
  assert.equal(room.gameState.players[1].lostLifeThisTurn, true, 'still true — client value ignored');
});

test('advanceTurn resets lostLifeThisTurn for both players', () => {
  const room = startedRoom({ firstPlayer: 0 });
  room.processAction(0, { type: 'stateSync', state: { players: [{}, { life: 15 }] } });
  room.advanceTurn(0);
  assert.equal(room.gameState.players[1].lostLifeThisTurn, false);
});

// ── advanceTurn: server-authoritative board cleanup (Etape 3.2b) ──────────────
// These behaviors moved off the (non-active) client into advanceTurn so the turn
// transition no longer clobbers the opponent's board with a stale client snapshot.
test('advanceTurn: untaps ONLY the new active player, clears enter/flags/manaPool', () => {
  const room = startedRoom({ firstPlayer: 0 }); // active = 0, advanceTurn -> 1
  room.processAction(0, { type: 'stateSync', state: { players: [
    { battlefield: [{ id: 'a1', tapped: true }] },
    { battlefield: [{ id: 'b1', tapped: true, enteredThisTurn: true }], landPlayedThisTurn: true, dealtDamageThisTurn: true, manaPool: { W: 0, U: 2, B: 0, R: 0, G: 0, C: 0 } },
  ] } });
  room.advanceTurn(0);
  const p0 = room.gameState.players[0], p1 = room.gameState.players[1];
  assert.equal(p1.battlefield[0].tapped, false, 'new active untapped');
  assert.equal(p1.battlefield[0].enteredThisTurn, false, 'enteredThisTurn cleared');
  assert.equal(p1.landPlayedThisTurn, false);
  assert.equal(p1.dealtDamageThisTurn, false);
  assert.deepEqual(p1.manaPool, { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });
  assert.equal(p0.battlefield[0].tapped, true, 'previous player NOT untapped');
  assert.deepEqual(p0.manaPool, { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }, 'prev manaPool also zeroed');
});

test('advanceTurn: clears tempBuffs on both boards + damagePrevented for the new active player', () => {
  const room = startedRoom({ firstPlayer: 0 });
  room.processAction(0, { type: 'stateSync', state: { players: [
    { battlefield: [{ id: 'a1', tempBuffs: { power: 2 }, damagePrevented: 1 }] },
    { battlefield: [{ id: 'b1', tempBuffs: { power: 1 }, damagePrevented: 1 }], untilNextTurnEffects: [{ type: 'sorcery_flash' }] },
  ] } });
  room.advanceTurn(0); // next = 1
  const p0 = room.gameState.players[0], p1 = room.gameState.players[1];
  assert.equal(p0.battlefield[0].tempBuffs, null);
  assert.equal(p1.battlefield[0].tempBuffs, null);
  assert.equal(p0.battlefield[0].damagePrevented, undefined, 'damagePrevented set for new active cleared on both');
  assert.equal(p1.battlefield[0].damagePrevented, undefined);
  assert.deepEqual(p1.untilNextTurnEffects, [], 'new active until-next-turn effects expire');
});

test('advanceTurn: returns temporarily-controlled cards to owner (tapped, haste stripped)', () => {
  const room = startedRoom({ firstPlayer: 0 });
  room.processAction(0, { type: 'stateSync', state: { players: [
    { battlefield: [{ id: 'stolen', temporaryControl: true, originalOwner: 1, grantedHaste: true, keywords: ['Haste', 'Flying'], tapped: false }] },
    { battlefield: [] },
  ] } });
  room.advanceTurn(0);
  const p0 = room.gameState.players[0], p1 = room.gameState.players[1];
  assert.ok(!p0.battlefield.some(c => c.id === 'stolen'), 'left controller board');
  const ret = p1.battlefield.find(c => c.id === 'stolen');
  assert.ok(ret, 'returned to owner');
  assert.equal(ret.temporaryControl, undefined);
  assert.equal(ret.originalOwner, undefined);
  assert.equal(ret.grantedHaste, undefined);
  assert.ok(!ret.keywords.includes('Haste'), 'granted haste removed');
  assert.ok(ret.keywords.includes('Flying'), 'intrinsic keyword kept');
  // Owner (player 1) is the NEW active player, so its untap step untaps the returned card.
  assert.equal(ret.tapped, false, 'untapped by new active player untap step');
});

test('advanceTurn: reverts temporarily-animated manlands', () => {
  const room = startedRoom({ firstPlayer: 1 }); // active = 1, advanceTurn(1) -> 0
  room.processAction(1, { type: 'stateSync', state: { players: [
    { battlefield: [{ id: 'ml', animatedCreature: true, animatedData: { originalTypeLine: 'Land', keywords: ['Haste'] }, power: '3', toughness: '3', type_line: 'Creature — Elemental', keywords: ['Haste', 'Vigilance'] }] },
    { battlefield: [] },
  ] } });
  room.advanceTurn(1);
  const ml = room.gameState.players[0].battlefield.find(c => c.id === 'ml');
  assert.equal(ml.animatedCreature, false);
  assert.equal(ml.animatedData, null);
  assert.equal(ml.power, undefined);
  assert.equal(ml.type_line, 'Land');
  assert.ok(!ml.keywords.includes('Haste'), 'animation-granted keyword removed');
  assert.ok(ml.keywords.includes('Vigilance'), 'other keyword kept');
});

test('changeLife with a negative delta sets lostLifeThisTurn', () => {
  const room = startedRoom({ firstPlayer: 0 });
  const r = room.changeLife(1, -4);
  assert.equal(r.life, 16);
  assert.equal(room.gameState.players[1].lostLifeThisTurn, true);
});

// ── Etape 3.3: server-authoritative spell stack ──────────────
test('stackPush: appends an entry, assigns id + caster, bumps version', () => {
  const room = startedRoom({ firstPlayer: 0 });
  const r1 = room.stackPush(0, { card: { name: 'Lightning Strike' }, displayName: 'Lightning Strike' });
  assert.equal(r1.ok, true);
  assert.ok(r1.entryId, 'entry got an id');
  assert.equal(room.gameState.spellStack.length, 1);
  assert.equal(room.gameState.spellStack[0].pIdx, 0, 'caster recorded');
  assert.equal(room.gameState.spellStackVersion, 1);

  const r2 = room.stackPush(1, { card: { name: 'Counterspell' }, pIdx: 1 });
  assert.equal(room.gameState.spellStack.length, 2);
  assert.equal(room.gameState.spellStackVersion, 2);
  // LIFO order: last pushed is on top.
  assert.equal(room.gameState.spellStack[1].card.name, 'Counterspell');
});

test('stackResolveTop: pops the top entry (LIFO); errors when empty', () => {
  const room = startedRoom({ firstPlayer: 0 });
  room.stackPush(0, { card: { name: 'A' } });
  room.stackPush(1, { card: { name: 'B' } });
  const res = room.stackResolveTop();
  assert.equal(res.ok, true);
  assert.equal(res.resolved.card.name, 'B', 'top (last-added) resolved first');
  assert.equal(room.gameState.spellStack.length, 1);
  room.stackResolveTop(); // resolve A
  assert.deepEqual(room.stackResolveTop(), { error: 'Stack is empty' });
});

test('stackRemove: removes a specific entry by id (counter); errors if missing', () => {
  const room = startedRoom({ firstPlayer: 0 });
  const a = room.stackPush(0, { card: { name: 'A' } }).entryId;
  const b = room.stackPush(1, { card: { name: 'B' } }).entryId;
  const res = room.stackRemove(a); // counter the bottom spell
  assert.equal(res.ok, true);
  assert.equal(res.removed.card.name, 'A');
  assert.deepEqual(room.gameState.spellStack.map(e => e.card.name), ['B']);
  assert.deepEqual(room.stackRemove('nope'), { error: 'Stack entry not found' });
});

test('stack ops via processAction return results and bump version together', () => {
  const room = startedRoom({ firstPlayer: 0 });
  const push = room.processAction(0, { type: 'stackPush', entry: { card: { name: 'Bolt' } } });
  assert.equal(push.ok, true);
  const resolve = room.processAction(0, { type: 'stackResolveTop' });
  assert.equal(resolve.resolved.card.name, 'Bolt');
  assert.equal(room.gameState.spellStack.length, 0);
});

// ── Etape 3.1: server-authoritative state-based game-over ─────
test('checkStateBasedGameOver: detects life <= 0, poison, commander damage', () => {
  const room = startedRoom();
  assert.equal(room.checkStateBasedGameOver(), null, 'healthy start: nobody has lost');

  room.gameState.players[0].life = 0;
  assert.deepEqual(room.checkStateBasedGameOver(), { loserIndex: 0, winnerIndex: 1, reason: 'reached 0 life' });

  room.gameState.players[0].life = 20;
  room.gameState.players[1].poison = 10;
  assert.deepEqual(room.checkStateBasedGameOver(), { loserIndex: 1, winnerIndex: 0, reason: 'reached 10 poison counters' });

  room.gameState.players[1].poison = 0;
  room.gameState.players[0].commanderDamageReceived = { 1: 21 };
  assert.deepEqual(room.checkStateBasedGameOver(), { loserIndex: 0, winnerIndex: 1, reason: 'took 21 commander damage' });
});

test('checkStateBasedGameOver: only while playing', () => {
  const room = startedRoom();
  room.gameState.players[0].life = 0;
  room.status = 'finished';
  assert.equal(room.checkStateBasedGameOver(), null);
});

test('processAction records stateBasedLoss after a lethal stateSync', () => {
  const room = startedRoom();
  // Either player may report public life (e.g. the attacker reports the defender's life).
  room.processAction(1, { type: 'stateSync', state: { players: [{ life: 0 }, {}] } });
  assert.deepEqual(room.gameState.stateBasedLoss, { loserIndex: 0, winnerIndex: 1, reason: 'reached 0 life' });
  // And it is included in the broadcast state.
  assert.deepEqual(room.getVisibleState(1).stateBasedLoss, { loserIndex: 0, winnerIndex: 1, reason: 'reached 0 life' });
});

test('gameWon: rejects a win claim that contradicts the server state', () => {
  const room = startedRoom();
  room.processAction(0, { type: 'stateSync', state: { players: [{ life: 0 }, {}] } }); // P0 is dead -> P1 wins
  const bad = room.gameWon(0); // P0 falsely claims the win
  assert.equal(bad.error, 'Win claim contradicts game state');
  assert.equal(bad.authoritativeWinner, 1);
  assert.equal(room.status, 'playing', 'rejected claim does not finish the game');
  // The correct winner is accepted.
  assert.deepEqual(room.gameWon(1), { matchOver: true, winner: 1 });
});

test('gameWon: still works normally when no state-based loss is recorded', () => {
  const room = startedRoom();
  assert.deepEqual(room.gameWon(0), { matchOver: true, winner: 0 });
});

test('gameWon: Bo3 needs two game wins', () => {
  const room = startedRoom({ matchType: 'bo3' });
  const r1 = room.gameWon(0);
  assert.equal(r1.matchOver, false);
  assert.deepEqual(r1.matchScore, [1, 0]);
  assert.equal(room.status, 'between-games');
  const r2 = room.gameWon(0);
  assert.equal(r2.matchOver, true);
  assert.equal(r2.winner, 0);
  assert.equal(room.status, 'finished');
});

// ── Cross-player board reconciliation (tombstones / keepalives) ──
test('bf reconcile: a tucked card cannot be re-added by the owner\'s stale sync', () => {
  const room = startedRoom();
  const gs = room.gameState;
  const card = { id: 'tuck1', name: 'Bonecrusher Giant', type_line: 'Creature' };
  gs.players[1].battlefield.push(card);
  // Player 0 tucks player 1's card into player 1's library (Teferi Hero -3).
  const r = room.processAction(0, { type: 'tuckToLibrary', targetPlayerIndex: 1, cardId: 'tuck1', position: 2 });
  assert.ok(r.ok);
  assert.equal(gs.players[1].battlefield.some(c => c.id === 'tuck1'), false, 'removed from battlefield');
  assert.equal(gs.players[1].library.some(c => c.id === 'tuck1'), true, 'placed into library');
  // Player 1's stale client sync re-asserts the card on its own battlefield.
  room.processAction(1, { type: 'stateSync', state: { players: [null, { battlefield: [card] }] } });
  assert.equal(gs.players[1].battlefield.some(c => c.id === 'tuck1'), false, 'tombstone rejects the stale re-add');
});

test('bf reconcile: a server-added token survives the owner\'s stale sync', () => {
  const room = startedRoom();
  const gs = room.gameState;
  const token = { id: 'tok1', name: 'Goblin Construct', isToken: true, type_line: 'Artifact Creature Token' };
  const r = room.processAction(0, { type: 'createBattlefieldToken', targetPlayerIndex: 1, token });
  assert.ok(r.ok);
  assert.equal(gs.players[1].battlefield.some(c => c.id === 'tok1'), true, 'token added to battlefield');
  // Player 1's stale client sync omits the token entirely.
  room.processAction(1, { type: 'stateSync', state: { players: [null, { battlefield: [] }] } });
  assert.equal(gs.players[1].battlefield.some(c => c.id === 'tok1'), true, 'keepalive preserves the token');
});

// ── Server-owned endOfTurnRespond (turn-authority slice) ──────
test('setEndOfTurnRespond intent: server owns value + version; stateSync cannot clobber', () => {
  const room = startedRoom();
  const gs = room.gameState;
  const r = room.processAction(0, { type: 'setEndOfTurnRespond', value: true });
  assert.ok(r.ok);
  assert.equal(gs.endOfTurnRespond, true);
  const verAfterIntent = gs.endOfTurnRespondVersion;
  assert.ok(verAfterIntent >= 1);
  // A stale client sync claiming endOfTurnRespond=false (with a huge version) is ignored.
  room.processAction(1, { type: 'stateSync', state: { endOfTurnRespond: false, endOfTurnRespondVersion: 9999 } });
  assert.equal(gs.endOfTurnRespond, true, 'stateSync no longer controls endOfTurnRespond');
  assert.equal(gs.endOfTurnRespondVersion, verAfterIntent, 'version unchanged by stateSync');
});

test('Turn flip is advanceTurn-only in play; a stateSync activePlayer echo is ignored', () => {
  const room = startedRoom({ firstPlayer: 0 });
  const gs = room.gameState;
  // A (active=0) passes: flag goes up via intent.
  room.processAction(0, { type: 'setEndOfTurnRespond', value: true });
  // B proceeds via the advanceTurn intent (the server-authoritative path). Flip to B.
  const r = room.processAction(1, { type: 'advanceTurn' });
  assert.ok(r.ok);
  assert.equal(gs.activePlayer, 1, 'advanceTurn flipped the turn to B');
  assert.equal(gs.endOfTurnRespond, false, 'advanceTurn cleared the respond flag');
  // REGRESSION: the new active player (B) then sends a routine stateSync that still echoes
  // its briefly-stale view (activePlayer=0). During play this MUST be ignored — accepting it
  // is exactly what reverted the turn and desynced/froze the game.
  room.processAction(1, { type: 'stateSync', state: { activePlayer: 0 } });
  assert.equal(gs.activePlayer, 1, 'stale stateSync echo did NOT revert the turn');
  // Same guard for the other player.
  room.processAction(0, { type: 'stateSync', state: { activePlayer: 0 } });
  assert.equal(gs.activePlayer, 1, 'stale stateSync from the other player also ignored');
});

test('stateSync CAN set activePlayer during mulligan (first-player selection)', () => {
  const room = startedRoom({ firstPlayer: 0 });
  const gs = room.gameState;
  gs.mulliganPhase = true;
  room.processAction(1, { type: 'stateSync', state: { activePlayer: 1 } });
  assert.equal(gs.activePlayer, 1, 'mulligan-phase activePlayer change accepted');
});

// ── exileGraveyard (Ashiok) + graveyard/exile reconciliation ──
test('exileGraveyard: moves GY to exile; owner\'s stale sync cannot revert it', () => {
  const room = startedRoom();
  const gs = room.gameState;
  gs.players[1].graveyard = [{ id: 'g1', name: 'Bonecrusher Giant' }, { id: 'g2', name: 'Lava Spike' }];
  // Player 0 (Ashiok's controller) exiles player 1's graveyard.
  const r = room.processAction(0, { type: 'exileGraveyard', targetPlayerIndex: 1 });
  assert.ok(r.ok);
  assert.equal(r.exiledCount, 2);
  assert.deepEqual(gs.players[1].graveyard, []);
  assert.equal(gs.players[1].exile.filter(c => c.id === 'g1' || c.id === 'g2').length, 2);
  // Player 1's stale sync re-asserts the old graveyard and an exile without the cards.
  room.processAction(1, { type: 'stateSync', state: { players: [null, {
    graveyard: [{ id: 'g1', name: 'Bonecrusher Giant' }, { id: 'g2', name: 'Lava Spike' }],
    exile: [],
  }] } });
  assert.deepEqual(gs.players[1].graveyard, [], 'gy tombstones reject the stale re-add');
  assert.equal(gs.players[1].exile.filter(c => c.id === 'g1' || c.id === 'g2').length, 2, 'exile keepalives preserve the exiled cards');
});

test('exilePermanent: exiles an opponent permanent; owner stale sync cannot re-add it', () => {
  const room = startedRoom({ firstPlayer: 0 });
  const gs = room.gameState;
  gs.players[0].battlefield = [{ id: 'troll', name: 'Old-Growth Troll', type_line: 'Creature — Troll' }];
  // Player 1 (Skyclave controller) exiles player 0's Troll.
  const r = room.processAction(1, { type: 'exilePermanent', targetPlayerIndex: 0, cardId: 'troll', exiledBy: { id: 'sky', name: 'Skyclave Apparition' } });
  assert.ok(r.ok);
  assert.ok(!gs.players[0].battlefield.some(c => c.id === 'troll'), 'left owner battlefield');
  assert.ok(gs.players[0].exile.some(c => c.id === 'troll' && c.exiledBy), 'in owner exile, tagged');
  // Owner's stale heartbeat re-asserts the Troll on their battlefield — must be rejected.
  room.processAction(0, { type: 'stateSync', state: { players: [{ battlefield: [{ id: 'troll', name: 'Old-Growth Troll' }] }, null] } });
  assert.ok(!gs.players[0].battlefield.some(c => c.id === 'troll'), 'bf tombstone rejects the stale re-add');
});

test('combatState: version-gated — a stale null does not clear an active combat', () => {
  const room = startedRoom({ firstPlayer: 0 });
  const gs = room.gameState;
  // Active player enters combat (version 5).
  room.processAction(0, { type: 'stateSync', state: { combatState: { phase: 'attackers', _v: 5 }, combatStateVersion: 5 } });
  assert.ok(gs.combatState && gs.combatState.phase === 'attackers');
  // Opponent's stale heartbeat carries combatState=null at an OLDER version — must be ignored.
  room.processAction(1, { type: 'stateSync', state: { combatState: null, combatStateVersion: 3 } });
  assert.ok(gs.combatState && gs.combatState.phase === 'attackers', 'stale null rejected — combat stays');
  // A newer null (real "combat ended") is accepted.
  room.processAction(0, { type: 'stateSync', state: { combatState: null, combatStateVersion: 6 } });
  assert.equal(gs.combatState, null, 'newer null accepted');
});

// ── Room resurrection after server restart ────────────────────
test('resurrect: room rebuilt from snapshot; opponent adopted; private zones restored via sync', () => {
  const RoomManager = require('../server/RoomManager.js');
  const room = startedRoom();
  const snap = room.getVisibleState(0); // what player 0's client last received

  // Simulate a server restart: a fresh RoomManager with no rooms.
  const rm = new RoomManager();
  assert.equal(rm.getRoom('TEST'), null);

  // Player 0 resurrects the room from their snapshot.
  const room2 = rm.resurrectRoom('TEST', 0, 'Alice', 'alice-id', snap);
  assert.ok(room2, 'room resurrected');
  assert.equal(room2.status, 'playing');
  assert.equal(room2.gameState.players[0].hand.length, snap.players[0].hand.length, 'own hand preserved');
  assert.deepEqual(room2.gameState.players[1].hand, [], 'opponent hidden hand stored empty (no placeholder cards)');
  assert.deepEqual(room2.gameState.players[1].library, [], 'opponent hidden library stored empty');

  // Resurrector reconnects normally by playerId.
  const r1 = room2.addPlayer({ id: 'sock-a' }, 'Alice', 'alice-id');
  assert.equal(r1.playerIndex, 0);

  // Opponent rejoins with their OLD playerId (unknown to the rebuilt room) → adopted into the vacant seat.
  const r2 = room2.addPlayer({ id: 'sock-b' }, 'Bob', 'bob-old-id');
  assert.equal(r2.playerIndex, 1, 'opponent adopted into their original seat');
  assert.equal(r2.playerId, 'bob-old-id', 'opponent keeps their playerId for future reconnects');

  // Opponent's own periodic stateSync restores their private zones.
  room2.processAction(1, { type: 'stateSync', state: { players: [null, { hand: [{ id: 'h1' }], library: [{ id: 'l1' }, { id: 'l2' }] }] } });
  assert.equal(room2.gameState.players[1].hand.length, 1, 'hand restored from owner sync');
  assert.equal(room2.gameState.players[1].library.length, 2, 'library restored from owner sync');

  // A second resurrect attempt (the other player racing) returns the SAME room.
  const again = rm.resurrectRoom('TEST', 1, 'Bob', 'bob-old-id', snap);
  assert.equal(again, room2);
});

// ── Sync ordering key: the end-of-turn freeze root cause + fix ───────────────
// The freeze: the client used the server's millisecond timestamp as a unique
// ordering/dedupe key (`if (state.timestamp <= last) return`). Two actions in the
// SAME millisecond got the SAME timestamp, so the client dropped the second one.
// When that dropped update carried endOfTurnRespond:true, the opponent never got
// the "Proceed" button and the turn froze. Fix: a strictly-increasing, unique
// per-room _seq stamped on every visible-state build.

test('sync ordering: two builds in the SAME millisecond get equal timestamp but DISTINCT _seq', () => {
  const room = startedRoom();
  // Two synchronous builds — same event-loop tick → identical Date.now() timestamp.
  const a = room.getVisibleState(0, { omitOwnLibrary: true });
  const b = room.getVisibleState(1, { omitOwnLibrary: true });
  // Precondition of the old freeze: timestamps CAN be equal within one millisecond.
  // (Not asserted equal — clock may tick — but the KEY must be safe either way.)
  assert.equal(typeof a._seq, 'number');
  assert.equal(typeof b._seq, 'number');
  assert.ok(b._seq > a._seq, '_seq is strictly increasing across builds (never collides)');
});

test('sync ordering: _seq strictly increases across many builds, never repeats', () => {
  const room = startedRoom();
  const seqs = [];
  for (let i = 0; i < 50; i++) seqs.push(room.getVisibleState(i % 2, { omitOwnLibrary: true })._seq);
  for (let i = 1; i < seqs.length; i++) {
    assert.ok(seqs[i] > seqs[i - 1], `build ${i} _seq (${seqs[i]}) > previous (${seqs[i - 1]})`);
  }
  assert.equal(new Set(seqs).size, seqs.length, 'all _seq values are unique');
});

test('sync ordering: two actions in the same tick both get delivered with distinct keys (freeze repro)', () => {
  const room = startedRoom({ firstPlayer: 0 });
  room.gameState.mulliganPhase = false;
  // Simulate the live collision: B heartbeat stateSync, then A opens the respond
  // window — processed back-to-back in the same tick (same ms).
  room.processAction(1, { type: 'stateSync', state: { players: [null, { life: 20 }] } });
  const beat = room.getVisibleState(1, { omitOwnLibrary: true }); // what B would receive first
  room.processAction(0, { type: 'setEndOfTurnRespond', value: true });
  const open = room.getVisibleState(1, { omitOwnLibrary: true }); // the eot=true broadcast
  assert.equal(open.endOfTurnRespond, true, 'server holds the respond flag');
  assert.ok(open._seq > beat._seq, 'the eot=true update has a strictly greater key → client cannot drop it');
});

test('sync ordering: full snapshots are marked _full, deltas are not', () => {
  const room = startedRoom();
  assert.equal(room.getVisibleState(0)._full, true, 'game-start / reconnect snapshot is full');
  assert.equal(room.getVisibleState(0, { omitOwnLibrary: true })._full, false, 'broadcast delta is not full');
});

// Restore console after the suite (best-effort; node:test runs files in isolation).
test.after?.(() => { console.log = origLog; console.warn = origWarn; });
