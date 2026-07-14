/**
 * GameRoom — Manages a single game session between two players.
 *
 * Handles:
 * - Player connections/disconnections
 * - Deck submission and game start
 * - Game state management
 * - Visibility filtering (information hiding)
 * - Action processing and broadcasting
 * - Reconnection support
 */

const crypto = require('crypto');

class GameRoom {
  constructor(id, hostNickname) {
    this.id = id;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.status = 'waiting'; // waiting | ready | playing | finished

    // Player slots
    this.players = [
      { nickname: hostNickname, playerId: this.generatePlayerId(), socketId: null, connected: false, deck: null, sideboard: null, ready: false, avatar: null },
      { nickname: null, playerId: null, socketId: null, connected: false, deck: null, sideboard: null, ready: false, avatar: null }
    ];
    this.hostPlayerId = this.players[0].playerId;

    // Game state (will be populated when both decks are submitted)
    this.gameState = null;
    this.actionLog = [];
    this.cleanupTimer = null;

    // Monotonic broadcast sequence (sync ordering key). Every visible-state build
    // stamps a strictly-increasing, globally-unique _seq. Clients order incoming
    // updates by _seq with a strict '>' — unlike the old millisecond timestamp,
    // two updates can NEVER share a key, so a distinct update is never silently
    // dropped (the end-of-turn "Proceed" freeze root cause).
    this.broadcastSeq = 0;

    // Match state (Best of 3)
    this.matchType = 'single'; // 'single' | 'bo3'
    this.matchScore = [0, 0];
    this.matchGame = 0;
    this.matchWinner = null;
    this.lastGameWinnerIndex = null;
  }

