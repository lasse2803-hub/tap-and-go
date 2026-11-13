# Tap & Go rules engine

The server-side rules engine that will become the **single authority** over every game
(see the roadmap below). It lives in `server/engine/` and is independent of the current
live game (`server/GameRoom.js` + `client/public/index.html`), which keeps running
unchanged until the new engine replaces it.

## Why

The live game splits game truth between two clients that broadcast their state and a
server that merges it (version gates, tombstones, keepalives). Every card that touches
the other player needs its own guard, and card rules are guessed from oracle text with
regex inside a 17k-line React component, so nothing can be tested without two
browsers. The engine removes all three problems: one authority, rules as explicit
code, and whole games playable — and testable — without a browser.

## Layout

| File | Role |
|---|---|
| `game.js` | State machine: turn steps, priority & stack, casting, mana payment, combat, state-based actions, win/loss. Public API: `createGame`, `legalActions`, `applyAction`. |
| `cards/index.js` | Explicit card implementations — the only place rules text becomes behavior. |
| `cardDb.js` | Card characteristics from Scryfall's structured fields; explicit mana-source rules. |
| `mana.js` | Cost parsing and an exact payment solver. |
| `invariants.js` | Checks run after every action (card conservation, zones, state machine, SBA applied, combat consistency, no deadlock). |
| `bot.js` | `sensible` and `chaos` bots — pick only from legal actions. |
| `sim.js` | Plays N games across all deck pairings, checks invariants, reports failures and the unimplemented-card backlog. |
| `testkit.js` | Builds exact board states for rules scenario tests. |
| `rng.js` | Seeded PRNG stored in the game state → every game replays exactly from its seed. |
| `data/` | `cards.json` + `decks.json` (generated), `level3-decks.js` (source). |

## Card legality rule

**A card is allowed unless it is banned in the Historic format.** This is the owner's
decision (2026-11-11) and the only legality criterion:

- "Banned in Historic" → not allowed. Enforced by `npm run build:cards` (fails) and by
  `test/engine.test.js`.
- "Not legal in Historic" (the card was never released on MTG Arena) → **allowed**.
- Other formats (Modern, Pioneer, …) are not consulted.

Source: Scryfall's `legalities` per card, which tracks Wizards' official banned lists.
Rebuild the card data after a Historic banned-list update to pick up changes.

## Model

- **State** is plain JSON. `s.pending = { player, kind }` is the one decision the game
  is waiting for: `mulligan`, `bottom`, `priority`, `attackers`, `blockers`, `discard`.
- `legalActions(s)` lists what that player may do. Multi-select decisions return one
  template (`template: true`) that the caller fills in.
- `applyAction(s, action)` validates completely (an illegal action throws and leaves the
  state untouched) and advances to the next decision. Clients will only ever send
  actions — they never write state.

## Commands

```bash
npm test                                    # all tests, incl. test/engine.test.js
npm run sim -- --games 1000                 # simulate games
npm run sim -- --replay 137 --decks "Red Aggro|Blue Control" --policy chaos --verbose
npm run build:cards                         # refetch card data from Scryfall (+ legality check)
npm run mutation-test                       # inject rules bugs; every one must make a test fail
```

A simulator failure prints seed, decks and bot policies; `--replay` reproduces it
action for action. Run `npm run mutation-test` after changing the engine: a test suite
that stays green when the rules are broken is worthless.

## M1 scope (done)

Turn structure with real priority (both players pass to move on; LIFO stack), London
mulligan, land drops, casting with timing rules (sorcery speed, instants, flash), exact
mana payment incl. X and Phyrexian, targeting with hexproof and fizzling, combat
(attacking players and planeswalkers, flying/reach, menace, vigilance, haste,
summoning sickness, first/double strike, trample, deathtouch, lifelink, indestructible),
state-based actions (life, poison, empty library, lethal damage, deathtouch, 0
loyalty, legend rule), cleanup discard. Six cards fully implemented as proof of the
card mechanism: Lightning Strike, Infernal Grasp, Hero's Downfall, Vraska's Contempt,
Night's Whisper, Damnation.

## M2 progress — card pool, one deck at a time

Each deck is finished completely (every card's whole rules text, one test per card)
before the next. Card implementations live in `cards/index.js`; the header documents
the entry shape.

| Deck | Status |
|---|---|
| Red Aggro | ✅ 12/12 cards — `test/engine.redaggro.test.js` |
| White Knight | ✅ 13/13 cards — `test/engine.whiteknight.test.js` |
| other 13 decks | backlog (see `npm run sim`) |

Engine machinery added for Red Aggro (reused by every later deck):
triggered abilities on the stack (APNAP order, targets chosen when put on the stack,
removed if no legal target), events (`cast`, `etb`, `attacks`, `attackWith`,
`becomesTarget`), graveyard triggers, delayed triggers ("at end of combat"),
activated abilities, tokens (incl. entering tapped and attacking), continuous effects
until end of turn (P/T, keywords, "becomes a creature"), prowess, damage replacement
effects, enters-tapped conditions, "can't block", alternative costs (spectacle) with
"lost life this turn" tracking, adventure (cast the adventure, then the creature from
exile), "exile and you may play" until the end of your next turn, and decisions
during resolution (scry, "you may pay").

Added for White Knight: planeswalker loyalty abilities (once per turn, sorcery speed,
with per-card exceptions), devotion, state-dependent characteristics (types and P/T
that depend on the game — `isType(c, t, s)` / `powerOf(s, c)` throw if the state is
missing for such a card), spell cost increases, life-gain triggers (simultaneous
lifelink is one event), leaves-the-battlefield triggers with linked information,
"exile until this leaves the battlefield", targets in graveyards, "up to one" targets,
sacrifice and remove-counters costs, Clue tokens (token abilities), "for as long as"
restrictions (can't attack/block), training, battle cry, "at the beginning of combat",
and object identity (a permanent that leaves and returns is a new object).

### Known simplifications

- Cards outside finished decks: only their keywords and P/T work. The simulator lists
  them by how often they were played.
- Lands outside finished decks: enters-tapped conditions, pain-land damage, pathway face
  choice (treated as either color), creature lands, utility abilities. Nykthos taps for
  {C} only.
- `*`-power/toughness creatures (Adeline, Burrowguard Mentor, Tymaret) count as 0.
- Double-faced cards use their front face.
- Simultaneous triggers of one player go on the stack in event order (the player does
  not choose the order yet). Creatures put onto the battlefield attacking attack the
  same target as their source (Ragavan, Goblin tokens) or the defending player
  (Phoenix Chick).
- X is chosen as the maximum affordable when listed by `legalActions` (any X is
  accepted by `applyAction`). Damage-assignment order follows the block order.

## Roadmap

- **M1** — engine core + bots + simulator. ✅
- **M2** — implement the curated card pool explicitly, one test per card, driven by the
  simulator backlog.
- **M3** — thin client: the existing UI renders engine state and sends actions.
- **M4** — paid hosting (no idle spin-down) + persisted game state.
