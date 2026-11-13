/**
 * Explicit card implementations — the ONLY place card rules text becomes behavior.
 *
 * Entry shape:
 *   complete    true only when the card's ENTIRE rules text is executed exactly.
 *   spell       { targets, resolve } — instant/sorcery (main face)
 *   adventure   { targets, resolve } — the adventure half (card then goes to exile)
 *   altCosts    [{ kind: 'spectacle', cost: '{R}' }]
 *   static      { cantBlock, etbTapped(s, card, controller, h), replaceDamage(s, perm, ev, h),
 *                 types(s, card, types, h), power(s, card, h), spellCostDelta(s, perm, spell, h),
 *                 loyaltyInstantSpeed(s, card) }
 *   abilities   { key: ability } where ability.kind is
 *                 'trigger'   { on, match(s, ev, card), zone?, granted?, targets?, resolve, onChoice? }
 *                 'activated' { cost?, tap?, sacrifice?, loyalty?, removeCounters?, sorcerySpeed?, targets?, resolve }
 *                 'delayed'   { resolve } (created by fx.delayed)
 *               beneficial: true tells bots the targets should be their own things.
 *
 * targets: a named kind — 'any' | 'creature' | 'creatureOrPlaneswalker' |
 * 'playerOrPlaneswalker' — or an object { players, perm(s, c, controller, sourceId, h),
 * card(s, c, controller, sourceId, h), upTo } (perm = permanent, card = card in a
 * graveyard, upTo = "up to one", may be null). Chosen when cast / put on the stack,
 * re-checked on resolution. h = helpers (isType, isCardType, mv, devotion, find, powerOf).
 * resolve(fx, ctx): fx is the effects API in game.js (damage, destroy, exile, draw,
 * loseLife, gainLife, pump, addMod, createToken, delayed, exileTopPlayable, scry, ask,
 * pay, …); ctx = { controller, sourceId, sourceName, targets, ev, x, source }.
 * fx.scry / fx.ask pause resolution for a decision and must be the LAST call.
 *
 * Trigger events: cast {player, cardId, noncreature} · etb {cardId} · attacks {attackerId}
 * · attackWith {player, count} · becomesTarget {targetId, bySpell, spellController}
 * · beginCombat {player} · gainLife {player, amount} · ltb (the card's own, ev.linked).
 */
