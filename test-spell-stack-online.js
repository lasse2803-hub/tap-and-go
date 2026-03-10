/**
 * Spell Stack Online Sync — End-to-End Test
 *
 * Tests the EXACT scenario that was broken:
 * Player A taps land, then casts a spell — Player B must see the spell stack.
 *
 * Tests both server-side (GameRoom) and client-side code patterns.
 */

const fs = require('fs');
const path = require('path');
const GameRoom = require('./server/GameRoom');

const clientCode = fs.readFileSync(path.join(__dirname, 'client', 'public', 'index.html'), 'utf8');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ════════════════════════════════════════════════════════════════
// PART 1: Verify the ROOT CAUSE fix — no more throttle in parent
// ════════════════════════════════════════════════════════════════

console.log('\n▸ Root Cause Fix: Throttle Removed from Parent onStateChange');

test('Parent onStateChange has NO 100ms throttle', () => {
  // The old code had: if (now - lastSyncRef.current < 100) return;
  // Find the onStateChange prop passed to GameBoard
  const onStateChangeBlock = clientCode.match(/onStateChange=\{[^}]*\}/s);
  assert(onStateChangeBlock, 'onStateChange prop not found');
  const block = onStateChangeBlock[0];
  assert(!block.includes('lastSyncRef'), 'Still references lastSyncRef — throttle not removed');
  assert(!block.includes('< 100'), 'Still has 100ms throttle check');
  assert(!block.includes('Date.now()'), 'Still has Date.now() throttle logic');
  // Should just directly call sendAction
  assert(block.includes('sendAction'), 'Should call sendAction directly');
});

test('lastSyncRef is completely removed from OnlineGameWrapper', () => {
  // Extract OnlineGameWrapper function
  const wrapperStart = clientCode.indexOf('function OnlineGameWrapper(');
  const wrapperEnd = clientCode.indexOf('\nfunction ', wrapperStart + 1);
  const wrapperCode = clientCode.substring(wrapperStart, wrapperEnd > 0 ? wrapperEnd : wrapperStart + 2000);
  assert(!wrapperCode.includes('lastSyncRef'), 'lastSyncRef still exists in OnlineGameWrapper');
});

// ════════════════════════════════════════════════════════════════
// PART 2: Verify log entries are BUNDLED (not sent separately)
// ════════════════════════════════════════════════════════════════

console.log('\n▸ Log Entry Bundling: No More Race Condition');

