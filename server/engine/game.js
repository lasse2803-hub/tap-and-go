/**
 * Tap & Go rules engine (M1) — the single authority over a game.
 *
 * Pure game logic: no sockets, no UI, no randomness except the seeded RNG stored in
 * the state. The state is plain JSON (serializable, replayable from its seed).
 *
 *   const s = createGame({ decks: ['Red Aggro', 'Golgari Nissa Control'], seed: 7 });
 *   while (!s.over) applyAction(s, chooseFrom(legalActions(s)));
 *
 * Every step waits for a DECISION (s.pending = { player, kind }): mulligan, bottom,
 * priority, attackers, blockers, discard. legalActions(s) lists what the deciding
 * player may do (multi-select decisions return one template); applyAction(s, a)
 * validates fully and applies, then advances to the next decision.
 *
 * Scope M1: turn structure, priority & stack, mana payment, land drops, casting,
 * combat with core keywords, state-based actions, win/loss. Card-specific rules text
 * comes from explicit implementations in ./cards — anything not implemented is
 * counted in s.stats so it can be built in M2.
 */
const db = require('./cardDb');
const { parseCost, solvePayment } = require('./mana');
const R = require('./rng');
const IMPLS = require('./cards');

const STEPS = ['untap', 'upkeep', 'draw', 'main1', 'beginCombat', 'declareAttackers', 'declareBlockers',
  'firstStrikeDamage', 'combatDamage', 'endCombat', 'main2', 'end', 'cleanup'];
const MAX_HAND = 7;
const IMPLEMENTED_KEYWORDS = new Set(['flying', 'reach', 'trample', 'haste', 'vigilance', 'deathtouch', 'lifelink',
  'first strike', 'double strike', 'menace', 'indestructible', 'flash', 'hexproof', 'defender']);

// ─── Card helpers ────────────────────────────────────────────────────────────
const ch = (c) => db.char(c.name);
const isType = (c, t) => ch(c).is(t);
const hasKw = (c, kw) => ch(c).keywords.includes(kw);
const powerOf = (s, c) => db.num(ch(c).power) + (c.counters['+1/+1'] || 0) - (c.counters['-1/-1'] || 0);
const toughOf = (s, c) => db.num(ch(c).toughness) + (c.counters['+1/+1'] || 0) - (c.counters['-1/-1'] || 0);
const find = (s, id) => s.battlefield.find(c => c.id === id);

/** Rules text the engine does NOT yet execute for this card (null = fully handled). */
function unimplementedText(name) {
  if (IMPLS[name] && IMPLS[name].complete) return null;
  const c = db.char(name);
  const lines = c.oracle.replace(/\([^)]*\)/g, '').split('\n').map(l => l.trim()).filter(Boolean).filter(line => {
    const parts = line.replace(/\.$/, '').split(/,\s*/).map(p => p.toLowerCase());
    if (parts.every(p => IMPLEMENTED_KEYWORDS.has(p))) return false;
    if (/^\{T\}: Add [^.]*\.$/.test(line) && db.manaOptions(name)) return false;
    return true;
  });
  return lines.length ? lines.join(' / ') : null;
}

// ─── Creation ────────────────────────────────────────────────────────────────
function newCard(s, name, owner) {
  db.char(name); // validates the name
  return { id: `c${s.nextId++}`, name, owner, controller: owner, tapped: false, sick: false, damage: 0, deathtouched: false, counters: {} };
}

function blankState(seed) {
  return {
    seed, rng: R.seedState(seed),
    turn: 0, active: 0, step: 'mulligan', priority: null, passes: 0,
    players: [0, 1].map(i => ({ name: `P${i}`, deck: null, life: 20, poison: 0, library: [], hand: [], graveyard: [], exile: [],
      landsPlayed: 0, mulligans: 0, kept: false, drewFromEmpty: false, cardCount: 0 })),
    battlefield: [], stack: [], combat: null, pending: null,
    over: false, winner: null, reason: null, firstPlayer: 0, nextId: 1,
    stats: { actions: 0, casts: {}, resolvedWithoutImpl: {}, enteredWithoutImpl: {} },
  };
}

