/**
 * Test kit: build exact board states and drive the engine step by step.
 * Every action goes through applyAction AND an invariant check.
 */
const db = require('./cardDb');
const G = require('./game');
const { checkInvariants } = require('./invariants');

// Synthetic cards with exact P/T + keywords, for rules scenarios.
const T = (name, p, t, keywords = [], extra = {}) => db._registerTestCard({
  name, type_line: extra.type_line || 'Creature — Test', mana_cost: extra.mana_cost || '{1}', cmc: 1,
  power: String(p), toughness: String(t), keywords, ...extra,
});
T('T Bear', 2, 2);
T('T Wall', 0, 5);
T('T Flyer', 2, 2, ['Flying']);
T('T Reach', 1, 3, ['Reach']);
T('T First Striker', 2, 2, ['First strike']);
T('T Double Striker', 2, 2, ['Double strike']);
T('T Trampler', 5, 5, ['Trample']);
T('T DT Trampler', 5, 5, ['Deathtouch', 'Trample']);
T('T Deathtoucher', 1, 1, ['Deathtouch']);
T('T Lifelinker', 3, 3, ['Lifelink']);
T('T Menace', 3, 3, ['Menace']);
T('T Vigilant', 2, 2, ['Vigilance']);
T('T Indestructible', 2, 2, ['Indestructible']);
T('T Haste', 2, 2, ['Haste']);
T('T Hexproof', 2, 2, ['Hexproof']);
T('T Legend', 2, 2, [], { type_line: 'Legendary Creature — Test' });
T('T Flash Bear', 2, 2, ['Flash'], { mana_cost: '{G}' });

/** A game paused with priority for `active` in `step`, empty hands, 10-card libraries. */
function setup({ active = 0, step = 'main1', turn = 3, life = [20, 20], library = 10 } = {}) {
  const s = G.blankState(1);
  s.turn = turn; s.active = active; s.firstPlayer = active; s.step = step;
  for (const p of [0, 1]) {
    s.players[p].life = life[p];
    s.players[p].kept = true;
    for (let i = 0; i < library; i++) s.players[p].library.push(G.newCard(s, 'Forest', p));
    s.players[p].cardCount = library;
  }
  s.priority = active;
  s.pending = { player: active, kind: 'priority' };
  return s;
}

function add(s, p, name, zone = 'battlefield', props = {}) {
  const c = G.newCard(s, name, p);
  if (zone === 'battlefield') {
    c.controller = p;
    if (db.char(name).is('Planeswalker')) c.counters.loyalty = db.num(db.char(name).loyalty);
    s.battlefield.push(c);
  } else s.players[p][zone].push(c);
  s.players[p].cardCount += 1;
  return Object.assign(c, props);
}

function lands(s, p, name, n) { return Array.from({ length: n }, () => add(s, p, name)); }

function act(s, a) {
  G.applyAction(s, { player: s.pending && s.pending.player, ...a });
  const v = checkInvariants(s);
  if (v.length) throw new Error(`invariants: ${v.join('; ')}`);
  return s;
}

const pass = (s) => act(s, { type: 'pass' });

/** Pass priority until `pred(s)` holds (or a non-priority decision appears). */
function passUntil(s, pred, cap = 200) {
  for (let i = 0; i < cap && !s.over && !pred(s); i++) {
    if (s.pending.kind !== 'priority') return s;
    pass(s);
  }
  return s;
}

/** Like passUntil, but also declares no attackers / no blockers along the way. */
function skipTo(s, pred, cap = 400) {
  for (let i = 0; i < cap && !s.over && !pred(s); i++) {
    const k = s.pending.kind;
    if (k === 'priority') pass(s);
    else if (k === 'attackers') act(s, { type: 'declareAttackers', attackers: [] });
    else if (k === 'blockers') act(s, { type: 'declareBlockers', blocks: [] });
    else return s;
  }
  return s;
}

/**
 * Run one combat from beginCombat: declare `attackers` ([{id,target}] or ids),
 * the defender declares `blocks`, then pass through damage. Stops at end of combat.
 */
function combat(s, attackers, blocks = []) {
  passUntil(s, x => x.pending.kind === 'attackers');
  act(s, { type: 'declareAttackers', attackers: attackers.map(a => (typeof a === 'string' ? { id: a, target: 'player' } : a)) });
  passUntil(s, x => x.pending.kind === 'blockers' || x.step !== 'declareAttackers');
  if (s.pending && s.pending.kind === 'blockers') act(s, { type: 'declareBlockers', blocks });
  passUntil(s, x => x.step === 'endCombat' || x.over);
  return s;
}

const where = (s, card) => {
  if (s.battlefield.includes(card)) return 'battlefield';
  for (const z of ['hand', 'library', 'graveyard', 'exile']) if (s.players[card.owner][z].includes(card)) return z;
  return s.stack.some(i => i.card === card) ? 'stack' : 'nowhere';
};

module.exports = { setup, add, lands, act, pass, passUntil, skipTo, combat, where };
