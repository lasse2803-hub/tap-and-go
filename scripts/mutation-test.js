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
const TESTS = 'node --test test/engine.test.js test/engine.redaggro.test.js';

const MUTATIONS = [
  // ── Core rules (M1) ──
  [GAME, 'trample excess not dealt', 'if (rem > 0 && trample && defTarget) dmg.push({ source: A, target: defTarget, n: rem });', ''],
  [GAME, 'first strike ignored', 'if (firstStrikeStep) return fs || ds;', 'if (firstStrikeStep) return false;'],
  [GAME, 'summoning sickness ignored', "&& (!c.sick || hasKw(c, 'haste')) && !hasKw(c, 'defender'));", "&& !hasKw(c, 'defender'));"],
  [GAME, 'resolved spell vanishes', 'else s.players[card.owner].graveyard.push(card);', 'else {}'],
  [GAME, 'deathtouch not lethal', '(c.deathtouched && c.damage > 0)', 'false'],
  [GAME, 'flying evasion removed', "if (hasKw(attacker, 'flying') && !hasKw(blocker, 'flying') && !hasKw(blocker, 'reach')) return false;", ''],
  [GAME, 'two lands per turn allowed', 's.players[p].landsPlayed < 1;', 's.players[p].landsPlayed < 2;'],
  [GAME, 'legend rule off', 'if (!baseChar(c).isLegendary) continue;', 'continue;'],
  [GAME, 'lifelink off', "if (source && hasKw(source, 'lifelink')) gainLife(s, source.controller, ev.n);", ''],
  [GAME, 'stack resolves bottom first', 'const item = s.stack[s.stack.length - 1];', 'const item = s.stack[0];'],
  // ── M2 machinery ──
  [GAME, 'prowess triggers on creature spells', 'match: (s, ev, c) => ev.player === c.controller && ev.noncreature,', 'match: (s, ev, c) => ev.player === c.controller,'],
  [GAME, 'until-end-of-turn effects never end', "c.mods = modsOf(c).filter(m => m.until !== 'eot');", ''],
  [GAME, 'delayed end-of-combat triggers never fire', 'for (const d of due) s.triggerQueue.push(', 'for (const d of []) s.triggerQueue.push('],
  [GAME, 'adventure goes to graveyard', "if (item.face === 'adventure' && resolved) {", 'if (false) {'],
  [GAME, 'spectacle always available', 'spectacle: (s, p) => s.players[1 - p].lostLifeThisTurn,', 'spectacle: () => true,'],
  [GAME, 'impulse draw expires a turn early', 'const untilTurn = s.active === p ? s.turn + 2 : s.turn + 1;', 'const untilTurn = s.turn + 1;'],
  [GAME, 'enters-tapped ignored', 'if (st.etbTapped && st.etbTapped(s, card, controller, { isType })) card.tapped = true;', ''],
  [GAME, "can't block ignored", '&& !c.tapped && !staticOf(c).cantBlock);', '&& !c.tapped);'],
  [GAME, 'becomes-target event never emitted', "for (const t of targets) if (t.kind === 'perm') emit(", "for (const t of []) if (t.kind === 'perm') emit("],
  [GAME, 'scry bottom puts cards on top', 'lib.push(...bottom.map(byId));', 'lib.unshift(...bottom.map(byId));'],
  [GAME, '"this turn" life loss never resets', 'for (const P of s.players) P.lostLifeThisTurn = false;', ''],
  [GAME, 'trigger targets auto-picked, never asked', 'if (combos.length > 1) {', 'if (false) {'],
  // ── Card implementations ──
  [CARDS, 'Phoenix Chick returns on 2 attackers', 'ev.player === c.owner && ev.count >= 3', 'ev.player === c.owner && ev.count >= 2'],
  [CARDS, 'Soul-Scar also replaces combat damage', 'if (ev.combat || ev.asCounters ||', 'if (ev.asCounters ||'],
];

const originals = new Map([GAME, CARDS].map(f => [f, fs.readFileSync(f, 'utf8')]));
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
