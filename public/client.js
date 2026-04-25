// client.js — Lügen frontend
const socket = io();

const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUIT_SYMBOLS = { H: '♥', D: '♦', C: '♣', S: '♠' };
const SUIT_COLORS  = { H: 'text-red-600', D: 'text-red-600', C: 'text-black', S: 'text-black' };

let myId = null;
let myHand = [];
let selectedCards = new Set();
let roomState = null;

const $ = (id) => document.getElementById(id);

// ---------- Lobby actions ----------
$('createBtn').onclick = () => {
  const name = $('playerName').value.trim() || 'Player';
  socket.emit('createRoom', { name });
};
$('joinBtn').onclick = () => {
  const name = $('playerName').value.trim() || 'Player';
  const roomId = $('roomCodeInput').value.trim().toUpperCase();
  if (!roomId) { showError('Enter a room code'); return; }
  socket.emit('joinRoom', { roomId, name });
};
$('roomCodeInput').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });
$('startBtn').onclick = () => socket.emit('startGame');

function showError(msg) {
  $('errorMsg').textContent = msg;
  setTimeout(() => { if ($('errorMsg').textContent === msg) $('errorMsg').textContent = ''; }, 4000);
}

// ---------- Socket events ----------
socket.on('joined', ({ roomId, playerId }) => {
  myId = playerId;
  $('lobby').classList.add('hidden');
  $('waitingRoom').classList.remove('hidden');
  $('settingsContainer').classList.remove('hidden');
  $('roomCode').textContent = roomId;
});

socket.on('errorMsg', ({ message }) => showError(message));

socket.on('roomState', (state) => {
  roomState = state;
  if (!state.started) {
    $('waitingRoom').classList.remove('hidden');
    $('game').classList.add('hidden');
    renderWaitingRoom(state);
  } else {
    $('waitingRoom').classList.add('hidden');
    $('game').classList.remove('hidden');
    renderGame(state);
  }
  if (state.gameOver) showGameOver(state);
  else $('gameOver').classList.add('hidden');
  // Show "End Game" only to the host while a game is in progress
  $('endGameBtn').classList.toggle('hidden', !(state.started && state.hostId === myId && !state.gameOver));
});

socket.on('hand', (hand) => {
  myHand = hand;
  // Drop selections that are no longer in hand
  selectedCards = new Set([...selectedCards].filter(id => hand.some(c => c.id === id)));
  renderHand();
});

socket.on('reveal', ({ cards, claimed, wasLie, challengerName, lastPlayerName }) => {
  const rev = $('revealArea');
  const verdict = wasLie
    ? `🚨 LIE! ${challengerName} called ${lastPlayerName} out — claimed ${claimed}`
    : `✅ TRUTH! ${lastPlayerName} actually had ${claimed}s`;
  rev.innerHTML = `<div class="w-full text-center mb-2 font-bold ${wasLie ? 'text-red-300' : 'text-green-300'}">${verdict}</div>`;
  cards.forEach(c => rev.appendChild(makeCardDiv(c, false, false)));
  setTimeout(() => { if (rev.firstChild && rev.textContent.includes(claimed)) rev.innerHTML = ''; }, 4000);
});

socket.on('fourOfKindReveal', ({ playerName, cards, durationMs }) => {
  const rev = $('revealArea');
  rev.innerHTML = `<div class="w-full text-center mb-2 font-bold text-amber-300">✨ ${playerName} discards four ${cards[0].rank}s!</div>`;
  cards.forEach(c => rev.appendChild(makeCardDiv(c, false, false)));
  const td = document.createElement('div');
  td.className = 'w-full text-center mt-2 text-yellow-300 font-mono';
  rev.appendChild(td);
  let secs = Math.ceil(durationMs / 1000);
  td.textContent = secs + 's';
  const timer = setInterval(() => {
    secs--;
    if (secs <= 0) { clearInterval(timer); td.textContent = ''; rev.innerHTML = ''; }
    else td.textContent = secs + 's';
  }, 1000);
});

socket.on('chat', ({ name, message }) => {
  const div = document.createElement('div');
  div.innerHTML = `<b class="text-yellow-300">${escapeHtml(name)}:</b> ${escapeHtml(message)}`;
  $('chat').appendChild(div);
  $('chat').scrollTop = $('chat').scrollHeight;
});

$('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.value.trim()) {
    socket.emit('chat', { message: e.target.value.trim() });
    e.target.value = '';
  }
});

