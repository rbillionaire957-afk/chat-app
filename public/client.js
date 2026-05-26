const socket = io();

let localStream;
let peers = new Map();
let currentRoom = null;
let currentUser = null;
let screenShareStream = null;

// DOM Elements
const joinScreen = document.getElementById('join-screen');
const meetingScreen = document.getElementById('meeting-screen');
const createRoomBtn = document.getElementById('create-room');
const joinRoomBtn = document.getElementById('join-room');
const leaveRoomBtn = document.getElementById('leave-room');
const toggleAudioBtn = document.getElementById('toggle-audio');
const toggleVideoBtn = document.getElementById('toggle-video');
const screenShareBtn = document.getElementById('screen-share');
const fileShareBtn = document.getElementById('file-share');
const fileInput = document.getElementById('file-input');
const sendMessageBtn = document.getElementById('send-message');
const chatInput = document.getElementById('chat-input');
const chatMessages = document.getElementById('chat-messages');
const videoGrid = document.getElementById('video-grid');
const roomIdDisplay = document.getElementById('room-id-display');
const userCountSpan = document.getElementById('user-count');

// Join Room Handlers
createRoomBtn.addEventListener('click', () => {
    const userName = document.getElementById('create-name').value.trim();
    if (!userName) {
        showError('Please enter your name');
        return;
    }
    
    socket.emit('create-room', { userName }, (response) => {
        if (response.success) {
            joinMeeting(response.roomId, userName);
        } else {
            showError('Failed to create room');
        }
    });
});

joinRoomBtn.addEventListener('click', () => {
    const roomId = document.getElementById('room-id').value.trim();
    const userName = document.getElementById('join-name').value.trim();
    
    if (!roomId || !userName) {
        showError('Please enter room ID and your name');
        return;
    }
    
    socket.emit('join-room', { roomId, userName }, (response) => {
        if (response.success) {
            joinMeeting(roomId, userName, response.users);
        } else {
            showError(response.error || 'Failed to join room');
        }
    });
});

async function joinMeeting(roomId, userName, existingUsers = []) {
    currentRoom = roomId;
    currentUser = userName;
    
    try {
        // Get user media
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        
        // Add local video
        addVideoStream(socket.id, userName, localStream, true);
        
        // Setup WebRTC for existing users
        for (const user of existingUsers) {
            if (user.userId !== socket.id) {
                createPeerConnection(user.userId, user.userName);
            }
        }
        
        // Show meeting screen
        joinScreen.classList.remove('active');
        meetingScreen.classList.add('active');
        roomIdDisplay.textContent = `Room: ${roomId}`;
        
        // Socket event handlers
        setupSocketHandlers();
        
    } catch (error) {
        console.error('Error accessing media devices:', error);
        showError('Unable to access camera/microphone');
    }
}

function setupSocketHandlers() {
    socket.on('user-joined', ({ userId, userName }) => {
        addChatMessage('system', `${userName} joined the meeting`);
        createPeerConnection(userId, userName);
        updateUserCount();
    });
    
    socket.on('user-left', ({ userId, userName }) => {
        removeVideoStream(userId);
        addChatMessage('system', `${userName} left the meeting`);
        updateUserCount();
    });
    
    socket.on('offer', async ({ sdp, caller, callerName }) => {
        const peerConnection = createPeerConnection(caller, callerName);
        await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('answer', { target: caller, sdp: answer });
    });
    
    socket.on('answer', async ({ sdp, answerer }) => {
        const peerConnection = peers.get(answerer);
        if (peerConnection) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
        }
    });
    
    socket.on('ice-candidate', async ({ candidate, sender }) => {
        const peerConnection = peers.get(sender);
        if (peerConnection) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        }
    });
    
    socket.on('receive-message', ({ userId, userName, message }) => {
        addChatMessage(userName, message);
    });
    
    socket.on('file-received', ({ userId, userName, fileName, fileData, fileType }) => {
        downloadFile(fileData, fileName, fileType);
        addChatMessage('system', `${userName} shared a file: ${fileName}`);
    });
    
    socket.on('user-media-state', ({ userId, isAudioEnabled, isVideoEnabled }) => {
        updateUserMediaState(userId, isAudioEnabled, isVideoEnabled);
    });
}

function createPeerConnection(userId, userName) {
    const peerConnection = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    });
    
    // Add local stream tracks
    if (localStream) {
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
    }
    
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', { target: userId, candidate: event.candidate });
        }
    };
    
    peerConnection.ontrack = (event) => {
        if (!document.getElementById(`video-${userId}`)) {
            addVideoStream(userId, userName, event.streams[0]);
        }
    };
    
    peers.set(userId, peerConnection);
    
    // Create offer if we're the caller
    if (socket.id < userId) {
        createOffer(peerConnection, userId);
    }
    
    return peerConnection;
}

async function createOffer(peerConnection, userId) {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('offer', { target: userId, sdp: offer });
}

function addVideoStream(userId, userName, stream, isLocal = false) {
    const videoContainer = document.createElement('div');
    videoContainer.id = `container-${userId}`;
    videoContainer.className = 'video-container';
    
    const video = document.createElement('video');
    video.id = `video-${userId}`;
    video.autoplay = true;
    video.playsInline = true;
    
    if (isLocal) {
        video.muted = true;
    }
    
    video.srcObject = stream;
    
    const label = document.createElement('div');
    label.className = 'video-label';
    label.textContent = isLocal ? `${userName} (You)` : userName;
    
    videoContainer.appendChild(video);
    videoContainer.appendChild(label);
    videoGrid.appendChild(videoContainer);
    
    video.play().catch(e => console.log('Video play error:', e));
}

