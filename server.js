const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 1e8, // 100MB for file transfers
  pingTimeout: 60000,
  pingInterval: 25000
});

// Middleware
app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// Store active rooms and users
const rooms = new Map();
const users = new Map();

// Generate unique room ID
function generateRoomId() {
  return uuidv4().substring(0, 8);
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Create new room
  socket.on('create-room', (data, callback) => {
    const roomId = generateRoomId();
    const roomName = data.roomName || `Meeting ${roomId}`;
    
    rooms.set(roomId, {
      id: roomId,
      name: roomName,
      users: new Map(),
      createdAt: Date.now(),
      maxUsers: data.maxUsers || 100000
    });
    
    socket.join(roomId);
    users.set(socket.id, {
      socketId: socket.id,
      roomId: roomId,
      userName: data.userName || 'Anonymous',
      isAudioEnabled: true,
      isVideoEnabled: true
    });
    
    const room = rooms.get(roomId);
    room.users.set(socket.id, users.get(socket.id));
    
    callback({ roomId, success: true });
    socket.emit('room-created', { roomId, roomName });
  });

  // Join existing room
  socket.on('join-room', (data, callback) => {
    const { roomId, userName } = data;
    const room = rooms.get(roomId);
    
    if (!room) {
      callback({ success: false, error: 'Room not found' });
      return;
    }
    
    if (room.users.size >= room.maxUsers) {
      callback({ success: false, error: 'Room is full' });
      return;
    }
    
    socket.join(roomId);
    users.set(socket.id, {
      socketId: socket.id,
      roomId: roomId,
      userName: userName || 'Anonymous',
      isAudioEnabled: true,
      isVideoEnabled: true
    });
    
    room.users.set(socket.id, users.get(socket.id));
    
    // Notify existing users
    socket.to(roomId).emit('user-joined', {
      userId: socket.id,
      userName: users.get(socket.id).userName
    });
    
    // Send existing users to new user
    const existingUsers = Array.from(room.users.values()).map(user => ({
      userId: user.socketId,
      userName: user.userName
    }));
    
    callback({ success: true, users: existingUsers });
    socket.emit('room-joined', { roomId, users: existingUsers });
  });

  // WebRTC signaling
  socket.on('offer', (data) => {
    socket.to(data.target).emit('offer', {
      sdp: data.sdp,
      caller: socket.id,
      callerName: users.get(socket.id)?.userName
    });
  });

  socket.on('answer', (data) => {
    socket.to(data.target).emit('answer', {
      sdp: data.sdp,
      answerer: socket.id
    });
  });

  socket.on('ice-candidate', (data) => {
    socket.to(data.target).emit('ice-candidate', {
      candidate: data.candidate,
      sender: socket.id
    });
  });

  // Chat messages
  socket.on('send-message', (data) => {
    const user = users.get(socket.id);
    if (user && user.roomId) {
      io.to(user.roomId).emit('receive-message', {
        userId: socket.id,
        userName: user.userName,
        message: data.message,
        timestamp: Date.now(),
        type: 'text'
      });
    }
  });

  // File sharing
  socket.on('file-share', (data) => {
    const user = users.get(socket.id);
    if (user && user.roomId) {
      socket.to(user.roomId).emit('file-received', {
        userId: socket.id,
        userName: user.userName,
        fileName: data.fileName,
        fileType: data.fileType,
        fileData: data.fileData,
        timestamp: Date.now()
      });
    }
  });

  // Media controls
  socket.on('toggle-audio', (data) => {
    const user = users.get(socket.id);
    if (user) {
      user.isAudioEnabled = data.enabled;
      users.set(socket.id, user);
      socket.to(user.roomId).emit('user-media-state', {
        userId: socket.id,
        isAudioEnabled: data.enabled,
        isVideoEnabled: user.isVideoEnabled
      });
    }
  });

  socket.on('toggle-video', (data) => {
    const user = users.get(socket.id);
    if (user) {
      user.isVideoEnabled = data.enabled;
      users.set(socket.id, user);
      socket.to(user.roomId).emit('user-media-state', {
        userId: socket.id,
        isAudioEnabled: user.isAudioEnabled,
        isVideoEnabled: data.enabled
      });
    }
  });

  // Screen sharing
  socket.on('start-screen-share', (data) => {
    const user = users.get(socket.id);
    if (user) {
      socket.to(user.roomId).emit('screen-share-started', {
        userId: socket.id,
        userName: user.userName,
        streamId: data.streamId
      });
    }
  });

  socket.on('stop-screen-share', () => {
    const user = users.get(socket.id);
    if (user) {
      socket.to(user.roomId).emit('screen-share-stopped', {
        userId: socket.id
      });
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      const room = rooms.get(user.roomId);
      if (room) {
        room.users.delete(socket.id);
        socket.to(user.roomId).emit('user-left', {
          userId: socket.id,
          userName: user.userName
        });
        
        // Delete room if empty
        if (room.users.size === 0) {
          rooms.delete(user.roomId);
        }
      }
      users.delete(socket.id);
    }
    console.log(`User disconnected: ${socket.id}`);
  });
});

// API endpoints
app.get('/api/rooms', (req, res) => {
  const roomList = Array.from(rooms.values()).map(room => ({
    id: room.id,
    name: room.name,
    userCount: room.users.size,
    maxUsers: room.maxUsers,
    createdAt: room.createdAt
  }));
  res.json(roomList);
});

app.get('/api/room/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  res.json({
    id: room.id,
    name: room.name,
    userCount: room.users.size,
    maxUsers: room.maxUsers
  });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  res.json({
    fileName: req.file.originalname,
    fileSize: req.file.size,
    mimeType: req.file.mimetype
  });
});

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/room/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
