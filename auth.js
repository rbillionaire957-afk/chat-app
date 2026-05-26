const session = require('express-session');

// Authentication middleware
const auth = (req, res, next) => {
    if (req.session && req.session.authenticated) {
        next();
    } else {
        res.redirect('/login');
    }
};

// Session configuration
const sessionConfig = {
    secret: process.env.SESSION_SECRET || 'pchat_secret_key_2026',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
};

// Login handler
const handleLogin = (req, res) => {
    const { username, password } = req.body;
    
    if (username === process.env.ADMIN_USERNAME && 
        password === process.env.ADMIN_PASSWORD) {
        req.session.authenticated = true;
        req.session.username = username;
        res.json({ success: true, redirect: '/dashboard' });
    } else {
        res.json({ success: false, error: 'Invalid credentials' });
    }
};

// Logout handler
const handleLogout = (req, res) => {
    req.session.destroy();
    res.json({ success: true });
};

module.exports = { auth, sessionConfig, handleLogin, handleLogout };
