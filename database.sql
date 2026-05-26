-- Create database
CREATE DATABASE whatsapp_clone;

-- Users table
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    phone_number VARCHAR(20) UNIQUE NOT NULL,
    display_name VARCHAR(100),
    profile_pic TEXT,
    status TEXT DEFAULT 'Hey there! I am using WhatsApp Clone',
    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_online BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- OTP logs table
CREATE TABLE otp_logs (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(20) NOT NULL,
    code VARCHAR(10) NOT NULL,
    info_url TEXT,
    custom_message TEXT,
    is_used BOOLEAN DEFAULT FALSE,
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP,
    INDEX idx_phone_number (phone_number),
    INDEX idx_sent_at (sent_at)
);

-- Chats table
CREATE TABLE chats (
    id SERIAL PRIMARY KEY,
    chat_id VARCHAR(100) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Chat participants
CREATE TABLE chat_participants (
    id SERIAL PRIMARY KEY,
    chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(chat_id, user_id)
);

-- Messages table
CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
    sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    message_type VARCHAR(20) DEFAULT 'text', -- text, image, video, audio, file
    content TEXT,
    file_url TEXT,
    file_size INTEGER,
    mime_type VARCHAR(100),
    is_read BOOLEAN DEFAULT FALSE,
    is_delivered BOOLEAN DEFAULT FALSE,
    is_deleted BOOLEAN DEFAULT FALSE,
    reply_to INTEGER REFERENCES messages(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_chat_id (chat_id),
    INDEX idx_created_at (created_at)
);

-- Calls table
CREATE TABLE calls (
    id SERIAL PRIMARY KEY,
    call_id VARCHAR(100) UNIQUE NOT NULL,
    caller_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    receiver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    call_type VARCHAR(20) DEFAULT 'audio', -- audio, video
    status VARCHAR(20) DEFAULT 'initiated', -- initiated, ringing, accepted, rejected, ended, missed
    duration INTEGER DEFAULT 0,
    started_at TIMESTAMP,
    ended_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_caller_id (caller_id),
    INDEX idx_receiver_id (receiver_id),
    INDEX idx_status (status)
);

-- User sessions table
CREATE TABLE user_sessions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    socket_id VARCHAR(100),
    session_token VARCHAR(255),
    device_info TEXT,
    last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default user (wanumber/user)
INSERT INTO users (username, password, phone_number, display_name) 
VALUES ('wanumber', '$2a$10$YourHashedPasswordHere', '255712345678', 'WA Number');

-- Note: Generate hash using bcrypt: bcrypt.hashSync('user', 10)
