#!/usr/bin/env node
/**
 * Game simulator — plays complete bot-vs-bot games across every deck pairing and
 * checks engine invariants after every single action.
 *
 *   node server/engine/sim.js                        # 1000 games, mixed bots
 *   node server/engine/sim.js --games 5000 --seed 42 --policy chaos
 *   node server/engine/sim.js --replay 137 --decks "Red Aggro|Blue Control" --policy sensible --verbose
 *   node server/engine/sim.js --json /path/report.json
 *
 * Every failure prints the seed + decks + policies needed to replay it exactly.
 */
const { createGame, legalActions, applyAction, unimplementedText } = require('./game');
const { checkInvariants } = require('./invariants');
const { makeBot } = require('./bot');
const { DECKS } = require('./cardDb');

function runGame({ decks, seed, policies, maxTurns = 200, verbose = false }) {
  const s = createGame({ decks, seed });
  const bots = [makeBot(policies[0], seed * 2 + 1), makeBot(policies[1], seed * 2 + 2)];
  const recent = [];
  let n = 0;
  while (!s.over) {
    if (s.turn > maxTurns) { s.timeout = true; break; }
    if (++n > 200000) throw Object.assign(new Error('action cap exceeded (possible loop)'), { recent });
    const acts = legalActions(s);
    const action = bots[s.pending.player](s, acts);
    recent.push({ turn: s.turn, step: s.step, action });
    if (recent.length > 25) recent.shift();
    if (verbose) console.log(`T${s.turn} ${s.step.padEnd(17)} P${action.player} ${JSON.stringify(action)}`);
    try {
      applyAction(s, action);
    } catch (e) { e.recent = recent; throw e; }
    const v = checkInvariants(s);
    if (v.length) throw Object.assign(new Error(`invariant violated: ${v[0]}`), { violations: v, recent });
  }
  return s;
}

function parseArgs(argv) {
  const a = { games: 1000, seed: 1, policy: 'mixed', maxTurns: 200 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--games') { a.games = +v; i++; } else if (k === '--seed') { a.seed = +v; i++; }
    else if (k === '--policy') { a.policy = v; i++; } else if (k === '--max-turns') { a.maxTurns = +v; i++; }
    else if (k === '--replay') { a.replay = +v; i++; } else if (k === '--decks') { a.decks = v.split('|'); i++; }
    else if (k === '--json') { a.json = v; i++; } else if (k === '--verbose') a.verbose = true;
  }
  return a;
}

const policiesFor = (policy, g) => policy === 'mixed'
  ? [['sensible', 'sensible'], ['chaos', 'chaos'], ['sensible', 'chaos'], ['chaos', 'sensible']][g % 4]
  : [policy, policy];

function main() {
  const args = parseArgs(process.argv.slice(2));
  const names = DECKS.map(d => d.name);

  if (args.replay !== undefined) {
    const decks = args.decks || [names[0], names[1]];
    const pol = args.policy === 'mixed' ? ['sensible', 'sensible'] : [args.policy, args.policy];
    const s = runGame({ decks, seed: args.replay, policies: pol, maxTurns: args.maxTurns, verbose: args.verbose });
    console.log(`Result: winner=${s.winner} reason=${s.reason || (s.timeout ? 'turn cap' : '?')} turns=${s.turn} life=${s.players.map(p => p.life)}`);
    return;
  }

  const t0 = Date.now();
  const r = { games: 0, finished: 0, draws: 0, timeouts: 0, failures: [], turns: 0, actions: 0, reasons: {}, deckWins: {}, deckGames: {}, unimpl: {} };
  for (let g = 0; g < args.games; g++) {
    const i = g % (names.length * names.length);
    const decks = [names[Math.floor(i / names.length)], names[i % names.length]];
    const seed = args.seed + g;
    const policies = policiesFor(args.policy, g);
    r.games++;
    try {
      const s = runGame({ decks, seed, policies, maxTurns: args.maxTurns });
      r.turns += s.turn;
      r.actions += s.stats.actions;
      for (const d of decks) r.deckGames[d] = (r.deckGames[d] || 0) + 1;
      if (s.timeout) r.timeouts++;
      else {
        r.finished++;
        const reason = (s.reason || '').replace(/P\d /g, '').replace(/-?\d+ life/, '≤0 life');
        r.reasons[reason] = (r.reasons[reason] || 0) + 1;
        if (s.winner === null) r.draws++; else r.deckWins[decks[s.winner]] = (r.deckWins[decks[s.winner]] || 0) + 1;
      }
      for (const src of [s.stats.enteredWithoutImpl, s.stats.resolvedWithoutImpl]) {
        for (const [name, n] of Object.entries(src)) r.unimpl[name] = (r.unimpl[name] || 0) + n;
      }
    } catch (e) {
      r.failures.push({ seed, decks, policies, error: e.message, violations: e.violations, recent: e.recent && e.recent.slice(-8) });
    }
  }
  const ms = Date.now() - t0;

  console.log(`\n═══ Simulation: ${r.games} games, ${names.length} decks, policy=${args.policy}, seeds ${args.seed}..${args.seed + args.games - 1} ═══`);
  console.log(`Finished:   ${r.finished}  (draws ${r.draws})`);
  console.log(`Turn cap:   ${r.timeouts}`);
  console.log(`FAILURES:   ${r.failures.length}  (crashes + invariant violations)`);
  console.log(`Avg turns:  ${(r.turns / Math.max(1, r.games - r.failures.length)).toFixed(1)}   avg actions: ${(r.actions / Math.max(1, r.games - r.failures.length)).toFixed(0)}   ${(ms / r.games).toFixed(1)} ms/game`);
  console.log('End reasons:', Object.entries(r.reasons).map(([k, v]) => `${k}: ${v}`).join(' | '));
  if (r.failures.length) {
    console.log('\nFirst failures (replay with --replay <seed> --decks "A|B" --policy <p> --verbose):');
    for (const f of r.failures.slice(0, 5)) {
      console.log(`  seed ${f.seed}  ${f.decks.join(' vs ')}  [${f.policies.join('/')}]\n    ${f.error}`);
      if (f.violations && f.violations.length > 1) console.log(`    (+${f.violations.length - 1} more violations)`);
    }
  }
  const backlog = Object.entries(r.unimpl).sort((a, b) => b[1] - a[1]);
  console.log(`\nCards played whose rules text is not implemented yet: ${backlog.length} (M2 backlog, by frequency)`);
  for (const [name, n] of backlog.slice(0, 15)) console.log(`  ${String(n).padStart(6)}×  ${name.padEnd(30)} ${(unimplementedText(name) || '').slice(0, 70)}`);
  if (args.json) {
    require('fs').writeFileSync(args.json, JSON.stringify({ ...r, backlog: backlog.map(([name, n]) => ({ name, n, text: unimplementedText(name) })), ms }, null, 1));
    console.log(`\nFull report: ${args.json}`);
  }
  process.exitCode = r.failures.length ? 1 : 0;
}

if (require.main === module) main();
module.exports = { runGame };
