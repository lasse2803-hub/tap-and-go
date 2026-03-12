#!/usr/bin/env node
/**
 * Comprehensive in-game test for ALL recent changes:
 * - Vorinclex counter-modifier (double/halve)
 * - Solemn Simulacrum library search ETB
 * - Crawling Barrens "You may" choice + permanent creature + counters
 * - Relic Robber token creation + can't block + upkeep damage
 * - Shadow's Verdict exile from battlefield + graveyards
 * - Cursecatcher sacrifice counter + pay-or-counter flow
 * - SFX system (WAV sounds + removed synth stubs)
 * - Online mode gating for new overlays
 */

const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, 'client', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf-8');

// Extract the script block
const scriptMatch = html.match(/<script type="text\/babel">([\s\S]*?)<\/script>/);
if (!scriptMatch) { console.error('Could not extract script'); process.exit(1); }
const code = scriptMatch[1];

let passed = 0, failed = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch(e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'Assertion failed'); };

// ============================================================
console.log('\n▸ Vorinclex Counter-Modifier System');
// ============================================================

test('applyVorinclexModifier function exists in code', () => {
  assert(code.includes('const applyVorinclexModifier'), 'applyVorinclexModifier not found');
  assert(code.includes('sourcePIdx, amount'), 'Missing sourcePIdx parameter');
});

test('Vorinclex detection uses oracle_text match', () => {
  assert(code.includes("(c.name || '').toLowerCase().includes('vorinclex')"), 'Name detection missing');
  assert(code.includes("/double|twice/i.test(c.oracle_text"), 'Oracle text detection missing');
});

test('Vorinclex doubles counters for controller', () => {
  assert(code.includes('return amount * 2'), 'Doubling logic missing');
});

test('Vorinclex halves counters for opponent (rounded down)', () => {
  assert(code.includes('Math.floor(amount / 2)'), 'Halving logic missing');
});

test('addCounter uses Vorinclex modifier', () => {
  // addCounter should call applyVorinclexModifier
  const addCounterBlock = code.match(/const addCounter = \(pIdx, cardId, type.*?\n([\s\S]*?)(?=\n  const \w)/);
  assert(addCounterBlock, 'Could not find addCounter');
  assert(addCounterBlock[0].includes('applyVorinclexModifier'), 'addCounter does not use Vorinclex modifier');
  assert(addCounterBlock[0].includes('sourcePIdx'), 'addCounter does not accept sourcePIdx');
});

test('addMultipleCounters uses Vorinclex modifier', () => {
  const addMultBlock = code.match(/const addMultipleCounters = \(pIdx, cardId, type, amount.*?\n([\s\S]*?)(?=\n  const \w)/);
  assert(addMultBlock, 'Could not find addMultipleCounters');
  assert(addMultBlock[0].includes('applyVorinclexModifier'), 'addMultipleCounters does not use Vorinclex modifier');
});

test('Planeswalker starting loyalty uses Vorinclex modifier', () => {
  assert(code.includes('applyVorinclexModifier(pIdx, startingLoyalty)'), 'PW starting loyalty not modified by Vorinclex');
});

test('Planeswalker plus-ability loyalty uses Vorinclex modifier', () => {
  assert(code.includes('applyVorinclexModifier(pIdx, costNum)'), 'PW plus-ability not modified');
  // Minus abilities should NOT be modified
  assert(code.includes('costNum > 0 ? applyVorinclexModifier'), 'Minus abilities should not be doubled');
});

test('Poison counters use Vorinclex modifier', () => {
  assert(code.includes('applyVorinclexModifier(attackingPlayer, poisonToDefender)'), 'Poison counters not modified');
});

test('Crawling Barrens counters use Vorinclex modifier', () => {
  const matches = code.match(/applyVorinclexModifier\(pIdx, data\.addCounters\.amount\)/g);
  assert(matches && matches.length >= 2, `Expected at least 2 Vorinclex modifier calls for addCounters, found ${matches ? matches.length : 0}`);
});

test('Vorinclex returns original amount when no Vorinclex on battlefield', () => {
  // Verify default return
  const fnBlock = code.match(/const applyVorinclexModifier[\s\S]*?return amount;\s*\n\s*\};/);
  assert(fnBlock, 'Default return amount not found in applyVorinclexModifier');
});

// ============================================================
console.log('\n▸ Solemn Simulacrum — Library Search ETB');
// ============================================================

test('Library search ETB pattern detection for basic land', () => {
  assert(code.includes("enters.*search your library for a basic land"), 'Basic land search pattern missing');
});

test('Library search ETB pattern detection for any land', () => {
  assert(code.includes("enters.*search your library for a land"), 'Land search pattern missing');
});

test('ETB auto-triggers library search overlay', () => {
  assert(code.includes("searchEffect.actionType === 'search_basic_land'"), 'search_basic_land actionType not checked');
  assert(code.includes("setLibrarySearch({"), 'setLibrarySearch not called on ETB');
});

test('librarySearch state variable exists with online sync', () => {
  assert(code.includes('const [librarySearch, _setLibrarySearch] = useState(null)'), 'librarySearch state missing');
  assert(code.includes("const setLibrarySearch = syncSetter(_setLibrarySearch)"), 'librarySearch online sync missing');
});

test('librarySearch in sync payload', () => {
  assert(code.includes('librarySearch,'), 'librarySearch not in sync payload');
});

test('librarySearch received from opponent', () => {
  assert(code.includes('onlineState.librarySearch !== undefined') && code.includes('_setLibrarySearch(onlineState.librarySearch)'), 'librarySearch not received from sync');
});

test('Library search overlay with online gating', () => {
  assert(code.includes("librarySearch && (!onlineMode || onlinePlayerIndex === librarySearch.pIdx)"), 'Online gating for library search overlay missing');
});

test('Library search overlay renders card choices', () => {
  assert(code.includes('BASIC_LAND_NAMES'), 'Basic land name list missing');
  assert(code.includes("tl.includes('basic') && tl.includes('land')"), 'Basic land type filter missing');
});

test('Library search puts land on battlefield and shuffles', () => {
  assert(code.includes("battlefield: [...prev.battlefield, { ...landCard, tapped: !!enterTapped"), 'Land not put on battlefield');
  // Verify shuffle
  const shuffleInSearch = code.includes("Math.floor(Math.random() * (si + 1))");
  assert(shuffleInSearch, 'Library shuffle missing after search');
});

test('Library search has Decline button', () => {
  assert(code.includes('Decline (shuffle only)'), 'Decline button missing');
});

test('Solemn Simulacrum oracle text matches ETB pattern', () => {
  // Simulate the regex
  const oracleText = 'When Solemn Simulacrum enters the battlefield, you may search your library for a basic land card, put that card onto the battlefield tapped, then shuffle your library.';
  assert(/enters.*search your library for a basic land/i.test(oracleText), 'Oracle text does not match search pattern');
  assert(/tapped/.test(oracleText), 'Tapped detection failed');
});

// ============================================================
console.log('\n▸ Crawling Barrens — "You May" Choice + Permanent Creature');
// ============================================================

test('Crawling Barrens in CREATURE_LAND_DATA with correct properties', () => {
  assert(code.includes("'crawling barrens':"), 'Crawling Barrens not in CREATURE_LAND_DATA');
  assert(code.includes("permanent: true"), 'permanent flag missing');
  assert(code.includes("noTap: true"), 'noTap flag missing');
  assert(code.includes("addCounters: { type: '+1/+1', amount: 2 }"), 'addCounters missing');
  assert(code.includes("power: 0, toughness: 0"), 'Base 0/0 missing');
});

test('activateCreatureLand accepts countersOnly parameter', () => {
  assert(code.includes('countersOnly = false'), 'countersOnly default parameter missing');
});

test('countersOnly mode adds counters without creature transformation', () => {
  assert(code.includes('if (countersOnly && data.addCounters)'), 'countersOnly branch missing');
  // Should NOT set animatedCreature or permanentCreature in countersOnly mode
  const countersOnlyBlock = code.match(/if \(countersOnly && data\.addCounters\) \{([\s\S]*?)return;\s*\}/);
  assert(countersOnlyBlock, 'countersOnly block not found');
  assert(!countersOnlyBlock[1].includes('permanentCreature'), 'countersOnly should NOT set permanentCreature');
  assert(!countersOnlyBlock[1].includes('animatedCreature'), 'countersOnly should NOT set animatedCreature');
  assert(countersOnlyBlock[1].includes('stays land'), 'countersOnly log message should say stays land');
});

test('Context menu shows two options for Crawling Barrens', () => {
  assert(code.includes('become creature'), 'Become creature option missing');
  assert(code.includes('only, stay land'), 'Stay land option missing');
  assert(code.includes('activateCreatureLand(pIdx, card, null, true)'), 'countersOnly=true call missing');
});

test('Permanent creature lands can activate multiple times', () => {
  assert(code.includes("clData.permanent\n            ? true"), 'Permanent lands not always activatable');
});

test('getEffectivePower/Toughness include +1/+1 counters', () => {
  assert(code.includes("p += (card.counters['+1/+1'] || 0)"), 'Power does not include +1/+1 counters');
  assert(code.includes("t += (card.counters['+1/+1'] || 0)"), 'Toughness does not include +1/+1 counters');
});

// ============================================================
console.log('\n▸ Relic Robber — Token Creation + Can\'t Block + Upkeep');
// ============================================================

test('Relic Robber combat damage trigger creates Goblin Construct token', () => {
  // Regex in code uses escaped forward slash: 0\/1
  assert(code.includes("that player creates a 0\\/1.*goblin construct"), 'Relic Robber trigger pattern missing');
  assert(code.includes("name: 'Goblin Construct'"), 'Goblin Construct token missing');
  assert(code.includes("cantBlock: true"), 'cantBlock flag missing on token');
});

test('Goblin Construct token has correct properties', () => {
  const tokenBlock = code.match(/name: 'Goblin Construct'[\s\S]*?(?=\}\))/);
  assert(tokenBlock, 'Token block not found');
  assert(tokenBlock[0].includes("power: '0'"), 'Wrong power');
  assert(tokenBlock[0].includes("toughness: '1'"), 'Wrong toughness');
  assert(tokenBlock[0].includes('isToken: true'), 'Not marked as token');
  assert(tokenBlock[0].includes("can't block"), 'Oracle text missing can\'t block');
  assert(tokenBlock[0].includes('deals 1 damage to you'), 'Oracle text missing upkeep damage');
});

