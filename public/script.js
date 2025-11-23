// public/script.js
// Client-side logic: UI, socket signaling and WebRTC
// This file now fetches runtime connection info from the server (`/info`) so it can connect
// to a programmatically started ngrok public URL when available.

let socket = null; // will be set after fetching /info

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
let searchDotsInterval = null;
let connectTimeout = null;

function setOnlineCount(n) {
  // server now sends an object { total, ready, sample }
  if (typeof n === 'object' && n !== null) {
    onlineCountEl.textContent = `${n.ready}/${n.total}`;
    return;
  }
  onlineCountEl.textContent = n;
}

// We'll attach socket event handlers after the socket connection is created.
function setupSocketHandlers() {
  if (!socket) return;

  socket.on('searching', () => {
    showSearching();
  });

  socket.on('online-count', (data) => {
    // data: { total, ready, sample }
    setOnlineCount(data);
  });

  socket.on('found', async (data) => {
    // New match arrived
    partnerId = data.partnerId;
    isInitiator = !!data.initiator;
    matchId = data.matchId;
    stopSearching();
    showConnecting();
    // update UI
    if (partnerLabel) partnerLabel.textContent = data.partnerName || 'Sherik';
    if (skipBtn) skipBtn.disabled = false;
    await startCall();
  });

  socket.on('offer', async (data) => {
    // Only accept offers that belong to the current match
    if (!data.matchId || data.matchId !== matchId) return;
    if (!pc) await startCall();
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer', { to: data.from, sdp: pc.localDescription, matchId });
    } catch (err) {
      console.error('Error handling offer', err);
      hangup('Offer handling failed');
    }
  });

  socket.on('answer', async (data) => {
    if (!data.matchId || data.matchId !== matchId) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } catch (err) {
      console.error('Error setting remote answer', err);
      hangup('Answer handling failed');
    }
  });

  socket.on('ice-candidate', async (data) => {
    if (!data.matchId || data.matchId !== matchId) return;
    try {
      if (data.candidate) await pc.addIceCandidate(data.candidate);
    } catch (err) {
      console.warn('Failed to add ICE candidate', err);
    }
  });

  socket.on('partner-left', () => {
    // partner disconnected or hung up
    // go back to searching automatically
    hangup('Partner left the call');
    // after hangup, re-enter searching
    startSearching();
  });
}

startBtn.addEventListener('click', async () => {
  if (!socket) await initSocket();
  await ensureLocalPreview();
  startSearching();
});

stopBtn.addEventListener('click', () => {
  if (socket) {
    socket.emit('stop');
    socket.emit('stop-search');
  }
  stopCall();
});

if (skipBtn) skipBtn.addEventListener('click', onSkip);

// Skip button will be wired in UI; emit skip to server and reset the PC
async function onSkip() {
  if (socket && partnerId) {
    socket.emit('skip', { matchId, to: partnerId });
  }
  // Immediately reset local connection but keep local preview
  resetPeerConnection();
  partnerId = null;
  matchId = null;
  startSearching();
}

function showSearching() {
  // show searching UI
  startBtn.disabled = true;
  stopBtn.disabled = false;
  searchingEl.innerHTML = `
    <div class="flex items-center gap-3">
      <div class="loader-ring" aria-hidden></div>
      <div>
        <div class="searching-text">Tasodifiy sherik izlanmoqda</div>
        <div class="text-xs text-slate-300">Iltimos kuting — tez orada topamiz</div>
      </div>
    </div>`;
}

function stopSearching() {
  startBtn.disabled = true;
  stopBtn.disabled = false;
  searchingEl.textContent = '';
  if (searchDotsInterval) clearInterval(searchDotsInterval);
}

function startSearching() {
  socket.emit('find');
  showSearching();
}

