const path = require('path');
const express = require('express');
const app = express();
const http = require('http').createServer(app);
// Allow cross-origin socket.io connections so clients connecting via ngrok can reach the server
const io = require('socket.io')(http, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// Simple in-memory structures for matching
const waitingQueue = []; // socket ids waiting for a partner
const peers = {}; // peers[socketId] = partnerSocketId
const matchOf = {}; // matchOf[socketId] = matchId
const usernames = {}; // usernames[socketId] = displayName
const mediaReady = new Set(); // sockets that have granted camera/mic access

function removeFromQueue(id) {
  const idx = waitingQueue.indexOf(id);
  if (idx !== -1) waitingQueue.splice(idx, 1);
}

function makeMatchId(a, b) {
  return `${Date.now()}-${Math.random().toString(36).slice(2,9)}-${a.slice(0,6)}-${b.slice(0,6)}`;
}

function cleanupPeer(id, notifyPartner = true) {
  const partner = peers[id];
  if (partner) {
    delete peers[partner];
    delete peers[id];
    const m = matchOf[partner];
    delete matchOf[partner];
    delete matchOf[id];
    if (notifyPartner && io.sockets.sockets.get(partner)) {
      io.to(partner).emit('partner-left');
    }
  }
}

function tryMatchAll() {
  // Shuffle waitingQueue and pair off randomly
  // Filter out disconnected sockets first
  for (let i = waitingQueue.length - 1; i >= 0; i--) {
    const id = waitingQueue[i];
    if (!io.sockets.sockets.get(id)) waitingQueue.splice(i, 1);
  }

  if (waitingQueue.length < 2) return;

  // Shuffle using Fisher-Yates
  for (let i = waitingQueue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [waitingQueue[i], waitingQueue[j]] = [waitingQueue[j], waitingQueue[i]];
  }

  // Pair sequentially after shuffle
  while (waitingQueue.length >= 2) {
    const a = waitingQueue.shift();
    const b = waitingQueue.shift();

    // validate both are connected and not already peers
    if (!io.sockets.sockets.get(a) || !io.sockets.sockets.get(b) || peers[a] || peers[b]) {
      // if invalid, put valid one back
      if (io.sockets.sockets.get(a) && !peers[a]) waitingQueue.push(a);
      if (io.sockets.sockets.get(b) && !peers[b]) waitingQueue.push(b);
      continue;
    }

    // create match
    const matchId = makeMatchId(a, b);
    peers[a] = b;
    peers[b] = a;
    matchOf[a] = matchId;
    matchOf[b] = matchId;

    // notify both clients; choose initiator randomly
    const initiatorForA = Math.random() < 0.5;
      io.to(a).emit('found', { partnerId: b, initiator: initiatorForA, matchId, partnerName: usernames[b] || null });
      io.to(b).emit('found', { partnerId: a, initiator: !initiatorForA, matchId, partnerName: usernames[a] || null });
    console.log(`Matched ${a} <-> ${b} (${matchId})`);
  }
}

app.use((req, res, next) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  next();
});


function getOnlineCount() {
  try {
    return io.of('/').sockets.size;
  } catch (e) {
    return 0;
  }
}

function broadcastOnlineCount() {
  // emit both total connected sockets and number of users who granted media access
  const total = getOnlineCount();
  const ready = mediaReady.size;
  // also include a small sample of ready usernames for UI if needed
  const sample = Array.from(mediaReady).slice(0, 10).map(id => ({ id, name: usernames[id] || null }));
  io.emit('online-count', { total, ready, sample });
}

// Expose current public ngrok URL (if started). We'll set this when ngrok is launched.
let ngrokUrl = null;

app.get('/info', (req, res) => {
  res.json({ ngrokUrl, port: PORT });
});