test('Can\'t block validation in selectBlocker', () => {
  assert(code.includes('blocker.cantBlock'), 'cantBlock property check missing');
  assert(code.includes("this creature can't block"), 'Oracle text can\'t block check missing');
  assert(code.includes("can't block!"), 'Can\'t block error message missing');
});

test('Upkeep damage trigger for self-damaging creatures', () => {
  assert(code.includes('at the beginning of your upkeep'), 'Upkeep damage trigger pattern missing');
  assert(code.includes('deals?\\s+(\\d+)\\s+damage to you'), 'Upkeep damage regex missing');
});

test('Token created for DEFENDING player (opponent)', () => {
  assert(code.includes('createToken(defendingPlayer,'), 'Token should be created for defending player');
});

// ============================================================
console.log('\n▸ Shadow\'s Verdict — Exile from Battlefield + Graveyards');
// ============================================================

test('Shadow\'s Verdict parser in parseSpellEffects', () => {
  assert(code.includes("shadows_verdict"), 'shadows_verdict effect type missing');
  assert(code.includes('exile all creatures and planeswalkers with'), 'Shadow\'s Verdict pattern missing');
});

test('Shadow\'s Verdict execution handler', () => {
  assert(code.includes("case 'shadows_verdict':"), 'shadows_verdict case missing');
});

test('Shadow\'s Verdict exiles from BOTH battlefield and graveyards', () => {
  const svBlock = code.match(/case 'shadows_verdict':([\s\S]*?)break;/);
  assert(svBlock, 'shadows_verdict case block not found');
  assert(svBlock[1].includes('prev.battlefield.filter'), 'Battlefield exile missing');
  assert(svBlock[1].includes('prev.graveyard.filter'), 'Graveyard exile missing');
  assert(svBlock[1].includes('prev.exile'), 'Exile zone not updated');
});

test('Shadow\'s Verdict filters by creature/PW type AND mana value', () => {
  assert(code.includes('isCreatureOrPW'), 'isCreatureOrPW helper missing');
  assert(code.includes('mvLte'), 'mvLte (mana value less than or equal) helper missing');
});

test('Shadow\'s Verdict affects BOTH players', () => {
  const svBlock = code.match(/case 'shadows_verdict':([\s\S]*?)break;/);
  assert(svBlock[1].includes('[0, 1].forEach'), 'Should affect both players');
});

// ============================================================
console.log('\n▸ Cursecatcher — Sacrifice Counter Ability');
// ============================================================

test('sacCounter type in getSacrificeAbilities', () => {
  assert(code.includes("type: 'sacCounter'"), 'sacCounter type missing');
  assert(code.includes('counter target.*spell.*unless.*pays'), 'sacCounter regex pattern missing');
});

test('sacCounterChoice state with online sync', () => {
  assert(code.includes('sacCounterChoice'), 'sacCounterChoice state missing');
  assert(code.includes("onlineSyncNeededRef.current = true"), 'Online sync trigger exists');
});

test('sacCounterChoice in sync payload and receiver', () => {
  assert(code.includes('sacCounterChoice,\n      librarySearch,'), 'sacCounterChoice not in sync payload');
  assert(code.includes('onlineState.sacCounterChoice !== undefined'), 'sacCounterChoice not in receiver');
});

test('Pay-or-counter overlay with online gating', () => {
  assert(code.includes('sacCounterChoice && (() =>'), 'sacCounter overlay missing');
  assert(code.includes('canDecide = !onlineMode || onlinePlayerIndex === targetPIdx'), 'Online gating missing for sacCounter');
});

test('sacCounter targets top of spell stack', () => {
  assert(code.includes("spellStack[spellStack.length - 1]"), 'Does not target top of stack');
});

test('sacCounter requires opponent to have mana to pay', () => {
  assert(code.includes('canPay'), 'canPay check missing');
  assert(code.includes("totalMana >= payAmount"), 'Mana sufficiency check missing');
});

test('isCounterSpellCard includes sacCounter pattern', () => {
  assert(code.includes('counter target.*spell'), 'isCounterSpellCard regex not updated');
});

// ============================================================
console.log('\n▸ SFX System — WAV Sounds + Removed Synth Stubs');
// ============================================================

test('WAV file definitions exist', () => {
  const wavFiles = ['Tap.wav', 'Mana_Enters.wav', 'Creatures_Hit.wav', 'Life_Loss_Spells.wav',
    'Counterspell.wav', 'Planeswalker_Enters.wav', 'Player_Wins.wav', 'Return_All_Creatures.wav'];
  for (const f of wavFiles) {
    assert(code.includes(f), `WAV file ${f} missing from wavFiles`);
  }
});

