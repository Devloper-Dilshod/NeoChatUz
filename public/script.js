// server.js (to‘liq variant)
// Express + Socket.io + ngrok (ixtiyoriy)

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const ngrok = require("ngrok"); // ixtiyoriy — xohlamasang o‘chirib tashlashing mumkin
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// Public papkani ulaymiz
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

// ---- Runtime ma'lumot ----
let ngrokUrl = null;

// /info → client script.js shu endpoint orqali ulanish manzilini oladi
app.get("/info", (req, res) => {
  res.json({ ngrokUrl });
});

// === ONLINE USERS TRACK ===
let onlineUsers = new Map(); // socketId → { name, ready, searching }

// === MATCHMAKING QUEUE ===
let searchingQueue = []; // faqat media-ready foydalanuvchilar

function broadcastOnlineCount() {
  const total = onlineUsers.size;
  const ready = [...onlineUsers.values()].filter(u => u.ready).length;
  io.emit("online-count", { total, ready });
}

// === SOCKET HANDLERS ===
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  onlineUsers.set(socket.id, {
    name: "Foydalanuvchi",
    ready: false,
    searching: false
  });

  broadcastOnlineCount();

  socket.on("register", ({ name }) => {
    const u = onlineUsers.get(socket.id);
    if (u) u.name = name;
  });

  socket.on("media-ready", ({ ready }) => {
    const u = onlineUsers.get(socket.id);
    if (!u) return;
    u.ready = ready;

    if (!ready) {
      // Searchdan chiqarib yuboramiz
      searchingQueue = searchingQueue.filter(id => id !== socket.id);
    }
    broadcastOnlineCount();
  });

  socket.on("find", () => {
    const u = onlineUsers.get(socket.id);
    if (!u || !u.ready) return;

    u.searching = true;
    if (!searchingQueue.includes(socket.id))
      searchingQueue.push(socket.id);

    socket.emit("searching");
    tryMatch();
  });

  socket.on("stop-search", () => {
    const u = onlineUsers.get(socket.id);
    if (u) u.searching = false;
    searchingQueue = searchingQueue.filter(id => id !== socket.id);
  });

  socket.on("stop", () => {
    io.to(socket.id).emit("partner-left");
  });

  // SKIP
  socket.on("skip", ({ matchId, to }) => {
    io.to(to).emit("partner-left");
  });

  // Offer / Answer / ICE
  socket.on("offer", (data) => {
    io.to(data.to).emit("offer", { ...data, from: socket.id });
  });

  socket.on("answer", (data) => {
    io.to(data.to).emit("answer", data);
  });

  socket.on("ice-candidate", (data) => {
    io.to(data.to).emit("ice-candidate", data);
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);
    searchingQueue = searchingQueue.filter(id => id !== socket.id);
    onlineUsers.delete(socket.id);
    broadcastOnlineCount();
  });
});

// === MATCHING FUNKSIYASI ===
function tryMatch() {
  if (searchingQueue.length < 2) return;

  const a = searchingQueue.shift();
  const b = searchingQueue.shift();

  const ua = onlineUsers.get(a);
  const ub = onlineUsers.get(b);
  if (!ua || !ub || !ua.ready || !ub.ready) return;

  const matchId = "match_" + Math.random().toString(36).slice(2);

  io.to(a).emit("found", {
    partnerId: b,
    partnerName: ub.name,
    initiator: true,
    matchId
  });

  io.to(b).emit("found", {
    partnerId: a,
    partnerName: ua.name,
    initiator: false,
    matchId
  });
}

// === NGROK ISHLATMOQCHI BO'LSANG ===
async function startNgrok() {
  try {
    ngrokUrl = await ngrok.connect({
      addr: PORT,
      authtoken: process.env.NGROK_TOKEN || undefined
    });
    console.log("🔗 NGROK PUBLIC URL:", ngrokUrl);
  } catch (e) {
    console.log("ngrok ishlamadi:", e);
    ngrokUrl = null;
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log("Server running on port", PORT);

  // Ngrokni yoqmoqchi bo‘lsang:
  // await startNgrok();
});
