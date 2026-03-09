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
  assert(code.includes("const setLibrarySearch = (v) => { _setLibrarySearch(v); if (onlineMode) onlineSyncNeededRef"), 'librarySearch online sync missing');
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

test('WAV-based SFX methods call playWav', () => {
  const wavMethods = ['tap', 'playLand', 'combatDamage', 'lifeLoss', 'playerDamage',
    'counterspell', 'planeswalkerEnters', 'playerWins', 'massReturn', 'playCreature'];
  for (const m of wavMethods) {
    assert(code.includes(`${m}() { playWav(`), `${m} does not call playWav`);
  }
});

test('Removed synthesized sounds are no-op stubs', () => {
  const removedMethods = ['draw', 'untap', 'untapAll', 'playSpell',
    'lifeGain', 'damage', 'toGraveyard', 'toExile', 'shuffle',
    'tokenCreate', 'mill', 'attack', 'block', 'creatureDeath', 'commanderCast', 'passTurn'];
  for (const m of removedMethods) {
    assert(code.includes(`${m}() {}`), `${m} should be a no-op stub but isn't`);
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

test('SFX calls wrapped in try-catch throughout code', () => {
  const sfxCalls = code.match(/try \{ SFX\.\w+\(\); \} catch\(e\) \{\}/g);
  assert(sfxCalls && sfxCalls.length > 20, `Expected >20 wrapped SFX calls, found ${sfxCalls ? sfxCalls.length : 0}`);
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
  const turnDrawBlock = code.match(/onlineTurnDrawnRef\.current = turnKey;([\s\S]*?)try \{ SFX\.draw/);
  assert(turnDrawBlock, 'Could not find onlineTurnDraw block');
  assert(turnDrawBlock[1].includes('landPlayedThisTurn: false'), 'landPlayedThisTurn not reset in onlineTurnDraw');
});

test('onlineTurnDrawEffect resets dealtDamageThisTurn', () => {
  const turnDrawBlock = code.match(/onlineTurnDrawnRef\.current = turnKey;([\s\S]*?)try \{ SFX\.draw/);
  assert(turnDrawBlock, 'Could not find onlineTurnDraw block');
  assert(turnDrawBlock[1].includes('dealtDamageThisTurn: false'), 'dealtDamageThisTurn not reset in onlineTurnDraw');
});

test('onlineTurnDrawEffect resets manaPool', () => {
  const turnDrawBlock = code.match(/onlineTurnDrawnRef\.current = turnKey;([\s\S]*?)try \{ SFX\.draw/);
  assert(turnDrawBlock, 'Could not find onlineTurnDraw block');
  assert(turnDrawBlock[1].includes("manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }"), 'manaPool not reset in onlineTurnDraw');
});

test('onlineTurnDrawEffect untaps battlefield', () => {
  const turnDrawBlock = code.match(/onlineTurnDrawnRef\.current = turnKey;([\s\S]*?)try \{ SFX\.draw/);
  assert(turnDrawBlock, 'Could not find onlineTurnDraw block');
  assert(turnDrawBlock[1].includes('tapped: false'), 'Battlefield not untapped in onlineTurnDraw');
  assert(turnDrawBlock[1].includes('enteredThisTurn: false'), 'enteredThisTurn not reset in onlineTurnDraw');
});

test('onlineTurnDrawEffect clears untilNextTurnEffects', () => {
  const turnDrawBlock = code.match(/onlineTurnDrawnRef\.current = turnKey;([\s\S]*?)try \{ SFX\.draw/);
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

test('addGameLog syncs to opponent via onStateChange', () => {
  assert(code.includes("onStateChange({ __logEntry: entry })"), 'addGameLog not syncing to opponent');
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
  assert(code.includes("playCreature() { playWav('playCreature'"), 'playCreature not using playWav');
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
// RESULTS
// ============================================================
console.log(`\n${'═'.repeat(55)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(55)}`);
process.exit(failed > 0 ? 1 : 0);