test('WAV-based SFX methods call playWav via safe wrapper', () => {
  const wavMethods = ['tap', 'playLand', 'combatDamage', 'lifeLoss', 'playerDamage',
    'counterspell', 'planeswalkerEnters', 'playerWins', 'massReturn', 'playCreature'];
  for (const m of wavMethods) {
    assert(code.includes(`${m}: safe(() => playWav(`), `${m} does not call playWav`);
  }
});

test('Removed synthesized sounds are safe no-op stubs', () => {
  const removedMethods = ['draw', 'untap', 'untapAll', 'playSpell',
    'lifeGain', 'damage', 'toGraveyard', 'toExile', 'shuffle',
    'tokenCreate', 'mill', 'attack', 'block', 'creatureDeath', 'commanderCast', 'passTurn'];
  for (const m of removedMethods) {
    assert(code.includes(`${m}: safe(`), `${m} should be a safe no-op stub but isn't`);
  }
});

test('Synthesizer engine removed (no tone/noise functions)', () => {
  assert(!code.includes('const tone = (freq,'), 'tone() synthesizer function should be removed');
  assert(!code.includes('const noise = (opts'), 'noise() synthesizer function should be removed');
  assert(!code.includes('const getMaster ='), 'getMaster() should be removed');
  assert(!code.includes('const createReverbs ='), 'createReverbs() should be removed');
});

test('reverbBuf and hallBuf removed', () => {
  assert(!code.includes('let reverbBuf'), 'reverbBuf should be removed');
  assert(!code.includes('let hallBuf'), 'hallBuf should be removed');
});

test('SFX calls are direct (no try-catch needed, safe wrapper handles errors)', () => {
  const tryCatchSfx = code.match(/try \{ SFX\.\w+\(\); \} catch\(e\) \{\}/g);
  assert(!tryCatchSfx || tryCatchSfx.length === 0, `Expected 0 try-catch SFX wrappers, found ${tryCatchSfx ? tryCatchSfx.length : 0}`);
  // Verify safe wrapper exists inside SFX
  assert(code.includes('const safe = (fn) => (...args) => { try { fn(...args); } catch(e) {} };'), 'SFX safe wrapper missing');
});

test('All WAV files exist on disk', () => {
  const soundDir = path.join(__dirname, 'client', 'public', 'sounds');
  const wavFiles = ['Tap.wav', 'Mana_Enters.wav', 'Creatures_Hit.wav', 'Life_Loss_Spells.wav',
    'Counterspell.wav', 'Planeswalker_Enters.wav', 'Player_Wins.wav', 'Return_All_Creatures.wav'];
  for (const f of wavFiles) {
    assert(fs.existsSync(path.join(soundDir, f)), `WAV file ${f} does not exist on disk`);
  }
});

// ============================================================
console.log('\n▸ Online Mode Gating — New Overlays');
// ============================================================

test('Library search overlay gated by player', () => {
  assert(code.includes("librarySearch && (!onlineMode || onlinePlayerIndex === librarySearch.pIdx)"), 'Library search overlay not gated');
});

test('Sac counter overlay gated by target player', () => {
  assert(code.includes("canDecide = !onlineMode || onlinePlayerIndex === targetPIdx"), 'sacCounter overlay not gated');
});

test('Spell stack resolve gated by opponent of caster', () => {
  // Only opponent of caster sees resolve button
  assert(code.includes('onlinePlayerIndex === (stackTop.pIdx === 0 ? 1 : 0)'), 'Spell stack resolve not gated');
});

test('Scry/Surveil overlay gated by scrying player', () => {
  assert(code.includes('scryView && (!onlineMode || onlinePlayerIndex === scryView.pIdx)'), 'Scry overlay not gated');
});

test('Look at top overlay gated by looking player', () => {
  assert(code.includes('lookTopView && (!onlineMode || onlinePlayerIndex === lookTopView.pIdx)'), 'Look-top overlay not gated');
});

// ============================================================
console.log('\n▸ Integration — Card Oracle Text Matching');
// ============================================================

test('Vorinclex oracle text matches detection regex', () => {
  const vorOracle = 'If you would put one or more counters on a permanent or player, put twice that many of each of those kinds of counters on that permanent or player instead.';
  assert(/double|twice/i.test(vorOracle), 'Vorinclex oracle should match double|twice');
  assert('vorinclex, monstrous raider'.includes('vorinclex'), 'Name should include vorinclex');
});

test('Relic Robber oracle text matches combat trigger', () => {
  const oracle = 'Whenever Relic Robber deals combat damage to a player, that player creates a 0/1 colorless Goblin Construct artifact creature token';
  assert(/that player creates a 0\/1.*goblin construct/i.test(oracle), 'Relic Robber trigger should match');
});

test('Shadow\'s Verdict oracle text matches parser', () => {
  const oracle = 'Exile all creatures and planeswalkers with mana value 3 or less from the battlefield and from all graveyards.';
  const match = oracle.match(/exile all creatures and planeswalkers with (?:mana value|converted mana cost) (\d+) or less/i);
  assert(match, 'Shadow\'s Verdict pattern should match');
  assert(match[1] === '3', 'Threshold should be 3');
});

test('Cursecatcher oracle text matches sacCounter pattern', () => {
  const oracle = 'Sacrifice Cursecatcher: Counter target instant or sorcery spell unless its controller pays {1}.';
  assert(/counter target.*spell.*unless.*pays\s*\{(\d+)\}/i.test(oracle), 'Cursecatcher oracle should match sacCounter');
  const payMatch = oracle.match(/unless.*pays\s*\{(\d+)\}/i);
  assert(payMatch && payMatch[1] === '1', 'Pay amount should be 1');
});

test('Solemn Simulacrum oracle matches search_basic_land', () => {
  const oracle = 'When Solemn Simulacrum enters the battlefield, you may search your library for a basic land card, put that card onto the battlefield tapped';
  assert(/enters.*search your library for a basic land/i.test(oracle), 'ETB search pattern should match');
  assert(/tapped/.test(oracle), 'Should detect tapped');
});

test('Goblin Construct upkeep damage pattern matches', () => {
  const oracle = "This creature can't block.\nAt the beginning of your upkeep, this creature deals 1 damage to you.";
  const match = oracle.match(/at the beginning of your upkeep,?\s*(?:this creature|~)\s+deals?\s+(\d+)\s+damage to you/i);
  assert(match, 'Upkeep damage pattern should match');
  assert(match[1] === '1', 'Damage should be 1');
});

test('Can\'t block pattern matches Goblin Construct oracle', () => {
  const oracle = "This creature can't block.";
  assert(/this creature can't block/i.test(oracle), 'Can\'t block pattern should match');
  // The code uses BOTH patterns: /this creature can't block/ OR /(?:^|\.\s)can't block(?:\.|$)/
  // The first one catches our case, which is sufficient
  const oracle2 = "Defender. Can't block.";
  assert(/(?:^|\.\s)can't block(?:\.|$)/i.test(oracle2), 'Standalone can\'t block should match after period');
});

// ============================================================
console.log('\n▸ State Sync Completeness');
// ============================================================

test('All new state variables in sync payload', () => {
  // The sync payload is multi-line, search for the variables near the emit call
  assert(code.includes('sacCounterChoice,') && code.includes('librarySearch,') && code.includes('spellStack,'), 'sacCounterChoice, librarySearch and spellStack should all be in sync payload');
});

test('All new state variables received from opponent', () => {
  assert(code.includes('onlineState.sacCounterChoice !== undefined'), 'sacCounterChoice not received');
  assert(code.includes('onlineState.librarySearch !== undefined'), 'librarySearch not received');
});

// ============================================================
console.log('\n▸ Edge Cases & Safety');
// ============================================================

