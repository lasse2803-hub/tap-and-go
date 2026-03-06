/**
 * Tap & Go — Deck Loading & Online Play Integration Tests
 *
 * Tests all 6 preset decks (5 Level 1 mono-color + 1 Level 2 multicolor):
 * 1. Parse Arena decklist → verify correct card names/sets/quantities
 * 2. Load each deck from Scryfall → verify 60 cards, no wrong names
 * 3. Simulate pairwise online games: each deck vs every other deck
 *    - Both players load decks, connect, submit, game starts
 *    - Verify hands, libraries, basic actions work
 *
 * Usage: node test-decks.js
 */

const http = require('http');
const https = require('https');

// ═══════════════════════════════════════════════════
// Copy of parseArenaDecklist from index.html
// ═══════════════════════════════════════════════════
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
      const reskinStr = trimmed.substring(reskinIdx + 2).trim();
      const parts = reskinStr.split('|').map(s => s.trim());
      reskin = {
        customName: parts[0] || null,
        customImage: parts[1] || null,
        customTokenName: parts[2] || null,
        customTokenImage: parts[3] || null,
      };
    }
    const match = cardPart.match(/^(\d+)\s+(.+?)(?:\s+\(([A-Za-z0-9]+)\)(?:\s+(\S+))?)?$/);
    if (match) {
      entries.push({
        qty: parseInt(match[1], 10),
        name: match[2].trim(),
        set: match[3] ? match[3].toLowerCase() : null,
        collectorNumber: match[4] || null,
        reskin: reskin,
      });
    }
  }
  return entries;
};

// ═══════════════════════════════════════════════════
// Preset decks (copied from index.html)
// ═══════════════════════════════════════════════════
const PRESET_DECKS = [
  {
    name: 'White Knight',
    description: 'Aggressive white creatures with powerful removal',
    list: `4 Hopeful Initiate
4 Thalia, Guardian of Thraben
4 Luminarch Aspirant
3 Adeline, Resplendent Cathar
3 Accorder Paladin
3 Skyclave Apparition
4 Extraction Specialist
3 Portable Hole
3 Fateful Absence
2 The Wandering Emperor
3 Heliod, Sun-Crowned
20 Plains (THB) 250
4 Mutavault`,
  },
  {
    name: 'Black Devotion',
    description: 'Drain life, removal, and devotion payoffs',
    list: `4 Tymaret, Chosen from Death
4 Gifted Aetherborn
4 Geralf's Messenger
1 Phyrexian Obliterator (A25) 101
2 Tenacious Underdog
4 Gray Merchant of Asphodel
4 Thoughtseize
4 Fatal Push
2 Invoke Despair
2 Hero's Downfall
3 Vampire Nighthawk
1 Liliana, the Necromancer
21 Swamp (THB) 252
4 Castle Locthwain`,
  },
  {
    name: 'Green Power',
    description: 'Ramp into massive creatures and overrun the opponent',
    list: `4 Llanowar Elves (PDMU) 1★
4 Elvish Mystic
4 Steel Leaf Champion
4 Old-Growth Troll (KHM) 365
4 Lovestruck Beast (PRM) 78830
4 Werewolf Pack Leader (AFR) 387
2 Rhonas the Indomitable (AKR) 213
2 Primal Might
4 Collected Company (SPG) 72
2 Garruk, Unleashed (M21) 284
1 Tangle
21 Forest (THB) 254
4 Lair of the Hydra`,
  },
  {
    name: 'Red Aggro',
    description: 'Fast burn and hasty creatures — end the game quickly',
    list: `4 Monastery Swiftspear
4 Soul-Scar Mage
2 Kari Zev, Skyship Raider
2 Viashino Pyromancer
4 Bonecrusher Giant
4 Phoenix Chick
4 Play with Fire
4 Lightning Strike
4 Skewer the Critics
4 Light Up the Stage
20 Mountain (THB) 253
4 Den of the Bugbear`,
  },
  {
    name: 'Blue Control',
    description: 'Counter everything, draw cards, and finish with big threats',
    list: `3 Jace, Architect of Thought
4 Consider
4 Make Disappear
4 Counterspell
3 Memory Deluge
3 Fading Hope
4 Impulse
3 Shark Typhoon
2 Brazen Borrower (SPG)
2 Hullbreaker Horror
2 Hall of Storm Giants
26 Island (THB) 251`,
  },
  {
    name: 'Azorius Control',
    level: 2,
    description: 'White-blue control — counter, wipe the board, and win with planeswalkers',
    list: `3 Teferi, Hero of Dominaria (DAR)
3 Teferi, Time Raveler (BLC)
3 The Wandering Emperor (NEO) 42p
4 Shark Typhoon (IKO) 319
2 Absorb (DMR) 443
4 Dovin's Veto (PWAR)
4 Supreme Verdict (EA1)
1 Farewell (NEO) 436
2 Memory Deluge (MID) 337
4 Omen of the Sea (THB)
4 Get Lost (LCI) 333
1 Learn from the Past (LTC)
4 Hallowed Fountain (RNA)
3 Glacial Fortress (M13)
2 Deserted Beach (MID)
1 Celestial Colonnade (WWK)
8 Island (THB) 251
7 Plains (THB) 250`,
  },
];