const RAGAVAN = { name: 'Ragavan', types: ['Creature'], subtypes: ['Monkey'], supertypes: ['Legendary'], power: 2, toughness: 1, colors: ['R'] };
const GOBLIN = { name: 'Goblin', types: ['Creature'], subtypes: ['Goblin'], power: 1, toughness: 1, colors: ['R'] };
const HUMAN = { name: 'Human', types: ['Creature'], subtypes: ['Human'], power: 1, toughness: 1, colors: ['W'] };
const SAMURAI = { name: 'Samurai', types: ['Creature'], subtypes: ['Samurai'], power: 2, toughness: 2, keywords: ['Vigilance'], colors: ['W'] };

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

  // ─── White Knight ───────────────────────────────────────────────────────────
  // Accorder Paladin: battle cry → engine keyword, no entry needed.

  // "Training / {2}{W}, Remove two +1/+1 counters from among creatures you control:
  //  Destroy target artifact or enchantment."
  'Hopeful Initiate': {
    complete: true,
    abilities: {
      destroy: {
        kind: 'activated', cost: '{2}{W}', removeCounters: { type: '+1/+1', n: 2 },
        targets: [{ perm: (s, c, ctrl, src, h) => h.isType(c, 'Artifact') || h.isType(c, 'Enchantment') }],
        resolve: (fx, ctx) => fx.destroy(ctx.targets[0].id),
      },
    },
  },

  // "First strike / Noncreature spells cost {1} more to cast."  (Every player's spells.)
  'Thalia, Guardian of Thraben': {
    complete: true,
    static: { spellCostDelta: (s, perm, spell) => (spell.types.includes('Creature') ? 0 : 1) },
  },

  // "At the beginning of combat on your turn, put a +1/+1 counter on target creature you control."
  'Luminarch Aspirant': {
    complete: true,
    abilities: {
      grow: {
        kind: 'trigger', on: 'beginCombat', match: (s, ev, c) => ev.player === c.controller, beneficial: true,
        targets: [{ perm: (s, c, ctrl, src, h) => c.controller === ctrl && h.isType(c, 'Creature') }],
        resolve: (fx, ctx) => fx.addCounter(ctx.targets[0].id, '+1/+1', 1),
      },
    },
  },

  // "Vigilance / Adeline's power is equal to the number of creatures you control. /
  //  Whenever you attack, for each opponent, create a 1/1 white Human creature token that's
  //  tapped and attacking that player or a planeswalker they control."  (Attacks the player.)
  'Adeline, Resplendent Cathar': {
    complete: true,
    static: { power: (s, card, h) => s.battlefield.filter(c => c.controller === card.controller && h.isType(c, 'Creature')).length },
    abilities: {
      humans: {
        kind: 'trigger', on: 'attackWith', match: (s, ev, c) => ev.player === c.controller,
        resolve: (fx, ctx) => fx.createToken(ctx.controller, HUMAN, { tapped: true, attacking: 'player' }),
      },
    },
  },

  // "When this creature enters, exile up to one target nonland, nontoken permanent you don't
  //  control with mana value 4 or less. / When this creature leaves the battlefield, the
  //  exiled card's owner creates an X/X blue Illusion creature token, where X is the mana
  //  value of the exiled card."
  'Skyclave Apparition': {
    complete: true,
    abilities: {
      exile: {
        kind: 'trigger', on: 'etb', match: (s, ev, c) => ev.cardId === c.id,
        targets: [{ upTo: true, perm: (s, c, ctrl, src, h) => !c.token && !h.isType(c, 'Land') && c.controller !== ctrl && h.mv(c) <= 4 }],
        resolve: (fx, ctx) => { if (ctx.targets[0]) fx.exileLinked(ctx.targets[0].id); },
      },
      illusion: {
        kind: 'trigger', on: 'ltb',
        resolve: (fx, ctx) => {
          for (const e of (ctx.ev.linked && ctx.ev.linked.exiled) || []) {
            fx.createToken(e.owner, { name: 'Illusion', types: ['Creature'], subtypes: ['Illusion'], power: e.mv, toughness: e.mv, colors: ['U'] });
          }
        },
      },
    },
  },

  // "Lifelink / When this creature enters, return target creature card with mana value 2 or
  //  less from your graveyard to the battlefield. That creature can't attack or block for as
  //  long as you control this creature."
  'Extraction Specialist': {
    complete: true,
    abilities: {
      reanimate: {
        kind: 'trigger', on: 'etb', match: (s, ev, c) => ev.cardId === c.id,
        targets: [{ card: (s, c, ctrl, src, h) => c.owner === ctrl && h.isCardType(c, 'Creature') && h.mv(c) <= 2 }],
        resolve: (fx, ctx) => fx.graveyardToBattlefield(ctx.targets[0].id, {
          controller: ctx.controller,
          mods: [{ until: 'whileSource', sourceOid: ctx.sourceOid, cantAttack: true, cantBlock: true }],
        }),
      },
    },
  },

  // "When this artifact enters, exile target nonland permanent an opponent controls with mana
  //  value 2 or less until this artifact leaves the battlefield."
  'Portable Hole': {
    complete: true,
    abilities: {
      exile: {
        kind: 'trigger', on: 'etb', match: (s, ev, c) => ev.cardId === c.id,
        targets: [{ perm: (s, c, ctrl, src, h) => !h.isType(c, 'Land') && c.controller !== ctrl && h.mv(c) <= 2 }],
        resolve: (fx, ctx) => fx.exileUntilLeaves(ctx.targets[0].id),
      },
    },
  },

  // "Destroy target creature or planeswalker. Its controller investigates."
  'Fateful Absence': {
    complete: true,
    spell: {
      targets: ['creatureOrPlaneswalker'],
      resolve: (fx, ctx) => {
        const t = fx.find(ctx.targets[0].id);
        const controller = t.controller;
        fx.destroy(t.id);
        fx.investigate(controller);
      },
    },
  },

  // "Flash / As long as The Wandering Emperor entered this turn, you may activate her loyalty
  //  abilities any time you could cast an instant. / +1: Put a +1/+1 counter on up to one
  //  target creature. It gains first strike until end of turn. / −1: Create a 2/2 white
  //  Samurai creature token with vigilance. / −2: Exile target tapped creature. You gain 2 life."
  'The Wandering Emperor': {
    complete: true,
    static: { loyaltyInstantSpeed: (s, card) => card.enteredTurn === s.turn },
    abilities: {
      plus: {
        kind: 'activated', loyalty: +1, beneficial: true,
        targets: [{ upTo: true, perm: (s, c, ctrl, src, h) => h.isType(c, 'Creature') }],
        resolve: (fx, ctx) => {
          const t = ctx.targets[0];
          if (!t) return;
          fx.addCounter(t.id, '+1/+1', 1);
          fx.pump(t.id, 0, 0, ['first strike']);
        },
      },
      samurai: { kind: 'activated', loyalty: -1, resolve: (fx, ctx) => fx.createToken(ctx.controller, SAMURAI) },
      exile: {
        kind: 'activated', loyalty: -2,
        targets: [{ perm: (s, c, ctrl, src, h) => h.isType(c, 'Creature') && c.tapped }],
        resolve: (fx, ctx) => { fx.exile(ctx.targets[0].id); fx.gainLife(ctx.controller, 2); },
      },
    },
  },

  // "Indestructible / As long as your devotion to white is less than five, Heliod isn't a
  //  creature. / Whenever you gain life, put a +1/+1 counter on target creature or enchantment
  //  you control. / {1}{W}: Another target creature gains lifelink until end of turn."
  'Heliod, Sun-Crowned': {
    complete: true,
    static: { types: (s, card, types, h) => (h.devotion(card.controller, 'W') < 5 ? types.filter(t => t !== 'Creature') : types) },
    abilities: {
      counter: {
        kind: 'trigger', on: 'gainLife', match: (s, ev, c) => ev.player === c.controller, beneficial: true,
        targets: [{ perm: (s, c, ctrl, src, h) => c.controller === ctrl && (h.isType(c, 'Creature') || h.isType(c, 'Enchantment')) }],
        resolve: (fx, ctx) => fx.addCounter(ctx.targets[0].id, '+1/+1', 1),
      },
      lifelink: {
        kind: 'activated', cost: '{1}{W}', beneficial: true,
        targets: [{ perm: (s, c, ctrl, src, h) => h.isType(c, 'Creature') && c.id !== src }],
        resolve: (fx, ctx) => fx.addMod(ctx.targets[0].id, { keywords: ['lifelink'] }),
      },
    },
  },

  // "{T}: Add {C}. / {1}: This land becomes a 2/2 creature with all creature types until end
  //  of turn. It's still a land."
  Mutavault: {
    complete: true,
    abilities: {
      animate: {
        kind: 'activated', cost: '{1}',
        resolve: (fx, ctx) => fx.addMod(ctx.sourceId, { types: ['Creature'], setPT: [2, 2], allCreatureTypes: true }),
      },
    },
  },

  // ─── Tokens with abilities ──────────────────────────────────────────────────
  // Clue: "{2}, Sacrifice this token: Draw a card."
  'token:Clue': {
    abilities: {
      draw: { kind: 'activated', cost: '{2}', sacrifice: true, resolve: (fx, ctx) => fx.draw(ctx.controller, 1) },
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
