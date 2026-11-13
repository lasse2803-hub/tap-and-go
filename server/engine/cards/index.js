/**
 * Explicit card implementations — the ONLY place card rules text becomes behavior.
 *
 * Entry shape:
 *   complete    true only when the card's ENTIRE rules text is executed exactly.
 *   spell       { targets, resolve } — instant/sorcery (main face)
 *   adventure   { targets, resolve } — the adventure half (card then goes to exile)
 *   altCosts    [{ kind: 'spectacle', cost: '{R}' }]
 *   static      { cantBlock, etbTapped(s, card, controller, h), replaceDamage(s, perm, ev, h) }
 *   abilities   { key: ability } where ability.kind is
 *                 'trigger'   { on, match(s, ev, card), zone?, granted?, targets?, resolve, onChoice? }
 *                 'activated' { cost, tap?, sorcerySpeed?, targets?, resolve }
 *                 'delayed'   { resolve } (created by fx.delayed)
 *
 * targets: 'any' | 'creature' | 'creatureOrPlaneswalker' | 'playerOrPlaneswalker' —
 * chosen when cast / put on the stack, re-checked on resolution.
 * resolve(fx, ctx): fx is the effects API in game.js (damage, destroy, exile, draw,
 * loseLife, gainLife, pump, addMod, createToken, delayed, exileTopPlayable, scry, ask,
 * pay, …); ctx = { controller, sourceId, sourceName, targets, ev, x, source }.
 * fx.scry / fx.ask pause resolution for a decision and must be the LAST call.
 *
 * Trigger events: cast {player, cardId, noncreature} · etb {cardId} · attacks {attackerId}
 * · attackWith {player, count} · becomesTarget {targetId, bySpell, spellController}.
 */
const RAGAVAN = { name: 'Ragavan', types: ['Creature'], subtypes: ['Monkey'], supertypes: ['Legendary'], power: 2, toughness: 1, colors: ['R'] };
const GOBLIN = { name: 'Goblin', types: ['Creature'], subtypes: ['Goblin'], power: 1, toughness: 1, colors: ['R'] };

