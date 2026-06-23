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
| `rules-core.characterization.test.js` | Pure rules: mana parsing/payment, `parseSpellEffects` (the regex effect parser), card-type predicates, Arena decklist parsing | `require('../client/public/rules-core.js')` directly (a real module since Etape 1). |
| `server-gameroom.characterization.test.js` | Server state: deal/startGame, information hiding, the `stateSync` merge rules (incl. current desync guards), and the server-authoritative actions (bounce / discard / mill / mulligan / returnToOwnerZone) + Bo3 scoring | `require('../server/GameRoom.js')` directly. |
| `helpers/extract-fn.js` | A reusable seam: a tiny JS lexer that pulls a named `const NAME = …;` declaration out of `index.html` and evaluates it in the current realm | Not used by the active tests anymore (see below). Kept for extracting more functions in later steps. |

These are **characterization tests**: they assert what the code does *today*,
including a couple of known quirks (documented inline, e.g. mulligan's `newCount`
is the number of cards put back, not the resulting hand size). If a refactor
changes one of these behaviors **on purpose**, update the assertion in the same
commit and say why. A surprise failure means the refactor broke something.

### How Etape 1 used the seam (and why it's kept)

Before Etape 1 the pure rules functions lived inside the 16k-line `index.html`
as browser-transpiled (Babel) JSX and couldn't be `require`d. `extract-fn.js`
read their real source out of the HTML and ran it, so the tests exercised the
*actual* logic, not a copy.

Etape 1 then moved those 11 functions verbatim into `client/public/rules-core.js`
(a classic script that exposes them as globals for the Babel block and as
`module.exports` for Node). The tests were re-pointed at the module and stayed
green — that green run is the proof the extraction preserved behavior.

`extract-fn.js` is retained because more (currently non-pure) logic still lives
in `index.html`; the same seam can characterize the next batch before it moves.

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
