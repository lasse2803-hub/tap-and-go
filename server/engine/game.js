/**
 * Tap & Go rules engine — the single authority over a game.
 *
 * Pure game logic: no sockets, no UI, no randomness except the seeded RNG stored in
 * the state. The state is plain JSON (serializable, replayable from its seed).
 *
 *   const s = createGame({ decks: ['Red Aggro', 'Golgari Nissa Control'], seed: 7 });
 *   while (!s.over) applyAction(s, chooseFrom(legalActions(s)));
 *
 * Every step waits for a DECISION (s.pending = { player, kind }):
 *   mulligan · bottom · priority · attackers · blockers · discard
 *   triggerTargets (choose targets for a triggered ability going on the stack)
 *   choice (a "you may" / mode choice during resolution) · scry
 * legalActions(s) lists what the deciding player may do (multi-select decisions return
 * one template); applyAction(s, a) validates fully and applies, then advances.
 *
 * Card rules come ONLY from explicit implementations in ./cards. Engine-level pieces
 * (keywords, triggers, stack, costs, tokens, continuous effects) live here.
 */
const db = require('./cardDb');
const { parseCost, solvePayment } = require('./mana');
const R = require('./rng');
const IMPLS = require('./cards');

const STEPS = ['untap', 'upkeep', 'draw', 'main1', 'beginCombat', 'declareAttackers', 'declareBlockers',
  'firstStrikeDamage', 'combatDamage', 'endCombat', 'main2', 'end', 'cleanup'];
const MAX_HAND = 7;
const IMPLEMENTED_KEYWORDS = new Set(['flying', 'reach', 'trample', 'haste', 'vigilance', 'deathtouch', 'lifelink',
  'first strike', 'double strike', 'menace', 'indestructible', 'flash', 'hexproof', 'defender', 'prowess']);

// ─── Characteristics (base + continuous effects + counters) ──────────────────
const tokenChars = new Map();
function baseChar(c) {
  if (!c.token) return db.char(c.name);
  const key = `${c.name}|${JSON.stringify(c.token)}`;
  let ch = tokenChars.get(key);
  if (!ch) { ch = db.makeTokenChar({ name: c.name, ...c.token }); tokenChars.set(key, ch); }
  return ch;
}
const modsOf = (c) => c.mods || [];
function typesOf(c) {
  const t = new Set(baseChar(c).types);
  for (const m of modsOf(c)) for (const x of m.types || []) t.add(x);
  return [...t];
}
const isType = (c, t) => typesOf(c).includes(t);
const hasKw = (c, kw) => baseChar(c).keywords.includes(kw) || modsOf(c).some(m => (m.keywords || []).includes(kw));
function ptOf(c, i) {
  const ch = baseChar(c);
  let v = db.num(i === 0 ? ch.power : ch.toughness);
  for (const m of modsOf(c)) if (m.setPT) v = m.setPT[i];          // characteristic-setting first
  for (const m of modsOf(c)) v += (i === 0 ? m.power : m.toughness) || 0; // then modifications
  return v + ((c.counters && c.counters['+1/+1']) || 0) - ((c.counters && c.counters['-1/-1']) || 0);
}
const powerOf = (s, c) => ptOf(c, 0);
const toughOf = (s, c) => ptOf(c, 1);
const find = (s, id) => s.battlefield.find(c => c.id === id);
const implOf = (c) => (c.token ? null : IMPLS[c.name]) || null;
const staticOf = (c) => (implOf(c) && implOf(c).static) || {};

// ─── Abilities: lookup by stable string key (keeps state serializable) ───────
// '#prowess' → engine keyword; 'Card Name#spell' / '#adventure' → spell faces;
// 'Card Name#abilityKey' → IMPLS[name].abilities[abilityKey].
const BUILTIN = {
  prowess: {
    kind: 'trigger', on: 'cast',
    match: (s, ev, c) => ev.player === c.controller && ev.noncreature,
    resolve: (fx, ctx) => fx.pump(ctx.sourceId, 1, 1),
  },
};

function lookup(key) {
  const i = key.lastIndexOf('#');
  const name = key.slice(0, i), part = key.slice(i + 1);
  if (!name) return BUILTIN[part];
  const impl = IMPLS[name];
  if (!impl) throw new Error(`No implementation for ${key}`);
  const out = (part === 'spell' || part === 'adventure') ? impl[part] : (impl.abilities && impl.abilities[part]);
  if (!out) throw new Error(`No ability ${key}`);
  return out;
}

