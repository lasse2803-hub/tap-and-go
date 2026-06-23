/*
 * card-effects.js — Etape 2: per-card effect DATA + dispatcher.
 *
 * getCardEffects(card) returns explicit effect data from the CARD_EFFECTS
 * registry (keyed by the real Scryfall card name) when present, and otherwise
 * falls back to parseSpellEffects(card) from rules-core.js. The effect objects
 * use the SAME schema the resolvers in index.html already consume
 * (applySpellEffect / applyNonTargetedEffects), so resolvers are untouched.
 *
 * WHY: regex-parsing oracle text is fragile ("fix one card, break three"). This
 * registry lets a card's effects be edited as data instead of by tweaking shared
 * regexes. It is also pure data (no React/DOM), which makes it portable to the
 * server in Etape 3.
 *
 * The seed below is the CURRENT parser output for preset instants/sorceries, so
 * behavior is identical to before for these cards — the win is that the effects
 * are now explicit, editable, and decoupled from the regex engine.
 *
 * KNOWN INACCURACIES (data edits — some now FIXED here, others remain as TODO):
 *   - "Get Lost": FIXED — targetType widened to creature/enchantment/planeswalker.
 *   - "Farewell": FIXED — 'graveyards' category restored.
 *   - "Fateful Absence": "investigate" is approximated as draw 1 (Clue token not modeled). TODO.
 *   - "Fading Hope": scry 1 is applied unconditionally (should require target mv <= 3). TODO.
 *
 * Dual environment:
 *   - Browser: loaded as a classic <script> AFTER rules-core.js and BEFORE the
 *     Babel block; exposes getCardEffects + CARD_EFFECTS as globals.
 *   - Node: require()s rules-core.js for the fallback and exports the same api.
 */
