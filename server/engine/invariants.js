/**
 * Invariants checked after EVERY action in tests and the simulator. Any violation is
 * an engine bug — this is what replaces "the user notices something odd in-game".
 */
const G = require('./game');

const ZONES = ['library', 'hand', 'graveyard', 'exile'];

function checkInvariants(s) {
  const v = [];
  const isInt = (n) => Number.isInteger(n);

  // 1. Every card exists exactly once; owners' card counts are conserved (tokens excluded).
  const where = new Map();
  const counts = [0, 0];
  const see = (c, place) => {
    if (where.has(c.id)) v.push(`card ${c.id} (${c.name}) is in ${place} AND ${where.get(c.id)}`);
    where.set(c.id, place);
    if (!c.token) counts[c.owner] += 1;
  };
  for (const p of [0, 1]) {
    for (const z of ZONES) for (const c of s.players[p][z]) {
      see(c, `P${p}.${z}`);
      if (c.owner !== p) v.push(`${c.name} owned by P${c.owner} sits in P${p}.${z}`);
      if (c.token) v.push(`token ${c.name} outside the battlefield (P${p}.${z})`);
    }
  }
  for (const c of s.battlefield) see(c, 'battlefield');
  for (const it of s.stack) if (it.card) see(it.card, 'stack');
  for (const p of [0, 1]) if (counts[p] !== s.players[p].cardCount) v.push(`P${p} has ${counts[p]} cards, expected ${s.players[p].cardCount}`);

  // 2. Zone contents are sane.
  for (const c of s.battlefield) {
    if (!G.baseChar(c).isPermanent && !G.isType(c, 'Creature', s)) v.push(`non-permanent ${c.name} on the battlefield`);
    if (!isInt(c.damage) || c.damage < 0) v.push(`${c.name} has invalid damage ${c.damage}`);
    for (const [k, n] of Object.entries(c.counters)) if (!isInt(n)) v.push(`${c.name} counter ${k}=${n}`);
    if (c.controller !== 0 && c.controller !== 1) v.push(`${c.name} has controller ${c.controller}`);
  }
  for (const it of s.stack) {
    if (it.kind === 'spell') {
      if (!it.card) v.push('spell on the stack without a card');
      else if (G.baseChar(it.card).is('Land')) v.push(`land ${it.card.name} on the stack`);
    } else if (it.kind === 'ability') {
      if (!it.key) v.push('ability on the stack without a key');
    } else v.push(`unknown stack item kind ${it.kind}`);
  }
  for (const p of [0, 1]) {
    const P = s.players[p];
    if (!isInt(P.life) || !isInt(P.poison)) v.push(`P${p} life/poison not integers`);
    if (P.landsPlayed > 1) v.push(`P${p} played ${P.landsPlayed} lands this turn`);
    for (const z of ['hand', 'library']) for (const c of P[z]) {
      if (c.tapped || c.damage || Object.keys(c.counters).length || (c.mods && c.mods.length) || c.playable || c.onAdventure) {
        v.push(`${c.name} in ${z} carries battlefield/exile state`);
      }
    }
  }

  // 3. State machine.
  if (s.over) {
    if (s.pending) v.push('game over but a decision is pending');
  } else {
    const pend = s.pending;
    if (!pend) v.push('no pending decision in a running game');
    else {
      if (pend.player !== 0 && pend.player !== 1) v.push(`pending player ${pend.player}`);
      if (s.step !== 'mulligan' && !G.STEPS.includes(s.step)) v.push(`invalid step ${s.step}`);
      if (pend.kind === 'priority' && s.priority !== pend.player) v.push('priority holder mismatch');
      if (pend.kind === 'priority' && s.triggerQueue.length) v.push('priority given while triggers wait to go on the stack');
      if (s.suspended && pend.kind !== 'scry' && pend.kind !== 'choice') v.push(`resolution suspended but pending is ${pend.kind}`);
      if ((pend.kind === 'scry' || pend.kind === 'choice') && !s.suspended) v.push(`${pend.kind} decision outside a resolution`);
      if (G.legalActions(s).length === 0) v.push(`deadlock: no legal actions for ${pend.kind}`);
    }
    // 4. At priority, state-based actions must already be applied.
    if (pend && pend.kind === 'priority') {
      for (const p of [0, 1]) if (s.players[p].life <= 0) v.push(`P${p} at ${s.players[p].life} life but game continues`);
      for (const c of s.battlefield) {
        if (G.isType(c, 'Creature', s)) {
          const t = G.toughOf(s, c);
          if (t <= 0 || (c.damage >= t && !G.hasKw(c, 'indestructible'))) v.push(`${c.name} should have died (damage ${c.damage}, toughness ${t})`);
        }
        if (G.isType(c, 'Planeswalker', s) && (c.counters.loyalty || 0) <= 0) v.push(`${c.name} at 0 loyalty still on battlefield`);
      }
    }
    // 5. Hand size is enforced at end of turn.
    if (s.step === 'upkeep' && s.turn > 1 && s.players[1 - s.active].hand.length > G.MAX_HAND) {
      v.push(`P${1 - s.active} kept ${s.players[1 - s.active].hand.length} cards past cleanup`);
    }
    // 6. Combat consistency.
    if (s.combat) {
      for (const a of s.combat.attackers) {
        const c = G.find(s, a.id);
        if (!c) v.push(`attacker ${a.id} not on battlefield`);
        else if (c.controller !== s.active) v.push(`attacker ${c.name} not controlled by active player`);
        else if (!c.tapped && !G.hasKw(c, 'vigilance')) v.push(`attacker ${c.name} untapped without vigilance`);
      }
      for (const b of s.combat.blocks) {
        const c = G.find(s, b.blocker);
        if (!c) v.push(`blocker ${b.blocker} not on battlefield`);
        else if (c.controller === s.active) v.push(`blocker ${c.name} controlled by attacker`);
      }
    }
  }
  return v;
}

module.exports = { checkInvariants };
