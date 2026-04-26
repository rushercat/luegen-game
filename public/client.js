// client.js - Lugen frontend
const socket = io({
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 4000,
  timeout: 10000
});

const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const TARGET_RANKS = RANKS.filter(r => r !== 'J');
const SUIT_SYMBOLS = { H: '♥', D: '♦', C: '♣', S: '♠', '*': '★' };
const SUIT_COLORS  = { H: 'text-red-600', D: 'text-red-600', C: 'text-black', S: 'text-black', '*': 'text-purple-700' };

const STORAGE_KEY = 'lugen-session';

let myId = null;
let myHand = [];
let selectedCards = new Set();
let roomState = null;
let prevHandIds = new Set();
let newCardIds  = new Set();
let session = loadSession();
let attemptedResume = false;
let modSyncing = false;

const DEFAULT_SETTINGS = {
  cardsRemoved: 0, pileStart: 0, maxCards: 3,
  mysteryHands: false, liarsBar: false, shuffleSeats: false,
  jokerCount: 0, jokerRandom: false
};

const $ = (id) => document.getElementById(id);

// ---------- Session persistence ----------
function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (obj && obj.roomId && obj.playerId) return obj;
  } catch (_) {}
  return null;
}
function saveSession(data) {
  session = data;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (_) {}
}
function clearSession() {
  session = null;
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
}

// ---------- Reconnecting overlay ----------
function ensureOverlay() {
  let el = document.getElementById('reconnectOverlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'reconnectOverlay';
  el.className = 'hidden fixed inset-0 z-50 bg-black/70 backdrop-blur flex items-center justify-center p-4';
  el.innerHTML = `
    <div class="bg-gradient-to-br from-slate-800 to-slate-900 border border-yellow-400/40 px-8 py-6 rounded-2xl text-center shadow-2xl max-w-sm">
      <div class="text-yellow-300 text-4xl mb-2">\u{1F4E1}</div>
      <div id="reconnectTitle" class="text-xl font-bold mb-1">Reconnecting...</div>
      <div id="reconnectSub" class="text-sm text-emerald-200 mb-4">Trying to restore your seat.</div>
      <div class="flex justify-center gap-2">
        <span class="w-2 h-2 bg-yellow-300 rounded-full animate-bounce" style="animation-delay:0ms"></span>
        <span class="w-2 h-2 bg-yellow-300 rounded-full animate-bounce" style="animation-delay:150ms"></span>
        <span class="w-2 h-2 bg-yellow-300 rounded-full animate-bounce" style="animation-delay:300ms"></span>
      </div>
    </div>`;
  document.body.appendChild(el);
  return el;
}
function showOverlay(title, sub) {
  const el = ensureOverlay();
  el.classList.remove('hidden');
  const t = document.getElementById('reconnectTitle');
  const s = document.getElementById('reconnectSub');
  if (t && title) t.textContent = title;
  if (s && sub) s.textContent = sub;
}
function hideOverlay() {
  const el = document.getElementById('reconnectOverlay');
  if (el) el.classList.add('hidden');
}

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

// ---------- Socket lifecycle ----------
socket.on('connect', () => {
  attemptedResume = true;
  if (session && session.roomId && session.playerId) {
    showOverlay('Reconnecting...', `Restoring your seat in room ${session.roomId}.`);
    socket.emit('resumeSession', { roomId: session.roomId, playerId: session.playerId });
  } else {
    hideOverlay();
  }
});
socket.on('disconnect', () => {
  if (session && session.roomId && session.playerId) {
    showOverlay('Connection lost', 'Trying to reconnect...');
  }
});
if (socket.io && typeof socket.io.on === 'function') {
  socket.io.on('reconnect_failed', () => {
    showOverlay('Could not reconnect', 'Please reload the page.');
  });
  socket.io.on('reconnect_attempt', (attempt) => {
    if (session && session.roomId) showOverlay('Reconnecting...', `Attempt ${attempt}...`);
  });
}

// ---------- Game socket events ----------
socket.on('joined', ({ roomId, playerId }) => {
  myId = playerId;
  attemptedResume = true;
  saveSession({ roomId, playerId, name: $('playerName').value.trim() || 'Player' });
  $('lobby').classList.add('hidden');
  $('waitingRoom').classList.remove('hidden');
  $('settingsContainer').classList.remove('hidden');
  $('roomCode').textContent = roomId;
  hideOverlay();
});

socket.on('reconnectFailed', ({ reason }) => {
  clearSession();
  attemptedResume = true;
  hideOverlay();
  myId = null;
  myHand = [];
  selectedCards.clear();
  prevHandIds.clear();
  newCardIds.clear();
  roomState = null;
  $('game').classList.add('hidden');
  $('waitingRoom').classList.add('hidden');
  $('gameOver').classList.add('hidden');
  $('settingsContainer').classList.add('hidden');
  $('lobby').classList.remove('hidden');
  hideRejoinBanner();
  if (reason) showError(reason);
});

socket.on('errorMsg', ({ message }) => showError(message));

socket.on('kicked', ({ reason }) => {
  clearSession();
  alert(reason || 'You were removed from the room.');
  location.reload();
});

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
  $('endGameBtn').classList.toggle('hidden', !(state.started && state.hostId === myId && !state.gameOver));
});

