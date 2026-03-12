# Magic The Gathering — Tap & Go

Play Magic: The Gathering against a friend online, or hotseat on the same computer.

## Features

- 8 pre-built decks across two difficulty levels, including a Pokemon-themed deck with custom card art
- Full spell stack with counterspells, counter-wars, and "can't be countered" support
- Modal spells ("choose one"), overload, adventure, foretell, cycling, flashback, and more
- Automatic combat resolution with all major keywords (flying, trample, deathtouch, lifelink, first strike, double strike, haste, vigilance, menace, reach, infect, toxic, hexproof, protection, indestructible)
- Planeswalker support with ability parsing, loyalty tracking, and damage targeting
- Real-time online multiplayer via Socket.io with reconnection support
- In-game card info overlay with auto-handling analysis and Scryfall rulings link

## Quick Start

```bash
npm install
npm start
```

Open `http://localhost:3000` in your browser.

## How to Play Online

1. Open the app and enter your nickname
2. Click **Create New Game** — share the link or room code with your friend
3. Your friend opens the link (or enters the code) and picks a nickname
4. Both players choose a deck (preset, paste decklist, or build custom), then click **Submit Deck & Ready Up**
5. The game starts when both players are ready!

## How to Play Hotseat

1. Click **Hotseat** from the main menu
2. Set up player names and avatars
3. Both players take turns on the same computer

## Documentation

- **[GAME_GUIDE.md](GAME_GUIDE.md)** — Full game guide and ruleset (English)
- **[SPILLEGUIDE.md](SPILLEGUIDE.md)** — Spilleguide på dansk (Danish)
- **[DEPLOY.md](DEPLOY.md)** — Deployment instructions

## Deploying

This runs as a single Node.js process (Express + Socket.io). Deploy to any Node.js host:

- **Render** (free tier): Connect your repo, set build command to `npm install`, start command to `npm start`
- **Railway**: Same as above
- **VPS**: Clone, `npm install`, `npm start` (use PM2 or systemd for production)

Set the `PORT` environment variable if needed (defaults to 3000).

## Project Structure

```
├── server/
│   ├── index.js          — Express + Socket.io server
│   ├── RoomManager.js    — Room creation/cleanup
│   └── GameRoom.js       — Game state, visibility filtering, actions
├── client/
│   └── public/
│       └── index.html    — Full game client (React + Babel CDN)
├── MTG Billeder/         — Custom card art (Pokemon reskins etc.)
├── sounds/               — Game sound effects (WAV)
├── GAME_GUIDE.md         — English game guide & ruleset
├── SPILLEGUIDE.md        — Danish spilleguide
├── DEPLOY.md             — Deployment guide
├── package.json
└── .env.example
```

## Architecture

- **Server-authoritative state**: Server holds the canonical game state
- **Information hiding**: Each player only sees their own hand; opponent hand shows card count only
- **Real-time sync**: Socket.io for instant state updates
- **Pre-cast targeting**: Caster selects targets at cast time, preventing information leaks
- **Link sharing**: No lobby needed — share a link or room code
- **Reconnection**: Disconnected players can rejoin within 5 minutes
- **Multiple games**: Each room is independent; unlimited concurrent games
