const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const session = require('express-session');
const multer = require('multer');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const { auth, sessionConfig, handleLogin, handleLogout } = require('./auth');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 1e8
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
app.use(session(sessionConfig));

// Ensure database directories exist
const dbDirs = ['database', 'database/profile', 'database/voice', 'database/files'];
dbDirs.forEach(dir => fs.ensureDirSync(dir));

// Database files
const USERS_FILE = './database/users.json';
const MESSAGES_FILE = './database/messages.json';
const OTP_FILE = './database/otp_codes.json';
const CALLS_FILE = './database/calls.json';

// Initialize database files
const initDB = () => {
    const files = [USERS_FILE, MESSAGES_FILE, OTP_FILE, CALLS_FILE];
    files.forEach(file => {
        if (!fs.existsSync(file)) {
            fs.writeJsonSync(file, []);
        }
    });
};
initDB();

// Rate limiter for OTP requests
const otpLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 1, // 1 request per minute per number
    keyGenerator: (req) => req.query.to,
    handler: (req, res) => {
        res.status(429).json({ 
            error: 'Rate limit exceeded. Please wait 60 seconds before requesting another OTP.' 
        });
    }
});

// OTP Generation endpoint
app.get('/api/send', otpLimiter, async (req, res) => {
    const { to, code, info, text } = req.query;
    
    if (!to || !code || !info) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    // Format phone number
    const phoneNumber = to.startsWith('0') ? '255' + to.slice(1) : to;
    
    // Generate custom message with $code placeholder replaced
    const defaultMessage = `Your verification code is: $code\n\nInfo: ${info}\n\nIf you didn't request this, please ignore.`;
    const message = (text || defaultMessage).replace(/\$code/g, code);
    
    // Store OTP in database
    const otpData = {
        id: uuidv4(),
        phoneNumber,
        code,
        info,
        message,
        createdAt: Date.now(),
        expiresAt: Date.now() + (5 * 60 * 1000), // 5 minutes expiry
        used: false
    };
    
    const otps = fs.readJsonSync(OTP_FILE);
    otps.push(otpData);
    fs.writeJsonSync(OTP_FILE, otps);
    
    // Create notification for dashboard
    const notification = {
        id: uuidv4(),
        type: 'otp',
        phoneNumber,
        code,
        message,
        timestamp: Date.now()
    };
    
    io.emit('new-otp', notification);
    
    res.json({
        success: true,
        message: 'OTP generated successfully',
        data: {
            to: phoneNumber,
            code,
            info,
            fullMessage: message,
            expiresIn: '5 minutes'
        }
    });
});

// API to check OTP status
app.get('/api/check/:otpId', (req, res) => {
    const otps = fs.readJsonSync(OTP_FILE);
    const otp = otps.find(o => o.id === req.params.otpId);
    
    if (!otp) {
        return res.status(404).json({ error: 'OTP not found' });
    }
    
    res.json({
        used: otp.used,
        expiresAt: otp.expiresAt,
        isExpired: Date.now() > otp.expiresAt
    });
});

// Authentication routes
app.post('/api/login', handleLogin);
app.post('/api/logout', handleLogout);
app.get('/api/check-auth', (req, res) => {
    res.json({ authenticated: !!req.session.authenticated });
});

// Protected routes
app.get('/dashboard', auth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/chat/:userId?', auth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

app.get('/call/:userId?', auth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'call.html'));
});

// User management API
app.get('/api/users', auth, (req, res) => {
    const users = fs.readJsonSync(USERS_FILE);
    res.json(users);
});

app.post('/api/users', auth, (req, res) => {
    const { phoneNumber, name, profileImage } = req.body;
    const users = fs.readJsonSync(USERS_FILE);
    
    let user = users.find(u => u.phoneNumber === phoneNumber);
    if (!user) {
        user = {
            id: uuidv4(),
            phoneNumber,
            name,
            profileImage: profileImage || '/default-avatar.png',
            createdAt: Date.now(),
            status: 'online'
        };
        users.push(user);
        fs.writeJsonSync(USERS_FILE, users);
    }
    
    res.json(user);
});

// Message API
app.get('/api/messages/:userId', auth, (req, res) => {
    const messages = fs.readJsonSync(MESSAGES_FILE);
    const userMessages = messages.filter(m => 
        m.from === req.params.userId || m.to === req.params.userId
    );
    res.json(userMessages);
});

app.post('/api/messages', auth, (req, res) => {
    const { from, to, message, type, replyTo, fileUrl } = req.body;
    const messages = fs.readJsonSync(MESSAGES_FILE);
    
    const newMessage = {
        id: uuidv4(),
        from,
        to,
        message,
        type: type || 'text',
        replyTo: replyTo || null,
        fileUrl: fileUrl || null,
        timestamp: Date.now(),
        reactions: [],
        edited: false,
        deleted: false,
        read: false
    };
    
    messages.push(newMessage);
    fs.writeJsonSync(MESSAGES_FILE, messages);
    
    // Emit to socket
    io.to(to).emit('new-message', newMessage);
    io.to(from).emit('new-message', newMessage);
    
    res.json(newMessage);
});

