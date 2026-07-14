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

  const _rc = (typeof module !== 'undefined' && module.exports) ? require('./rules-core.js') : root;
  const parseSpellEffects = _rc.parseSpellEffects;
  const parseETBEffects = _rc.parseETBEffects;
  const parsePlaneswalkerAbilities = _rc.parsePlaneswalkerAbilities;

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

  // ── Creature/permanent ETB triggers (reminder schema: {icon,text,actionType?}) ──
  // Seeded verbatim from parseETBEffects for preset permanents (zero behavior change).
  const ETB_EFFECTS = {
    "Skyclave Apparition": [{"icon":"🚫","text":"Exile up to one target nonland, nontoken permanent an opponent controls with mana value 1+ (right-click it → Exile linked). Its owner gets an Illusion token only when Skyclave leaves."}],
    "Extraction Specialist": [{"icon":"⚡","text":"when this creature enters, return target creature card with mana value 2 or less"}],
    "Portable Hole": [{"icon":"🚫","text":"Exile target permanent"}],
    "Geralf's Messenger": [{"icon":"💀","text":"Target opponent loses 2 life"},{"icon":"⬆","text":"Put +1/+1 counter(s)"}],
    "Gray Merchant of Asphodel": [{"icon":"⚡","text":"when this creature enters, each opponent loses x life, where x is your devotion "}],
    "Viashino Pyromancer": [{"icon":"🔥","text":"Deal 2 damage to target player or planeswalker","actionType":"etb_damage_player_pw","damage":2}],
    // Omen of the Sea intentionally NOT here — it uses parseETBEffects, which now
    // emits a structured, executable "scry 2 then draw 1" effect.
  };
  function getETBEffects(card) {
    if (!card) return [];
    if (card.name && Object.prototype.hasOwnProperty.call(ETB_EFFECTS, card.name)) {
      return JSON.parse(JSON.stringify(ETB_EFFECTS[card.name]));
    }
    return parseETBEffects(card);
  }

  // ── Planeswalker loyalty abilities (schema: [{cost,text}]) ──
  // Seeded verbatim from parsePlaneswalkerAbilities for preset planeswalkers.
  const PW_ABILITIES = {
    "The Wandering Emperor": [{"cost":"+1","text":"Put a +1/+1 counter on up to one target creature. It gains first strike until end of turn."},{"cost":"-1","text":"Create a 2/2 white Samurai creature token with vigilance."},{"cost":"-2","text":"Exile target tapped creature. You gain 2 life."}],
    "Liliana, the Necromancer": [{"cost":"+1","text":"Target player loses 2 life."},{"cost":"-1","text":"Return target creature card from your graveyard to your hand."},{"cost":"-7","text":"Destroy up to two target creatures. Put up to two creature cards from graveyards onto the battlefield under your control."}],
    "Garruk, Unleashed": [{"cost":"+1","text":"Up to one target creature gets +3/+3 and gains trample until end of turn."},{"cost":"-2","text":"Create a 3/3 green Beast creature token. Then if an opponent controls more creatures than you, put a loyalty counter on Garruk."},{"cost":"-7","text":"You get an emblem with \"At the beginning of your end step, you may search your library for a creature card, put it onto the battlefield, then shuffle.\""}],
    "Jace, Architect of Thought": [{"cost":"+1","text":"Until your next turn, whenever a creature an opponent controls attacks, it gets -1/-0 until end of turn."},{"cost":"-2","text":"Reveal the top three cards of your library. An opponent separates those cards into two piles. Put one pile into your hand and the other on the bottom of your library in any order."},{"cost":"-8","text":"For each player, search that player's library for a nonland card and exile it, then that player shuffles. You may cast those cards without paying their mana costs."}],
    "Teferi, Hero of Dominaria": [{"cost":"+1","text":"Draw a card. At the beginning of the next end step, untap up to two lands."},{"cost":"-3","text":"Put target nonland permanent into its owner's library third from the top."},{"cost":"-8","text":"You get an emblem with \"Whenever you draw a card, exile target permanent an opponent controls.\""}],
    "Teferi, Time Raveler": [{"cost":"+1","text":"Until your next turn, you may cast sorcery spells as though they had flash."},{"cost":"-3","text":"Return up to one target artifact, creature, or enchantment to its owner's hand. Draw a card."}],
    "Elspeth, Sun's Champion": [{"cost":"+1","text":"Create three 1/1 white Soldier creature tokens."},{"cost":"-3","text":"Destroy all creatures with power 4 or greater."},{"cost":"-7","text":"You get an emblem with \"Creatures you control get +2/+2 and have flying.\""}],
    "Chandra, Torch of Defiance": [{"cost":"+1","text":"Exile the top card of your library. You may cast that card. If you don't, Chandra deals 2 damage to each opponent."},{"cost":"+1","text":"Add {R}{R}."},{"cost":"-3","text":"Chandra deals 4 damage to target creature."},{"cost":"-7","text":"You get an emblem with \"Whenever you cast a spell, this emblem deals 5 damage to any target.\""}],
    "Domri, Anarch of Bolas": [{"cost":"+1","text":"Add {R} or {G}. Creature spells you cast this turn can't be countered."},{"cost":"-2","text":"Target creature you control fights target creature you don't control."}],
    "Ashiok, Dream Render": [{"cost":"-1","text":"Target player mills four cards. Then exile each opponent's graveyard."}],
    "Narset, Parter of Veils": [{"cost":"-2","text":"Look at the top four cards of your library. You may reveal a noncreature, nonland card from among them and put it into your hand. Put the rest on the bottom of your library in a random order."}],
    "Ashiok, Nightmare Muse": [{"cost":"+1","text":"Create a 2/3 blue and black Nightmare creature token with \"Whenever this token attacks or blocks, each opponent exiles the top two cards of their library.\""},{"cost":"-3","text":"Return target nonland permanent to its owner's hand, then that player exiles a card from their hand."},{"cost":"-7","text":"You may cast up to three spells from among face-up cards your opponents own from exile without paying their mana costs."}],
    "Professor Onyx": [{"cost":"+1","text":"You lose 1 life. Look at the top three cards of your library. Put one of them into your hand and the rest into your graveyard."},{"cost":"-3","text":"Each opponent sacrifices a creature with the greatest power among creatures that player controls."},{"cost":"-8","text":"Each opponent may discard a card. If they don't, they lose 3 life. Repeat this process six more times."}],
    "Ugin, the Spirit Dragon": [{"cost":"+2","text":"Ugin deals 3 damage to any target."},{"cost":"-X","text":"Exile each permanent with mana value X or less that's one or more colors."},{"cost":"-10","text":"You gain 7 life, draw seven cards, then put up to seven permanent cards from your hand onto the battlefield."}],
    "Ugin, the Ineffable": [{"cost":"+1","text":"Exile the top card of your library face down and look at it. Create a 2/2 colorless Spirit creature token. When that token leaves the battlefield, put the exiled card into your hand."},{"cost":"-3","text":"Destroy target permanent that's one or more colors."}],
    "Ugin, Eye of the Storms": [{"cost":"+2","text":"You gain 3 life and draw a card."},{"cost":"0","text":"Add {C}{C}{C}."},{"cost":"-11","text":"Search your library for any number of colorless nonland cards, exile them, then shuffle. Until end of turn, you may cast those cards without paying their mana costs."}],
    "Nissa, Who Shakes the World": [{"cost":"+1","text":"Put three +1/+1 counters on up to one target noncreature land you control. Untap it. It becomes a 0/0 Elemental creature with vigilance and haste that's still a land."},{"cost":"-8","text":"You get an emblem with \"Lands you control have indestructible.\" Search your library for any number of Forest cards, put them onto the battlefield tapped, then shuffle."}],
    "Nissa, Ascended Animist": [{"cost":"+1","text":"Create an X/X green Phyrexian Horror creature token, where X is Nissa's loyalty."},{"cost":"-1","text":"Destroy target artifact or enchantment."},{"cost":"-7","text":"Until end of turn, creatures you control get +1/+1 for each Forest you control and gain trample."}],
    "Nissa of Shadowed Boughs": [{"cost":"+1","text":"Untap target land you control. You may have it become a 3/3 Elemental creature with haste and menace until end of turn. It's still a land."},{"cost":"-5","text":"You may put a creature card with mana value less than or equal to the number of lands you control onto the battlefield from your hand or graveyard with two +1/+1 counters on it."}],
  };
  function getPlaneswalkerAbilities(card) {
    if (!card) return [];
    if (card.name && Object.prototype.hasOwnProperty.call(PW_ABILITIES, card.name)) {
      return JSON.parse(JSON.stringify(PW_ABILITIES[card.name]));
    }
    return parsePlaneswalkerAbilities(card);
  }

  const api = { getCardEffects, CARD_EFFECTS, getETBEffects, ETB_EFFECTS, getPlaneswalkerAbilities, PW_ABILITIES };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof root !== 'undefined') {
    root.getCardEffects = getCardEffects;
    root.CARD_EFFECTS = CARD_EFFECTS;
    root.getETBEffects = getETBEffects;
    root.ETB_EFFECTS = ETB_EFFECTS;
    root.getPlaneswalkerAbilities = getPlaneswalkerAbilities;
    root.PW_ABILITIES = PW_ABILITIES;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
