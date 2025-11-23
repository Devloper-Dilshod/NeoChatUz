const path = require('path');
const express = require('express');
const app = express();
const http = require('http').createServer(app);
// Allow cross-origin socket.io connections so clients connecting via ngrok can reach the server
const io = require('socket.io')(http, { cors: { origin: '*' } });

// Alwaysdata kabi hostinglarda PORT qiymatini atrof-muhit o'zgaruvchisidan (process.env.PORT) olamiz.
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// Simple in-memory structures for matching
const waitingQueue = []; // socket ids waiting for a partner
const peers = {}; // peers[socketId] = partnerSocketId
const matchOf = {}; // matchOf[socketId] = matchId
const usernames = {}; // usernames[socketId] = displayName
const mediaReady = new Set(); // sockets that have granted camera/mic access

let ngrokUrl = ''; // Endi ngrok-ni ishlatmaymiz, lekin /info endpointiga bo'sh satr qaytaramiz.

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
    if (notifyPartner) {
      io.to(partner).emit('match_ended', { reason: 'partner_disconnected' });
    }
    console.log(`Match ${m} ended between ${id} and ${partner}`);
  }
}

function tryMatch(id) {
  if (waitingQueue.length > 0) {
    const partner = waitingQueue.shift();
    if (partner === id) {
      // should not happen, but prevents self-match
      console.error('Self-match attempted!');
      waitingQueue.unshift(id);
      return;
    }
    
    const matchId = makeMatchId(id, partner);
    peers[id] = partner;
    peers[partner] = id;
    matchOf[id] = matchId;
    matchOf[partner] = matchId;
    
    console.log(`Match found: ${id} vs ${partner} (Match ID: ${matchId})`);
    
    // Notify client A (the current socket)
    io.to(id).emit('match_found', { matchId, partnerId: partner, partnerUsername: usernames[partner] });
    // Notify client B (the waiting socket)
    io.to(partner).emit('match_found', { matchId, partnerId: id, partnerUsername: usernames[id] });
  } else {
    waitingQueue.push(id);
    console.log(`${id} added to queue. Queue size: ${waitingQueue.length}`);
  }
}

function broadcastOnlineCount() {
  io.emit('online_count', { count: io.engine.clientsCount });
}

// Endpoint for client to query server info (like ngrok URL)
app.get('/info', (req, res) => {
  res.json({ ngrokUrl });
});

io.on('connection', (socket) => {
  console.log('connection', socket.id);
  
  broadcastOnlineCount();

  socket.on('set_username', (data) => {
    const { username } = data;
    usernames[socket.id] = username || 'Anon';
    console.log(`Username set for ${socket.id}: ${usernames[socket.id]}`);
  });

  socket.on('media_ready', () => {
    mediaReady.add(socket.id);
    console.log(`${socket.id} media ready`);
    
    if (peers[socket.id]) {
      // If already matched, signal the partner media is ready
      io.to(peers[socket.id]).emit('partner_media_ready');
    }
  });

  socket.on('start_search', () => {
    console.log('start_search', socket.id);
    
    // Ensure media is ready before matching
    if (!mediaReady.has(socket.id)) {
      console.log(`${socket.id} started search, but media not ready. Waiting...`);
      // We could optionally emit an event here to tell the client to wait
      return;
    }

    // if user is already matched, end the current match first
    cleanupPeer(socket.id, true);

    // ensure the stopper is removed from any queue
    removeFromQueue(socket.id);

    tryMatch(socket.id);
  });

  socket.on('stop_search', () => {
    console.log('stop_search', socket.id);
    removeFromQueue(socket.id);
  });
  
  socket.on('end_match', () => {
    console.log('end_match', socket.id);
    cleanupPeer(socket.id, true);
    // ensure the stopper is removed from any queue
    removeFromQueue(socket.id);
  });

  // WebRTC Signaling Handlers
  socket.on('webrtc_offer', (data) => {
    const { sdp } = data;
    const partner = peers[socket.id];
    if (partner) {
      io.to(partner).emit('webrtc_offer', { sdp, senderId: socket.id });
    }
  });

  socket.on('webrtc_answer', (data) => {
    const { sdp } = data;
    const partner = peers[socket.id];
    if (partner) {
      io.to(partner).emit('webrtc_answer', { sdp, senderId: socket.id });
    }
  });

  socket.on('webrtc_ice_candidate', (data) => {
    const { candidate } = data;
    const partner = peers[socket.id];
    if (partner) {
      io.to(partner).emit('webrtc_ice_candidate', { candidate, senderId: socket.id });
    }
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



// ngrok ni ishga tushirish qismi olib tashlandi,
// chunki u hostingda EACCES xatosiga sabab bo'layotgan edi.