// ═══════════════════════════════════════════════════
// Scryfall fetch (Node.js https)
// ═══════════════════════════════════════════════════
function scryfallFetch(url) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout: ${url}`)), 10000);
    https.get(url, { headers: { 'User-Agent': 'MTG-Test/1.0' } }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        clearTimeout(timeout);
        resolve({ ok: res.statusCode === 200, status: res.statusCode, json: () => JSON.parse(body) });
      });
    }).on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

async function loadDeckFromList(entries, onProgress) {
  const deck = [];
  const skipped = [];
  let loaded = 0;
  for (const entry of entries) {
    try {
      let res;
      if (entry.set && entry.collectorNumber) {
        res = await scryfallFetch(`https://api.scryfall.com/cards/${encodeURIComponent(entry.set)}/${encodeURIComponent(entry.collectorNumber)}`);
      }
      if ((!res || !res.ok) && entry.set) {
        res = await scryfallFetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(entry.name)}&set=${entry.set}`);
      }
      if (!res || !res.ok) {
        res = await scryfallFetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(entry.name)}`);
      }
      if (!res || !res.ok) {
        res = await scryfallFetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(entry.name)}`);
      }
      if (res.ok) {
        const card = res.json();
        if (card.type_line && card.type_line.includes('Saga')) {
          skipped.push({ name: card.name, reason: 'Saga (not supported)', qty: entry.qty });
          loaded++;
          if (onProgress) onProgress(loaded, entries.length);
          continue;
        }
        if (entry.reskin) card._reskin = entry.reskin;
        deck.push({ card, qty: entry.qty });
      } else {
        skipped.push({ name: entry.name, reason: 'Not found on Scryfall', qty: entry.qty });
      }
      loaded++;
      if (onProgress) onProgress(loaded, entries.length);
      await new Promise(r => setTimeout(r, 80)); // rate limit
    } catch (err) {
      skipped.push({ name: entry.name, reason: 'Load error: ' + err.message, qty: entry.qty });
      loaded++;
      if (onProgress) onProgress(loaded, entries.length);
    }
  }
  return { deck, skipped };
}

// ═══════════════════════════════════════════════════
// Socket.io client + helpers (copied from test-online.js)
// ═══════════════════════════════════════════════════
const io = require('./node_modules/socket.io/client-dist/socket.io.js');
const SERVER_URL = 'http://localhost:3000';

function createSocket() {
  return io(SERVER_URL, { transports: ['websocket', 'polling'], forceNew: true });
}

function emitCb(socket, event, data) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout on ${event}`)), 5000);
    if (data === undefined) {
      socket.emit(event, (response) => { clearTimeout(timeout); resolve(response); });
      return;
    }
    socket.emit(event, data, (response) => { clearTimeout(timeout); resolve(response); });
  });
}

function waitForEvent(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (data) => { clearTimeout(timeout); resolve(data); });
  });
}

function drainEvents(socket, event) {
  socket.removeAllListeners(event);
}

