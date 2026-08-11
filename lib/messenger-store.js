/**
 * In-memory message & user store for VChat.
 *
 * Production tip: swap every in-memory Map for a Supabase table
 * (the Supabase client is already configured in lib/supabase.js).
 */

const { v4: uuidv4 } = require('uuid');

// ── Users ──────────────────────────────────────────────────────────────
// key: userId → { id, username, avatar, status, lastSeen, socketId }
const users = new Map();

// ── Rooms ──────────────────────────────────────────────────────────────
// key: roomId → { id, name, type: 'group'|'dm', members: Set<userId>, createdAt }
const rooms = new Map();

// ── Messages ──────────────────────────────────────────────────────────
// key: roomId → [ { id, roomId, senderId, text, file, type, timestamp, readBy: Set<userId> } ]
const messagesByRoom = new Map();

// Seed a default "General" room
const GENERAL_ROOM_ID = 'general';
rooms.set(GENERAL_ROOM_ID, {
  id: GENERAL_ROOM_ID,
  name: 'General',
  type: 'group',
  members: new Set(),
  createdAt: Date.now(),
});
messagesByRoom.set(GENERAL_ROOM_ID, []);

// ── User helpers ──────────────────────────────────────────────────────

function addUser({ username, avatar }) {
  // Prevent duplicate usernames
  for (const u of users.values()) {
    if (u.username.toLowerCase() === username.toLowerCase()) {
      return null; // already taken
    }
  }
  const id = uuidv4();
  const user = { id, username, avatar: avatar || null, status: 'online', lastSeen: Date.now(), socketId: null };
  users.set(id, user);
  // Auto-join General
  joinRoom(id, GENERAL_ROOM_ID);
  return { ...user };
}

function removeUser(userId) {
  const user = users.get(userId);
  if (!user) return;
  user.status = 'offline';
  user.lastSeen = Date.now();
  user.socketId = null;
}

function getUser(userId) {
  return users.get(userId) || null;
}

function getUserBySocket(socketId) {
  for (const u of users.values()) {
    if (u.socketId === socketId) return u;
  }
  return null;
}

function setSocket(userId, socketId) {
  const u = users.get(userId);
  if (u) {
    u.socketId = socketId;
    u.status = 'online';
  }
}

function getOnlineUsers() {
  return [...users.values()].filter(u => u.status === 'online');
}

function getAllUsers() {
  return [...users.values()];
}

// ── Room helpers ──────────────────────────────────────────────────────

function createRoom({ name, type, members }) {
  const id = uuidv4();
  const room = { id, name, type: type || 'group', members: new Set(members || []), createdAt: Date.now() };
  rooms.set(id, room);
  messagesByRoom.set(id, []);
  return { ...room, members: [...room.members] };
}

function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

function joinRoom(userId, roomId) {
  const room = rooms.get(roomId);
  if (room) room.members.add(userId);
}

function leaveRoom(userId, roomId) {
  const room = rooms.get(roomId);
  if (room) room.members.delete(userId);
}

function getUserRooms(userId) {
  const result = [];
  for (const room of rooms.values()) {
    if (room.members.has(userId)) {
      result.push({ ...room, members: [...room.members] });
    }
  }
  return result;
}

function findOrCreateDM(userId1, userId2) {
  // Look for an existing DM room between these two users
  for (const room of rooms.values()) {
    if (room.type === 'dm' && room.members.has(userId1) && room.members.has(userId2)) {
      return { ...room, members: [...room.members] };
    }
  }
  // Create new DM room
  const u1 = users.get(userId1);
  const u2 = users.get(userId2);
  const name = u1 && u2 ? `${u1.username} & ${u2.username}` : 'DM';
  return createRoom({ name, type: 'dm', members: [userId1, userId2] });
}

// ── Message helpers ──────────────────────────────────────────────────

function addMessage({ roomId, senderId, text, file, type }) {
  const list = messagesByRoom.get(roomId) || [];
  const msg = {
    id: uuidv4(),
    roomId,
    senderId,
    text: text || '',
    file: file || null,  // { url, name, size, mimeType }
    type: type || 'text',
    timestamp: Date.now(),
    readBy: new Set([senderId]),
  };
  list.push(msg);
  messagesByRoom.set(roomId, list);
  // Return a plain object (sets → arrays)
  return { ...msg, readBy: [...msg.readBy] };
}

function getMessages(roomId, limit = 100) {
  const list = messagesByRoom.get(roomId) || [];
  return list.slice(-limit).map(m => ({ ...m, readBy: [...m.readBy] }));
}

function markRead(roomId, userId) {
  const list = messagesByRoom.get(roomId) || [];
  for (const m of list) {
    m.readBy.add(userId);
  }
}

module.exports = {
  addUser,
  removeUser,
  getUser,
  getUserBySocket,
  setSocket,
  getOnlineUsers,
  getAllUsers,
  createRoom,
  getRoom,
  joinRoom,
  leaveRoom,
  getUserRooms,
  findOrCreateDM,
  addMessage,
  getMessages,
  markRead,
  GENERAL_ROOM_ID,
};