// File upload
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const type = req.body.type || 'files';
        const dir = `./database/${type}`;
        fs.ensureDirSync(dir);
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${uuidv4()}-${file.originalname}`;
        cb(null, uniqueName);
    }
});

const upload = multer({ 
    storage,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

app.post('/api/upload', auth, upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const fileUrl = `/${req.body.type || 'files'}/${req.file.filename}`;
    res.json({
        success: true,
        fileUrl,
        fileName: req.file.originalname,
        fileSize: req.file.size,
        mimeType: req.file.mimetype
    });
});

// Call recording
app.post('/api/call/record', auth, (req, res) => {
    const { from, to, duration, type } = req.body;
    const calls = fs.readJsonSync(CALLS_FILE);
    
    const callRecord = {
        id: uuidv4(),
        from,
        to,
        duration,
        type, // 'audio' or 'video'
        timestamp: Date.now(),
        recording: req.body.recording || null
    };
    
    calls.push(callRecord);
    fs.writeJsonSync(CALLS_FILE, calls);
    
    res.json(callRecord);
});

// Socket.io for real-time features
const onlineUsers = new Map();

io.use((socket, next) => {
    const session = socket.request.session;
    if (session && session.authenticated) {
        next();
    } else {
        next(new Error('Unauthorized'));
    }
});

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    socket.on('user-online', (userId) => {
        onlineUsers.set(userId, socket.id);
        io.emit('user-status', { userId, status: 'online' });
    });
    
    socket.on('typing', ({ from, to }) => {
        io.to(to).emit('user-typing', { from, isTyping: true });
    });
    
    socket.on('stop-typing', ({ from, to }) => {
        io.to(to).emit('user-typing', { from, isTyping: false });
    });
    
    socket.on('message-reaction', ({ messageId, userId, reaction }) => {
        const messages = fs.readJsonSync(MESSAGES_FILE);
        const message = messages.find(m => m.id === messageId);
        
        if (message) {
            const existingReaction = message.reactions.find(r => r.userId === userId);
            if (existingReaction) {
                existingReaction.reaction = reaction;
            } else {
                message.reactions.push({ userId, reaction, timestamp: Date.now() });
            }
            fs.writeJsonSync(MESSAGES_FILE, messages);
            io.emit('message-updated', message);
        }
    });
    
    socket.on('edit-message', ({ messageId, newMessage }) => {
        const messages = fs.readJsonSync(MESSAGES_FILE);
        const message = messages.find(m => m.id === messageId);
        
        if (message) {
            message.message = newMessage;
            message.edited = true;
            message.editedAt = Date.now();
            fs.writeJsonSync(MESSAGES_FILE, messages);
            io.emit('message-updated', message);
        }
    });
    
    socket.on('delete-message', ({ messageId, forEveryone }) => {
        const messages = fs.readJsonSync(MESSAGES_FILE);
        const messageIndex = messages.findIndex(m => m.id === messageId);
        
        if (messageIndex !== -1) {
            if (forEveryone) {
                messages[messageIndex].deleted = true;
                messages[messageIndex].message = 'This message was deleted';
            } else {
                messages.splice(messageIndex, 1);
            }
            fs.writeJsonSync(MESSAGES_FILE, messages);
            io.emit('message-deleted', { messageId, forEveryone });
        }
    });
    
    // WebRTC signaling for calls
    socket.on('call-user', ({ from, to, offer, type }) => {
        const targetSocket = onlineUsers.get(to);
        if (targetSocket) {
            io.to(targetSocket).emit('incoming-call', { from, offer, type });
        }
    });
    
    socket.on('answer-call', ({ to, answer }) => {
        const targetSocket = onlineUsers.get(to);
        if (targetSocket) {
            io.to(targetSocket).emit('call-answered', { answer });
        }
    });
    
    socket.on('ice-candidate', ({ to, candidate }) => {
        const targetSocket = onlineUsers.get(to);
        if (targetSocket) {
            io.to(targetSocket).emit('ice-candidate', { candidate });
        }
    });
    
    socket.on('end-call', ({ to }) => {
        const targetSocket = onlineUsers.get(to);
        if (targetSocket) {
            io.to(targetSocket).emit('call-ended');
        }
    });
    
    socket.on('disconnect', () => {
        for (const [userId, socketId] of onlineUsers.entries()) {
            if (socketId === socket.id) {
                onlineUsers.delete(userId);
                io.emit('user-status', { userId, status: 'offline' });
                break;
            }
        }
    });
});

// Serve main page
app.get('/', (req, res) => {
    if (req.session && req.session.authenticated) {
        res.redirect('/dashboard');
    } else {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

app.get('/login', (req, res) => {
    if (req.session && req.session.authenticated) {
        res.redirect('/dashboard');
    } else {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