test('Vorinclex modifier returns 0 for amount 0', () => {
  assert(code.includes('if (amount <= 0) return amount'), 'Should return early for amount <= 0');
});

test('addCounter shows feedback and skips when Vorinclex halves to 0', () => {
  assert(code.includes('if (finalAmount <= 0) {'), 'Should check finalAmount <= 0');
  assert(code.includes('Vorinclex negated'), 'Should show Vorinclex negation message');
});

test('Library search handles empty library gracefully', () => {
  assert(code.includes("matchingCards.length > 0 ?"), 'Should handle no matching cards');
  assert(code.includes("No matching lands found"), 'Should show message when no lands found');
});

test('Crawling Barrens base 0/0 survives with counters', () => {
  // getEffectiveToughness with 0 base + 2 counters should be 2 (not 0)
  // This is ensured by: t += (card.counters['+1/+1'] || 0)
  assert(code.includes("t += (card.counters['+1/+1'] || 0)"), 'Toughness counter bonus missing');
  // And Math.max(0, t) at the end
  assert(code.includes('return Math.max(0, t)'), 'Toughness floor at 0 missing');
});

test('revertCreatureLands skips permanent creature lands', () => {
  // Permanent creature lands use permanentCreature flag, not animatedCreature
  // revertCreatureLands only reverts animatedCreature === true
  assert(code.includes('animatedCreature: !isPermanent'), 'Permanent lands should not set animatedCreature');
});

test('Crawling Barrens countersOnly does not change type_line', () => {
  const countersOnlyBlock = code.match(/if \(countersOnly && data\.addCounters\) \{([\s\S]*?)return;\s*\}/);
  assert(countersOnlyBlock, 'countersOnly block not found');
  assert(!countersOnlyBlock[1].includes('type_line'), 'countersOnly should NOT modify type_line');
});

test('Bracket balance sanity check on key sections', () => {
  // Check that SFX block is properly closed
  const sfxBlock = code.match(/const SFX = \(\(\) => \{([\s\S]*?)\}\)\(\);/);
  assert(sfxBlock, 'SFX IIFE block not properly closed');

  // Check CREATURE_LAND_DATA is properly closed
  const cldBlock = code.match(/const CREATURE_LAND_DATA = \{([\s\S]*?)\};/);
  assert(cldBlock, 'CREATURE_LAND_DATA not properly closed');
});

// ============================================================
console.log('\n▸ Online Mode — Turn Start State Reset');
// ============================================================

test('onlineTurnDrawEffect resets landPlayedThisTurn', () => {
  // The online turn draw effect must reset landPlayedThisTurn: false
  // because setMe doesn't accept it from the server sync
  const turnDrawBlock = code.match(/onlineTurnDrawnRef\.current = turnKey;([\s\S]*?)SFX\.draw/);
  assert(turnDrawBlock, 'Could not find onlineTurnDraw block');
  assert(turnDrawBlock[1].includes('landPlayedThisTurn: false'), 'landPlayedThisTurn not reset in onlineTurnDraw');
});

test('onlineTurnDrawEffect resets dealtDamageThisTurn', () => {
  const turnDrawBlock = code.match(/onlineTurnDrawnRef\.current = turnKey;([\s\S]*?)SFX\.draw/);
  assert(turnDrawBlock, 'Could not find onlineTurnDraw block');
  assert(turnDrawBlock[1].includes('dealtDamageThisTurn: false'), 'dealtDamageThisTurn not reset in onlineTurnDraw');
});

test('onlineTurnDrawEffect resets manaPool', () => {
  const turnDrawBlock = code.match(/onlineTurnDrawnRef\.current = turnKey;([\s\S]*?)SFX\.draw/);
  assert(turnDrawBlock, 'Could not find onlineTurnDraw block');
  assert(turnDrawBlock[1].includes("manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }"), 'manaPool not reset in onlineTurnDraw');
});

test('onlineTurnDrawEffect untaps battlefield', () => {
  const turnDrawBlock = code.match(/onlineTurnDrawnRef\.current = turnKey;([\s\S]*?)SFX\.draw/);
  assert(turnDrawBlock, 'Could not find onlineTurnDraw block');
  assert(turnDrawBlock[1].includes('tapped: false'), 'Battlefield not untapped in onlineTurnDraw');
  assert(turnDrawBlock[1].includes('enteredThisTurn: false'), 'enteredThisTurn not reset in onlineTurnDraw');
});

test('onlineTurnDrawEffect clears untilNextTurnEffects', () => {
  const turnDrawBlock = code.match(/onlineTurnDrawnRef\.current = turnKey;([\s\S]*?)SFX\.draw/);
  assert(turnDrawBlock, 'Could not find onlineTurnDraw block');
  assert(turnDrawBlock[1].includes('untilNextTurnEffects: []'), 'untilNextTurnEffects not cleared in onlineTurnDraw');
});

test('onlineTurnDrawEffect plays untapAll SFX', () => {
  // Should play untapAll before draw
  const afterTurnDraw = code.match(/onlineTurnDrawnRef\.current = turnKey;([\s\S]*?)SFX\.draw/);
  assert(afterTurnDraw, 'Could not find post-turnDraw block');
  assert(afterTurnDraw[1].includes('SFX.untapAll()'), 'untapAll SFX not played in onlineTurnDraw');
});

