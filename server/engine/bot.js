/**
 * Bots for the simulator. They only ever pick from legalActions(s) (or fill a
 * template with choices the engine then validates) — a bot can't cheat, so any
 * illegal state reached is an engine bug.
 *
 *  'chaos'    uniformly random legal choices — explores odd corners of the engine.
 *  'sensible' plays like a simple human — lands first, spends mana, attacks, blocks
 *             sensibly — so games look like real games and actually finish.
 */
const R = require('./rng');
const db = require('./cardDb');
const G = require('./game');

const isLandName = (n) => db.char(n).is('Land');
const cardIn = (s, id) => {
  for (const p of [0, 1]) for (const z of ['hand', 'library', 'graveyard', 'exile']) {
    const c = s.players[p][z].find(x => x.id === id); if (c) return c;
  }
  return G.find(s, id);
};

function randomSubset(rng, ids, k) {
  return R.shuffle(rng, ids.slice()).slice(0, k);
}

// ─── Template filling (shared) ──────────────────────────────────────────────
function fillBlocks(s, rng, tpl, wantBlock) {
  const attackers = tpl.attackers.map(id => G.find(s, id)).filter(Boolean);
  const blocks = [];
  for (const bid of R.shuffle(rng, tpl.eligible.slice())) {
    const B = G.find(s, bid);
    const options = attackers.filter(A => G.canBlock(B, A) && wantBlock(B, A));
    if (options.length) blocks.push({ blocker: bid, attacker: R.pick(rng, options).id });
  }
  // Menace: a lone blocker on a menace attacker is illegal — drop it.
  return blocks.filter(b => !(G.hasKw(G.find(s, b.attacker), 'menace') && blocks.filter(x => x.attacker === b.attacker).length === 1));
}

// ─── Chaos ──────────────────────────────────────────────────────────────────
function chaos(s, actions, rng) {
  const a = R.pick(rng, actions);
  if (!a.template) return a;
  switch (a.type) {
    case 'bottom':
    case 'discard':
      return { type: a.type, player: a.player, cardIds: randomSubset(rng, a.options, a.count) };
    case 'declareAttackers':
      return { type: a.type, player: a.player, attackers: a.eligible.filter(() => R.rand(rng) < 0.5).map(id => ({ id, target: R.pick(rng, a.targets) })) };
    case 'declareBlockers':
      return { type: a.type, player: a.player, blocks: fillBlocks(s, rng, a, () => R.rand(rng) < 0.5) };
    case 'scry': {
      const cards = R.shuffle(rng, a.cards.slice());
      const k = R.int(rng, cards.length + 1);
      return { type: 'scry', player: a.player, top: cards.slice(0, k), bottom: cards.slice(k) };
    }
    default: throw new Error(`chaos: unknown template ${a.type}`);
  }
}

// ─── Sensible ───────────────────────────────────────────────────────────────
function sensible(s, actions, rng) {
  const first = actions[0];
  const p = first.player;
  const P = s.players[p];
  const opp = 1 - p;

  switch (first.type) {
    case 'keep':
    case 'mulligan': {
      const lands = P.hand.filter(c => isLandName(c.name)).length;
      const ok = (lands >= 2 && lands <= 5) || P.mulligans >= 2;
      return actions.find(a => a.type === (ok ? 'keep' : 'mulligan')) || first;
    }
    case 'bottom':
    case 'discard': {
      const lands = P.hand.filter(c => isLandName(c.name));
      const spells = P.hand.filter(c => !isLandName(c.name)).sort((a, b) => db.char(b.name).cmc - db.char(a.name).cmc);
      // Drop excess lands when flooded, else the most expensive spells.
      const order = lands.length > 3 ? [...lands, ...spells] : [...spells, ...lands];
      return { type: first.type, player: p, cardIds: order.slice(0, first.count).map(c => c.id) };
    }
    case 'declareAttackers': {
      const blockers = s.battlefield.filter(c => c.controller === opp && G.isType(c, 'Creature') && !c.tapped);
      const attackers = first.eligible.filter(id => {
        const A = G.find(s, id);
        const pow = G.powerOf(s, A);
        if (pow <= 0) return false;
        // Attack unless an untapped blocker would kill it without dying.
        const badBlock = blockers.some(B => G.canBlock(B, A) && G.powerOf(s, B) >= G.toughOf(s, A) && G.toughOf(s, B) > pow);
        return !badBlock || R.rand(rng) < 0.2;
      });
      return { type: first.type, player: p, attackers: attackers.map(id => ({ id, target: 'player' })) };
    }
    case 'declareBlockers': {
      const incoming = first.attackers.reduce((n, id) => n + Math.max(0, G.powerOf(s, G.find(s, id))), 0);
      const desperate = incoming >= P.life - 3;
      return {
        type: first.type, player: p,
        blocks: fillBlocks(s, rng, first, (B, A) => {
          const kills = G.powerOf(s, B) >= G.toughOf(s, A);
          const survives = G.toughOf(s, B) > G.powerOf(s, A);
          return survives || kills || desperate;
        }),
      };
    }
    case 'chooseTargets': {
      const good = actions.filter(a => goodTargets(s, a.targets, opp));
      return R.pick(rng, good.length ? good : actions);
    }
    case 'choose':
      return actions.find(a => a.option === 'pay') || first;
    case 'scry': {
      const landsOut = s.battlefield.filter(c => c.controller === p && G.isType(c, 'Land')).length;
      const keep = (id) => {
        const c = cardIn(s, id);
        const ch = db.char(c.name);
        return ch.is('Land') ? landsOut < 5 : ch.cmc <= landsOut + 1;
      };
      return { type: 'scry', player: p, top: first.cards.filter(keep), bottom: first.cards.filter(id => !keep(id)) };
    }
    default: break;
  }

  // Priority. Lands first — exiled "may play" cards before they expire.
  const lands = actions.filter(a => a.type === 'playLand');
  if (lands.length) return lands.find(a => P.exile.some(c => c.id === a.cardId)) || lands[0];
  const casts = actions.filter(a => a.type === 'cast');
  const myMain = s.active === p && (s.step === 'main1' || s.step === 'main2') && s.stack.length === 0;
  const sane = casts.filter(a => goodTargets(s, a.targets, opp));
  if (sane.length) {
    if (myMain) {
      const cmc = (a) => db.char(cardIn(s, a.cardId).name).cmc;
      const best = Math.max(...sane.map(cmc));
      const top = sane.filter(a => cmc(a) === best);
      const cheap = top.filter(a => a.alt); // e.g. spectacle: same spell, less mana
      return R.pick(rng, cheap.length ? cheap : top);
    }
    // Instant-speed play outside own main phase, now and then (exercises the stack).
    if (R.rand(rng) < 0.25) return R.pick(rng, sane);
  }
  // Activated abilities (e.g. animate a creature land before combat), once per permanent.
  const acts = actions.filter(a => a.type === 'activate' && !(G.find(s, a.cardId).mods || []).length);
  if (acts.length && s.active === p && s.step === 'beginCombat' && R.rand(rng) < 0.6) return R.pick(rng, acts);
  return actions.find(a => a.type === 'pass');
}

function goodTargets(s, targets, opp) {
  return targets.every(t => (t.kind === 'player' ? t.player === opp : (G.find(s, t.id) || {}).controller === opp));
}

function makeBot(policy, seed) {
  const rng = { rng: R.seedState(seed) };
  const fn = policy === 'chaos' ? chaos : sensible;
  return (s, actions) => fn(s, actions, rng);
}

module.exports = { makeBot };