function removeVideoStream(userId) {
    const container = document.getElementById(`container-${userId}`);
    if (container) {
        container.remove();
    }
    
    const peerConnection = peers.get(userId);
    if (peerConnection) {
        peerConnection.close();
        peers.delete(userId);
    }
}

function addChatMessage(sender, message) {
    const messageDiv = document.createElement('div');
    messageDiv.className = sender === 'system' ? 'message system' : 'message';
    
    if (sender === 'system') {
        messageDiv.textContent = message;
    } else {
        messageDiv.innerHTML = `
            <div class="sender">${sender}</div>
            <div class="text">${escapeHtml(message)}</div>
        `;
    }
    
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function sendMessage() {
    const message = chatInput.value.trim();
    if (message && currentRoom) {
        socket.emit('send-message', { message });
        addChatMessage(currentUser, message);
        chatInput.value = '';
    }
}

sendMessageBtn.addEventListener('click', sendMessage);
chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});

// Media Controls
toggleAudioBtn.addEventListener('click', () => {
    const audioTrack = localStream?.getAudioTracks()[0];
    if (audioTrack) {
        const enabled = !audioTrack.enabled;
        audioTrack.enabled = enabled;
        toggleAudioBtn.classList.toggle('audio-off', !enabled);
        toggleAudioBtn.querySelector('span:last-child').textContent = enabled ? 'Mute' : 'Unmute';
        socket.emit('toggle-audio', { enabled });
    }
});

toggleVideoBtn.addEventListener('click', () => {
    const videoTrack = localStream?.getVideoTracks()[0];
    if (videoTrack) {
        const enabled = !videoTrack.enabled;
        videoTrack.enabled = enabled;
        toggleVideoBtn.classList.toggle('video-off', !enabled);
        toggleVideoBtn.querySelector('span:last-child').textContent = enabled ? 'Stop Video' : 'Start Video';
        socket.emit('toggle-video', { enabled });
    }
});

// Screen Sharing
screenShareBtn.addEventListener('click', async () => {
    if (!screenShareStream) {
        try {
            screenShareStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            const videoTrack = screenShareStream.getVideoTracks()[0];
            
            // Replace video track for all peers
            for (const [userId, peerConnection] of peers) {
                const sender = peerConnection.getSenders().find(s => s.track?.kind === 'video');
                if (sender) {
                    await sender.replaceTrack(videoTrack);
                }
            }
            
            screenShareBtn.style.background = '#4caf50';
            screenShareBtn.querySelector('span:last-child').textContent = 'Stop Sharing';
            
            videoTrack.onended = () => stopScreenSharing();
            
        } catch (error) {
            console.error('Error sharing screen:', error);
        }
    } else {
        stopScreenSharing();
    }
});

function stopScreenSharing() {
    if (screenShareStream) {
        screenShareStream.getTracks().forEach(track => track.stop());
        screenShareStream = null;
        
        // Restore camera video track
        const videoTrack = localStream?.getVideoTracks()[0];
        if (videoTrack) {
            for (const [userId, peerConnection] of peers) {
                const sender = peerConnection.getSenders().find(s => s.track?.kind === 'video');
                if (sender) {
                    sender.replaceTrack(videoTrack);
                }
            }
        }
        
        screenShareBtn.style.background = '';
        screenShareBtn.querySelector('span:last-child').textContent = 'Share Screen';
    }
}

// File Sharing
fileShareBtn.addEventListener('click', () => {
    fileInput.click();
});

fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file && file.size <= 50 * 1024 * 1024) { // 50MB limit
        const reader = new FileReader();
        reader.onload = (event) => {
            socket.emit('file-share', {
                fileName: file.name,
                fileType: file.type,
                fileData: event.target.result
            });
            addChatMessage('system', `You shared: ${file.name}`);
        };
        reader.readAsDataURL(file);
    } else {
        showError('File too large (max 50MB)');
    }
    fileInput.value = '';
});

function downloadFile(fileData, fileName, fileType) {
    const link = document.createElement('a');
    link.href = fileData;
    link.download = fileName;
    link.click();
}

// Leave Room
leaveRoomBtn.addEventListener('click', () => {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
    if (screenShareStream) {
        screenShareStream.getTracks().forEach(track => track.stop());
    }
    for (const [_, peerConnection] of peers) {
        peerConnection.close();
    }
    peers.clear();
    
    socket.disconnect();
    window.location.reload();
});

function updateUserCount() {
    const count = document.querySelectorAll('.video-container').length;
    userCountSpan.textContent = `${count} participant${count !== 1 ? 's' : ''}`;
}

function updateUserMediaState(userId, isAudioEnabled, isVideoEnabled) {
    const video = document.getElementById(`video-${userId}`);
    if (video && video.srcObject) {
        const audioTrack = video.srcObject.getAudioTracks()[0];
        const videoTrack = video.srcObject.getVideoTracks()[0];
        if (audioTrack) audioTrack.enabled = isAudioEnabled;
        if (videoTrack) videoTrack.enabled = isVideoEnabled;
    }
}

function showError(message) {
    const errorDiv = document.getElementById('error-message');
    errorDiv.textContent = message;
    setTimeout(() => {
        errorDiv.textContent = '';
    }, 3000);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Update user count periodically
setInterval(updateUserCount, 1000);