socket.on('hand', (hand) => {
  const incomingIds = new Set(hand.map(c => c.id));
  if (prevHandIds.size === 0) newCardIds.clear();
  else if (incomingIds.size < prevHandIds.size) newCardIds.clear();
  else for (const id of incomingIds) if (!prevHandIds.has(id)) newCardIds.add(id);
  for (const id of [...newCardIds]) if (!incomingIds.has(id)) newCardIds.delete(id);
  prevHandIds = incomingIds;
  myHand = hand;
  selectedCards = new Set([...selectedCards].filter(id => incomingIds.has(id)));
  renderHand();
});

socket.on('reveal', ({ cards, claimed, wasLie, challengerName, lastPlayerName }) => {
  const rev = $('revealArea');
  const verdict = wasLie
    ? `LIE! ${challengerName} called ${lastPlayerName} out - claimed ${claimed}`
    : `TRUTH! ${lastPlayerName} actually had ${claimed}s (or jokers)`;
  rev.innerHTML = `<div class="w-full text-center mb-2 font-bold ${wasLie ? 'text-red-300' : 'text-green-300'}">${verdict}</div>`;
  cards.forEach(c => rev.appendChild(makeCardDiv(c, false, false)));
  setTimeout(() => { if (rev.firstChild && rev.textContent.includes(claimed)) rev.innerHTML = ''; }, 4000);
});

socket.on('gunPull', ({ playerName, died, chambersBefore, chambersAfter }) => {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-40 flex items-center justify-center pointer-events-none';
  const probStr = chambersBefore > 0 ? `1 / ${chambersBefore}` : 'guaranteed';
  overlay.innerHTML = `
    <div class="bg-black/85 border-4 ${died ? 'border-red-500' : 'border-emerald-400'} rounded-2xl px-10 py-6 text-center shadow-2xl">
      <div class="text-6xl mb-2">${died ? '\u{1F4A5}' : '\u{1F50A}'}</div>
      <div class="text-2xl font-extrabold ${died ? 'text-red-400' : 'text-emerald-300'}">
        ${died ? 'BANG!' : '*click*'}
      </div>
      <div class="text-white text-lg mt-1">${escapeHtml(playerName)}</div>
      <div class="text-white/70 text-sm mt-2">Chance was <b>${probStr}</b> ${died ? '— unlucky.' : '— survived. Next: 1/' + Math.max(1, chambersAfter)}</div>
    </div>`;
  document.body.appendChild(overlay);
  setTimeout(() => overlay.remove(), 2200);
});

