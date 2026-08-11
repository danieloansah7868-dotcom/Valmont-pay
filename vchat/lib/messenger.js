/**
 * VChat — Socket.io event handlers
 *
 * Attach to an existing Express server + HTTP server:
 *   const messenger = require('./lib/messenger');
 *   messenger.attach(httpServer, expressApp);
 */

const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const store = require('./messenger-store');

// ── File upload config ────────────────────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '..', 'public', 'uploads'),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|gif|webp|pdf|doc|docx|txt|zip|mp3|mp4)$/i;
    cb(null, allowed.test(path.extname(file.originalname)));
  },
});

function attach(httpServer, app) {
  // ── REST: File upload endpoint ──────────────────────────────────────
  app.post('/api/messenger/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const url = `/uploads/${req.file.filename}`;
    res.json({
      url,
      name: req.file.originalname,
      size: req.file.size,
      mimeType: req.file.mimetype,
    });
  });

  // ── REST: Get rooms for a user ──────────────────────────────────────
  app.get('/api/messenger/rooms', (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    res.json(store.getUserRooms(userId));
  });

  // ── REST: Get messages for a room ──────────────────────────────────
  app.get('/api/messenger/messages/:roomId', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    res.json(store.getMessages(req.params.roomId, limit));
  });

  // ── REST: Get all users ────────────────────────────────────────────
  app.get('/api/messenger/users', (_req, res) => {
    res.json(store.getAllUsers());
  });

  // ── Socket.io ──────────────────────────────────────────────────────
  const io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    maxHttpBufferSize: 5e6, // 5 MB for base64 file transfers
  });

  io.on('connection', (socket) => {
    console.log(`[Messenger] Socket connected: ${socket.id}`);

    // ── User joins ──────────────────────────────────────────────────
    socket.on('user:join', ({ username, avatar }) => {
      // Check if user already exists (reconnect)
      let user = null;
      for (const u of store.getAllUsers()) {
        if (u.username.toLowerCase() === username.toLowerCase()) {
          user = u;
          store.setSocket(u.id, socket.id);
          u.status = 'online';
          break;
        }
      }
      if (!user) {
        user = store.addUser({ username, avatar });
      }
      if (!user) {
        socket.emit('error', { message: 'Username already taken' });
        return;
      }

      // Re-join all rooms
      const userRooms = store.getUserRooms(user.id);
      for (const room of userRooms) {
        socket.join(room.id);
      }

      store.setSocket(user.id, socket.id);

      socket.emit('user:joined', {
        user,
        rooms: userRooms,
        onlineUsers: store.getOnlineUsers(),
      });

      // Broadcast to all that user is online
      io.emit('users:online', store.getOnlineUsers());

      // Notify General room
      io.to(store.GENERAL_ROOM_ID).emit('room:notification', {
        roomId: store.GENERAL_ROOM_ID,
        message: `${user.username} joined the chat`,
        type: 'system',
        timestamp: Date.now(),
      });

      console.log(`[Messenger] ${user.username} joined (${user.id})`);
    });

    // ── Send message ────────────────────────────────────────────────
    socket.on('message:send', ({ roomId, text, file, type }) => {
      const user = store.getUserBySocket(socket.id);
      if (!user) return;

      const msg = store.addMessage({
        roomId,
        senderId: user.id,
        text,
        file,
        type: type || (file ? 'file' : 'text'),
      });

      // Enrich with sender info for the UI
      msg.sender = { id: user.id, username: user.username, avatar: user.avatar };

      io.to(roomId).emit('message:new', msg);
    });

    // ── Typing indicator ────────────────────────────────────────────
    socket.on('typing:start', ({ roomId }) => {
      const user = store.getUserBySocket(socket.id);
      if (!user) return;
      socket.to(roomId).emit('typing:start', { roomId, userId: user.id, username: user.username });
    });

    socket.on('typing:stop', ({ roomId }) => {
      const user = store.getUserBySocket(socket.id);
      if (!user) return;
      socket.to(roomId).emit('typing:stop', { roomId, userId: user.id });
    });

    // ── Mark messages as read ───────────────────────────────────────
    socket.on('messages:read', ({ roomId }) => {
      const user = store.getUserBySocket(socket.id);
      if (!user) return;
      store.markRead(roomId, user.id);
      socket.to(roomId).emit('messages:read', { roomId, userId: user.id });
    });

    // ── Create a group room ─────────────────────────────────────────
    socket.on('room:create', ({ name, members }) => {
      const user = store.getUserBySocket(socket.id);
      if (!user) return;

      const allMembers = [...new Set([user.id, ...(members || [])])];
      const room = store.createRoom({ name, type: 'group', members: allMembers });

      // Make every member join the socket room
      for (const memberId of allMembers) {
        const member = store.getUser(memberId);
        if (member && member.socketId) {
          io.sockets.sockets.get(member.socketId)?.join(room.id);
        }
      }

      // Notify all members
      for (const memberId of allMembers) {
        const member = store.getUser(memberId);
        if (member && member.socketId) {
          io.to(member.socketId).emit('room:created', room);
        }
      }
    });

    // ── Start a DM ──────────────────────────────────────────────────
    socket.on('dm:start', ({ targetUserId }) => {
      const user = store.getUserBySocket(socket.id);
      if (!user) return;

      const room = store.findOrCreateDM(user.id, targetUserId);

      // Join both users to the socket room
      socket.join(room.id);
      const target = store.getUser(targetUserId);
      if (target && target.socketId) {
        io.sockets.sockets.get(target.socketId)?.join(room.id);
      }

      socket.emit('room:created', room);
      if (target && target.socketId) {
        io.to(target.socketId).emit('room:created', room);
      }
    });

    // ── Join room ────────────────────────────────────────────────────
    socket.on('room:join', ({ roomId }) => {
      const user = store.getUserBySocket(socket.id);
      if (!user) return;
      store.joinRoom(user.id, roomId);
      socket.join(roomId);
      socket.emit('room:joined', { roomId, messages: store.getMessages(roomId) });
    });

    // ── Disconnect ──────────────────────────────────────────────────
    socket.on('disconnect', () => {
      const user = store.getUserBySocket(socket.id);
      if (user) {
        store.removeUser(user.id);
        io.emit('users:online', store.getOnlineUsers());
        io.to(store.GENERAL_ROOM_ID).emit('room:notification', {
          roomId: store.GENERAL_ROOM_ID,
          message: `${user.username} left the chat`,
          type: 'system',
          timestamp: Date.now(),
        });
        console.log(`[Messenger] ${user.username} disconnected`);
      }
    });
  });

  return io;
}

module.exports = { attach };
