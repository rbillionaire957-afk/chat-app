const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const multer = require('multer');
const session = require('express-session');
const fs = require('fs-extra');
const axios = require('axios');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 1e8,
  pingTimeout: 60000
});

// Middleware
app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 days
}));

// Ensure database directories exist
const dbPaths = [
  'database',
  'database/profile',
  'database/voice'
];
dbPaths.forEach(path => fs.ensureDirSync(path));

// Initialize JSON files
const initJSONFile = async (file, defaultData) => {
  const filePath = `database/${file}`;
  if (!await fs.pathExists(filePath)) {
    await fs.writeJson(filePath, defaultData, { spaces: 2 });
  }
};

initJSONFile('users.json', []);
initJSONFile('messages.json', []);
initJSONFile('otp_codes.json', []);
initJSONFile('calls.json', []);

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'profile') {
      cb(null, 'database/profile/');
    } else if (file.fieldname === 'voice') {
      cb(null, 'database/voice/');
    } else {
      cb(null, 'database/uploads/');
    }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }
});

// Authentication middleware
const requireAuth = (req, res, next) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// OTP API Integration
async function sendOTP(phoneNumber, code) {
  try {
    const response = await axios.get(process.env.OTP_API_URL, {
      params: {
        to: phoneNumber,
        code: code,
        info: 'https://pchat.onrender.com',
        text: 'Your $code is your verification code for pChat. Never share this code with anyone.'
      }
    });
    return { success: true, data: response.data };
  } catch (error) {
    console.error('OTP send error:', error);
    return { success: false, error: error.message };
  }
}