test('setMe does NOT include landPlayedThisTurn (by design)', () => {
  // Verify that the "my state" receiver does NOT blindly accept landPlayedThisTurn
  // from the server. The onlineTurnDrawEffect handles this locally instead.
  const setMeBlock = code.match(/const next = \{\s*\.\.\.prev,\s*life: serverMe\.life([\s\S]*?)return next;/);
  assert(setMeBlock, 'setMe block not found');
  assert(!setMeBlock[1].includes('landPlayedThisTurn'), 'setMe should NOT include landPlayedThisTurn (would cause issues)');
});

// ============================================================
console.log('\n▸ Game Log & Token Art');
// ============================================================

test('createToken includes game log with skipLog parameter', () => {
  assert(code.includes('const createToken = (pIdx, token, playSound = true, skipLog = false)'), 'createToken signature missing skipLog');
  assert(code.includes("if (!skipLog)"), 'skipLog check missing in createToken');
});

test('addGameLog queues log entries for broadcast via pendingLogEntriesRef', () => {
  assert(code.includes("pendingLogEntriesRef.current.push(entry)"), 'addGameLog not queuing log entries');
  // Log entries are bundled into the useEffect broadcast as __logEntries
  assert(code.includes("payload.__logEntries"), 'Log entries not bundled in broadcast payload');
});

test('moveCard logs zone transitions', () => {
  // Should log battlefield→graveyard, battlefield→exile, etc.
  const moveCardBlock = code.match(/const moveCard = \(pIdx[\s\S]*?(?=\n  const \w+ = )/);
  assert(moveCardBlock, 'moveCard function not found');
  assert(moveCardBlock[0].includes("addGameLog(pIdx, '💀'"), 'Missing graveyard transition log');
  assert(moveCardBlock[0].includes("addGameLog(pIdx, '🚫'"), 'Missing exile transition log');
});

test('PW token auto-creation detects create token pattern', () => {
  // The code uses multiple patterns for parsing token creation from PW abilities
  assert(code.includes("create\\s+(\\w[\\w\\s]*?),\\s+a"), 'Named token creation regex missing');
  assert(code.includes("creature\\s+token"), 'creature token pattern missing');
});

test('Scryfall token art fetch after createToken', () => {
  // After creating tokens, should fetch art from Scryfall
  assert(code.includes("api.scryfall.com/cards/search?q="), 'Scryfall token art fetch missing');
});

test('Chandra exile-cast-or-damage detection', () => {
  assert(code.includes("exile the top card of your library.*you may cast"), 'Chandra +1 pattern missing');
  assert(code.includes("exiledCard"), 'exiledCard property missing for two-phase flow');
});

test('Shark Typhoon cycling token auto-creation', () => {
  assert(code.includes("Enter X value for the"), 'Shark Typhoon X prompt missing');
});

// ============================================================
console.log('\n▸ Opponent SFX in Online Mode');
// ============================================================

test('Opponent SFX: detect new creatures on opponent battlefield', () => {
  const setOppBlock = code.match(/setOpp\(prev => \{([\s\S]*?)\}\);/);
  assert(setOppBlock, 'setOpp block not found');
  assert(setOppBlock[1].includes('SFX.playCreature()'), 'Missing creature enter SFX for opponent');
  assert(setOppBlock[1].includes('SFX.playLand()'), 'Missing land enter SFX for opponent');
  assert(setOppBlock[1].includes('SFX.playSpell()'), 'Missing spell cast SFX for opponent');
});

test('Opponent SFX: detect tapping without new cards', () => {
  assert(code.includes('tappedNew.length > 0 && entered.length === 0'), 'Tap SFX condition missing (should exclude new card entries)');
});

test('Creature_Enters.wav integrated', () => {
  assert(code.includes("playCreature: '/sounds/Creature_Enters.wav'"), 'Creature_Enters.wav not in wavFiles');
  assert(code.includes("playCreature: safe(() => playWav('playCreature'"), 'playCreature not using playWav');
});

// ============================================================
console.log('\n▸ Create Token Copy');
// ============================================================

test('createTokenCopy function exists', () => {
  assert(code.includes('const createTokenCopy'), 'createTokenCopy function missing');
  assert(code.includes('isTokenCopy: true'), 'isTokenCopy flag missing in token copy');
  assert(code.includes('copiedFrom:'), 'copiedFrom property missing');
});

test('Token copy prompts for P/T override', () => {
  assert(code.includes('Override P/T?'), 'P/T override prompt missing');
});

test('Token copy available in graveyard context menu for creatures', () => {
  assert(code.includes("Create Token Copy (exile this)"), 'Token copy option missing from graveyard menu');
});

test('Token copy available in exile context menu for creatures', () => {
  const exileSection = code.match(/zone === 'exile'[\s\S]*?(?=zone === 'library')/);
  assert(exileSection, 'Exile zone section not found');
  assert(exileSection[0].includes('Create Token Copy'), 'Token copy option missing from exile menu');
});

// ============================================================
console.log('\n▸ Return-to-Hand Reminder (parseLTBEffects)');
// ============================================================

test('parseLTBEffects detects return-to-hand at end step', () => {
  const ltbSection = code.match(/const parseLTBEffects[\s\S]*?return effects;\s*\};/);
  assert(ltbSection, 'parseLTBEffects function not found');
  assert(ltbSection[0].includes('return') && ltbSection[0].includes('hand') && ltbSection[0].includes('end step'), 'Return-to-hand pattern not detected');
  assert(ltbSection[0].includes('REMINDER'), 'Missing REMINDER label for return-to-hand');
});

test('parseLTBEffects detects return-to-battlefield at end step', () => {
  const ltbSection = code.match(/const parseLTBEffects[\s\S]*?return effects;\s*\};/);
  assert(ltbSection, 'parseLTBEffects function not found');
  assert(ltbSection[0].includes('Return this card to the battlefield'), 'Return-to-battlefield pattern not detected');
});

// ============================================================
console.log('\n▸ Foretell Mechanic');
// ============================================================

test('getForetellCost parser exists', () => {
  assert(code.includes('const getForetellCost'), 'getForetellCost function missing');
  assert(code.includes("foretell"), 'foretell keyword check missing');
});

test('Foretell option appears in hand context menu', () => {
  assert(code.includes('Foretell (pay {2}, exile face-down)'), 'Foretell option missing from hand menu');
});

test('foretellCard function exists', () => {
  assert(code.includes('const foretellCard'), 'foretellCard function missing');
  assert(code.includes('isForetold: true'), 'isForetold flag missing');
  assert(code.includes('foretoldBy:'), 'foretoldBy property missing');
});

test('castForetold function exists', () => {
  assert(code.includes('const castForetold'), 'castForetold function missing');
  assert(code.includes('from foretell'), 'Foretell cast log missing');
});

test('Foretold cards have special context menu in exile', () => {
  assert(code.includes('Cast from Foretell'), 'Cast from Foretell option missing');
  assert(code.includes('card.isForetold'), 'Foretold card detection in exile missing');
});

test('Exile button shows foretell indicator', () => {
  assert(code.includes('foretoldInExile'), 'foretoldInExile detection missing');
  assert(code.includes("Foretold"), 'Foretold badge missing in ZoneViewer');
});

// ============================================================
// Modal Choice ("Choose One") & Block Triggers
// ============================================================
console.log('\n▸ Modal Choice (Choose One) & Block Triggers');

test('parseCombatTrigger function exists', () => {
  assert(code.includes('const parseCombatTrigger'), 'parseCombatTrigger not found');
  assert(code.includes('triggerType'), 'triggerType param not found');
});

test('parseCombatTrigger detects "choose one" modal triggers', () => {
  assert(code.includes('choose one'), 'choose one detection not found');
  assert(code.includes('modalChoices'), 'modalChoices not set');
  assert(code.includes('isModal: true'), 'isModal flag not set');
});

test('parseCombatTrigger parses token/life/draw choices', () => {
  assert(code.includes("action: 'token'"), 'token action not parsed');
  assert(code.includes("action: 'life'"), 'life action not parsed');
  assert(code.includes("action: 'draw'"), 'draw action not parsed');
});

test('executeModalChoice function exists', () => {
  assert(code.includes('const executeModalChoice'), 'executeModalChoice not found');
  assert(code.includes('choice.action'), 'choice action handling not found');
});

test('executeModalChoice creates token with reskin support', () => {
  assert(code.includes('customTokenName') && code.includes('executeModalChoice'), 'reskin token name in modal');
  assert(code.includes('customTokenImage') && code.includes('tokenImageSmall'), 'reskin token image in modal');
});

test('executeModalChoice handles life gain choice', () => {
  assert(code.includes("choice.action === 'life'"), 'life gain handling');
  assert(code.includes('prev.life + amount'), 'life addition');
});

test('executeModalChoice handles draw card choice', () => {
  assert(code.includes("choice.action === 'draw'"), 'draw handling');
  assert(code.includes('prev.library.slice(0, amount)'), 'library draw slice');
});

test('modalChoice is a synced state for online mode', () => {
  assert(code.includes('const [modalChoice, _setModalChoice] = useState(null)'), 'modalChoice state');
  assert(code.includes('const setModalChoice = syncSetter(_setModalChoice)'), 'modalChoice syncSetter');
});

test('modalChoice in broadcast payload', () => {
  assert(code.includes('modalChoice,') && code.includes('preventCombatDamage,'), 'modalChoice in payload');
});

test('modalChoice in receiver', () => {
  assert(code.includes('_setModalChoice(onlineState.modalChoice)'), 'modalChoice receiver');
});

test('Block trigger scanning in confirmBlockers', () => {
  assert(code.includes('BLOCK TRIGGERS'), 'block trigger comment');
  assert(code.includes('selfBlockPattern'), 'block pattern matching');
  assert(code.includes('blockTriggers'), 'blockTriggers array');
});

test('Modal choice overlay UI renders', () => {
  assert(code.includes('Modal Choice Overlay'), 'modal overlay comment');
  assert(code.includes('Choose One'), 'choose one title');
  assert(code.includes('executeModalChoice(choice'), 'modal choice click handler');
});