/** Ability keys a permanent currently has on the battlefield. */
function abilitiesOf(c) {
  const keys = [];
  if (hasKw(c, 'prowess')) keys.push('#prowess');
  const impl = implOf(c);
  if (impl && impl.abilities) {
    for (const [k, a] of Object.entries(impl.abilities)) {
      if (!a.granted && a.kind !== 'delayed' && (a.zone || 'battlefield') === 'battlefield') keys.push(`${c.name}#${k}`);
    }
  }
  for (const m of modsOf(c)) for (const g of m.grant || []) keys.push(g);
  return keys;
}

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
  return { id: `c${s.nextId++}`, name, owner, controller: owner, tapped: false, sick: false, damage: 0, deathtouched: false, counters: {}, mods: [] };
}

function blankState(seed) {
  return {
    seed, rng: R.seedState(seed),
    turn: 0, active: 0, step: 'mulligan', priority: null, passes: 0,
    players: [0, 1].map(i => ({ name: `P${i}`, deck: null, life: 20, poison: 0, library: [], hand: [], graveyard: [], exile: [],
      landsPlayed: 0, mulligans: 0, kept: false, drewFromEmpty: false, lostLifeThisTurn: false, cardCount: 0 })),
    battlefield: [], stack: [], combat: null, pending: null,
    triggerQueue: [], delayed: [], suspended: null, resumePriority: null, noPrevention: false,
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
  c.controller = c.owner; c.tapped = false; c.sick = false; c.damage = 0; c.deathtouched = false; c.counters = {}; c.mods = [];
  delete c.playable; delete c.onAdventure;
}

function drawCards(s, p, n) {
  const P = s.players[p];
  for (let i = 0; i < n; i++) {
    if (!P.library.length) { P.drewFromEmpty = true; return; }
    P.hand.push(P.library.shift());
  }
}

/** opts: { tapped, attacking: attack target ('player' | pwId), counters: {name: n} } */
function enterBattlefield(s, card, controller, opts = {}) {
  resetCard(card);
  card.controller = controller;
  card.sick = true;
  if (isType(card, 'Planeswalker')) card.counters.loyalty = db.num(baseChar(card).loyalty);
  const st = staticOf(card);
  if (st.etbTapped && st.etbTapped(s, card, controller, { isType })) card.tapped = true;
  if (opts.tapped) card.tapped = true;
  for (const [k, n] of Object.entries(opts.counters || {})) card.counters[k] = (card.counters[k] || 0) + n;
  s.battlefield.push(card);
  if (opts.attacking && s.combat) s.combat.attackers.push({ id: card.id, target: opts.attacking });
  if (!card.token && unimplementedText(card.name)) s.stats.enteredWithoutImpl[card.name] = (s.stats.enteredWithoutImpl[card.name] || 0) + 1;
  emit(s, { type: 'etb', cardId: card.id });
}

function leaveBattlefield(s, id, zone) {
  const i = s.battlefield.findIndex(c => c.id === id);
  if (i === -1) return null;
  const [card] = s.battlefield.splice(i, 1);
  if (s.combat) {
    s.combat.attackers = s.combat.attackers.filter(a => a.id !== id);
    s.combat.blocks = s.combat.blocks.filter(b => b.blocker !== id && b.attacker !== id);
  }
  if (card.token) return card; // tokens cease to exist outside the battlefield
  resetCard(card);
  s.players[card.owner][zone].push(card);
  return card;
}

// ─── Life & damage ───────────────────────────────────────────────────────────
function loseLife(s, p, n) {
  if (!(n > 0)) return;
  s.players[p].life -= n;
  s.players[p].lostLifeThisTurn = true;
}
function gainLife(s, p, n) { if (n > 0) s.players[p].life += n; }

/** Deal damage, applying replacement effects. Returns { dealt } (damage actually dealt). */
function applyDamage(s, source, target, n, opts = {}) {
  if (!(n > 0)) return { dealt: 0 };
  let ev = { source, sourceController: source ? source.controller : null, target, n, combat: !!opts.combat, asCounters: false };
  for (const perm of s.battlefield) {
    const st = staticOf(perm);
    if (st.replaceDamage) ev = st.replaceDamage(s, perm, ev, { isType, find: (id) => find(s, id) });
  }
  if (ev.target.kind === 'player') {
    loseLife(s, ev.target.player, ev.n);
  } else {
    const t = find(s, ev.target.id);
    if (!t) return { dealt: 0 };
    if (ev.asCounters) { t.counters['-1/-1'] = (t.counters['-1/-1'] || 0) + ev.n; return { dealt: 0 }; }
    if (isType(t, 'Creature')) { t.damage += ev.n; if (source && hasKw(source, 'deathtouch')) t.deathtouched = true; }
    if (isType(t, 'Planeswalker')) t.counters.loyalty = (t.counters.loyalty || 0) - ev.n;
  }
  if (source && hasKw(source, 'lifelink')) gainLife(s, source.controller, ev.n);
  return { dealt: ev.n };
}

// ─── Triggers ────────────────────────────────────────────────────────────────
/** An event happened: queue every triggered ability that triggers on it. */
function emit(s, ev) {
  for (const c of s.battlefield) {
    for (const key of abilitiesOf(c)) {
      const ab = lookup(key);
      if (ab.kind !== 'trigger' || ab.on !== ev.type) continue;
      if (ab.match && !ab.match(s, ev, c)) continue;
      s.triggerQueue.push({ key, sourceId: c.id, sourceName: c.name, controller: c.controller, ev: { ...ev } });
    }
  }
  for (const p of [0, 1]) {
    for (const c of s.players[p].graveyard) {
      const impl = IMPLS[c.name];
      if (!impl || !impl.abilities) continue;
      for (const [k, ab] of Object.entries(impl.abilities)) {
        if (ab.kind !== 'trigger' || ab.zone !== 'graveyard' || ab.on !== ev.type) continue;
        if (ab.match && !ab.match(s, ev, c)) continue;
        s.triggerQueue.push({ key: `${c.name}#${k}`, sourceId: c.id, sourceName: c.name, controller: c.owner, ev: { ...ev } });
      }
    }
  }
}

function targetCombos(s, controller, spec) {
  let combos = [[]];
  for (const kind of spec || []) {
    const ts = legalTargets(s, controller, kind);
    combos = combos.flatMap(prev => ts.filter(t => !prev.some(x => sameTarget(x, t))).map(t => [...prev, t]));
  }
  return combos;
}
const sameTarget = (a, b) => a.kind === b.kind && (a.kind === 'player' ? a.player === b.player : a.id === b.id);

/** Put queued triggers on the stack (APNAP). Returns false if a target choice is needed. */
function placeTriggers(s) {
  const order = (t) => (t.controller === s.active ? 0 : 1);
  s.triggerQueue.sort((a, b) => order(a) - order(b));
  while (s.triggerQueue.length) {
    const t = s.triggerQueue[0];
    const combos = targetCombos(s, t.controller, lookup(t.key).targets);
    if (!combos.length) { s.triggerQueue.shift(); continue; } // no legal target: removed from the stack
    if (combos.length > 1) {
      s.pending = { player: t.controller, kind: 'triggerTargets', source: t.sourceName, options: combos };
      return false;
    }
    s.triggerQueue.shift();
    s.stack.push({ kind: 'ability', key: t.key, sourceId: t.sourceId, sourceName: t.sourceName, controller: t.controller, targets: combos[0], ev: t.ev });
  }
  return true;
}

// ─── Effects API for card implementations (./cards) ──────────────────────────
const plainCtx = (ctx) => ({ controller: ctx.controller, sourceId: ctx.sourceId, sourceName: ctx.sourceName, targets: ctx.targets, ev: ctx.ev || null, x: ctx.x || 0 });

function sourceRef(s, ctx) {
  const onBf = find(s, ctx.sourceId);
  if (onBf) return onBf;
  for (const p of [0, 1]) for (const z of ['graveyard', 'exile', 'hand']) {
    const c = s.players[p][z].find(x => x.id === ctx.sourceId);
    if (c) return c;
  }
  const onStack = s.stack.find(i => i.card && i.card.id === ctx.sourceId);
  if (onStack) return onStack.card;
  return { id: ctx.sourceId, name: ctx.sourceName, controller: ctx.controller, owner: ctx.controller, counters: {}, mods: [] }; // last known info
}

function findAnywhere(s, id) {
  for (const p of [0, 1]) for (const z of ['graveyard', 'exile', 'hand', 'library']) {
    const c = s.players[p][z].find(x => x.id === id);
    if (c) return { card: c, zone: z, player: p };
  }
  return null;
}

function makeFx(s, key, ctx) {
  const suspend = (pending, cont) => { s.pending = pending; s.suspended = { key, cont: cont || null, ctx: plainCtx(ctx) }; };
  const fx = {
    state: s,
    find: (id) => find(s, id),
    isType,
    damage: (source, target, n) => applyDamage(s, source, target, n),
    destroy: (id) => { const c = find(s, id); if (c && !hasKw(c, 'indestructible')) leaveBattlefield(s, id, 'graveyard'); },
    exile: (id) => { if (find(s, id)) leaveBattlefield(s, id, 'exile'); },
    draw: (p, n) => drawCards(s, p, n),
    loseLife: (p, n) => loseLife(s, p, n),
    gainLife: (p, n) => gainLife(s, p, n),
    creatures: () => s.battlefield.filter(c => isType(c, 'Creature')),
    /** +P/+T (and keywords) until end of turn. */
    pump: (id, power, toughness, keywords) => { const c = find(s, id); if (c) c.mods.push({ until: 'eot', power, toughness, keywords }); },
    addMod: (id, mod) => { const c = find(s, id); if (c) c.mods.push({ until: 'eot', ...mod }); },
    createToken: (p, def, opts = {}) => {
      const { name, ...rest } = def;
      const t = { id: `t${s.nextId++}`, name, owner: p, controller: p, token: rest, tapped: false, sick: false, damage: 0, deathtouched: false, counters: {}, mods: [] };
      enterBattlefield(s, t, p, opts);
      return t.id;
    },
    /** A delayed triggered ability (e.g. "at end of combat") created by this effect. */
    delayed: (when, abilityKey, ev) => s.delayed.push({ when, key: abilityKey, controller: ctx.controller, sourceId: ctx.sourceId, sourceName: ctx.sourceName, ev: ev || null }),
    noPrevention: () => { s.noPrevention = true; },
    /** Exile the top n of p's library; p may play them until the end of p's next turn. */
    exileTopPlayable: (p, n) => {
      const P = s.players[p];
      const untilTurn = s.active === p ? s.turn + 2 : s.turn + 1;
      for (const c of P.library.splice(0, n)) { c.playable = { player: p, untilTurn }; P.exile.push(c); }
    },
    canPay: (p, cost) => !!solvePayment(parseCost(cost), manaSources(s, p), s.players[p].life),
    pay: (p, cost) => {
      const pay = solvePayment(parseCost(cost), manaSources(s, p), s.players[p].life);
      if (!pay) return false;
      for (const id of pay.tap) find(s, id).tapped = true;
      loseLife(s, p, pay.life);
      return true;
    },
    inGraveyard: (id) => { const f = findAnywhere(s, id); return !!(f && f.zone === 'graveyard'); },
    /** Return a card from its owner's graveyard to the battlefield (opts as enterBattlefield). */
    graveyardToBattlefield: (id, opts) => {
      const f = findAnywhere(s, id);
      if (!f || f.zone !== 'graveyard') return false;
      s.players[f.player].graveyard.splice(s.players[f.player].graveyard.indexOf(f.card), 1);
      enterBattlefield(s, f.card, f.card.owner, opts);
      return true;
    },
    attackTargetOf: (id) => { const a = s.combat && s.combat.attackers.find(x => x.id === id); return a ? a.target : 'player'; },
    /** Ask the controller to scry n. Must be the LAST thing a resolve() does. */
    scry: (p, n) => {
      const cards = s.players[p].library.slice(0, n).map(c => c.id);
      if (cards.length) suspend({ player: p, kind: 'scry', cards }, null);
    },
    /** Ask a choice; answer goes to holder[contName](fx, ctx, option). Must be LAST in resolve(). */
    ask: (p, options, contName, prompt) => suspend({ player: p, kind: 'choice', options, prompt: prompt || '' }, contName),
  };
  return fx;
}

// ─── Targets ─────────────────────────────────────────────────────────────────
function isTargetLegal(s, caster, kind, t) {
  if (!t) return false;
  if (t.kind === 'player') return (kind === 'any' || kind === 'playerOrPlaneswalker') && (t.player === 0 || t.player === 1);
  if (t.kind !== 'perm') return false;
  const c = find(s, t.id);
  if (!c) return false;
  if (c.controller !== caster && hasKw(c, 'hexproof')) return false;
  const cr = isType(c, 'Creature'), pw = isType(c, 'Planeswalker');
  if (kind === 'any' || kind === 'creatureOrPlaneswalker') return cr || pw;
  if (kind === 'creature') return cr;
  if (kind === 'playerOrPlaneswalker') return pw;
  return false;
}

function legalTargets(s, caster, kind) {
  const out = [];
  if (kind === 'any' || kind === 'playerOrPlaneswalker') out.push({ kind: 'player', player: 0 }, { kind: 'player', player: 1 });
  for (const c of s.battlefield) { const t = { kind: 'perm', id: c.id }; if (isTargetLegal(s, caster, kind, t)) out.push(t); }
  return out;
}

// ─── Mana ────────────────────────────────────────────────────────────────────
function manaSources(s, p, excludeId) {
  const out = [];
  for (const c of s.battlefield) {
    if (c.controller !== p || c.tapped || c.id === excludeId || c.token) continue;
    const opts = db.manaOptions(c.name);
    if (!opts) continue;
    if (isType(c, 'Creature') && c.sick && !hasKw(c, 'haste')) continue;
    out.push({ id: c.id, options: opts });
  }
  return out;
}

/** Payment for a cost string; prefers not to tap `avoidId` (e.g. the ability's own source). */
function payCost(s, p, costStr, x, avoidId) {
  const cost = parseCost(costStr, x);
  if (avoidId) { const r = solvePayment(cost, manaSources(s, p, avoidId), s.players[p].life); if (r) return r; }
  return solvePayment(cost, manaSources(s, p), s.players[p].life);
}

function maxX(s, p, costStr) {
  for (let x = manaSources(s, p).length; x >= 0; x--) if (payCost(s, p, costStr, x)) return x;
  return -1;
}

// ─── Casting & playing ───────────────────────────────────────────────────────
const isMain = (s) => s.step === 'main1' || s.step === 'main2';
const sorceryTiming = (s, p) => p === s.active && isMain(s) && s.stack.length === 0;

const ALT_CONDITIONS = {
  spectacle: (s, p) => s.players[1 - p].lostLifeThisTurn, // an opponent lost life this turn
};

/** What casting `card` with `face`/`alt` means: types, cost, implementation. */
function faceInfo(card, face, alt) {
  const ch = baseChar(card);
  const impl = IMPLS[card.name] || {};
  if (face === 'adventure') {
    if (!ch.adventure) return null;
    return { name: ch.adventure.name, types: ch.adventure.types, cost: ch.adventure.manaCost, impl: impl.adventure, permanent: false, flash: false };
  }
  let cost = ch.manaCost;
  if (alt) {
    const a = (impl.altCosts || []).find(x => x.kind === alt);
    if (!a) return null;
    cost = a.cost;
  }
  return { name: ch.name, types: ch.types, cost, impl: impl.spell, permanent: ch.isPermanent, flash: ch.keywords.includes('flash') };
}

/** Cards p may cast or play right now from each zone. */
function castSources(s, p) {
  const P = s.players[p];
  const out = P.hand.map(card => ({ card, from: 'hand' }));
  for (const card of P.exile) {
    if (card.playable && card.playable.player === p && s.turn <= card.playable.untilTurn) out.push({ card, from: 'exile' });
    else if (card.onAdventure && card.owner === p) out.push({ card, from: 'exile', onlyMain: true });
  }
  return out;
}

function canPlayLand(s, p, src) {
  return isType(src.card, 'Land') && !src.onlyMain && sorceryTiming(s, p) && s.players[p].landsPlayed < 1;
}

/** Concrete cast options for one source: [{ face, alt, targets, x }]. */
function castOptions(s, p, src) {
  const { card } = src;
  if (isType(card, 'Land')) return [];
  const out = [];
  const faces = ['main'];
  if (src.from === 'hand' && baseChar(card).adventure) faces.push('adventure');
  for (const face of faces) {
    const impl = IMPLS[card.name] || {};
    const alts = [null];
    if (face === 'main') for (const a of impl.altCosts || []) if (ALT_CONDITIONS[a.kind] && ALT_CONDITIONS[a.kind](s, p)) alts.push(a.kind);
    for (const alt of alts) {
      const f = faceInfo(card, face, alt);
      if (!f) continue;
      if (!(f.types.includes('Instant') || f.flash) && !sorceryTiming(s, p)) continue;
      const x = parseCost(f.cost, 0).hasX ? maxX(s, p, f.cost) : 0;
      if (x < 0 || !payCost(s, p, f.cost, x)) continue;
      for (const targets of targetCombos(s, p, f.impl && f.impl.targets)) out.push({ face, alt, targets, x });
    }
  }
  return out;
}

function activationOptions(s, p) {
  const out = [];
  for (const c of s.battlefield) {
    if (c.controller !== p) continue;
    const impl = implOf(c);
    if (!impl || !impl.abilities) continue;
    for (const [k, a] of Object.entries(impl.abilities)) {
      if (a.kind !== 'activated') continue;
      if (a.sorcerySpeed && !sorceryTiming(s, p)) continue;
      if (a.tap && (c.tapped || (isType(c, 'Creature') && c.sick && !hasKw(c, 'haste')))) continue;
      if (a.cost && !payCost(s, p, a.cost, 0, c.id)) continue;
      for (const targets of targetCombos(s, p, a.targets)) out.push({ type: 'activate', player: p, cardId: c.id, ability: k, targets });
    }
  }
  return out;
}

// ─── Combat ──────────────────────────────────────────────────────────────────
function eligibleAttackers(s) {
  return s.battlefield.filter(c => c.controller === s.active && isType(c, 'Creature') && !c.tapped
    && (!c.sick || hasKw(c, 'haste')) && !hasKw(c, 'defender'));
}

function eligibleBlockers(s) {
  return s.battlefield.filter(c => c.controller !== s.active && isType(c, 'Creature') && !c.tapped && !staticOf(c).cantBlock);
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
  for (const d of dmg) applyDamage(s, d.source, d.target, d.n, { combat: true });
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
      if (!baseChar(c).isLegendary) continue;
      const key = `${c.controller}|${c.name}`;
      if (seen.has(key)) { leaveBattlefield(s, c.id, 'graveyard'); changed = true; } else seen.add(key);
    }
    if (!changed) return;
  }
  throw new Error('State-based actions did not stabilize');
}