module.exports = {
  // ─── Red Aggro ──────────────────────────────────────────────────────────────
  // Monastery Swiftspear: haste + prowess → engine keywords, no entry needed.

  // "Prowess / If a source you control would deal noncombat damage to a creature an
  //  opponent controls, put that many -1/-1 counters on that creature instead."
  'Soul-Scar Mage': {
    complete: true,
    static: {
      replaceDamage: (s, perm, ev, h) => {
        if (ev.combat || ev.asCounters || ev.sourceController !== perm.controller || ev.target.kind !== 'perm') return ev;
        const t = h.find(ev.target.id);
        if (!t || !h.isType(t, 'Creature') || t.controller === perm.controller) return ev;
        return { ...ev, asCounters: true };
      },
    },
  },

  // "First strike, menace / Whenever Kari Zev attacks, create Ragavan, a legendary 2/1 red
  //  Monkey creature token. Ragavan enters tapped and attacking. Exile that token at end
  //  of combat."  (Ragavan attacks the same player/planeswalker as Kari Zev.)
  'Kari Zev, Skyship Raider': {
    complete: true,
    abilities: {
      ragavan: {
        kind: 'trigger', on: 'attacks', match: (s, ev, c) => ev.attackerId === c.id,
        resolve: (fx, ctx) => {
          const id = fx.createToken(ctx.controller, RAGAVAN, { tapped: true, attacking: fx.attackTargetOf(ctx.sourceId) });
          fx.delayed('endCombat', 'Kari Zev, Skyship Raider#exileRagavan', { tokenId: id });
        },
      },
      exileRagavan: { kind: 'delayed', resolve: (fx, ctx) => fx.exile(ctx.ev.tokenId) },
    },
  },

  // "When this creature enters, it deals 2 damage to target player or planeswalker."
  'Viashino Pyromancer': {
    complete: true,
    abilities: {
      etb: {
        kind: 'trigger', on: 'etb', match: (s, ev, c) => ev.cardId === c.id, targets: ['playerOrPlaneswalker'],
        resolve: (fx, ctx) => fx.damage(ctx.source, ctx.targets[0], 2),
      },
    },
  },

  // Creature: "Whenever this creature becomes the target of a spell, this creature deals
  //  2 damage to that spell's controller."
  // Stomp {1}{R} Instant — Adventure: "Damage can't be prevented this turn. Stomp deals 2
  //  damage to any target."
  'Bonecrusher Giant': {
    complete: true,
    abilities: {
      punish: {
        kind: 'trigger', on: 'becomesTarget', match: (s, ev, c) => ev.bySpell && ev.targetId === c.id,
        resolve: (fx, ctx) => fx.damage(ctx.source, { kind: 'player', player: ctx.ev.spellController }, 2),
      },
    },
    adventure: { targets: ['any'], resolve: (fx, ctx) => { fx.noPrevention(); fx.damage(ctx.source, ctx.targets[0], 2); } },
  },

  // "Flying, haste / This creature can't block. / Whenever you attack with three or more
  //  creatures, you may pay {R}{R}. If you do, return this card from your graveyard to the
  //  battlefield tapped and attacking with a +1/+1 counter on it."
  //  (It attacks the defending player.)
  'Phoenix Chick': {
    complete: true,
    static: { cantBlock: true },
    abilities: {
      rise: {
        kind: 'trigger', zone: 'graveyard', on: 'attackWith', match: (s, ev, c) => ev.player === c.owner && ev.count >= 3,
        resolve: (fx, ctx) => {
          if (!fx.inGraveyard(ctx.sourceId) || !fx.canPay(ctx.controller, '{R}{R}')) return;
          fx.ask(ctx.controller, ['pay', 'decline'], 'onChoice', 'Pay {R}{R} to return Phoenix Chick tapped and attacking?');
        },
        onChoice: (fx, ctx, option) => {
          if (option !== 'pay' || !fx.inGraveyard(ctx.sourceId) || !fx.pay(ctx.controller, '{R}{R}')) return;
          fx.graveyardToBattlefield(ctx.sourceId, { tapped: true, attacking: 'player', counters: { '+1/+1': 1 } });
        },
      },
    },
  },

  // "Play with Fire deals 2 damage to any target. If a player is dealt damage this way,
  //  scry 1."
  'Play with Fire': {
    complete: true,
    spell: {
      targets: ['any'],
      resolve: (fx, ctx) => {
        const t = ctx.targets[0];
        const r = fx.damage(ctx.source, t, 2);
        if (t.kind === 'player' && r.dealt > 0) fx.scry(ctx.controller, 1);
      },
    },
  },

  // "Spectacle {R} / Skewer the Critics deals 3 damage to any target."
  'Skewer the Critics': {
    complete: true,
    altCosts: [{ kind: 'spectacle', cost: '{R}' }],
    spell: { targets: ['any'], resolve: (fx, ctx) => fx.damage(ctx.source, ctx.targets[0], 3) },
  },

  // "Spectacle {R} / Exile the top two cards of your library. Until the end of your next
  //  turn, you may play those cards."
  'Light Up the Stage': {
    complete: true,
    altCosts: [{ kind: 'spectacle', cost: '{R}' }],
    spell: { targets: [], resolve: (fx, ctx) => fx.exileTopPlayable(ctx.controller, 2) },
  },

  // "If you control two or more other lands, this land enters tapped. / {T}: Add {R}. /
  //  {3}{R}: Until end of turn, this land becomes a 3/2 red Goblin creature with
  //  'Whenever this creature attacks, create a 1/1 red Goblin creature token that's tapped
  //  and attacking.' It's still a land."
  'Den of the Bugbear': {
    complete: true,
    static: {
      etbTapped: (s, card, controller, h) => s.battlefield.filter(c => c.controller === controller && c.id !== card.id && h.isType(c, 'Land')).length >= 2,
    },
    abilities: {
      animate: {
        kind: 'activated', cost: '{3}{R}',
        resolve: (fx, ctx) => fx.addMod(ctx.sourceId, { types: ['Creature'], subtypes: ['Goblin'], colors: ['R'], setPT: [3, 2], grant: ['Den of the Bugbear#goblin'] }),
      },
      goblin: {
        kind: 'trigger', granted: true, on: 'attacks', match: (s, ev, c) => ev.attackerId === c.id,
        resolve: (fx, ctx) => fx.createToken(ctx.controller, GOBLIN, { tapped: true, attacking: fx.attackTargetOf(ctx.sourceId) }),
      },
    },
  },

  // ─── M1 proof set ───────────────────────────────────────────────────────────
  // "Lightning Strike deals 3 damage to any target."
  'Lightning Strike': {
    complete: true,
    spell: { targets: ['any'], resolve: (fx, ctx) => fx.damage(ctx.source, ctx.targets[0], 3) },
  },
  // "Destroy target creature. You lose 2 life."
  'Infernal Grasp': {
    complete: true,
    spell: { targets: ['creature'], resolve: (fx, ctx) => { fx.destroy(ctx.targets[0].id); fx.loseLife(ctx.controller, 2); } },
  },
  // "Destroy target creature or planeswalker."
  "Hero's Downfall": {
    complete: true,
    spell: { targets: ['creatureOrPlaneswalker'], resolve: (fx, ctx) => fx.destroy(ctx.targets[0].id) },
  },
  // "Exile target creature or planeswalker. You gain 2 life."
  "Vraska's Contempt": {
    complete: true,
    spell: { targets: ['creatureOrPlaneswalker'], resolve: (fx, ctx) => { fx.exile(ctx.targets[0].id); fx.gainLife(ctx.controller, 2); } },
  },
  // "You draw two cards and lose 2 life."
  "Night's Whisper": {
    complete: true,
    spell: { targets: [], resolve: (fx, ctx) => { fx.draw(ctx.controller, 2); fx.loseLife(ctx.controller, 2); } },
  },
  // "Destroy all creatures. They can't be regenerated."
  Damnation: {
    complete: true,
    spell: { targets: [], resolve: (fx) => { for (const c of fx.creatures()) fx.destroy(c.id); } },
  },
};
