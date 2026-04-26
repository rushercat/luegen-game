// server.js - Lugen multiplayer card game backend
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
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
const SUITS = ['H', 'D', 'C', 'S'];
const FOUR_OF_KIND_MS = 15000;

// How long a disconnected lobby player is kept around so a quick refresh works.
const LOBBY_GRACE_MS = 60 * 1000;
// How long we keep a fully-empty room around (in case everyone reconnects).
const EMPTY_ROOM_GRACE_MS = 5 * 60 * 1000;

// ---------- Helpers ----------
function newPlayerId() {
  return crypto.randomBytes(8).toString('hex');
}

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
const rooms = {};

function newRoom(id) {
  return {
    id,
    players: [],
    pile: [],
    lastPlayedCards: [],
    lastPlayCount: 0,
    lastPlayerId: null,
    canChallengeId: null,
    currentTurnIdx: 0,
    targetRank: null,
    started: false,
    log: [],
    revealedFour: null,
    gameOver: false,
    winners: [],
    losers: [],
    hostId: null,
    emptyTimer: null
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
    losers: room.losers,
    log: room.log.slice(-30)
  };
}

function broadcast(room) {
  io.to(room.id).emit('roomState', publicState(room));
  for (const p of room.players) {
    if (p.socketId) io.to(p.socketId).emit('hand', p.hand);
  }
}

function nextPlayerIdx(room, fromIdx) {
  return (fromIdx + 1) % room.players.length;
}