socket.on('fourOfKindReveal', ({ playerName, cards, durationMs }) => {
  const rev = $('revealArea');
  rev.innerHTML = `<div class="w-full text-center mb-2 font-bold text-amber-300">${playerName} discards four ${cards[0].rank}s!</div>`;
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

// ---------- Modifier panel ----------
const MOD_FIELDS = [
  { key: 'cardsRemoved', input: 'modCardsRemoved', label: 'modCardsRemovedVal', kind: 'range' },
  { key: 'pileStart',    input: 'modPileStart',    label: 'modPileStartVal',    kind: 'range' },
  { key: 'maxCards',     input: 'modMaxCards',     label: 'modMaxCardsVal',     kind: 'range' },
  { key: 'jokerCount',   input: 'modJokerCount',   label: 'modJokerCountVal',   kind: 'range' },
  { key: 'mysteryHands', input: 'modMysteryHands', kind: 'check' },
  { key: 'liarsBar',     input: 'modLiarsBar',     kind: 'check' },
  { key: 'shuffleSeats', input: 'modShuffleSeats', kind: 'check' },
  { key: 'jokerRandom',  input: 'modJokerRandom',  kind: 'check' }
];
const _modPending = {};
function emitModChange(key, value) {
  clearTimeout(_modPending[key]);
  _modPending[key] = setTimeout(() => {
    socket.emit('updateSettings', { [key]: value });
  }, 80);
}
function applySettingsToPanel(state) {
  const settings = (state && state.settings) || DEFAULT_SETTINGS;
  const isHost = state && state.hostId === myId;
  modSyncing = true;
  for (const f of MOD_FIELDS) {
    const inp = $(f.input);
    if (!inp) continue;
    inp.disabled = !isHost;
    if (f.kind === 'range') {
      inp.value = String(settings[f.key]);
      const lbl = f.label && $(f.label);
      if (lbl) lbl.textContent = String(settings[f.key]);
    } else if (f.kind === 'check') {
      inp.checked = !!settings[f.key];
    }
  }
  // The joker slider is overridden when "Random Jokers" is on — gray it out
  // and show "?" so the host can't tell what number is in play.
  const jokerSlider = $('modJokerCount');
  const jokerLabel  = $('modJokerCountVal');
  if (jokerSlider) jokerSlider.disabled = !isHost || !!settings.jokerRandom;
  if (jokerLabel)  jokerLabel.textContent = settings.jokerRandom ? '?' : String(settings.jokerCount || 0);
  modSyncing = false;
  const hint = $('modsHint');
  if (hint) {
    hint.textContent = isHost
      ? 'Drag the sliders or toggle a checkbox - changes sync to everyone.'
      : 'Only the host can change these.';
  }
  const resetBtn = $('resetModsBtn');
  if (resetBtn) resetBtn.classList.toggle('hidden', !isHost);
}
(function wireModifiers() {
  for (const f of MOD_FIELDS) {
    const inp = document.getElementById(f.input);
    if (!inp) continue;
    if (f.kind === 'range') {
      inp.addEventListener('input', () => {
        if (modSyncing) return;
        const lbl = f.label && document.getElementById(f.label);
        if (lbl) lbl.textContent = inp.value;
        emitModChange(f.key, parseInt(inp.value, 10));
      });
    } else if (f.kind === 'check') {
      inp.addEventListener('change', () => {
        if (modSyncing) return;
        emitModChange(f.key, !!inp.checked);
      });
    }
  }
  const resetBtn = document.getElementById('resetModsBtn');
  if (resetBtn) {
    resetBtn.onclick = () => socket.emit('updateSettings', { ...DEFAULT_SETTINGS });
  }
})();

// ---------- Renderers ----------
function renderWaitingRoom(state) {
  applySettingsToPanel(state);
  const list = $('playerList');
  list.innerHTML = '';
  const isHost = state.hostId === myId;
  state.players.forEach(p => {
    const div = document.createElement('div');
    div.className = 'flex justify-between items-center px-3 py-2 rounded bg-white/5';
    const showKick = isHost && p.id !== myId;
    div.innerHTML = `
      <span>${escapeHtml(p.name)}${p.id === myId ? ' <span class="text-emerald-300">(you)</span>' : ''}${p.id === state.hostId ? ' \u{1F451}' : ''}</span>
      <span class="flex items-center gap-2">
        <span class="text-xs ${p.connected ? 'text-emerald-200' : 'text-amber-300'}">${p.connected ? 'online' : 'offline'}</span>
        ${showKick ? '<button class="kickBtn bg-red-600/70 hover:bg-red-600 text-xs px-2 py-1 rounded font-bold transition">Kick</button>' : ''}
      </span>`;
    const kickBtn = div.querySelector('.kickBtn');
    if (kickBtn) {
      kickBtn.onclick = () => {
        if (confirm(`Kick ${p.name} from the room?`)) {
          socket.emit('kickPlayer', { playerId: p.id });
        }
      };
    }
    list.appendChild(div);
  });
  const enough = state.players.length >= 2;
  $('startBtn').disabled = !isHost || !enough;
  $('hostHint').textContent = isHost
    ? (enough ? '' : 'Waiting for at least 2 players...')
    : 'Waiting for the host to start the game...';
}

function describeActiveSettingsClient(s, state) {
  if (!s) return [];
  const out = [];
  if (s.liarsBar)         out.push("Liar's Bar Mode");
  if (s.cardsRemoved > 0) out.push(`Lean Deck -${s.cardsRemoved}`);
  if (s.pileStart > 0)    out.push(`Loaded Pile +${s.pileStart}`);
  if (s.maxCards < 3)     out.push(`Trickle (max ${s.maxCards})`);
  if (s.jokerRandom) {
    const known = state && typeof state.actualJokerCount === 'number';
    out.push(known ? `Jokers (${state.actualJokerCount})` : 'Jokers (?)');
  } else if (s.jokerCount > 0) {
    out.push(`Jokers (${s.jokerCount})`);
  }
  if (s.mysteryHands)     out.push('Mystery Hands');
  if (s.shuffleSeats)     out.push('Shuffle Seats');
  return out;
}

function renderActiveMods(state) {
  const el = $('activeMods');
  if (!el) return;
  const mods = describeActiveSettingsClient(state && state.settings, state);
  if (!mods.length) { el.innerHTML = ''; return; }
  el.innerHTML = mods.map(m =>
    `<span class="bg-yellow-400/20 border border-yellow-400/40 text-yellow-200 px-2 py-0.5 rounded-full">${escapeHtml(m)}</span>`
  ).join('');
}

function renderGunDots(chambers) {
  const total = 6;
  const remaining = Math.max(0, Math.min(total, chambers || 0));
  let html = '<span class="inline-flex gap-0.5 items-center">';
  for (let i = 0; i < total; i++) {
    if (i < remaining) html += '<span class="w-1.5 h-1.5 bg-yellow-300 rounded-full"></span>';
    else                html += '<span class="w-1.5 h-1.5 bg-red-500/80 rounded-full"></span>';
  }
  html += '</span>';
  return html;
}

function renderGame(state) {
  renderActiveMods(state);
  const liarsBar = !!(state.settings && state.settings.liarsBar);
  const opp = $('opponents');
  opp.innerHTML = '';
  state.players.forEach((p, idx) => {
    const isCurrent = idx === state.currentTurnIdx;
    const canChallenge = p.id === state.canChallengeId;
    const isMe = p.id === myId;
    const isDead = liarsBar && p.alive === false;
    let displayCount;
    if (isMe) displayCount = myHand.length;
    else if (p.cardCount === null || p.cardCount === undefined) displayCount = '?';
    else displayCount = p.cardCount;
    const isOut = !liarsBar && (typeof displayCount === 'number') ? displayCount === 0 : false;
    const div = document.createElement('div');
    let borderCls;
    if (isDead)        borderCls = 'border-red-500/70 ring-2 ring-red-500/40';
    else if (isOut)    borderCls = 'border-yellow-300 ring-2 ring-yellow-300/60';
    else if (isCurrent) borderCls = 'border-yellow-400 ring-2 ring-yellow-400';
    else if (isMe)     borderCls = 'border-emerald-400';
    else               borderCls = 'border-white/10';
    div.className = `relative bg-black/40 p-3 rounded-xl text-center min-w-[120px] border ${borderCls} ${(isOut || isDead) ? 'opacity-70' : ''}`;
    const countLabel = isDead ? 'eliminated'
      : (isOut ? 'finished'
        : (typeof displayCount === 'number' ? `${displayCount} card${displayCount === 1 ? '' : 's'}` : '? cards'));
    const gunHtml = liarsBar ? `<div class="mt-1 flex justify-center">${renderGunDots(p.chambers)}</div>` : '';
    div.innerHTML = `
      ${p.seatNumber ? `<div class="absolute -top-2 -left-2 bg-yellow-400 text-black w-7 h-7 rounded-full flex items-center justify-center font-extrabold text-sm shadow">${p.seatNumber}</div>` : ''}
      ${isMe ? '<div class="absolute -top-2 -right-2 bg-emerald-400 text-black px-2 py-0.5 rounded-full text-[10px] font-extrabold shadow">YOU</div>' : ''}
      <div class="font-bold truncate">${escapeHtml(p.name)}${p.isSkipped ? ' ⏭' : ''}</div>
      <div class="text-3xl my-1">${isDead ? '\u{1F480}' : (isOut ? '\u{1F3C6}' : (isMe ? '\u{1F0CF}' : '\u{1F0A0}'))}</div>
      <div class="text-sm">${countLabel}</div>
      ${gunHtml}
      ${isOut ? '<div class="text-[10px] mt-1 text-yellow-300 font-extrabold">WON!</div>' : ''}
      ${isDead ? '<div class="text-[10px] mt-1 text-red-400 font-extrabold">OUT</div>' : ''}
      ${canChallenge && !isOut && !isDead ? '<div class="text-[10px] mt-1 text-red-300">may challenge</div>' : ''}
      ${!p.connected ? '<div class="text-[10px] text-amber-300">disconnected</div>' : ''}
    `;
    opp.appendChild(div);
  });

  const me = state.players.find(p => p.id === myId);
  const mySeat = $('mySeat');
  if (mySeat) mySeat.textContent = me && me.seatNumber ? `You are #${me.seatNumber}` : '';

  $('targetRank').textContent = state.targetRank || '-';
  $('pileSize').textContent = state.pileSize;
  if (state.lastPlayCount > 0) {
    const lp = state.players.find(p => p.id === state.lastPlayerId);
    $('lastPlayInfo').textContent = `${lp ? lp.name : 'Someone'} just played ${state.lastPlayCount} card(s).`;
  } else if (liarsBar) {
    $('lastPlayInfo').textContent = state.targetRank ? `Round target is ${state.targetRank}.` : '';
  } else {
    $('lastPlayInfo').textContent = state.targetRank ? '' : 'Waiting for the round-starter to choose a Target Rank.';
  }

  const cur = state.players[state.currentTurnIdx];
  if (cur) $('turnIndicator').textContent = cur.id === myId ? 'YOUR TURN' : `${cur.name}'s turn`;

  const isMyTurn = cur && cur.id === myId;
  const myAlive = !me || me.alive !== false;
  const rankPicker = $('rankPicker');
  const playBtn = $('playBtn');
  const maxCards = (state.settings && state.settings.maxCards) || 3;
  const validSelection = selectedCards.size >= 1 && selectedCards.size <= maxCards;

  if (liarsBar) {
    rankPicker.classList.add('hidden');
    if (isMyTurn && myAlive) {
      playBtn.classList.remove('hidden');
      playBtn.textContent = `Play as ${state.targetRank || ''}${state.targetRank === 'A' ? '' : 's'}`;
      playBtn.disabled = !validSelection;
    } else {
      playBtn.classList.add('hidden');
    }
  } else if (isMyTurn && state.targetRank === null) {
    rankPicker.classList.remove('hidden');
    playBtn.classList.add('hidden');
    const rb = $('rankButtons');
    if (rb.children.length === 0) {
      TARGET_RANKS.forEach(r => {
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
    rankPicker.classList.add('hidden');
    playBtn.classList.remove('hidden');
    playBtn.textContent = `Play as ${state.targetRank}${state.targetRank === 'A' ? '' : 's'}`;
    playBtn.disabled = !validSelection;
  } else {
    rankPicker.classList.add('hidden');
    playBtn.classList.add('hidden');
  }

  $('liarBtn').disabled = state.canChallengeId !== myId;

  $('log').innerHTML = state.log.map(l => `<div>${escapeHtml(l)}</div>`).join('');
  $('log').scrollTop = $('log').scrollHeight;
}

function renderHand() {
  const handDiv = $('hand');
  handDiv.innerHTML = '';
  const sorted = [...myHand].sort((a, b) => {
    const ai = RANKS.indexOf(a.rank);
    const bi = RANKS.indexOf(b.rank);
    if (ai !== bi) return ai - bi;
    return (a.suit || '').localeCompare(b.suit || '');
  });
  sorted.forEach(c => handDiv.appendChild(makeCardDiv(c, true, false)));
  $('handCount').textContent = myHand.length;
  const handMax = $('handMax');
  if (handMax) handMax.textContent = String((roomState && roomState.settings && roomState.settings.maxCards) || 3);
  updateFourBtn();
  if (roomState && roomState.started) renderGame(roomState);
}

function makeCardDiv(card, selectable, hidden) {
  const isJoker = card && card.rank === 'JOKER';
  const div = document.createElement('div');
  div.className = `card rounded-lg flex flex-col items-center justify-center transition-transform ${
    hidden ? 'card-back' : 'card-face ' + (isJoker ? 'text-purple-700 bg-amber-100' : SUIT_COLORS[card.suit] || 'text-black')
  } ${selectable ? 'cursor-pointer hover:-translate-y-1' : ''}`;
  if (!hidden) {
    if (isJoker) {
      div.innerHTML = `
        <div class="text-3xl font-extrabold leading-none">★</div>
        <div class="text-[10px] font-bold mt-1">JOKER</div>`;
    } else {
      div.innerHTML = `
        <div class="text-2xl font-extrabold leading-none">${card.rank}</div>
        <div class="text-3xl leading-none">${SUIT_SYMBOLS[card.suit] || ''}</div>`;
    }
  }
  if (selectable) {
    if (selectedCards.has(card.id)) div.classList.add('selected');
    if (newCardIds.has(card.id)) div.classList.add('card-new');
    div.onclick = () => {
      const max = (roomState && roomState.settings && roomState.settings.maxCards) || 3;
      if (selectedCards.has(card.id)) selectedCards.delete(card.id);
      else if (selectedCards.size < max) selectedCards.add(card.id);
      renderHand();
    };
  }
  return div;
}

function updateFourBtn() {
  const liarsBar = !!(roomState && roomState.settings && roomState.settings.liarsBar);
  const btn = $('fourBtn');
  if (liarsBar) { btn.classList.add('hidden'); return; }
  const counts = {};
  myHand.forEach(c => counts[c.rank] = (counts[c.rank] || 0) + 1);
  const fours = Object.entries(counts).filter(([r, c]) => c === 4 && r !== 'J' && r !== 'JOKER').map(([r]) => r);
  if (fours.length > 0) {
    btn.classList.remove('hidden');
    btn.textContent = `Discard 4 ${fours[0]}s`;
    btn.onclick = () => socket.emit('discardFourOfKind', { rank: fours[0] });
  } else {
    btn.classList.add('hidden');
  }
}

function showGameOver(state) {
  const losers = (state.losers || []).map(id => state.players.find(p => p.id === id)).filter(Boolean);
  const loserNames = losers.map(p => p.name).join(' and ');
  $('gameOver').classList.remove('hidden');
  if (state.winners.includes(myId)) {
    $('gameOverTitle').textContent = 'You Won!';
    $('gameOverText').textContent = losers.length > 0
      ? `${loserNames} ${losers.length > 1 ? 'lose' : 'lost'}.`
      : 'Everyone else lost.';
  } else if ((state.losers || []).includes(myId)) {
    $('gameOverTitle').textContent = 'You Lost!';
    if (losers.length > 1) {
      const others = losers.filter(p => p.id !== myId).map(p => p.name).join(', ');
      $('gameOverText').textContent = `Last two with cards both lose - you and ${others}.`;
    } else {
      $('gameOverText').textContent = 'Better luck next time.';
    }
  } else {
    $('gameOverTitle').textContent = 'Game Over';
    $('gameOverText').textContent = losers.length > 0
      ? `${loserNames} ${losers.length > 1 ? 'lose' : 'lost'}.`
      : '';
  }
}

// ---------- Play / challenge actions ----------
function playAsRank(rank) {
  const maxCards = (roomState && roomState.settings && roomState.settings.maxCards) || 3;
  if (selectedCards.size < 1 || selectedCards.size > maxCards) { showError(`Select 1 to ${maxCards} card${maxCards === 1 ? '' : 's'} first`); return; }
  socket.emit('setTargetAndPlay', { targetRank: rank, cardIds: [...selectedCards] });
  selectedCards.clear();
}

$('playBtn').onclick = () => {
  const maxCards = (roomState && roomState.settings && roomState.settings.maxCards) || 3;
  if (selectedCards.size < 1 || selectedCards.size > maxCards) { showError(`Select 1 to ${maxCards} card${maxCards === 1 ? '' : 's'}`); return; }
  socket.emit('playCards', { cardIds: [...selectedCards] });
  selectedCards.clear();
};
$('liarBtn').onclick = () => socket.emit('callLiar');

const playAgainBtn = $('playAgainBtn');
if (playAgainBtn) playAgainBtn.onclick = () => socket.emit('playAgain');

// ---------- Settings menu ----------
$('settingsBtn').onclick = (e) => {
  e.stopPropagation();
  $('settingsMenu').classList.toggle('hidden');
};
document.addEventListener('click', (e) => {
  if (!$('settingsContainer').contains(e.target)) $('settingsMenu').classList.add('hidden');
});
$('endGameBtn').onclick = () => {
  $('settingsMenu').classList.add('hidden');
  if (confirm('End the current game and return everyone to the waiting room?')) socket.emit('endGame');
};
$('leaveBtn').onclick = () => {
  $('settingsMenu').classList.add('hidden');
  if (confirm('Leave this room and go back to the main lobby?')) {
    socket.emit('leaveRoom');
    clearSession();
    location.reload();
  }
};

// ---------- Rejoin banner ----------
function ensureRejoinBanner() {
  let el = document.getElementById('rejoinBanner');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'rejoinBanner';
  el.className = 'mt-4 bg-yellow-500/15 border border-yellow-400/40 rounded-xl p-4 flex flex-col gap-2 text-sm';
  $('lobby').querySelector('.bg-black\\/40').after(el);
  return el;
}
function showRejoinBanner() {
  if (!session || !session.roomId || !session.playerId) return;
  const el = ensureRejoinBanner();
  el.innerHTML = `
    <div>You were in room <b class="font-mono">${escapeHtml(session.roomId)}</b>${session.name ? ` as <b>${escapeHtml(session.name)}</b>` : ''}.</div>
    <div class="flex gap-2">
      <button id="rejoinBtn" class="flex-1 bg-yellow-500 hover:bg-yellow-400 text-black px-4 py-2 rounded-lg font-bold transition">Reconnect</button>
      <button id="forgetBtn" class="bg-white/10 hover:bg-white/20 px-4 py-2 rounded-lg font-bold transition">Forget</button>
    </div>`;
  el.classList.remove('hidden');
  document.getElementById('rejoinBtn').onclick = () => {
    showOverlay('Reconnecting...', `Restoring your seat in room ${session.roomId}.`);
    attemptedResume = true;
    socket.emit('resumeSession', { roomId: session.roomId, playerId: session.playerId });
  };
  document.getElementById('forgetBtn').onclick = () => {
    clearSession();
    hideRejoinBanner();
  };
}
function hideRejoinBanner() {
  const el = document.getElementById('rejoinBanner');
  if (el) el.remove();
}

if (session && session.roomId && session.playerId) {
  showRejoinBanner();
  if (session.name) {
    const nameInput = $('playerName');
    if (nameInput && !nameInput.value) nameInput.value = session.name;
  }
}

// ---------- Util ----------
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]
  ));
}