// Routes
app.post('/api/send-otp', async (req, res) => {
  const { phoneNumber } = req.body;
  
  if (!phoneNumber) {
    return res.status(400).json({ error: 'Phone number required' });
  }
  
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes expiry
  
  // Save OTP to database
  const otpCodes = await fs.readJson('database/otp_codes.json');
  otpCodes.push({
    phoneNumber,
    code,
    expiresAt,
    createdAt: Date.now(),
    used: false
  });
  await fs.writeJson('database/otp_codes.json', otpCodes, { spaces: 2 });
  
  // Send OTP via external API
  const result = await sendOTP(phoneNumber, code);
  
  if (result.success) {
    res.json({ success: true, message: 'OTP sent successfully' });
  } else {
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

app.post('/api/verify-otp', async (req, res) => {
  const { phoneNumber, code, username, password } = req.body;
  
  const otpCodes = await fs.readJson('database/otp_codes.json');
  const validOTP = otpCodes.find(
    otp => otp.phoneNumber === phoneNumber && 
           otp.code === code && 
           otp.expiresAt > Date.now() && 
           !otp.used
  );
  
  if (!validOTP) {
    return res.status(400).json({ error: 'Invalid or expired OTP' });
  }
  
  // Mark OTP as used
  validOTP.used = true;
  await fs.writeJson('database/otp_codes.json', otpCodes, { spaces: 2 });
  
  // Check if user exists
  const users = await fs.readJson('database/users.json');
  let user = users.find(u => u.phoneNumber === phoneNumber);
  
  if (!user) {
    // Create new user
    const hashedPassword = await bcrypt.hash(password, 10);
    user = {
      id: uuidv4(),
      phoneNumber,
      username,
      password: hashedPassword,
      profilePic: null,
      status: 'Hey there! I am using pChat',
      lastSeen: Date.now(),
      createdAt: Date.now(),
      isOnline: true
    };
    users.push(user);
    await fs.writeJson('database/users.json', users, { spaces: 2 });
  } else {
    // Verify password for existing user
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
  }
  
  // Create session
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.phoneNumber = user.phoneNumber;
  
  res.json({ 
    success: true, 
    user: {
      id: user.id,
      username: user.username,
      phoneNumber: user.phoneNumber,
      profilePic: user.profilePic
    }
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', requireAuth, async (req, res) => {
  const users = await fs.readJson('database/users.json');
  const user = users.find(u => u.id === req.session.userId);
  
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  res.json({
    id: user.id,
    username: user.username,
    phoneNumber: user.phoneNumber,
    profilePic: user.profilePic,
    status: user.status,
    isOnline: user.isOnline
  });
});

app.get('/api/users', requireAuth, async (req, res) => {
  const users = await fs.readJson('database/users.json');
  const filteredUsers = users
    .filter(u => u.id !== req.session.userId)
    .map(u => ({
      id: u.id,
      username: u.username,
      phoneNumber: u.phoneNumber,
      profilePic: u.profilePic,
      status: u.status,
      isOnline: u.isOnline,
      lastSeen: u.lastSeen
    }));
  res.json(filteredUsers);
});

app.get('/api/messages/:userId', requireAuth, async (req, res) => {
  const messages = await fs.readJson('database/messages.json');
  const userMessages = messages.filter(
    m => (m.from === req.session.userId && m.to === req.params.userId) ||
         (m.from === req.params.userId && m.to === req.session.userId)
  );
  res.json(userMessages);
});

app.post('/api/upload-profile', requireAuth, upload.single('profile'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  const users = await fs.readJson('database/users.json');
  const userIndex = users.findIndex(u => u.id === req.session.userId);
  
  if (userIndex !== -1) {
    users[userIndex].profilePic = `/profile/${req.file.filename}`;
    await fs.writeJson('database/users.json', users, { spaces: 2 });
    res.json({ success: true, profilePic: users[userIndex].profilePic });
  } else {
    res.status(404).json({ error: 'User not found' });
  }
});

app.post('/api/update-status', requireAuth, async (req, res) => {
  const { status } = req.body;
  const users = await fs.readJson('database/users.json');
  const userIndex = users.findIndex(u => u.id === req.session.userId);
  
  if (userIndex !== -1) {
    users[userIndex].status = status;
    await fs.writeJson('database/users.json', users, { spaces: 2 });
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'User not found' });
  }
});

// Serve HTML pages
app.get('/', (req, res) => {
  if (req.session.userId) {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  } else {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

app.get('/chat/:userId', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

app.get('/call/:userId', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'call.html'));
});

// Socket.io handlers
const activeUsers = new Map(); // userId -> socketId
const activeCalls = new Map(); // callId -> { caller, callee, status }

io.use((socket, next) => {
  const session = socket.request.session;
  if (session && session.userId) {
    socket.userId = session.userId;
    socket.username = session.username;
    next();
  } else {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', async (socket) => {
  console.log(`User connected: ${socket.userId}`);
  
  // Update user online status
  const users = await fs.readJson('database/users.json');
  const userIndex = users.findIndex(u => u.id === socket.userId);
  if (userIndex !== -1) {
    users[userIndex].isOnline = true;
    users[userIndex].lastSeen = Date.now();
    await fs.writeJson('database/users.json', users, { spaces: 2 });
  }
  
  activeUsers.set(socket.userId, socket.id);
  
  // Broadcast online status to all users
  socket.broadcast.emit('user-online', { userId: socket.userId, username: socket.username });
  
  // Handle sending messages
  socket.on('send-message', async (data) => {
    const message = {
      id: uuidv4(),
      from: socket.userId,
      to: data.to,
      text: data.text,
      type: data.type || 'text',
      fileUrl: data.fileUrl || null,
      fileName: data.fileName || null,
      timestamp: Date.now(),
      read: false,
      reactions: [],
      replyTo: data.replyTo || null,
      edited: false,
      deleted: false
    };
    
    // Save to database
    const messages = await fs.readJson('database/messages.json');
    messages.push(message);
    await fs.writeJson('database/messages.json', messages, { spaces: 2 });
    
    // Send to recipient if online
    const recipientSocketId = activeUsers.get(data.to);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('new-message', message);
    }
    
    // Send back to sender
    socket.emit('message-sent', message);
  });
  
  // Handle message reactions
  socket.on('add-reaction', async (data) => {
    const messages = await fs.readJson('database/messages.json');
    const message = messages.find(m => m.id === data.messageId);
    
    if (message) {
      const existingReaction = message.reactions.find(r => r.userId === socket.userId);
      if (existingReaction) {
        existingReaction.emoji = data.emoji;
      } else {
        message.reactions.push({
          userId: socket.userId,
          emoji: data.emoji,
          timestamp: Date.now()
        });
      }
      await fs.writeJson('database/messages.json', messages, { spaces: 2 });
      
      // Notify participants
      io.to(activeUsers.get(message.from)).emit('message-updated', message);
      if (message.to !== message.from) {
        io.to(activeUsers.get(message.to)).emit('message-updated', message);
      }
    }
  });
  
  // Handle message edit
  socket.on('edit-message', async (data) => {
    const messages = await fs.readJson('database/messages.json');
    const message = messages.find(m => m.id === data.messageId);
    
    if (message && message.from === socket.userId) {
      message.text = data.newText;
      message.edited = true;
      await fs.writeJson('database/messages.json', messages, { spaces: 2 });
      
      // Notify participants
      io.to(activeUsers.get(message.from)).emit('message-updated', message);
      if (message.to !== message.from) {
        io.to(activeUsers.get(message.to)).emit('message-updated', message);
      }
    }
  });
  
  // Handle message delete
  socket.on('delete-message', async (data) => {
    const messages = await fs.readJson('database/messages.json');
    const message = messages.find(m => m.id === data.messageId);
    
    if (message && message.from === socket.userId) {
      if (data.forEveryone) {
        message.deleted = true;
        message.text = 'This message was deleted';
      } else {
        const index = messages.findIndex(m => m.id === data.messageId);
        messages.splice(index, 1);
      }
      await fs.writeJson('database/messages.json', messages, { spaces: 2 });
      
      // Notify participants
      io.to(activeUsers.get(message.from)).emit('message-deleted', { messageId: data.messageId, forEveryone: data.forEveryone });
      if (message.to !== message.from) {
        io.to(activeUsers.get(message.to)).emit('message-deleted', { messageId: data.messageId, forEveryone: data.forEveryone });
      }
    }
  });
  
  // WebRTC signaling for calls
  socket.on('call-user', (data) => {
    const callId = uuidv4();
    activeCalls.set(callId, {
      caller: socket.userId,
      callee: data.to,
      status: 'calling',
      startTime: Date.now()
    });
    
    io.to(activeUsers.get(data.to)).emit('incoming-call', {
      callId,
      from: socket.userId,
      fromName: socket.username,
      offer: data.offer
    });
  });
  
  socket.on('answer-call', (data) => {
    const call = activeCalls.get(data.callId);
    if (call && call.status === 'calling') {
      call.status = 'active';
      io.to(activeUsers.get(call.caller)).emit('call-answered', {
        callId: data.callId,
        answer: data.answer
      });
    }
  });
  
  socket.on('ice-candidate', (data) => {
    io.to(activeUsers.get(data.to)).emit('ice-candidate', {
      candidate: data.candidate,
      from: socket.userId
    });
  });
  
  socket.on('end-call', async (data) => {
    const call = activeCalls.get(data.callId);
    if (call) {
      call.status = 'ended';
      call.endTime = Date.now();
      call.duration = call.endTime - call.startTime;
      
      // Save call record
      const calls = await fs.readJson('database/calls.json');
      calls.push(call);
      await fs.writeJson('database/calls.json', calls, { spaces: 2 });
      
      activeCalls.delete(data.callId);
      
      io.to(activeUsers.get(call.caller)).emit('call-ended', { callId: data.callId });
      io.to(activeUsers.get(call.callee)).emit('call-ended', { callId: data.callId });
    }
  });
  
  // Handle typing indicator
  socket.on('typing', (data) => {
    const recipientSocketId = activeUsers.get(data.to);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('user-typing', {
        from: socket.userId,
        fromName: socket.username
      });
    }
  });
  
  // Handle read receipts
  socket.on('mark-read', async (data) => {
    const messages = await fs.readJson('database/messages.json');
    const unreadMessages = messages.filter(
      m => m.from === data.from && m.to === socket.userId && !m.read
    );
    
    unreadMessages.forEach(m => m.read = true);
    await fs.writeJson('database/messages.json', messages, { spaces: 2 });
    
    io.to(activeUsers.get(data.from)).emit('messages-read', {
      by: socket.userId,
      messageIds: unreadMessages.map(m => m.id)
    });
  });
  
  // Disconnect
  socket.on('disconnect', async () => {
    console.log(`User disconnected: ${socket.userId}`);
    activeUsers.delete(socket.userId);
    
    // Update user offline status
    const users = await fs.readJson('database/users.json');
    const userIndex = users.findIndex(u => u.id === socket.userId);
    if (userIndex !== -1) {
      users[userIndex].isOnline = false;
      users[userIndex].lastSeen = Date.now();
      await fs.writeJson('database/users.json', users, { spaces: 2 });
    }
    
    socket.broadcast.emit('user-offline', { userId: socket.userId });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`pChat server running on port ${PORT}`);
});