// ---------- Renderers ----------
function renderWaitingRoom(state) {
  const list = $('playerList');
  list.innerHTML = '';
  state.players.forEach(p => {
    const div = document.createElement('div');
    div.className = 'flex justify-between items-center px-3 py-2 rounded bg-white/5';
    div.innerHTML = `
      <span>${escapeHtml(p.name)}${p.id === myId ? ' <span class="text-emerald-300">(you)</span>' : ''}${p.id === state.hostId ? ' 👑' : ''}</span>
      <span class="text-xs text-emerald-200">${p.connected ? 'online' : 'offline'}</span>`;
    list.appendChild(div);
  });
  const isHost = state.hostId === myId;
  const enough = state.players.length >= 2;
  $('startBtn').disabled = !isHost || !enough;
  $('hostHint').textContent = isHost
    ? (enough ? '' : 'Waiting for at least 2 players…')
    : 'Waiting for the host to start the game…';
}

function renderGame(state) {
  // --- All players at the top, sorted by seat number, including yourself ---
  const opp = $('opponents');
  opp.innerHTML = '';
  state.players.forEach((p, idx) => {
    const isCurrent = idx === state.currentTurnIdx;
    const canChallenge = p.id === state.canChallengeId;
    const isMe = p.id === myId;
    const div = document.createElement('div');
    const borderCls = isCurrent
      ? 'border-yellow-400 ring-2 ring-yellow-400'
      : isMe ? 'border-emerald-400' : 'border-white/10';
    div.className = `relative bg-black/40 p-3 rounded-xl text-center min-w-[110px] border ${borderCls}`;
    div.innerHTML = `
      ${p.seatNumber ? `<div class="absolute -top-2 -left-2 bg-yellow-400 text-black w-7 h-7 rounded-full flex items-center justify-center font-extrabold text-sm shadow">${p.seatNumber}</div>` : ''}
      ${isMe ? '<div class="absolute -top-2 -right-2 bg-emerald-400 text-black px-2 py-0.5 rounded-full text-[10px] font-extrabold shadow">YOU</div>' : ''}
      <div class="font-bold truncate">${escapeHtml(p.name)}${p.isSkipped ? ' ⏭' : ''}</div>
      <div class="text-3xl my-1">${isMe ? '🃏' : '🂠'}</div>
      <div class="text-sm">${p.cardCount} card${p.cardCount === 1 ? '' : 's'}</div>
      ${canChallenge ? '<div class="text-[10px] mt-1 text-red-300">may challenge</div>' : ''}
      ${!p.connected ? '<div class="text-[10px] text-gray-400">disconnected</div>' : ''}
    `;
    opp.appendChild(div);
  });
  // Own seat badge above the hand (kept as a redundant cue)
  const me = state.players.find(p => p.id === myId);
  const mySeat = $('mySeat');
  if (mySeat) mySeat.textContent = me && me.seatNumber ? `You are #${me.seatNumber}` : '';

  // --- Center ---
  $('targetRank').textContent = state.targetRank || '—';
  $('pileSize').textContent = state.pileSize;
  if (state.lastPlayCount > 0) {
    const lp = state.players.find(p => p.id === state.lastPlayerId);
    $('lastPlayInfo').textContent = `${lp ? lp.name : 'Someone'} just played ${state.lastPlayCount} card(s).`;
  } else {
    $('lastPlayInfo').textContent = state.targetRank ? '' : 'Waiting for the round-starter to choose a Target Rank.';
  }

  // --- Turn indicator ---
  const cur = state.players[state.currentTurnIdx];
  if (cur) $('turnIndicator').textContent = cur.id === myId ? 'YOUR TURN' : `${cur.name}'s turn`;

  // --- Action area: rank picker (round-starter) vs. Play button (target locked) ---
  const isMyTurn = cur && cur.id === myId;
  const rankPicker = $('rankPicker');
  const playBtn = $('playBtn');
  const validSelection = selectedCards.size >= 1 && selectedCards.size <= 3;

  if (isMyTurn && state.targetRank === null) {
    // Round starter: show rank buttons. Picking a rank both declares and plays.
    rankPicker.classList.remove('hidden');
    playBtn.classList.add('hidden');
    const rb = $('rankButtons');
    if (rb.children.length === 0) {
      RANKS.forEach(r => {
        const btn = document.createElement('button');
        btn.className = 'bg-white/10 hover:bg-yellow-400 hover:text-black border border-white/20 px-3 py-2 rounded font-bold transition disabled:opacity-30 disabled:cursor-not-allowed min-w-[44px]';
        btn.textContent = r;
        btn.dataset.rank = r;
        btn.onclick = () => playAsRank(r);
        rb.appendChild(btn);
      });
    }
    [...rb.children].forEach(b => b.disabled = !validSelection);
  } else if (isMyTurn && state.targetRank !== null) {
    // Target locked: one Play button labeled with the locked rank
    rankPicker.classList.add('hidden');
    playBtn.classList.remove('hidden');
    playBtn.textContent = `Play as ${state.targetRank}${state.targetRank === 'A' ? '' : 's'}`;
    playBtn.disabled = !validSelection;
  } else {
    rankPicker.classList.add('hidden');
    playBtn.classList.add('hidden');
  }

  $('liarBtn').disabled = state.canChallengeId !== myId;

  // --- Log ---
  $('log').innerHTML = state.log.map(l => `<div>${escapeHtml(l)}</div>`).join('');
  $('log').scrollTop = $('log').scrollHeight;
}