// ─── Turn structure ──────────────────────────────────────────────────────────
/** 117.5/704.3: SBAs and pending triggers are handled before a player gets priority. */
function givePriority(s, p) {
  for (;;) {
    checkSBA(s);
    if (s.over) return;
    if (!s.triggerQueue.length) break;
    if (!placeTriggers(s)) { s.resumePriority = p; return; }
  }
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
        for (const P of s.players) P.lostLifeThisTurn = false;
        s.step = 'upkeep';
        continue;
      case 'draw':
        if (s.turn > 1) drawCards(s, a, 1); // the starting player skips their first draw
        return givePriority(s, a);
      case 'declareAttackers':
        if (!eligibleAttackers(s).length) { s.combat = { attackers: [], blocks: [], blockedIds: [] }; return givePriority(s, a); }
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
      case 'endCombat': {
        // Delayed triggers "at end of combat" (e.g. exile Kari Zev's Ragavan).
        const due = s.delayed.filter(d => d.when === 'endCombat');
        s.delayed = s.delayed.filter(d => d.when !== 'endCombat');
        for (const d of due) s.triggerQueue.push({ key: d.key, sourceId: d.sourceId, sourceName: d.sourceName, controller: d.controller, ev: d.ev });
        return givePriority(s, a);
      }
      case 'cleanup': {
        const excess = s.players[a].hand.length - MAX_HAND;
        if (excess > 0) { s.pending = { player: a, kind: 'discard', count: excess }; return; }
        for (const c of s.battlefield) {
          c.damage = 0; c.deathtouched = false;
          c.mods = modsOf(c).filter(m => m.until !== 'eot'); // "until end of turn" effects end
        }
        s.noPrevention = false;
        s.combat = null;
        s.active = 1 - a;
        s.turn += 1;
        s.step = 'untap';
        continue;
      }
      default: // upkeep, main1, beginCombat, main2, end
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

// ─── Stack resolution ────────────────────────────────────────────────────────
function finishSpell(s, item, resolved) {
  s.stack.pop();
  const card = item.card;
  resetCard(card);
  if (item.face === 'adventure' && resolved) { card.onAdventure = true; s.players[card.owner].exile.push(card); }
  else s.players[card.owner].graveyard.push(card);
}

/** Resolve the top item. Returns false if resolution paused for a decision. */
function resolveTop(s) {
  const item = s.stack[s.stack.length - 1];
  if (item.kind === 'ability') {
    const ab = lookup(item.key);
    const spec = ab.targets || [];
    const allIllegal = spec.length > 0 && item.targets.every((t, i) => !isTargetLegal(s, item.controller, spec[i], t));
    if (!allIllegal) {
      const ctx = { controller: item.controller, sourceId: item.sourceId, sourceName: item.sourceName, targets: item.targets, ev: item.ev, x: 0 };
      ctx.source = sourceRef(s, ctx);
      ab.resolve(makeFx(s, item.key, ctx), ctx);
    }
    if (s.suspended) return false;
    s.stack.pop();
    return true;
  }
  const card = item.card;
  const f = faceInfo(card, item.face, null);
  if (f.permanent && item.face !== 'adventure') { s.stack.pop(); enterBattlefield(s, card, item.controller); return true; }
  let fizzled = false;
  if (f.impl) {
    const spec = f.impl.targets || [];
    fizzled = spec.length > 0 && item.targets.every((t, i) => !isTargetLegal(s, item.controller, spec[i], t));
    if (!fizzled) {
      const key = `${card.name}#${item.face === 'adventure' ? 'adventure' : 'spell'}`;
      const ctx = { controller: item.controller, sourceId: card.id, sourceName: card.name, targets: item.targets, ev: null, x: item.x || 0, source: card };
      f.impl.resolve(makeFx(s, key, ctx), ctx);
    }
  } else {
    s.stats.resolvedWithoutImpl[card.name] = (s.stats.resolvedWithoutImpl[card.name] || 0) + 1;
  }
  if (s.suspended) return false;
  finishSpell(s, item, !fizzled);
  return true;
}

/** A decision taken mid-resolution: run the continuation, then finish the stack item. */
function continueResolution(s, answer) {
  const sus = s.suspended;
  s.suspended = null;
  s.pending = null;
  if (sus.cont) {
    const ctx = { ...sus.ctx };
    ctx.source = sourceRef(s, ctx);
    lookup(sus.key)[sus.cont](makeFx(s, sus.key, ctx), ctx, answer);
  }
  if (s.suspended || s.over) return;
  const item = s.stack[s.stack.length - 1];
  if (item.kind === 'ability') s.stack.pop(); else finishSpell(s, item, true);
  givePriority(s, s.active);
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
    case 'triggerTargets':
      return pend.options.map(targets => ({ type: 'chooseTargets', player: p, targets }));
    case 'choice':
      return pend.options.map(option => ({ type: 'choose', player: p, option }));
    case 'scry':
      return [{ type: 'scry', player: p, template: true, cards: pend.cards.slice() }];
    case 'priority': {
      const acts = [{ type: 'pass', player: p }];
      for (const src of castSources(s, p)) {
        if (canPlayLand(s, p, src)) acts.push({ type: 'playLand', player: p, cardId: src.card.id });
        for (const o of castOptions(s, p, src)) {
          const a = { type: 'cast', player: p, cardId: src.card.id, targets: o.targets, x: o.x };
          if (o.face !== 'main') a.face = o.face;
          if (o.alt) a.alt = o.alt;
          acts.push(a);
        }
      }
      acts.push(...activationOptions(s, p));
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

function validateTargets(s, p, spec, targets, label) {
  if (!Array.isArray(targets) || targets.length !== spec.length) fail(`${label} needs ${spec.length} target(s)`);
  spec.forEach((kind, i) => { if (!isTargetLegal(s, p, kind, targets[i])) fail(`illegal target for ${label}`); });
  for (let i = 0; i < targets.length; i++) for (let j = i + 1; j < targets.length; j++) if (sameTarget(targets[i], targets[j])) fail('same target chosen twice');
}

function removeFromZone(s, p, card) {
  for (const z of ['hand', 'exile']) {
    const i = s.players[p][z].indexOf(card);
    if (i !== -1) { s.players[p][z].splice(i, 1); return; }
  }
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
    case 'triggerTargets': {
      if (action.type !== 'chooseTargets') fail('expected chooseTargets');
      const chosen = pend.options.find(o => JSON.stringify(o) === JSON.stringify(action.targets));
      if (!chosen) fail('not one of the offered target choices');
      const t = s.triggerQueue.shift();
      s.stack.push({ kind: 'ability', key: t.key, sourceId: t.sourceId, sourceName: t.sourceName, controller: t.controller, targets: chosen, ev: t.ev });
      s.pending = null;
      givePriority(s, s.resumePriority);
      return s;
    }
    case 'choice': {
      if (action.type !== 'choose' || !pend.options.includes(action.option)) fail('not one of the offered options');
      continueResolution(s, action.option);
      return s;
    }
    case 'scry': {
      if (action.type !== 'scry') fail('expected scry');
      const top = action.top || [], bottom = action.bottom || [];
      const all = [...top, ...bottom];
      if (all.length !== pend.cards.length || new Set(all).size !== all.length || !all.every(id => pend.cards.includes(id))) fail('scry must place each looked-at card exactly once');
      const lib = P.library;
      const looked = lib.splice(0, pend.cards.length);
      const byId = (id) => looked.find(c => c.id === id);
      lib.unshift(...top.map(byId));
      lib.push(...bottom.map(byId));
      continueResolution(s, null);
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
      for (const a of list) emit(s, { type: 'attacks', attackerId: a.id });
      if (list.length) emit(s, { type: 'attackWith', player: s.active, count: list.length });
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
        if (s.stack.length) { if (resolveTop(s)) givePriority(s, s.active); } else nextStep(s);
        return s;
      }
      if (action.type === 'playLand') {
        const src = castSources(s, p).find(x => x.card.id === action.cardId);
        if (!src || !canPlayLand(s, p, src)) fail('cannot play that land now');
        removeFromZone(s, p, src.card);
        P.landsPlayed += 1;
        enterBattlefield(s, src.card, p);
        s.passes = 0;
        givePriority(s, p);
        return s;
      }
      if (action.type === 'cast') {
        const src = castSources(s, p).find(x => x.card.id === action.cardId);
        if (!src) fail('cannot cast that card from where it is');
        const card = src.card;
        if (isType(card, 'Land')) fail('lands are played, not cast');
        const face = action.face || 'main';
        if (face !== 'main' && face !== 'adventure') fail('unknown face');
        if (face === 'adventure' && (src.from !== 'hand' || !baseChar(card).adventure)) fail('no adventure to cast');
        const alt = action.alt || null;
        if (alt && (face !== 'main' || !ALT_CONDITIONS[alt] || !ALT_CONDITIONS[alt](s, p))) fail(`alternative cost ${alt} not available`);
        const f = faceInfo(card, face, alt);
        if (!f) fail('unknown cost');
        if (!(f.types.includes('Instant') || f.flash) && !sorceryTiming(s, p)) fail(`cannot cast ${f.name} now`);
        const x = action.x || 0;
        if (!Number.isInteger(x) || x < 0) fail('invalid X');
        if (x > 0 && !parseCost(f.cost, 0).hasX) fail('X given for a spell without X');
        const targets = action.targets || [];
        validateTargets(s, p, (f.impl && f.impl.targets) || [], targets, f.name);
        const pay = payCost(s, p, f.cost, x);
        if (!pay) fail(`cannot pay for ${f.name}`);
        for (const id of pay.tap) find(s, id).tapped = true;
        loseLife(s, p, pay.life);
        removeFromZone(s, p, card);
        delete card.playable; delete card.onAdventure;
        card.controller = p;
        s.stack.push({ kind: 'spell', card, controller: p, face, alt, targets: targets.map(t => ({ ...t })), x });
        s.stats.casts[card.name] = (s.stats.casts[card.name] || 0) + 1;
        s.passes = 0;
        emit(s, { type: 'cast', player: p, cardId: card.id, noncreature: !f.types.includes('Creature') });
        for (const t of targets) if (t.kind === 'perm') emit(s, { type: 'becomesTarget', targetId: t.id, bySpell: true, spellController: p });
        givePriority(s, p);
        return s;
      }
      if (action.type === 'activate') {
        const c = find(s, action.cardId);
        if (!c || c.controller !== p) fail('not your permanent');
        const impl = implOf(c);
        const a = impl && impl.abilities && impl.abilities[action.ability];
        if (!a || a.kind !== 'activated') fail('no such activated ability');
        if (a.sorcerySpeed && !sorceryTiming(s, p)) fail('sorcery-speed ability');
        if (a.tap && (c.tapped || (isType(c, 'Creature') && c.sick && !hasKw(c, 'haste')))) fail('cannot tap it now');
        const targets = action.targets || [];
        validateTargets(s, p, a.targets || [], targets, `${c.name} ability`);
        const pay = a.cost ? payCost(s, p, a.cost, 0, c.id) : { tap: [], life: 0 };
        if (!pay) fail(`cannot pay ${a.cost}`);
        for (const id of pay.tap) find(s, id).tapped = true;
        loseLife(s, p, pay.life);
        if (a.tap) c.tapped = true;
        s.stack.push({ kind: 'ability', key: `${c.name}#${action.ability}`, sourceId: c.id, sourceName: c.name, controller: p, targets, ev: null });
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
  STEPS, IMPLEMENTED_KEYWORDS, unimplementedText, powerOf, toughOf, hasKw, isType, find, baseChar, staticOf,
  eligibleAttackers, eligibleBlockers, canBlock, manaSources, checkSBA, blankState, newCard,
  enterBattlefield, runStep, givePriority, MAX_HAND,
};