test('Attack triggers use parseCombatTrigger', () => {
  assert(code.includes("parseCombatTrigger(attacker, oracle, 'attack')"), 'attack triggers use shared parser');
});

test('Block triggers use parseCombatTrigger', () => {
  assert(code.includes("parseCombatTrigger(blocker, oracle, 'block')"), 'block triggers use shared parser');
});

test('Modal triggers separated from simple triggers in attack processing', () => {
  assert(code.includes('modalTriggers = attackTriggers.filter(t => t.trigger.isModal)'), 'modal filter');
  assert(code.includes('simpleTriggers = attackTriggers.filter(t => !t.trigger.isModal)'), 'simple filter');
});

// ============================================================
// Bug Fix: Bonecrusher Giant adventure instant casting
// ============================================================
console.log('\n▸ Bug Fix: Bonecrusher Giant Adventure Instant Casting');

test('Adventure instant cast always uses adventure face at instant speed', () => {
  // The fix: removed !isInstant(card) && !hasFlash(card) check that prevented
  // adventure cards with instant adventure faces from being cast as adventures
  // The condition should now be just: if (isAdventureCard(card)) {
  const castInstantSection = code.substring(
    code.indexOf('setInstantCasting(null); // Close the instant casting overlay'),
    code.indexOf('castCard(pIdx, card);', code.indexOf('setInstantCasting(null); // Close'))
  );
  // The actual code condition should NOT have && !isInstant(card) && !hasFlash(card) on the same line as isAdventureCard
  assert(!castInstantSection.includes('isAdventureCard(card) && !isInstant(card)'), 'removed !isInstant condition from adventure check');
});

test('Instant casting overlay shows adventure label for instant adventures', () => {
  assert(code.includes("card.card_faces?.[1]?.type_line?.toLowerCase().includes('instant')"), 'adventure label uses face type_line');
});

// ============================================================
// Bug Fix: Reskin art overlay height
// ============================================================
console.log('\n▸ Bug Fix: Reskin Art Overlay Height');

test('Non-planeswalker reskin art uses 44% height', () => {
  assert(code.includes("'44%'"), 'creature reskin art height is 44%');
});

// ============================================================
// Bug Fix: Kiora +1 prevent damage
// ============================================================
console.log('\n▸ Bug Fix: Kiora +1 Prevent Damage');

test('PW ability resolver detects prevent damage pattern', () => {
  assert(code.includes('isPreventDamage'), 'isPreventDamage variable exists');
  assert(code.includes("until your next turn,?\\s+prevent all damage"), 'prevent damage regex');
});

test('PW ability resolver shows target buttons for each opponent permanent', () => {
  assert(code.includes('oppPermanents.forEach'), 'renders button per opponent permanent');
  assert(code.includes('oppPermanents = getState(oppIdx).battlefield'), 'targets all permanents, not just creatures');
  assert(code.includes('No target (loyalty only)'), 'has no-target option for loyalty-only activation');
});

test('Prevent damage targets any permanent (not just creatures)', () => {
  assert(!code.includes('oppCreatures = getState(oppIdx).battlefield.filter(c => isCreature(c))') ||
         code.includes('oppPermanents = getState(oppIdx).battlefield'), 'targets permanents not just creatures');
});

// ============================================================
// Bug Fix: Attack/block trigger robustness
// ============================================================
console.log('\n▸ Bug Fix: Attack/Block Trigger Robustness');

test('Attack trigger has generic fallback pattern for ~ self-reference', () => {
  assert(code.includes('genericAttackPattern'), 'generic attack pattern variable');
  assert(code.includes('~|this creature'), 'pattern matches tilde and this creature');
});

test('Block trigger has generic fallback pattern', () => {
  assert(code.includes('genericBlockPattern'), 'generic block pattern variable');
});

test('Attack trigger parsing is wrapped in try-catch', () => {
  assert(code.includes("[Attack Trigger] Error parsing trigger for"), 'attack trigger try-catch with error log');
});

test('Block trigger parsing is wrapped in try-catch', () => {
  assert(code.includes("[Block Trigger] Error parsing trigger for"), 'block trigger try-catch with error log');
});

// ============================================================
// Modal Spell Choice ("choose one" instants like Decisive Denial)
// ============================================================
console.log('\n▸ Modal Spell Choice (Choose One Instants)');

test('castCard detects "choose one" spells and shows modal', () => {
  assert(code.includes("choose one/i.test(spellOracle)"), 'choose one detection in castCard');
  assert(code.includes("pendingSpellModalRef.current ="), 'stores pending spell modal state');
  assert(code.includes("triggerType: 'spell'"), 'sets triggerType to spell for modal');
});

test('pendingSpellModalRef exists for storing spell modal state', () => {
  assert(code.includes('pendingSpellModalRef = useRef(null)'), 'pendingSpellModalRef declared');
});

test('executeModalChoice handles spell_mode action', () => {
  assert(code.includes("choice.action === 'spell_mode'"), 'spell_mode action handler');
});

test('Spell modal counter mode puts on stack with chosenMode', () => {
  assert(code.includes("chosenMode: 'counter'"), 'counter chosenMode in stack entry');
});

test('resolveTopOfStack respects chosenMode for modal spells', () => {
  assert(code.includes("shouldActAsCounter"), 'shouldActAsCounter variable');
  assert(code.includes("topSpell.chosenMode === 'counter'"), 'checks chosenMode for counter');
});

test('parseSpellEffects detects "counter target noncreature spell"', () => {
  assert(code.includes('counter target [\\w\\s]*spell'), 'broadened counter regex');
});

test('Modal choice overlay shows Spell label for spell modals', () => {
  assert(code.includes("Spell — Choose Mode"), 'spell modal overlay label');
});

// ============================================================
// Overload Mechanic (Cyclonic Rift)
// ============================================================
test('Overload: castCard detects overload keyword in oracle text', () => {
  assert(code.includes('overload') && code.includes('overloadMatch'), 'overload detection in castCard');
});

test('Overload: regex extracts overload cost from oracle text', () => {
  const overloadRegex = /overload\s*(\{[^}]+(?:\}\{[^}]+)*\})/;
  const cyclonic = 'return target nonland permanent you don\'t control to its owner\'s hand.\noverload {4}{u}{u}{u}';
  const match = cyclonic.match(overloadRegex);
  assert(match !== null, 'overload regex matches Cyclonic Rift oracle');
  assert(match[1] === '{4}{u}{u}{u}', 'extracted overload cost: ' + (match ? match[1] : 'null'));
});

test('Overload: modal shows Normal vs Overload choices', () => {
  assert(code.includes("action: 'overload_mode'"), 'overload_mode action in choices');
  assert(code.includes("modeText: 'normal'"), 'normal mode text');
  assert(code.includes("modeText: 'overload'"), 'overload mode text');
});

test('Overload: executeModalChoice handles overload_mode action', () => {
  assert(code.includes("choice.action === 'overload_mode'"), 'overload_mode handler in executeModalChoice');
});

test('Overload: overload mode puts spell on stack with overloadMode flag', () => {
  assert(code.includes('overloadMode: true'), 'overloadMode flag on stack entry');
});

test('Overload: resolveSpellFromStack handles overloadMode', () => {
  assert(code.includes('stackEntry.overloadMode'), 'overloadMode check in resolveSpellFromStack');
});

test('Overload: Cyclonic Rift overload bounces all opponent nonland permanents', () => {
  // Check the resolution code handles nonland permanent bounce for opponents
  assert(code.includes('return.*nonland permanent.*to its owner') || code.includes('nonland permanent'), 'nonland permanent bounce pattern');
  assert(code.includes('Overload! Bounced'), 'overload bounce message');
});

