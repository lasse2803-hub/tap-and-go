#!/usr/bin/env node
/**
 * Mutation test for the rules engine: injects deliberate rules bugs one at a time and
 * checks that the engine test suite FAILS for each. A test suite that stays green when
 * the rules are broken is worthless — this proves ours isn't.
 *
 *   npm run mutation-test
 *
 * Every mutated file is restored afterwards (also on crash). When engine code changes
 * and a pattern no longer matches, the script reports it ("pattern not found") — update
 * the pattern rather than dropping the mutation.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const GAME = path.join(ROOT, 'server/engine/game.js');
const CARDS = path.join(ROOT, 'server/engine/cards/index.js');
const TESTS = 'node --test test/engine.test.js test/engine.redaggro.test.js test/engine.whiteknight.test.js';

const MUTATIONS = [
  // ── Core rules (M1) ──
  [GAME, 'trample excess not dealt', 'if (rem > 0 && trample && defTarget) dmg.push({ source: A, target: defTarget, n: rem });', ''],
  [GAME, 'first strike ignored', 'if (firstStrikeStep) return fs || ds;', 'if (firstStrikeStep) return false;'],
  [GAME, "summoning sickness ignored", "&& (!c.sick || hasKw(c, 'haste')) && !hasKw(c, 'defender') && !restricted(s, c, 'cantAttack'));", "&& !hasKw(c, 'defender') && !restricted(s, c, 'cantAttack'));"],
  [GAME, 'resolved spell vanishes', 'else s.players[card.owner].graveyard.push(card);', 'else {}'],
  [GAME, 'deathtouch not lethal', '(c.deathtouched && c.damage > 0)', 'false'],
  [GAME, 'flying evasion removed', "if (hasKw(attacker, 'flying') && !hasKw(blocker, 'flying') && !hasKw(blocker, 'reach')) return false;", ''],
  [GAME, 'two lands per turn allowed', 's.players[p].landsPlayed < 1;', 's.players[p].landsPlayed < 2;'],
  [GAME, 'legend rule off', 'if (!baseChar(c).isLegendary) continue;', 'continue;'],
  [GAME, "lifelink off", "if (source && hasKw(source, 'lifelink')) {", "if (false) {"],
  [GAME, 'stack resolves bottom first', 'const item = s.stack[s.stack.length - 1];', 'const item = s.stack[0];'],
  // ── M2 machinery ──
  [GAME, 'prowess triggers on creature spells', 'match: (s, ev, c) => ev.player === c.controller && ev.noncreature,', 'match: (s, ev, c) => ev.player === c.controller,'],
  [GAME, "until-end-of-turn effects never end", "c.mods = modsOf(c).filter(m => m.until !== 'eot' && modActive(s, c, m));", "c.mods = modsOf(c).filter(m => modActive(s, c, m));"],
  [GAME, 'delayed end-of-combat triggers never fire', 'for (const d of due) s.triggerQueue.push(', 'for (const d of []) s.triggerQueue.push('],
  [GAME, 'adventure goes to graveyard', "if (item.face === 'adventure' && resolved) {", 'if (false) {'],
  [GAME, 'spectacle always available', 'spectacle: (s, p) => s.players[1 - p].lostLifeThisTurn,', 'spectacle: () => true,'],
  [GAME, 'impulse draw expires a turn early', 'const untilTurn = s.active === p ? s.turn + 2 : s.turn + 1;', 'const untilTurn = s.turn + 1;'],
  [GAME, "enters-tapped ignored", "if (st.etbTapped && st.etbTapped(s, card, controller, helpers(s))) card.tapped = true;", ""],
  [GAME, "can't block ignored", "&& !staticOf(c).cantBlock && !restricted(s, c, 'cantBlock'));", "&& !restricted(s, c, 'cantBlock'));"],
  [GAME, "becomes-target event never emitted", "for (const t of targets) if (t && t.kind === 'perm') emit(", "for (const t of []) if (t && t.kind === 'perm') emit("],
  [GAME, 'scry bottom puts cards on top', 'lib.push(...bottom.map(byId));', 'lib.unshift(...bottom.map(byId));'],
  [GAME, '"this turn" life loss never resets', 'for (const P of s.players) P.lostLifeThisTurn = false;', ''],
  [GAME, 'trigger targets auto-picked, never asked', 'if (combos.length > 1) {', 'if (false) {'],
  // ── M2 machinery for White Knight ──
  [GAME, 'Thalia tax ignored', 'if (st.spellCostDelta) n += st.spellCostDelta(', 'if (false) n += st.spellCostDelta('],
  [GAME, 'simultaneous lifelink = separate events', 'if (opts.gains) opts.gains[source.controller] += ev.n; else gainLife(s, source.controller, ev.n);', 'gainLife(s, source.controller, ev.n);'],
  [GAME, 'loyalty usable twice per turn', 'if (c.loyaltyUsedTurn === s.turn) return false;', ''],
  [GAME, 'Emperor instant-speed loyalty ignored', 'const instant = st.loyaltyInstantSpeed && st.loyaltyInstantSpeed(s, c);', 'const instant = false;'],
  [GAME, '"until it leaves" exile never returns', 'for (const rid of returning) {', 'for (const rid of []) {'],
  [GAME, 'leaves-the-battlefield triggers never fire', "if (a.kind !== 'trigger' || a.on !== 'ltb') continue;", 'continue;'],
  [GAME, '"up to one" cannot choose nothing', 'const opts = normSpec(e).upTo ? [null, ...ts] : ts;', 'const opts = ts;'],
  [GAME, "can't-attack restrictions ignored", 'const restricted = (s, c, flag) => modsOf(c).some(m => m[flag] && modActive(s, c, m));', 'const restricted = () => false;'],
  [GAME, '"for as long as" never ends', 'return !!src && src.controller === c.controller;', 'return true;'],
  [GAME, 'training ignores power', 'return a.id !== c.id && o && powerOf(s, o) > powerOf(s, c);', 'return a.id !== c.id && o;'],
  [GAME, 'battle cry pumps itself', 'if (a.id !== ctx.sourceId) fx.pump(a.id, 1, 0);', 'fx.pump(a.id, 1, 0);'],
  [GAME, 'counter-removal cost not paid', 'if (a.removeCounters) for (const id of action.removeFrom) find(s, id).counters[a.removeCounters.type] -= 1;', ''],
  [GAME, 'sacrifice cost not paid', "if (a.sacrifice) leaveBattlefield(s, c.id, 'graveyard');", ''],
  // ── Card implementations ──
  [CARDS, 'Phoenix Chick returns on 2 attackers', 'ev.player === c.owner && ev.count >= 3', 'ev.player === c.owner && ev.count >= 2'],
  [CARDS, 'Soul-Scar also replaces combat damage', 'if (ev.combat || ev.asCounters ||', 'if (ev.asCounters ||'],
  [CARDS, 'Heliod creature at devotion 4', "h.devotion(card.controller, 'W') < 5", "h.devotion(card.controller, 'W') < 4"],
  [CARDS, "Luminarch triggers on opponent's turn", "on: 'beginCombat', match: (s, ev, c) => ev.player === c.controller,", "on: 'beginCombat', match: () => true,"],
  [CARDS, 'Fateful Absence: caster investigates', 'fx.investigate(controller);', 'fx.investigate(ctx.controller);'],
  [CARDS, 'Adeline does not count tokens', "c.controller === card.controller && h.isType(c, 'Creature')).length", "c.controller === card.controller && !c.token && h.isType(c, 'Creature')).length"],
  [CARDS, 'Extraction Specialist reaches MV 3', "h.isCardType(c, 'Creature') && h.mv(c) <= 2", "h.isCardType(c, 'Creature') && h.mv(c) <= 3"],
];

const originals = new Map([GAME, CARDS].map(f => [f, fs.readFileSync(f, 'utf8')]));

// --check: only report mutations whose pattern no longer matches the code (fast).
if (process.argv.includes('--check')) {
  const stale = MUTATIONS.filter(([file, , from]) => !originals.get(file).includes(from)).map(m => m[1]);
  console.log(stale.length ? `Stale patterns:\n  ${stale.join('\n  ')}` : `All ${MUTATIONS.length} patterns match.`);
  process.exit(stale.length ? 1 : 0);
}
const restore = () => { for (const [f, src] of originals) fs.writeFileSync(f, src); };
process.on('SIGINT', () => { restore(); process.exit(130); });

let caught = 0, missing = 0;
try {
  for (const [file, label, from, to] of MUTATIONS) {
    const src = originals.get(file);
    if (!src.includes(from)) { missing++; console.log(`??       ${label.padEnd(44)} pattern not found — update it`); continue; }
    fs.writeFileSync(file, src.replace(from, to));
    let out = '';
    try { out = execSync(TESTS, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }); } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
    fs.writeFileSync(file, src);
    const fail = +((out.match(/ℹ fail (\d+)/) || [0, 0])[1]);
    if (fail > 0) caught++;
    console.log(`${fail > 0 ? 'CAUGHT ' : 'MISSED!'}  ${label.padEnd(44)} → ${fail} failing test(s)`);
  }
} finally { restore(); }

const total = MUTATIONS.length;
console.log(`\n${caught}/${total} injected bugs caught${missing ? `, ${missing} pattern(s) missing` : ''}. Files restored.`);
process.exitCode = caught === total ? 0 : 1;
