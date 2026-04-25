// server.js — Lügen multiplayer card game backend
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

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

// ---------- Game constants ----------
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUITS = ['H', 'D', 'C', 'S']; // Hearts, Diamonds, Clubs, Spades
const FOUR_OF_KIND_MS = 15000;

// ---------- Helpers ----------
function createDeck() {
  const deck = [];
  for (const r of RANKS) for (const s of SUITS) deck.push({ rank: r, suit: s, id: r + s });
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Distribute the entire deck as evenly as possible to all players (2..8)
function dealCards(deck, numPlayers) {
  const hands = Array.from({ length: numPlayers }, () => []);
  for (let i = 0; i < deck.length; i++) hands[i % numPlayers].push(deck[i]);
  return hands;
}

function makeRoomId() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 5; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// ---------- Room state ----------
const rooms = {}; // roomId -> Room

function newRoom(id) {
  return {
    id,
    players: [],          // { id, socketId, name, hand, connected, isSkipped }
    pile: [],
    lastPlayedCards: [],  // server-only knowledge of what's on top
    lastPlayCount: 0,
    lastPlayerId: null,
    canChallengeId: null,
    currentTurnIdx: 0,
    targetRank: null,
    started: false,
    log: [],
    revealedFour: null,   // { playerId, rank, until }
    gameOver: false,
    winners: [],
    loser: null,
    hostId: null
  };
}

function publicState(room) {
  return {
    id: room.id,
    hostId: room.hostId,
    players: room.players.map((p, idx) => ({
      id: p.id,
      name: p.name,
      cardCount: p.hand.length,
      isSkipped: !!p.isSkipped,
      connected: !!p.connected,
      seatNumber: room.started ? idx + 1 : null
    })),
    started: room.started,
    currentTurnIdx: room.currentTurnIdx,
    targetRank: room.targetRank,
    pileSize: room.pile.length,
    lastPlayCount: room.lastPlayCount,
    lastPlayerId: room.lastPlayerId,
    canChallengeId: room.canChallengeId,
    revealedFour: room.revealedFour,
    gameOver: room.gameOver,
    winners: room.winners,
    loser: room.loser,
    log: room.log.slice(-30)
  };
}

function broadcast(room) {
  io.to(room.id).emit('roomState', publicState(room));
  for (const p of room.players) io.to(p.socketId).emit('hand', p.hand);
}

function nextPlayerIdx(room, fromIdx) {
  return (fromIdx + 1) % room.players.length;
}

// Instant loss if any player holds all 4 Jacks
function checkInstantLoss(room) {
  for (const p of room.players) {
    if (p.hand.filter(c => c.rank === 'J').length === 4) {
      room.gameOver = true;
      room.loser = p.id;
      room.winners = room.players.filter(x => x.id !== p.id).map(x => x.id);
      room.log.push(`💥 ${p.name} holds all 4 Jacks — instant loss!`);
      return true;
    }
  }
  return false;
}

// Game ends when only one player still has cards
function checkLastPlayerStanding(room) {
  if (room.gameOver) return;
  const withCards = room.players.filter(p => p.hand.length > 0);
  if (withCards.length === 1 && room.players.length > 1) {
    room.gameOver = true;
    room.loser = withCards[0].id;
    room.winners = room.players.filter(p => p.hand.length === 0).map(p => p.id);
    room.log.push(`🏁 ${withCards[0].name} is left with cards and loses the game.`);
  }
}

function clearPile(room) {
  room.pile = [];
  room.lastPlayedCards = [];
  room.lastPlayCount = 0;
  room.lastPlayerId = null;
  room.canChallengeId = null;
  room.targetRank = null;
}

// ---------- Socket handlers ----------
io.on('connection', (socket) => {
  let currentRoomId = null;

  function emitError(message) { socket.emit('errorMsg', { message }); }

  socket.on('createRoom', ({ name }) => {
    const roomId = makeRoomId();
    const room = newRoom(roomId);
    rooms[roomId] = room;
    addPlayer(room, socket, name);
    room.hostId = socket.id;
    currentRoomId = roomId;
    socket.emit('joined', { roomId, playerId: socket.id });
    broadcast(room);
  });

  socket.on('joinRoom', ({ roomId, name }) => {
    const room = rooms[(roomId || '').toUpperCase()];
    if (!room) return emitError('Room not found.');
    if (room.started) return emitError('Game already started.');
    if (room.players.length >= 8) return emitError('Room is full (8 max).');
    addPlayer(room, socket, name);
    currentRoomId = room.id;
    socket.emit('joined', { roomId: room.id, playerId: socket.id });
    broadcast(room);
  });

  function addPlayer(room, sock, name) {
    const player = {
      id: sock.id,
      socketId: sock.id,
      name: (name || '').trim().slice(0, 20) || `Player${room.players.length + 1}`,
      hand: [],
      connected: true,
      isSkipped: false
    };
    room.players.push(player);
    sock.join(room.id);
  }

  socket.on('startGame', () => {
    const room = rooms[currentRoomId];
    if (!room) return;
    if (room.hostId !== socket.id) return emitError('Only the host can start.');
    if (room.players.length < 2) return emitError('Need at least 2 players.');
    if (room.started) return;
    // Randomize seating order: each player gets a unique number 1..N, #1 starts.
    shuffle(room.players);
    const deck = shuffle(createDeck());
    const hands = dealCards(deck, room.players.length);
    room.players.forEach((p, i) => { p.hand = hands[i]; p.isSkipped = false; });
    room.started = true;
    room.currentTurnIdx = 0;
    room.targetRank = null;
    clearPile(room);
    const seating = room.players.map((p, i) => `#${i + 1} ${p.name}`).join(', ');
    room.log.push(`Game started — seating: ${seating}.`);
    room.log.push(`#1 ${room.players[0].name} chooses the first Target Rank and starts.`);
    if (checkInstantLoss(room)) { broadcast(room); return; }
    broadcast(room);
  });

  // Used when starting a fresh round and target is null
  socket.on('setTargetAndPlay', ({ targetRank, cardIds }) => {
    const room = rooms[currentRoomId];
    if (!room || !room.started || room.gameOver) return;
    if (room.targetRank !== null) return emitError('Target rank already set.');
    if (room.players[room.currentTurnIdx].id !== socket.id) return emitError('Not your turn.');
    if (!RANKS.includes(targetRank)) return emitError('Invalid rank.');
    room.targetRank = targetRank;
    room.log.push(`🎯 ${room.players[room.currentTurnIdx].name} sets Target Rank to ${targetRank}.`);
    playCards(room, socket, cardIds);
  });

  socket.on('playCards', ({ cardIds }) => {
    const room = rooms[currentRoomId];
    if (!room || !room.started || room.gameOver) return;
    if (room.targetRank === null) return emitError('Target rank not set yet.');
    if (room.players[room.currentTurnIdx].id !== socket.id) return emitError('Not your turn.');
    playCards(room, socket, cardIds);
  });

  function playCards(room, sock, cardIds) {
    const player = room.players.find(p => p.id === sock.id);
    if (!player) return;
    if (!Array.isArray(cardIds) || cardIds.length < 1 || cardIds.length > 3) {
      return emitError('Play 1 to 3 cards.');
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

    // Advance turn (with skip)
    let nextIdx = nextPlayerIdx(room, room.currentTurnIdx);
    if (room.players[nextIdx].isSkipped) {
      room.players[nextIdx].isSkipped = false;
      room.log.push(`${room.players[nextIdx].name} is skipped this turn.`);
      nextIdx = nextPlayerIdx(room, nextIdx);
    }
    room.currentTurnIdx = nextIdx;
    room.canChallengeId = room.players[nextIdx].id;

    if (checkInstantLoss(room)) { broadcast(room); return; }
    checkLastPlayerStanding(room);
    broadcast(room);
  }

  socket.on('callLiar', () => {
    const room = rooms[currentRoomId];
    if (!room || !room.started || room.gameOver) return;
    if (room.canChallengeId !== socket.id) return emitError('You cannot challenge right now.');
    if (room.lastPlayedCards.length === 0) return emitError('Nothing to challenge.');

    const challenger = room.players.find(p => p.id === socket.id);
    const lastPlayer = room.players.find(p => p.id === room.lastPlayerId);
    const lastCards = room.lastPlayedCards;
    // Any non-target card (including Jacks if Jack is not the target) is a lie
    const wasLie = lastCards.some(c => c.rank !== room.targetRank);

    // Reveal cards to all clients briefly
    io.to(room.id).emit('reveal', {
      cards: lastCards,
      claimed: room.targetRank,
      wasLie,
      challengerName: challenger.name,
      lastPlayerName: lastPlayer.name
    });

    if (wasLie) {
      lastPlayer.hand.push(...room.pile);
      // Defensive: make sure no stale skip flag is hanging on the liar
      lastPlayer.isSkipped = false;
      room.log.push(`🚨 ${challenger.name} called LIAR — ${lastPlayer.name} was lying and takes the pile (${room.pile.length} cards).`);
      const challengerIdx = room.players.findIndex(p => p.id === challenger.id);
      clearPile(room);
      room.currentTurnIdx = challengerIdx;
    } else {
      const takenCount = room.pile.length;
      challenger.hand.push(...room.pile);
      // The skip is implemented by moving the round start past them — do NOT
      // also set isSkipped, otherwise they'd get skipped a second time when
      // the turn cycles back to them.
      const challengerIdx = room.players.findIndex(p => p.id === challenger.id);
      clearPile(room);
      room.currentTurnIdx = nextPlayerIdx(room, challengerIdx);
      room.log.push(`❌ ${challenger.name} falsely accused ${lastPlayer.name}, takes the pile (${takenCount} cards) and is skipped — ${room.players[room.currentTurnIdx].name} starts the new round.`);
    }

    if (checkInstantLoss(room)) { broadcast(room); return; }
    checkLastPlayerStanding(room);
    broadcast(room);
  });

  socket.on('discardFourOfKind', ({ rank }) => {
    const room = rooms[currentRoomId];
    if (!room || !room.started || room.gameOver) return;
    if (!RANKS.includes(rank)) return emitError('Invalid rank.');
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    const matching = player.hand.filter(c => c.rank === rank);
    if (matching.length !== 4) return emitError('You do not have all 4 of that rank.');
    player.hand = player.hand.filter(c => c.rank !== rank);
    room.revealedFour = { playerId: player.id, playerName: player.name, rank, until: Date.now() + FOUR_OF_KIND_MS };
    room.log.push(`✨ ${player.name} discards the four ${rank}s — revealed to everyone for 15s.`);
    io.to(room.id).emit('fourOfKindReveal', { playerName: player.name, cards: matching, durationMs: FOUR_OF_KIND_MS });
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
    if (room.hostId !== socket.id) return emitError('Only the host can end the game.');
    if (!room.started) return;
    // Reset back to waiting-room state, keep players
    room.started = false;
    room.gameOver = false;
    room.winners = [];
    room.loser = null;
    room.currentTurnIdx = 0;
    room.revealedFour = null;
    room.players.forEach(p => { p.hand = []; p.isSkipped = false; });
    clearPile(room);
    room.log.push('🛑 Host ended the game. Back to the waiting room.');
    broadcast(room);
  });

  socket.on('chat', ({ message }) => {
    const room = rooms[currentRoomId];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    const msg = String(message || '').slice(0, 200);
    if (!msg.trim()) return;
    io.to(room.id).emit('chat', { name: player.name, message: msg });
  });

  socket.on('disconnect', () => {
    const room = rooms[currentRoomId];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    player.connected = false;
    if (!room.started) {
      // Just remove if game hasn't started
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.hostId === socket.id && room.players.length > 0) {
        room.hostId = room.players[0].id;
      }
      if (room.players.length === 0) { delete rooms[room.id]; return; }
      room.log.push(`${player.name} left the lobby.`);
    } else {
      room.log.push(`${player.name} disconnected.`);
    }
    broadcast(room);
  });
});

server.listen(PORT, () => {
  console.log(`Lugen server listening on port ${PORT}`);
});
ms[room.id]; return; }
      room.log.push(`${player.name} left the lobby.`);
    } else {
      room.log.push(`${player.name} disconnected.`);
    }
    broadcast(room);
  });
});

server.listen(PORT, () => {
  console.log(`Lugen server listening on port ${PORT}`);
});
 {
        room.hostId = room.players[0].id;
      }
      if (room.players.length === 0) { delete rooms[room.id]; return; }
      room.log.push(`${player.name} left the lobby.`);
    } else {
      room.log.push(`${player.name} disconnected.`);
    }
    broadcast(room);
  });
});

server.listen(PORT, () => {
  console.log(`Lugen server listening on port ${PORT}`);
});