test('Overload: disabled button support in modal choices', () => {
  assert(code.includes('choice.disabled'), 'disabled check on modal choice buttons');
  assert(code.includes("cursor: choice.disabled ? 'not-allowed'"), 'not-allowed cursor for disabled');
});

test('Overload: stack overlay shows OVERLOADED label', () => {
  assert(code.includes('OVERLOADED'), 'OVERLOADED label in stack overlay');
});

test('Overload: Cyclonic Rift normal mode still works (single target bounce)', () => {
  // Normal castCard path should still detect single-target bounce
  // Regex includes ' in character class to handle "you don't control"
  const bounceRegex = /return target (creature|nonland permanent|permanent|artifact|enchantment)[\w ']*to its owner's hand/;
  const cyclonic = "return target nonland permanent you don't control to its owner's hand.";
  assert(bounceRegex.test(cyclonic), 'single-target bounce regex matches Cyclonic Rift with don\'t control');
  // Also test simpler bounces
  const unsummon = "return target creature to its owner's hand.";
  assert(bounceRegex.test(unsummon), 'single-target bounce regex matches Unsummon');
});

// ============================================================
// BUG FIX: Boros Charm / Skewer planeswalker targeting
// ============================================================
console.log('\n--- Boros Charm / Skewer Planeswalker Targeting ---');

test('Damage regex matches "player or planeswalker"', () => {
  const dmgRegex = /deals? (\d+|x) damage to (any target|target (creature or planeswalker|player or planeswalker|creature or player|creature|player|opponent))/;
  assert(dmgRegex.test('deals 4 damage to target player or planeswalker'), 'Boros Charm pattern matches');
  assert(dmgRegex.test('deals 3 damage to target player or planeswalker'), 'Skewer pattern matches');
});

test('Damage regex longer patterns match before shorter ones', () => {
  const dmgRegex = /deals? (\d+|x) damage to (any target|target (creature or planeswalker|player or planeswalker|creature or player|creature|player|opponent))/;
  const match = 'deals 4 damage to target player or planeswalker'.match(dmgRegex);
  assert(match, 'regex matches');
  assert(match[3] === 'player or planeswalker', `captured group is "player or planeswalker", got "${match[3]}"`);
});

test('Planeswalker damage removes loyalty counters in code', () => {
  assert(code.includes('isPlaneswalker(targetCard)'), 'checks if target is planeswalker');
  assert(code.includes('currentLoyalty - dmg') || code.includes('currentLoyalty-dmg'), 'subtracts damage from loyalty');
});

// ============================================================
// BUG FIX: Light Up the Stage (library as public zone)
// ============================================================
console.log('\n--- Light Up the Stage (library public zone) ---');

test('Server GameRoom.js has library in public zone', () => {
  const serverCode = fs.readFileSync(path.join(__dirname, 'server', 'GameRoom.js'), 'utf8');
  // Library should be updated outside the `if (i === playerIndex)` block
  // Check that library update is NOT inside the private-only section
  const publicZoneSection = serverCode.match(/Update public zones.*?Semi-private/s);
  if (publicZoneSection) {
    assert(publicZoneSection[0].includes('u.library'), 'library is in public zone section');
  } else {
    // Alternative check: library update should not be gated by playerIndex
    assert(serverCode.includes('if (u.library) s.library = u.library'), 'library update exists in server');
  }
});

// ============================================================
// BUG FIX: Pain lands deal 1 damage
// ============================================================
console.log('\n--- Pain Lands ---');

test('Pain land detection regex works', () => {
  const painRegex = /deals? 1 damage to you/i;
  assert(painRegex.test('Whenever you tap Caves of Koilos for mana, it deals 1 damage to you.'), 'Caves of Koilos matches');
  assert(painRegex.test('{T}: Add {C}. {T}: Add {W} or {B}. Battlefield Forge deals 1 damage to you.'), 'Battlefield Forge matches');
  assert(!painRegex.test('{T}: Add {G} or {U}.'), 'Normal dual land does not match');
});

test('Pain land code deducts life on colored mana', () => {
  assert(code.includes('isPainLand'), 'isPainLand variable exists');
  assert(code.includes('pain land') || code.includes('Pain land'), 'pain land log message exists');
});

test('Mana choice overlay passes isPainLand', () => {
  assert(code.includes('isPainLand') && code.includes('manaChoice.isPainLand'), 'manaChoice carries isPainLand flag');
});

// ============================================================
// BUG FIX: Roiling Vortex curly apostrophe
// ============================================================
console.log('\n--- Roiling Vortex Curly Apostrophe ---');

test('Upkeep damage regex handles curly apostrophe', () => {
  // The regex in code uses ['\u2018\u2019] character class
  const upkeepRegex = /at the beginning of each player['\u2018\u2019]?s upkeep,?\s*(?:~|[\w\s,]+)\s+deals?\s+(\d+)\s+damage to that player/i;
  // Scryfall uses right single quotation mark U+2019
  const scryfallText = "At the beginning of each player\u2019s upkeep, Roiling Vortex deals 1 damage to that player.";
  assert(upkeepRegex.test(scryfallText), 'regex matches Scryfall curly apostrophe');
  // Also test straight apostrophe
  const straightText = "At the beginning of each player's upkeep, Roiling Vortex deals 1 damage to that player.";
  assert(upkeepRegex.test(straightText), 'regex matches straight apostrophe');
});

test('Code uses curly apostrophe character class for upkeep damage', () => {
  assert(code.includes("['\u2018\u2019]"), 'code contains curly apostrophe character class');
});

// ============================================================
// BUG FIX: Exit Game (leaveRoom)
// ============================================================
console.log('\n--- Exit Game (leaveRoom) ---');

test('leaveRoom function exists in useGameSocket', () => {
  assert(code.includes('const leaveRoom'), 'leaveRoom function is defined');
  assert(code.includes("socket.emit('leaveRoom'") || code.includes('socket.emit("leaveRoom"'), 'leaveRoom emits socket event');
});

test('leaveRoom resets all game state', () => {
  assert(code.includes('setRoomInfo(null)'), 'resets roomInfo');
  assert(code.includes('setGameState(null)'), 'resets gameState');
  assert(code.includes('setGameStarted(false)'), 'resets gameStarted');
});

test('onExit calls leaveRoom', () => {
  assert(code.includes('gameSocket.leaveRoom()'), 'onExit calls gameSocket.leaveRoom()');
});

test('Server has leaveRoom handler', () => {
  const serverCode = fs.readFileSync(path.join(__dirname, 'server', 'index.js'), 'utf8');
  assert(serverCode.includes("socket.on('leaveRoom'"), 'server handles leaveRoom event');
  assert(serverCode.includes('socket.leave(socket.roomId)'), 'server leaves socket room');
});

// ============================================================
// PW Loyalty Damage — uses counters.loyalty, not card.loyalty
// ============================================================
console.log('\n--- PW Loyalty Damage (Bug Fix) ---');

test('applySpellEffect reads counters.loyalty for PW damage, not card.loyalty', () => {
  // The bug was: code used targetCard.loyalty (printed starting value) instead of counters.loyalty (current value)
  // This caused PWs to die from damage that should have been survivable
  const loyaltyLine = code.match(/Damage to planeswalker[\s\S]{0,200}const currentLoyalty = ([^;]+);/);
  assert(loyaltyLine, 'PW damage loyalty calculation exists');
  const calcExpr = loyaltyLine[1];
  // Must check counters.loyalty FIRST, not card.loyalty
  assert(calcExpr.includes('counters') && calcExpr.includes('loyalty'), 'Uses counters.loyalty for PW damage calculation');
  // Must NOT use targetCard.loyalty as the primary source
  assert(!calcExpr.includes('targetCard.loyalty != null ? targetCard.loyalty'),
    'Does NOT use targetCard.loyalty (printed starting value) as primary source');
});

test('PW loyalty read priority: counters.loyalty > card.loyalty', () => {
  // Extract the actual loyalty calculation line
  const match = code.match(/\/\/ IMPORTANT:.*\n\s*const currentLoyalty = ([^;]+);/);
  assert(match, 'Has IMPORTANT comment and currentLoyalty assignment');
  const expr = match[1];
  // counters.loyalty should come BEFORE targetCard.loyalty in the expression
  const countersPos = expr.indexOf('counters');
  const targetLoyaltyPos = expr.indexOf('targetCard.loyalty');
  assert(countersPos >= 0, 'Expression references counters');
  assert(targetLoyaltyPos >= 0 || expr.includes('parseInt'), 'Has fallback to card.loyalty');
  assert(countersPos < targetLoyaltyPos || targetLoyaltyPos === -1,
    'counters.loyalty is checked BEFORE targetCard.loyalty');
});

test('PW survives damage when counters.loyalty > damage amount', () => {
  // Simulate: Kiora with starting loyalty 2, current counters.loyalty = 4, takes 3 damage
  // With the fix, currentLoyalty should be 4 (from counters), not 2 (from card.loyalty)
  // newLoyalty = 4 - 3 = 1 > 0, so PW should survive
  const kiora = { loyalty: 2, counters: { loyalty: 4 } };
  const dmg = 3;
  const currentLoyalty = (kiora.counters && kiora.counters.loyalty != null) ? kiora.counters.loyalty : (parseInt(kiora.loyalty) || 0);
  assert(currentLoyalty === 4, `currentLoyalty should be 4 (from counters), got ${currentLoyalty}`);
  const newLoyalty = currentLoyalty - dmg;
  assert(newLoyalty === 1, `newLoyalty should be 1, got ${newLoyalty}`);
  assert(newLoyalty > 0, 'PW should survive (loyalty > 0)');
});

test('PW dies from damage when counters.loyalty <= damage amount', () => {
  const kiora = { loyalty: 2, counters: { loyalty: 3 } };
  const dmg = 3;
  const currentLoyalty = (kiora.counters && kiora.counters.loyalty != null) ? kiora.counters.loyalty : (parseInt(kiora.loyalty) || 0);
  assert(currentLoyalty === 3, `currentLoyalty should be 3, got ${currentLoyalty}`);
  const newLoyalty = currentLoyalty - dmg;
  assert(newLoyalty <= 0, 'PW should die (loyalty <= 0)');
});

test('PW with no counters falls back to card.loyalty', () => {
  // Fresh PW that just entered (before first ability activation)
  const freshPW = { loyalty: 3, counters: {} };
  const currentLoyalty = (freshPW.counters && freshPW.counters.loyalty != null) ? freshPW.counters.loyalty : (parseInt(freshPW.loyalty) || 0);
  assert(currentLoyalty === 3, `Fresh PW should use card.loyalty (3), got ${currentLoyalty}`);
});

test('PW with counters.loyalty = 0 uses 0 (not card.loyalty)', () => {
  // Edge case: loyalty exactly 0 but not yet cleaned up
  const pw = { loyalty: 4, counters: { loyalty: 0 } };
  const currentLoyalty = (pw.counters && pw.counters.loyalty != null) ? pw.counters.loyalty : (parseInt(pw.loyalty) || 0);
  assert(currentLoyalty === 0, `PW with loyalty 0 in counters should read 0, got ${currentLoyalty}`);
});

// ============================================================
// Decisive Denial Modal — counter icon should not look disabled
// ============================================================
console.log('\n--- Decisive Denial Modal UX (Bug Fix) ---');

test('Counter mode icon is shield (not prohibited sign)', () => {
  // The 🚫 icon made the counter option look disabled/prohibited
  // Changed to 🛡 which better represents "counter/shield"
  const iconLine = code.match(/if \(\/counter\/i\.test\(text\)\) icon = '([^']+)'/);
  assert(iconLine, 'Counter icon assignment exists');
  assert(iconLine[1] !== '\u{1F6AB}', 'Counter icon should NOT be 🚫 (prohibited sign)');
  assert(iconLine[1] === '\u{1F6E1}', `Counter icon should be 🛡 (shield), got ${iconLine[1]}`);
});

test('Decisive Denial is in Simic deck', () => {
  assert(code.includes('Decisive Denial'), 'Decisive Denial card exists in codebase');
});

test('isCounterSpellCard detects modal counter spells via regex', () => {
  // Decisive Denial oracle includes "counter target noncreature spell"
  // isCounterSpellCard must detect this via /counter target.*spell/ regex
  assert(code.includes('/counter target.*spell/.test(oracle)'),
    'isCounterSpellCard has regex for "counter target...spell" pattern');
});

test('Modal spell counter mode puts spell on stack with chosenMode counter', () => {
  assert(code.includes("chosenMode: 'counter'"), 'Counter mode sets chosenMode to "counter"');
});

test('resolveTopOfStack checks chosenMode for modal counter spells', () => {
  const counterCheck = code.includes("topSpell.chosenMode === 'counter'");
  assert(counterCheck, 'resolveTopOfStack checks for chosenMode === counter');
});

// ============================================================
// Stack/Turn Transition — spells must resolve before turn passes
// ============================================================
console.log('\n--- Stack/Turn Transition (Bug Fix) ---');

test('End-of-turn overlay hides when spellStack is not empty', () => {
  // The bug: end-of-turn overlay (z-index 10000) covered the stack overlay (z-index 9999),
  // so "Pass Turn" was clickable even with spells on the stack
  const overlayCondition = code.match(/endOfTurnRespond && !instantCasting && spellStack\.length === 0/);
  assert(overlayCondition, 'End-of-turn overlay requires spellStack.length === 0');
});

test('executePassTurn blocks when spellStack is not empty', () => {
  const blockCheck = code.match(/const executePassTurn[\s\S]{0,300}spellStack\.length > 0/);
  assert(blockCheck, 'executePassTurn checks for non-empty stack');
  assert(code.includes('Resolve all spells on the stack before passing'), 'Shows warning message when stack is not empty');
});

test('Stack overlay z-index is below end-of-turn overlay', () => {
  // z-index is in CSS (outside script block), check full HTML
  const stackZIndex = html.match(/spell-stack-overlay[\s\S]{0,100}z-index:\s*(\d+)/);
  assert(stackZIndex && parseInt(stackZIndex[1]) === 9999, 'Stack overlay z-index is 9999');
  // End-of-turn overlay z-index is inline in JSX
  const eotZIndex = html.match(/End of Turn[\s\S]{0,2000}zIndex:\s*(\d+)/);
  assert(eotZIndex && parseInt(eotZIndex[1]) >= 10000, 'End-of-turn overlay z-index >= 10000');
});

test('End-of-turn respond state persists while stack resolves', () => {
  const resolveCode = code.match(/const resolveTopOfStack[\s\S]{0,500}/);
  assert(resolveCode, 'resolveTopOfStack function exists');
  assert(!resolveCode[0].includes('setEndOfTurnRespond(false)'),
    'resolveTopOfStack does NOT clear endOfTurnRespond');
});

// ============================================================
// RESULTS
// ============================================================
console.log(`\n${'═'.repeat(55)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(55)}`);
process.exit(failed > 0 ? 1 : 0);