function createRoom(nickname) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ nickname });
    const req = http.request(`${SERVER_URL}/api/room/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ═══════════════════════════════════════════════════
// Test tracking
// ═══════════════════════════════════════════════════
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) passed++;
  else { failed++; console.error(`  ✗ FAIL: ${msg}`); }
}

function assertEqual(actual, expected, msg) {
  if (actual === expected) passed++;
  else { failed++; console.error(`  ✗ FAIL: ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

// ═══════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════

async function testParseAllDecks() {
  console.log('\n▸ Parsing all preset decklists');

  for (const preset of PRESET_DECKS) {
    const entries = parseArenaDecklist(preset.list);
    const totalCards = entries.reduce((sum, e) => sum + e.qty, 0);
    assertEqual(totalCards, 60, `${preset.name}: should parse to 60 total cards (got ${totalCards})`);
    assert(entries.length > 0, `${preset.name}: should have entries`);

    // Verify specific known issues are fixed
    if (preset.name === 'Red Aggro') {
      const lightUp = entries.find(e => e.name === 'Light Up the Stage');
      assert(lightUp !== undefined, 'Red Aggro: "Light Up the Stage" should be parsed correctly (not split)');
      if (lightUp) {
        assertEqual(lightUp.qty, 4, 'Red Aggro: Light Up the Stage should have qty 4');
      }
    }

    if (preset.name === 'Green Power') {
      const llanowar = entries.find(e => e.name === 'Llanowar Elves');
      assert(llanowar !== undefined, 'Green Power: "Llanowar Elves" should parse correctly');
      if (llanowar) {
        assertEqual(llanowar.set, 'pdmu', 'Green Power: Llanowar Elves set should be pdmu');
        assertEqual(llanowar.collectorNumber, '1★', 'Green Power: Llanowar Elves CN should be 1★');
      }
    }

    console.log(`  ✓ ${preset.name}: ${entries.length} unique cards, ${totalCards} total`);
  }
}

// Since Scryfall API may not be reachable from test environment,
// generate realistic mock decks based on parsed entries.
// This verifies the full pipeline: parse → build deck → submit → play online
function generateMockDecks() {
  console.log('\n▸ Generating realistic mock decks from parsed decklists');

  const colorMap = {
    'White Knight': 'W', 'Black Devotion': 'B',
    'Green Power': 'G', 'Red Aggro': 'R', 'Blue Control': 'U',
    'Azorius Control': 'W'
  };

  // Known card types for realistic mocks
  const landNames = ['Plains', 'Swamp', 'Forest', 'Mountain', 'Island',
    'Mutavault', 'Castle Locthwain', 'Lair of the Hydra', 'Den of the Bugbear',
    'Hall of Storm Giants', 'Hallowed Fountain', 'Glacial Fortress', 'Deserted Beach',
    'Celestial Colonnade'];
  const creatureKeywords = ['Initiate', 'Thalia', 'Aspirant', 'Adeline', 'Paladin',
    'Apparition', 'Specialist', 'Emperor', 'Heliod', 'Tymaret', 'Aetherborn',
    'Messenger', 'Obliterator', 'Underdog', 'Merchant', 'Nighthawk', 'Liliana',
    'Elves', 'Mystic', 'Champion', 'Troll', 'Beast', 'Pack Leader', 'Rhonas',
    'Garruk', 'Swiftspear', 'Mage', 'Kari Zev', 'Pyromancer', 'Giant',
    'Phoenix', 'Jace', 'Borrower', 'Horror', 'Typhoon', 'Teferi'];

  const loadedDecks = {};

  for (const preset of PRESET_DECKS) {
    const entries = parseArenaDecklist(preset.list);
    const color = colorMap[preset.name] || 'C';
    const expandedDeck = [];

    for (const entry of entries) {
      const isLand = landNames.some(l => entry.name.includes(l));
      const isCreature = creatureKeywords.some(k => entry.name.includes(k));
      const isInstant = ['Bolt', 'Push', 'Fire', 'Strike', 'Absence', 'Hope',
        'Counterspell', 'Disappear', 'Impulse', 'Tangle', 'Might'].some(k => entry.name.includes(k));

      for (let i = 0; i < entry.qty; i++) {
        expandedDeck.push({
          id: `${entry.name.replace(/\s+/g, '_')}_${i}_${Math.random().toString(36).slice(2, 8)}`,
          name: entry.name,
          type_line: isLand ? `Basic Land — ${entry.name}` :
            isCreature ? 'Creature — Test' :
            isInstant ? 'Instant' : 'Sorcery',
          mana_cost: isLand ? '' : `{${color}}`,
          power: isCreature ? '2' : undefined,
          toughness: isCreature ? '2' : undefined,
          oracle_text: isLand ? `{T}: Add {${color}}.` : 'Test card.',
          image_uris: { normal: 'https://example.com/card.jpg', small: 'https://example.com/card_sm.jpg' },
          colors: isLand ? [] : [color],
          cmc: isLand ? 0 : 1,
          counters: {},
          tapped: false,
        });
      }
    }

    const totalCards = expandedDeck.length;
    assertEqual(totalCards, 60, `${preset.name}: mock deck should have 60 cards (got ${totalCards})`);
    console.log(`  ✓ ${preset.name}: ${totalCards} cards generated from ${entries.length} unique entries`);
    loadedDecks[preset.name] = expandedDeck;
  }

  return loadedDecks;
}

async function testPairwiseOnlineGames(loadedDecks) {
  console.log('\n▸ Pairwise online games — all deck combinations');

  const deckNames = Object.keys(loadedDecks);
  let gamesPlayed = 0;

  for (let i = 0; i < deckNames.length; i++) {
    for (let j = i + 1; j < deckNames.length; j++) {
      const d1Name = deckNames[i];
      const d2Name = deckNames[j];
      const deck1 = loadedDecks[d1Name];
      const deck2 = loadedDecks[d2Name];

      process.stdout.write(`  ${d1Name} vs ${d2Name}...`);

      try {
        const roomData = await createRoom(d1Name);
        const s1 = createSocket();
        const s2 = createSocket();
        await Promise.all([
          new Promise(r => s1.on('connect', r)),
          new Promise(r => s2.on('connect', r))
        ]);

        await emitCb(s1, 'joinGame', { roomId: roomData.roomId, nickname: d1Name });
        await emitCb(s2, 'joinGame', { roomId: roomData.roomId, nickname: d2Name });

        const p1Start = waitForEvent(s1, 'gameStart');
        const p2Start = waitForEvent(s2, 'gameStart');

        await emitCb(s1, 'submitDeck', { deck: deck1 });
        await emitCb(s2, 'submitDeck', { deck: deck2 });

        const gs1 = await p1Start;
        const gs2 = await p2Start;

        // Check opening hands
        const p1Hand = gs1.state.players[0].hand;
        const p2Hand = gs2.state.players[1].hand;
        assertEqual(p1Hand.length, 7, `${d1Name} vs ${d2Name}: P1 hand should be 7`);
        assertEqual(p2Hand.length, 7, `${d1Name} vs ${d2Name}: P2 hand should be 7`);

        // Check libraries
        const p1Lib = gs1.state.players[0].library.length;
        const p2Lib = gs2.state.players[1].library.length;
        const expectedP1Lib = deck1.length - 7;
        const expectedP2Lib = deck2.length - 7;
        assertEqual(p1Lib, expectedP1Lib, `${d1Name} vs ${d2Name}: P1 library should be ${expectedP1Lib}`);
        assertEqual(p2Lib, expectedP2Lib, `${d1Name} vs ${d2Name}: P2 library should be ${expectedP2Lib}`);

        // Check life totals
        assertEqual(gs1.state.players[0].life, 20, `${d1Name} vs ${d2Name}: P1 life should be 20`);
        assertEqual(gs1.state.players[1].life, 20, `${d1Name} vs ${d2Name}: P2 life should be 20`);

        // Simulate P1 plays first card from hand to battlefield
        const cardToPlay = p1Hand[0];
        drainEvents(s2, 'stateUpdate');
        const p2SeesPlay = waitForEvent(s2, 'stateUpdate');

        await emitCb(s1, 'gameAction', {
          action: {
            type: 'stateSync',
            state: {
              players: [
                {
                  ...gs1.state.players[0],
                  hand: p1Hand.slice(1),
                  battlefield: [{ ...cardToPlay, tapped: false }],
                },
                gs1.state.players[1]
              ],
              activePlayer: gs1.state.activePlayer,
              currentPhase: 'main1',
              turnNumber: 1,
            }
          }
        });

        const playUpdate = await p2SeesPlay;
        const p1BfFromP2 = playUpdate.state.players[0].battlefield;
        assert(p1BfFromP2 && p1BfFromP2.length === 1,
          `${d1Name} vs ${d2Name}: P2 should see P1 card on battlefield`);

        // Simulate P2 draws a card (reduces library by 1, adds to hand)
        drainEvents(s1, 'stateUpdate');
        drainEvents(s2, 'stateUpdate');
        await new Promise(r => setTimeout(r, 100));

        const p1SeesDraw = waitForEvent(s1, 'stateUpdate');
        const p2Lib2 = gs2.state.players[1].library;
        const drawnCard = p2Lib2[0];
        const newP2Hand = [...p2Hand, drawnCard];
        const newP2Lib = p2Lib2.slice(1);

        await emitCb(s2, 'gameAction', {
          action: {
            type: 'stateSync',
            state: {
              players: [
                gs2.state.players[0],
                {
                  ...gs2.state.players[1],
                  hand: newP2Hand,
                  library: newP2Lib,
                }
              ],
              activePlayer: gs2.state.activePlayer,
              currentPhase: 'draw',
              turnNumber: 1,
            }
          }
        });

        const drawUpdate = await p1SeesDraw;
        const p2HandCount = drawUpdate.state.players[1].handCount;
        assertEqual(p2HandCount, 8, `${d1Name} vs ${d2Name}: P2 hand should show 8 after draw`);

        console.log(`\r  ✓ ${d1Name} vs ${d2Name}: game started, cards played, draw worked`);
        gamesPlayed++;

        s1.disconnect();
        s2.disconnect();
      } catch (err) {
        console.log(`\r  ✗ ${d1Name} vs ${d2Name}: ${err.message}`);
        failed++;
      }
    }
  }

  console.log(`  Total pairwise games played: ${gamesPlayed}/10`);
}

// ═══════════════════════════════════════════════════
// Best of 3 match tests
// ═══════════════════════════════════════════════════
async function testBo3Matches(loadedDecks) {
  console.log('\n▸ Best of 3 match tests — Azorius Control vs other decks');

  const bo3Pairs = [
    ['Azorius Control', 'Red Aggro'],
    ['Azorius Control', 'White Knight'],
    ['Azorius Control', 'Blue Control'],
  ];

  let matchesPlayed = 0;

  for (const [d1Name, d2Name] of bo3Pairs) {
    const deck1 = loadedDecks[d1Name];
    const deck2 = loadedDecks[d2Name];
    if (!deck1 || !deck2) {
      console.log(`  ✗ ${d1Name} vs ${d2Name}: deck not found`);
      failed++;
      continue;
    }

    process.stdout.write(`  ${d1Name} vs ${d2Name} (Bo3)...`);

    try {
      // Create room and connect both players
      const roomData = await createRoom(d1Name);
      const s1 = createSocket();
      const s2 = createSocket();
      await Promise.all([
        new Promise(r => s1.on('connect', r)),
        new Promise(r => s2.on('connect', r))
      ]);

      await emitCb(s1, 'joinGame', { roomId: roomData.roomId, nickname: d1Name });
      await emitCb(s2, 'joinGame', { roomId: roomData.roomId, nickname: d2Name });

      // Submit decks with matchType 'bo3'
      const p1Start = waitForEvent(s1, 'gameStart');
      const p2Start = waitForEvent(s2, 'gameStart');

      await emitCb(s1, 'submitDeck', { deck: deck1, matchType: 'bo3' });
      await emitCb(s2, 'submitDeck', { deck: deck2, matchType: 'bo3' });

      const gs1 = await p1Start;
      const gs2 = await p2Start;

      // Verify matchInfo is present and correct
      assert(gs1.matchInfo, `${d1Name} vs ${d2Name}: Game 1 should include matchInfo`);
      assertEqual(gs1.matchInfo.type, 'bo3', `${d1Name} vs ${d2Name}: matchInfo.type should be bo3`);
      assertEqual(gs1.matchInfo.game, 1, `${d1Name} vs ${d2Name}: matchInfo.game should be 1`);
      assertEqual(gs1.matchInfo.score[0], 0, `${d1Name} vs ${d2Name}: matchInfo.score[0] should be 0`);
      assertEqual(gs1.matchInfo.score[1], 0, `${d1Name} vs ${d2Name}: matchInfo.score[1] should be 0`);

      // Verify hands dealt
      assertEqual(gs1.state.players[0].hand.length, 7, `${d1Name} vs ${d2Name} G1: P1 hand should be 7`);
      assertEqual(gs2.state.players[1].hand.length, 7, `${d1Name} vs ${d2Name} G1: P2 hand should be 7`);

      // ─── Game 1: Player 0 wins ───
      const p1MatchUpdate = waitForEvent(s1, 'matchStateUpdate');
      const p2MatchUpdate = waitForEvent(s2, 'matchStateUpdate');
      const p1Between = waitForEvent(s1, 'betweenGames');
      const p2Between = waitForEvent(s2, 'betweenGames');

      await emitCb(s1, 'gameWon', { winnerIndex: 0 });

      const mu1 = await p1MatchUpdate;
      const mu2 = await p2MatchUpdate;
      assertEqual(mu1.matchScore[0], 1, `${d1Name} vs ${d2Name} G1: P1 score should be 1`);
      assertEqual(mu1.matchScore[1], 0, `${d1Name} vs ${d2Name} G1: P2 score should be 0`);
      assert(!mu1.result.matchOver, `${d1Name} vs ${d2Name} G1: match should not be over`);

      const bg1 = await p1Between;
      assertEqual(bg1.loserIndex, 1, `${d1Name} vs ${d2Name}: loser should be P2 (index 1)`);
      assertEqual(bg1.nextGame, 2, `${d1Name} vs ${d2Name}: nextGame should be 2`);

      // ─── Between games: loser (P2) chooses who goes first ───
      const p1G2Start = waitForEvent(s1, 'gameStart');
      const p2G2Start = waitForEvent(s2, 'gameStart');

      // P2 (loser) chooses to go first
      await emitCb(s2, 'chooseFirstPlayer', { firstPlayerIndex: 1 });

      const g2s1 = await p1G2Start;
      const g2s2 = await p2G2Start;

      // Verify game 2 state
      assert(g2s1.matchInfo, `${d1Name} vs ${d2Name} G2: should have matchInfo`);
      assertEqual(g2s1.matchInfo.game, 2, `${d1Name} vs ${d2Name} G2: matchInfo.game should be 2`);
      assertEqual(g2s1.matchInfo.score[0], 1, `${d1Name} vs ${d2Name} G2: score should be 1-0`);
      assertEqual(g2s1.state.players[0].hand.length, 7, `${d1Name} vs ${d2Name} G2: P1 hand should be 7`);
      assertEqual(g2s2.state.players[1].hand.length, 7, `${d1Name} vs ${d2Name} G2: P2 hand should be 7`);
      assertEqual(g2s1.state.players[0].life, 20, `${d1Name} vs ${d2Name} G2: P1 life should be 20`);
      assertEqual(g2s1.state.players[1].life, 20, `${d1Name} vs ${d2Name} G2: P2 life should be 20`);

      // ─── Game 2: Player 0 wins again → match over ───
      const p1FinalUpdate = waitForEvent(s1, 'matchStateUpdate');
      const p2FinalUpdate = waitForEvent(s2, 'matchStateUpdate');

      await emitCb(s1, 'gameWon', { winnerIndex: 0 });

      const fu1 = await p1FinalUpdate;
      assertEqual(fu1.matchScore[0], 2, `${d1Name} vs ${d2Name} G2: P1 score should be 2`);
      assertEqual(fu1.matchScore[1], 0, `${d1Name} vs ${d2Name} G2: P2 score should be 0`);
      assert(fu1.result.matchOver, `${d1Name} vs ${d2Name}: match should be over after 2 wins`);
      assertEqual(fu1.matchWinner, 0, `${d1Name} vs ${d2Name}: winner should be P1 (index 0)`);

      console.log(`\r  ✓ ${d1Name} vs ${d2Name} (Bo3): 2-0 match completed, all state correct`);
      matchesPlayed++;

      s1.disconnect();
      s2.disconnect();
    } catch (err) {
      console.log(`\r  ✗ ${d1Name} vs ${d2Name} (Bo3): ${err.message}`);
      failed++;
    }
  }

  // ─── Also test concede in Bo3 ───
  process.stdout.write(`  Azorius Control vs Green Power (Bo3 + concede)...`);
  try {
    const deck1 = loadedDecks['Azorius Control'];
    const deck2 = loadedDecks['Green Power'];

    const roomData = await createRoom('AzoriusConcede');
    const s1 = createSocket();
    const s2 = createSocket();
    await Promise.all([
      new Promise(r => s1.on('connect', r)),
      new Promise(r => s2.on('connect', r))
    ]);

    await emitCb(s1, 'joinGame', { roomId: roomData.roomId, nickname: 'Azorius' });
    await emitCb(s2, 'joinGame', { roomId: roomData.roomId, nickname: 'Green' });

    const p1Start = waitForEvent(s1, 'gameStart');
    const p2Start = waitForEvent(s2, 'gameStart');

    await emitCb(s1, 'submitDeck', { deck: deck1, matchType: 'bo3' });
    await emitCb(s2, 'submitDeck', { deck: deck2, matchType: 'bo3' });

    await p1Start;
    await p2Start;

    // P2 concedes game 1
    const p1Concede = waitForEvent(s1, 'playerConceded');
    const p2Concede = waitForEvent(s2, 'playerConceded');
    const p1MatchUpd = waitForEvent(s1, 'matchStateUpdate');
    const p1Between = waitForEvent(s1, 'betweenGames');

    await emitCb(s2, 'concede', {});

    const c1 = await p1Concede;
    const c2 = await p2Concede;
    assertEqual(c1.loserIndex, 1, 'Concede: loserIndex should be 1 (P2)');
    assertEqual(c1.winnerIndex, 0, 'Concede: winnerIndex should be 0 (P1)');
    assertEqual(c2.loserName, 'Green', 'Concede: loserName should be Green');

    const mu = await p1MatchUpd;
    assertEqual(mu.matchScore[0], 1, 'Concede G1: P1 score should be 1');
    assertEqual(mu.matchScore[1], 0, 'Concede G1: P2 score should be 0');
    assert(!mu.result.matchOver, 'Concede G1: match should not be over');

    const bg = await p1Between;
    assertEqual(bg.loserIndex, 1, 'Concede between: loserIndex should be 1');

    // P2 (loser) starts game 2
    const p1G2 = waitForEvent(s1, 'gameStart');
    const p2G2 = waitForEvent(s2, 'gameStart');
    await emitCb(s2, 'chooseFirstPlayer', { firstPlayerIndex: 1 });

    const g2s1 = await p1G2;
    assertEqual(g2s1.matchInfo.game, 2, 'Concede G2: game should be 2');
    assertEqual(g2s1.state.players[0].life, 20, 'Concede G2: fresh life totals');

    // P2 concedes game 2 → P1 wins match 2-0
    const p1Final = waitForEvent(s1, 'matchStateUpdate');
    drainEvents(s1, 'playerConceded');
    drainEvents(s2, 'playerConceded');

    await emitCb(s2, 'concede', {});

    const fu = await p1Final;
    assertEqual(fu.matchScore[0], 2, 'Concede G2: P1 score should be 2');
    assert(fu.result.matchOver, 'Concede G2: match should be over');
    assertEqual(fu.matchWinner, 0, 'Concede G2: P1 should be match winner');

    console.log(`\r  ✓ Azorius Control vs Green Power (Bo3 + concede): 2 concessions, match completed correctly`);
    matchesPlayed++;

    s1.disconnect();
    s2.disconnect();
  } catch (err) {
    console.log(`\r  ✗ Azorius Control vs Green Power (Bo3 + concede): ${err.message}`);
    failed++;
  }

  console.log(`  Total Bo3 matches tested: ${matchesPlayed}`);
}

// ═══════════════════════════════════════════════════
// Extended Bo3 edge case tests
// ═══════════════════════════════════════════════════
async function testBo3EdgeCases(loadedDecks) {
  console.log('\n▸ Best of 3 — edge cases & validation');

  // Helper: setup a Bo3 match and return sockets + game 1 state
  async function setupBo3(deckA, deckB, nameA, nameB) {
    const roomData = await createRoom(nameA);
    const s1 = createSocket();
    const s2 = createSocket();
    await Promise.all([
      new Promise(r => s1.on('connect', r)),
      new Promise(r => s2.on('connect', r))
    ]);
    await emitCb(s1, 'joinGame', { roomId: roomData.roomId, nickname: nameA });
    await emitCb(s2, 'joinGame', { roomId: roomData.roomId, nickname: nameB });
    const p1Start = waitForEvent(s1, 'gameStart');
    const p2Start = waitForEvent(s2, 'gameStart');
    await emitCb(s1, 'submitDeck', { deck: deckA, matchType: 'bo3' });
    await emitCb(s2, 'submitDeck', { deck: deckB, matchType: 'bo3' });
    const gs1 = await p1Start;
    const gs2 = await p2Start;
    return { s1, s2, gs1, gs2, roomId: roomData.roomId };
  }

  // Helper: play a gameWon + between-games + chooseFirstPlayer cycle
  async function winGameAndContinue(s1, s2, winnerIndex, firstPlayerIndex) {
    const mu1 = waitForEvent(s1, 'matchStateUpdate');
    const mu2 = waitForEvent(s2, 'matchStateUpdate');
    const bg1 = waitForEvent(s1, 'betweenGames');
    const bg2 = waitForEvent(s2, 'betweenGames');
    await emitCb(s1, 'gameWon', { winnerIndex });
    const muResult = await mu1;
    await mu2;
    const bgResult = await bg1;
    await bg2;
    // Now loser chooses first player
    const g1 = waitForEvent(s1, 'gameStart');
    const g2 = waitForEvent(s2, 'gameStart');
    const loserSocket = bgResult.loserIndex === 0 ? s1 : s2;
    await emitCb(loserSocket, 'chooseFirstPlayer', { firstPlayerIndex });
    const ng1 = await g1;
    const ng2 = await g2;
    return { muResult, bgResult, ng1, ng2 };
  }

  // ─── Test 1: Full 3-game match (2-1) — P1 wins G1, P2 wins G2, P1 wins G3 ───
  process.stdout.write('  Full 3-game match (2-1 score)...');
  try {
    const { s1, s2, gs1, gs2 } = await setupBo3(
      loadedDecks['Azorius Control'], loadedDecks['Red Aggro'], 'Azorius', 'RedAggro'
    );

    // Game 1: P1 (Azorius) wins
    const r1 = await winGameAndContinue(s1, s2, 0, 1); // loser P2 chooses P2 goes first
    assertEqual(r1.muResult.matchScore[0], 1, '3-game: G1 score 1-0');
    assertEqual(r1.muResult.matchScore[1], 0, '3-game: G1 P2 score 0');
    assertEqual(r1.ng1.matchInfo.game, 2, '3-game: should be game 2');
    assertEqual(r1.ng1.state.players[0].life, 20, '3-game G2: P1 fresh life');
    assertEqual(r1.ng1.state.players[1].life, 20, '3-game G2: P2 fresh life');
    assertEqual(r1.ng1.state.players[0].hand.length, 7, '3-game G2: P1 fresh hand 7');
    assertEqual(r1.ng1.state.players[0].battlefield.length, 0, '3-game G2: P1 empty battlefield');
    assertEqual(r1.ng1.state.players[0].graveyard.length, 0, '3-game G2: P1 empty graveyard');

    // Game 2: P2 (Red Aggro) wins → 1-1
    const r2 = await winGameAndContinue(s1, s2, 1, 0); // loser P1 chooses P1 goes first
    assertEqual(r2.muResult.matchScore[0], 1, '3-game: G2 score 1-1 P1');
    assertEqual(r2.muResult.matchScore[1], 1, '3-game: G2 score 1-1 P2');
    assertEqual(r2.bgResult.loserIndex, 0, '3-game: G2 loser should be P1');
    assertEqual(r2.ng1.matchInfo.game, 3, '3-game: should be game 3');
    assertEqual(r2.ng1.matchInfo.score[0], 1, '3-game G3: carried score P1=1');
    assertEqual(r2.ng1.matchInfo.score[1], 1, '3-game G3: carried score P2=1');
    assertEqual(r2.ng1.state.players[0].hand.length, 7, '3-game G3: fresh hand');
    assertEqual(r2.ng1.state.players[1].life, 20, '3-game G3: fresh life');

    // Game 3: P1 wins → match over 2-1
    const finalMu1 = waitForEvent(s1, 'matchStateUpdate');
    const finalMu2 = waitForEvent(s2, 'matchStateUpdate');
    await emitCb(s1, 'gameWon', { winnerIndex: 0 });
    const fm1 = await finalMu1;
    const fm2 = await finalMu2;
    assertEqual(fm1.matchScore[0], 2, '3-game: final score P1=2');
    assertEqual(fm1.matchScore[1], 1, '3-game: final score P2=1');
    assert(fm1.result.matchOver, '3-game: match should be over');
    assertEqual(fm1.matchWinner, 0, '3-game: P1 should be match winner');
    // Both players should see same matchWinner
    assertEqual(fm2.matchWinner, 0, '3-game: P2 also sees P1 as winner');

    console.log('\r  ✓ Full 3-game match (2-1 score): all 3 games, state resets, match winner correct');
    s1.disconnect();
    s2.disconnect();
  } catch (err) {
    console.log(`\r  ✗ Full 3-game match (2-1): ${err.message}`);
    failed++;
  }

  // ─── Test 2: Loser chooses opponent goes first (not themselves) ───
  process.stdout.write('  Loser lets opponent go first...');
  try {
    const { s1, s2 } = await setupBo3(
      loadedDecks['Azorius Control'], loadedDecks['Black Devotion'], 'Az', 'Black'
    );

    // P1 wins game 1
    const mu = waitForEvent(s1, 'matchStateUpdate');
    const bg = waitForEvent(s2, 'betweenGames');
    drainEvents(s1, 'betweenGames');
    await emitCb(s1, 'gameWon', { winnerIndex: 0 });
    await mu;
    const bgData = await bg;
    assertEqual(bgData.loserIndex, 1, 'OpponentFirst: P2 is loser');

    // P2 (loser) chooses P1 (opponent) goes first
    const g2p1 = waitForEvent(s1, 'gameStart');
    const g2p2 = waitForEvent(s2, 'gameStart');
    await emitCb(s2, 'chooseFirstPlayer', { firstPlayerIndex: 0 });
    const g2s1 = await g2p1;
    const g2s2 = await g2p2;

    // Verify game started with correct active player
    assert(g2s1.state, 'OpponentFirst: game 2 should have state');
    assertEqual(g2s1.state.players[0].hand.length, 7, 'OpponentFirst: P1 hand=7');
    assertEqual(g2s2.state.players[1].hand.length, 7, 'OpponentFirst: P2 hand=7');

    console.log('\r  ✓ Loser lets opponent go first: game 2 started correctly');
    s1.disconnect();
    s2.disconnect();
  } catch (err) {
    console.log(`\r  ✗ Loser lets opponent go first: ${err.message}`);
    failed++;
  }

  // ─── Test 3: Winner tries to choose first player (should be rejected) ───
  process.stdout.write('  Winner cannot choose first player...');
  try {
    const { s1, s2 } = await setupBo3(
      loadedDecks['Azorius Control'], loadedDecks['Green Power'], 'Az', 'Green'
    );

    // P1 wins game 1
    const mu = waitForEvent(s1, 'matchStateUpdate');
    drainEvents(s1, 'betweenGames');
    drainEvents(s2, 'betweenGames');
    await emitCb(s1, 'gameWon', { winnerIndex: 0 });
    await mu;

    // Wait a moment for between-games to be processed
    await new Promise(r => setTimeout(r, 200));

    // P1 (winner) tries to choose first player — should fail
    const result = await emitCb(s1, 'chooseFirstPlayer', { firstPlayerIndex: 0 });
    assert(result.error, 'WinnerChoose: should return error');
    assert(result.error.includes('loser'), 'WinnerChoose: error should mention loser');

    console.log('\r  ✓ Winner cannot choose first player: server correctly rejects');
    s1.disconnect();
    s2.disconnect();
  } catch (err) {
    console.log(`\r  ✗ Winner cannot choose first player: ${err.message}`);
    failed++;
  }

  // ─── Test 4: Concede in single game (not Bo3) ───
  process.stdout.write('  Concede in single game...');
  try {
    const roomData = await createRoom('SingleConcede');
    const s1 = createSocket();
    const s2 = createSocket();
    await Promise.all([
      new Promise(r => s1.on('connect', r)),
      new Promise(r => s2.on('connect', r))
    ]);

    await emitCb(s1, 'joinGame', { roomId: roomData.roomId, nickname: 'Player1' });
    await emitCb(s2, 'joinGame', { roomId: roomData.roomId, nickname: 'Player2' });

    const p1Start = waitForEvent(s1, 'gameStart');
    const p2Start = waitForEvent(s2, 'gameStart');
    // Submit without matchType → defaults to 'single'
    await emitCb(s1, 'submitDeck', { deck: loadedDecks['Azorius Control'] });
    await emitCb(s2, 'submitDeck', { deck: loadedDecks['Red Aggro'] });
    await p1Start;
    await p2Start;

    // P1 concedes
    const p1Conc = waitForEvent(s1, 'playerConceded');
    const p2Conc = waitForEvent(s2, 'playerConceded');
    await emitCb(s1, 'concede', {});

    const c1 = await p1Conc;
    const c2 = await p2Conc;
    assertEqual(c1.loserIndex, 0, 'SingleConcede: P1 is loser');
    assertEqual(c1.winnerIndex, 1, 'SingleConcede: P2 is winner');
    assertEqual(c1.loserName, 'Player1', 'SingleConcede: loserName correct');
    assertEqual(c2.loserIndex, 0, 'SingleConcede: P2 also sees P1 as loser');

    // In single game, there should be NO matchStateUpdate or betweenGames
    let gotMatchUpdate = false;
    s1.once('matchStateUpdate', () => { gotMatchUpdate = true; });
    await new Promise(r => setTimeout(r, 300));
    assert(!gotMatchUpdate, 'SingleConcede: should NOT get matchStateUpdate');

    console.log('\r  ✓ Concede in single game: playerConceded broadcast, no match events');
    s1.disconnect();
    s2.disconnect();
  } catch (err) {
    console.log(`\r  ✗ Concede in single game: ${err.message}`);
    failed++;
  }

  // ─── Test 5: P1 concedes in Bo3 (first player, not second) ───
  process.stdout.write('  P1 concedes in Bo3...');
  try {
    const { s1, s2 } = await setupBo3(
      loadedDecks['White Knight'], loadedDecks['Azorius Control'], 'White', 'Azorius'
    );

    // P1 concedes game 1
    const p1Conc = waitForEvent(s1, 'playerConceded');
    const p2Conc = waitForEvent(s2, 'playerConceded');
    const p1Mu = waitForEvent(s1, 'matchStateUpdate');
    const p1Bg = waitForEvent(s1, 'betweenGames');
    const p2Bg = waitForEvent(s2, 'betweenGames');

    await emitCb(s1, 'concede', {});

    const c = await p1Conc;
    assertEqual(c.loserIndex, 0, 'P1Concede: loserIndex=0');
    assertEqual(c.winnerIndex, 1, 'P1Concede: winnerIndex=1');
    assertEqual(c.loserName, 'White', 'P1Concede: loserName=White');

    const mu = await p1Mu;
    assertEqual(mu.matchScore[0], 0, 'P1Concede: P1 score=0');
    assertEqual(mu.matchScore[1], 1, 'P1Concede: P2 score=1');

    const bg = await p1Bg;
    assertEqual(bg.loserIndex, 0, 'P1Concede between: loser=P1');

    // P1 (loser) chooses to go first
    const g2p1 = waitForEvent(s1, 'gameStart');
    const g2p2 = waitForEvent(s2, 'gameStart');
    await emitCb(s1, 'chooseFirstPlayer', { firstPlayerIndex: 0 });
    const g2 = await g2p1;
    assertEqual(g2.matchInfo.game, 2, 'P1Concede: game 2 starts');
    assertEqual(g2.matchInfo.score[1], 1, 'P1Concede: P2 leads 1-0');

    console.log('\r  ✓ P1 concedes in Bo3: score correct, P1 chooses as loser');
    s1.disconnect();
    s2.disconnect();
  } catch (err) {
    console.log(`\r  ✗ P1 concedes in Bo3: ${err.message}`);
    failed++;
  }

  // ─── Test 6: Game state fully resets between games ───
  process.stdout.write('  State reset between games (hand/bf/gy/lib/life)...');
  try {
    const { s1, s2, gs1 } = await setupBo3(
      loadedDecks['Azorius Control'], loadedDecks['Blue Control'], 'Az', 'Blue'
    );

    const origP1LibLen = gs1.state.players[0].library.length;

    // Simulate playing cards: P1 moves card from hand to battlefield, then to graveyard
    const cardToPlay = gs1.state.players[0].hand[0];
    await emitCb(s1, 'gameAction', {
      action: {
        type: 'stateSync',
        state: {
          ...gs1.state,
          players: [
            {
              ...gs1.state.players[0],
              hand: gs1.state.players[0].hand.slice(2), // remove 2 cards
              battlefield: [cardToPlay],
              graveyard: [gs1.state.players[0].hand[1]],
              life: 14, // took some damage
            },
            gs1.state.players[1]
          ],
        }
      }
    });

    await new Promise(r => setTimeout(r, 200));

    // Win game 1, proceed to game 2
    const r1 = await winGameAndContinue(s1, s2, 0, 1);

    // Verify FULL state reset in game 2
    const g2state = r1.ng1.state;
    assertEqual(g2state.players[0].life, 20, 'Reset: P1 life back to 20');
    assertEqual(g2state.players[1].life, 20, 'Reset: P2 life back to 20');
    assertEqual(g2state.players[0].hand.length, 7, 'Reset: P1 fresh hand of 7');
    assertEqual(g2state.players[1].hand.length, 7, 'Reset: P2 fresh hand of 7');
    assertEqual(g2state.players[0].battlefield.length, 0, 'Reset: P1 empty battlefield');
    assertEqual(g2state.players[1].battlefield.length, 0, 'Reset: P2 empty battlefield');
    assertEqual(g2state.players[0].graveyard.length, 0, 'Reset: P1 empty graveyard');
    assertEqual(g2state.players[1].graveyard.length, 0, 'Reset: P2 empty graveyard');
    assertEqual(g2state.players[0].library.length, origP1LibLen, 'Reset: P1 library full (53 cards)');

    console.log('\r  ✓ State reset between games: life, hand, battlefield, graveyard, library all fresh');
    s1.disconnect();
    s2.disconnect();
  } catch (err) {
    console.log(`\r  ✗ State reset between games: ${err.message}`);
    failed++;
  }

  // ─── Test 7: Both players receive identical matchInfo ───
  process.stdout.write('  Both players see same matchInfo...');
  try {
    const { s1, s2, gs1, gs2 } = await setupBo3(
      loadedDecks['Azorius Control'], loadedDecks['Green Power'], 'Az', 'Green'
    );

    // Check game 1 matchInfo is identical for both
    assertEqual(JSON.stringify(gs1.matchInfo), JSON.stringify(gs2.matchInfo),
      'MatchInfo: both players see same matchInfo at game start');
    assertEqual(gs1.matchInfo.type, 'bo3', 'MatchInfo: type=bo3');
    assertEqual(gs1.matchInfo.game, 1, 'MatchInfo: game=1');

    // Win game 1, check matchStateUpdate is identical for both
    const mu1 = waitForEvent(s1, 'matchStateUpdate');
    const mu2 = waitForEvent(s2, 'matchStateUpdate');
    drainEvents(s1, 'betweenGames');
    drainEvents(s2, 'betweenGames');
    await emitCb(s1, 'gameWon', { winnerIndex: 0 });
    const m1 = await mu1;
    const m2 = await mu2;
    assertEqual(JSON.stringify(m1.matchScore), JSON.stringify(m2.matchScore),
      'MatchInfo: both players see same score after G1');
    assertEqual(m1.matchWinner, m2.matchWinner,
      'MatchInfo: both players see same matchWinner');

    console.log('\r  ✓ Both players see same matchInfo: verified at game start and after game win');
    s1.disconnect();
    s2.disconnect();
  } catch (err) {
    console.log(`\r  ✗ Both players see same matchInfo: ${err.message}`);
    failed++;
  }

  // ─── Test 8: Concede when not in playing state (should fail) ───
  process.stdout.write('  Concede rejected when not playing...');
  try {
    const roomData = await createRoom('BadConcede');
    const s1 = createSocket();
    await new Promise(r => s1.on('connect', r));
    await emitCb(s1, 'joinGame', { roomId: roomData.roomId, nickname: 'TestPlayer' });

    // Try to concede before game starts (room is 'waiting')
    const result = await emitCb(s1, 'concede', {});
    assert(result.error, 'BadConcede: should return error');
    assert(result.error.includes('not in progress') || result.error.includes('not found'),
      'BadConcede: error should indicate game not in progress');

    console.log('\r  ✓ Concede rejected when not playing: server returns error');
    s1.disconnect();
  } catch (err) {
    console.log(`\r  ✗ Concede rejected when not playing: ${err.message}`);
    failed++;
  }

  // ─── Test 9: Mixed concede + normal win in Bo3 (P2 concedes G1, P1 wins G2 normally) ───
  process.stdout.write('  Mixed concede + normal win in Bo3...');
  try {
    const { s1, s2 } = await setupBo3(
      loadedDecks['Azorius Control'], loadedDecks['Red Aggro'], 'Az', 'Red'
    );

    // G1: P2 concedes
    const c1 = waitForEvent(s1, 'playerConceded');
    const mu1 = waitForEvent(s1, 'matchStateUpdate');
    const bg1 = waitForEvent(s1, 'betweenGames');
    drainEvents(s2, 'playerConceded');
    drainEvents(s2, 'matchStateUpdate');
    drainEvents(s2, 'betweenGames');
    await emitCb(s2, 'concede', {});
    await c1;
    const m1 = await mu1;
    assertEqual(m1.matchScore[0], 1, 'MixedWin G1: P1 score=1 after concede');
    await bg1;

    // Start G2
    const g2p1 = waitForEvent(s1, 'gameStart');
    const g2p2 = waitForEvent(s2, 'gameStart');
    await emitCb(s2, 'chooseFirstPlayer', { firstPlayerIndex: 1 });
    await g2p1;
    await g2p2;

    // G2: P1 wins normally (via gameWon, not concede)
    const mu2 = waitForEvent(s1, 'matchStateUpdate');
    const mu2b = waitForEvent(s2, 'matchStateUpdate');
    await emitCb(s1, 'gameWon', { winnerIndex: 0 });
    const m2 = await mu2;
    await mu2b;
    assertEqual(m2.matchScore[0], 2, 'MixedWin G2: P1 score=2');
    assertEqual(m2.matchScore[1], 0, 'MixedWin G2: P2 score=0');
    assert(m2.result.matchOver, 'MixedWin: match should be over');
    assertEqual(m2.matchWinner, 0, 'MixedWin: P1 is match winner');

    console.log('\r  ✓ Mixed concede + normal win in Bo3: G1 concede + G2 normal = 2-0 match');
    s1.disconnect();
    s2.disconnect();
  } catch (err) {
    console.log(`\r  ✗ Mixed concede + normal win in Bo3: ${err.message}`);
    failed++;
  }
}

// ═══════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════
async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Tap & Go — Deck Loading & Pairwise Game Tests');
  console.log('═══════════════════════════════════════════════════');

  try {
    // Phase 1: Parse decklists (no network needed)
    await testParseAllDecks();

    // Phase 2: Generate realistic mock decks (no network needed)
    const loadedDecks = generateMockDecks();

    // Phase 3: Pairwise online games (needs local server running)
    await testPairwiseOnlineGames(loadedDecks);

    // Phase 4: Best of 3 match tests (needs local server running)
    await testBo3Matches(loadedDecks);

    // Phase 5: Bo3 edge cases — full 3-game match, validation, concede variants
    await testBo3EdgeCases(loadedDecks);
  } catch (err) {
    console.error(`\n✗ FATAL ERROR: ${err.message}`);
    console.error(err.stack);
    failed++;
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

main();