// Walk forward from fromIdx, skipping disconnected players silently and
// consuming isSkipped flags (with a log line). Returns the next active idx,
// or fromIdx if no one else is active (safety fallback).
function findNextActiveIdx(room, fromIdx) {
  let idx = fromIdx;
  for (let i = 0; i < room.players.length + 1; i++) {
    idx = (idx + 1) % room.players.length;
    const p = room.players[idx];
    if (!p.connected) continue;
    if (p.hand.length === 0) continue; // already finished — sitting out as a winner
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
  const withCards = room.players.filter(p => p.hand.length > 0);
  const totalPlayers = room.players.length;
  // For 2-player games: classic rule — last with cards loses (1 left).
  // For 3+ player games: game ends as soon as only 2 are left holding cards;
  // BOTH of those two are losers, everyone who emptied is a winner.
  const losingThreshold = totalPlayers >= 3 ? 2 : 1;
  if (totalPlayers > 1 && withCards.length > 0 && withCards.length <= losingThreshold) {
    room.gameOver = true;
    room.losers = withCards.map(p => p.id);
    room.winners = room.players.filter(p => p.hand.length === 0).map(p => p.id);
    if (withCards.length === 1) {
      room.log.push(`${withCards[0].name} is left with cards and loses the game.`);
    } else {
      const names = withCards.map(p => p.name).join(' and ');
      room.log.push(`Only ${names} are left with cards — both lose!`);
    }
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

function findPlayerBySocket(room, socketId) {
  return room.players.find(p => p.socketId === socketId);
}

// Schedule deletion of a room that has no connected players. Cancels any prior
// timer when called, so reconnection during the grace period keeps the room alive.
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
  if (room.emptyTimer) {
    clearTimeout(room.emptyTimer);
    room.emptyTimer = null;
  }
}

// ---------- Socket handlers ----------
io.on('connection', (socket) => {
  let currentRoomId = null;

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
    if (room.started) return emitError('Game already started. (If you were in this room before, click "Reconnect to last room".)');
    if (room.players.length >= 8) return emitError('Room is full (8 max).');
    const player = addPlayer(room, socket, name);
    currentRoomId = room.id;
    socket.emit('joined', { roomId: room.id, playerId: player.id });
    broadcast(room);
  });

  // Reconnect to an existing seat after a disconnect / refresh / network blip.
  // Identity is the (roomId, playerId) pair issued when the player first joined.
  socket.on('resumeSession', ({ roomId, playerId }) => {
    const room = rooms[(roomId || '').toUpperCase()];
    if (!room) return socket.emit('reconnectFailed', { reason: 'Room no longer exists.' });
    const player = room.players.find(p => p.id === playerId);
    if (!player) return socket.emit('reconnectFailed', { reason: 'You are no longer in that room.' });

    // Cancel any pending lobby-grace removal timer for this player.
    if (player.removalTimer) {
      clearTimeout(player.removalTimer);
      player.removalTimer = null;
    }
    cancelEmptyRoomCleanup(room);

    const wasOffline = !player.connected;
    player.socketId = socket.id;
    player.connected = true;
    socket.join(room.id);
    currentRoomId = room.id;

    if (wasOffline) {
      room.log.push(`${player.name} reconnected.`);
    }

    socket.emit('joined', { roomId: room.id, playerId: player.id });
    broadcast(room);
  });

  function addPlayer(room, sock, name) {
    const player = {
      id: newPlayerId(),  // stable, survives socket reconnects
      socketId: sock.id,  // current live socket
      name: (name || '').trim().slice(0, 20) || `Player${room.players.length + 1}`,
      hand: [],
      connected: true,
      isSkipped: false,
      removalTimer: null
    };
    room.players.push(player);
    sock.join(room.id);
    cancelEmptyRoomCleanup(room);
    return player;
  }

  socket.on('startGame', () => {
    const room = rooms[currentRoomId];
    if (!room) return;
    const me = findPlayerBySocket(room, socket.id);
    if (!me || room.hostId !== me.id) return emitError('Only the host can start.');
    if (room.players.length < 2) return emitError('Need at least 2 players.');
    if (room.started) return;
    shuffle(room.players);
    const deck = shuffle(createDeck());
    const hands = dealCards(deck, room.players.length);
    room.players.forEach((p, i) => { p.hand = hands[i]; p.isSkipped = false; });
    room.started = true;
    room.currentTurnIdx = 0;
    room.targetRank = null;
    clearPile(room);
    const seating = room.players.map((p, i) => `#${i + 1} ${p.name}`).join(', ');
    room.log.push(`Game started - seating: ${seating}.`);
    room.log.push(`#1 ${room.players[0].name} chooses the first Target Rank and starts.`);
    if (checkInstantLoss(room)) { broadcast(room); return; }
    broadcast(room);
  });

  socket.on('setTargetAndPlay', ({ targetRank, cardIds }) => {
    const room = rooms[currentRoomId];
    if (!room || !room.started || room.gameOver) return;
    const me = findPlayerBySocket(room, socket.id);
    if (!me) return;
    if (room.targetRank !== null) return emitError('Target rank already set.');
    if (room.players[room.currentTurnIdx].id !== me.id) return emitError('Not your turn.');
    if (!RANKS.includes(targetRank)) return emitError('Invalid rank.');
    if (targetRank === 'J') return emitError('Jacks cannot be the target rank - bluff with them instead.');
    room.targetRank = targetRank;
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
    if (player.hand.length === 0) {
      room.log.push(`🏆 ${player.name} emptied their hand and wins! Play continues without them (they can still be called LIAR on this play).`);
    }

    const nextIdx = findNextActiveIdx(room, room.currentTurnIdx);
    room.currentTurnIdx = nextIdx;
    room.canChallengeId = room.players[nextIdx].id;

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
    const wasLie = lastCards.some(c => c.rank !== room.targetRank);

    io.to(room.id).emit('reveal', {
      cards: lastCards,
      claimed: room.targetRank,
      wasLie,
      challengerName: challenger.name,
      lastPlayerName: lastPlayer.name
    });

    if (wasLie) {
      const takenCount = room.pile.length;
      lastPlayer.hand.push(...room.pile);
      lastPlayer.isSkipped = false;
      room.log.push(`${challenger.name} called LIAR - ${lastPlayer.name} was lying and takes the pile (${takenCount} cards).`);
      const challengerIdx = room.players.findIndex(p => p.id === challenger.id);
      clearPile(room);
      room.currentTurnIdx = challengerIdx;
    } else {
      const takenCount = room.pile.length;
      challenger.hand.push(...room.pile);
      const challengerIdx = room.players.findIndex(p => p.id === challenger.id);
      clearPile(room);
      room.currentTurnIdx = findNextActiveIdx(room, challengerIdx);
      room.log.push(`${challenger.name} falsely accused ${lastPlayer.name}, takes the pile (${takenCount} cards) and is skipped - ${room.players[room.currentTurnIdx].name} starts the new round.`);
    }

    if (checkInstantLoss(room)) { broadcast(room); return; }
    checkLastPlayerStanding(room);
    broadcast(room);
  });

  socket.on('discardFourOfKind', ({ rank }) => {
    const room = rooms[currentRoomId];
    if (!room || !room.started || room.gameOver) return;
    if (!RANKS.includes(rank)) return emitError('Invalid rank.');
    if (rank === 'J') return emitError('You cannot discard four Jacks.');
    const player = findPlayerBySocket(room, socket.id);
    if (!player) return;
    const matching = player.hand.filter(c => c.rank === rank);
    if (matching.length !== 4) return emitError('You do not have all 4 of that rank.');
    player.hand = player.hand.filter(c => c.rank !== rank);
    room.revealedFour = { playerId: player.id, playerName: player.name, rank, until: Date.now() + FOUR_OF_KIND_MS };
    room.log.push(`${player.name} discards the four ${rank}s - revealed to everyone for 15s.`);
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
    const me = findPlayerBySocket(room, socket.id);
    if (!me || room.hostId !== me.id) return emitError('Only the host can end the game.');
    if (!room.started) return;
    room.started = false;
    room.gameOver = false;
    room.winners = [];
    room.losers = [];
    room.currentTurnIdx = 0;
    room.revealedFour = null;
    room.players.forEach(p => { p.hand = []; p.isSkipped = false; });
    clearPile(room);
    room.log.push('Host ended the game. Back to the waiting room.');
    broadcast(room);
  });

  socket.on('playAgain', () => {
    const room = rooms[currentRoomId];
    if (!room) return;
    if (!room.gameOver) return; // only resets when the game has finished
    room.started = false;
    room.gameOver = false;
    room.winners = [];
    room.losers = [];
    room.currentTurnIdx = 0;
    room.revealedFour = null;
    room.players.forEach(p => { p.hand = []; p.isSkipped = false; });
    clearPile(room);
    // Drop disconnected players - they didn't come back for a rematch.
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

  // Explicit "Leave Room" — different from a network drop. Removes the seat
  // entirely so the player can't auto-reconnect into it later.
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
    if (room.players.length === 0) {
      delete rooms[room.id];
      return;
    }
    if (wasHost) {
      const newHost = room.players.find(p => p.connected) || room.players[0];
      room.hostId = newHost.id;
    }
    if (room.started) {
      // Mid-game leave: rebalance turn / challenge pointers similar to disconnect.
      if (room.currentTurnIdx >= room.players.length) room.currentTurnIdx = 0;
      // Indices may have shifted; keep things sane.
      const stillActive = room.players.some(p => p.connected && p.hand.length > 0);
      if (stillActive) {
        // If the leaver was up, advance to the next active.
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
      // Lobby grace period: keep the seat for a minute so refresh / blip can rejoin.
      // After the timer fires, drop them if they haven't reconnected.
      room.log.push(`${player.name} disconnected (waiting for them to come back…).`);
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
        if (!p || p.connected) return;  // they came back — don't remove
        r.players = r.players.filter(x => x.id !== playerIdSnapshot);
        r.log.push(`${p.name} did not return — removed from the lobby.`);
        if (r.hostId === playerIdSnapshot && r.players.length > 0) {
          r.hostId = r.players[0].id;
        }
        if (r.players.length === 0) {
          delete rooms[r.id];
          return;
        }
        broadcast(r);
      }, LOBBY_GRACE_MS);
    } else {
      room.log.push(`${player.name} disconnected — they can rejoin with the room code.`);
      // Pass the host crown if the host dropped, so the game can be ended/restarted.
      if (room.hostId === player.id) {
        const newHost = room.players.find(p => p.connected);
        if (newHost) room.hostId = newHost.id;
      }
      // If the disconnect victim was the player whose turn it is, skip them.
      const myIdx = room.players.findIndex(p => p.id === player.id);
      if (myIdx === room.currentTurnIdx) {
        const wasChallenger = room.canChallengeId === player.id;
        room.currentTurnIdx = findNextActiveIdx(room, room.currentTurnIdx);
        room.canChallengeId = wasChallenger ? room.players[room.currentTurnIdx].id : room.canChallengeId;
      } else if (room.canChallengeId === player.id) {
        // Challenger dropped without acting - pass challenge rights to the next active player.
        const newIdx = findNextActiveIdx(room, myIdx);
        room.canChallengeId = room.players[newIdx].id;
        room.currentTurnIdx = newIdx;
      }
    }

    // If everyone is offline, schedule the room itself for cleanup after a longer grace.
    if (!room.players.some(p => p.connected)) {
      scheduleEmptyRoomCleanup(room);
    }

    broadcast(room);
  });
});

server.listen(PORT, () => {
  console.log(`Lugen server listening on port ${PORT}`);
});