function createGame({ decks, seed = 1, names } = {}) {
  if (!Array.isArray(decks) || decks.length !== 2) throw new Error('createGame needs two deck names');
  const s = blankState(seed);
  for (const p of [0, 1]) {
    const P = s.players[p];
    P.deck = decks[p];
    if (names && names[p]) P.name = names[p];
    for (const { name, qty } of db.getDeck(decks[p]).cards) for (let i = 0; i < qty; i++) P.library.push(newCard(s, name, p));
    P.cardCount = P.library.length;
    R.shuffle(s, P.library);
  }
  s.firstPlayer = R.int(s, 2);
  s.active = s.firstPlayer;
  for (const p of [0, 1]) drawCards(s, p, 7);
  s.pending = { player: s.firstPlayer, kind: 'mulligan' };
  return s;
}

// ─── Zones ───────────────────────────────────────────────────────────────────
function resetCard(c) {
  c.controller = c.owner; c.tapped = false; c.sick = false; c.damage = 0; c.deathtouched = false; c.counters = {};
}

function drawCards(s, p, n) {
  const P = s.players[p];
  for (let i = 0; i < n; i++) {
    if (!P.library.length) { P.drewFromEmpty = true; return; }
    P.hand.push(P.library.shift());
  }
}

function enterBattlefield(s, card, controller) {
  resetCard(card);
  card.controller = controller;
  card.sick = true;
  if (isType(card, 'Planeswalker')) card.counters.loyalty = db.num(ch(card).loyalty);
  s.battlefield.push(card);
  if (unimplementedText(card.name)) s.stats.enteredWithoutImpl[card.name] = (s.stats.enteredWithoutImpl[card.name] || 0) + 1;
}

function leaveBattlefield(s, id, zone) {
  const i = s.battlefield.findIndex(c => c.id === id);
  if (i === -1) return null;
  const [card] = s.battlefield.splice(i, 1);
  if (s.combat) {
    s.combat.attackers = s.combat.attackers.filter(a => a.id !== id);
    s.combat.blocks = s.combat.blocks.filter(b => b.blocker !== id && b.attacker !== id);
  }
  resetCard(card);
  s.players[card.owner][zone].push(card);
  return card;
}

// ─── Effects API for card implementations (./cards) ──────────────────────────
function applyDamage(s, source, target, n) {
  if (!(n > 0)) return;
  if (target.kind === 'player') {
    s.players[target.player].life -= n;
  } else {
    const t = find(s, target.id);
    if (!t) return;
    if (isType(t, 'Creature')) { t.damage += n; if (source && hasKw(source, 'deathtouch')) t.deathtouched = true; }
    if (isType(t, 'Planeswalker')) t.counters.loyalty = (t.counters.loyalty || 0) - n;
  }
  if (source && hasKw(source, 'lifelink')) s.players[source.controller].life += n;
}

function makeFx(s) {
  return {
    damage: (source, target, n) => applyDamage(s, source, target, n),
    destroy: (id) => { const c = find(s, id); if (c && !hasKw(c, 'indestructible')) leaveBattlefield(s, id, 'graveyard'); },
    exile: (id) => { if (find(s, id)) leaveBattlefield(s, id, 'exile'); },
    draw: (p, n) => drawCards(s, p, n),
    loseLife: (p, n) => { s.players[p].life -= n; },
    gainLife: (p, n) => { s.players[p].life += n; },
    creatures: () => s.battlefield.filter(c => isType(c, 'Creature')),
  };
}

// ─── Targets ─────────────────────────────────────────────────────────────────
const targetSpec = (name) => (IMPLS[name] && IMPLS[name].spell && IMPLS[name].spell.targets) || [];

function isTargetLegal(s, caster, kind, t) {
  if (!t) return false;
  if (t.kind === 'player') return kind === 'any' && (t.player === 0 || t.player === 1);
  if (t.kind !== 'perm') return false;
  const c = find(s, t.id);
  if (!c) return false;
  if (c.controller !== caster && hasKw(c, 'hexproof')) return false;
  const cr = isType(c, 'Creature'), pw = isType(c, 'Planeswalker');
  if (kind === 'any' || kind === 'creatureOrPlaneswalker') return cr || pw;
  if (kind === 'creature') return cr;
  return false;
}

