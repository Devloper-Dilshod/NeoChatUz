// public/script.js - ISHLAYDI!
let socket = null;

// UI elements
const onlineCountEl = document.getElementById('onlineCount');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const searchingEl = document.getElementById('searching');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const skipBtn = document.getElementById('skipBtn');
const partnerLabel = document.getElementById('partnerLabel');

let localStream = null;
let pc = null;
let partnerId = null;
let isInitiator = false;
let matchId = null;

// Socket ulanishi
function initSocket() {
    console.log('🔗 Socket ulanmoqda...');
    
    socket = io('http://localhost:5000', {
        transports: ['websocket', 'polling']
    });

    socket.on('connect', () => {
        console.log('✅ Serverga ulandik!');
        updateOnlineStatus('connected');
    });

    socket.on('disconnect', () => {
        console.log('❌ Server bilan aloqa uzildi');
        updateOnlineStatus('disconnected');
    });

    socket.on('connected', (data) => {
        console.log('Server xabari:', data);
    });

    socket.on('registered', (data) => {
        console.log('Ism saqlandi:', data);
    });

    socket.on('online-count', (data) => {
        console.log('👥 Online:', data);
        onlineCountEl.textContent = `${data.total} online`;
    });

    socket.on('searching', (data) => {
        console.log('🔍 Sherik qidirilmoqda...');
        showSearching();
    });

    socket.on('found', async (data) => {
        console.log('🤝 Sherik topildi:', data);
        partnerId = data.partnerId;
        isInitiator = data.initiator;
        matchId = data.matchId;
        
        if (partnerLabel) partnerLabel.textContent = data.partnerName;
        if (skipBtn) skipBtn.disabled = false;
        
        stopSearching();
        showConnecting();
        await startCall();
    });

    socket.on('offer', async (data) => {
        console.log('📨 Offer qabul qilindi');
        if (!pc) await startCall();
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit('answer', { 
                to: data.from, 
                sdp: pc.localDescription, 
                matchId: data.matchId 
            });
        } catch (err) {
            console.error('Offer error:', err);
        }
    });

    socket.on('answer', async (data) => {
        console.log('📨 Answer qabul qilindi');
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        } catch (err) {
            console.error('Answer error:', err);
        }
    });

    socket.on('ice-candidate', async (data) => {
        try {
            if (data.candidate) {
                await pc.addIceCandidate(data.candidate);
            }
        } catch (err) {
            console.warn('ICE candidate error:', err);
        }
    });

    socket.on('partner-left', () => {
        console.log('👋 Sherik chiqib ketdi');
        hangup();
        startSearching();
    });
}

// UI functions
function updateOnlineStatus(status) {
    const colors = {
        connected: 'text-green-400',
        disconnected: 'text-red-400'
    };
    onlineCountEl.className = colors[status] || '';
}

function showSearching() {
    startBtn.disabled = true;
    stopBtn.disabled = false;
    searchingEl.innerHTML = `
        <div class="flex items-center gap-3 text-yellow-400">
            <div class="w-6 h-6 border-2 border-yellow-400 border-t-transparent rounded-full animate-spin"></div>
            <div>
                <div class="font-semibold">Sherik qidirilmoqda...</div>
                <div class="text-xs">Iltimos kuting</div>
            </div>
        </div>`;
}

function stopSearching() {
    searchingEl.innerHTML = '';
}

function showConnecting() {
    searchingEl.innerHTML = `
        <div class="flex items-center gap-3 text-blue-400">
            <div class="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"></div>
            <div class="font-semibold">Sherik bilan ulanilmoqda...</div>
        </div>`;
}

function showConnected() {
    searchingEl.innerHTML = `
        <div class="flex items-center gap-3 text-green-400">
            <div class="w-3 h-3 bg-green-400 rounded-full animate-pulse"></div>
            <div class="font-semibold">✅ Ulaningiz!</div>
        </div>`;
}

// WebRTC functions
async function startCall() {
    try {
        if (!localStream) {
            await ensureLocalPreview();
            socket.emit('media-ready', { ready: true });
        }

        resetPeerConnection();
        createPeerConnection();

        localStream.getTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });

        if (isInitiator) {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit('offer', { 
                to: partnerId, 
                sdp: pc.localDescription, 
                matchId: matchId 
            });
        }

        startBtn.disabled = true;
        stopBtn.disabled = false;
        if (skipBtn) skipBtn.disabled = false;

    } catch (err) {
        console.error('Start call error:', err);
        if (err.name === 'NotAllowedError') {
            alert('Kamera va mikrofon ruxsatini bering!');
        }
    }
}

function createPeerConnection() {
    pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' }
        ]
    });

    pc.ontrack = (event) => {
        console.log('🎥 Sherik videosi qabul qilindi');
        const remoteStream = event.streams[0];
        remoteVideo.srcObject = remoteStream;
        remoteVideo.play().then(() => {
            showConnected();
        }).catch(console.error);
    };

    pc.onicecandidate = (event) => {
        if (event.candidate && partnerId) {
            socket.emit('ice-candidate', {
                to: partnerId,
                candidate: event.candidate,
                matchId: matchId
            });
        }
    };
}

function resetPeerConnection() {
    if (pc) {
        pc.close();
        pc = null;
    }
    remoteVideo.srcObject = null;
}

function hangup() {
    resetPeerConnection();
    partnerId = null;
    matchId = null;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    if (skipBtn) skipBtn.disabled = true;
    stopSearching();
}

// Event listeners
startBtn.addEventListener('click', async () => {
    if (!socket) initSocket();
    await ensureLocalPreview();
    socket.emit('find');
    showSearching();
});

stopBtn.addEventListener('click', () => {
    socket.emit('stop-search');
    hangup();
});

skipBtn.addEventListener('click', () => {
    if (partnerId) {
        socket.emit('skip', { to: partnerId, matchId: matchId });
    }
    hangup();
    socket.emit('find');
    showSearching();
});

// Local media
async function ensureLocalPreview() {
    if (!localStream) {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({
                audio: true,
                video: true
            });
            localVideo.srcObject = localStream;
            await localVideo.play();
            console.log('✅ Kamera va mikrofon yoqildi');
        } catch (err) {
            console.error('Media error:', err);
            throw err;
        }
    }
}

// Ism modal
function showNameModal() {
    const name = prompt('Ismingizni kiriting:', 'Mehmon');
    if (name && name.trim()) {
        const trimmedName = name.trim().slice(0, 20);
        localStorage.setItem('neochat_name', trimmedName);
        if (socket) {
            socket.emit('register', { name: trimmedName });
        }
    } else {
        showNameModal(); // Qayta so'rash
    }
}

// Init
window.addEventListener('load', () => {
    console.log('🚀 NeoChatUz yuklandi!');
    initSocket();
    
    // Ism so'rash
    const savedName = localStorage.getItem('neochat_name');
    if (!savedName) {
        showNameModal();
    } else if (socket) {
        socket.emit('register', { name: savedName });
    }
});