(function (root) {
  'use strict';

  const parseSpellEffects =
    (typeof module !== 'undefined' && module.exports)
      ? require('./rules-core.js').parseSpellEffects
      : root.parseSpellEffects;

  // Real Scryfall card name -> effect-object array (resolver schema).
  const CARD_EFFECTS = {
    // Lightning Strike deals 3 damage to any target.
    "Lightning Strike": [{"type":"damage","amount":3,"targetDesc":"any target","description":"Deal 3 damage to any target"}],
    // Spectacle {R} (You may cast this spell for its spectacle cost rather than its mana cost if an opponent lost life this turn.) Skewer the Critics deals 3 damage t
    "Skewer the Critics": [{"type":"damage","amount":3,"targetDesc":"any target","description":"Deal 3 damage to any target"}],
    // Play with Fire deals 2 damage to any target. If a player is dealt damage this way, scry 1. (Look at the top card of your library. You may put that card on the b
    "Play with Fire": [{"type":"damage","amount":2,"targetDesc":"any target","description":"Deal 2 damage to any target"},{"type":"scry","count":1,"mode":"scry","description":"Scry 1"}],
    // Counter target spell.
    "Counterspell": [{"type":"counter_spell","description":"Counter target spell"}],
    // Casualty 1 (As you cast this spell, you may sacrifice a creature with power 1 or greater. When you do, copy this spell and you may choose a new target for the c
    "Make Disappear": [{"type":"counter_spell","description":"Counter target spell"}],
    // This spell can't be countered. Counter target noncreature spell.
    "Dovin's Veto": [{"type":"counter_spell","description":"Counter target noncreature spell"}],
    // Counter target spell. You gain 3 life.
    "Absorb": [{"type":"counter_spell","description":"Counter target spell"},{"type":"gain_life","amount":3,"description":"Gain 3 life"}],
    // This spell can't be countered. Destroy all creatures.
    "Supreme Verdict": [{"type":"board_wipe","subtype":"destroy_all","description":"Destroy all creatures"}],
    // Choose one or more — • Exile all artifacts. • Exile all creatures. • Exile all enchantments. • Exile all graveyards.
    // FIX (Etape 2 expand): added 'graveyards' — the regex parser dropped it; executeFarewellChoice() supports it.
    "Farewell": [{"type":"farewell","categories":["artifacts","creatures","enchantments","graveyards"],"description":"Choose: exile artifacts, creatures, enchantments, graveyards"}],
    // Target player reveals their hand. You choose a nonland card from it. That player discards that card. You lose 2 life.
    "Thoughtseize": [{"type":"discard","description":"Target opponent discards"},{"type":"lose_life","amount":2,"description":"You lose 2 life"}],
    // Destroy target creature if it has mana value 2 or less. Revolt — Destroy that creature if it has mana value 4 or less instead if a permanent left the battlefiel
    "Fatal Push": [{"type":"destroy","targetType":"creature","description":"Destroy target creature"}],
    // Exile target creature or planeswalker. You gain 2 life.
    "Vraska's Contempt": [{"type":"exile","targetType":"creature or planeswalker","description":"Exile target creature or planeswalker"},{"type":"gain_life","amount":2,"description":"Gain 2 life"}],
    // Destroy target creature or planeswalker.
    "Hero's Downfall": [{"type":"destroy","targetType":"creature or planeswalker","description":"Destroy target creature or planeswalker"}],
    // Destroy target creature or planeswalker. Its controller investigates. (Create a Clue token. It's an artifact with "{2}, Sacrifice this token: Draw a card.")
    "Fateful Absence": [{"type":"destroy","targetType":"creature or planeswalker","description":"Destroy target creature or planeswalker"},{"type":"draw","amount":1,"description":"Draw 1 card"}],
    // Destroy target creature, enchantment, or planeswalker. Its controller creates two Map tokens. (They're artifacts with "{1}, {T}, Sacrifice this token: Target cr
    // FIX (Etape 2 expand): widened targetType so the targeting UI allows enchantments/planeswalkers (parser narrowed it to 'creature').
    "Get Lost": [{"type":"destroy","targetType":"creature, enchantment, or planeswalker","description":"Destroy target creature, enchantment, or planeswalker"}],
    // Look at the top six cards of your library. Put up to two creature cards with mana value 3 or less from among them onto the battlefield. Put the rest on the bott
    "Collected Company": [{"type":"look_top_battlefield","count":6,"toField":2,"selectFilter":{"type":"creature","maxMV":3},"description":"Look at top 6, put 2 onto battlefield"}],
    // Prevent all combat damage that would be dealt this turn. Each attacking creature doesn't untap during its controller's next untap step.
    "Tangle": [{"type":"prevent_combat_damage","description":"Prevent all combat damage this turn"}],
    // Surveil 1. (Look at the top card of your library. You may put it into your graveyard.) Draw a card.
    "Consider": [{"type":"scry","count":1,"mode":"surveil","description":"Surveil 1"},{"type":"draw","amount":1,"description":"Draw 1 card"}],
    // Look at the top four cards of your library. Put one of them into your hand and the rest on the bottom of your library in any order.
    "Impulse": [{"type":"look_top","count":4,"toHand":1,"description":"Look at top 4, put 1 into hand"}],
    // Look at the top X cards of your library, where X is the amount of mana spent to cast this spell. Put two of them into your hand and the rest on the bottom of yo
    "Memory Deluge": [{"type":"look_top","count":-1,"toHand":2,"description":"Look at top X, put 2 into hand"}],
    // Return target creature to its owner's hand. If its mana value was 3 or less, scry 1. (Look at the top card of your library. You may put that card on the bottom.
    "Fading Hope": [{"type":"bounce","targetType":"creature","description":"Return target creature to hand"},{"type":"scry","count":1,"mode":"scry","description":"Scry 1"}],
    // Spectacle {R} (You may cast this spell for its spectacle cost rather than its mana cost if an opponent lost life this turn.) Exile the top two cards of your lib
    "Light Up the Stage": [{"type":"exile_top_play","count":2,"untilNextTurn":true,"description":"Exile top 2 and play them"}],
  };

  // Registry hits are deep-cloned so resolvers can't mutate the shared registry.
  function getCardEffects(card) {
    if (!card) return [];
    if (card.name && Object.prototype.hasOwnProperty.call(CARD_EFFECTS, card.name)) {
      return JSON.parse(JSON.stringify(CARD_EFFECTS[card.name]));
    }
    return parseSpellEffects(card);
  }

  const api = { getCardEffects, CARD_EFFECTS };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof root !== 'undefined') {
    root.getCardEffects = getCardEffects;
    root.CARD_EFFECTS = CARD_EFFECTS;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
