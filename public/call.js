const socket = io();
const urlParams = new URLSearchParams(window.location.search);
const calleeId = window.location.pathname.split('/')[2];
const callType = urlParams.get('type') || 'video';

let localStream;
let remoteStream;
let peerConnection;
let callStartTime;
let callTimerInterval;
let isMuted = false;
let isVideoOff = false;

const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ]
};

// DOM elements
const localVideo = document.getElementById('local-video-element');
const remoteVideo = document.getElementById('remote-video-element');
const callStatus = document.getElementById('call-status');
const callTimer = document.getElementById('call-timer');
const toggleMicBtn = document.getElementById('toggle-mic');
const toggleVideoBtn = document.getElementById('toggle-video');
const endCallBtn = document.getElementById('end-call');

// Initialize call
async function initCall() {
    try {
        // Get user media
        localStream = await navigator.mediaDevices.getUserMedia({
            video: callType === 'video',
            audio: true
        });
        
        localVideo.srcObject = localStream;
        
        // Create peer connection
        peerConnection = new RTCPeerConnection(configuration);
        
        // Add local tracks
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
        
        // Handle remote tracks
        peerConnection.ontrack = (event) => {
            if (!remoteStream) {
                remoteStream = new MediaStream();
                remoteVideo.srcObject = remoteStream;
            }
            remoteStream.addTrack(event.track);
        };
        
        // Handle ICE candidates
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('ice-candidate', {
                    to: calleeId,
                    candidate: event.candidate
                });
            }
        };
        
        // Create offer
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        
        socket.emit('call-user', {
            to: calleeId,
            offer: offer,
            type: callType
        });
        
        callStatus.textContent = 'Calling...';
        
    } catch (error) {
        console.error('Error accessing media devices:', error);
        callStatus.textContent = 'Failed to access camera/microphone';
    }
}

// Socket event handlers
socket.on('call-answered', async (data) => {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
    callStatus.textContent = 'Connected';
    startCallTimer();
});

socket.on('ice-candidate', async (data) => {
    if (peerConnection) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
});

socket.on('call-ended', () => {
    endCall();
});

// Control buttons
toggleMicBtn.addEventListener('click', () => {
    const audioTrack = localStream?.getAudioTracks()[0];
    if (audioTrack) {
        isMuted = !isMuted;
        audioTrack.enabled = !isMuted;
        toggleMicBtn.textContent = isMuted ? '🎤 Unmute' : '🎤 Mute';
        toggleMicBtn.classList.toggle('active', !isMuted);
    }
});

toggleVideoBtn.addEventListener('click', () => {
    const videoTrack = localStream?.getVideoTracks()[0];
    if (videoTrack) {
        isVideoOff = !isVideoOff;
        videoTrack.enabled = !isVideoOff;
        toggleVideoBtn.textContent = isVideoOff ? '📹 Start Video' : '📹 Stop Video';
        toggleVideoBtn.classList.toggle('active', !isVideoOff);
    }
});

endCallBtn.addEventListener('click', () => {
    socket.emit('end-call', { to: calleeId });
    endCall();
});

function endCall() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
    if (peerConnection) {
        peerConnection.close();
    }
    if (callTimerInterval) {
        clearInterval(callTimerInterval);
    }
    window.close();
    window.location.href = '/dashboard.html';
}

function startCallTimer() {
    callStartTime = Date.now();
    callTimerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        callTimer.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }, 1000);
}

// Handle incoming call answer
socket.on('call-answered', async (data) => {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
    callStatus.textContent = 'Connected';
    startCallTimer();
});

// Initialize call
initCall();