async function startCall() {
  try {
    // ensure preview stream
    if (!localStream) {
      // Attempt to get media; this will prompt user
      try {
        await ensureLocalPreview();
        // notify server that this socket has media
        if (socket) socket.emit('media-ready', { ready: true });
      } catch (err) {
        // If user denies, notify server and disable start
        if (socket) socket.emit('media-ready', { ready: false });
        throw err;
      }
    }

    // close any previous peer before creating a new one
    resetPeerConnection();
    createPeerConnection();

    // add local tracks
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    // if initiator, create offer
    if (isInitiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { to: partnerId, sdp: pc.localDescription, matchId });
    }

    startBtn.disabled = true;
    stopBtn.disabled = false;
    if (skipBtn) skipBtn.disabled = false;

    // safety: if connection doesn't establish within 20s, go back to searching
    if (connectTimeout) clearTimeout(connectTimeout);
    connectTimeout = setTimeout(() => {
      console.warn('Connection timeout, returning to searching');
      if (socket) {
        socket.emit('stop-search');
      }
      resetPeerConnection();
      partnerId = null;
      matchId = null;
      startSearching();
    }, 20000);
  } catch (err) {
    console.error('startCall error', err);
    hangup('Failed to get camera/microphone');
    // show user-friendly message if permission denied
    if (err && err.name === 'NotAllowedError') {
      alert('Iltimos, kamera va mikrofon uchun ruxsat bering — aks holda video ishlamaydi.');
      // ensure server knows we are not ready
      if (socket) socket.emit('media-ready', { ready: false });
      startBtn.disabled = false;
      stopBtn.disabled = true;
    }
  }
}

function createPeerConnection() {
  if (pc) return;
  pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' }
    ]
  });

  pc.ontrack = (evt) => {
    // remote stream may arrive as multiple tracks
    try {
      const incomingStream = (evt.streams && evt.streams[0]) ? evt.streams[0] : new MediaStream([evt.track]);
      console.debug('ontrack, tracks:', incomingStream.getTracks().map(t => t.kind));
      if (remoteVideo.srcObject !== incomingStream) {
        if (connectTimeout) { clearTimeout(connectTimeout); connectTimeout = null; }
        remoteVideo.srcObject = incomingStream;
        // ensure remote is unmuted
        try { remoteVideo.muted = false; } catch (e) {}
        // attempt to play; catch autoplay restrictions
        remoteVideo.play().then(() => {
          showConnected();
        }).catch(err => {
          console.warn('remoteVideo.play() rejected:', err);
          // show user prompt to enable audio if autoplay blocked
          showEnableAudioPrompt();
        });
      }
    } catch (err) {
      console.error('Error handling ontrack', err);
    }
  };

  pc.onicecandidate = (evt) => {
    if (evt.candidate) console.debug('icecandidate generated', evt.candidate);
    if (evt.candidate && partnerId) {
      socket.emit('ice-candidate', { to: partnerId, candidate: evt.candidate, matchId });
    }
  };

  pc.onconnectionstatechange = () => {
    console.debug('PC connectionState:', pc.connectionState);
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      hangup('Connection closed');
    }
  };
}

function resetPeerConnection() {
  if (pc) {
    try { pc.close(); } catch (e) {}
    pc = null;
  }
  if (connectTimeout) { clearTimeout(connectTimeout); connectTimeout = null; }
  remoteVideo.srcObject = null;
  if (remoteVideo && remoteVideo.parentElement) remoteVideo.parentElement.classList.remove('connected');
}

function showEnableAudioPrompt() {
  if (document.getElementById('enableAudioBtn')) return;
  const btn = document.createElement('button');
  btn.id = 'enableAudioBtn';
  btn.textContent = 'Dasturchi bilan bog\'lanish uchun pastga tushing.';
  btn.style.position = 'fixed';
  btn.style.left = '50%';
  btn.style.bottom = '16px';
  btn.style.transform = 'translateX(-50%)';
  btn.style.zIndex = 60;
  btn.className = 'px-4 py-2 rounded bg-sky-600 text-white shadow-lg';
  btn.addEventListener('click', async () => {
    try {
      if (remoteVideo && remoteVideo.srcObject) await remoteVideo.play();
      if (localVideo) await localVideo.play();
    } catch (err) {
      console.warn('Enable audio play failed', err);
    }
    const el = document.getElementById('enableAudioBtn');
    if (el) el.remove();
  });
  document.body.appendChild(btn);
}

