# Magic The Gathering - Tap & Go

Play Magic: The Gathering against a friend online, or hotseat on the same computer.

## Quick Start

```bash
npm install
npm start
```

Open `http://localhost:3000` in your browser.

## How to Play Online

1. Open the app and click **Play Online**
2. Enter your nickname and click **Create New Game**
3. Share the link or 6-letter room code with your friend
4. Your friend opens the link (or enters the code) and picks a nickname
5. Both players build/choose decks, pick an avatar, then click **Submit Deck & Ready Up**
6. The game starts when both players are ready!

## How to Play Hotseat

1. Click **Hotseat** from the main menu
2. Set up player names and avatars
3. Both players take turns on the same computer

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
├── package.json
└── .env.example
```

## Architecture

- **Server-authoritative state**: Server holds the canonical game state
- **Information hiding**: Each player only sees their own hand; opponent hand shows card count only
- **Real-time sync**: Socket.io for instant state updates
- **Link sharing**: No lobby needed — share a link or room code
- **Reconnection**: Disconnected players can rejoin within 5 minutes
- **Multiple games**: Each room is independent; unlimited concurrent games