function renderHand() {
  const handDiv = $('hand');
  handDiv.innerHTML = '';
  const sorted = [...myHand].sort((a, b) => {
    const r = RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank);
    if (r !== 0) return r;
    return a.suit.localeCompare(b.suit);
  });
  sorted.forEach(c => handDiv.appendChild(makeCardDiv(c, true, false)));
  $('handCount').textContent = myHand.length;
  updateFourBtn();
  // Re-render game UI so action buttons update with the new selection
  if (roomState && roomState.started) renderGame(roomState);
}

function makeCardDiv(card, selectable, hidden) {
  const div = document.createElement('div');
  div.className = `card rounded-lg flex flex-col items-center justify-center transition-transform ${
    hidden ? 'card-back' : 'card-face ' + SUIT_COLORS[card.suit]
  } ${selectable ? 'cursor-pointer hover:-translate-y-1' : ''}`;
  if (!hidden) {
    div.innerHTML = `
      <div class="text-2xl font-extrabold leading-none">${card.rank}</div>
      <div class="text-3xl leading-none">${SUIT_SYMBOLS[card.suit]}</div>`;
  }
  if (selectable) {
    if (selectedCards.has(card.id)) div.classList.add('selected');
    div.onclick = () => {
      if (selectedCards.has(card.id)) selectedCards.delete(card.id);
      else if (selectedCards.size < 3) selectedCards.add(card.id);
      renderHand();
    };
  }
  return div;
}

function updateFourBtn() {
  const counts = {};
  myHand.forEach(c => counts[c.rank] = (counts[c.rank] || 0) + 1);
  // Per the rules, the auto-loss for 4 Jacks is checked server-side. We don't offer to discard Jacks here.
  const fours = Object.entries(counts).filter(([r, c]) => c === 4 && r !== 'J').map(([r]) => r);
  const btn = $('fourBtn');
  if (fours.length > 0) {
    btn.classList.remove('hidden');
    btn.textContent = `Discard 4 ${fours[0]}s`;
    btn.onclick = () => socket.emit('discardFourOfKind', { rank: fours[0] });
  } else {
    btn.classList.add('hidden');
  }
}

function showGameOver(state) {
  const loser = state.players.find(p => p.id === state.loser);
  $('gameOver').classList.remove('hidden');
  if (state.winners.includes(myId)) {
    $('gameOverTitle').textContent = '🏆 You Won!';
    $('gameOverText').textContent = loser ? `${loser.name} lost.` : 'Everyone else lost.';
  } else if (state.loser === myId) {
    $('gameOverTitle').textContent = '💀 You Lost!';
    $('gameOverText').textContent = 'Better luck next time.';
  } else {
    $('gameOverTitle').textContent = 'Game Over';
    $('gameOverText').textContent = loser ? `${loser.name} lost.` : '';
  }
}

// ---------- Play / challenge actions ----------
function playAsRank(rank) {
  if (selectedCards.size < 1 || selectedCards.size > 3) { showError('Select 1 to 3 cards first'); return; }
  socket.emit('setTargetAndPlay', { targetRank: rank, cardIds: [...selectedCards] });
  selectedCards.clear();
}

$('playBtn').onclick = () => {
  if (selectedCards.size < 1 || selectedCards.size > 3) { showError('Select 1 to 3 cards'); return; }
  socket.emit('playCards', { cardIds: [...selectedCards] });
  selectedCards.clear();
};
$('liarBtn').onclick = () => socket.emit('callLiar');

// ---------- Settings menu ----------
$('settingsBtn').onclick = (e) => {
  e.stopPropagation();
  $('settingsMenu').classList.toggle('hidden');
};
document.addEventListener('click', (e) => {
  if (!$('settingsContainer').contains(e.target)) {
    $('settingsMenu').classList.add('hidden');
  }
});
$('endGameBtn').onclick = () => {
  $('settingsMenu').classList.add('hidden');
  if (confirm('End the current game and return everyone to the waiting room?')) {
    socket.emit('endGame');
  }
};
$('leaveBtn').onclick = () => {
  $('settingsMenu').classList.add('hidden');
  if (confirm('Leave this room and go back to the main lobby?')) {
    location.reload();
  }
};

// ---------- Util ----------
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]
  ));
}
 the current game and return everyone to the waiting room?')) {
    socket.emit('endGame');
  }
};
$('leaveBtn').onclick = () => {
  $('settingsMenu').classList.add('hidden');
  if (confirm('Leave this room and go back to the main lobby?')) {
    location.reload();
  }
};

// ---------- Util ----------
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]
  ));
}
 (confirm('Leave this room and go back to the main lobby?')) {
    location.reload();
  }
};

// ---------- Util ----------
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]
  ));
}