function hangup(reason) {
  console.log('Hangup:', reason);
  // close peer connection, but keep local preview stream so user can immediately search again
  resetPeerConnection();

  partnerId = null;
  matchId = null;
  isInitiator = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  if (skipBtn) skipBtn.disabled = true;

  if (searchDotsInterval) clearInterval(searchDotsInterval);
  searchingEl.textContent = '';
  // when hangup and preview stopped, notify server that media is not ready
  if (!localStream && socket) socket.emit('media-ready', { ready: false });
}

function stopCall() {
  // Stop the call and return to idle preview (do not stop camera preview)
  if (socket) socket.emit('stop-search');
  if (socket) socket.emit('stop');
  hangup('Stopped by user');
  // also mark media not-ready if we stopped preview completely
  if (!localStream && socket) socket.emit('media-ready', { ready: false });
}

// Clean unload
window.addEventListener('beforeunload', () => {
  if (socket) {
    socket.emit('stop');
    socket.emit('stop-search');
  }
});

// Initialize socket connection by fetching runtime info (ngrok public URL if available).
async function initSocket() {
  try {
    const res = await fetch('/info');
    const info = await res.json();
    // If server provided a ngrokUrl, connect to it; otherwise default to same origin.
    const connectUrl = info.ngrokUrl || window.location.origin;
    socket = io(connectUrl);
    setupSocketHandlers();
  } catch (err) {
    console.warn('Could not fetch /info, falling back to same-origin socket:', err);
    socket = io();
    setupSocketHandlers();
  }
}

// Auto-init socket for typical cases (optional). We still lazily init on Start click.
initSocket().catch(() => {});

// Registration / username handling
const nameModalHtml = `
  <div id="nameModal" class="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
    <div class="w-full max-w-md p-6 bg-white rounded shadow">
      <h3 class="text-sky-700 text-lg font-semibold mb-2">Ismni kiriting</h3>
      <p class="text-sm text-slate-600 mb-4">Ismingizni kiriting (32 belgigacha). Bu nom sherikga ko'rinadi.</p>
      <input id="nameInput" class="w-full border border-slate-200 rounded px-3 py-2 mb-3" placeholder="Sizning ismingiz" />
      <div class="flex justify-end gap-2">
        <button id="nameSave" class="px-4 py-2 bg-sky-600 text-white rounded">Saqlash</button>
      </div>
    </div>
  </div>
`;

function showNameModal() {
  if (document.getElementById('nameModal')) return;
  document.body.insertAdjacentHTML('beforeend', nameModalHtml);
  const input = document.getElementById('nameInput');
  const save = document.getElementById('nameSave');
  input.focus();
  save.addEventListener('click', () => {
    const v = String(input.value || '').trim().slice(0,32);
    if (!v) return input.focus();
    localStorage.setItem('bluechat_name', v);
    const modal = document.getElementById('nameModal');
    if (modal) modal.remove();
    registerName(v);
  });
}

function registerName(name) {
  if (!socket) initSocket();
  if (socket) socket.emit('register', { name });
}

// ensure registered name exists
const existingName = localStorage.getItem('bluechat_name');
if (!existingName) {
  // show modal
  showNameModal();
} else {
  // inform server of existing name when socket ready
  (async () => {
    await initSocket();
    if (socket) socket.emit('register', { name: existingName });
  })();
}

// UI helpers
async function ensureLocalPreview() {
  if (!localStream) {
    try {
      // Use mobile-friendly constraints and prefer front camera
      const constraints = {
        audio: true,
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }
      };
      localStream = await navigator.mediaDevices.getUserMedia(constraints);
      localVideo.srcObject = localStream;
      // try to play local preview (user gesture should allow this)
      try { await localVideo.play(); } catch (err) { console.debug('Local preview play blocked, will play on user gesture', err); }
    } catch (err) {
      console.error('Unable to get media for preview', err);
      throw err;
    }
  }
}

function showConnecting() {
  searchingEl.innerHTML = '<div class="searching-text">Ulanmoqda…</div>';
  // indicate connecting state on partner panel
  if (remoteVideo && remoteVideo.parentElement) remoteVideo.parentElement.classList.remove('connected');
}

function showConnected() {
  searchingEl.innerHTML = '<div class="searching-text">Ulandi</div>';
  // add glow to remote panel
  if (remoteVideo && remoteVideo.parentElement) remoteVideo.parentElement.classList.add('connected');
}
