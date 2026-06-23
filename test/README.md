# Test safety net (Etape 0)

This directory holds **behavior tests** that pin the current behavior of the game
so the upcoming refactor (extracting the rules engine, then moving game authority
to the server) can proceed without silently breaking things.

Run them with **no server required**:

```bash
npm test
```

That runs every `*.test.js` file in `test/` via Node's built-in test runner
(`node --test`). No extra dependencies are installed.

## What's here

| File | What it pins | How it reaches the code |
|------|--------------|-------------------------|
| `rules-core.characterization.test.js` | Pure client rules: mana parsing/payment, `parseSpellEffects` (the regex effect parser), card-type predicates, Arena decklist parsing | Extracts the **real source** of these functions out of `client/public/index.html` and runs it (see `helpers/extract-fn.js`). No copy-paste. |
| `server-gameroom.characterization.test.js` | Server state: deal/startGame, information hiding, the `stateSync` merge rules (incl. current desync guards), and the server-authoritative actions (bounce / discard / mill / mulligan / returnToOwnerZone) + Bo3 scoring | `require('../server/GameRoom.js')` directly. |
| `helpers/extract-fn.js` | The seam: a tiny JS lexer that pulls a named `const NAME = …;` declaration out of `index.html` and evaluates it in the current realm | — |

These are **characterization tests**: they assert what the code does *today*,
including a couple of known quirks (documented inline, e.g. mulligan's `newCount`
is the number of cards put back, not the resulting hand size). If a refactor
changes one of these behaviors **on purpose**, update the assertion in the same
commit and say why. A surprise failure means the refactor broke something.

### The seam, and what happens in Etape 1

The client rules engine currently lives inside the 16k-line `index.html` as
browser-transpiled (Babel) JSX, so it can't be `require`d. `extract-fn.js` reads
the real function source out of the HTML and runs it — that's how we test the
*actual* logic instead of a stale copy.

When Etape 1 moves these pure functions into a real module
(e.g. `client/public/rules-core.js`), point `loadFns` / `SOURCE_FILE` at the new
file. The same tests must stay green — that's the proof the extraction preserved
behavior.

## Legacy test files (in the project root)

These predate the safety net. Run them with `node <file>` individually.

| File | Status | Notes |
|------|--------|-------|
| `test-online.js` | **Real integration test** — keep | Drives the server over Socket.io. Needs a server running (`npm start`). |
| `test-decks.js` | **Real integration test** — keep | Pairwise games + Bo3 over Socket.io. Needs the server **and** network (Scryfall). |
| `test-game-logic.js` | Mixed | Some pure logic (copy-pasted from `index.html` — the pattern this net replaces) plus one Socket.io online test. |
| `test-recent-changes.js` | ⚠️ **Pattern-matching, not behavior** | Mostly `regex`-greps `index.html` to check that code *looks* a certain way. It passes if the text exists, even if the behavior is wrong, and breaks on any refactor without catching real bugs. Do not trust it as a safety net; migrate the cases worth keeping into real behavior tests here. |
| `test-spell-stack-online.js` | ⚠️ **Pattern-matching, not behavior** | Same caveat as above. |

`npm run test:integration` runs the two real integration tests (`test-online.js`,
`test-decks.js`) — start the server first.
