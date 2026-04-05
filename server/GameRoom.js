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
  getVisibleState(playerIndex) {
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

    // Add viewer info
    state.viewerIndex = playerIndex;

    return state;
  }

  /**
   * Process a game action from a player
   * For the MVP, we use a "trust the client" model:
   * the client sends state diffs and the server applies them.
   * This keeps the existing game logic on the client side.
   */
  processAction(playerIndex, action) {
    if (!this.gameState) return { error: 'Game not started' };
    this.lastActivity = Date.now();

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
          if (u.life !== undefined) s.life = u.life;
          if (u.poison !== undefined) s.poison = u.poison;
          if (u.battlefield) s.battlefield = u.battlefield;
          if (u.graveyard) s.graveyard = u.graveyard;
          if (u.exile) s.exile = u.exile;
          if (u.manaPool) s.manaPool = u.manaPool;
          if (u.counters) s.counters = u.counters;
          if (u.emblems) s.emblems = u.emblems;
          if (u.commandZone) s.commandZone = u.commandZone;
          if (u.commanderDamageReceived) s.commanderDamageReceived = u.commanderDamageReceived;
          if (u.untilNextTurnEffects) s.untilNextTurnEffects = u.untilNextTurnEffects;
          // Library & hand: only the owning player can update these.
          // The opponent's client receives library as [] (filtered/hidden),
          // so accepting their sync would wipe the real library data.
          if (i === playerIndex) {
            if (u.library) s.library = u.library;
            if (u.hand) s.hand = u.hand;
            if (u.landPlayedThisTurn !== undefined) s.landPlayedThisTurn = u.landPlayedThisTurn;
            if (u.dealtDamageThisTurn !== undefined) s.dealtDamageThisTurn = u.dealtDamageThisTurn;
            if (u.commanderCastCount !== undefined) s.commanderCastCount = u.commanderCastCount;
          }
        }
      }

      // Update game-level state
      // activePlayer: only accept changes from the current active player
      // (prevents stale syncs from the non-active player reverting the turn)
      if (update.activePlayer !== undefined && update.activePlayer !== this.gameState.activePlayer) {
        if (playerIndex === this.gameState.activePlayer || this.gameState.mulliganPhase) {
          this.gameState.activePlayer = update.activePlayer;
          // Reset end-of-turn state when the active player changes (new turn)
          // Prevents stale endOfTurnRespond from carrying over and causing desync
          this.gameState.endOfTurnRespond = false;
        }
      }
      if (update.currentPhase) this.gameState.currentPhase = update.currentPhase;
      if (update.currentStep) this.gameState.currentStep = update.currentStep;
      // turnNumber: only accept if >= current (can only increase, prevents stale regression)
      if (update.turnNumber && update.turnNumber >= (this.gameState.turnNumber || 1)) {
        this.gameState.turnNumber = update.turnNumber;
      }
      if (update.stack) this.gameState.stack = update.stack;
      if (update.combatState !== undefined) this.gameState.combatState = update.combatState;
      if (update.priorityPlayer !== undefined) this.gameState.priorityPlayer = update.priorityPlayer;

      // Mulligan state
      if (update.mulliganPhase !== undefined) this.gameState.mulliganPhase = update.mulliganPhase;
      if (update.mulliganPlayer !== undefined) this.gameState.mulliganPlayer = update.mulliganPlayer;
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
      if (update.endOfTurnRespond !== undefined) {
        const incomingVer = update.endOfTurnRespondVersion || 0;
        const currentVer = this.gameState.endOfTurnRespondVersion || 0;
        if (incomingVer >= currentVer) {
          this.gameState.endOfTurnRespond = update.endOfTurnRespond;
          this.gameState.endOfTurnRespondVersion = incomingVer;
        }
      }
      if (update.pwAbilityOnStack !== undefined) this.gameState.pwAbilityOnStack = update.pwAbilityOnStack;
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
      this.gameState.timestamp = Date.now();
      return { ok: true, discardedCard: { name: card.name, id: card.id } };
    }

    if (action.type === 'millCards') {
      // Mill cards from a player's library to graveyard (used when milling opponent in online mode)
      const { targetPlayerIndex, count } = action;
      const target = this.gameState.players[targetPlayerIndex];
      if (!target) return { error: 'Invalid target player' };
      const millCount = Math.min(count || 1, target.library.length);
      const milled = target.library.splice(0, millCount);
      target.graveyard.push(...milled);
      this.gameState.timestamp = Date.now();
      return { ok: true, milledCards: milled, newLibraryCount: target.library.length };
    }

    if (action.type === 'peekHand') {
      // Let a player see an opponent's hand (for discard selection)
      const { targetPlayerIndex } = action;
      const target = this.gameState.players[targetPlayerIndex];
      if (!target) return { error: 'Invalid target player' };
      return { ok: true, hand: target.hand };
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
      const zone = destinationZone || 'graveyard';
      if (!owner[zone]) return { error: 'Invalid zone' };
      owner[zone].push(card);
      this.gameState.timestamp = Date.now();
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
