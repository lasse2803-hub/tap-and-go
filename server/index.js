/**
 * Tap & Go — Express + Socket.io Server
 * Serves the static client and handles real-time game communication.
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const RoomManager = require('./RoomManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.json());

// Serve static client files
app.use(express.static(path.join(__dirname, '..', 'client', 'public')));

// ─── Room Manager ───────────────────────────────────────────
const roomManager = new RoomManager();

// ─── REST API ───────────────────────────────────────────────

// Create a new room
app.post('/api/room/create', (req, res) => {
  const { nickname } = req.body;
  if (!nickname || nickname.trim().length === 0) {
    return res.status(400).json({ error: 'Nickname is required' });
  }
  const room = roomManager.createRoom(nickname.trim());
  res.json({ roomId: room.id, playerId: room.hostPlayerId });
});

// Get room status
app.get('/api/room/:id', (req, res) => {
  const room = roomManager.getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(room.getPublicInfo());
});

// Catch-all: serve index.html for client-side routing (e.g. /game/ABC123)
app.get('/game/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'public', 'index.html'));
});

// ─── Socket.io ──────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // Join a game room
  socket.on('joinGame', ({ roomId, nickname, playerId }, callback) => {
    const room = roomManager.getRoom(roomId);
    if (!room) {
      return callback({ error: 'Room not found' });
    }

    const result = room.addPlayer(socket, nickname, playerId);
    if (result.error) {
      return callback({ error: result.error });
    }

    socket.join(roomId);
    socket.roomId = roomId;
    socket.playerIndex = result.playerIndex;
    socket.playerId = result.playerId;

    callback({
      ok: true,
      playerIndex: result.playerIndex,
      playerId: result.playerId,
      roomInfo: room.getPublicInfo()
    });

    // Notify opponent
    socket.to(roomId).emit('playerJoined', {
      nickname: nickname,
      playerIndex: result.playerIndex,
      roomInfo: room.getPublicInfo()
    });

    // If both players connected, notify both
    if (room.isFull()) {
      io.to(roomId).emit('roomReady', { roomInfo: room.getPublicInfo() });
    }
  });

  // Player submits their deck
  socket.on('submitDeck', ({ deck, avatar }, callback) => {
    const room = roomManager.getRoom(socket.roomId);
    if (!room) return callback?.({ error: 'Room not found' });

    const result = room.submitDeck(socket.playerIndex, deck, avatar);
    if (result.error) return callback?.({ error: result.error });

    callback?.({ ok: true });

    // Notify opponent that this player is ready
    socket.to(socket.roomId).emit('opponentReady', { playerIndex: socket.playerIndex });

    // If both decks submitted, start the game
    if (room.bothDecksSubmitted()) {
      const initialStates = room.startGame();
      // Send filtered state to each player
      for (const [idx, sid] of room.getSocketIds().entries()) {
        const playerSocket = io.sockets.sockets.get(sid);
        if (playerSocket) {
          playerSocket.emit('gameStart', {
            state: room.getVisibleState(idx),
            playerIndex: idx
          });
        }
      }
    }
  });

  // Player sends a game action
  socket.on('gameAction', ({ action }, callback) => {
    const room = roomManager.getRoom(socket.roomId);
    if (!room) return callback?.({ error: 'Room not found' });

    const result = room.processAction(socket.playerIndex, action);
    if (result.error) return callback?.({ error: result.error });

    callback?.({ ok: true });

    // Send updated filtered state to each player
    for (const [idx, sid] of room.getSocketIds().entries()) {
      const playerSocket = io.sockets.sockets.get(sid);
      if (playerSocket) {
        playerSocket.emit('stateUpdate', {
          state: room.getVisibleState(idx),
          lastAction: { by: socket.playerIndex, type: action.type }
        });
      }
    }
  });

  // Full state sync (for reconnection)
  socket.on('requestState', (callback) => {
    const room = roomManager.getRoom(socket.roomId);
    if (!room) return callback?.({ error: 'Room not found' });

    callback?.({
      ok: true,
      state: room.getVisibleState(socket.playerIndex),
      playerIndex: socket.playerIndex
    });
  });

  // Chat message
  socket.on('chatMessage', ({ message }) => {
    if (!socket.roomId) return;
    const room = roomManager.getRoom(socket.roomId);
    if (!room) return;
    const nickname = room.getNickname(socket.playerIndex);
    io.to(socket.roomId).emit('chatMessage', {
      from: nickname,
      playerIndex: socket.playerIndex,
      message: message.substring(0, 500), // limit length
      timestamp: Date.now()
    });
  });

  // Disconnect handling
  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: ${socket.id}`);
    if (socket.roomId) {
      const room = roomManager.getRoom(socket.roomId);
      if (room) {
        room.playerDisconnected(socket.playerIndex, socket.id);
        socket.to(socket.roomId).emit('opponentDisconnected', {
          playerIndex: socket.playerIndex
        });

        // Start cleanup timer
        room.startCleanupTimer(() => {
          console.log(`[Room] Cleaning up abandoned room: ${socket.roomId}`);
          roomManager.removeRoom(socket.roomId);
        });
      }
    }
  });
});

// ─── Periodic cleanup of stale rooms ────────────────────────
setInterval(() => {
  roomManager.cleanupStaleRooms();
}, 5 * 60 * 1000); // every 5 minutes

// ─── Start ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Tap & Go server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} to play`);
});