function legalTargets(s, caster, kind) {
  const out = [];
  if (kind === 'any') out.push({ kind: 'player', player: 0 }, { kind: 'player', player: 1 });
  for (const c of s.battlefield) { const t = { kind: 'perm', id: c.id }; if (isTargetLegal(s, caster, kind, t)) out.push(t); }
  return out;
}

// ─── Mana ────────────────────────────────────────────────────────────────────
function manaSources(s, p) {
  const out = [];
  for (const c of s.battlefield) {
    if (c.controller !== p || c.tapped) continue;
    const opts = db.manaOptions(c.name);
    if (!opts) continue;
    if (isType(c, 'Creature') && c.sick && !hasKw(c, 'haste')) continue;
    out.push({ id: c.id, options: opts });
  }
  return out;
}

function payFor(s, p, card, x) {
  return solvePayment(parseCost(ch(card).manaCost, x), manaSources(s, p), s.players[p].life);
}

function maxX(s, p, card) {
  for (let x = manaSources(s, p).length; x >= 0; x--) if (payFor(s, p, card, x)) return x;
  return -1;
}

// ─── Legality of priority actions ────────────────────────────────────────────
const isMain = (s) => s.step === 'main1' || s.step === 'main2';

function sorceryTiming(s, p) {
  return p === s.active && isMain(s) && s.stack.length === 0;
}

function canPlayLand(s, p, card) {
  if (!isType(card, 'Land')) return false;
  if (!s.players[p].hand.includes(card)) return false;
  return sorceryTiming(s, p) && s.players[p].landsPlayed < 1;
}

function canCastTiming(s, p, card) {
  if (isType(card, 'Land')) return false;
  const instantSpeed = isType(card, 'Instant') || hasKw(card, 'flash');
  return instantSpeed || sorceryTiming(s, p);
}

/** Concrete cast options for a card in hand: [{ targets, x }]. */
function castOptions(s, p, card) {
  if (!canCastTiming(s, p, card)) return [];
  const cost = parseCost(ch(card).manaCost, 0);
  const x = cost.hasX ? maxX(s, p, card) : 0;
  if (x < 0 || !payFor(s, p, card, x)) return [];
  let combos = [[]];
  for (const kind of targetSpec(card.name)) {
    const ts = legalTargets(s, p, kind);
    combos = combos.flatMap(prev => ts.map(t => [...prev, t]));
  }
  return combos.map(targets => ({ targets, x }));
}

// ─── Combat ──────────────────────────────────────────────────────────────────
function eligibleAttackers(s) {
  return s.battlefield.filter(c => c.controller === s.active && isType(c, 'Creature') && !c.tapped
    && (!c.sick || hasKw(c, 'haste')) && !hasKw(c, 'defender'));
}

function eligibleBlockers(s) {
  return s.battlefield.filter(c => c.controller !== s.active && isType(c, 'Creature') && !c.tapped);
}

function canBlock(blocker, attacker) {
  if (hasKw(attacker, 'flying') && !hasKw(blocker, 'flying') && !hasKw(blocker, 'reach')) return false;
  return true;
}

function combatHasFirstStrike(s) {
  if (!s.combat) return false;
  const ids = [...s.combat.attackers.map(a => a.id), ...s.combat.blocks.map(b => b.blocker)];
  return ids.some(id => { const c = find(s, id); return c && (hasKw(c, 'first strike') || hasKw(c, 'double strike')); });
}

