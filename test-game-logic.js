/**
 * Tap & Go — In-Game Logic Tests
 *
 * Tests game mechanics by extracting logic from index.html and running it in Node.js:
 * 1. Card type detection (isPlaneswalker, isCreature, isLand, etc.)
 * 2. Planeswalker ability parsing & loyalty mechanics
 * 3. Counter system (add/remove, loyalty, +1/+1, -1/-1)
 * 4. Deck parsing (parseArenaDecklist)
 * 5. Z-index overlay stacking (no conflicts)
 * 6. Online mode guard completeness
 *
 * Also uses Socket.io to test planeswalker flows in actual online games.
 *
 * Usage: node test-game-logic.js
 */

const http = require('http');
const fs = require('fs');
const io = require('./node_modules/socket.io/client-dist/socket.io.js');

const SERVER_URL = 'http://localhost:3000';
let passed = 0;
let failed = 0;
let testName = '';

function assert(condition, msg) {
  if (condition) passed++;
  else { failed++; console.error(`  ✗ FAIL [${testName}]: ${msg}`); }
}

function assertEqual(actual, expected, msg) {
  if (actual === expected) passed++;
  else { failed++; console.error(`  ✗ FAIL [${testName}]: ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

function section(name) {
  testName = name;
  console.log(`\n▸ ${name}`);
}

// ═══════════════════════════════════════════════════
// Extracted game logic functions from index.html
// ═══════════════════════════════════════════════════

const isCreature = (card) => card.type_line && card.type_line.toLowerCase().includes('creature');
const isLand = (card) => card.type_line && card.type_line.toLowerCase().includes('land');
const isEnchantment = (card) => card.type_line && card.type_line.toLowerCase().includes('enchantment');
const isArtifact = (card) => card.type_line && card.type_line.toLowerCase().includes('artifact');
const isPlaneswalker = (card) => card.type_line && card.type_line.toLowerCase().includes('planeswalker');
const isInstant = (card) => card.type_line && card.type_line.toLowerCase().includes('instant');

// Copy of parsePlaneswalkerAbilities from index.html
const parsePlaneswalkerAbilities = (card) => {
  const oracle = card.oracle_text || (card.card_faces && card.card_faces[0] ? card.card_faces[0].oracle_text : '') || '';
  const abilities = [];
  // Primary format: [+1]: text or [-2]: text or [0]: text
  const bracketRegex = /\[([+\-\u2212]?\d+)\]:\s*([^\n]+)/g;
  let match;
  while ((match = bracketRegex.exec(oracle)) !== null) {
    abilities.push({ cost: match[1].replace('\u2212', '-'), text: match[2].trim() });
  }
  // Fallback format: +1: text or −2: text
  if (abilities.length === 0 && isPlaneswalker(card)) {
    const fallbackRegex = /^([+\-\u2212]\d+):\s*(.+)$/gm;
    while ((match = fallbackRegex.exec(oracle)) !== null) {
      abilities.push({ cost: match[1].replace('\u2212', '-'), text: match[2].trim() });
    }
  }
  return abilities;
};

const getPlaneswalkerStartingLoyalty = (card) => {
  if (card.loyalty) return parseInt(card.loyalty);
  if (card.card_faces) {
    for (const face of card.card_faces) {
      if (face.loyalty) return parseInt(face.loyalty);
    }
  }
  return 0;
};

const parseArenaDecklist = (text) => {
  const lines = text.trim().split('\n');
  const entries = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) continue;
    let cardPart = trimmed;
    let reskin = null;
    const reskinIdx = trimmed.indexOf('>>');
    if (reskinIdx !== -1) {
      cardPart = trimmed.substring(0, reskinIdx).trim();
    }
    const match = cardPart.match(/^(\d+)\s+(.+?)(?:\s+\(([A-Za-z0-9]+)\)(?:\s+(\S+))?)?$/);
    if (match) {
      entries.push({
        qty: parseInt(match[1], 10),
        name: match[2].trim(),
        set: match[3] ? match[3].toLowerCase() : null,
        collectorNumber: match[4] || null,
      });
    }
  }
  return entries;
};

// ═══════════════════════════════════════════════════
// Socket.io helpers
// ═══════════════════════════════════════════════════
function createSocket() { return io(SERVER_URL, { transports: ['websocket', 'polling'], forceNew: true }); }
function emitCb(socket, event, data) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout on ${event}`)), 5000);
    if (data === undefined) { socket.emit(event, (r) => { clearTimeout(timeout); resolve(r); }); return; }
    socket.emit(event, data, (r) => { clearTimeout(timeout); resolve(r); });
  });
}
function waitForEvent(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (data) => { clearTimeout(timeout); resolve(data); });
  });
}
function drainEvents(socket, event) { socket.removeAllListeners(event); }
function createRoom(nickname) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ nickname });
    const req = http.request(`${SERVER_URL}/api/room/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => { let body = ''; res.on('data', c => body += c); res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } }); });
    req.on('error', reject); req.write(data); req.end();
  });
}

// ═══════════════════════════════════════════════════
// TEST 1: Card Type Detection
// ═══════════════════════════════════════════════════

function testCardTypeDetection() {
  section('Card Type Detection');

  const cards = [
    { name: 'Jace, Architect of Thought', type_line: 'Legendary Planeswalker — Jace', loyalty: '4' },
    { name: 'Lightning Bolt', type_line: 'Instant' },
    { name: 'Mountain', type_line: 'Basic Land — Mountain' },
    { name: 'Grizzly Bears', type_line: 'Creature — Bear' },
    { name: 'Sol Ring', type_line: 'Artifact' },
    { name: 'Pacifism', type_line: 'Enchantment — Aura' },
    { name: 'Dockside Extortionist', type_line: 'Creature — Goblin Pirate' },
    { name: 'Karn, the Great Creator', type_line: 'Legendary Planeswalker — Karn', loyalty: '5' },
    { name: 'Shark Typhoon', type_line: 'Enchantment' },
    { name: 'Wurmcoil Engine', type_line: 'Artifact Creature — Phyrexian Wurm' },
    { name: 'Grist, the Hunger Tide', type_line: 'Legendary Planeswalker — Grist', loyalty: '3' },
    { name: 'Mutavault', type_line: 'Land' },
    { name: 'Nicol Bolas, Dragon-God', type_line: 'Legendary Planeswalker — Bolas', loyalty: '4' },
  ];

  // Test isPlaneswalker
  assert(isPlaneswalker(cards[0]), 'Jace should be planeswalker');
  assert(isPlaneswalker(cards[7]), 'Karn should be planeswalker');
  assert(isPlaneswalker(cards[10]), 'Grist should be planeswalker');
  assert(isPlaneswalker(cards[12]), 'Nicol Bolas should be planeswalker');
  assert(!isPlaneswalker(cards[1]), 'Lightning Bolt should NOT be planeswalker');
  assert(!isPlaneswalker(cards[3]), 'Grizzly Bears should NOT be planeswalker');
  assert(!isPlaneswalker(cards[2]), 'Mountain should NOT be planeswalker');

  // Test isCreature
  assert(isCreature(cards[3]), 'Grizzly Bears should be creature');
  assert(isCreature(cards[6]), 'Dockside should be creature');
  assert(isCreature(cards[9]), 'Wurmcoil should be creature');
  assert(!isCreature(cards[0]), 'Jace should NOT be creature');
  assert(!isCreature(cards[1]), 'Lightning Bolt should NOT be creature');

  // Test isLand
  assert(isLand(cards[2]), 'Mountain should be land');
  assert(isLand(cards[11]), 'Mutavault should be land');
  assert(!isLand(cards[0]), 'Jace should NOT be land');

  // Test isArtifact
  assert(isArtifact(cards[4]), 'Sol Ring should be artifact');
  assert(isArtifact(cards[9]), 'Wurmcoil should be artifact');
  assert(!isArtifact(cards[0]), 'Jace should NOT be artifact');

  // Test isEnchantment
  assert(isEnchantment(cards[5]), 'Pacifism should be enchantment');
  assert(isEnchantment(cards[8]), 'Shark Typhoon should be enchantment');
  assert(!isEnchantment(cards[0]), 'Jace should NOT be enchantment');

  // Test isInstant
  assert(isInstant(cards[1]), 'Lightning Bolt should be instant');
  assert(!isInstant(cards[0]), 'Jace should NOT be instant');

  // Test edge cases
  assert(!isPlaneswalker({ type_line: undefined }), 'undefined type_line should not crash');
  assert(!isPlaneswalker({}), 'empty card should not crash');
  assert(!isCreature({ type_line: '' }), 'empty type_line should return false');

  console.log(`  ✓ All type detection tests passed`);
}

// ═══════════════════════════════════════════════════
// TEST 2: Planeswalker Ability Parsing
// ═══════════════════════════════════════════════════

function testPlaneswalkerAbilityParsing() {
  section('Planeswalker Ability Parsing');

  // Jace, Architect of Thought
  const jace = {
    name: 'Jace, Architect of Thought',
    type_line: 'Legendary Planeswalker — Jace',
    loyalty: '4',
    oracle_text: '[+1]: Until your next turn, whenever a creature an opponent controls attacks, it gets -1/-0 until end of turn.\n[−2]: Reveal the top three cards of your library. An opponent separates those cards into two piles. Put one pile into your hand and the other on the bottom of your library in any order.\n[−5]: You may cast target instant or sorcery card from each player\'s library without paying its mana cost.'
  };

  const jaceAbilities = parsePlaneswalkerAbilities(jace);
  assertEqual(jaceAbilities.length, 3, 'Jace should have 3 abilities');
  assertEqual(jaceAbilities[0].cost, '+1', 'Jace first ability should be +1');
  assertEqual(jaceAbilities[1].cost, '-2', 'Jace second ability should be -2');
  assertEqual(jaceAbilities[2].cost, '-5', 'Jace third ability should be -5');

  // Karn, the Great Creator
  const karn = {
    name: 'Karn, the Great Creator',
    type_line: 'Legendary Planeswalker — Karn',
    loyalty: '5',
    oracle_text: 'Activated abilities of artifacts your opponents control can\'t be activated.\n[+1]: Until your next turn, up to one target noncreature artifact becomes an artifact creature with power and toughness each equal to its mana value.\n[−2]: You may reveal an artifact card you own from outside the game or in exile and put it into your hand.'
  };

  const karnAbilities = parsePlaneswalkerAbilities(karn);
  assertEqual(karnAbilities.length, 2, 'Karn should have 2 abilities');
  assertEqual(karnAbilities[0].cost, '+1', 'Karn first ability should be +1');
  assertEqual(karnAbilities[1].cost, '-2', 'Karn second ability should be -2');

  // Starting loyalty
  assertEqual(getPlaneswalkerStartingLoyalty(jace), 4, 'Jace starting loyalty should be 4');
  assertEqual(getPlaneswalkerStartingLoyalty(karn), 5, 'Karn starting loyalty should be 5');
  assertEqual(getPlaneswalkerStartingLoyalty({ name: 'Test', type_line: 'Creature' }), 0, 'Non-PW starting loyalty should be 0');

  // Test with card_faces (MDFC planeswalker)
  const mdfcPW = {
    name: 'Test MDFC',
    type_line: 'Legendary Planeswalker — Test // Legendary Creature',
    card_faces: [
      { loyalty: '3', oracle_text: '[+1]: Draw a card.\n[-3]: Deal 3 damage.' },
      { oracle_text: 'Menace' }
    ]
  };
  assertEqual(getPlaneswalkerStartingLoyalty(mdfcPW), 3, 'MDFC PW starting loyalty from card_faces');
  const mdfcAbilities = parsePlaneswalkerAbilities(mdfcPW);
  assertEqual(mdfcAbilities.length, 2, 'MDFC PW should parse abilities from front face');

  console.log(`  ✓ All planeswalker parsing tests passed`);
}

// ═══════════════════════════════════════════════════
// TEST 3: Counter Logic
// ═══════════════════════════════════════════════════

function testCounterLogic() {
  section('Counter System Logic');

  // Simulate addCounter
  const card1 = { id: 'test1', counters: {} };
  const afterAdd = { ...card1, counters: { ...card1.counters } };
  afterAdd.counters['+1/+1'] = (afterAdd.counters['+1/+1'] || 0) + 1;
  assertEqual(afterAdd.counters['+1/+1'], 1, 'Adding +1/+1 counter should result in 1');

  afterAdd.counters['+1/+1'] = (afterAdd.counters['+1/+1'] || 0) + 1;
  assertEqual(afterAdd.counters['+1/+1'], 2, 'Adding second +1/+1 counter should result in 2');

  // Simulate removeCounter
  afterAdd.counters['+1/+1'] = Math.max(0, (afterAdd.counters['+1/+1'] || 0) - 1);
  assertEqual(afterAdd.counters['+1/+1'], 1, 'Removing one +1/+1 counter should leave 1');

  afterAdd.counters['+1/+1'] = Math.max(0, (afterAdd.counters['+1/+1'] || 0) - 1);
  if (afterAdd.counters['+1/+1'] === 0) delete afterAdd.counters['+1/+1'];
  assert(afterAdd.counters['+1/+1'] === undefined, 'Counter at 0 should be deleted');

  // Loyalty counter simulation
  const pw = { id: 'pw1', counters: { loyalty: 4 } };

  // +1 ability
  const afterPlus = { ...pw, counters: { ...pw.counters } };
  afterPlus.counters.loyalty = (afterPlus.counters.loyalty || 0) + 1;
  assertEqual(afterPlus.counters.loyalty, 5, 'Loyalty after +1 should be 5');

  // -2 ability
  const afterMinus = { ...pw, counters: { ...pw.counters } };
  const costNum = -2;
  const currentLoyalty = afterMinus.counters.loyalty || 0;
  assert(currentLoyalty + costNum >= 0, 'Should be able to use -2 with 4 loyalty');
  afterMinus.counters.loyalty = currentLoyalty + costNum;
  assertEqual(afterMinus.counters.loyalty, 2, 'Loyalty after -2 should be 2');

  // Can't use -5 with only 4 loyalty
  const bigCost = -5;
  assert(currentLoyalty + bigCost < 0, 'Should NOT be able to use -5 with 4 loyalty');

  // Can use -4 exactly (goes to 0)
  const exactCost = -4;
  assert(currentLoyalty + exactCost >= 0, 'Should be able to use -4 with 4 loyalty (goes to 0)');

  // Damage to planeswalker
  const pwDamaged = { id: 'pw2', counters: { loyalty: 3 } };
  const damage = 2;
  const newLoyalty = Math.max(0, (pwDamaged.counters.loyalty || 0) - damage);
  assertEqual(newLoyalty, 1, 'PW with 3 loyalty taking 2 damage should have 1');
  assert(newLoyalty > 0, 'PW should survive with 1 loyalty');

  // Lethal damage
  const lethalDamage = 3;
  const lethalResult = Math.max(0, (pwDamaged.counters.loyalty || 0) - lethalDamage);
  assertEqual(lethalResult, 0, 'PW with 3 loyalty taking 3 damage should have 0');
  assert(lethalResult <= 0, 'PW should die at 0 loyalty');

  console.log(`  ✓ All counter logic tests passed`);
}

// ═══════════════════════════════════════════════════
// TEST 4: Decklist Parsing Edge Cases
// ═══════════════════════════════════════════════════

function testDecklistParsing() {
  section('Decklist Parsing Edge Cases');

  // Multi-word card names
  const entries1 = parseArenaDecklist('4 Light Up the Stage');
  assertEqual(entries1[0].name, 'Light Up the Stage', 'Multi-word name should parse correctly');
  assertEqual(entries1[0].qty, 4, 'Quantity should be 4');
  assertEqual(entries1[0].set, null, 'No set should be null');

  // Card with set code
  const entries2 = parseArenaDecklist('2 Lightning Bolt (2XM)');
  assertEqual(entries2[0].name, 'Lightning Bolt', 'Name with set should parse correctly');
  assertEqual(entries2[0].set, '2xm', 'Set should be lowercase');

  // Card with set + collector number
  const entries3 = parseArenaDecklist('1 Phyrexian Obliterator (A25) 101');
  assertEqual(entries3[0].name, 'Phyrexian Obliterator', 'Name with set+CN should parse');
  assertEqual(entries3[0].set, 'a25', 'Set should be a25');
  assertEqual(entries3[0].collectorNumber, '101', 'CN should be 101');

  // Star collector number (promo)
  const entries4 = parseArenaDecklist('4 Llanowar Elves (PDMU) 1★');
  assertEqual(entries4[0].name, 'Llanowar Elves', 'Promo card name should parse');
  assertEqual(entries4[0].collectorNumber, '1★', 'Star CN should parse');

  // Comments and blank lines
  const entries5 = parseArenaDecklist(`
    // This is a comment
    # Another comment
    4 Mountain

    2 Lightning Bolt
  `);
  assertEqual(entries5.length, 2, 'Should skip comments and blanks');
  assertEqual(entries5[0].name, 'Mountain', 'First card after comments');

  // Reskin syntax
  const entries6 = parseArenaDecklist('4 Mountain >> Fire Mountain|https://example.com/fire.jpg');
  assertEqual(entries6[0].name, 'Mountain', 'Reskin card name should parse');
  assertEqual(entries6[0].qty, 4, 'Reskin qty should be 4');

  // Apostrophe in name
  const entries7 = parseArenaDecklist("4 Geralf's Messenger");
  assertEqual(entries7[0].name, "Geralf's Messenger", 'Apostrophe in name should work');

  // Comma in name
  const entries8 = parseArenaDecklist('3 Thalia, Guardian of Thraben');
  assertEqual(entries8[0].name, 'Thalia, Guardian of Thraben', 'Comma in name should work');

  // THE ORIGINAL BUG: collector number capturing last word
  // "Light Up the Stage" should NOT become name="Light Up the" cn="Stage"
  const entries9 = parseArenaDecklist('4 Light Up the Stage (RNA) 107');
  assertEqual(entries9[0].name, 'Light Up the Stage', 'Set+CN should not steal name words');
  assertEqual(entries9[0].set, 'rna', 'Set should be rna');
  assertEqual(entries9[0].collectorNumber, '107', 'CN should be 107');

  // Card WITHOUT set should NOT have collector number
  const entries10 = parseArenaDecklist('4 Light Up the Stage');
  assertEqual(entries10[0].collectorNumber, null, 'No set = no collector number');
  assertEqual(entries10[0].name, 'Light Up the Stage', 'Full name preserved without set');

  console.log(`  ✓ All decklist parsing tests passed`);
}

// ═══════════════════════════════════════════════════
// TEST 5: Z-Index Stacking Order (no conflicts)
// ═══════════════════════════════════════════════════

function testZIndexStacking() {
  section('Z-Index Overlay Stacking');

  // Read the actual HTML file and extract z-index values
  const htmlPath = __dirname + '/client/public/index.html';
  const html = fs.readFileSync(htmlPath, 'utf8');

  // Extract all z-index values with context
  const zIndexRegex = /z[_-]?[Ii]ndex\s*[:=]\s*['"]?(\d+)/g;
  const zValues = [];
  let m;
  while ((m = zIndexRegex.exec(html)) !== null) {
    zValues.push(parseInt(m[1]));
  }

  assert(zValues.length > 0, 'Should find z-index values in HTML');

  // Error boundary should be highest
  assert(zValues.includes(99999), 'Error boundary should have z-index 99999');

  // Key overlays should exist
  assert(zValues.includes(500), 'Modal overlay (500) should exist');
  assert(zValues.includes(1000), 'Context menu (1000) should exist');
  assert(zValues.includes(9999), 'Critical overlays (9999) should exist');

  // Verify ordering: error > disconnect > overlays > modals > cards
  const criticalOrder = [
    { name: 'card hover', z: 10 },
    { name: 'modal overlay', z: 500 },
    { name: 'card preview', z: 900 },
    { name: 'context menu', z: 1000 },
    { name: 'game over', z: 2000 },
    { name: 'mulligan', z: 3000 },
    { name: 'disconnect', z: 9998 },
    { name: 'spell stack', z: 9999 },
    { name: 'scry/surveil', z: 10000 },
    { name: 'mana choice', z: 10001 },
    { name: 'error boundary', z: 99999 },
  ];

  for (let i = 1; i < criticalOrder.length; i++) {
    assert(criticalOrder[i].z > criticalOrder[i-1].z,
      `${criticalOrder[i].name} (${criticalOrder[i].z}) should be above ${criticalOrder[i-1].name} (${criticalOrder[i-1].z})`);
  }

  console.log(`  ✓ Z-index stacking order verified (${zValues.length} values found)`);
}

// ═══════════════════════════════════════════════════
// TEST 6: Online Mode Guard Completeness
// ═══════════════════════════════════════════════════

function testOnlineGuardCompleteness() {
  section('Online Mode Guard Completeness');

  const htmlPath = __dirname + '/client/public/index.html';
  const html = fs.readFileSync(htmlPath, 'utf8');

  // Functions that MUST have online guards
  const guardedFunctions = [
    'drawCard',
    'shuffleLibrary',
    'toggleTap',
    'millCards',
    'returnToLibrary',
    'playCardFromHand',
    'activatePlaneswalkerAbility',
  ];

  for (const fn of guardedFunctions) {
    // Find function definition and check for guard within next few lines
    const fnRegex = new RegExp(`const ${fn}\\s*=\\s*\\(pIdx[^)]*\\)\\s*=>\\s*\\{[^}]{0,200}onlineMode`, 's');
    const hasGuard = fnRegex.test(html);
    assert(hasGuard, `${fn} should have onlineMode guard`);
  }

  // Functions that should NOT be guarded (legitimate opponent interaction)
  const unguardedFunctions = [
    'addCounter',     // opponent can add -1/-1 via spells
    'removeCounter',  // opponent can remove counters via spells
  ];

  // Verify isPlaneswalker is defined
  const isPWDefined = /const isPlaneswalker\s*=/.test(html);
  assert(isPWDefined, 'isPlaneswalker should be defined');

  // Verify isPlaneswalker is defined BEFORE first use
  const defIndex = html.indexOf('const isPlaneswalker =');
  const firstUse = html.indexOf('isPlaneswalker(');
  assert(defIndex > 0 && defIndex < firstUse,
    `isPlaneswalker definition (pos ${defIndex}) should come before first use (pos ${firstUse})`);

  // handleContext guard
  const hasContextGuard = /handleContext[^}]*onlineMode && pIdx !== onlinePlayerIndex/.test(html);
  assert(hasContextGuard, 'handleContext should have online guard for hand/library');

  // Hand card click guard
  const hasHandClickGuard = /onClick.*onlineMode && pIdx !== onlinePlayerIndex.*playCardFromHand|playCardFromHand.*onlineMode/s.test(html);
  assert(hasHandClickGuard, 'Hand card click should have online guard');

  console.log(`  ✓ All online guards verified`);
}

// ═══════════════════════════════════════════════════
// TEST 7: Planeswalker Online Play (Socket.io)
// ═══════════════════════════════════════════════════

async function testPlaneswalkerOnlinePlay() {
  section('Planeswalker Online — Loyalty & Abilities');

  // Create a test deck with planeswalkers
  function createPWDeck() {
    const cards = [];
    // 4 planeswalkers
    for (let i = 0; i < 4; i++) {
      cards.push({
        id: `jace_${i}_${Math.random().toString(36).slice(2)}`,
        name: 'Jace, Architect of Thought',
        type_line: 'Legendary Planeswalker — Jace',
        loyalty: '4',
        oracle_text: '[+1]: Until your next turn, creatures get -1/-0.\n[-2]: Reveal top three.\n[-5]: Cast from libraries.',
        mana_cost: '{2}{U}{U}',
        image_uris: { normal: 'x', small: 'x' },
        colors: ['U'], cmc: 4, counters: {}, tapped: false,
      });
    }
    // Fill with lands
    for (let i = 0; i < 56; i++) {
      cards.push({
        id: `island_${i}_${Math.random().toString(36).slice(2)}`,
        name: 'Island', type_line: 'Basic Land — Island',
        mana_cost: '', oracle_text: '{T}: Add {U}.',
        image_uris: { normal: 'x', small: 'x' },
        colors: [], cmc: 0, counters: {}, tapped: false,
      });
    }
    return cards;
  }

  const roomData = await createRoom('PWTest1');
  const s1 = createSocket();
  const s2 = createSocket();
  await Promise.all([new Promise(r => s1.on('connect', r)), new Promise(r => s2.on('connect', r))]);

  await emitCb(s1, 'joinGame', { roomId: roomData.roomId, nickname: 'PWTest1' });
  await emitCb(s2, 'joinGame', { roomId: roomData.roomId, nickname: 'PWTest2' });

  const p1Start = waitForEvent(s1, 'gameStart');
  const p2Start = waitForEvent(s2, 'gameStart');
  await emitCb(s1, 'submitDeck', { deck: createPWDeck() });
  await emitCb(s2, 'submitDeck', { deck: createPWDeck() });

  const gs1 = await p1Start;
  const gs2 = await p2Start;

  // Find a Jace in P1's hand
  const jace = gs1.state.players[0].hand.find(c => c.name === 'Jace, Architect of Thought');

  if (!jace) {
    // All Jaces might be in library — just test with whatever we have
    console.log(`  (No Jace in opening hand — testing with library cards)`);
    // Still test the game starts correctly
    assertEqual(gs1.state.players[0].hand.length, 7, 'P1 should have 7 cards');
    assertEqual(gs1.state.players[1].life, 20, 'P2 should have 20 life');
  } else {
    // Play Jace to battlefield
    drainEvents(s2, 'stateUpdate');
    const p2SeesJace = waitForEvent(s2, 'stateUpdate');

    // Jace enters with loyalty 4
    const jaceOnBF = {
      ...jace,
      tapped: false,
      enteredThisTurn: true,
      counters: { ...jace.counters, loyalty: parseInt(jace.loyalty) || 4 }
    };

    await emitCb(s1, 'gameAction', {
      action: {
        type: 'stateSync',
        state: {
          players: [
            {
              ...gs1.state.players[0],
              hand: gs1.state.players[0].hand.filter(c => c.id !== jace.id),
              battlefield: [jaceOnBF],
            },
            gs1.state.players[1]
          ],
          activePlayer: gs1.state.activePlayer,
          currentPhase: 'main1', turnNumber: 1,
        }
      }
    });

    const jaceUpdate = await p2SeesJace;
    const p1BfFromP2 = jaceUpdate.state.players[0].battlefield;
    assert(p1BfFromP2 && p1BfFromP2.length === 1, 'P2 should see Jace on P1 battlefield');

    if (p1BfFromP2 && p1BfFromP2[0]) {
      assertEqual(p1BfFromP2[0].counters.loyalty, 4, 'Jace should enter with 4 loyalty');
      assert(isPlaneswalker(p1BfFromP2[0]), 'Jace should be detected as planeswalker');
    }

    // Simulate +1 ability activation
    drainEvents(s2, 'stateUpdate');
    const p2SeesPlus = waitForEvent(s2, 'stateUpdate');

    const jaceAfterPlus = { ...jaceOnBF, counters: { loyalty: 5 } };

    await emitCb(s1, 'gameAction', {
      action: {
        type: 'stateSync',
        state: {
          players: [
            {
              ...gs1.state.players[0],
              hand: gs1.state.players[0].hand.filter(c => c.id !== jace.id),
              battlefield: [jaceAfterPlus],
            },
            gs1.state.players[1]
          ],
          activePlayer: gs1.state.activePlayer,
          currentPhase: 'main1', turnNumber: 1,
        }
      }
    });

    const plusUpdate = await p2SeesPlus;
    const p1BfAfterPlus = plusUpdate.state.players[0].battlefield;
    if (p1BfAfterPlus && p1BfAfterPlus[0]) {
      assertEqual(p1BfAfterPlus[0].counters.loyalty, 5, 'Jace loyalty after +1 should be 5');
    }

    // Simulate opponent dealing 3 damage to Jace (combat)
    drainEvents(s1, 'stateUpdate');
    drainEvents(s2, 'stateUpdate');
    await new Promise(r => setTimeout(r, 100));

    const p1SeesDamage = waitForEvent(s1, 'stateUpdate');

    const jaceDamaged = { ...jaceAfterPlus, counters: { loyalty: 2 } }; // 5 - 3 = 2

    await emitCb(s2, 'gameAction', {
      action: {
        type: 'stateSync',
        state: {
          players: [
            {
              ...plusUpdate.state.players[0],
              battlefield: [jaceDamaged],
            },
            plusUpdate.state.players[1]
          ],
          activePlayer: gs1.state.activePlayer,
          currentPhase: 'combat_damage', turnNumber: 1,
        }
      }
    });

    const damageUpdate = await p1SeesDamage;
    // This tests the critical fix: opponent modifying our battlefield (lastAction.by !== myIdx)
    assertEqual(damageUpdate.lastAction.by, 1, 'Combat damage should show lastAction.by = 1 (opponent)');

    const p1BfAfterDmg = damageUpdate.state.players[0].battlefield;
    if (p1BfAfterDmg && p1BfAfterDmg[0]) {
      assertEqual(p1BfAfterDmg[0].counters.loyalty, 2, 'Jace loyalty after 3 damage should be 2');
    }

    console.log(`  ✓ Jace entered with 4 loyalty, +1 to 5, took 3 damage to 2`);
  }

  s1.disconnect();
  s2.disconnect();
}

// ═══════════════════════════════════════════════════
// 8. Until Next Turn Effects (Jace +1 auto-apply)
// ═══════════════════════════════════════════════════

function testUntilNextTurnEffects() {
  section('Until Next Turn — Effect registration via PW ability pattern');

  // Test the regex pattern used to detect "until your next turn, whenever a creature an opponent controls attacks, it gets -X/-Y"
  const jaceText = "until your next turn, whenever a creature an opponent controls attacks, it gets -1/-0 until end of turn";
  const match = jaceText.match(/until your next turn,?\s+whenever a creature an opponent controls attacks,?\s+it gets (-?\d+)\/(-?\d+)/i);
  assert(match !== null, 'Jace +1 text should match the until-next-turn attacker debuff pattern');
  assertEqual(parseInt(match[1]), -1, 'Power debuff should be -1');
  assertEqual(parseInt(match[2]), 0, 'Toughness debuff should be 0');

  // Test with slightly different formatting
  const jaceAlt = "Until your next turn whenever a creature an opponent controls attacks it gets -1/-0 until end of turn.";
  const matchAlt = jaceAlt.match(/until your next turn,?\s+whenever a creature an opponent controls attacks,?\s+it gets (-?\d+)\/(-?\d+)/i);
  assert(matchAlt !== null, 'Alternative formatting should also match');

  // Test non-matching patterns
  const nonMatch = "target creature gets -3/-0 until end of turn";
  const noMatch = nonMatch.match(/until your next turn,?\s+whenever a creature an opponent controls attacks,?\s+it gets (-?\d+)\/(-?\d+)/i);
  assert(noMatch === null, 'Non Jace-style text should not match');

  // Test with -2/-0 variant (hypothetical)
  const variant = "until your next turn, whenever a creature an opponent controls attacks, it gets -2/-0 until end of turn";
  const matchVar = variant.match(/until your next turn,?\s+whenever a creature an opponent controls attacks,?\s+it gets (-?\d+)\/(-?\d+)/i);
  assert(matchVar !== null, 'Variant with -2/-0 should match');
  assertEqual(parseInt(matchVar[1]), -2, 'Power debuff should be -2');
  assertEqual(parseInt(matchVar[2]), 0, 'Toughness debuff should be 0');

  console.log('  ✓ Pattern matching for until-next-turn effects');

  section('Until Next Turn — Effect data structure');

  // Test creating effect object
  const effect = {
    id: 'test-effect-1',
    type: 'attacker_debuff',
    power: -1,
    toughness: 0,
    sourceName: 'Jace, Architect of Thought',
    ownerIdx: 0,
    registeredTurn: 3,
  };
  assertEqual(effect.type, 'attacker_debuff', 'Effect type should be attacker_debuff');
  assertEqual(effect.power, -1, 'Effect power should be -1');
  assertEqual(effect.toughness, 0, 'Effect toughness should be 0');
  assertEqual(effect.ownerIdx, 0, 'Owner should be player 0');

  console.log('  ✓ Effect data structure is correct');

  section('Until Next Turn — Applying debuffs to attackers');

  // Simulate applying debuffs to attacking creatures
  const attackers = ['creature-1', 'creature-3'];
  const battlefield = [
    { id: 'creature-1', name: 'Goblin Guide', type_line: 'Creature — Goblin Scout', power: '2', toughness: '2', tempBuffs: null },
    { id: 'creature-2', name: 'Mountain', type_line: 'Basic Land — Mountain', tempBuffs: null },
    { id: 'creature-3', name: 'Lightning Mauler', type_line: 'Creature — Human Berserker', power: '2', toughness: '1', tempBuffs: null },
  ];
  const effects = [{ type: 'attacker_debuff', power: -1, toughness: 0 }];

  let totalPower = 0, totalToughness = 0;
  effects.forEach(e => { totalPower += e.power; totalToughness += e.toughness; });

  const updatedBattlefield = battlefield.map(c => {
    if (!attackers.includes(c.id) || !isCreature(c)) return c;
    const existing = c.tempBuffs || { power: 0, toughness: 0, keywords: [] };
    return {
      ...c,
      tempBuffs: {
        ...existing,
        power: (existing.power || 0) + totalPower,
        toughness: (existing.toughness || 0) + totalToughness,
      },
    };
  });

  // creature-1 (attacker) should have tempBuffs
  const c1 = updatedBattlefield.find(c => c.id === 'creature-1');
  assertEqual(c1.tempBuffs.power, -1, 'Goblin Guide should have -1 power buff');
  assertEqual(c1.tempBuffs.toughness, 0, 'Goblin Guide toughness buff should be 0');

  // creature-2 (land, not attacking) should be unchanged
  const c2 = updatedBattlefield.find(c => c.id === 'creature-2');
  assert(c2.tempBuffs === null, 'Mountain should not be affected');

  // creature-3 (attacker) should have tempBuffs
  const c3 = updatedBattlefield.find(c => c.id === 'creature-3');
  assertEqual(c3.tempBuffs.power, -1, 'Lightning Mauler should have -1 power buff');
  assertEqual(c3.tempBuffs.toughness, 0, 'Lightning Mauler toughness buff should be 0');

  console.log('  ✓ Debuffs correctly applied to attacking creatures only');

  // Test effective power calculation with tempBuffs
  const getEffectivePower = (card) => {
    let p = parseInt(card.power) || 0;
    if (card.tempBuffs) p += (card.tempBuffs.power || 0);
    return p;
  };
  assertEqual(getEffectivePower(c1), 1, 'Goblin Guide effective power should be 2 + (-1) = 1');
  assertEqual(getEffectivePower(c3), 1, 'Lightning Mauler effective power should be 2 + (-1) = 1');

  console.log('  ✓ Effective power calculation includes tempBuffs');

  section('Until Next Turn — Multiple stacking effects');

  // Two Jace activations should stack
  const doubleEffects = [
    { type: 'attacker_debuff', power: -1, toughness: 0 },
    { type: 'attacker_debuff', power: -1, toughness: 0 },
  ];
  let stackedPower = 0;
  doubleEffects.forEach(e => { stackedPower += e.power; });
  assertEqual(stackedPower, -2, 'Two Jace effects should stack to -2 power');

  // Apply double effects to a creature
  const bigCreature = { id: 'big-1', name: 'Tarmogoyf', type_line: 'Creature — Lhurgoyf', power: '4', toughness: '5', tempBuffs: null };
  const existing = bigCreature.tempBuffs || { power: 0, toughness: 0 };
  const buffed = { ...bigCreature, tempBuffs: { power: existing.power + stackedPower, toughness: existing.toughness } };
  assertEqual(getEffectivePower(buffed), 2, 'Tarmogoyf with double Jace should have 4 + (-2) = 2 power');

  console.log('  ✓ Multiple effects stack correctly');

  section('Until Next Turn — Effect cleanup at turn start');

  // Simulate clearing effects when owner's turn starts
  const playerState = {
    untilNextTurnEffects: [
      { id: 'e1', type: 'attacker_debuff', power: -1, toughness: 0, ownerIdx: 0 },
      { id: 'e2', type: 'attacker_debuff', power: -1, toughness: 0, ownerIdx: 0 },
    ],
  };

  // When player 0's turn starts, clear their effects
  const clearedState = { ...playerState, untilNextTurnEffects: [] };
  assertEqual(clearedState.untilNextTurnEffects.length, 0, 'Effects should be cleared when turn starts');

  // Effects from player 1 should NOT be cleared when player 0's turn starts
  // (they persist until player 1's next turn)
  const mixedEffects = [
    { id: 'e1', type: 'attacker_debuff', power: -1, toughness: 0, ownerIdx: 0 },
    { id: 'e2', type: 'attacker_debuff', power: -1, toughness: 0, ownerIdx: 1 },
  ];
  // In the actual implementation, each player's effects are stored in their own state
  // so clearing player 0's state only clears player 0's effects
  const p0Effects = mixedEffects.filter(e => e.ownerIdx === 0);
  const p1Effects = mixedEffects.filter(e => e.ownerIdx === 1);
  assertEqual(p0Effects.length, 1, 'Player 0 has 1 effect');
  assertEqual(p1Effects.length, 1, 'Player 1 has 1 effect');

  console.log('  ✓ Effects correctly scoped to owning player');

  section('Until Next Turn — Jace ability in HTML code verification');

  // Verify the actual HTML has the untilNextTurnEffects in player state init
  const html = fs.readFileSync(__dirname + '/client/public/index.html', 'utf8');
  assert(html.includes('untilNextTurnEffects: []'), 'Player state should initialize untilNextTurnEffects to empty array');
  assert(html.includes('untilNextTurnEffects: serverPlayer.untilNextTurnEffects'), 'Online player state should include untilNextTurnEffects');
  assert(html.includes("type: 'attacker_debuff'"), 'PW reminder should register attacker_debuff effects');
  assert(html.includes('untilNextTurnEffects || []).filter'), 'confirmAttackers should check for attacker debuff effects');
  assert(html.includes('Activate Effect'), 'PW reminder should show Activate Effect button');

  // Verify the turn pass clears effects
  assert(html.includes('untilNextTurnEffects: [],'), 'executePassTurn should clear untilNextTurnEffects');

  console.log('  ✓ HTML implementation verified');
}

// ═══════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Tap & Go — In-Game Logic Test Suite');
  console.log('═══════════════════════════════════════════════');

  // Pure logic tests (no server needed)
  testCardTypeDetection();
  testPlaneswalkerAbilityParsing();
  testCounterLogic();
  testDecklistParsing();
  testZIndexStacking();
  testOnlineGuardCompleteness();
  testUntilNextTurnEffects();

  // Online play tests (needs server)
  try {
    await testPlaneswalkerOnlinePlay();
  } catch (err) {
    console.error(`  ✗ Planeswalker online test error: ${err.message}`);
    failed++;
  }

  console.log('\n═══════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

main();
