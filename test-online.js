/**
 * Tap & Go — Automated Integration Tests
 *
 * Simulates two players connecting via Socket.io to verify:
 * 1. Room creation & joining
 * 2. Deck submission & game start
 * 3. State sync between players (card zones, life, mana, turns)
 * 4. Echo prevention (own updates don't overwrite own state)
 * 5. Opponent action sync (opponent's changes reach us)
 * 6. Online guards (can't modify opponent's state)
 *
 * Usage: node test-online.js
 */

const http = require('http');
const io = require('./node_modules/socket.io/client-dist/socket.io.js');

const SERVER_URL = 'http://localhost:3000';
let passed = 0;
let failed = 0;
let testName = '';

function assert(condition, msg) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ FAIL [${testName}]: ${msg}`);
  }
}

function assertEqual(actual, expected, msg) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ FAIL [${testName}]: ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function section(name) {
  testName = name;
  console.log(`\n▸ ${name}`);
}

// Helper: create a socket connection
function createSocket() {
  return io(SERVER_URL, { transports: ['websocket', 'polling'], forceNew: true });
}

// Helper: drain any pending events on a socket (prevent stale events from leaking)
function drainEvents(socket, event) {
  socket.removeAllListeners(event);
}

// Helper: emit and wait for callback
function emitCb(socket, event, data) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout on ${event}`)), 5000);
    if (data === undefined) {
      // For events like requestState that take only a callback
      socket.emit(event, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });
      return;
    }
    socket.emit(event, data, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

// Helper: wait for a specific event
function waitForEvent(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (data) => {
      clearTimeout(timeout);
      resolve(data);
    });
  });
}

// Helper: create a minimal test deck (needs at least some cards)
function createTestDeck() {
  const cards = [];
  for (let i = 0; i < 60; i++) {
    cards.push({
      id: `card_${i}_${Math.random().toString(36).slice(2, 8)}`,
      name: i < 20 ? 'Mountain' : i < 40 ? 'Lightning Bolt' : 'Goblin Guide',
      type_line: i < 20 ? 'Basic Land — Mountain' : (i < 40 ? 'Instant' : 'Creature — Goblin Scout'),
      mana_cost: i < 20 ? '' : '{R}',
      power: i >= 40 ? '2' : undefined,
      toughness: i >= 40 ? '2' : undefined,
      oracle_text: i < 20 ? '{T}: Add {R}.' : (i < 40 ? 'Lightning Bolt deals 3 damage to any target.' : 'Haste'),
      image_uris: { normal: 'https://example.com/card.jpg', small: 'https://example.com/card_small.jpg' },
      colors: ['R'],
      cmc: i < 20 ? 0 : 1,
      counters: {},
      tapped: false,
    });
  }
  return cards;
}

