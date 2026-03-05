/**
 * RoomManager — Creates, tracks, and cleans up game rooms.
 */

const GameRoom = require('./GameRoom');

class RoomManager {
  constructor() {
    this.rooms = new Map(); // roomId → GameRoom
  }

  /**
   * Generate a unique 6-character room ID
   */
  generateRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 to avoid confusion
    let id;
    do {
      id = '';
      for (let i = 0; i < 6; i++) {
        id += chars[Math.floor(Math.random() * chars.length)];
      }
    } while (this.rooms.has(id));
    return id;
  }

  /**
   * Create a new game room
   */
  createRoom(hostNickname) {
    const id = this.generateRoomId();
    const room = new GameRoom(id, hostNickname);
    this.rooms.set(id, room);
    console.log(`[RoomManager] Room created: ${id} by ${hostNickname} (${this.rooms.size} active rooms)`);
    return room;
  }

  /**
   * Get a room by ID (case-insensitive)
   */
  getRoom(roomId) {
    if (!roomId) return null;
    return this.rooms.get(roomId.toUpperCase()) || null;
  }

  /**
   * Remove a room
   */
  removeRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (room) {
      room.destroy();
      this.rooms.delete(roomId);
      console.log(`[RoomManager] Room removed: ${roomId} (${this.rooms.size} active rooms)`);
    }
  }

  /**
   * Clean up rooms that have been abandoned (both players disconnected for 30+ min)
   */
  cleanupStaleRooms() {
    const now = Date.now();
    const staleTimeout = 30 * 60 * 1000; // 30 minutes

    for (const [id, room] of this.rooms.entries()) {
      if (room.isAbandoned(staleTimeout)) {
        console.log(`[RoomManager] Auto-removing stale room: ${id}`);
        this.removeRoom(id);
      }
    }
  }

  /**
   * Get stats for monitoring
   */
  getStats() {
    return {
      activeRooms: this.rooms.size,
      rooms: Array.from(this.rooms.values()).map(r => r.getPublicInfo())
    };
  }
}

module.exports = RoomManager;