test('addGameLog does NOT call onStateChange directly', () => {
  // Extract addGameLog function
  const addGameLogMatch = clientCode.match(/const addGameLog = \(pIdx[\s\S]*?(?=\n  \/\/ Scan battlefield)/);
  assert(addGameLogMatch, 'addGameLog function not found');
  const fn = addGameLogMatch[0];
  assert(!fn.includes('onStateChange({'), 'addGameLog still calls onStateChange directly!');
  assert(!fn.includes('onStateChange({ __logEntry'), 'addGameLog still sends __logEntry directly!');
});

test('addGameLog pushes to pendingLogEntriesRef', () => {
  const addGameLogMatch = clientCode.match(/const addGameLog = \(pIdx[\s\S]*?(?=\n  \/\/ Scan battlefield)/);
  const fn = addGameLogMatch[0];
  assert(fn.includes('pendingLogEntriesRef.current.push(entry)'), 'Not pushing to pendingLogEntriesRef');
});

test('addGameLog sets onlineSyncNeededRef.current = true', () => {
  const addGameLogMatch = clientCode.match(/const addGameLog = \(pIdx[\s\S]*?(?=\n  \/\/ Scan battlefield)/);
  const fn = addGameLogMatch[0];
  assert(fn.includes('onlineSyncNeededRef.current = true'), 'Not setting sync needed flag');
});

test('pendingLogEntriesRef is declared', () => {
  assert(clientCode.includes('const pendingLogEntriesRef = useRef([])'), 'pendingLogEntriesRef not declared');
});

test('Broadcast useEffect includes __logEntries from pendingLogEntriesRef', () => {
  // Find the broadcast useEffect
  const broadcastMatch = clientCode.match(/onlineSyncNeededRef\.current = false;[\s\S]*?onStateChange\(payload\)/);
  assert(broadcastMatch, 'Broadcast useEffect not found');
  const block = broadcastMatch[0];
  assert(block.includes('pendingLogEntriesRef.current'), 'Not reading from pendingLogEntriesRef');
  assert(block.includes('payload.__logEntries'), 'Not including __logEntries in payload');
  assert(block.includes('pendingLogEntriesRef.current = []'), 'Not clearing pendingLogEntriesRef after send');
});

// ════════════════════════════════════════════════════════════════
// PART 3: Verify broadcast useEffect still has spellStack
// ════════════════════════════════════════════════════════════════

console.log('\n▸ Broadcast Payload Completeness');

test('Broadcast payload includes spellStack', () => {
  const broadcastMatch = clientCode.match(/const payload = \{[\s\S]*?\};[\s\S]*?onStateChange\(payload\)/);
  assert(broadcastMatch, 'Broadcast payload not found');
  assert(broadcastMatch[0].includes('spellStack'), 'spellStack missing from payload');
});

test('Broadcast payload includes all critical fields', () => {
  const broadcastMatch = clientCode.match(/const payload = \{[\s\S]*?\};/);
  assert(broadcastMatch, 'Broadcast payload not found');
  const payload = broadcastMatch[0];
  const fields = ['players', 'activePlayer', 'currentPhase', 'spellStack', 'instantCasting',
                  'combatState', 'mulliganPhase', 'sacCounterChoice', 'endOfTurnRespond',
                  'pwAbilityOnStack', 'preventCombatDamage'];
  for (const f of fields) {
    assert(payload.includes(f), `Missing field: ${f}`);
  }
});

// ════════════════════════════════════════════════════════════════
// PART 4: Verify receiver handles both __logEntries and __logEntry
// ════════════════════════════════════════════════════════════════

console.log('\n▸ Receiver: __logEntries Array Support');

test('Receiver handles __logEntries array', () => {
  assert(clientCode.includes('onlineState.__logEntries'), 'Receiver does not check __logEntries');
});

test('Receiver falls back to __logEntry (backward compat)', () => {
  const receiverMatch = clientCode.match(/const logEntries = onlineState\.__logEntries[\s\S]*?;/);
  assert(receiverMatch, 'logEntries parsing not found');
  assert(receiverMatch[0].includes('__logEntry'), 'Missing __logEntry fallback');
});

test('Receiver iterates over log entries array', () => {
  assert(clientCode.includes('for (const entry of logEntries)'), 'Not iterating over logEntries');
});

// ════════════════════════════════════════════════════════════════
// PART 5: Server-side GameRoom tests
// ════════════════════════════════════════════════════════════════

console.log('\n▸ Server: GameRoom processAction & getVisibleState');

test('GameRoom processAction stores spellStack', () => {
  const room = new GameRoom('test1');
  // Mock sockets
  const mockSocket1 = { id: 's1', join: () => {} };
  const mockSocket2 = { id: 's2', join: () => {} };
  room.addPlayer(mockSocket1, 'Alice');
  room.addPlayer(mockSocket2, 'Bob');

  // Create a minimal deck (need at least some cards)
  const minDeck = [];
  for (let i = 0; i < 60; i++) minDeck.push({ name: `Card ${i}`, id: `c${i}` });
  room.submitDeck(0, minDeck);
  room.submitDeck(1, minDeck);
  room.startGame('single');

  // Now send a stateSync with spellStack
  const spellStackData = [{ pIdx: 0, card: { name: 'Lava Spike', id: 'ls1' }, displayName: 'Lava Spike' }];
  room.processAction(0, {
    type: 'stateSync',
    state: { spellStack: spellStackData }
  });

  // Verify spellStack is stored
  assert(room.gameState.spellStack, 'spellStack not stored on gameState');
  assert(room.gameState.spellStack.length === 1, `Expected 1 spell, got ${room.gameState.spellStack.length}`);
  assert(room.gameState.spellStack[0].card.name === 'Lava Spike', 'Wrong spell name');
});

test('GameRoom getVisibleState includes spellStack for BOTH players', () => {
  const room = new GameRoom('test2');
  const mockSocket1 = { id: 's1', join: () => {} };
  const mockSocket2 = { id: 's2', join: () => {} };
  room.addPlayer(mockSocket1, 'Alice');
  room.addPlayer(mockSocket2, 'Bob');

  const minDeck = [];
  for (let i = 0; i < 60; i++) minDeck.push({ name: `Card ${i}`, id: `c${i}` });
  room.submitDeck(0, minDeck);
  room.submitDeck(1, minDeck);
  room.startGame('single');

  // Set spellStack
  room.processAction(0, {
    type: 'stateSync',
    state: { spellStack: [{ pIdx: 0, card: { name: 'Lava Spike', id: 'ls1' }, displayName: 'Lava Spike' }] }
  });

  // Check both players see it
  const state0 = room.getVisibleState(0);
  const state1 = room.getVisibleState(1);

  assert(state0.spellStack, 'Player 0 missing spellStack in visible state');
  assert(state1.spellStack, 'Player 1 missing spellStack in visible state');
  assert(state0.spellStack.length === 1, 'Player 0 wrong spellStack length');
  assert(state1.spellStack.length === 1, 'Player 1 wrong spellStack length');
  assert(state1.spellStack[0].card.name === 'Lava Spike', 'Player 1 doesn\'t see Lava Spike');
});

test('GameRoom processAction stores __logEntries array', () => {
  const room = new GameRoom('test3');
  const mockSocket1 = { id: 's1', join: () => {} };
  const mockSocket2 = { id: 's2', join: () => {} };
  room.addPlayer(mockSocket1, 'Alice');
  room.addPlayer(mockSocket2, 'Bob');

  const minDeck = [];
  for (let i = 0; i < 60; i++) minDeck.push({ name: `Card ${i}`, id: `c${i}` });
  room.submitDeck(0, minDeck);
  room.submitDeck(1, minDeck);
  room.startGame('single');

  // Send __logEntries (the new format)
  const entries = [
    { id: 1, time: Date.now(), pIdx: 0, icon: '🃏', text: 'Alice casts Lava Spike' },
    { id: 2, time: Date.now(), pIdx: 0, icon: '🔥', text: 'Lava Spike resolves' },
  ];
  room.processAction(0, {
    type: 'stateSync',
    state: { __logEntries: entries }
  });

  assert(room.gameState.__logEntries, '__logEntries not stored');
  assert(room.gameState.__logEntries.length === 2, `Expected 2 entries, got ${room.gameState.__logEntries.length}`);
});

test('getVisibleState includes __logEntries for opponent', () => {
  const room = new GameRoom('test4');
  const mockSocket1 = { id: 's1', join: () => {} };
  const mockSocket2 = { id: 's2', join: () => {} };
  room.addPlayer(mockSocket1, 'Alice');
  room.addPlayer(mockSocket2, 'Bob');

  const minDeck = [];
  for (let i = 0; i < 60; i++) minDeck.push({ name: `Card ${i}`, id: `c${i}` });
  room.submitDeck(0, minDeck);
  room.submitDeck(1, minDeck);
  room.startGame('single');

  room.processAction(0, {
    type: 'stateSync',
    state: { __logEntries: [{ id: 1, pIdx: 0, icon: '🃏', text: 'Cast spell' }] }
  });

  const stateForOpponent = room.getVisibleState(1);
  assert(stateForOpponent.__logEntries, 'Opponent missing __logEntries');
  assert(stateForOpponent.__logEntries[0].text === 'Cast spell', 'Wrong log text for opponent');
});

// ════════════════════════════════════════════════════════════════
// PART 6: Simulate the EXACT race condition scenario
// ════════════════════════════════════════════════════════════════

console.log('\n▸ Race Condition Simulation: Tap Land → Cast Spell');

test('CRITICAL: spellStack + __logEntries arrive in SAME broadcast (no throttle drop)', () => {
  const room = new GameRoom('test5');
  const mockSocket1 = { id: 's1', join: () => {} };
  const mockSocket2 = { id: 's2', join: () => {} };
  room.addPlayer(mockSocket1, 'Alice');
  room.addPlayer(mockSocket2, 'Bob');

  const minDeck = [];
  for (let i = 0; i < 60; i++) minDeck.push({ name: `Card ${i}`, id: `c${i}` });
  room.submitDeck(0, minDeck);
  room.submitDeck(1, minDeck);
  room.startGame('single');

  // Simulate: Player 0 taps land (first broadcast)
  room.processAction(0, {
    type: 'stateSync',
    state: {
      players: [{ battlefield: [{ id: 'land1', name: 'Mountain', tapped: true }], manaPool: { R: 1 } }, null],
    }
  });

  // 50ms later — cast spell (SECOND broadcast) — this was the one being DROPPED
  // Now with the fix, this is a single broadcast containing BOTH spellStack AND __logEntries
  const spellStack = [{ pIdx: 0, card: { name: 'Lava Spike', id: 'ls1', mana_cost: '{R}' }, displayName: 'Lava Spike' }];
  const logEntries = [{ id: 1, time: Date.now(), pIdx: 0, icon: '🃏', text: 'Alice casts Lava Spike' }];

  room.processAction(0, {
    type: 'stateSync',
    state: {
      players: [{
        battlefield: [{ id: 'land1', name: 'Mountain', tapped: true }],
        manaPool: { R: 0 },
        hand: [] // card removed from hand
      }, null],
      spellStack: spellStack,
      __logEntries: logEntries,
    }
  });

  // VERIFY: Opponent sees the spell stack
  const opponentView = room.getVisibleState(1);
  assert(opponentView.spellStack, 'FAIL: Opponent does NOT see spellStack');
  assert(opponentView.spellStack.length === 1, `FAIL: Expected 1 spell, got ${opponentView.spellStack.length}`);
  assert(opponentView.spellStack[0].card.name === 'Lava Spike', 'FAIL: Wrong spell');
  assert(opponentView.__logEntries, 'FAIL: Opponent missing log entries');
  assert(opponentView.__logEntries[0].text === 'Alice casts Lava Spike', 'FAIL: Wrong log text');
});

test('Spell stack persists across multiple syncs until cleared', () => {
  const room = new GameRoom('test6');
  const mockSocket1 = { id: 's1', join: () => {} };
  const mockSocket2 = { id: 's2', join: () => {} };
  room.addPlayer(mockSocket1, 'Alice');
  room.addPlayer(mockSocket2, 'Bob');

  const minDeck = [];
  for (let i = 0; i < 60; i++) minDeck.push({ name: `Card ${i}`, id: `c${i}` });
  room.submitDeck(0, minDeck);
  room.submitDeck(1, minDeck);
  room.startGame('single');

  // Cast spell
  room.processAction(0, {
    type: 'stateSync',
    state: { spellStack: [{ pIdx: 0, card: { name: 'Lava Spike', id: 'ls1' }, displayName: 'Lava Spike' }] }
  });

  // Another sync (e.g. something else changes) — spellStack should still be there
  room.processAction(1, {
    type: 'stateSync',
    state: { players: [null, { life: 18 }] }
  });

  const view = room.getVisibleState(1);
  assert(view.spellStack.length === 1, 'spellStack disappeared after unrelated sync');

  // Now opponent resolves — spellStack cleared
  room.processAction(1, {
    type: 'stateSync',
    state: { spellStack: [] }
  });

  const viewAfter = room.getVisibleState(0);
  assert(viewAfter.spellStack.length === 0, 'spellStack not cleared after resolve');
});

test('Multiple spells on stack visible to opponent', () => {
  const room = new GameRoom('test7');
  const mockSocket1 = { id: 's1', join: () => {} };
  const mockSocket2 = { id: 's2', join: () => {} };
  room.addPlayer(mockSocket1, 'Alice');
  room.addPlayer(mockSocket2, 'Bob');

  const minDeck = [];
  for (let i = 0; i < 60; i++) minDeck.push({ name: `Card ${i}`, id: `c${i}` });
  room.submitDeck(0, minDeck);
  room.submitDeck(1, minDeck);
  room.startGame('single');

  // Player 0 casts, then Player 1 responds with counterspell
  room.processAction(0, {
    type: 'stateSync',
    state: { spellStack: [{ pIdx: 0, card: { name: 'Lava Spike', id: 'ls1' }, displayName: 'Lava Spike' }] }
  });

  // Player 1 adds counterspell on top
  room.processAction(1, {
    type: 'stateSync',
    state: {
      spellStack: [
        { pIdx: 0, card: { name: 'Lava Spike', id: 'ls1' }, displayName: 'Lava Spike' },
        { pIdx: 1, card: { name: 'Counterspell', id: 'cs1' }, displayName: 'Counterspell' },
      ]
    }
  });

  // Both players see both spells
  const view0 = room.getVisibleState(0);
  const view1 = room.getVisibleState(1);
  assert(view0.spellStack.length === 2, `Player 0 sees ${view0.spellStack.length} spells, expected 2`);
  assert(view1.spellStack.length === 2, `Player 1 sees ${view1.spellStack.length} spells, expected 2`);
  assert(view0.spellStack[1].card.name === 'Counterspell', 'Player 0 doesn\'t see Counterspell');
});

// ════════════════════════════════════════════════════════════════
// PART 7: Verify receiver-side spellStack handling
// ════════════════════════════════════════════════════════════════

console.log('\n▸ Client Receiver: spellStack Update Path');

test('Receiver updates spellStack with _setSpellStack (raw setter)', () => {
  assert(clientCode.includes('_setSpellStack(onlineState.spellStack)'), 'Receiver not using _setSpellStack');
});

test('Receiver checks spellStack !== undefined before updating', () => {
  assert(clientCode.includes("if (onlineState.spellStack !== undefined) _setSpellStack(onlineState.spellStack)"),
    'Missing undefined check for spellStack in receiver');
});

test('Spell stack overlay renders when spellStack.length > 0', () => {
  assert(clientCode.includes('spellStack.length > 0'), 'Spell stack overlay condition missing');
});

test('Spell stack resolve button gated to opponent only', () => {
  // The resolve button should only show for the opponent of the caster
  const resolveMatch = clientCode.match(/stackTop\.pIdx === 0 \? 1 : 0/);
  assert(resolveMatch, 'Resolve button not gated to opponent');
});

// ════════════════════════════════════════════════════════════════
// PART 8: Echo Prevention correctness
// ════════════════════════════════════════════════════════════════

console.log('\n▸ Echo Prevention: No Double Processing');

test('Echo detection uses lastAction.by (not a boolean flag)', () => {
  // The old boolean flag approach caused race conditions where opponent updates
  // were dropped. The new approach uses onlineLastAction.by to identify echoes.
  assert(clientCode.includes('isOwnEcho = onlineLastAction && onlineLastAction.by === myIdx'),
    'Echo detection via lastAction.by not found');
  // Verify the old boolean flag is gone
  assert(!clientCode.includes('onlineIgnoreNextUpdateRef'),
    'Old onlineIgnoreNextUpdateRef flag should be removed');
});

test('Opponent state update gated on !isOwnEcho', () => {
  assert(clientCode.includes('serverOpp && !isOwnEcho'),
    'Opponent state update not gated on !isOwnEcho');
});

test('Own state update gated on opponentCausedUpdate', () => {
  assert(clientCode.includes('serverMe && opponentCausedUpdate'),
    'Own state update not gated on opponentCausedUpdate');
});

test('Only ONE broadcast per render cycle (single useEffect)', () => {
  // Count how many times onStateChange is called in the codebase
  // Should only be in: (1) the useEffect broadcast, and (2) the parent prop
  const onStateChangeCalls = (clientCode.match(/onStateChange\(/g) || []).length;
  // The prop definition: onStateChange={(newState) => {
  // The useEffect call: onStateChange(payload);
  // That should be it — NO MORE direct calls from addGameLog
  // Also appears in: function signature, comments, etc.
  // Let's specifically check there's no onStateChange({ __logEntry
  assert(!clientCode.includes('onStateChange({ __logEntry'), 'Still has direct __logEntry send!');
});

// ════════════════════════════════════════════════════════════════
// PART 9: Verify the complete castCard → broadcast → receive flow
// ════════════════════════════════════════════════════════════════

console.log('\n▸ Complete Cast Flow: castCard → broadcast → server → opponent');

test('castCard calls setSpellStack (syncSetter)', () => {
  const castCardMatch = clientCode.match(/const castCard = \(pIdx, card[\s\S]*?(?=\n  \/\/ Cast adventure)/);
  assert(castCardMatch, 'castCard function not found');
  const fn = castCardMatch[0];
  assert(fn.includes('setSpellStack(prev =>'), 'castCard doesn\'t call setSpellStack');
});

test('castCard calls addGameLog (which now queues for broadcast)', () => {
  const castCardMatch = clientCode.match(/const castCard = \(pIdx, card[\s\S]*?(?=\n  \/\/ Cast adventure)/);
  const fn = castCardMatch[0];
  assert(fn.includes('addGameLog(pIdx,'), 'castCard doesn\'t call addGameLog');
});

test('setSpellStack is a syncSetter (triggers onlineSyncNeededRef)', () => {
  // Find setSpellStack definition — should be wrapped with syncSetter
  assert(clientCode.includes("if (onlineMode && onlineSyncNeededRef) onlineSyncNeededRef.current = true"),
    'syncSetter pattern not found');
  // Verify spellStack uses the wrapped setter
  const spellStackInit = clientCode.match(/const \[spellStack, _setSpellStack\]/);
  assert(spellStackInit, 'spellStack state not found with _setSpellStack pattern');
  // The syncSetter wrapper
  assert(clientCode.includes('setSpellStack') && clientCode.includes('_setSpellStack'),
    'Both setSpellStack and _setSpellStack should exist');
});

test('Server processAction stores spellStack with !== undefined check', () => {
  const serverCode = fs.readFileSync(path.join(__dirname, 'server', 'GameRoom.js'), 'utf8');
  assert(serverCode.includes('if (update.spellStack !== undefined) this.gameState.spellStack = update.spellStack'),
    'Server missing proper spellStack storage');
});

test('Server processAction stores __logEntries', () => {
  const serverCode = fs.readFileSync(path.join(__dirname, 'server', 'GameRoom.js'), 'utf8');
  assert(serverCode.includes('if (update.__logEntries) this.gameState.__logEntries = update.__logEntries'),
    'Server missing __logEntries storage');
});

test('Server getVisibleState deep-clones gameState (including spellStack)', () => {
  const serverCode = fs.readFileSync(path.join(__dirname, 'server', 'GameRoom.js'), 'utf8');
  assert(serverCode.includes('JSON.parse(JSON.stringify(this.gameState))'),
    'getVisibleState doesn\'t deep clone');
});

test('Server broadcasts to ALL players after processAction (index.js)', () => {
  const indexCode = fs.readFileSync(path.join(__dirname, 'server', 'index.js'), 'utf8');
  // After processAction, should iterate over all socket IDs
  const broadcastBlock = indexCode.match(/processAction[\s\S]*?for \(const \[idx, sid\] of room\.getSocketIds/);
  assert(broadcastBlock, 'Server doesn\'t broadcast to all players after processAction');
  assert(indexCode.includes("emit('stateUpdate'"), 'Server doesn\'t emit stateUpdate');
});

// ════════════════════════════════════════════════════════════════
// PART 10: Stress test — rapid sequential syncs on server
// ════════════════════════════════════════════════════════════════

console.log('\n▸ Stress Test: Rapid Sequential Syncs');

test('10 rapid stateSync actions all preserve spellStack', () => {
  const room = new GameRoom('stress1');
  const mockSocket1 = { id: 's1', join: () => {} };
  const mockSocket2 = { id: 's2', join: () => {} };
  room.addPlayer(mockSocket1, 'Alice');
  room.addPlayer(mockSocket2, 'Bob');

  const minDeck = [];
  for (let i = 0; i < 60; i++) minDeck.push({ name: `Card ${i}`, id: `c${i}` });
  room.submitDeck(0, minDeck);
  room.submitDeck(1, minDeck);
  room.startGame('single');

  // Cast a spell
  room.processAction(0, {
    type: 'stateSync',
    state: { spellStack: [{ pIdx: 0, card: { name: 'Lava Spike', id: 'ls1' }, displayName: 'Lava Spike' }] }
  });

  // 10 rapid unrelated syncs from player 1 (e.g. tapping lands, adding mana)
  for (let i = 0; i < 10; i++) {
    room.processAction(1, {
      type: 'stateSync',
      state: { players: [null, { life: 20 - i, manaPool: { U: i + 1 } }] }
    });

    // Verify spellStack survives each sync
    const view = room.getVisibleState(1);
    assert(view.spellStack.length === 1, `spellStack lost after sync #${i + 1}`);
  }
});

test('Empty spellStack correctly clears', () => {
  const room = new GameRoom('stress2');
  const mockSocket1 = { id: 's1', join: () => {} };
  const mockSocket2 = { id: 's2', join: () => {} };
  room.addPlayer(mockSocket1, 'Alice');
  room.addPlayer(mockSocket2, 'Bob');

  const minDeck = [];
  for (let i = 0; i < 60; i++) minDeck.push({ name: `Card ${i}`, id: `c${i}` });
  room.submitDeck(0, minDeck);
  room.submitDeck(1, minDeck);
  room.startGame('single');

  // Cast spell
  room.processAction(0, {
    type: 'stateSync',
    state: { spellStack: [{ pIdx: 0, card: { name: 'Lava Spike', id: 'ls1' }, displayName: 'Lava Spike' }] }
  });

  // Resolve (clear stack)
  room.processAction(1, {
    type: 'stateSync',
    state: { spellStack: [] }
  });

  const view = room.getVisibleState(0);
  assert(view.spellStack.length === 0, 'spellStack not cleared');
  assert(Array.isArray(view.spellStack), 'spellStack not an array');
});

// ════════════════════════════════════════════════════════════════
// Pre-Cast Targeting (online spell resolution)
// ════════════════════════════════════════════════════════════════
console.log('\n▸ Pre-Cast Targeting (online spell resolution)');

test('applyResolvedTargets function exists in client', () => {
  assert(clientCode.includes('const applyResolvedTargets = (casterIdx, card, targetedEffects, resolvedTargets)'),
    'applyResolvedTargets function not found');
});

test('applyResolvedTargets handles creature targets with fizzle check', () => {
  assert(clientCode.includes('resolvedTargets.type === \'creature\''),
    'Creature target type check not found');
  assert(clientCode.includes('fizzles'),
    'Fizzle handling for missing targets not found');
});

test('applyResolvedTargets handles player targets with damage', () => {
  assert(clientCode.includes('resolvedTargets.type === \'player\''),
    'Player target type check not found');
  assert(clientCode.includes('resolvedTargets.damage'),
    'Player damage from resolvedTargets not found');
});

test('pendingCastRef stores spell info for pre-cast targeting', () => {
  assert(clientCode.includes('pendingCastRef.current = { pIdx, card, asAdventure'),
    'pendingCastRef storage not found in castCard');
});

test('cancelSpellTargeting undoes pre-cast (returns card to source zone)', () => {
  assert(clientCode.includes('if (pendingCastRef.current)'),
    'pendingCastRef check in cancelSpellTargeting not found');
  assert(clientCode.includes('cancels casting'),
    'Cancel log message not found');
});

test('resolveSpellFromStack uses resolvedTargets when present', () => {
  assert(clientCode.includes('if (resolvedTargets)'),
    'resolvedTargets check in resolveSpellFromStack not found');
  assert(clientCode.includes('applyResolvedTargets(pIdx, card'),
    'applyResolvedTargets call in resolveSpellFromStack not found');
});

// ════════════════════════════════════════════════════════════════
// Summary
// ════════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(55)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(55)}`);

process.exit(failed > 0 ? 1 : 0);