  generatePlayerId() {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * Rebuild this room's game after a server restart (deploy / idle spin-down wiped
   * the in-memory rooms) from a client's last received state snapshot (a
   * getVisibleState payload). The resurrecting player's private zones are complete;
   * the opponent's hidden zones are stored empty and repopulate automatically from
   * that player's own periodic stateSync once they reconnect (own-index hand/library
   * are accepted in the merge). Note: bo3 "next game" needs decks, which are not in
   * the snapshot — resurrection covers finishing the CURRENT game.
   */
  resurrectFromSnapshot(playerIndex, nickname, playerId, snapshot) {
    if (!snapshot || !Array.isArray(snapshot.players) || snapshot.players.length !== 2) {
      return { error: 'Invalid snapshot' };
    }
    const oppIdx = playerIndex === 0 ? 1 : 0;
    this.players[playerIndex].nickname = nickname || this.players[playerIndex].nickname;
    this.players[playerIndex].playerId = playerId;
    this.players[playerIndex].ready = true;
    // Opponent seat is left vacant (playerId null) — their old playerId died with the
    // restart if THEY didn't resurrect; addPlayer adopts them into this seat on rejoin.
    this.players[oppIdx].nickname = snapshot.players[oppIdx]?.name || this.players[oppIdx].nickname || 'Opponent';
    this.players[oppIdx].playerId = null;
    this.players[oppIdx].ready = true;
    if (playerIndex === 0) this.hostPlayerId = playerId;

    const gs = JSON.parse(JSON.stringify(snapshot));
    delete gs.viewerIndex;
    if (gs.players[oppIdx]) {
      // Hidden-zone placeholders from the snapshot must not become real cards.
      gs.players[oppIdx].hand = [];
      gs.players[oppIdx].library = [];
    }
    gs.timestamp = Date.now();
    this.gameState = gs;
    this.status = 'playing';
    this.lastActivity = Date.now();
    return { ok: true };
  }

  /**
   * Add a player to this room (connect via socket)
   */
  addPlayer(socket, nickname, existingPlayerId) {
    this.lastActivity = Date.now();

    // Check if this is a reconnection (player has an existing ID)
    if (existingPlayerId) {
      const idx = this.players.findIndex(p => p.playerId === existingPlayerId);
      if (idx !== -1) {
        this.players[idx].socketId = socket.id;
        this.players[idx].connected = true;
        if (this.cleanupTimer) {
          clearTimeout(this.cleanupTimer);
          this.cleanupTimer = null;
        }
        console.log(`[GameRoom ${this.id}] Player ${idx} (${this.players[idx].nickname}) reconnected`);
        return { playerIndex: idx, playerId: existingPlayerId };
      }
    }

    // Resurrected room: a PLAYING room can have a vacant seat (playerId null but
    // nickname set) reserved for the other player of the original game. Their old
    // playerId is unknown to this rebuilt room — adopt them into the seat and keep
    // their playerId so future reconnects match normally.
    if (this.status === 'playing') {
      const vacantIdx = this.players.findIndex(p => p.playerId === null && p.nickname !== null);
      if (vacantIdx !== -1) {
        this.players[vacantIdx].playerId = existingPlayerId || this.generatePlayerId();
        this.players[vacantIdx].socketId = socket.id;
        this.players[vacantIdx].connected = true;
        if (nickname) this.players[vacantIdx].nickname = nickname;
        if (this.cleanupTimer) { clearTimeout(this.cleanupTimer); this.cleanupTimer = null; }
        console.log(`[GameRoom ${this.id}] Player ${vacantIdx} (${this.players[vacantIdx].nickname}) adopted into resurrected room`);
        return { playerIndex: vacantIdx, playerId: this.players[vacantIdx].playerId };
      }
    }

    // New player joining — find an open slot
    // Player 0 (host) is always pre-created, so check if they need to connect
    if (!this.players[0].connected && this.players[0].socketId === null) {
      // Host connecting for the first time
      this.players[0].socketId = socket.id;
      this.players[0].connected = true;
      this.players[0].nickname = nickname || this.players[0].nickname;
      console.log(`[GameRoom ${this.id}] Host (P0) connected: ${this.players[0].nickname}`);
      return { playerIndex: 0, playerId: this.players[0].playerId };
    }

    // Second player joining
    if (this.players[1].nickname === null) {
      this.players[1].nickname = nickname;
      this.players[1].playerId = this.generatePlayerId();
      this.players[1].socketId = socket.id;
      this.players[1].connected = true;
      this.status = 'ready';
      console.log(`[GameRoom ${this.id}] Player 1 joined: ${nickname}`);
      return { playerIndex: 1, playerId: this.players[1].playerId };
    }

    // Room is full
    return { error: 'Room is full' };
  }

  /**
   * Check if both player slots are taken
   */
  isFull() {
    return this.players[0].nickname !== null && this.players[1].nickname !== null;
  }

  /**
   * Submit a deck for a player
   */
  submitDeck(playerIndex, deck, avatar, sideboard) {
    if (playerIndex < 0 || playerIndex > 1) return { error: 'Invalid player' };
    if (!deck || !Array.isArray(deck) || deck.length === 0) return { error: 'Invalid deck' };

    this.players[playerIndex].deck = deck;
    this.players[playerIndex].sideboard = sideboard || [];
    this.players[playerIndex].ready = true;
    if (avatar) this.players[playerIndex].avatar = avatar;
    this.lastActivity = Date.now();

    const sideboardInfo = this.players[playerIndex].sideboard.length > 0 ? ` + ${this.players[playerIndex].sideboard.length} sideboard` : '';
    console.log(`[GameRoom ${this.id}] Player ${playerIndex} submitted deck (${deck.length} cards${sideboardInfo})`);
    return { ok: true };
  }

  /**
   * Check if both players have submitted decks
   */
  bothDecksSubmitted() {
    return this.players[0].ready && this.players[1].ready;
  }

  /**
   * Initialize game state from both decks
   */
  startGame(matchType = null, firstPlayerIndex = null) {
    this.status = 'playing';
    this.lastActivity = Date.now();
    if (matchType) this.matchType = matchType;
    if (this.matchGame === 0) this.matchGame = 1;

    // Flatten deck entries ({ card, qty } or raw card objects) into individual cards
    const flattenDeck = (deck) => {
      const cards = [];
      for (const entry of deck) {
        if (entry.card && entry.qty) {
          // { card, qty } format from DeckChooser
          for (let i = 0; i < entry.qty; i++) {
            const card = { ...entry.card, id: require('crypto').randomBytes(8).toString('hex'), tapped: false, counters: {}, enteredThisTurn: false };
            if (entry.card._reskin) card._reskin = entry.card._reskin;
            cards.push(card);
          }
        } else {
          // Raw card object — add an ID if missing
          if (!entry.id) entry.id = require('crypto').randomBytes(8).toString('hex');
          cards.push(entry);
        }
      }
      return cards;
    };

    // Shuffle each player's deck
    const shuffleDeck = (deck) => {
      const arr = [...deck];
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    };

    const p0Deck = shuffleDeck(flattenDeck(this.players[0].deck));
    const p1Deck = shuffleDeck(flattenDeck(this.players[1].deck));

    // Draw initial hands (7 cards each)
    const p0Hand = p0Deck.splice(0, 7);
    const p1Hand = p1Deck.splice(0, 7);

    // Who goes first: use provided index (Bo3 loser's choice) or random coin flip
    const firstPlayer = firstPlayerIndex !== null ? firstPlayerIndex : (Math.random() < 0.5 ? 0 : 1);

    this.gameState = {
      avatars: [this.players[0].avatar || null, this.players[1].avatar || null],
      players: [
        {
          nickname: this.players[0].nickname,
          life: 20,
          poison: 0,
          library: p0Deck,
          hand: p0Hand,
          battlefield: [],
          graveyard: [],
          exile: [],
          commandZone: [],
          manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
          counters: {},
          emblems: [],
          landPlayedThisTurn: false,
          dealtDamageThisTurn: false,
          commanderCastCount: 0,
          commanderDamageReceived: {},
          mulligansTaken: 0
        },
        {
          nickname: this.players[1].nickname,
          life: 20,
          poison: 0,
          library: p1Deck,
          hand: p1Hand,
          battlefield: [],
          graveyard: [],
          exile: [],
          commandZone: [],
          manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
          counters: {},
          emblems: [],
          landPlayedThisTurn: false,
          dealtDamageThisTurn: false,
          commanderCastCount: 0,
          commanderDamageReceived: {},
          mulligansTaken: 0
        }
      ],
      activePlayer: firstPlayer,
      currentPhase: 'main1',
      currentStep: 'untap',
      turnNumber: 1,
      stack: [],
      combatState: null,
      priorityPlayer: firstPlayer,
      timestamp: Date.now()
    };

    console.log(`[GameRoom ${this.id}] Game ${this.matchGame} started! (${this.matchType}, first player: ${firstPlayer})`);
    return this.gameState;
  }

  /**
   * Report a game win in a match — updates score, checks for match winner
   */
  gameWon(winnerIndex) {
    if (winnerIndex < 0 || winnerIndex > 1) return { error: 'Invalid winner' };
    // Server-authoritative guard (Etape 3.1): reject a win claim that
    // contradicts the server's state-based truth — e.g. a client declaring it
    // won while its OWN life is 0. Closes the "trust the client's gameWon" hole.
    const sbl = this.gameState && this.gameState.stateBasedLoss;
    if (sbl && sbl.winnerIndex !== winnerIndex) {
      return { error: 'Win claim contradicts game state', authoritativeWinner: sbl.winnerIndex };
    }
    this.lastGameWinnerIndex = winnerIndex;
    this.lastActivity = Date.now();

    if (this.matchType === 'single') {
      this.matchWinner = winnerIndex;
      this.status = 'finished';
      return { matchOver: true, winner: winnerIndex };
    }

    // Bo3: increment score
    this.matchScore[winnerIndex]++;
    console.log(`[GameRoom ${this.id}] Game ${this.matchGame} won by player ${winnerIndex}. Score: ${this.matchScore[0]}-${this.matchScore[1]}`);

    if (this.matchScore[winnerIndex] >= 2) {
      this.matchWinner = winnerIndex;
      this.status = 'finished';
      return { matchOver: true, winner: winnerIndex, matchScore: [...this.matchScore] };
    }

    // Match continues — next game
    this.status = 'between-games';
    const loserIndex = winnerIndex === 0 ? 1 : 0;
    return { matchOver: false, loser: loserIndex, nextGame: this.matchGame + 1, matchScore: [...this.matchScore] };
  }

  /**
   * Server-authoritative turn advancement (Etape 3.2).
   * Owns the scalar turn truth (activePlayer / turnNumber / phase reset) so the
   * two clients can't disagree on whose turn it is. Mirrors the client's rule:
   * turnNumber increments when play returns to player 0. Per-turn side-effects
   * (untap, draw, buff cleanup) remain client-side for now, driven by the
   * broadcast activePlayer change.
   * Returns { ok, activePlayer, turnNumber, currentPhase } or { error }.
   */
  advanceTurn(playerIndex) {
    if (!this.gameState || this.status !== 'playing') return { error: 'Game not in progress' };
    // Mirrors the proven stateSync acceptance logic: the active player advances
    // their own turn, OR the non-active player confirms the advance during the
    // end-of-turn respond window ("Proceed"), OR during the mulligan phase.
    const isActive = playerIndex === this.gameState.activePlayer;
    const isEndOfTurnProceed = !!this.gameState.endOfTurnRespond && !isActive;
    if (!isActive && !isEndOfTurnProceed && !this.gameState.mulliganPhase) {
      this._dec(`advanceTurn REJECT: P${playerIndex} not active (active=${this.gameState.activePlayer}), eot=${!!this.gameState.endOfTurnRespond}`);
      return { error: 'Not your turn' };
    }
    if (Array.isArray(this.gameState.spellStack) && this.gameState.spellStack.length > 0) {
      this._dec(`advanceTurn REJECT: stack not empty (${this.gameState.spellStack.length})`);
      return { error: 'Resolve the stack before passing the turn' };
    }
    this._dec(`advanceTurn OK: via ${isActive ? 'active' : isEndOfTurnProceed ? 'eot-proceed' : 'mulligan'}`);
    const prev = this.gameState.activePlayer;
    const next = prev === 0 ? 1 : 0;
    this.gameState.activePlayer = next;
    this.gameState.priorityPlayer = next;
    this.gameState.currentPhase = 'main1';
    this.gameState.currentStep = 'untap';
    if (next === 0) this.gameState.turnNumber = (this.gameState.turnNumber || 1) + 1;
    if (this.gameState.endOfTurnRespond) {
      this.gameState.endOfTurnRespondVersion = (this.gameState.endOfTurnRespondVersion || 0) + 1;
    }
    this.gameState.endOfTurnRespond = false;
    // New turn → "lost life this turn" resets for both players (Spectacle, etc.).
    for (const p of this.gameState.players) { if (p) p.lostLifeThisTurn = false; }

    // ── Turn-transition BOARD CLEANUP, done on the server's TRUE state ──────────
    // This used to run in the client's executePassTurn, mutating BOTH players'
    // boards on the *non-active* player (the one clicking "Proceed") and broadcasting
    // that player's stale snapshot of the opponent's board — clobbering it. Doing it
    // here (single source of truth) removes the clobber and makes the transition atomic.
    const players = this.gameState.players;

    // 1) Return temporarily-controlled cards to their owners (Act of Treason, etc.),
    //    tapped and stripped of granted haste — mirrors client returnTemporaryControl().
    for (let pi = 0; pi < 2; pi++) {
      const st = players[pi];
      if (!st || !Array.isArray(st.battlefield)) continue;
      if (!st.battlefield.some(c => c && c.temporaryControl)) continue;
      const staying = [];
      for (const c of st.battlefield) {
        if (c && c.temporaryControl) {
          const owner = (c.originalOwner !== undefined && c.originalOwner !== null) ? c.originalOwner : (pi === 0 ? 1 : 0);
          const ret = { ...c, tapped: true };
          delete ret.temporaryControl; delete ret.originalOwner;
          if (ret.grantedHaste) {
            ret.keywords = (ret.keywords || []).filter(k => (k || '').toLowerCase() !== 'haste');
            delete ret.grantedHaste;
          }
          if (players[owner] && Array.isArray(players[owner].battlefield)) players[owner].battlefield.push(ret);
        } else {
          staying.push(c);
        }
      }
      st.battlefield = staying;
    }

    // 2) Revert temporarily-animated lands (manlands) — mirrors client revertCreatureLands().
    for (let pi = 0; pi < 2; pi++) {
      const st = players[pi];
      if (!st || !Array.isArray(st.battlefield)) continue;
      st.battlefield = st.battlefield.map(c => {
        if (!c || !c.animatedCreature) return c;
        const orig = c.animatedData || {};
        return {
          ...c, animatedCreature: false, animatedData: null,
          power: undefined, toughness: undefined,
          type_line: orig.originalTypeLine || c.type_line,
          keywords: (c.keywords || []).filter(k => !((orig.keywords || []).includes(k))),
        };
      });
    }

    // 3) Per-board resets: zero manaPool (both); clear until-end-of-turn tempBuffs (both);
    //    clear damagePrevented that was set for the NEW active player (both); and for the
    //    NEW active player, untap + clear enteredThisTurn + reset per-turn flags + expire
    //    "until your next turn" effects.
    for (let pi = 0; pi < 2; pi++) {
      const st = players[pi];
      if (!st) continue;
      st.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
      if (Array.isArray(st.battlefield)) {
        st.battlefield = st.battlefield.map(c => {
          if (!c) return c;
          const nc = { ...c };
          if (nc.tempBuffs) nc.tempBuffs = null;
          if (nc.damagePrevented === next) nc.damagePrevented = undefined;
          if (pi === next) { nc.tapped = false; nc.enteredThisTurn = false; }
          return nc;
        });
      }
    }
    const na = players[next];
    if (na) {
      na.landPlayedThisTurn = false;
      na.dealtDamageThisTurn = false;
      na.untilNextTurnEffects = [];
    }

    this.gameState.timestamp = Date.now();
    return { ok: true, activePlayer: next, turnNumber: this.gameState.turnNumber, currentPhase: 'main1' };
  }

  // ── Server-authoritative spell stack (Etape 3.3) ────────────────
  // The server owns stack membership & order; effect RESOLUTION stays
  // client-side for now (the caster has the library/targets). Every op bumps
  // spellStackVersion so this stays compatible with the existing versioned sync.

  /** Push a spell/ability entry onto the stack. Assigns an id if missing. */
  stackPush(playerIndex, entry) {
    if (!this.gameState || this.status !== 'playing') return { error: 'Game not in progress' };
    if (!entry || typeof entry !== 'object') return { error: 'Invalid stack entry' };
    if (!Array.isArray(this.gameState.spellStack)) this.gameState.spellStack = [];
    const item = { ...entry, pIdx: entry.pIdx !== undefined ? entry.pIdx : playerIndex };
    if (!item.id) item.id = crypto.randomBytes(6).toString('hex');
    this.gameState.spellStack.push(item);
    this.gameState.spellStackVersion = (this.gameState.spellStackVersion || 0) + 1;
    this.gameState.timestamp = Date.now();
    return { ok: true, entryId: item.id, spellStack: this.gameState.spellStack, spellStackVersion: this.gameState.spellStackVersion };
  }

  /** Pop the top (last-added) entry — its effects are resolved client-side. */
  stackResolveTop() {
    if (!this.gameState || this.status !== 'playing') return { error: 'Game not in progress' };
    const stack = this.gameState.spellStack;
    if (!Array.isArray(stack) || stack.length === 0) return { error: 'Stack is empty' };
    const resolved = stack.pop();
    this.gameState.spellStackVersion = (this.gameState.spellStackVersion || 0) + 1;
    this.gameState.timestamp = Date.now();
    return { ok: true, resolved, spellStack: stack, spellStackVersion: this.gameState.spellStackVersion };
  }

  /** Remove a specific entry by id (e.g. a countered spell). */
  stackRemove(entryId) {
    if (!this.gameState || this.status !== 'playing') return { error: 'Game not in progress' };
    const stack = this.gameState.spellStack;
    if (!Array.isArray(stack) || stack.length === 0) return { error: 'Stack is empty' };
    const idx = stack.findIndex(e => e && e.id === entryId);
    if (idx === -1) return { error: 'Stack entry not found' };
    const [removed] = stack.splice(idx, 1);
    this.gameState.spellStackVersion = (this.gameState.spellStackVersion || 0) + 1;
    this.gameState.timestamp = Date.now();
    return { ok: true, removed, spellStack: stack, spellStackVersion: this.gameState.spellStackVersion };
  }

  /**
   * Server-authoritative life / poison change (Etape 3.4). Applies a delta to a
   * player's life and/or poison, then recomputes state-based loss. Life is
   * allowed to go <= 0 (the SBA check turns that into a loss). The most-changed
   * shared scalar, so owning it server-side removes a whole class of drift.
   */
  changeLife(targetPlayerIndex, lifeDelta = 0, poisonDelta = 0) {
    if (!this.gameState || this.status !== 'playing') return { error: 'Game not in progress' };
    const p = this.gameState.players[targetPlayerIndex];
    if (!p) return { error: 'Invalid target player' };
    if (lifeDelta) {
      p.life = (p.life || 0) + lifeDelta;
      if (lifeDelta < 0) p.lostLifeThisTurn = true;
    }
    if (poisonDelta) p.poison = (p.poison || 0) + poisonDelta;
    this.gameState.stateBasedLoss = this.checkStateBasedGameOver();
    this.gameState.timestamp = Date.now();
    return { ok: true, life: p.life, poison: p.poison, stateBasedLoss: this.gameState.stateBasedLoss };
  }

  /**
   * Server-authoritative state-based game-over check (Etape 3.1).
   * Scans the authoritative (synced) life / poison / commander-damage and
   * returns { loserIndex, winnerIndex, reason } for the first player that has
   * lost, or null if nobody has. Pure read — does not mutate state.
   */
  checkStateBasedGameOver() {
    if (!this.gameState || this.status !== 'playing') return null;
    const POISON_LETHAL = 10;
    const COMMANDER_LETHAL = 21;
    for (let i = 0; i < 2; i++) {
      const p = this.gameState.players[i];
      if (!p) continue;
      const winnerIndex = i === 0 ? 1 : 0;
      if (typeof p.life === 'number' && p.life <= 0) {
        return { loserIndex: i, winnerIndex, reason: `reached ${p.life} life` };
      }
      if (typeof p.poison === 'number' && p.poison >= POISON_LETHAL) {
        return { loserIndex: i, winnerIndex, reason: `reached ${p.poison} poison counters` };
      }
      const cmd = p.commanderDamageReceived || {};
      for (const dmg of Object.values(cmd)) {
        if (typeof dmg === 'number' && dmg >= COMMANDER_LETHAL) {
          return { loserIndex: i, winnerIndex, reason: `took ${dmg} commander damage` };
        }
      }
    }
    return null;
  }

  /**
   * Update deck after sideboard swap (Bo3 between games)
   */
  updateDeck(playerIndex, newDeck, newSideboard) {
    if (playerIndex < 0 || playerIndex > 1) return { error: 'Invalid player' };
    if (!newDeck || !Array.isArray(newDeck) || newDeck.length === 0) return { error: 'Invalid deck' };
    this.players[playerIndex].deck = newDeck;
    this.players[playerIndex].sideboard = newSideboard || [];
    this.lastActivity = Date.now();
    console.log(`[GameRoom ${this.id}] Player ${playerIndex} updated deck after sideboard swap (${newDeck.length} cards)`);
    return { ok: true };
  }

  /**
   * Start the next game in a Bo3 match — re-shuffles same decks, new hands
   */
  startNextGame(firstPlayerIndex) {
    this.matchGame++;
    // Reset player ready state but keep decks
    this.players[0].ready = true;
    this.players[1].ready = true;
    // Re-start the game with the same decks
    return this.startGame(null, firstPlayerIndex);
  }

  /**
   * Get state filtered for a specific player (information hiding)
   * Each player only sees their own hand and library count.
   */
  getVisibleState(playerIndex, opts = {}) {
    if (!this.gameState) return null;

    const state = JSON.parse(JSON.stringify(this.gameState)); // deep clone
    const opponentIndex = playerIndex === 0 ? 1 : 0;

    // Hide opponent's hand — only send count and card backs
    const opponentHand = state.players[opponentIndex].hand;
    state.players[opponentIndex].hand = opponentHand.map(() => ({
      hidden: true,
      id: crypto.randomBytes(4).toString('hex') // random ID so client can render card backs
    }));
    state.players[opponentIndex].handCount = opponentHand.length;

    // Hide opponent's library — only send count
    // Keep viewer's own library so they can draw/search
    state.players[opponentIndex].libraryCount = state.players[opponentIndex].library.length;
    state.players[opponentIndex].library = [];
    // For viewer's own library: keep full data but also include count
    state.players[playerIndex].libraryCount = state.players[playerIndex].library.length;
    // Broadcasts can omit the viewer's own library too (they own it locally and
    // never read it from a stateUpdate) — it is by far the heaviest zone.
    // requestState / join / resurrection responses keep it for full recovery.
    if (opts.omitOwnLibrary) state.players[playerIndex].library = [];

    // Add viewer info
    state.viewerIndex = playerIndex;

    // Unique, strictly-increasing ordering key for the client merge (see constructor).
    // Incremented per build, so each client's received stream is strictly increasing
    // and no two broadcasts ever collide — the fix for the dropped-update freeze.
    state._seq = ++this.broadcastSeq;
    // Mark FULL authoritative snapshots (game start / reconnect requestState /
    // resurrection). Deltas set omitOwnLibrary. On a full snapshot the client
    // re-baselines its _seq ref — which also recovers from a server restart, where
    // broadcastSeq resets to a low value the client would otherwise reject as stale.
    state._full = !opts.omitOwnLibrary;

    return state;
  }

  /**
   * Process a game action from a player
   * For the MVP, we use a "trust the client" model:
   * the client sends state diffs and the server applies them.
   * This keeps the existing game logic on the client side.
   */
  // Cross-player board reconciliation (see stateSync merge). A tombstone marks a card the
  // server removed from a player's battlefield (their client must not re-add it); a keepalive
  // marks a card the server added (their client must not drop it). Short TTL — just long
  // enough for the owner's client to receive and reconcile the authoritative change.
  _bfTombstone(playerIndex, cardId, ms = 12000) {
    if (!this.bfTombstones) this.bfTombstones = [{}, {}];
    if (cardId != null) this.bfTombstones[playerIndex][cardId] = Date.now() + ms;
  }
  _bfKeepalive(playerIndex, cardId, ms = 12000) {
    if (!this.bfKeepalive) this.bfKeepalive = [{}, {}];
    if (cardId != null) this.bfKeepalive[playerIndex][cardId] = Date.now() + ms;
  }
  // Same reconciliation for graveyard removals / exile additions (Ashiok's
  // "exile each opponent's graveyard" is a cross-player write to BOTH zones).
  _gyTombstone(playerIndex, cardId, ms = 12000) {
    if (!this.gyTombstones) this.gyTombstones = [{}, {}];
    if (cardId != null) this.gyTombstones[playerIndex][cardId] = Date.now() + ms;
  }
  _exileKeepalive(playerIndex, cardId, ms = 12000) {
    if (!this.exileKeepalive) this.exileKeepalive = [{}, {}];
    if (cardId != null) this.exileKeepalive[playerIndex][cardId] = Date.now() + ms;
  }
  // Hand is OWNER-authoritative, so a server-driven removal from a player's hand
  // (discard: Thoughtseize/Duress) is undone by that player's own heartbeat re-sending
  // its hand. A hand tombstone strips the discarded card from the owner's incoming hand;
  // the paired graveyard keepalive stops their stale sync from dropping the card the
  // server just put in their graveyard. (Bug: "Thoughtseize took Kari Zev but it stayed
  // in hand" — the card bounced back and duplicated in the graveyard.)
  _handTombstone(playerIndex, cardId, ms = 12000) {
    if (!this.handTombstones) this.handTombstones = [{}, {}];
    if (cardId != null) this.handTombstones[playerIndex][cardId] = Date.now() + ms;
  }
  _gyKeepalive(playerIndex, cardId, ms = 12000) {
    if (!this.gyKeepalive) this.gyKeepalive = [{}, {}];
    if (cardId != null) this.gyKeepalive[playerIndex][cardId] = Date.now() + ms;
  }

  // ── Sync observability (Trin 1) ─────────────────────────────
  // A ground-truth event log of every processed action: the turn-spine scalars
  // before/after, plus the accept/reject decisions taken in the stateSync merge.
  // This exists to DIAGNOSE the recurring end-of-turn/handoff freeze from captured
  // data instead of screenshots. Read via getEventLog() / the /api/room/:id/debug
  // endpoint; also mirrored to the server console when SYNC_DEBUG is set.
  _snap() {
    const gs = this.gameState;
    if (!gs) return null;
    return {
      ts: gs.timestamp,
      active: gs.activePlayer,
      prio: gs.priorityPlayer,
      phase: gs.currentPhase,
      step: gs.currentStep,
      turn: gs.turnNumber,
      eot: !!gs.endOfTurnRespond,
      eotV: gs.endOfTurnRespondVersion || 0,
      stackLen: Array.isArray(gs.spellStack) ? gs.spellStack.length : 0,
      stackV: gs.spellStackVersion || 0,
      combat: gs.combatState ? (gs.combatState.step || gs.combatState.phase || 'active') : null,
      combatV: gs.combatStateVersion || 0,
      mull: !!gs.mulliganPhase,
    };
  }
  _dec(msg) { if (Array.isArray(this._decisions)) this._decisions.push(msg); }
  _logEvent(by, action, before, after, result) {
    if (!this.eventLog) this.eventLog = [];
    this._eventSeq = (this._eventSeq || 0) + 1;
    const decisions = (this._decisions && this._decisions.length) ? this._decisions.slice() : undefined;
    // For stateSync, record which top-level keys the client tried to push — the
    // merge decisions above explain which were accepted vs. rejected and why.
    const keys = (action && action.type === 'stateSync' && action.state)
      ? Object.keys(action.state).filter(k => k !== 'players') : undefined;
    const entry = {
      seq: this._eventSeq,
      t: Date.now() - this.createdAt,
      by,
      type: action && action.type,
      before, after,
      err: result && result.error ? result.error : undefined,
      syncKeys: keys,
      decisions,
    };
    this.eventLog.push(entry);
    if (this.eventLog.length > 400) this.eventLog.shift();
    if (process.env.SYNC_DEBUG) {
      const b = before || {}, a = after || {};
      const d = decisions ? ' | ' + decisions.join('; ') : '';
      console.log(
        `[SYNC ${this.id}] #${entry.seq} +${entry.t}ms P${by} ${entry.type} ` +
        `active:${b.active}→${a.active} phase:${b.phase}→${a.phase} ` +
        `eot:${b.eot}/v${b.eotV}→${a.eot}/v${a.eotV} ` +
        `stack:${b.stackLen}/v${b.stackV}→${a.stackLen}/v${a.stackV} ` +
        `combat:${b.combat}/v${b.combatV}→${a.combat}/v${a.combatV}` +
        `${entry.err ? ' ERR:' + entry.err : ''}${d}`
      );
    }
  }
  getEventLog() { return this.eventLog || []; }

  processAction(playerIndex, action) {
    if (!this.gameState) return { error: 'Game not started' };
    const _before = this._snap();
    this._decisions = [];
    const _result = this._processActionInner(playerIndex, action);
    this._logEvent(playerIndex, action, _before, this._snap(), _result);
    return _result;
  }

  _processActionInner(playerIndex, action) {
    if (!this.gameState) return { error: 'Game not started' };
    this.lastActivity = Date.now();

    // Server-authoritative turn advancement (Etape 3.2). Reachable via the
    // gameAction channel; the existing broadcast then carries the new turn
    // state to both clients.
    if (action.type === 'advanceTurn') {
      const result = this.advanceTurn(playerIndex);
      this.gameState.stateBasedLoss = this.checkStateBasedGameOver();
      this.actionLog.push({ playerIndex, action: { type: 'advanceTurn' }, timestamp: Date.now() });
      return result;
    }

    // Server-authoritative spell stack (Etape 3.3), reachable via gameAction.
    if (action.type === 'stackPush') {
      const result = this.stackPush(playerIndex, action.entry);
      this.actionLog.push({ playerIndex, action: { type: 'stackPush' }, timestamp: Date.now() });
      return result;
    }
    if (action.type === 'stackResolveTop') {
      const result = this.stackResolveTop();
      this.gameState.stateBasedLoss = this.checkStateBasedGameOver();
      this.actionLog.push({ playerIndex, action: { type: 'stackResolveTop' }, timestamp: Date.now() });
      return result;
    }
    if (action.type === 'stackRemove') {
      const result = this.stackRemove(action.entryId);
      this.actionLog.push({ playerIndex, action: { type: 'stackRemove' }, timestamp: Date.now() });
      return result;
    }
    if (action.type === 'changeLife') {
      const result = this.changeLife(action.targetPlayerIndex, action.lifeDelta || 0, action.poisonDelta || 0);
      this.actionLog.push({ playerIndex, action: { type: 'changeLife' }, timestamp: Date.now() });
      return result;
    }
    if (action.type === 'setEndOfTurnRespond') {
      // Server-owned end-of-turn respond flag (turn-authority slice). One authoritative
      // version counter kills the cross-client drift that hid "Pass Turn" from the opponent.
      this.gameState.endOfTurnRespond = !!action.value;
      this.gameState.endOfTurnRespondVersion = (this.gameState.endOfTurnRespondVersion || 0) + 1;
      this._dec(`setEndOfTurnRespond=${!!action.value} → v${this.gameState.endOfTurnRespondVersion}`);
      // When the non-active player clears the flag ("Proceed"), their activePlayer flip
      // arrives in a stateSync moments later — allow it via a short grace window.
      if (!action.value) this._eotClearedAt = Date.now();
      this.gameState.timestamp = Date.now();
      this.actionLog.push({ playerIndex, action: { type: 'setEndOfTurnRespond', value: !!action.value }, timestamp: Date.now() });
      return { ok: true, endOfTurnRespond: this.gameState.endOfTurnRespond, endOfTurnRespondVersion: this.gameState.endOfTurnRespondVersion };
    }

    // For MVP: the client sends the updated state for its own zones.
    // Server merges and broadcasts.
    if (action.type === 'stateSync') {
      // Client sends its view of the full state — server merges
      const update = action.state;

      // Merge player states
      for (let i = 0; i < 2; i++) {
        if (update.players && update.players[i]) {
          const u = update.players[i];
          const s = this.gameState.players[i];

          // Update public zones (any player can modify — e.g. combat affects opponent)
          // Server-authoritative "lost life this turn" (robust Spectacle fix):
          // detect any life decrease here and own the flag — clients never set it,
          // so the previous dual-writer race (defender re-syncing it false) is gone.
          if (u.life !== undefined) {
            if (typeof s.life === 'number' && u.life < s.life) s.lostLifeThisTurn = true;
            s.life = u.life;
          }
          if (u.poison !== undefined) s.poison = u.poison;
          if (u.battlefield) {
            // Server-authoritative reconciliation of CROSS-PLAYER board changes: the owner's
            // client is authoritative for its own board, so without this its periodic sync
            // would UNDO changes another player made via server actions (tuck/bounce removing
            // your card; a token added to your board). Short-lived tombstones/keepalives make
            // those server changes stick until the owner's client has reconciled.
            const now = Date.now();
            const tomb = (this.bfTombstones && this.bfTombstones[i]) || {};
            const keep = (this.bfKeepalive && this.bfKeepalive[i]) || {};
            let bf = u.battlefield.filter(c => !(tomb[c.id] && tomb[c.id] > now)); // drop server-removed cards
            for (const id in keep) { // re-add server-added cards the owner's stale sync dropped
              if (keep[id] > now && !bf.some(c => c.id === id)) {
                const existing = s.battlefield.find(c => c.id === id);
                if (existing) bf.push(existing);
              }
            }
            s.battlefield = bf;
          }
          if (u.graveyard) {
            const now = Date.now();
            const gyTomb = (this.gyTombstones && this.gyTombstones[i]) || {};
            const gyKeep = (this.gyKeepalive && this.gyKeepalive[i]) || {};
            let gy = u.graveyard.filter(c => !(gyTomb[c.id] && gyTomb[c.id] > now));
            for (const id in gyKeep) { // re-add server-discarded cards the owner's stale sync dropped
              if (gyKeep[id] > now && !gy.some(c => c.id === id)) {
                const existing = (s.graveyard || []).find(c => c.id === id);
                if (existing) gy = [...gy, existing];
              }
            }
            s.graveyard = gy;
          }
          if (u.exile) {
            const now = Date.now();
            const exKeep = (this.exileKeepalive && this.exileKeepalive[i]) || {};
            let ex = u.exile;
            for (const id in exKeep) { // re-add server-exiled cards the owner's stale sync dropped
              if (exKeep[id] > now && !ex.some(c => c.id === id)) {
                const existing = (s.exile || []).find(c => c.id === id);
                if (existing) ex = [...ex, existing];
              }
            }
            s.exile = ex;
          }
          if (u.manaPool) s.manaPool = u.manaPool;
          if (u.counters) s.counters = u.counters;
          if (u.emblems) s.emblems = u.emblems;
          if (u.commandZone) s.commandZone = u.commandZone;
          if (u.commanderDamageReceived) s.commanderDamageReceived = u.commanderDamageReceived;
          if (u.untilNextTurnEffects) s.untilNextTurnEffects = u.untilNextTurnEffects;
          // dealtDamageThisTurn: public — either player can set this (e.g. when
          // you deal damage to the opponent, YOUR client marks THEIR flag).
          if (u.dealtDamageThisTurn !== undefined) s.dealtDamageThisTurn = u.dealtDamageThisTurn;
          // Library & hand: only the owning player can update these.
          // The opponent's client receives library as [] (filtered/hidden),
          // so accepting their sync would wipe the real library data.
          if (i === playerIndex) {
            if (u.library) s.library = u.library;
            if (u.hand) {
              // Strip cards the server just discarded from this hand (owner-authoritative),
              // so a stale heartbeat can't re-add them until the owner's client reconciles.
              const now = Date.now();
              const handTomb = (this.handTombstones && this.handTombstones[i]) || {};
              s.hand = u.hand.filter(c => !(handTomb[c.id] && handTomb[c.id] > now));
            }
            if (u.landPlayedThisTurn !== undefined) s.landPlayedThisTurn = u.landPlayedThisTurn;
            if (u.commanderCastCount !== undefined) s.commanderCastCount = u.commanderCastCount;
          }
        }
      }

      // Update game-level state
      // activePlayer: accept changes from the current active player,
      // OR from the non-active player during end-of-turn (they click "Proceed")
      if (update.activePlayer !== undefined && update.activePlayer !== this.gameState.activePlayer) {
        // Turn advancement DURING PLAY is server-authoritative via the advanceTurn intent.
        // A stateSync must NOT move activePlayer while the game is in progress — doing so
        // caused the game-breaking revert: right after advanceTurn flipped the turn, the
        // NEW active player's own routine stateSync still echoed its (briefly stale) view
        // of activePlayer, and because that player was now "active" the old rule accepted
        // it and flipped the turn straight back (both clients then disagreed / froze).
        // Only honor a stateSync activePlayer change during the mulligan phase, where the
        // first-player selection legitimately rides this path (no advanceTurn yet).
        if (this.gameState.mulliganPhase) {
          this.gameState.activePlayer = update.activePlayer;
          this._dec(`stateSync activePlayer ${update.activePlayer} ACCEPTED (mulligan)`);
          // Reset end-of-turn state when the active player changes (new turn)
          if (this.gameState.endOfTurnRespond) {
            this.gameState.endOfTurnRespond = false;
            this.gameState.endOfTurnRespondVersion = (this.gameState.endOfTurnRespondVersion || 0) + 1;
          }
        } else {
          this._dec(`stateSync activePlayer ${update.activePlayer} IGNORED (in play; server-authoritative; cur=${this.gameState.activePlayer})`);
        }
      }
      // currentPhase: only the ACTIVE player advances the phase in play. Accepting it from
      // the non-active player let their stale echo revert the phase (e.g. combat → main1).
      // Still honored during mulligan, where the game-level phase isn't player-owned yet.
      if (update.currentPhase !== undefined && update.currentPhase !== this.gameState.currentPhase) {
        if (playerIndex === this.gameState.activePlayer || this.gameState.mulliganPhase) {
          this.gameState.currentPhase = update.currentPhase;
          this._dec(`stateSync currentPhase ${update.currentPhase} ACCEPTED`);
        } else {
          this._dec(`stateSync currentPhase ${update.currentPhase} IGNORED (P${playerIndex} not active; cur=${this.gameState.currentPhase})`);
        }
      }
      if (update.currentStep) this.gameState.currentStep = update.currentStep;
      // turnNumber: only accept if >= current (can only increase, prevents stale regression)
      if (update.turnNumber && update.turnNumber >= (this.gameState.turnNumber || 1)) {
        this.gameState.turnNumber = update.turnNumber;
      }
      if (update.stack) this.gameState.stack = update.stack;
      if (update.combatState !== undefined) {
        // Version-gate combat like the spell stack. Without this, a stale stateSync from
        // the non-active player (combatState=null, sent before they received the active
        // player's combat-entry) would clobber the server's combat and bounce both clients
        // out of the combat step. null is gated too (its version rides top-level).
        const inV = (update.combatState && update.combatState._v) || update.combatStateVersion || 0;
        const curV = this.gameState.combatStateVersion || 0;
        if (inV >= curV) {
          this.gameState.combatState = update.combatState;
          this.gameState.combatStateVersion = inV;
          this._dec(`stateSync combatState=${update.combatState ? 'set' : 'null'} ACCEPTED (v${inV}>=${curV})`);
        } else {
          this._dec(`stateSync combatState=${update.combatState ? 'set' : 'null'} REJECTED (v${inV}<${curV})`);
        }
      }
      if (update.priorityPlayer !== undefined) this.gameState.priorityPlayer = update.priorityPlayer;

      // Mulligan state — version-gated (like spellStack) so a stale sync from the
      // waiting player can't revert the deciding player's keep/advance.
      if (update.mulliganVersion !== undefined) {
        const incomingVer = update.mulliganVersion || 0;
        const currentVer = this.gameState.mulliganVersion || 0;
        if (incomingVer >= currentVer) {
          this.gameState.mulliganVersion = incomingVer;
          if (update.mulliganPhase !== undefined) this.gameState.mulliganPhase = update.mulliganPhase;
          if (update.mulliganPlayer !== undefined) this.gameState.mulliganPlayer = update.mulliganPlayer;
        }
      } else {
        // Backward-compat: no version supplied (older client) — apply directly.
        if (update.mulliganPhase !== undefined) this.gameState.mulliganPhase = update.mulliganPhase;
        if (update.mulliganPlayer !== undefined) this.gameState.mulliganPlayer = update.mulliganPlayer;
      }
      if (update.mulliganCounts) this.gameState.mulliganCounts = update.mulliganCounts;

      // Spell stack, overlays, and shared game state
      // These must be forwarded so the opponent sees spells on the stack,
      // counter-choice overlays, library search state, instant casting, etc.
      if (update.spellStack !== undefined) {
        // Only accept spellStack updates with a higher version to prevent race conditions
        const incomingVer = update.spellStackVersion || 0;
        const currentVer = this.gameState.spellStackVersion || 0;
        if (incomingVer >= currentVer) {
          this.gameState.spellStack = update.spellStack;
          this.gameState.spellStackVersion = incomingVer;
        }
      }
      if (update.sacCounterChoice !== undefined) this.gameState.sacCounterChoice = update.sacCounterChoice;
      if (update.librarySearch !== undefined) this.gameState.librarySearch = update.librarySearch;
      if (update.instantCasting !== undefined) {
        const incomingVer = update.instantCastingVersion || 0;
        const currentVer = this.gameState.instantCastingVersion || 0;
        if (incomingVer >= currentVer) {
          this.gameState.instantCasting = update.instantCasting;
          this.gameState.instantCastingVersion = incomingVer;
        }
      }
      // endOfTurnRespond is SERVER-OWNED (set via the 'setEndOfTurnRespond' intent).
      // Clients no longer send it in stateSync; ignoring any legacy value here prevents
      // the cross-client version drift that made Pass Turn invisible to the opponent
      // (each client counted its own version, so one side's updates got rejected).
      if (update.pwAbilityOnStackVersion !== undefined) {
        const inV = update.pwAbilityOnStackVersion || 0;
        const curV = this.gameState.pwAbilityOnStackVersion || 0;
        if (inV >= curV) {
          this.gameState.pwAbilityOnStackVersion = inV;
          if (update.pwAbilityOnStack !== undefined) this.gameState.pwAbilityOnStack = update.pwAbilityOnStack;
        }
      } else if (update.pwAbilityOnStack !== undefined) {
        this.gameState.pwAbilityOnStack = update.pwAbilityOnStack;
      }
      if (update.pwReminder !== undefined) this.gameState.pwReminder = update.pwReminder;
      if (update.preventCombatDamage !== undefined) this.gameState.preventCombatDamage = update.preventCombatDamage;
      if (update.modalChoice !== undefined) this.gameState.modalChoice = update.modalChoice;
      if (update.searchExile !== undefined) this.gameState.searchExile = update.searchExile;
      if (update.spellResolveRequest !== undefined) this.gameState.spellResolveRequest = update.spellResolveRequest;
      if (update.abilityActivated !== undefined) this.gameState.abilityActivated = update.abilityActivated;
      if (update.pendingRemoteDraw !== undefined) this.gameState.pendingRemoteDraw = update.pendingRemoteDraw;
      if (update.pendingRemoteScry !== undefined) this.gameState.pendingRemoteScry = update.pendingRemoteScry;
      if (update.pendingRemoteLookTop !== undefined) this.gameState.pendingRemoteLookTop = update.pendingRemoteLookTop;
      // lookTopView removed from server sync — it's a local UI overlay only
      if (update.putLandFromHand !== undefined) this.gameState.putLandFromHand = update.putLandFromHand;
      if (update.discardChoice !== undefined) this.gameState.discardChoice = update.discardChoice;

      // Forward game log entries from one player to the other
      if (update.__logEntries) this.gameState.__logEntries = update.__logEntries;
      if (update.__logEntry) this.gameState.__logEntry = update.__logEntry;

      this.gameState.timestamp = Date.now();
    }

    // ── Server-side cross-visibility actions ──────────────────
    // These actions modify an opponent's hand or library, which can't
    // be done through the normal stateSync path (visibility filter blocks it).
    // The server operates on the true (unfiltered) game state.

    if (action.type === 'bounce') {
      // Move a card from any zone to a player's hand (bounce, return from graveyard, etc.)
      const { targetPlayerIndex, cardId, fromZone } = action;
      const target = this.gameState.players[targetPlayerIndex];
      if (!target) return { error: 'Invalid target player' };
      // Search for card in source zone, or across all zones if not specified
      const zones = fromZone ? [fromZone] : ['battlefield', 'graveyard', 'exile', 'commandZone'];
      let card = null;
      let foundZone = null;
      for (const z of zones) {
        if (!target[z]) continue;
        const idx = target[z].findIndex(c => c.id === cardId);
        if (idx !== -1) {
          card = { ...target[z][idx], tapped: false, enteredThisTurn: false };
          target[z].splice(idx, 1);
          foundZone = z;
          break;
        }
      }
      if (!card) return { error: 'Card not found' };
      // Clean up zone-specific properties
      if (foundZone === 'battlefield') {
        if (card.counters) card.counters = {};
        if (card.animatedCreature) { delete card.animatedCreature; delete card.power; delete card.toughness; delete card.keywords; }
        delete card.temporaryControl; delete card.originalOwner; delete card.grantedHaste;
      }
      target.hand.push(card);
      if (foundZone === 'battlefield') this._bfTombstone(targetPlayerIndex, cardId);
      this.gameState.timestamp = Date.now();
    }

    if (action.type === 'bounceAll') {
      // Mass bounce: return all nonland permanents (or creatures) to owners' hands
      // Used by overloaded Cyclone Rift, Evacuation, Whelming Wave, etc.
      const { targetPlayerIndex, filter, exceptions } = action;
      // filter: 'nonland' | 'creatures' | 'nonland permanents' | 'all'
      // exceptions: optional array of subtypes to exclude (e.g. ['kraken', 'leviathan'])
      const target = this.gameState.players[targetPlayerIndex];
      if (!target) return { error: 'Invalid target player' };
      const isLand = (c) => (c.type_line || '').toLowerCase().includes('land');
      const isCreature = (c) => (c.type_line || '').toLowerCase().includes('creature');
      const excList = (exceptions || []).map(e => e.toLowerCase());
      const shouldBounce = (c) => {
        if (filter === 'nonland' || filter === 'nonland permanents') { if (isLand(c)) return false; }
        else if (filter === 'creatures') { if (!isCreature(c)) return false; }
        // Check exceptions (creature subtypes like Kraken, Leviathan, etc.)
        if (excList.length > 0) {
          const typeLine = (c.type_line || '').toLowerCase();
          for (const ex of excList) { if (typeLine.includes(ex)) return false; }
        }
        return true;
      };
      const toBounce = target.battlefield.filter(shouldBounce);
      target.battlefield = target.battlefield.filter(c => !shouldBounce(c));
      toBounce.forEach(c => this._bfTombstone(targetPlayerIndex, c.id));
      // Clean up bounced cards and add to hand
      for (const card of toBounce) {
        const cleaned = { ...card, tapped: false, enteredThisTurn: false };
        if (cleaned.counters) cleaned.counters = {};
        if (cleaned.animatedCreature) { delete cleaned.animatedCreature; delete cleaned.power; delete cleaned.toughness; delete cleaned.keywords; }
        delete cleaned.temporaryControl; delete cleaned.originalOwner; delete cleaned.grantedHaste;
        delete cleaned.tempBuffs; delete cleaned.damagePrevented;
        target.hand.push(cleaned);
      }
      this.gameState.timestamp = Date.now();
      return { ok: true, bouncedCount: toBounce.length };
    }

    if (action.type === 'discardFromHand') {
      // Force-discard a specific card from a player's hand (by card index)
      // Used by discard effects (Thoughtseize, Duress, etc.)
      const { targetPlayerIndex, cardIndex } = action;
      const target = this.gameState.players[targetPlayerIndex];
      if (!target) return { error: 'Invalid target player' };
      if (cardIndex < 0 || cardIndex >= target.hand.length) return { error: 'Invalid card index' };
      const card = target.hand.splice(cardIndex, 1)[0];
      target.graveyard.push(card);
      // Hand is owner-authoritative: without these, the target's own heartbeat re-adds
      // the card to hand and drops it from the graveyard (the discarded card "comes back").
      this._handTombstone(targetPlayerIndex, card.id);
      this._gyKeepalive(targetPlayerIndex, card.id);
      this.gameState.timestamp = Date.now();
      return { ok: true, discardedCard: { name: card.name, id: card.id } };
    }

    if (action.type === 'millCards') {
      // Mill cards from a player's library to graveyard — or to EXILE with toExile
      // (Ashiok, Nightmare Muse's token: "each opponent exiles the top two cards").
      const { targetPlayerIndex, count, toExile } = action;
      const target = this.gameState.players[targetPlayerIndex];
      if (!target) return { error: 'Invalid target player' };
      const millCount = Math.min(count || 1, target.library.length);
      const milled = target.library.splice(0, millCount);
      if (toExile) {
        target.exile = [...(target.exile || []), ...milled];
        milled.forEach(c => this._exileKeepalive(targetPlayerIndex, c.id));
      } else {
        target.graveyard.push(...milled);
      }
      this.gameState.timestamp = Date.now();
      return { ok: true, milledCards: milled, newLibraryCount: target.library.length, toExile: !!toExile };
    }

    if (action.type === 'peekHand') {
      // Let a player see an opponent's hand (for discard selection)
      const { targetPlayerIndex } = action;
      const target = this.gameState.players[targetPlayerIndex];
      if (!target) return { error: 'Invalid target player' };
      return { ok: true, hand: target.hand };
    }

    if (action.type === 'tuckToLibrary') {
      // Move a battlefield permanent into its owner's library Nth-from-top
      // (Teferi Hero -3, etc.). Server-side because the target's library may be
      // the opponent's hidden zone, which the client cannot modify.
      const { targetPlayerIndex, cardId, position = 2 } = action;
      const target = this.gameState.players[targetPlayerIndex];
      if (!target) return { error: 'Invalid target player' };
      const idx = target.battlefield.findIndex(c => c.id === cardId);
      if (idx === -1) return { error: 'Card not on battlefield' };
      const card = { ...target.battlefield[idx], tapped: false, counters: {} };
      delete card.tempBuffs; delete card.damagePrevented; delete card.temporaryControl;
      delete card.originalOwner; delete card.grantedHaste;
      if (card.animatedCreature) { delete card.animatedCreature; delete card.power; delete card.toughness; delete card.keywords; }
      target.battlefield.splice(idx, 1);
      this._bfTombstone(targetPlayerIndex, cardId);
      const insertIdx = Math.min(Math.max(0, position), target.library.length);
      target.library.splice(insertIdx, 0, card);
      this.gameState.timestamp = Date.now();
      return { ok: true, cardName: card.name, newLibraryCount: target.library.length };
    }

    if (action.type === 'exileGraveyard') {
      // Exile a player's entire graveyard, server-authoritative (Ashiok, Dream Render).
      // Cross-player write to graveyard+exile — tombstones/keepalives stop the owner's
      // own sync from reverting it.
      const { targetPlayerIndex } = action;
      const target = this.gameState.players[targetPlayerIndex];
      if (!target) return { error: 'Invalid target player' };
      const moved = (target.graveyard || []).map(c => ({ ...c, tapped: false }));
      if (moved.length > 0) {
        target.exile = [...(target.exile || []), ...moved];
        target.graveyard = [];
        moved.forEach(c => { this._gyTombstone(targetPlayerIndex, c.id); this._exileKeepalive(targetPlayerIndex, c.id); });
      }
      this.gameState.timestamp = Date.now();
      this.actionLog.push({ playerIndex, action: { type: 'exileGraveyard', targetPlayerIndex }, timestamp: Date.now() });
      return { ok: true, exiledCount: moved.length };
    }

    if (action.type === 'exilePermanent') {
      // Move a battlefield permanent to its controller's exile (Skyclave Apparition,
      // Portable Hole, any "exile target permanent"). Cross-player when you exile an
      // OPPONENT's permanent — the owner is authoritative for their own board, so without
      // a server write + tombstone their heartbeat re-adds the card (the "opponent still
      // sees it on board after exile" bug). exiledBy links it for later return.
      const { targetPlayerIndex, cardId, exiledBy } = action;
      const target = this.gameState.players[targetPlayerIndex];
      if (!target) return { error: 'Invalid target player' };
      const idx = target.battlefield.findIndex(c => c.id === cardId);
      if (idx === -1) return { error: 'Card not on battlefield' };
      const card = { ...target.battlefield[idx], tapped: false, counters: {} };
      delete card.tempBuffs; delete card.damagePrevented; delete card.temporaryControl;
      delete card.originalOwner; delete card.grantedHaste;
      if (card.animatedCreature) { delete card.animatedCreature; delete card.power; delete card.toughness; delete card.keywords; }
      if (exiledBy) card.exiledBy = exiledBy;
      target.battlefield.splice(idx, 1);
      target.exile = [...(target.exile || []), card];
      this._bfTombstone(targetPlayerIndex, cardId);
      this._exileKeepalive(targetPlayerIndex, cardId);
      this.gameState.timestamp = Date.now();
      return { ok: true, cardName: card.name };
    }

    if (action.type === 'createBattlefieldToken') {
      // Create a token on a (possibly opponent's) battlefield, server-authoritative.
      // Used when one player's trigger makes a token under ANOTHER player's control
      // (Relic Robber → defending player creates a Goblin Construct). Owning this write
      // on the server prevents the target's own state sync from clobbering the token.
      const { targetPlayerIndex, token } = action;
      const target = this.gameState.players[targetPlayerIndex];
      if (!target || !token || !token.id) return { error: 'Invalid token creation' };
      // Idempotent: ignore a duplicate id (e.g. a retried action)
      if (target.battlefield.some(c => c.id === token.id)) return { ok: true, tokenName: token.name };
      target.battlefield.push({ ...token, tapped: false, counters: {} });
      this._bfKeepalive(targetPlayerIndex, token.id); // owner's stale sync must not drop it
      this.gameState.timestamp = Date.now();
      return { ok: true, tokenName: token.name };
    }

    if (action.type === 'mulligan') {
      // Server-side mulligan: shuffle hand+library, draw new hand
      const { targetPlayerIndex, newCount } = action;
      const target = this.gameState.players[targetPlayerIndex];
      if (!target) return { error: 'Invalid target player' };
      const drawSize = 7 - newCount;
      const allCards = [...target.hand, ...target.library];
      // Fisher-Yates shuffle
      for (let i = allCards.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [allCards[i], allCards[j]] = [allCards[j], allCards[i]];
      }
      if (drawSize <= 0) {
        target.hand = [];
        target.library = allCards;
      } else {
        target.hand = allCards.slice(0, drawSize);
        target.library = allCards.slice(drawSize);
      }
      if (!this.gameState.mulliganCounts) this.gameState.mulliganCounts = [0, 0];
      this.gameState.mulliganCounts[targetPlayerIndex] = newCount;
      this.gameState.timestamp = Date.now();
    }

    if (action.type === 'returnToOwnerZone') {
      // Return a stolen card to its original owner's zone (hand, graveyard, etc.)
      // Used when temporarily controlled creatures leave the battlefield
      const { controllerIndex, cardId, destinationZone } = action;
      const controller = this.gameState.players[controllerIndex];
      if (!controller) return { error: 'Invalid controller' };
      const cardIdx = controller.battlefield.findIndex(c => c.id === cardId);
      if (cardIdx === -1) return { error: 'Card not on battlefield' };
      const card = { ...controller.battlefield[cardIdx], tapped: false };
      const ownerIndex = card.originalOwner;
      if (ownerIndex === undefined || ownerIndex === controllerIndex) return { error: 'Card is not stolen' };
      const owner = this.gameState.players[ownerIndex];
      if (!owner) return { error: 'Invalid owner' };
      // Clean up card
      if (card.counters) card.counters = {};
      delete card.temporaryControl; delete card.originalOwner; delete card.grantedHaste;
      if (card.animatedCreature) { delete card.animatedCreature; delete card.power; delete card.toughness; delete card.keywords; }
      // Move card
      controller.battlefield.splice(cardIdx, 1);
      this._bfTombstone(controllerIndex, cardId); // controller's sync must not re-add the returned card
      const zone = destinationZone || 'graveyard';
      if (!owner[zone]) return { error: 'Invalid zone' };
      owner[zone].push(card);
      this.gameState.timestamp = Date.now();
    }

    // Server-authoritative state-based game-over (Etape 3.1): recompute after
    // any action that may have changed life/poison and record it on gameState
    // so it is broadcast to both clients (via getVisibleState's deep clone) and
    // used to validate gameWon() claims.
    if (this.gameState) {
      this.gameState.stateBasedLoss = this.checkStateBasedGameOver();
    }

    // Log the action
    this.actionLog.push({
      playerIndex,
      action: { type: action.type },
      timestamp: Date.now()
    });

    return { ok: true };
  }

  /**
   * Handle player disconnection
   */
  playerDisconnected(playerIndex, socketId) {
    if (playerIndex >= 0 && playerIndex <= 1) {
      this.players[playerIndex].connected = false;
      this.players[playerIndex].socketId = null;
      this.lastActivity = Date.now();
      console.log(`[GameRoom ${this.id}] Player ${playerIndex} (${this.players[playerIndex].nickname}) disconnected`);
    }
  }

  /**
   * Start a cleanup timer — if no one reconnects, the room is cleaned up
   */
  startCleanupTimer(onCleanup, timeoutMs = 5 * 60 * 1000) {
    // Only start timer if BOTH players are disconnected
    if (this.players.some(p => p.connected)) return;

    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    this.cleanupTimer = setTimeout(() => {
      if (!this.players.some(p => p.connected)) {
        onCleanup();
      }
    }, timeoutMs);
  }

  /**
   * Check if room has been abandoned (both disconnected for too long)
   */
  isAbandoned(timeoutMs) {
    if (this.players.some(p => p.connected)) return false;
    return Date.now() - this.lastActivity > timeoutMs;
  }

  /**
   * Get socket IDs for both players
   */
  getSocketIds() {
    return this.players.map(p => p.socketId);
  }

  /**
   * Get a player's nickname
   */
  getNickname(playerIndex) {
    return this.players[playerIndex]?.nickname || 'Unknown';
  }

  /**
   * Get public room info (safe to send to anyone)
   */
  getPublicInfo() {
    return {
      id: this.id,
      status: this.status,
      createdAt: this.createdAt,
      players: this.players.map(p => ({
        nickname: p.nickname,
        connected: p.connected,
        ready: p.ready
      })),
      matchInfo: {
        type: this.matchType,
        score: [...this.matchScore],
        game: this.matchGame,
        winner: this.matchWinner
      }
    };
  }

  /**
   * Clean up resources
   */
  destroy() {
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.gameState = null;
    this.actionLog = [];
  }
}

module.exports = GameRoom;
