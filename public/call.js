const socket = io();
let localStream;
let remoteStream;
let peerConnection;
let currentUser = null;
let currentCallUser = null;
let isAudioEnabled = true;
let isVideoEnabled = true;
let screenShareStream = null;

const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// DOM elements
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const toggleAudioBtn = document.getElementById('toggle-audio');
const toggleVideoBtn = document.getElementById('toggle-video');
const screenShareBtn = document.getElementById('screen-share');
const endCallBtn = document.getElementById('end-call');
const incomingCallDiv = document.getElementById('incoming-call');
const callerNameSpan = document.getElementById('caller-name');
const acceptCallBtn = document.getElementById('accept-call');
const rejectCallBtn = document.getElementById('reject-call');

// Initialize user media
async function initLocalStream() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = localStream;
        return true;
    } catch (error) {
        console.error('Error accessing media devices:', error);
        alert('Unable to access camera/microphone');
        return false;
    }
}

// Create peer connection
function createPeerConnection(targetUserId) {
    const pc = new RTCPeerConnection(configuration);
    
    // Add local stream tracks
    if (localStream) {
        localStream.getTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });
    }
    
    // Handle ICE candidates
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', {
                to: targetUserId,
                candidate: event.candidate
            });
        }
    };
    
    // Handle remote stream
    pc.ontrack = (event) => {
        if (!remoteStream) {
            remoteStream = new MediaStream();
            remoteVideo.srcObject = remoteStream;
        }
        remoteStream.addTrack(event.track);
    };
    
    return pc;
}

// Start call
async function startCall(targetUserId, targetUserName, type = 'video') {
    currentCallUser = { id: targetUserId, name: targetUserName };
    
    if (!localStream) {
        const success = await initLocalStream();
        if (!success) return;
    }
    
    peerConnection = createPeerConnection(targetUserId);
    
    // Create offer
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    
    socket.emit('call-user', {
        from: currentUser.id,
        to: targetUserId,
        offer: offer,
        type: type
    });
}

// Answer call
async function answerCall(fromUserId, offer) {
    if (!localStream) {
        const success = await initLocalStream();
        if (!success) return;
    }
    
    peerConnection = createPeerConnection(fromUserId);
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    
    socket.emit('answer-call', {
        to: fromUserId,
        answer: answer
    });
}

// End call
function endCall() {
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    
    if (remoteStream) {
        remoteStream.getTracks().forEach(track => track.stop());
        remoteStream = null;
    }
    
    remoteVideo.srcObject = null;
    currentCallUser = null;
    
    socket.emit('end-call', { to: currentCallUser?.id });
}

// Toggle audio
toggleAudioBtn.onclick = () => {
    if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            isAudioEnabled = !isAudioEnabled;
            audioTrack.enabled = isAudioEnabled;
            toggleAudioBtn.style.background = isAudioEnabled ? '#4caf50' : '#f44336';
            toggleAudioBtn.textContent = isAudioEnabled ? '🎤' : '🔇';
        }
    }
};

// Toggle video
toggleVideoBtn.onclick = () => {
    if (localStream) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            isVideoEnabled = !isVideoEnabled;
            videoTrack.enabled = isVideoEnabled;
            toggleVideoBtn.style.background = isVideoEnabled ? '#2196f3' : '#f44336';
            toggleVideoBtn.textContent = isVideoEnabled ? '📹' : '🚫';
        }
    }
};

// Screen sharing
screenShareBtn.onclick = async () => {
    if (!screenShareStream) {
        try {
            screenShareStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            const videoTrack = screenShareStream.getVideoTracks()[0];
            
            // Replace video track in peer connection
            const sender = peerConnection?.getSenders().find(s => s.track?.kind === 'video');
            if (sender) {
                await sender.replaceTrack(videoTrack);
            }
            
            screenShareBtn.style.background = '#f44336';
            screenShareBtn.textContent = '🖥️ Stop';
            
            videoTrack.onended = () => stopScreenShare();
        } catch (error) {
            console.error('Error sharing screen:', error);
        }
    } else {
        stopScreenShare();
    }
};

function stopScreenShare() {
    if (screenShareStream) {
        screenShareStream.getTracks().forEach(track => track.stop());
        screenShareStream = null;
        
        // Restore camera video track
        const videoTrack = localStream?.getVideoTracks()[0];
        if (videoTrack && peerConnection) {
            const sender = peerConnection.getSenders().find(s => s.track?.kind === 'video');
            if (sender) {
                sender.replaceTrack(videoTrack);
            }
        }
        
        screenShareBtn.style.background = '#ff9800';
        screenShareBtn.textContent = '🖥️';
    }
}

endCallBtn.onclick = () => {
    endCall();
    window.location.href = '/dashboard';
};

// Socket event handlers
socket.on('incoming-call', async ({ from, offer, type }) => {
    incomingCallDiv.classList.remove('hidden');
    callerNameSpan.textContent = `Call from ${from}`;
    
    acceptCallBtn.onclick = async () => {
        incomingCallDiv.classList.add('hidden');
        await answerCall(from, offer);
    };
    
    rejectCallBtn.onclick = () => {
        incomingCallDiv.classList.add('hidden');
        socket.emit('end-call', { to: from });
    };
});

socket.on('call-answered', async ({ answer }) => {
    if (peerConnection) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    }
});

socket.on('ice-candidate', async ({ candidate }) => {
    if (peerConnection) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
});

socket.on('call-ended', () => {
    endCall();
    alert('Call ended');
    window.location.href = '/dashboard';
});

// Initialize
async function init() {
    const response = await fetch('/api/users');
    const users = await response.json();
    if (users.length > 0) {
        currentUser = users[0];
        socket.emit('user-online', currentUser.id);
    }
    
    // Check if there's a user ID in URL
    const urlParams = new URLSearchParams(window.location.search);
    const userId = urlParams.get('user');
    if (userId) {
        const targetUser = users.find(u => u.id === userId);
        if (targetUser) {
            await startCall(targetUser.id, targetUser.name);
        }
    }
}

document.getElementById('logout-btn').onclick = async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/';
};

init();
