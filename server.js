// server.js - Lugen multiplayer card game backend
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const auth = require('./auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filepath) => {
    if (filepath.endsWith('.js'))   res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    if (filepath.endsWith('.html')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
  }
}));
app.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- Auth REST endpoints ----------
function bearerToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

app.get('/api/config', (_req, res) => {
  res.json({
    authEnabled: auth.enabled,
    googleEnabled: auth.oauthEnabled,
    minPasswordLen: auth.MIN_PASSWORD_LEN,
    supabaseUrl: auth.oauthEnabled ? auth.supabaseUrl : '',
    supabaseAnonKey: auth.oauthEnabled ? auth.supabaseAnonKey : ''
  });
});

app.post('/api/signup', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = await auth.signup(username, password);
    const token = await auth.createSession(user.id);
    res.json({ token, user: auth.publicUser(user) });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Signup failed.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = await auth.login(username, password);
    const token = await auth.createSession(user.id);
    res.json({ token, user: auth.publicUser(user) });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Login failed.' });
  }
});

app.post('/api/logout', async (req, res) => {
  await auth.deleteSession(bearerToken(req));
  res.json({ ok: true });
});

app.get('/api/me', async (req, res) => {
  const user = await auth.getUserByToken(bearerToken(req));
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  const mods = await auth.userModifierStats(user.id);
  res.json({ user: auth.publicUser(user), modifierStats: mods });
});

app.get('/api/leaderboard', async (_req, res) => {
  const list = await auth.leaderboard(20);
  res.json({ users: list });
});

// ---- Beta prototype: account-linked roguelike progression ----

app.get('/api/beta/progression', async (req, res) => {
  const user = await auth.getUserByToken(bearerToken(req));
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  const prog = await auth.getBetaProgression(user.id);
  if (!prog) return res.status(500).json({ error: 'Could not load progression.' });
  res.json({ progression: prog });
});

app.post('/api/beta/progression', async (req, res) => {
  const user = await auth.getUserByToken(bearerToken(req));
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  const { maxFloor, runWon } = req.body || {};
  const prog = await auth.updateBetaProgression(user.id, { maxFloor, runWon });
  if (!prog) return res.status(500).json({ error: 'Could not update progression.' });
  res.json({ progression: prog });
});

app.post('/api/beta/admin/unlock-all', async (req, res) => {
  const user = await auth.getUserByToken(bearerToken(req));
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  const prog = await auth.adminUnlockAllProgression(user.id);
  if (!prog) return res.status(403).json({ error: 'Admin access required.' });
  res.json({ progression: prog });
});

// ---- Phase 6: cosmetics + achievements ----

app.get('/api/cosmetics/me', async (req, res) => {
  const user = await auth.getUserByToken(bearerToken(req));
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  const c = await auth.getCosmetics(user.id);
  if (!c) return res.status(500).json({ error: 'Could not load cosmetics.' });
  res.json({ cosmetics: c });
});

// ---- Phase 7: beta run history ----

app.get('/api/beta/run-history', async (req, res) => {
  const user = await auth.getUserByToken(bearerToken(req));
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  const history = await auth.getBetaRunHistory(user.id);
  res.json({ history: history });
});

app.post('/api/beta/run-history', async (req, res) => {
  const user = await auth.getUserByToken(bearerToken(req));
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  const next = await auth.recordBetaRun(user.id, req.body || {});
  if (!next) return res.status(500).json({ error: 'Could not record run.' });
  res.json({ history: next });
});

app.post('/api/oauth-link', async (req, res) => {
  try {
    const { supabase_token, username } = req.body || {};
    if (!supabase_token) return res.status(400).json({ error: 'Missing token.' });
    const supaUser = await auth.verifySupabaseUser(supabase_token);
    if (!supaUser) return res.status(401).json({ error: 'Invalid Supabase token.' });
    const provider = (supaUser.app_metadata && supaUser.app_metadata.provider) || 'oauth';
    const sub = supaUser.id;
    const email = supaUser.email || null;
    const result = await auth.findOrCreateOAuthUser({ provider, sub, email, username });
    if (result.needsUsername) {
      return res.status(409).json({
        error: 'Username required.',
        needsUsername: true,
        suggested: result.suggested || ''
      });
    }
    const token = await auth.createSession(result.user.id);
    res.json({ token, user: auth.publicUser(result.user), isNew: !!result.isNew });
  } catch (e) {
    res.status(400).json({ error: e.message || 'OAuth link failed.' });
  }
});

// ---------- Game constants ----------
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUITS = ['H', 'D', 'C', 'S'];
const FOUR_OF_KIND_MS = 15000;

const LIARS_BAR_RANKS = ['J', 'Q', 'K', 'A'];
const LIARS_BAR_SUITS = SUITS;
const LIARS_BAR_CARDS_PER_PLAYER = 5;
const LIARS_BAR_FACE_DECK_SIZE = LIARS_BAR_RANKS.length * LIARS_BAR_SUITS.length;
const LIARS_BAR_GUN_CHAMBERS = 6;

const JOKER_SLIDER_MAX = 10;
const JOKER_RANDOM_MAX = 5;
const ROTATE_MAX = 10;

const VALID_WILD_SUITS = ['', 'H', 'D', 'C', 'S', 'random'];

const LOBBY_GRACE_MS = 60 * 1000;
const EMPTY_ROOM_GRACE_MS = 5 * 60 * 1000;

// ---------- Helpers ----------
function newPlayerId() { return crypto.randomBytes(8).toString('hex'); }
function jokerCard(idx) { return { rank: 'JOKER', suit: '*', id: 'JK' + (idx + 1) }; }