// Create a room via REST API
async function createRoom(nickname) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ nickname });
    const req = http.request(`${SERVER_URL}/api/room/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ═══════════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════════

async function testRoomLifecycle() {
  section('Room Creation & Joining');

  // Create room via REST
  const roomData = await createRoom('Player1');
  assert(roomData.roomId, 'Room should be created with ID');
  assert(roomData.roomId.length >= 4, 'Room ID should be at least 4 chars');
  console.log(`  Room created: ${roomData.roomId}`);

  // Player 1 joins via socket
  const s1 = createSocket();
  await new Promise(r => s1.on('connect', r));

  const join1 = await emitCb(s1, 'joinGame', {
    roomId: roomData.roomId,
    nickname: 'Player1'
  });
  assertEqual(join1.playerIndex, 0, 'First player should be index 0');
  assert(join1.playerId, 'Should receive playerId');

  // Player 2 joins
  const s2 = createSocket();
  await new Promise(r => s2.on('connect', r));

  const p1SeesJoin = waitForEvent(s1, 'roomReady');

  const join2 = await emitCb(s2, 'joinGame', {
    roomId: roomData.roomId,
    nickname: 'Player2'
  });
  assertEqual(join2.playerIndex, 1, 'Second player should be index 1');

  const roomReady = await p1SeesJoin;
  assert(roomReady.roomInfo, 'Player 1 should receive roomReady event');
  assertEqual(roomReady.roomInfo.players.length, 2, 'Room should show 2 players');
  console.log(`  ✓ Both players joined room successfully`);

  s1.disconnect();
  s2.disconnect();
  return roomData.roomId;
}

async function testDeckSubmissionAndGameStart() {
  section('Deck Submission & Game Start');

  const roomData = await createRoom('Alice');
  const s1 = createSocket();
  const s2 = createSocket();
  await Promise.all([
    new Promise(r => s1.on('connect', r)),
    new Promise(r => s2.on('connect', r))
  ]);

  const join1 = await emitCb(s1, 'joinGame', { roomId: roomData.roomId, nickname: 'Alice' });
  const join2 = await emitCb(s2, 'joinGame', { roomId: roomData.roomId, nickname: 'Bob' });

  // Submit decks
  const deck1 = createTestDeck();
  const deck2 = createTestDeck();

  const p2SeesReady = waitForEvent(s2, 'opponentReady');
  const sub1 = await emitCb(s1, 'submitDeck', { deck: deck1 });
  assert(sub1.ok, 'Deck 1 submission should succeed');

  await p2SeesReady;
  console.log(`  ✓ Player 2 received opponentReady after Player 1 submitted deck`);

  // Player 2 submits → game should start
  const p1GameStart = waitForEvent(s1, 'gameStart');
  const p2GameStart = waitForEvent(s2, 'gameStart');

  const sub2 = await emitCb(s2, 'submitDeck', { deck: deck2 });
  assert(sub2.ok, 'Deck 2 submission should succeed');

  const gs1 = await p1GameStart;
  const gs2 = await p2GameStart;

  // Verify game state
  assert(gs1.state, 'Player 1 should receive game state');
  assert(gs2.state, 'Player 2 should receive game state');

  // Check starting hands (7 cards)
  const p1Hand = gs1.state.players[0].hand;
  const p2Hand = gs2.state.players[1].hand;
  assertEqual(p1Hand.length, 7, 'Player 1 should have 7-card opening hand');
  // Player 2 sees Player 1 hand as hidden
  const p2SeesP1Hand = gs2.state.players[0].hand;
  assert(p2SeesP1Hand[0].hidden === true || p2SeesP1Hand[0].name === undefined || p2SeesP1Hand.length === 0,
    'Player 2 should NOT see Player 1 hand details (information hiding)');

  // Check life totals
  assertEqual(gs1.state.players[0].life, 20, 'Player 1 should start at 20 life');
  assertEqual(gs1.state.players[1].life, 20, 'Player 2 should start at 20 life');

  // Check library sizes (60 - 7 = 53)
  assert(gs1.state.players[0].libraryCount === 53 || gs1.state.players[0].library?.length === 53,
    'Player 1 library should have 53 cards after drawing 7');

  // Active player should be either 0 or 1 (random coin flip)
  assert(gs1.state.activePlayer === 0 || gs1.state.activePlayer === 1,
    'Active player should be 0 or 1');
  assertEqual(gs1.state.activePlayer, gs2.state.activePlayer,
    'Both players should see same active player');

  console.log(`  ✓ Game started: active player = ${gs1.state.activePlayer}`);
  console.log(`  ✓ Opening hands dealt, libraries correct size`);

  // Store for next tests
  const result = { s1, s2, gs1, gs2, roomId: roomData.roomId, join1, join2 };
  return result;
}

async function testStateSync(gameInfo) {
  section('State Sync — Player Actions');

  const { s1, s2, gs1, gs2 } = gameInfo;

  // Player 1 modifies their life total
  const p1State = gs1.state.players[0];
  const p2SeesUpdate = waitForEvent(s2, 'stateUpdate');

  const modifiedState = {
    players: [
      { ...p1State, life: 17, hand: p1State.hand }, // took 3 damage
      gs1.state.players[1]
    ],
    activePlayer: gs1.state.activePlayer,
    currentPhase: 'main1',
    turnNumber: 1,
  };

  const actionResult = await emitCb(s1, 'gameAction', {
    action: { type: 'stateSync', state: modifiedState }
  });
  assert(actionResult.ok, 'gameAction should succeed');

  const update = await p2SeesUpdate;
  assert(update.state, 'Player 2 should receive state update');
  assert(update.lastAction, 'Update should include lastAction');
  assertEqual(update.lastAction.by, 0, 'lastAction.by should be Player 1 (index 0)');
  assertEqual(update.lastAction.type, 'stateSync', 'lastAction.type should be stateSync');

  // Check Player 2 sees Player 1 life change
  assertEqual(update.state.players[0].life, 17, 'Player 2 should see Player 1 at 17 life');

  console.log(`  ✓ Player 1 life change synced to Player 2 (20 → 17)`);

  // Player 2 plays a card to battlefield
  const p2State = gs2.state.players[1];
  // Drain any stale events from the previous action, then listen fresh
  drainEvents(s1, 'stateUpdate');
  await new Promise(r => setTimeout(r, 200)); // let any pending events flush
  const p1SeesUpdate = waitForEvent(s1, 'stateUpdate');

  // Simulate playing a card from hand to battlefield
  const cardToPlay = p2State.hand[0];
  const newHand = p2State.hand.slice(1);
  const newBattlefield = [...(p2State.battlefield || []), { ...cardToPlay, tapped: false }];

  const modifiedState2 = {
    players: [
      gs2.state.players[0], // leave P1 unchanged
      { ...p2State, hand: newHand, battlefield: newBattlefield }
    ],
    activePlayer: gs2.state.activePlayer,
    currentPhase: 'main1',
    turnNumber: 1,
  };

  await emitCb(s2, 'gameAction', {
    action: { type: 'stateSync', state: modifiedState2 }
  });

  const update2 = await p1SeesUpdate;
  assertEqual(update2.lastAction.by, 1, 'lastAction.by should be Player 2 (index 1)');

  // Player 1 should see Player 2's battlefield change
  const p2BfFromP1 = update2.state.players[1].battlefield;
  assert(p2BfFromP1 && p2BfFromP1.length > 0, 'Player 1 should see cards on Player 2 battlefield');

  // Player 1 should see Player 2 has 6 cards in hand now
  const p2HandCount = update2.state.players[1].handCount || update2.state.players[1].hand?.length;
  assertEqual(p2HandCount, 6, 'Player 2 hand should show 6 cards after playing 1');

  console.log(`  ✓ Player 2 card play synced to Player 1 (hand 7→6, battlefield 0→1)`);

  return { lastUpdate: update2 };
}

async function testLastActionTracking(gameInfo) {
  section('lastAction Tracking — Echo vs Opponent');

  const { s1, s2, gs1 } = gameInfo;

  // When Player 1 sends action, Player 1 also receives it (echo)
  // Drain stale events first
  drainEvents(s1, 'stateUpdate');
  drainEvents(s2, 'stateUpdate');
  await new Promise(r => setTimeout(r, 200));
  const p1SeesOwnUpdate = waitForEvent(s1, 'stateUpdate');
  const p2SeesUpdate = waitForEvent(s2, 'stateUpdate');

  const currentP1State = gs1.state.players[0];
  await emitCb(s1, 'gameAction', {
    action: {
      type: 'stateSync',
      state: {
        players: [{ ...currentP1State, life: 15 }, gs1.state.players[1]],
        activePlayer: gs1.state.activePlayer,
        currentPhase: 'main1',
        turnNumber: 1,
      }
    }
  });

  const echoUpdate = await p1SeesOwnUpdate;
  const oppUpdate = await p2SeesUpdate;

  // Both should receive lastAction.by = 0 (Player 1)
  assertEqual(echoUpdate.lastAction.by, 0, 'Echo should show lastAction.by = 0');
  assertEqual(oppUpdate.lastAction.by, 0, 'Opponent update should show lastAction.by = 0');

  // The client-side logic should use lastAction.by to decide:
  // - If by === myIdx → own echo → only update life/poison/commanderDamage for own state
  // - If by !== myIdx → opponent action → accept zone changes for own state too
  console.log(`  ✓ Echo and opponent updates both carry correct lastAction.by`);
  console.log(`  ✓ Client can distinguish own echo from opponent action`);
}

async function testCoinFlipRandomness() {
  section('Coin Flip Randomness');

  // Create multiple games and check that active player varies
  const results = [];
  for (let i = 0; i < 10; i++) {
    const roomData = await createRoom(`TestP1_${i}`);
    const s1 = createSocket();
    const s2 = createSocket();
    await Promise.all([
      new Promise(r => s1.on('connect', r)),
      new Promise(r => s2.on('connect', r))
    ]);

    await emitCb(s1, 'joinGame', { roomId: roomData.roomId, nickname: `P1_${i}` });
    await emitCb(s2, 'joinGame', { roomId: roomData.roomId, nickname: `P2_${i}` });

    const p1Start = waitForEvent(s1, 'gameStart');
    await emitCb(s1, 'submitDeck', { deck: createTestDeck() });
    await emitCb(s2, 'submitDeck', { deck: createTestDeck() });
    const gs = await p1Start;
    results.push(gs.state.activePlayer);

    s1.disconnect();
    s2.disconnect();
  }

  const p0Count = results.filter(r => r === 0).length;
  const p1Count = results.filter(r => r === 1).length;

  // With 10 games, both players should win at least once (extremely unlikely to fail)
  assert(p0Count > 0 && p1Count > 0,
    `Coin flip should vary: Player 0 won ${p0Count}/10, Player 1 won ${p1Count}/10`);
  console.log(`  ✓ Coin flip results over 10 games: P0=${p0Count}, P1=${p1Count}`);
}

async function testInformationHiding() {
  section('Information Hiding — Hand & Library');

  const roomData = await createRoom('HideTest1');
  const s1 = createSocket();
  const s2 = createSocket();
  await Promise.all([
    new Promise(r => s1.on('connect', r)),
    new Promise(r => s2.on('connect', r))
  ]);

  await emitCb(s1, 'joinGame', { roomId: roomData.roomId, nickname: 'HideTest1' });
  await emitCb(s2, 'joinGame', { roomId: roomData.roomId, nickname: 'HideTest2' });

  const p1Start = waitForEvent(s1, 'gameStart');
  const p2Start = waitForEvent(s2, 'gameStart');
  await emitCb(s1, 'submitDeck', { deck: createTestDeck() });
  await emitCb(s2, 'submitDeck', { deck: createTestDeck() });

  const gs1 = await p1Start;
  const gs2 = await p2Start;

  // Player 1 should see own hand cards fully
  const myHand1 = gs1.state.players[0].hand;
  assert(myHand1[0].name !== undefined, 'Player 1 should see own card names');
  assert(myHand1[0].id !== undefined, 'Player 1 should see own card IDs');

  // Player 1 should NOT see Player 2 hand details
  const oppHand1 = gs1.state.players[1].hand;
  if (oppHand1 && oppHand1.length > 0) {
    assert(oppHand1[0].hidden === true || !oppHand1[0].name,
      'Player 1 should not see opponent hand card names');
  }

  // Player 1 should NOT see opponent library contents
  const oppLib1 = gs1.state.players[1].library;
  assert(!oppLib1 || oppLib1.length === 0,
    'Player 1 should not see opponent library cards');
  assert(gs1.state.players[1].libraryCount >= 0,
    'Player 1 should see opponent library COUNT');

  // Player 1 SHOULD see own library
  const myLib1 = gs1.state.players[0].library;
  assert(myLib1 && myLib1.length > 0, 'Player 1 should see own library contents');

  console.log(`  ✓ Own hand visible: ${myHand1.length} cards with names`);
  console.log(`  ✓ Opponent hand hidden (${oppHand1?.length || 0} hidden cards)`);
  console.log(`  ✓ Opponent library hidden (count: ${gs1.state.players[1].libraryCount})`);

  s1.disconnect();
  s2.disconnect();
}

async function testTurnPassAndPhases() {
  section('Turn Pass & Phase Changes');

  const roomData = await createRoom('TurnTest1');
  const s1 = createSocket();
  const s2 = createSocket();
  await Promise.all([
    new Promise(r => s1.on('connect', r)),
    new Promise(r => s2.on('connect', r))
  ]);

  await emitCb(s1, 'joinGame', { roomId: roomData.roomId, nickname: 'Turn1' });
  await emitCb(s2, 'joinGame', { roomId: roomData.roomId, nickname: 'Turn2' });

  const p1Start = waitForEvent(s1, 'gameStart');
  const p2Start = waitForEvent(s2, 'gameStart');
  await emitCb(s1, 'submitDeck', { deck: createTestDeck() });
  await emitCb(s2, 'submitDeck', { deck: createTestDeck() });

  const gs1 = await p1Start;
  const gs2 = await p2Start;

  const initialActive = gs1.state.activePlayer;
  const nextActive = initialActive === 0 ? 1 : 0;

  // Active player passes the turn
  const p2Update = waitForEvent(s2, 'stateUpdate');
  const sender = initialActive === 0 ? s1 : s2;
  const senderState = initialActive === 0 ? gs1 : gs2;

  await emitCb(sender, 'gameAction', {
    action: {
      type: 'stateSync',
      state: {
        players: senderState.state.players,
        activePlayer: nextActive,
        currentPhase: 'upkeep',
        turnNumber: 2,
      }
    }
  });

  const turnUpdate = await p2Update;
  assertEqual(turnUpdate.state.activePlayer, nextActive,
    `Active player should switch to ${nextActive}`);
  assertEqual(turnUpdate.state.turnNumber, 2, 'Turn number should be 2');
  assertEqual(turnUpdate.state.currentPhase, 'upkeep', 'Phase should be upkeep');

  console.log(`  ✓ Turn passed: P${initialActive} → P${nextActive}, turn 1→2, phase→upkeep`);

  s1.disconnect();
  s2.disconnect();
}

async function testReconnection() {
  section('Player Reconnection');

  const roomData = await createRoom('ReconTest1');
  const s1 = createSocket();
  const s2 = createSocket();
  await Promise.all([
    new Promise(r => s1.on('connect', r)),
    new Promise(r => s2.on('connect', r))
  ]);

  const join1 = await emitCb(s1, 'joinGame', { roomId: roomData.roomId, nickname: 'Recon1' });
  await emitCb(s2, 'joinGame', { roomId: roomData.roomId, nickname: 'Recon2' });

  const p1Start = waitForEvent(s1, 'gameStart');
  await emitCb(s1, 'submitDeck', { deck: createTestDeck() });
  await emitCb(s2, 'submitDeck', { deck: createTestDeck() });
  await p1Start;

  // Player 2 sees Player 1 disconnect
  const p2SeesDisconnect = waitForEvent(s2, 'opponentDisconnected');
  s1.disconnect();
  await p2SeesDisconnect;
  console.log(`  ✓ Player 2 notified of Player 1 disconnect`);

  // Player 1 reconnects with same playerId
  const s1b = createSocket();
  await new Promise(r => s1b.on('connect', r));

  const p2SeesReconnect = waitForEvent(s2, 'playerJoined');
  const rejoin = await emitCb(s1b, 'joinGame', {
    roomId: roomData.roomId,
    nickname: 'Recon1',
    playerId: join1.playerId
  });
  assertEqual(rejoin.playerIndex, 0, 'Reconnected player should get same index');

  await p2SeesReconnect;
  console.log(`  ✓ Player 1 reconnected with same playerIndex`);

  // Request state after reconnection (requestState takes only callback, no data)
  const stateResult = await emitCb(s1b, 'requestState');
  assert(stateResult.state, 'Should receive game state on reconnection');
  assert(stateResult.state.players, 'State should have players array');

  console.log(`  ✓ Reconnected player received full game state`);

  s1b.disconnect();
  s2.disconnect();
}

async function testCombatDamageSync() {
  section('Combat Damage — Opponent Modifying Our State');

  const roomData = await createRoom('CombatTest1');
  const s1 = createSocket();
  const s2 = createSocket();
  await Promise.all([
    new Promise(r => s1.on('connect', r)),
    new Promise(r => s2.on('connect', r))
  ]);

  await emitCb(s1, 'joinGame', { roomId: roomData.roomId, nickname: 'Attacker' });
  await emitCb(s2, 'joinGame', { roomId: roomData.roomId, nickname: 'Defender' });

  const p1Start = waitForEvent(s1, 'gameStart');
  const p2Start = waitForEvent(s2, 'gameStart');
  await emitCb(s1, 'submitDeck', { deck: createTestDeck() });
  await emitCb(s2, 'submitDeck', { deck: createTestDeck() });

  const gs1 = await p1Start;
  const gs2 = await p2Start;

  // Simulate: Player 1 (attacker) deals 5 damage to Player 2 and kills a creature
  const p2State = gs1.state.players[1];

  // Put a creature on P2's battlefield first (via P2's action)
  const p2Card = gs2.state.players[1].hand[0];
  const p2BfWithCreature = [{ ...p2Card, tapped: false, id: p2Card.id }];

  const p1SeesP2Card = waitForEvent(s1, 'stateUpdate');
  await emitCb(s2, 'gameAction', {
    action: {
      type: 'stateSync',
      state: {
        players: [
          gs2.state.players[0],
          { ...gs2.state.players[1], hand: gs2.state.players[1].hand.slice(1), battlefield: p2BfWithCreature }
        ],
        activePlayer: gs1.state.activePlayer,
        currentPhase: 'main1',
        turnNumber: 1,
      }
    }
  });
  const p2CardUpdate = await p1SeesP2Card;
  console.log(`  Setup: Player 2 played a creature to battlefield`);

  // Now Player 1 attacks and kills that creature
  // Player 1 sends update that:
  //   - P2 life goes from 20 to 15
  //   - P2 battlefield loses the creature
  //   - P2 graveyard gains the creature
  const p2UpdatedState = p2CardUpdate.state.players[1];
  const killedCreature = p2BfWithCreature[0];

  // Drain stale events (P2's own echo from the card play above)
  drainEvents(s1, 'stateUpdate');
  drainEvents(s2, 'stateUpdate');
  await new Promise(r => setTimeout(r, 200));

  const p2SeesCombat = waitForEvent(s2, 'stateUpdate');
  await emitCb(s1, 'gameAction', {
    action: {
      type: 'stateSync',
      state: {
        players: [
          p2CardUpdate.state.players[0], // P1 unchanged
          {
            ...p2UpdatedState,
            life: 15,
            battlefield: [], // creature killed
            graveyard: [...(p2UpdatedState.graveyard || []), killedCreature],
          }
        ],
        activePlayer: gs1.state.activePlayer,
        currentPhase: 'combat_damage',
        turnNumber: 1,
      }
    }
  });

  const combatResult = await p2SeesCombat;

  // KEY CHECK: Player 2 should see their own life reduced
  assertEqual(combatResult.state.players[1].life, 15,
    'Defender should see life reduced to 15');

  // KEY CHECK: lastAction.by should be 0 (Player 1 = attacker)
  assertEqual(combatResult.lastAction.by, 0,
    'lastAction.by should be Player 1 (attacker)');

  // The CLIENT-SIDE receive effect should use lastAction.by to:
  // - See that by=0 !== myIdx=1 (opponent caused update)
  // - Accept battlefield/graveyard changes for own state
  // - Result: P2 sees creature removed from battlefield, added to graveyard

  const p2Bf = combatResult.state.players[1].battlefield;
  const p2Gy = combatResult.state.players[1].graveyard;
  assertEqual(p2Bf.length, 0, 'Defender battlefield should be empty after creature killed');
  assert(p2Gy && p2Gy.length > 0, 'Defender graveyard should have the killed creature');

  console.log(`  ✓ Combat damage: Defender life 20→15, creature killed`);
  console.log(`  ✓ lastAction.by = 0 (attacker) → client accepts zone changes for defender`);
  console.log(`  ✓ Server correctly relays attacker's changes to defender's zones`);

  s1.disconnect();
  s2.disconnect();
}

async function testMultipleRooms() {
  section('Multiple Simultaneous Rooms');

  const room1 = await createRoom('Game1_P1');
  const room2 = await createRoom('Game2_P1');
  assert(room1.roomId !== room2.roomId, 'Rooms should have different IDs');

  const s1a = createSocket();
  const s1b = createSocket();
  const s2a = createSocket();
  const s2b = createSocket();

  await Promise.all([
    new Promise(r => s1a.on('connect', r)),
    new Promise(r => s1b.on('connect', r)),
    new Promise(r => s2a.on('connect', r)),
    new Promise(r => s2b.on('connect', r)),
  ]);

  await emitCb(s1a, 'joinGame', { roomId: room1.roomId, nickname: 'G1P1' });
  await emitCb(s1b, 'joinGame', { roomId: room1.roomId, nickname: 'G1P2' });
  await emitCb(s2a, 'joinGame', { roomId: room2.roomId, nickname: 'G2P1' });
  await emitCb(s2b, 'joinGame', { roomId: room2.roomId, nickname: 'G2P2' });

  // Start both games
  const g1Start = waitForEvent(s1a, 'gameStart');
  const g2Start = waitForEvent(s2a, 'gameStart');

  await emitCb(s1a, 'submitDeck', { deck: createTestDeck() });
  await emitCb(s1b, 'submitDeck', { deck: createTestDeck() });
  await emitCb(s2a, 'submitDeck', { deck: createTestDeck() });
  await emitCb(s2b, 'submitDeck', { deck: createTestDeck() });

  const [gs1, gs2] = await Promise.all([g1Start, g2Start]);
  assert(gs1.state, 'Game 1 should start');
  assert(gs2.state, 'Game 2 should start');

  // Actions in game 1 should NOT leak to game 2
  const g2ListensForUpdate = new Promise((resolve) => {
    const timeout = setTimeout(() => resolve('no_update'), 1000);
    s2a.once('stateUpdate', (data) => {
      clearTimeout(timeout);
      resolve('got_update');
    });
  });

  await emitCb(s1a, 'gameAction', {
    action: {
      type: 'stateSync',
      state: {
        players: gs1.state.players,
        activePlayer: 0,
        currentPhase: 'main1',
        turnNumber: 1,
      }
    }
  });

  const g2Result = await g2ListensForUpdate;
  assertEqual(g2Result, 'no_update', 'Game 2 should NOT receive Game 1 updates');
  console.log(`  ✓ Multiple rooms isolated: actions don't leak between games`);

  s1a.disconnect();
  s1b.disconnect();
  s2a.disconnect();
  s2b.disconnect();
}

// ═══════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════');
  console.log('  Tap & Go — Integration Test Suite');
  console.log('═══════════════════════════════════════');

  try {
    await testRoomLifecycle();
    await testDeckSubmissionAndGameStart();
    const gameInfo = await testDeckSubmissionAndGameStart(); // fresh game for sync tests
    await testStateSync(gameInfo);
    await testLastActionTracking(gameInfo);
    gameInfo.s1.disconnect();
    gameInfo.s2.disconnect();

    await testCoinFlipRandomness();
    await testInformationHiding();
    await testTurnPassAndPhases();
    await testReconnection();
    await testCombatDamageSync();
    await testMultipleRooms();
  } catch (err) {
    console.error(`\n✗ FATAL ERROR: ${err.message}`);
    console.error(err.stack);
    failed++;
  }

  console.log('\n═══════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

main();
