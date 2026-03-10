# Tap & Go — Game Guide & Ruleset

## Overview

Tap & Go is a digital MTG (Magic: The Gathering) board game that supports both local (hotseat) and online multiplayer. The game auto-handles many card mechanics, but some require manual action via right-click context menus.

---

## How to Look Up Card Handling

### In-Game Card Info (📖)
- **Right-click any card** → select **"📖 Card Info & Rulings"** at the bottom of the menu
- The overlay shows:
  - **Oracle text** — the official card text
  - **Auto-Handled by Game** (✅) — what the game does automatically
  - **Manual Action Required** (⚠️) — what you need to do yourself via right-click
  - **Tips** (💡) — helpful hints for using the card
  - **Scryfall link** — for official MTG rulings

### Quick Lookup Button (📖 Lookup)
- Click the **📖 Lookup** button (top-left, next to Log)
- Type a card name to search all zones
- If the card is in play, the info overlay opens
- If not found, Scryfall opens in a new tab

---

## What the Game Auto-Handles

### Spell Casting & Resolution
- **Mana cost deduction** — automatically paid from your mana pool when casting
- **Spell stack** — spells go on the stack; opponent sees "Resolve" / "Respond" buttons
- **Counterspells** — auto-detected; option appears when spells are on the stack
- **Spell targeting** — damage, destroy, exile, bounce, boost effects prompt for target selection
- **Spectacle cost** — shown as alternative when opponent took damage this turn

### Combat
- **Keywords**: Flying, trample, deathtouch, lifelink, first strike, double strike, haste, vigilance, menace, reach, indestructible, hexproof, infect, toxic — all applied automatically in combat
- **Defender** — creatures with defender cannot be declared as attackers
- **Protection** — damage prevention and blocking restrictions enforced
- **Combat damage triggers** — "Whenever ~ deals combat damage to a player" auto-detected
- **Attack triggers with tokens** — auto-creates tokens (e.g., Hero of Bladehold)
- **Damage prevention per creature** — via right-click "🛡 Prevent all damage until next turn"
- **Global combat damage prevention** — Fog-like effects via spell resolution

### Enter-the-Battlefield (ETB) Triggers
Auto-detected ETB effects include: damage, life loss/gain, draw, destroy, exile, bounce, +1/+1 counters, token creation, library search, scry, surveil, discard.

### Upkeep Triggers
- **Counter triggers** — "At the beginning of your upkeep, put a counter on ~" (e.g., Midnight Clock)
- **Self-damage triggers** — "deals damage to you" during upkeep (e.g., Goblin Construct)

### Planeswalkers
- **Ability parsing** — +/- abilities automatically parsed from oracle text
- **Loyalty tracking** — counters adjust automatically on ability activation
- **Token creation** — detected from planeswalker abilities

### Special Mechanics
- **Adventure** — both faces castable from hand; adventure spell exiles creature for later casting
- **Cycling** — right-click in hand to cycle (pay cost, draw card)
- **Foretell** — exile face-down from hand, cast later for foretell cost
- **Flashback / Jump-Start / Escape / Disturb / Unearth** — all available via right-click in graveyard
- **Creature lands** — activate via right-click (e.g., Den of the Bugbear, Mutavault)
- **Equipment & Auras** — attach via right-click "Attach to creature..."
- **Sacrifice abilities** — available via right-click on battlefield
- **Paid activated abilities** — auto-detected and shown in right-click menu

### Counters & Buffs
- **+1/+1 and -1/-1 counters** — add/remove via right-click or +/- buttons on card
- **Temporary buffs** — "Temp Buff" and "Temp Keywords" via right-click (until end of turn)
- **Damage prevention** — "🛡 Prevent all damage until next turn" (persists until your next turn)

---

## What Requires Manual Action

### Dies / Leaves-the-Battlefield Triggers
- The game shows a **reminder** when a card with LTB/dies effects leaves the battlefield
- You must **manually resolve** the effect (e.g., move cards, gain life, etc.)

### Complex ETB Triggers
- Some ETB effects are too complex to auto-parse
- The game shows what it detected; anything not listed needs manual resolution

### Attack Triggers (non-token)
- "Whenever ~ attacks" effects that don't create tokens need manual resolution

### Activated Abilities (partial)
- Some activated abilities are auto-detected (shown in right-click menu)
- Others require manual resolution — check the right-click menu for available options

### Token Creation (from complex sources)
- Use the **"Create Token"** button in the game for tokens not auto-created

---

## Damage Prevention System

### Per-Creature Prevention (Kiora's +1, etc.)
- **Right-click** on any creature (own or opponent's) → **"🛡 Prevent all damage until next turn"**
- The creature gets a blue **"🛡 No Dmg"** badge
- **Persists until YOUR next turn** — works through the opponent's entire turn
- The creature can still attack and block, but deals no combat damage
- Blockers can still deal damage TO a damage-prevented creature
- Clear early via right-click → "🛡 Remove damage prevention"

### Global Prevention (Fog effects)
- Cast a spell with "prevent all combat damage" → auto-applied for the entire combat phase

---

## Online Mode Notes

### Spell Resolution
- When you cast a spell, your **opponent** sees "Resolve" and "Respond" buttons
- The caster sees "Waiting for opponent..."
- Cards are removed from hand immediately when cast (not on resolution)

### State Sync
- Battlefield, graveyard, exile, spell stack, and combat state sync in real-time
- Hand and library are private — only you can see/modify your own
- Game log is shared — both players see the same log

### Turn Management
- Each player draws their own card when their turn starts
- "Until your next turn" effects (Kiora, Jace, etc.) clear when your turn begins

---

## Right-Click Actions Summary

### Your Cards (Battlefield)
- Tap/Untap
- Creature land activation
- Paid activated abilities
- Sacrifice abilities
- Planeswalker abilities (+loyalty adjustment)
- +1/+1 / -1/-1 counters
- Temp Buff / Temp Keywords (until end of turn)
- 🛡 Prevent all damage until next turn
- Equipment/Aura attachment
- Zone transfers (to hand, graveyard, exile, library)
- 📖 Card Info & Rulings

### Opponent's Cards (Battlefield)
- -1/-1 Counter
- 🛡 Prevent all damage until next turn
- Gain Control (permanent / until end of turn)
- Zone transfers (to hand, graveyard, exile, library)
- 📖 Card Info & Rulings

### Hand
- Cast spell / Play to battlefield
- Adventure (both faces)
- Spectacle cost (when available)
- Cycling / Foretell
- Zone transfers
- 📖 Card Info & Rulings

### Graveyard
- Flashback / Jump-Start / Escape / Disturb / Unearth
- Create Token Copy
- Zone transfers
- 📖 Card Info & Rulings

### Exile
- Cast foretold card
- Cast adventure creature (after adventure spell)
- Create Token Copy
- Zone transfers
- 📖 Card Info & Rulings

---

## Keyboard & UI Tips

- **📖 Lookup** button (top-left) — search for any card by name
- **📋 Log** button — view the shared game action log
- **Mana buttons** — tap lands for mana, visible in mana pool
- **Create Token** — for manually creating tokens
- **End Turn** — passes the turn with end-of-turn cleanup

---

*Last updated: March 2026*