function createDeck() {
  const deck = [];
  for (const r of RANKS) for (const s of SUITS) deck.push({ rank: r, suit: s, id: r + s });
  return deck;
}

function createLiarsBarFaceDeck() {
  const deck = [];
  for (const r of LIARS_BAR_RANKS) for (const s of LIARS_BAR_SUITS) {
    deck.push({ rank: r, suit: s, id: r + s });
  }
  return deck;
}

function buildLiarsBarDeck(numAlive, jokerCountRequest) {
  const total = numAlive * LIARS_BAR_CARDS_PER_PLAYER;
  const minJokersForDeckSize = Math.max(0, total - LIARS_BAR_FACE_DECK_SIZE);
  let jokers = Math.max(jokerCountRequest | 0, minJokersForDeckSize);
  jokers = Math.min(jokers, total);
  const faceCount = total - jokers;
  const facePool = shuffle(createLiarsBarFaceDeck()).slice(0, faceCount);
  const jokerCards = [];
  for (let i = 0; i < jokers; i++) jokerCards.push(jokerCard(i));
  return { deck: shuffle([...facePool, ...jokerCards]), jokers, total };
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function dealCards(deck, numPlayers) {
  const hands = Array.from({ length: numPlayers }, () => []);
  for (let i = 0; i < deck.length; i++) hands[i % numPlayers].push(deck[i]);
  return hands;
}

function applyLeanDeck(deck, cardsToRemove) {
  if (cardsToRemove <= 0) return deck;
  const eligibleRanks = RANKS.filter(r => r !== 'J');
  const buckets = {};
  for (const r of eligibleRanks) buckets[r] = [];
  for (const c of deck) {
    if (c.rank !== 'J' && c.rank !== 'JOKER' && buckets[c.rank]) buckets[c.rank].push(c);
  }
  for (const r of eligibleRanks) shuffle(buckets[r]);
  const rankOrder = shuffle([...eligibleRanks]);
  const drops = {};
  for (const r of eligibleRanks) drops[r] = 0;
  let remaining = cardsToRemove;
  let safety = 0;
  while (remaining > 0 && safety < 100) {
    let droppedThisPass = 0;
    for (const r of rankOrder) {
      if (drops[r] < buckets[r].length) {
        drops[r]++; remaining--; droppedThisPass++;
        if (remaining === 0) break;
      }
    }
    if (droppedThisPass === 0) break;
    safety++;
  }
  const idsToRemove = new Set();
  for (const r of eligibleRanks) {
    for (let i = 0; i < drops[r]; i++) idsToRemove.add(buckets[r][i].id);
  }
  return deck.filter(c => !idsToRemove.has(c.id));
}

function makeRoomId() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 5; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function clampInt(v, lo, hi) {
  const n = Math.floor(Number(v));
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function describeActiveSettings(s) {
  const out = [];
  if (s.liarsBar)         out.push("Liar's Bar Mode");
  if (s.cardsRemoved > 0) out.push(`Lean Deck (-${s.cardsRemoved})`);
  if (s.pileStart > 0)    out.push(`Loaded Pile (+${s.pileStart})`);
  if (s.maxCards < 3)     out.push(`Trickle Mode (max ${s.maxCards})`);
  if (s.jokerRandom)      out.push('Random Jokers (?)');
  else if (s.jokerCount > 0) out.push(`Jokers (${s.jokerCount})`);
  if (s.wildSuit === 'random') out.push('Wild Suit (random)');
  else if (s.wildSuit)         out.push(`Wild Suit (${s.wildSuit})`);
  if (s.fogOfWar)         out.push('Fog of War');
  if (s.mysteryHands)     out.push('Mystery Hands');
  if (s.shuffleSeats)     out.push('Shuffle Seats');
  if (s.rotateTargetEvery > 0) out.push(`Rotates every ${s.rotateTargetEvery}`);
  return out;
}

function activeModifierKeys(s) {
  const out = [];
  if (s.liarsBar)              out.push('liarsBar');
  if (s.cardsRemoved > 0)      out.push('leanDeck');
  if (s.pileStart > 0)         out.push('loadedPile');
  if (s.maxCards < 3)          out.push('trickle');
  if (s.jokerRandom || s.jokerCount > 0) out.push('jokers');
  if (s.wildSuit)              out.push('wildSuit');
  if (s.fogOfWar)              out.push('fogOfWar');
  if (s.mysteryHands)          out.push('mysteryHands');
  if (s.shuffleSeats)          out.push('shuffleSeats');
  if (s.rotateTargetEvery > 0) out.push('rotatingTarget');
  return out;
}

function defaultSettings() {
  return {
    cardsRemoved: 0, pileStart: 0, maxCards: 3,
    mysteryHands: false, liarsBar: false, shuffleSeats: false,
    jokerCount: 0, jokerRandom: false,
    wildSuit: '', fogOfWar: false,
    rotateTargetEvery: 0
  };
}

// ---------- Room state ----------
const rooms = {};

function newRoom(id) {
  return {
    id, players: [], pile: [], lastPlayedCards: [], lastPlayCount: 0,
    lastPlayerId: null, canChallengeId: null, currentTurnIdx: 0,
    targetRank: null, started: false, log: [], revealedFour: null,
    gameOver: false, winners: [], losers: [], hostId: null, emptyTimer: null,
    settings: defaultSettings(), actualJokerCount: 0, actualWildSuit: '',
    statsRecorded: false,
    discardedRanks: [],          // ranks that have been 4-of-a-kind discarded — no longer pickable as target
    playsSinceTargetChange: 0    // counter for the Rotating Target modifier
  };
}

function publicState(room) {
  const hideCounts = room.settings && room.settings.mysteryHands && room.started && !room.gameOver;
  const hideJokerCount = room.started && !room.gameOver && !!room.settings.jokerRandom;
  const fog = room.settings && room.settings.fogOfWar && room.started && !room.gameOver;
  return {
    id: room.id,
    hostId: room.hostId,
    settings: room.settings,
    actualJokerCount: hideJokerCount ? null : room.actualJokerCount,
    actualWildSuit: room.actualWildSuit || '',
    discardedRanks: Array.isArray(room.discardedRanks) ? room.discardedRanks.slice() : [],
    playsUntilRotate: (room.settings && room.settings.rotateTargetEvery > 0)
      ? Math.max(0, room.settings.rotateTargetEvery - (room.playsSinceTargetChange || 0))
      : null,
    players: room.players.map((p, idx) => ({
      id: p.id,
      name: p.name,
      username: p.username || null,
      cardCount: hideCounts && p.hand.length > 0 ? null : p.hand.length,
      isSkipped: !!p.isSkipped,
      connected: !!p.connected,
      alive: p.alive !== false,
      chambers: typeof p.chambers === 'number' ? p.chambers : LIARS_BAR_GUN_CHAMBERS,
      seatNumber: room.started ? idx + 1 : null
    })),
    started: room.started,
    currentTurnIdx: room.currentTurnIdx,
    targetRank: room.targetRank,
    pileSize: fog ? null : room.pile.length,
    lastPlayCount: fog ? null : room.lastPlayCount,
    lastPlayerId: room.lastPlayerId,
    canChallengeId: room.canChallengeId,
    revealedFour: room.revealedFour,
    gameOver: room.gameOver,
    winners: room.winners,
    losers: room.losers,
    log: fog ? ['(Game log hidden by Fog of War — revealed at game over.)'] : room.log.slice(-30)
  };
}

function recordCompletedGameStats(room) {
  if (!auth.enabled || !room.gameOver || room.statsRecorded) return;
  if (!room.winners || room.winners.length === 0) return;
  room.statsRecorded = true;
  const mode = room.settings.liarsBar ? 'liarsbar' : 'classic';
  const winners = new Set(room.winners);
  const losers = new Set(room.losers);
  const entries = [];
  for (const p of room.players) {
    if (!p.userId) continue;
    entries.push({
      userId: p.userId,
      won: winners.has(p.id),
      lost: losers.has(p.id),
      mode,
      eliminated: p.alive === false
    });
  }
  if (entries.length === 0) return;
  const mods = activeModifierKeys(room.settings);
  auth.recordGameStats(entries, mods).catch(err => {
    console.error('[stats] record failed', err && err.message);
  });
}

function broadcast(room) {
  if (room.gameOver && !room.statsRecorded) recordCompletedGameStats(room);
  io.to(room.id).emit('roomState', publicState(room));
  for (const p of room.players) {
    if (p.socketId) io.to(p.socketId).emit('hand', p.hand);
  }
}

function findNextActiveIdx(room, fromIdx) {
  const n = room.players.length;
  let idx = fromIdx;
  for (let i = 0; i < n + 1; i++) {
    idx = (idx + 1 + n) % n;
    const p = room.players[idx];
    if (!p.connected) continue;
    if (p.alive === false) continue;
    if (p.hand.length === 0) continue;
    if (p.isSkipped) {
      p.isSkipped = false;
      room.log.push(`${p.name} is skipped this turn.`);
      continue;
    }
    return idx;
  }
  return fromIdx;
}

function checkInstantLoss(room) {
  if (room.settings && room.settings.liarsBar) return false;
  for (const p of room.players) {
    if (p.hand.filter(c => c.rank === 'J').length === 4) {
      room.gameOver = true;
      room.losers = [p.id];
      room.winners = room.players.filter(x => x.id !== p.id).map(x => x.id);
      room.log.push(`${p.name} holds all 4 Jacks - instant loss!`);
      return true;
    }
  }
  return false;
}

function checkLastPlayerStanding(room) {
  if (room.gameOver) return;
  if (room.settings && room.settings.liarsBar) {
    const aliveCount = room.players.filter(p => p.alive !== false).length;
    if (aliveCount <= 1 && room.players.length > 1) {
      room.gameOver = true;
      const survivor = room.players.find(p => p.alive !== false);
      room.winners = survivor ? [survivor.id] : [];
      room.losers = room.players.filter(p => p.alive === false).map(p => p.id);
      if (survivor) room.log.push(`${survivor.name} is the last one standing and wins!`);
      if (room.settings.jokerRandom) {
        room.log.push(`Random Jokers reveal: there were ${room.actualJokerCount} joker(s) in the deck.`);
      }
    }
    return;
  }
  const withCards = room.players.filter(p => p.hand.length > 0);
  const totalPlayers = room.players.length;
  const losingThreshold = totalPlayers >= 3 ? 2 : 1;
  if (totalPlayers > 1 && withCards.length > 0 && withCards.length <= losingThreshold) {
    room.gameOver = true;
    room.losers = withCards.map(p => p.id);
    room.winners = room.players.filter(p => p.hand.length === 0).map(p => p.id);
    if (withCards.length === 1) {
      room.log.push(`${withCards[0].name} is left with cards and loses the game.`);
    } else {
      const names = withCards.map(p => p.name).join(' and ');
      room.log.push(`Only ${names} are left with cards - both lose!`);
    }
    if (room.settings.jokerRandom) {
      room.log.push(`Random Jokers reveal: there were ${room.actualJokerCount} joker(s) in the deck.`);
    }
  }
}

function clearPile(room) {
  room.pile = []; room.lastPlayedCards = []; room.lastPlayCount = 0;
  room.lastPlayerId = null; room.canChallengeId = null; room.targetRank = null;
  room.playsSinceTargetChange = 0;
}

function findPlayerBySocket(room, socketId) {
  return room.players.find(p => p.socketId === socketId);
}

function scheduleEmptyRoomCleanup(room) {
  if (room.emptyTimer) clearTimeout(room.emptyTimer);
  room.emptyTimer = setTimeout(() => {
    const r = rooms[room.id];
    if (!r) return;
    const stillConnected = r.players.some(p => p.connected);
    if (!stillConnected) delete rooms[r.id];
  }, EMPTY_ROOM_GRACE_MS);
}

function cancelEmptyRoomCleanup(room) {
  if (room.emptyTimer) { clearTimeout(room.emptyTimer); room.emptyTimer = null; }
}

function pickRandomTargetRank() {
  return LIARS_BAR_RANKS[Math.floor(Math.random() * LIARS_BAR_RANKS.length)];
}

// ---------- Rotating Target ----------
//
// Pick a fresh target rank for the running round. Forbidden picks: J (rule),
// the current rank (forces a real change), and any rank already discarded
// via 4-of-a-kind (those cards are physically gone from the game). Returns
// null if nothing valid is left.
function pickRotatedTarget(room) {
  const source = room.settings && room.settings.liarsBar ? LIARS_BAR_RANKS : RANKS;
  const discarded = new Set(room.discardedRanks || []);
  const candidates = source.filter(r =>
    r !== 'J' &&
    r !== room.targetRank &&
    !discarded.has(r)
  );
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// Trigger a target rotation: pick a new rank, clear the LIAR window, reset
// the per-target play counter. Cards already on the pile stay, but the
// previously played cards become unchallengeable (canChallengeId cleared).
function rotateTarget(room, reason) {
  const next = pickRotatedTarget(room);
  if (!next) {
    room.log.push('Target rotation skipped — no other valid rank available.');
    room.playsSinceTargetChange = 0;
    return;
  }
  const old = room.targetRank || '?';
  room.targetRank = next;
  room.lastPlayedCards = [];
  room.lastPlayCount = 0;
  room.lastPlayerId = null;
  room.canChallengeId = null;
  room.playsSinceTargetChange = 0;
  const because = reason ? ` (${reason})` : '';
  room.log.push(`Target rotated: ${old} → ${next}${because}. Previous plays are now safe from LIAR.`);
}

function startLiarsBarRound(room) {
  const alive = room.players.filter(p => p.alive !== false);
  const { deck, jokers } = buildLiarsBarDeck(alive.length, room.actualJokerCount);
  room.actualJokerCount = jokers;
  const hands = dealCards(deck, alive.length);
  alive.forEach((p, i) => { p.hand = hands[i]; p.isSkipped = false; });
  room.players.filter(p => p.alive === false).forEach(p => { p.hand = []; });
  clearPile(room);
  room.targetRank = pickRandomTargetRank();
  room.log.push(`New round dealt (${alive.length} alive, ${alive.length * LIARS_BAR_CARDS_PER_PLAYER} cards). Target rank: ${room.targetRank}.`);
}

function applyShuffleSeatsPreservingStarter(room, starterId) {
  shuffle(room.players);
  const idx = room.players.findIndex(p => p.id === starterId);
  if (idx >= 0) room.currentTurnIdx = idx;
}

// ---------- Socket handlers ----------
io.on('connection', async (socket) => {
  let currentRoomId = null;
  let socketUser = null;
  const authToken = socket.handshake && socket.handshake.auth && socket.handshake.auth.token;
  if (authToken) {
    try { socketUser = await auth.getUserByToken(authToken); } catch (_) {}
  }

  function emitError(message) { socket.emit('errorMsg', { message }); }

  socket.on('createRoom', ({ name }) => {
    const roomId = makeRoomId();
    const room = newRoom(roomId);
    rooms[roomId] = room;
    const player = addPlayer(room, socket, name);
    room.hostId = player.id;
    currentRoomId = roomId;
    socket.emit('joined', { roomId, playerId: player.id });
    broadcast(room);
  });

  socket.on('joinRoom', ({ roomId, name }) => {
    const room = rooms[(roomId || '').toUpperCase()];
    if (!room) return emitError('Room not found.');
    if (room.started) return emitError('Game already started.');
    if (room.players.length >= 8) return emitError('Room is full (8 max).');
    const player = addPlayer(room, socket, name);
    currentRoomId = room.id;
    socket.emit('joined', { roomId: room.id, playerId: player.id });
    broadcast(room);
  });

  socket.on('resumeSession', ({ roomId, playerId }) => {
    const room = rooms[(roomId || '').toUpperCase()];
    if (!room) return socket.emit('reconnectFailed', { reason: 'Room no longer exists.' });
    const player = room.players.find(p => p.id === playerId);
    if (!player) return socket.emit('reconnectFailed', { reason: 'You are no longer in that room.' });
    if (player.removalTimer) { clearTimeout(player.removalTimer); player.removalTimer = null; }
    cancelEmptyRoomCleanup(room);
    const wasOffline = !player.connected;
    player.socketId = socket.id;
    player.connected = true;
    if (socketUser) {
      player.userId = socketUser.id;
      player.username = socketUser.username;
    }
    socket.join(room.id);
    currentRoomId = room.id;
    if (wasOffline) room.log.push(`${player.name} reconnected.`);
    socket.emit('joined', { roomId: room.id, playerId: player.id });
    broadcast(room);
  });

  function addPlayer(room, sock, name) {
    const displayName = socketUser
      ? socketUser.username
      : ((name || '').trim().slice(0, 20) || `Player${room.players.length + 1}`);
    const player = {
      id: newPlayerId(),
      socketId: sock.id,
      name: displayName,
      userId: socketUser ? socketUser.id : null,
      username: socketUser ? socketUser.username : null,
      hand: [],
      connected: true,
      isSkipped: false,
      removalTimer: null,
      alive: true,
      chambers: LIARS_BAR_GUN_CHAMBERS
    };
    room.players.push(player);
    sock.join(room.id);
    cancelEmptyRoomCleanup(room);
    return player;
  }

  socket.on('updateSettings', (patch) => {
    const room = rooms[currentRoomId];
    if (!room) return;
    const me = findPlayerBySocket(room, socket.id);
    if (!me || room.hostId !== me.id) return emitError('Only the host can change settings.');
    if (room.started) return emitError('Cannot change settings during a game.');
    if (!patch || typeof patch !== 'object') return;
    const s = room.settings;
    if ('cardsRemoved' in patch) s.cardsRemoved = clampInt(patch.cardsRemoved, 0, 20);
    if ('pileStart'    in patch) s.pileStart    = clampInt(patch.pileStart, 0, 10);
    if ('maxCards'     in patch) s.maxCards     = clampInt(patch.maxCards, 1, 3);
    if ('mysteryHands' in patch) s.mysteryHands = !!patch.mysteryHands;
    if ('liarsBar'     in patch) s.liarsBar     = !!patch.liarsBar;
    if ('shuffleSeats' in patch) s.shuffleSeats = !!patch.shuffleSeats;
    if ('jokerCount'   in patch) s.jokerCount   = clampInt(patch.jokerCount, 0, JOKER_SLIDER_MAX);
    if ('jokerRandom'  in patch) s.jokerRandom  = !!patch.jokerRandom;
    if ('wildSuit'     in patch) {
      const v = String(patch.wildSuit || '');
      s.wildSuit = VALID_WILD_SUITS.includes(v) ? v : '';
    }
    if ('fogOfWar'     in patch) s.fogOfWar     = !!patch.fogOfWar;
    if ('rotateTargetEvery' in patch) s.rotateTargetEvery = clampInt(patch.rotateTargetEvery, 0, ROTATE_MAX);
    broadcast(room);
  });

  socket.on('startGame', () => {
    const room = rooms[currentRoomId];
    if (!room) return;
    const me = findPlayerBySocket(room, socket.id);
    if (!me || room.hostId !== me.id) return emitError('Only the host can start.');
    if (room.players.length < 2) return emitError('Need at least 2 players.');
    if (room.started) return;

    room.players.forEach(p => {
      p.alive = true;
      p.chambers = LIARS_BAR_GUN_CHAMBERS;
      p.isSkipped = false;
      p.hand = [];
    });
    shuffle(room.players);
    room.started = true;
    room.gameOver = false;
    room.statsRecorded = false;
    room.winners = []; room.losers = [];
    room.currentTurnIdx = 0;
    room.targetRank = null;
    room.discardedRanks = [];
    room.playsSinceTargetChange = 0;
    clearPile(room);

    let jokerRequest;
    if (room.settings.jokerRandom) jokerRequest = Math.floor(Math.random() * (JOKER_RANDOM_MAX + 1));
    else                            jokerRequest = room.settings.jokerCount | 0;
    room.actualJokerCount = jokerRequest;

    if (room.settings.wildSuit === 'random') {
      room.actualWildSuit = SUITS[Math.floor(Math.random() * SUITS.length)];
    } else if (SUITS.includes(room.settings.wildSuit)) {
      room.actualWildSuit = room.settings.wildSuit;
    } else {
      room.actualWildSuit = '';
    }

    if (room.settings.liarsBar) {
      startLiarsBarRound(room);
    } else {
      let deck = createDeck();
      for (let i = 0; i < jokerRequest; i++) deck.push(jokerCard(i));
      const cardsRemoved = room.settings.cardsRemoved | 0;
      if (cardsRemoved > 0) {
        const safeCount = Math.min(cardsRemoved, Math.max(0, deck.length - room.players.length));
        deck = applyLeanDeck(deck, safeCount);
      }
      deck = shuffle(deck);
      const pileSeed = Math.min(room.settings.pileStart | 0, Math.max(0, deck.length - room.players.length));
      const initialPile = pileSeed > 0 ? deck.splice(0, pileSeed) : [];
      const hands = dealCards(deck, room.players.length);
      room.players.forEach((p, i) => { p.hand = hands[i]; });
      room.pile = initialPile;
    }

    const seating = room.players.map((p, i) => `#${i + 1} ${p.name}`).join(', ');
    room.log.push(`Game started - seating: ${seating}.`);
    const mods = describeActiveSettings(room.settings);
    if (mods.length) room.log.push(`Modifiers active: ${mods.join(', ')}.`);
    if (room.actualWildSuit) room.log.push(`Wild Suit this game: ${room.actualWildSuit}.`);
    if (room.settings.liarsBar) room.log.push(`#1 ${room.players[0].name} starts.`);
    else room.log.push(`#1 ${room.players[0].name} chooses the first Target Rank and starts.`);
    if (checkInstantLoss(room)) { broadcast(room); return; }
    broadcast(room);
  });

  socket.on('setTargetAndPlay', ({ targetRank, cardIds }) => {
    const room = rooms[currentRoomId];
    if (!room || !room.started || room.gameOver) return;
    const me = findPlayerBySocket(room, socket.id);
    if (!me) return;
    if (room.settings.liarsBar) return emitError('Target rank is auto-picked in Liar’s Bar mode.');
    if (room.targetRank !== null) return emitError('Target rank already set.');
    if (room.players[room.currentTurnIdx].id !== me.id) return emitError('Not your turn.');
    if (!RANKS.includes(targetRank)) return emitError('Invalid rank.');
    if (targetRank === 'J') return emitError('Jacks cannot be the target rank - bluff with them instead.');
    if ((room.discardedRanks || []).includes(targetRank)) {
      return emitError(`${targetRank}s have all been discarded — pick another rank.`);
    }
    room.targetRank = targetRank;
    room.playsSinceTargetChange = 0;
    room.log.push(`${room.players[room.currentTurnIdx].name} sets Target Rank to ${targetRank}.`);
    playCards(room, me, cardIds);
  });

  socket.on('playCards', ({ cardIds }) => {
    const room = rooms[currentRoomId];
    if (!room || !room.started || room.gameOver) return;
    const me = findPlayerBySocket(room, socket.id);
    if (!me) return;
    if (room.targetRank === null) return emitError('Target rank not set yet.');
    if (room.players[room.currentTurnIdx].id !== me.id) return emitError('Not your turn.');
    playCards(room, me, cardIds);
  });

  function playCards(room, player, cardIds) {
    if (!player) return;
    if (player.alive === false) return emitError('You are eliminated.');
    const max = clampInt(room.settings.maxCards, 1, 3);
    if (!Array.isArray(cardIds) || cardIds.length < 1 || cardIds.length > max) {
      return emitError(`Play 1 to ${max} card${max === 1 ? '' : 's'}.`);
    }
    const ids = new Set(cardIds);
    const playedCards = [];
    for (const cid of cardIds) {
      const card = player.hand.find(c => c.id === cid);
      if (!card) return emitError('Card not in your hand.');
      playedCards.push(card);
    }
    player.hand = player.hand.filter(c => !ids.has(c.id));
    room.pile.push(...playedCards);
    room.lastPlayedCards = playedCards;
    room.lastPlayCount = playedCards.length;
    room.lastPlayerId = player.id;
    room.log.push(`${player.name} plays ${playedCards.length} card(s) claiming ${room.targetRank}.`);
    if (!room.settings.liarsBar && player.hand.length === 0) {
      room.log.push(`${player.name} emptied their hand and wins! Play continues without them (they can still be called LIAR on this play).`);
    }
    const nextIdx = findNextActiveIdx(room, room.currentTurnIdx);
    room.currentTurnIdx = nextIdx;
    room.canChallengeId = room.players[nextIdx].id;

    // Rotating Target: tick the per-target counter; when it hits N, rotate
    // immediately so the cards just played become unchallengeable.
    if (room.settings.rotateTargetEvery > 0) {
      room.playsSinceTargetChange = (room.playsSinceTargetChange || 0) + 1;
      if (room.playsSinceTargetChange >= room.settings.rotateTargetEvery) {
        rotateTarget(room, `every ${room.settings.rotateTargetEvery} plays`);
      }
    }

    if (checkInstantLoss(room)) { broadcast(room); return; }
    checkLastPlayerStanding(room);
    broadcast(room);
  }

  socket.on('callLiar', () => {
    const room = rooms[currentRoomId];
    if (!room || !room.started || room.gameOver) return;
    const challenger = findPlayerBySocket(room, socket.id);
    if (!challenger) return;
    if (room.canChallengeId !== challenger.id) return emitError('You cannot challenge right now.');
    if (room.lastPlayedCards.length === 0) return emitError('Nothing to challenge.');
    const lastPlayer = room.players.find(p => p.id === room.lastPlayerId);
    const lastCards = room.lastPlayedCards;
    const wildSuit = room.actualWildSuit;
    const wasLie = lastCards.some(c =>
      c.rank !== room.targetRank &&
      c.rank !== 'JOKER' &&
      (!wildSuit || c.suit !== wildSuit)
    );

    io.to(room.id).emit('reveal', {
      cards: lastCards,
      claimed: room.targetRank,
      wasLie,
      challengerName: challenger.name,
      lastPlayerName: lastPlayer.name
    });

    if (room.settings.liarsBar) {
      const loser = wasLie ? lastPlayer : challenger;
      const winner = wasLie ? challenger : lastPlayer;
      const result = pullTrigger(loser);
      io.to(room.id).emit('gunPull', {
        playerId: loser.id, playerName: loser.name,
        died: result.died, chambersBefore: result.chambersBefore,
        chambersAfter: result.chambersAfter, prob: result.prob
      });
      if (wasLie) room.log.push(`${challenger.name} called LIAR - ${lastPlayer.name} was lying.`);
      else        room.log.push(`${challenger.name} wrongly accused ${lastPlayer.name}.`);
      if (result.died) {
        room.log.push(`BANG! ${loser.name}'s gun fired (was 1/${result.chambersBefore}). ${loser.name} is eliminated.`);
      } else {
        room.log.push(`*click* ${loser.name} survives (was 1/${result.chambersBefore}; next time 1/${Math.max(1, result.chambersAfter)}).`);
      }
      checkLastPlayerStanding(room);
      if (room.gameOver) { broadcast(room); return; }
      const starter = winner.alive !== false ? winner : room.players.find(p => p.alive !== false);
      startLiarsBarRound(room);
      const startIdx = room.players.findIndex(p => p.id === starter.id);
      room.currentTurnIdx = startIdx >= 0 ? startIdx : 0;
      if (room.settings.shuffleSeats) applyShuffleSeatsPreservingStarter(room, starter.id);
      broadcast(room);
      return;
    }

    let starterId = null;
    if (wasLie) {
      const takenCount = room.pile.length;
      lastPlayer.hand.push(...room.pile);
      lastPlayer.isSkipped = false;
      room.log.push(`${challenger.name} called LIAR - ${lastPlayer.name} was lying and takes the pile (${takenCount} cards).`);
      const challengerIdx = room.players.findIndex(p => p.id === challenger.id);
      clearPile(room);
      room.currentTurnIdx = challengerIdx;
      starterId = challenger.id;
    } else {
      const takenCount = room.pile.length;
      challenger.hand.push(...room.pile);
      const challengerIdx = room.players.findIndex(p => p.id === challenger.id);
      clearPile(room);
      room.currentTurnIdx = findNextActiveIdx(room, challengerIdx);
      starterId = room.players[room.currentTurnIdx].id;
      room.log.push(`${challenger.name} falsely accused ${lastPlayer.name}, takes the pile (${takenCount} cards) and is skipped - ${room.players[room.currentTurnIdx].name} starts the new round.`);
    }
    if (room.settings.shuffleSeats && starterId) {
      applyShuffleSeatsPreservingStarter(room, starterId);
      room.log.push('Seats reshuffled for the next round.');
    }
    if (checkInstantLoss(room)) { broadcast(room); return; }
    checkLastPlayerStanding(room);
    broadcast(room);
  });

  function pullTrigger(player) {
    const before = player.chambers || LIARS_BAR_GUN_CHAMBERS;
    if (before <= 0) {
      player.alive = false;
      return { died: true, chambersBefore: before, chambersAfter: 0, prob: 1 };
    }
    const prob = 1 / before;
    const died = Math.random() < prob;
    const after = Math.max(0, before - 1);
    player.chambers = after;
    if (died) player.alive = false;
    return { died, chambersBefore: before, chambersAfter: after, prob };
  }

  socket.on('discardFourOfKind', ({ rank }) => {
    const room = rooms[currentRoomId];
    if (!room || !room.started || room.gameOver) return;
    if (room.settings.liarsBar) return emitError('Four-of-a-kind discard is disabled in Liar’s Bar mode.');
    if (!RANKS.includes(rank)) return emitError('Invalid rank.');
    if (rank === 'J') return emitError('You cannot discard four Jacks.');
    const player = findPlayerBySocket(room, socket.id);
    if (!player) return;
    const matching = player.hand.filter(c => c.rank === rank);
    if (matching.length !== 4) return emitError('You do not have all 4 of that rank.');
    player.hand = player.hand.filter(c => c.rank !== rank);
    if (!room.discardedRanks.includes(rank)) room.discardedRanks.push(rank);
    room.revealedFour = { playerId: player.id, playerName: player.name, rank, until: Date.now() + FOUR_OF_KIND_MS };
    room.log.push(`${player.name} discards the four ${rank}s - revealed to everyone for 15s. ${rank}s can no longer be called as target.`);
    io.to(room.id).emit('fourOfKindReveal', { playerName: player.name, cards: matching, durationMs: FOUR_OF_KIND_MS });

    // If the current target is the rank just discarded, force a rotation now.
    if (room.targetRank === rank) {
      rotateTarget(room, `${rank}s discarded`);
    }

    broadcast(room);
    setTimeout(() => {
      const r = rooms[room.id];
      if (!r) return;
      r.revealedFour = null;
      checkLastPlayerStanding(r);
      broadcast(r);
    }, FOUR_OF_KIND_MS);
    checkLastPlayerStanding(room);
  });

  socket.on('endGame', () => {
    const room = rooms[currentRoomId];
    if (!room) return;
    const me = findPlayerBySocket(room, socket.id);
    if (!me || room.hostId !== me.id) return emitError('Only the host can end the game.');
    if (!room.started) return;
    room.started = false;
    room.gameOver = false;
    room.statsRecorded = false;
    room.winners = []; room.losers = [];
    room.currentTurnIdx = 0;
    room.revealedFour = null;
    room.players.forEach(p => {
      p.hand = []; p.isSkipped = false; p.alive = true;
      p.chambers = LIARS_BAR_GUN_CHAMBERS;
    });
    clearPile(room);
    room.discardedRanks = [];
    room.actualJokerCount = 0;
    room.actualWildSuit = '';
    room.log.push('Host ended the game. Back to the waiting room.');
    broadcast(room);
  });

  socket.on('playAgain', () => {
    const room = rooms[currentRoomId];
    if (!room) return;
    if (!room.gameOver) return;
    room.started = false;
    room.gameOver = false;
    room.statsRecorded = false;
    room.winners = []; room.losers = [];
    room.currentTurnIdx = 0;
    room.revealedFour = null;
    room.players.forEach(p => {
      p.hand = []; p.isSkipped = false; p.alive = true;
      p.chambers = LIARS_BAR_GUN_CHAMBERS;
    });
    clearPile(room);
    room.discardedRanks = [];
    room.actualJokerCount = 0;
    room.actualWildSuit = '';
    const dropped = room.players.filter(p => !p.connected);
    dropped.forEach(p => {
      if (p.removalTimer) { clearTimeout(p.removalTimer); p.removalTimer = null; }
    });
    room.players = room.players.filter(p => p.connected);
    if (room.players.length === 0) { delete rooms[room.id]; return; }
    if (!room.players.find(p => p.id === room.hostId)) {
      room.hostId = room.players[0].id;
    }
    room.log.push('Returning to the waiting room. Ready for another game!');
    broadcast(room);
  });

  socket.on('kickPlayer', ({ playerId }) => {
    const room = rooms[currentRoomId];
    if (!room) return;
    const me = findPlayerBySocket(room, socket.id);
    if (!me || room.hostId !== me.id) return emitError('Only the host can kick.');
    if (room.started) return emitError('You cannot kick during a game.');
    if (playerId === me.id) return emitError('You cannot kick yourself.');
    const idx = room.players.findIndex(p => p.id === playerId);
    if (idx === -1) return;
    const kicked = room.players[idx];
    room.players.splice(idx, 1);
    if (kicked.removalTimer) { clearTimeout(kicked.removalTimer); kicked.removalTimer = null; }
    room.log.push(`${kicked.name} was kicked by the host.`);
    if (kicked.socketId) {
      const sock = io.sockets.sockets.get(kicked.socketId);
      if (sock) {
        sock.emit('kicked', { reason: 'You were kicked from the room by the host.' });
        sock.leave(room.id);
      }
    }
    broadcast(room);
  });

  socket.on('chat', ({ message }) => {
    const room = rooms[currentRoomId];
    if (!room) return;
    const player = findPlayerBySocket(room, socket.id);
    if (!player) return;
    const msg = String(message || '').slice(0, 200);
    if (!msg.trim()) return;
    io.to(room.id).emit('chat', { name: player.name, message: msg });
  });

  socket.on('leaveRoom', () => {
    const room = rooms[currentRoomId];
    if (!room) return;
    const player = findPlayerBySocket(room, socket.id);
    if (!player) return;
    const wasHost = room.hostId === player.id;
    if (player.removalTimer) { clearTimeout(player.removalTimer); player.removalTimer = null; }
    room.players = room.players.filter(p => p.id !== player.id);
    socket.leave(room.id);
    currentRoomId = null;
    if (room.players.length === 0) { delete rooms[room.id]; return; }
    if (wasHost) {
      const newHost = room.players.find(p => p.connected) || room.players[0];
      room.hostId = newHost.id;
    }
    if (room.started) {
      if (room.currentTurnIdx >= room.players.length) room.currentTurnIdx = 0;
      const stillActive = room.players.some(p => p.connected && p.hand.length > 0);
      if (stillActive) {
        const cur = room.players[room.currentTurnIdx];
        if (!cur || !cur.connected || cur.hand.length === 0) {
          room.currentTurnIdx = findNextActiveIdx(room, room.currentTurnIdx === 0 ? room.players.length - 1 : room.currentTurnIdx - 1);
        }
        room.canChallengeId = room.players[room.currentTurnIdx].id;
      }
      room.log.push(`${player.name} left the game.`);
      checkLastPlayerStanding(room);
    } else {
      room.log.push(`${player.name} left the lobby.`);
    }
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const room = rooms[currentRoomId];
    if (!room) return;
    const player = findPlayerBySocket(room, socket.id);
    if (!player) return;
    player.connected = false;
    player.socketId = null;
    if (!room.started) {
      room.log.push(`${player.name} disconnected (waiting for them to come back...).`);
      if (room.hostId === player.id) {
        const newHost = room.players.find(p => p.connected);
        if (newHost) room.hostId = newHost.id;
      }
      if (player.removalTimer) clearTimeout(player.removalTimer);
      const playerIdSnapshot = player.id;
      const roomIdSnapshot = room.id;
      player.removalTimer = setTimeout(() => {
        const r = rooms[roomIdSnapshot];
        if (!r) return;
        const p = r.players.find(x => x.id === playerIdSnapshot);
        if (!p || p.connected) return;
        r.players = r.players.filter(x => x.id !== playerIdSnapshot);
        r.log.push(`${p.name} did not return - removed from the lobby.`);
        if (r.hostId === playerIdSnapshot && r.players.length > 0) r.hostId = r.players[0].id;
        if (r.players.length === 0) { delete rooms[r.id]; return; }
        broadcast(r);
      }, LOBBY_GRACE_MS);
    } else {
      room.log.push(`${player.name} disconnected - they can rejoin with the room code.`);
      if (room.hostId === player.id) {
        const newHost = room.players.find(p => p.connected);
        if (newHost) room.hostId = newHost.id;
      }
      const myIdx = room.players.findIndex(p => p.id === player.id);
      if (myIdx === room.currentTurnIdx) {
        const wasChallenger = room.canChallengeId === player.id;
        room.currentTurnIdx = findNextActiveIdx(room, room.currentTurnIdx);
        room.canChallengeId = wasChallenger ? room.players[room.currentTurnIdx].id : room.canChallengeId;
      } else if (room.canChallengeId === player.id) {
        const newIdx = findNextActiveIdx(room, myIdx);
        room.canChallengeId = room.players[newIdx].id;
        room.currentTurnIdx = newIdx;
      }
    }
    if (!room.players.some(p => p.connected)) scheduleEmptyRoomCleanup(room);
    broadcast(room);
  });
});

server.listen(PORT, () => {
  console.log(`Lugen server listening on port ${PORT}.${auth.enabled ? ' (Supabase auth' + (auth.oauthEnabled ? ' + Google OAuth' : '') + ' enabled)' : ''}`);
});