function dealCombatDamage(s, firstStrikeStep) {
  const cb = s.combat;
  if (!cb) return;
  const deals = (c) => {
    const fs = hasKw(c, 'first strike'), ds = hasKw(c, 'double strike');
    if (firstStrikeStep) return fs || ds;
    return cb.hadFirstStrike ? (!fs || ds) : true;
  };
  const defender = 1 - s.active;
  const dmg = [];
  for (const atk of cb.attackers) {
    const A = find(s, atk.id);
    if (!A || !deals(A)) continue;
    const power = Math.max(0, powerOf(s, A));
    if (!power) continue;
    const blockerIds = cb.blocks.filter(b => b.attacker === A.id).map(b => b.blocker);
    const wasBlocked = blockerIds.length > 0 || (cb.blockedIds || []).includes(A.id);
    const blockers = blockerIds.map(id => find(s, id)).filter(Boolean);
    let defTarget = null;
    if (atk.target === 'player') defTarget = { kind: 'player', player: defender };
    else if (find(s, atk.target)) defTarget = { kind: 'perm', id: atk.target };
    if (!wasBlocked) { if (defTarget) dmg.push({ source: A, target: defTarget, n: power }); continue; }
    if (!blockers.length) { if (hasKw(A, 'trample') && defTarget) dmg.push({ source: A, target: defTarget, n: power }); continue; }
    let rem = power;
    const trample = hasKw(A, 'trample');
    blockers.forEach((B, i) => {
      if (rem <= 0) return;
      const lethal = hasKw(A, 'deathtouch') ? 1 : Math.max(0, toughOf(s, B) - B.damage);
      const last = i === blockers.length - 1;
      const n = (last && !trample) ? rem : Math.min(rem, lethal);
      if (n > 0) { dmg.push({ source: A, target: { kind: 'perm', id: B.id }, n }); rem -= n; }
    });
    if (rem > 0 && trample && defTarget) dmg.push({ source: A, target: defTarget, n: rem });
  }
  for (const b of cb.blocks) {
    const B = find(s, b.blocker), A = find(s, b.attacker);
    if (!B || !A || !deals(B)) continue;
    const p = Math.max(0, powerOf(s, B));
    if (p) dmg.push({ source: B, target: { kind: 'perm', id: A.id }, n: p });
  }
  // Combat damage is dealt simultaneously: compute everything first, then apply.
  for (const d of dmg) applyDamage(s, d.source, d.target, d.n);
  if (firstStrikeStep) cb.hadFirstStrike = true;
}

// ─── State-based actions ─────────────────────────────────────────────────────
function endGame(s, losers, reason) {
  s.over = true;
  s.pending = null;
  s.priority = null;
  s.winner = losers.length === 2 ? null : 1 - losers[0];
  s.reason = reason;
}

function checkSBA(s) {
  for (let guard = 0; guard < 100; guard++) {
    const losers = [], why = [];
    for (const p of [0, 1]) {
      const P = s.players[p];
      if (P.life <= 0) { losers.push(p); why.push(`P${p} at ${P.life} life`); }
      else if (P.poison >= 10) { losers.push(p); why.push(`P${p} has 10 poison`); }
      else if (P.drewFromEmpty) { losers.push(p); why.push(`P${p} drew from an empty library`); }
    }
    if (losers.length) { endGame(s, losers, why.join('; ')); return; }

    let changed = false;
    for (const c of s.battlefield.slice()) {
      if (isType(c, 'Creature')) {
        const t = toughOf(s, c);
        const lethal = c.damage >= t || (c.deathtouched && c.damage > 0);
        if (t <= 0 || (lethal && !hasKw(c, 'indestructible'))) { leaveBattlefield(s, c.id, 'graveyard'); changed = true; continue; }
      }
      if (isType(c, 'Planeswalker') && (c.counters.loyalty || 0) <= 0) { leaveBattlefield(s, c.id, 'graveyard'); changed = true; }
    }
    // Legend rule: keep the newest of each legendary name per controller.
    const seen = new Set();
    for (const c of s.battlefield.slice().reverse()) {
      if (!ch(c).isLegendary) continue;
      const key = `${c.controller}|${c.name}`;
      if (seen.has(key)) { leaveBattlefield(s, c.id, 'graveyard'); changed = true; } else seen.add(key);
    }
    if (!changed) return;
  }
  throw new Error('State-based actions did not stabilize');
}

// ─── Turn structure ──────────────────────────────────────────────────────────
function givePriority(s, p) {
  checkSBA(s); // 704.3: SBAs are checked whenever a player would receive priority
  if (s.over) return;
  s.priority = p;
  s.pending = { player: p, kind: 'priority' };
}

