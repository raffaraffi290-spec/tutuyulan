const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const srv = http.createServer(app);
const io = new Server(srv);
const PORT = process.env.PORT || 3000;

/* ---------- KONFIGURASI KARTU ---------- */
const SUITS = [{ s: '♠', red: false }, { s: '♥', red: true }, { s: '♦', red: true }, { s: '♣', red: false }];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function buildDeck() {
  const d = []; let id = 0;
  for (const su of SUITS) {
    for (const r of RANKS) {
      d.push({ id: id++, r, s: su.s, red: su.red, joker: false });
    }
  }
  d.push({ id: id++, r: 'JOKER', s: '★', red: false, joker: true }); // 1 Kartu Tuyul
  return d;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const cardName = c => c.joker ? 'JOKER 🃏 (Tuyul)' : `${c.r}${c.s}`;

/* ---------- LOGIKA EKSTRAKSI PAIR ---------- */
function extractPairs(hand) {
  const pairs = [], cnt = {};
  hand.forEach(c => { if (!c.joker) cnt[c.r] = (cnt[c.r] || 0) + 1; });
  for (const r in cnt) {
    while (cnt[r] >= 2) {
      cnt[r] -= 2;
      const a = hand.findIndex(c => !c.joker && c.r === r);
      const b = hand.findIndex((c, i) => !c.joker && c.r === r && i > a);
      pairs.push([hand[a], hand[b]]);
      hand.splice(b, 1); hand.splice(a, 1);
    }
  }
  return pairs;
}

/* ---------- MANAJEMEN RUANGAN & STATE ---------- */
const rooms = new Map();

function genCode() {
  let c;
  do { c = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(c));
  return c;
}

function bcast(room, ev, data) {
  for (const p of room.players) {
    const s = io.sockets.sockets.get(p.id);
    if (s) s.emit(ev, data);
  }
}

function sendRoomState(room) {
  for (const p of room.players) {
    const s = io.sockets.sockets.get(p.id);
    if (!s) continue;
    s.emit('room', {
      code: room.code,
      players: room.players.map(x => ({ name: x.name, seat: x.seat })),
      hostId: room.host,
      youSeat: p.seat,
      phase: room.game ? (room.game.over ? 'over' : 'game') : 'lobby'
    });
  }
}

function drawTarget(g) {
  let t = (g.active + 1) % 4, n = 0;
  while ((g.out[t] || g.hands[t].length === 0) && n < 4) {
    t = (t + 1) % 4;
    n++;
  }
  // Validasi akhir: pastikan target benar-benar valid
  if (g.out[t] || g.hands[t].length === 0) return null;
  return t;
}

function broadcastGame(room) {
  const g = room.game; if (!g) return;
  for (const p of room.players) {
    const s = io.sockets.sockets.get(p.id);
    if (!s) continue;
    s.emit('state', {
      names: room.players.map(x => x.name),
      you: p.seat,
      hand: g.hands[p.seat],
      counts: g.hands.map(h => h.length),
      out: g.out,
      active: g.active,
      pile: g.pile,
      over: g.over,
      loser: g.loser,
      reveal: g.reveal,
      drawTarget: g.over ? null : drawTarget(g),
      discardedPairs: g.discardedPairs || []
    });
  }
}

function startGame(room) {
  const deck = shuffle(buildDeck());
  const hands = [[], [], [], []];
  let turn = Math.floor(Math.random() * 4);
  while (deck.length) { hands[turn % 4].push(deck.pop()); turn++; }

  const firstActive = Math.floor(Math.random() * 4);
  const g = { hands, out: [false, false, false, false], active: firstActive, pile: 0, over: false, loser: null, reveal: false, discardedPairs: [] };
  room.game = g;

  bcast(room, 'log', { html: `🎲 Permainan dimulai! 53 kartu dibagikan, pair otomatis dibuang.`, cls: '' });
  for (let i = 0; i < 4; i++) {
    const prs = extractPairs(hands[i]);
    g.pile += prs.length * 2;
    // Simpan info pair (rank + suits) untuk ditampilkan
    for (const [c1, c2] of prs) {
      g.discardedPairs.push({ r: c1.r, s1: c1.s, s2: c2.s, red1: c1.red, red2: c2.red });
    }
    bcast(room, 'log', { html: `🧹 <b>${room.players[i].name}</b> membuang ${prs.length} pasang${prs.length ? ': ' + prs.map(p => p[0].r).join(', ') : ''}.`, cls: 'pair' });
  }
}

function doTurn(room, actor) {
  const g = room.game;
  const t = drawTarget(g);
  if (t == null || !g.hands[t].length) return;

  const idx = Math.floor(Math.random() * g.hands[t].length);
  const card = g.hands[t].splice(idx, 1)[0];
  const names = room.players.map(p => p.name);

  bcast(room, 'drawn', { to: actor, from: t, card });
  const ah = g.hands[actor];
  const match = card.joker ? null : ah.find(c => !c.joker && c.r === card.r);

  if (match) {
    ah.splice(ah.findIndex(c => c.id === match.id), 1);
    g.pile += 2;
    // Simpan pair yang dibuang (untuk ditampilkan di client)
    if (!g.discardedPairs) g.discardedPairs = [];
    g.discardedPairs.push({ r: card.r, s1: card.s, s2: match.s, red1: card.red, red2: match.red });
    bcast(room, 'log', { html: `🎴 <b>${names[actor]}</b> mencabut <b>${cardName(card)}</b> dari <b>${names[t]}</b> → PASANGAN ${card.r} dibuang!`, cls: 'pair' });
  } else {
    ah.push(card);
    bcast(room, 'log', { html: `🎴 <b>${names[actor]}</b> mencabut <b>${cardName(card)}</b> dari <b>${names[t]}</b> — tidak cocok, disimpan.`, cls: 'draw' });
  }

  for (let i = 0; i < 4; i++) {
    if (!g.out[i] && g.hands[i].length === 0) {
      g.out[i] = true;
      bcast(room, 'log', { html: `🎉 <b>${names[i]}</b> SELAMAT — kartunya habis!`, cls: 'out' });
      bcast(room, 'popup', { html: `<div class="pop-big">🎉</div><h2>${names[i]} Selamat!</h2><p>Kartunya sudah habis dan keluar dari putaran.</p>`, ms: 1800 });
    }
  }

  const alive = [0, 1, 2, 3].filter(i => !g.out[i]);
  if (alive.length === 1) {
    g.over = true; g.loser = alive[0]; g.reveal = true;
    bcast(room, 'log', { html: `☠️ <b>${names[g.loser]}</b> memegang kartu terakhir — JOKER (Tuyul). KALAH!`, cls: 'over' });
    bcast(room, 'gameOver', { loser: g.loser, name: names[g.loser] });
  } else {
    let n = actor;
    do { n = (n + 1) % 4; } while (g.out[n]);
    g.active = n;
  }
  broadcastGame(room);
}

/* ---------- EVENT SOCKET ---------- */
io.on('connection', socket => {
  let joined = null;

  socket.on('create', ({ name }, cb) => {
    name = String(name || 'Pemain').slice(0, 15);
    const code = genCode();
    const room = { code, host: socket.id, players: [{ id: socket.id, name, seat: 0 }], game: null };
    rooms.set(code, room);
    joined = { room };
    cb && cb({ ok: true, code });
    sendRoomState(room);
  });

  socket.on('join', ({ code, name }, cb) => {
    code = String(code || '').trim();
    name = String(name || 'Pemain').slice(0, 15);
    const room = rooms.get(code);
    if (!room) return cb && cb({ ok: false, msg: 'Kode ruangan tidak ditemukan.' });
    if (room.players.length >= 4) return cb && cb({ ok: false, msg: 'Ruangan sudah penuh (4 pemain).' });
    if (room.game && !room.game.over) return cb && cb({ ok: false, msg: 'Permainan sedang berlangsung.' });

    room.players.push({ id: socket.id, name, seat: room.players.length });
    joined = { room };
    cb && cb({ ok: true, code });
    bcast(room, 'log', { html: `👤 <b>${name}</b> bergabung.`, cls: '' });
    sendRoomState(room);
  });

  socket.on('start', () => {
    if (!joined) return;
    const room = joined.room;
    if (room.host !== socket.id || room.players.length < 4) return;
    if (room.game && !room.game.over) return;
    startGame(room);
    broadcastGame(room);
    sendRoomState(room);
  });

  socket.on('draw', () => {
    if (!joined || !joined.room.game) return;
    const g = joined.room.game; if (g.over) return;
    const me = joined.room.players.find(p => p.id === socket.id);
    if (!me || me.seat !== g.active || g.out[me.seat]) return;
    doTurn(joined.room, me.seat);
  });

  socket.on('disconnect', () => {
    if (!joined) return;
    const room = joined.room;
    const i = room.players.findIndex(p => p.id === socket.id);
    if (i < 0) return;
    const name = room.players[i].name;
    room.players.splice(i, 1);

    if (!room.players.length) {
      rooms.delete(room.code);
      return;
    }
    if (room.host === socket.id) room.host = room.players[0].id;
    room.players.forEach((p, k) => p.seat = k);

    if (room.game) {
      room.game = null;
      bcast(room, 'log', { html: `⚠️ <b>${name}</b> keluar — permainan dihentikan.`, cls: 'over' });
      bcast(room, 'gameAborted', { name });
    }
    sendRoomState(room);
  });
});

srv.listen(PORT, () => console.log(`🃏 Tuyul Online berjalan di http://localhost:${PORT}`));