io.on('connection', (socket) => {
  console.log('connect', socket.id);
  usernames[socket.id] = `User-${socket.id.slice(0,5)}`;
  broadcastOnlineCount();

  socket.on('find', () => {
    // If already paired, ignore
    if (peers[socket.id]) return;
    // Avoid duplicate in queue
    if (!waitingQueue.includes(socket.id)) {
      waitingQueue.push(socket.id);
    }
    socket.emit('searching');
    tryMatchAll();
  });

  socket.on('register', (data) => {
    const name = String(data && data.name || '').trim().slice(0,32);
    if (name) {
      usernames[socket.id] = name;
      socket.emit('registered', { name });
      broadcastOnlineCount();
    }
  });

  socket.on('media-ready', (data) => {
    // data.ready = true/false
    const ready = !!(data && data.ready);
    if (ready) mediaReady.add(socket.id);
    else mediaReady.delete(socket.id);
    broadcastOnlineCount();
  });

  socket.on('stop-search', () => {
    // remove from queue if present
    removeFromQueue(socket.id);
  });

  socket.on('skip', () => {
    // user wants to skip current partner and find a new one
    const partner = peers[socket.id];
    const myMatch = matchOf[socket.id];
    // remove both from peers mapping
    if (partner) {
      // notify partner that we've left; they should go to searching
      if (io.sockets.sockets.get(partner)) {
        io.to(partner).emit('partner-left');
      }
      delete peers[partner];
      delete matchOf[partner];
    }
    delete peers[socket.id];
    delete matchOf[socket.id];

    // Put the skipper back into queue and try rematching
    if (!waitingQueue.includes(socket.id)) waitingQueue.push(socket.id);
    tryMatchAll();
  });

  // emit enriched online-count including count and simple list of names (capped)
  // small helper to send more info when requested
  socket.on('whoami', () => {
    socket.emit('whoami', { id: socket.id, name: usernames[socket.id] });
  });

  socket.on('offer', (data) => {
    const { to, sdp, matchId } = data;
    // only forward if the matchId is still valid for both peers
    if (!matchId || matchOf[socket.id] !== matchId || matchOf[to] !== matchId) return;
    io.to(to).emit('offer', { from: socket.id, sdp, matchId });
  });

  socket.on('answer', (data) => {
    const { to, sdp, matchId } = data;
    if (!matchId || matchOf[socket.id] !== matchId || matchOf[to] !== matchId) return;
    io.to(to).emit('answer', { from: socket.id, sdp, matchId });
  });

  socket.on('ice-candidate', (data) => {
    const { to, candidate, matchId } = data;
    if (!matchId || matchOf[socket.id] !== matchId || matchOf[to] !== matchId) return;
    io.to(to).emit('ice-candidate', { from: socket.id, candidate, matchId });
  });

  socket.on('stop', () => {
    // hang up and cleanup both sides; partner will be notified and can search again
    cleanupPeer(socket.id, true);
    // ensure the stopper is removed from any queue
    removeFromQueue(socket.id);
  });

  socket.on('disconnect', () => {
    console.log('disconnect', socket.id);
    // cleanup waiting queue
    removeFromQueue(socket.id);
    // cleanup peer relationship and notify partner
    cleanupPeer(socket.id, true);
    // cleanup username and mediaReady
    delete usernames[socket.id];
    mediaReady.delete(socket.id);
    broadcastOnlineCount();
  });
});

http.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

// Optionally start ngrok automatically to expose the local server.
// Controls:
//  - Set environment variable ENABLE_NGROK=0 to disable automatic ngrok start.
//  - Optionally set NGROK_AUTHTOKEN to use your ngrok auth token.
;(async () => {
  if (process.env.ENABLE_NGROK === '0') return;
  try {
    const ngrok = require('ngrok');
    // Use the `proto: 'http'` option instead of the deprecated/unsupported
    // `bind_tls` flag. Recent ngrok versions expose both HTTP and HTTPS
    // endpoints for an HTTP proto, so no extra bind flag is needed.
    const opts = { addr: PORT, proto: 'http' };
    if (process.env.NGROK_AUTHTOKEN) opts.authtoken = process.env.NGROK_AUTHTOKEN;
    console.log('Starting ngrok tunnel...');
    ngrokUrl = await ngrok.connect(opts);
    console.log('Ngrok public URL:', ngrokUrl);
    console.log('Share this URL with friends to connect: %s', ngrokUrl);
  } catch (err) {
    console.error('Ngrok failed to start (ensure ngrok package installed):', err.message || err);
  }
})();