function goToStep(s, step) {
  s.step = step;
  s.passes = 0;
  s.pending = null;
  runStep(s);
}

/** Turn-based actions of the current step; stops at the next decision. */
function runStep(s) {
  for (;;) {
    if (s.over) return;
    const a = s.active;
    switch (s.step) {
      case 'untap':
        for (const c of s.battlefield) if (c.controller === a) { c.tapped = false; c.sick = false; }
        s.players[a].landsPlayed = 0;
        s.step = 'upkeep';
        continue;
      case 'draw':
        if (s.turn > 1) drawCards(s, a, 1); // the starting player skips their first draw
        return givePriority(s, a);
      case 'declareAttackers':
        if (!eligibleAttackers(s).length) { s.combat = { attackers: [], blocks: [] }; return givePriority(s, a); }
        s.pending = { player: a, kind: 'attackers' };
        return;
      case 'declareBlockers':
        if (eligibleBlockers(s).some(b => s.combat.attackers.some(at => { const A = find(s, at.id); return A && canBlock(b, A); }))) {
          s.pending = { player: 1 - a, kind: 'blockers' };
          return;
        }
        return givePriority(s, a);
      case 'firstStrikeDamage':
        dealCombatDamage(s, true);
        return givePriority(s, a);
      case 'combatDamage':
        dealCombatDamage(s, false);
        return givePriority(s, a);
      case 'cleanup': {
        const excess = s.players[a].hand.length - MAX_HAND;
        if (excess > 0) { s.pending = { player: a, kind: 'discard', count: excess }; return; }
        for (const c of s.battlefield) { c.damage = 0; c.deathtouched = false; }
        s.combat = null;
        s.active = 1 - a;
        s.turn += 1;
        s.step = 'untap';
        continue;
      }
      default: // upkeep, main1, beginCombat, endCombat, main2, end
        return givePriority(s, a);
    }
  }
}

function nextStep(s) {
  switch (s.step) {
    case 'declareAttackers':
      return goToStep(s, s.combat && s.combat.attackers.length ? 'declareBlockers' : 'endCombat');
    case 'declareBlockers':
      return goToStep(s, combatHasFirstStrike(s) ? 'firstStrikeDamage' : 'combatDamage');
    case 'endCombat':
      s.combat = null;
      return goToStep(s, 'main2');
    default:
      return goToStep(s, STEPS[STEPS.indexOf(s.step) + 1]);
  }
}

function startFirstTurn(s) {
  s.turn = 1;
  s.active = s.firstPlayer;
  goToStep(s, 'untap');
}

// ─── Stack ───────────────────────────────────────────────────────────────────
function resolveTop(s) {
  const item = s.stack.pop();
  const card = item.card;
  const c = ch(card);
  if (c.isPermanent) {
    enterBattlefield(s, card, item.controller);
    return;
  }
  const impl = IMPLS[card.name];
  if (impl && impl.spell) {
    const spec = targetSpec(card.name);
    const allIllegal = spec.length > 0 && item.targets.every((t, i) => !isTargetLegal(s, item.controller, spec[i], t));
    if (!allIllegal) {
      impl.spell.resolve(makeFx(s), { controller: item.controller, targets: item.targets, x: item.x, source: card });
    }
  } else {
    s.stats.resolvedWithoutImpl[card.name] = (s.stats.resolvedWithoutImpl[card.name] || 0) + 1;
  }
  resetCard(card);
  s.players[card.owner].graveyard.push(card);
}

