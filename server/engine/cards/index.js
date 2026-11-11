/**
 * Explicit card implementations — the ONLY place card rules text becomes behavior.
 *
 * Each entry: { complete, spell?: { targets: [kind…], resolve(fx, ctx) } }
 *   complete  true only when the card's ENTIRE rules text is executed exactly.
 *   targets   'any' | 'creature' | 'creatureOrPlaneswalker' — chosen on cast, re-checked
 *             on resolution (all illegal → the spell does nothing).
 *   resolve   gets the effects API (fx: damage, destroy, exile, draw, loseLife,
 *             gainLife, creatures) and ctx { controller, targets, x, source }.
 *
 * M1 proof set: cards whose full text maps onto the core engine. Everything else is
 * reported by the simulator as "needs implementation" (the M2 backlog).
 */
module.exports = {
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