// ─── Public API ──────────────────────────────────────────────────────────────
function legalActions(s) {
  const pend = s.pending;
  if (!pend || s.over) return [];
  const p = pend.player;
  const P = s.players[p];
  const handIds = P.hand.map(c => c.id);
  switch (pend.kind) {
    case 'mulligan':
      return P.mulligans >= MAX_HAND ? [{ type: 'keep', player: p }] : [{ type: 'keep', player: p }, { type: 'mulligan', player: p }];
    case 'bottom':
      return [{ type: 'bottom', player: p, template: true, count: pend.count, options: handIds }];
    case 'discard':
      return [{ type: 'discard', player: p, template: true, count: pend.count, options: handIds }];
    case 'attackers': {
      const defender = 1 - s.active;
      const pws = s.battlefield.filter(c => c.controller === defender && isType(c, 'Planeswalker')).map(c => c.id);
      return [{ type: 'declareAttackers', player: p, template: true, eligible: eligibleAttackers(s).map(c => c.id), targets: ['player', ...pws] }];
    }
    case 'blockers':
      return [{ type: 'declareBlockers', player: p, template: true, eligible: eligibleBlockers(s).map(c => c.id), attackers: s.combat.attackers.map(a => a.id) }];
    case 'priority': {
      const acts = [{ type: 'pass', player: p }];
      for (const card of P.hand) {
        if (canPlayLand(s, p, card)) acts.push({ type: 'playLand', player: p, cardId: card.id });
        for (const o of castOptions(s, p, card)) acts.push({ type: 'cast', player: p, cardId: card.id, targets: o.targets, x: o.x });
      }
      return acts;
    }
    default:
      throw new Error(`Unknown pending kind ${pend.kind}`);
  }
}

function fail(msg) { throw new Error(`Illegal action: ${msg}`); }

function pickFromHand(P, ids, count) {
  if (!Array.isArray(ids) || ids.length !== count || new Set(ids).size !== count) fail(`choose exactly ${count} distinct cards`);
  const cards = ids.map(id => P.hand.find(c => c.id === id));
  if (cards.some(c => !c)) fail('card not in hand');
  return cards;
}

function nextMulliganDecision(s) {
  const first = s.firstPlayer, second = 1 - first;
  if (!s.players[first].kept) s.pending = { player: first, kind: 'mulligan' };
  else if (!s.players[second].kept) s.pending = { player: second, kind: 'mulligan' };
  else startFirstTurn(s);
}

function applyAction(s, action) {
  if (s.over) fail('game is over');
  const pend = s.pending;
  if (!pend) fail('no decision pending');
  if (!action || action.player !== pend.player) fail(`it is P${pend.player}'s decision`);
  const p = pend.player;
  const P = s.players[p];
  s.stats.actions++;

  switch (pend.kind) {
    case 'mulligan': {
      if (action.type === 'keep') {
        P.kept = true;
        if (P.mulligans > 0) { s.pending = { player: p, kind: 'bottom', count: P.mulligans }; return s; }
        nextMulliganDecision(s);
      } else if (action.type === 'mulligan') {
        if (P.mulligans >= MAX_HAND) fail('no more mulligans');
        P.library.push(...P.hand.splice(0));
        R.shuffle(s, P.library);
        drawCards(s, p, 7);
        P.mulligans += 1;
      } else fail(`expected keep/mulligan, got ${action.type}`);
      return s;
    }
    case 'bottom': {
      if (action.type !== 'bottom') fail('expected bottom');
      for (const c of pickFromHand(P, action.cardIds, pend.count)) { P.hand.splice(P.hand.indexOf(c), 1); P.library.push(c); }
      nextMulliganDecision(s);
      return s;
    }
    case 'discard': {
      if (action.type !== 'discard') fail('expected discard');
      for (const c of pickFromHand(P, action.cardIds, pend.count)) { P.hand.splice(P.hand.indexOf(c), 1); P.graveyard.push(c); }
      s.pending = null;
      runStep(s); // finish cleanup → next turn
      return s;
    }
    case 'attackers': {
      if (action.type !== 'declareAttackers') fail('expected declareAttackers');
      const eligible = new Set(eligibleAttackers(s).map(c => c.id));
      const defender = 1 - s.active;
      const list = action.attackers || [];
      if (new Set(list.map(a => a.id)).size !== list.length) fail('duplicate attacker');
      for (const a of list) {
        if (!eligible.has(a.id)) fail(`${a.id} cannot attack`);
        if (a.target !== 'player') {
          const pw = find(s, a.target);
          if (!pw || pw.controller !== defender || !isType(pw, 'Planeswalker')) fail('invalid attack target');
        }
      }
      for (const a of list) { const c = find(s, a.id); if (!hasKw(c, 'vigilance')) c.tapped = true; }
      s.combat = { attackers: list.map(a => ({ id: a.id, target: a.target })), blocks: [], blockedIds: [] };
      givePriority(s, s.active);
      return s;
    }
    case 'blockers': {
      if (action.type !== 'declareBlockers') fail('expected declareBlockers');
      const eligible = new Set(eligibleBlockers(s).map(c => c.id));
      const attackerIds = new Set(s.combat.attackers.map(a => a.id));
      const blocks = action.blocks || [];
      if (new Set(blocks.map(b => b.blocker)).size !== blocks.length) fail('a creature can block only one attacker');
      for (const b of blocks) {
        if (!eligible.has(b.blocker)) fail(`${b.blocker} cannot block`);
        if (!attackerIds.has(b.attacker)) fail(`${b.attacker} is not attacking`);
        if (!canBlock(find(s, b.blocker), find(s, b.attacker))) fail(`${b.blocker} cannot block ${b.attacker} (evasion)`);
      }
      for (const id of attackerIds) {
        const n = blocks.filter(b => b.attacker === id).length;
        if (n === 1 && hasKw(find(s, id), 'menace')) fail(`${id} has menace and needs two or more blockers`);
      }
      s.combat.blocks = blocks.map(b => ({ blocker: b.blocker, attacker: b.attacker }));
      s.combat.blockedIds = [...new Set(blocks.map(b => b.attacker))];
      givePriority(s, s.active);
      return s;
    }
    case 'priority': {
      if (action.type === 'pass') {
        s.passes += 1;
        if (s.passes < 2) { givePriority(s, 1 - p); return s; }
        s.passes = 0;
        if (s.stack.length) { resolveTop(s); givePriority(s, s.active); } else nextStep(s);
        return s;
      }
      if (action.type === 'playLand') {
        const card = P.hand.find(c => c.id === action.cardId);
        if (!card || !canPlayLand(s, p, card)) fail('cannot play that land now');
        P.hand.splice(P.hand.indexOf(card), 1);
        enterBattlefield(s, card, p);
        P.landsPlayed += 1;
        s.passes = 0;
        givePriority(s, p);
        return s;
      }
      if (action.type === 'cast') {
        const card = P.hand.find(c => c.id === action.cardId);
        if (!card) fail('card not in hand');
        if (!canCastTiming(s, p, card)) fail(`cannot cast ${card.name} now`);
        const x = action.x || 0;
        if (!Number.isInteger(x) || x < 0) fail('invalid X');
        if (x > 0 && !parseCost(ch(card).manaCost, 0).hasX) fail('X given for a spell without X');
        const spec = targetSpec(card.name);
        const targets = action.targets || [];
        if (targets.length !== spec.length) fail(`${card.name} needs ${spec.length} target(s)`);
        spec.forEach((kind, i) => { if (!isTargetLegal(s, p, kind, targets[i])) fail(`illegal target for ${card.name}`); });
        const pay = payFor(s, p, card, x);
        if (!pay) fail(`cannot pay for ${card.name}`);
        for (const id of pay.tap) find(s, id).tapped = true;
        P.life -= pay.life;
        P.hand.splice(P.hand.indexOf(card), 1);
        card.controller = p;
        s.stack.push({ card, controller: p, targets: targets.map(t => ({ ...t })), x });
        s.stats.casts[card.name] = (s.stats.casts[card.name] || 0) + 1;
        s.passes = 0;
        givePriority(s, p);
        return s;
      }
      fail(`unknown priority action ${action.type}`);
    }
    // eslint-disable-next-line no-fallthrough
    default:
      fail(`unknown pending kind ${pend.kind}`);
  }
  return s;
}

module.exports = {
  createGame, legalActions, applyAction,
  // exposed for tests, invariants and the bot
  STEPS, IMPLEMENTED_KEYWORDS, unimplementedText, powerOf, toughOf, hasKw, isType, find,
  eligibleAttackers, eligibleBlockers, canBlock, manaSources, checkSBA, blankState, newCard,
  enterBattlefield, runStep, givePriority, MAX_HAND,
};
