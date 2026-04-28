// beta-mp.js — Client-side beta multiplayer. Connects via socket.io to
// server-beta-rooms.js, drives the multiplayer beta UI from server broadcasts.
// Re-uses the existing #betaGame DOM where possible.

(function () {
  'use strict';

  // ==================== State ====================
  let socket = null;
  let myRoomId = null;
  let myPlayerId = null;
  let lastState = null;
  const selected = new Set();

  // Character roster (mirror of server) — for the lobby picker
  const CHARACTERS = [
    { id: 'ace',       name: 'The Ace',       startingJoker: 'sleightOfHand', passive: 'Starts with Sleight of Hand.' },
    { id: 'trickster', name: 'The Trickster', startingJoker: 'doubletalk',    passive: 'Starts with Doubletalk.' },
    { id: 'hoarder',   name: 'The Hoarder',   startingJoker: 'slowHand',      passive: 'Hand size +1 (6 cards). Starts with Slow Hand.' },
    { id: 'banker',    name: 'The Banker',    startingJoker: 'surveyor',      passive: 'Start with 150g + a Gilded Ace. Starts with Surveyor.' },
    { id: 'bait',      name: 'The Bait',      startingJoker: 'spikedTrap',    passive: 'Round start: peek 1 random card from a random opponent. Starts with Spiked Trap.' },
    { id: 'gambler',   name: 'The Gambler',   startingJoker: 'blackHole',     passive: '+50% gold from all sources. 1 Cursed forced each floor. Starts with Black Hole.' },
    { id: 'sharp',     name: 'The Sharp',     startingJoker: 'tattletale',    passive: 'Challenge window +1 second. Starts with Tattletale.' },
    { id: 'whisper',   name: 'The Whisper',   startingJoker: 'eavesdropper',  passive: 'Round start: peek 1 card from your left or right neighbour (toggleable). Starts with Eavesdropper.' },
    { id: 'randomExe', name: 'RANDOM.EXE',    startingJoker: null,            passive: 'Round start: every run-deck card sheds its affix and gains a new random one (Steel not safe). Run-deck cards in the shop cost 20% less.' },
  ];

  // Open a detail modal for a character — shows passive + starting joker info.
  // Includes a "Pick this character" button that emits beta:pickCharacter and
  // closes the modal. The card click in the lobby calls this instead of
  // emitting directly, so players can see what they're picking before they pick.
  function _showCharacterDetailMP(c, alreadyPicked) {
    const jokerInfo = (window.lugenJokerCatalog && c.startingJoker)
      ? window.lugenJokerCatalog[c.startingJoker]
      : null;
    let modal = document.getElementById('betaMpCharDetailModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'betaMpCharDetailModal';
      modal.className = 'fixed inset-0 bg-black/80 backdrop-blur z-50 flex items-center justify-center p-4';
      document.body.appendChild(modal);
      modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
    }
    const RARITY_TONE = {
      Common: 'bg-gray-700 text-gray-100',
      Uncommon: 'bg-emerald-700 text-emerald-100',
      Rare: 'bg-blue-700 text-blue-100',
      Legendary: 'bg-amber-700 text-amber-100',
    };
    const rarityTone = jokerInfo ? (RARITY_TONE[jokerInfo.rarity] || 'bg-gray-700 text-gray-100') : '';
    const jokerSection = jokerInfo
      ? '<div class="bg-purple-900/40 border border-purple-400 rounded-lg p-3 mb-4">' +
          '<div class="flex items-baseline gap-2 mb-1">' +
            '<span class="text-[10px] uppercase tracking-widest text-purple-200 font-bold">Starting joker</span>' +
            '<span class="font-bold">' + escapeHtml(jokerInfo.name) + '</span>' +
            (jokerInfo.rarity ? '<span class="text-[10px] uppercase tracking-widest font-bold px-1.5 rounded ' + rarityTone + '">' + escapeHtml(jokerInfo.rarity) + '</span>' : '') +
          '</div>' +
          '<div class="text-xs text-emerald-100">' + escapeHtml(jokerInfo.desc || '') + '</div>' +
        '</div>'
      : '<div class="text-xs italic text-white/50 mb-4">No starting joker.</div>';
    modal.innerHTML =
      '<div class="bg-slate-800 border-2 border-purple-400 p-6 rounded-2xl shadow-2xl max-w-md w-full">' +
        '<div class="flex items-start justify-between mb-2">' +
          '<h3 class="text-2xl font-extrabold">' + escapeHtml(c.name) + '</h3>' +
          '<button id="betaMpCharDetailClose" class="bg-white/10 hover:bg-white/20 px-3 py-1 rounded-lg text-sm">Close</button>' +
        '</div>' +
        '<div class="text-sm text-emerald-200 mb-4">' + escapeHtml(c.passive || '') + '</div>' +
        jokerSection +
        '<div class="flex gap-2 mt-4">' +
          '<button id="betaMpCharDetailPick" class="flex-1 bg-yellow-500 hover:bg-yellow-400 text-black font-bold px-4 py-2 rounded-lg transition">' +
            (alreadyPicked ? 'Re-confirm pick' : 'Pick ' + escapeHtml(c.name)) +
          '</button>' +
        '</div>' +
      '</div>';
    modal.querySelector('#betaMpCharDetailClose').addEventListener('click', () => modal.classList.add('hidden'));
    modal.querySelector('#betaMpCharDetailPick').addEventListener('click', () => {
      socket.emit('beta:pickCharacter', { characterId: c.id });
      modal.classList.add('hidden');
    });
    modal.classList.remove('hidden');
  }

  function affixRingClass(affix) {
    switch (affix) {
      case 'gilded': return 'ring-2 ring-yellow-400';
      case 'glass':  return 'ring-2 ring-cyan-400';
      case 'spiked': return 'ring-2 ring-red-400';
      case 'cursed': return 'ring-2 ring-purple-500';
      case 'steel':  return 'ring-2 ring-gray-300';
      case 'mirage': return 'ring-2 ring-pink-400';
      case 'hollow': return 'ring-2 ring-indigo-400';
      case 'echo':   return 'ring-2 ring-fuchsia-400';
      default: return null;
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function getAuthToken() {
    try { return localStorage.getItem('lugen-auth-token') || null; }
    catch (e) { return null; }
  }

  // Persisted reconnect identity. We stash the last room+player IDs in
  // localStorage so a refresh or transient network drop can resume the seat
  // via beta:resume. Cleared when the player explicitly leaves.
  const _RESUME_ROOM_KEY   = 'lugen-beta-mp-room';
  const _RESUME_PLAYER_KEY = 'lugen-beta-mp-player';

  function rememberSession(roomId, playerId) {
    try {
      if (roomId)   localStorage.setItem(_RESUME_ROOM_KEY, roomId);
      if (playerId) localStorage.setItem(_RESUME_PLAYER_KEY, playerId);
    } catch (e) {}
  }
  function forgetSession() {
    try {
      localStorage.removeItem(_RESUME_ROOM_KEY);
      localStorage.removeItem(_RESUME_PLAYER_KEY);
    } catch (e) {}
  }
  function recallSession() {
    try {
      return {
        roomId:   localStorage.getItem(_RESUME_ROOM_KEY)   || null,
        playerId: localStorage.getItem(_RESUME_PLAYER_KEY) || null,
      };
    } catch (e) { return { roomId: null, playerId: null }; }
  }

  // ==================== Connect ====================
  function ensureSocket() {
    if (socket) return socket;
    const token = getAuthToken();
    socket = io({ auth: { token: token || undefined } });

    socket.on('beta:joined', ({ roomId, playerId }) => {
      myRoomId = roomId;
      myPlayerId = playerId;
      rememberSession(roomId, playerId);
      const codeEl = document.getElementById('betaMpRoomCode');
      if (codeEl) codeEl.textContent = roomId;
      showLobby();
    });

    socket.on('beta:state', (state) => {
      lastState = state;
      render();
    });

    socket.on('beta:error', ({ message }) => {
      const errEl = document.getElementById('betaMpError');
      if (errEl) {
        errEl.textContent = message || 'Server error.';
        errEl.classList.remove('hidden');
        setTimeout(() => errEl.classList.add('hidden'), 5000);
      } else {
        alert(message || 'Server error.');
      }
    });

    // Reconnect handshake: socket.io auto-reconnects after a network blip,
    // but our seat is still on the server (with a 60s removal timer). On
    // every (re)connect, if we have a saved session, ask the server to
    // reattach us to it. The 'connect' event fires on the initial connect
    // too — that's fine; if the server doesn't recognize the saved session
    // it returns beta:reconnectFailed and we clear it locally.
    socket.on('connect', () => {
      const sess = recallSession();
      if (sess.roomId && sess.playerId) {
        socket.emit('beta:resume', { roomId: sess.roomId, playerId: sess.playerId });
      }
    });

    socket.on('beta:reconnectFailed', ({ reason } = {}) => {
      forgetSession();
      myRoomId = null;
      myPlayerId = null;
      lastState = null;
      const errEl = document.getElementById('betaMpError');
      if (errEl) {
        errEl.textContent = reason || 'Could not reconnect to your beta room.';
        errEl.classList.remove('hidden');
        setTimeout(() => errEl.classList.add('hidden'), 6000);
      }
      showEntry();
    });
  }

  // ==================== Screen visibility ====================
  function hideAllMpScreens() {
    const ids = ['betaMpEntry', 'betaMpLobby', 'betaMpGame', 'betaMpResult'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    }
  }

  function showEntry() {
    hideAllMpScreens();
    const el = document.getElementById('betaMpEntry');
    if (el) el.classList.remove('hidden');
  }

  function showLobby() {
    hideAllMpScreens();
    const el = document.getElementById('betaMpLobby');
    if (el) el.classList.remove('hidden');
  }

  function showGame() {
    hideAllMpScreens();
    const el = document.getElementById('betaMpGame');
    if (el) el.classList.remove('hidden');
  }

  function showResult() {
    hideAllMpScreens();
    const el = document.getElementById('betaMpResult');
    if (el) el.classList.remove('hidden');
  }

  // ==================== Render ====================
  function render() {
    if (!lastState) return;
    if (lastState.runOver) {
      renderResult();
      return;
    }
    if (!lastState.runStarted) {
      renderLobby();
      showLobby();
      return;
    }
    showGame();
    renderGame();
  }

  function renderLobby() {
    const codeEl = document.getElementById('betaMpRoomCode');
    if (codeEl) codeEl.textContent = lastState.id;

    // Player list
    const listEl = document.getElementById('betaMpPlayerList');
    if (listEl) {
      listEl.innerHTML = '';
      for (const p of lastState.players) {
        const isMe = p.id === myPlayerId;
        const isHost = p.id === lastState.hostId;
        const row = document.createElement('div');
        row.className = 'flex items-center justify-between bg-black/30 px-3 py-2 rounded';
        row.innerHTML =
          '<div>' +
            '<span class="font-bold">' + escapeHtml(p.name) + '</span>' +
            (isMe ? ' <span class="text-xs text-emerald-300">(you)</span>' : '') +
            (isHost ? ' <span class="text-xs text-yellow-300">[host]</span>' : '') +
            (!p.connected ? ' <span class="text-xs text-rose-300">[disconnected]</span>' : '') +
          '</div>' +
          '<div class="text-xs text-emerald-200">' +
            (p.characterName ? escapeHtml(p.characterName) : '<i class="text-white/40">picking...</i>') +
          '</div>';
        listEl.appendChild(row);
      }
    }

    // Character picker (only show options if I haven't picked, or to change)
    const me = (lastState.players || []).find(p => p.id === myPlayerId);
    const myPickEl = document.getElementById('betaMpMyCharacter');
    if (myPickEl) {
      myPickEl.innerHTML = '';
      for (const c of CHARACTERS) {
        const btn = document.createElement('button');
        const picked = me && me.characterId === c.id;
        btn.className = 'p-3 rounded-lg border-2 text-left transition w-full ' +
          (picked ? 'bg-purple-700 border-yellow-300' : 'bg-black/40 border-white/10 hover:border-white/30');
        btn.innerHTML =
          '<div class="font-bold">' + escapeHtml(c.name) + '</div>' +
          '<div class="text-xs text-emerald-200 mt-1">' + escapeHtml(c.passive) + '</div>';
        btn.addEventListener('click', () => {
          _showCharacterDetailMP(c, picked);
        });
        myPickEl.appendChild(btn);
      }
    }

    // Host controls
    const startBtn = document.getElementById('betaMpStartBtn');
    const startHint = document.getElementById('betaMpStartHint');
    if (startBtn && startHint) {
      const allPicked = lastState.players.every(p => p.characterId);
      const hasMin = lastState.players.length >= 2;
      const isHost = lastState.hostId === myPlayerId;
      startBtn.classList.toggle('hidden', !isHost);
      startBtn.disabled = !(allPicked && hasMin);
      if (!isHost) {
        startHint.textContent = 'Waiting for the host to start the run...';
      } else if (!hasMin) {
        startHint.textContent = 'Need at least 2 players.';
      } else if (!allPicked) {
        startHint.textContent = 'Waiting for everyone to pick a character.';
      } else {
        startHint.textContent = 'Ready to start!';
      }
    }
  }

  function renderGameStatusExtras() {
    const s = lastState;
    // Floor modifier / boss badge
    const badge = document.getElementById('betaMpModBadge');
    if (badge) {
      badge.innerHTML = '';
      if (s.currentBoss) {
        const b = document.createElement('button');
        b.className = 'bg-rose-700 hover:bg-rose-600 transition px-2 py-0.5 rounded text-xs font-bold cursor-pointer';
        b.innerHTML = '&#128081; BOSS: ' + escapeHtml(s.currentBoss.name);
        b.title = s.currentBoss.desc;
        b.addEventListener('click', () => alert(s.currentBoss.name + '\n\n' + s.currentBoss.desc));
        badge.appendChild(b);
      } else if (s.currentFloorModifierInfo) {
        const m = s.currentFloorModifierInfo;
        const b = document.createElement('button');
        b.className = 'bg-purple-700 hover:bg-purple-600 transition px-2 py-0.5 rounded text-xs font-bold cursor-pointer';
        b.textContent = m.name;
        b.title = m.desc;
        b.addEventListener('click', () => alert(m.name + '\n\n' + m.desc));
        badge.appendChild(b);
      }
    }
    // Joker row (mine)
    const jokers = s.mine && s.mine.jokers ? s.mine.jokers : [null, null];
    for (let i = 0; i < 2; i++) {
      const slot = document.getElementById('betaMpJokerSlot' + i);
      if (!slot) continue;
      const j = jokers[i];
      slot.innerHTML = j
        ? ('<button class="text-xs px-2 py-1 rounded bg-purple-900/60 hover:bg-purple-800 text-purple-100" title="' + escapeHtml(j.desc) + '">&#127183; ' + escapeHtml(j.name) + '</button>')
        : '<span class="text-xs italic text-white/40">Empty</span>';
    }
    // Surveyor display
    const surv = document.getElementById('betaMpSurveyor');
    if (surv) {
      if (s.mine && s.mine.surveyorTop) {
        surv.classList.remove('hidden');
        surv.innerHTML = '&#128270; Top: <b>' + escapeHtml(s.mine.surveyorTop.rank) + '</b>';
      } else surv.classList.add('hidden');
    }
    // Tattletale button
    const ttBtn = document.getElementById('betaMpTattletaleBtn');
    if (ttBtn) {
      const charges = (s.mine && s.mine.tattletaleCharges) || 0;
      const hasJoker = (s.mine && s.mine.jokers && s.mine.jokers.some(j => j && j.id === 'tattletale'));
      ttBtn.classList.toggle('hidden', !hasJoker);
      ttBtn.disabled = charges <= 0;
      ttBtn.innerHTML = '&#128064; Tattletale (' + charges + ')';
    }
    // Loaded Die button
    const ldBtn = document.getElementById('betaMpLoadedDieBtn');
    if (ldBtn) {
      const hasIt = s.mine && s.mine.relics && s.mine.relics.includes('loadedDie');
      const used = s.mine && s.mine.loadedDieUsed;
      ldBtn.classList.toggle('hidden', !hasIt);
      ldBtn.disabled = !!used;
      ldBtn.textContent = used ? 'Loaded Die (used)' : 'Loaded Die';
    }
    // Consumable inventory
    const consDiv = document.getElementById('betaMpConsumables');
    if (consDiv) {
      const inv = (s.mine && s.mine.inventory) || {};
      consDiv.innerHTML = '';
      const ids = Object.keys(inv).filter(id => inv[id] > 0);
      if (ids.length === 0) {
        consDiv.innerHTML = '<span class="text-xs italic text-white/40">No consumables.</span>';
      } else {
        for (const id of ids) {
          const btn = document.createElement('button');
          const labels = { smokeBomb: '&#128168; Smoke Bomb', counterfeit: '&#128276; Counterfeit', jackBeNimble: '&#127183; Jack-be-Nimble', tracer: '&#128270; Tracer', devilsBargain: "&#128520; Devil's Bargain", magnet: '&#129516; Magnet' };
          btn.className = 'bg-amber-700 hover:bg-amber-600 transition px-2 py-1 rounded text-xs font-bold';
          btn.innerHTML = (labels[id] || id) + ' (' + inv[id] + ')';
          btn.addEventListener('click', () => useConsumable(id));
          consDiv.appendChild(btn);
        }
      }
    }
    // Show one-shot peeks (Cold Read, Hand Mirror, Tattletale)
    if (s.mine && s.mine.peeks && s.mine.peeks.length > 0) {
      for (const peek of s.mine.peeks) {
        if (peek.kind === 'tattletale') {
          showTattletaleModal(peek.payload.target, peek.payload.cards || [], peek.payload.ms || 4000);
        } else if (peek.kind === 'coldRead' || peek.kind === 'handMirror') {
          const txt = (peek.payload || []).map(p => p.player + ': ' + p.rank).join('\n');
          alert((peek.kind === 'coldRead' ? 'Cold Read' : 'Hand Mirror') + ':\n' + txt);
        } else if (peek.kind === 'eavesdropper') {
          alert('Eavesdropper - ' + peek.payload.source + ': ' + peek.payload.bucket + ' matches for the target rank.');
        } else if (peek.kind === 'bait') {
          alert('Bait - ' + peek.payload.player + ': ' + peek.payload.rank);
        } else if (peek.kind === 'echo') {
          alert("Echo's eye — " + peek.payload.player + "'s first card: " + peek.payload.rank + (peek.payload.affix ? ' (' + peek.payload.affix + ')' : ''));
        } else if (peek.kind === 'tracerPeek') {
          // Show top-3 cards, prompt for new order
          const tops = peek.payload.topCards || [];
          const tag = (c, i) => i + ': ' + c.rank + (c.affix ? ' [' + c.affix + ']' : '');
          const labels = tops.map((c, i) => tag(c, i)).join('\n');
          const order = prompt('Tracer — top of draw pile (TOP first):\n' + labels + '\n\nEnter NEW order as comma-separated indices (top first), e.g. "0,1,2" to keep, "2,1,0" to flip:');
          if (!order) return;
          const perm = order.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !Number.isNaN(n));
          if (perm.length === 0) return;
          socket.emit('beta:useConsumable', { itemId: 'tracer', options: { perm } });
        }
      }
    }
  }

  function useConsumable(itemId) {
    if (!socket || !lastState) return;
    if (itemId === 'counterfeit') {
      const newRank = prompt('Counterfeit — change target to (A, K, Q, 10):');
      if (!newRank) return;
      socket.emit('beta:useConsumable', { itemId, options: { newRank: newRank.toUpperCase() } });
      return;
    }
    if (itemId === 'tracer') {
      // First call requests the peek; then we'll prompt for permutation
      socket.emit('beta:useConsumable', { itemId });
      return;
    }
    if (itemId === 'devilsBargain' || itemId === 'magnet') {
      const hand = (lastState.mine && lastState.mine.hand) || [];
      const eligible = itemId === 'magnet' ? hand.filter(c => c.affix !== 'steel') : hand.slice();
      if (eligible.length === 0) { alert('No eligible cards in your hand.'); return; }
      const labels = eligible.map((c, i) => i + ': ' + c.rank + (c.affix ? ' [' + c.affix + ']' : '')).join('\n');
      const choice = prompt('Pick a hand card index:\n' + labels);
      if (choice === null) return;
      const idx = parseInt(choice, 10);
      if (Number.isNaN(idx) || idx < 0 || idx >= eligible.length) return;
      socket.emit('beta:useConsumable', { itemId, options: { handCardId: eligible[idx].id } });
      return;
    }
    socket.emit('beta:useConsumable', { itemId });
  }

  function showTattletaleModal(targetName, cards, ms) {
    const modal = document.getElementById('betaMpTattletaleModal');
    if (!modal) return;
    document.getElementById('betaMpTattletaleTarget').textContent = targetName || '?';
    const cardsDiv = document.getElementById('betaMpTattletaleCards');
    cardsDiv.innerHTML = '';
    const order = ['A', 'K', 'Q', '10', 'J'];
    const sorted = cards.slice().sort((a, b) => order.indexOf(a.rank) - order.indexOf(b.rank));
    for (const c of sorted) {
      const div = document.createElement('div');
      let cls = 'card card-face flex items-center justify-center text-2xl font-bold text-black rounded';
      const ring = affixRingClass(c.affix);
      if (ring) cls += ' ' + ring;
      div.className = cls;
      div.textContent = c.rank;
      if (c.affix) div.title = 'Affix: ' + c.affix;
      cardsDiv.appendChild(div);
    }
    modal.classList.remove('hidden');
    let remaining = Math.max(1, Math.floor((ms || 4000) / 1000));
    const cd = document.getElementById('betaMpTattletaleCountdown');
    cd.textContent = remaining;
    const interval = setInterval(() => {
      remaining--;
      cd.textContent = remaining;
      if (remaining <= 0) {
        clearInterval(interval);
        modal.classList.add('hidden');
      }
    }, 1000);
  }

  function useTattletale() {
    if (!socket || !lastState) return;
    const opts = lastState.players
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.id !== myPlayerId && !p.eliminated);
    if (opts.length === 0) { alert('No targets available.'); return; }
    const labels = opts.map(({ p, i }) => i + ': ' + p.name).join('\n');
    const choice = prompt('Pick a target index:\n' + labels);
    if (choice === null) return;
    const idx = parseInt(choice, 10);
    if (Number.isNaN(idx)) return;
    socket.emit('beta:useTattletale', { targetIdx: idx });
  }

  function renderForkPhase() {
    const s = lastState;
    const fork = document.getElementById('betaMpFork');
    if (!fork) return;
    fork.classList.remove('hidden');
    const offer = s.forkOffer || {};
    const me = (s.mine) || {};
    const myPick = me.forkPick;
    const isResolved = myPick && myPick !== 'shop-browsing' && myPick !== null && myPick !== undefined;
    const isShopBrowsing = myPick === 'shop-browsing';

    let html =
      '<div class="flex items-baseline justify-between mb-2 gap-2 flex-wrap">' +
        '<h3 class="text-xl font-bold">Floor ' + offer.nextFloor + ' approaches</h3>' +
        // Run seed pill — visible at every fork, shareable to replay the run.
        (s.seed
          ? '<span class="text-[11px] text-white/60" title="Run seed — share to replay this exact run">Seed: <code class="bg-black/40 px-1 rounded">' + escapeHtml(s.seed) + '</code></span>'
          : '') +
      '</div>' +
      (offer.nextFloorIsBoss && offer.nextBoss
        ? '<p class="text-rose-300 mb-3">&#128081; Boss next: ' + escapeHtml(offer.nextBoss.name) + ' — ' + escapeHtml(offer.nextBoss.desc) + '</p>'
        : '') +
      '<p class="text-emerald-200 mb-3">Pick one fork. Each player chooses independently.</p>';

    if (!isResolved && !isShopBrowsing && myPick !== 'reward-browsing' && myPick !== 'cleanse-browsing') {
      html += '<div class="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">';
      if (offer.hasShop) {
        html += '<button data-fork="shop" class="bg-yellow-600 hover:bg-yellow-500 px-4 py-3 rounded-lg font-bold">&#129689; Shop</button>';
      }
      if (offer.hasReward) {
        html += '<button data-fork="reward" class="bg-emerald-600 hover:bg-emerald-500 px-4 py-3 rounded-lg font-bold">&#128176; Reward (2 jokers / 75g)</button>';
      }
      if (offer.hasTreasure) {
        html += '<button data-fork="treasure" class="bg-pink-600 hover:bg-pink-500 px-4 py-3 rounded-lg font-bold">&#127873; Treasure (+120g + Treasure relic)</button>';
      }
      if (offer.hasEvent) {
        html += '<button data-fork="event" class="bg-purple-600 hover:bg-purple-500 px-4 py-3 rounded-lg font-bold">&#10068; Event</button>';
      }
      if (offer.hasCleanse) {
        html += '<button data-fork="cleanse" class="bg-cyan-600 hover:bg-cyan-500 px-4 py-3 rounded-lg font-bold">&#9876; Cleanse</button>';
      }
      html += '</div>';
    } else if (myPick === 'reward-browsing') {
      html += '<div class="bg-black/30 p-4 rounded-xl mb-4">' +
              '<h4 class="font-bold mb-2">Reward — pick a joker (or take 75g)</h4>' +
              '<div id="betaMpRewardList" class="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2"></div>' +
              '<button id="betaMpRewardGoldBtn" class="bg-yellow-500 hover:bg-yellow-400 text-black px-4 py-1 rounded text-sm font-bold">Take 75g instead</button>' +
              '</div>';
    } else if (myPick === 'cleanse-browsing') {
      html += '<div class="bg-black/30 p-4 rounded-xl mb-4">' +
              '<h4 class="font-bold mb-2">Cleanse — pick a card</h4>' +
              '<div class="text-xs text-emerald-200 mb-2">Strip the affix from a run-deck card, OR remove a Cursed run-deck card entirely.</div>' +
              '<div id="betaMpCleanseList" class="flex flex-wrap gap-2"></div>' +
              '</div>';
    } else if (isShopBrowsing) {
      const myGold = (s.players.find(p => p.id === myPlayerId) || {}).gold;
      html +=
        '<div class="bg-black/30 p-4 rounded-xl mb-4">' +
          '<div class="flex justify-between items-center mb-3">' +
            '<h4 class="text-xl font-bold">\ud83c\udfe6 Shop</h4>' +
            '<span class="text-yellow-300 font-bold">\ud83d\udcb0 ' + myGold + 'g</span>' +
          '</div>' +
          // Top: Jokers section
          '<div class="mb-4 bg-black/30 p-3 rounded-xl border border-purple-500/30">' +
            '<h3 class="text-xs uppercase tracking-widest text-purple-300 font-bold mb-2">\ud83c\udca0 Jokers</h3>' +
            '<div id="betaMpShopJokers" class="grid grid-cols-1 sm:grid-cols-3 gap-3"></div>' +
          '</div>' +
          // Bottom row: Cards (left) + Consumables (right)
          '<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">' +
            '<div class="bg-black/30 p-3 rounded-xl border border-blue-500/30">' +
              '<h3 class="text-xs uppercase tracking-widest text-blue-300 font-bold mb-2">\ud83c\udca0 Cards</h3>' +
              '<div id="betaMpShopCards" class="space-y-2"></div>' +
            '</div>' +
            '<div class="bg-black/30 p-3 rounded-xl border border-amber-500/30">' +
              '<h3 class="text-xs uppercase tracking-widest text-amber-300 font-bold mb-2">\ud83c\udf81 Consumables &amp; Services</h3>' +
              '<div id="betaMpShopConsumables" class="space-y-2"></div>' +
            '</div>' +
          '</div>' +
          // Pending-service overlay still mounts to the original betaMpShopList id (kept hidden, used only for service flows)
          '<div id="betaMpShopList" class="hidden"></div>' +
        '</div>';
    } else if (myPick && myPick !== 'continue') {
      const labels = { 'reward-resolved': 'You took the Reward.', 'treasure-resolved': 'You took the Treasure.', 'event-resolved': 'Event resolved.', 'shop-browsing': 'Shopping...' };
      html += '<p class="text-emerald-300 mb-3">' + escapeHtml(labels[myPick] || myPick) + '</p>';
      if (me.eventResult) {
        html += '<p class="text-amber-200 mb-3">' + escapeHtml(me.eventResult.name) + ': ' + escapeHtml(me.eventResult.desc) + (me.eventResult.gold ? ' (' + me.eventResult.gold + 'g)' : '') + '</p>';
      }
    }

    // Continue button:
    //   - not shopping → standard "Continue to Floor N" once a fork is picked
    //   - shopping     → "Done shopping — continue" so the player can leave
    //     the shop without backing out via a different path. Earlier this
    //     button was hidden during shop-browsing, leaving players stuck.
    if (myPick && myPick !== 'shop-browsing') {
      html += '<button id="betaMpContinueForkBtn" class="bg-blue-600 hover:bg-blue-500 px-6 py-2 rounded-lg font-bold">Continue to Floor ' + offer.nextFloor + '</button>';
    } else if (myPick === 'shop-browsing') {
      html += '<button id="betaMpContinueForkBtn" class="bg-blue-600 hover:bg-blue-500 px-6 py-2 rounded-lg font-bold">Done shopping — continue to Floor ' + offer.nextFloor + '</button>';
    }
    // Show waiting status
    const ready = Object.values(s.forkPicks || {}).filter(v => v === 'continue').length;
    const total = s.players.filter(p => !p.eliminated).length;
    html += '<p class="text-xs text-white/60 mt-3">' + ready + '/' + total + ' players ready.</p>';

    fork.innerHTML = html;

    // Wire fork buttons
    fork.querySelectorAll('button[data-fork]').forEach(btn => {
      btn.addEventListener('click', () => {
        socket.emit('beta:pickFork', { choice: btn.dataset.fork });
      });
    });
    const cont = document.getElementById('betaMpContinueForkBtn');
    if (cont) cont.addEventListener('click', () => socket.emit('beta:continueFork'));
    if (isShopBrowsing) renderShopList();
    if (myPick === 'reward-browsing') renderRewardList();
    if (myPick === 'cleanse-browsing') renderCleanseList();
  }

  function renderRewardList() {
    const list = document.getElementById('betaMpRewardList');
    if (!list) return;
    list.innerHTML = '';
    const offer = (lastState.mine && lastState.mine.rewardOffer) || [];
    if (offer.length === 0) {
      list.innerHTML = '<span class="text-xs italic text-rose-300">No jokers available — take the gold.</span>';
    } else {
      for (const item of offer) {
        const row = document.createElement('div');
        row.className = 'bg-black/40 p-3 rounded-xl border border-emerald-500/30';
        row.innerHTML =
          '<div class="font-bold">' + escapeHtml(item.name) + '</div>' +
          '<div class="text-xs text-emerald-200 mt-1 mb-2">' + escapeHtml(item.desc) + '</div>' +
          '<button class="bg-emerald-500 hover:bg-emerald-400 text-black px-3 py-1 rounded font-bold text-sm">Take this joker</button>';
        const btn = row.querySelector('button');
        btn.addEventListener('click', () => socket.emit('beta:rewardPick', { choice: { itemId: item.id } }));
        list.appendChild(row);
      }
    }
    const goldBtn = document.getElementById('betaMpRewardGoldBtn');
    if (goldBtn) goldBtn.addEventListener('click', () => socket.emit('beta:rewardPick', { choice: { gold: true } }));
  }

  function renderCleanseList() {
    const list = document.getElementById('betaMpCleanseList');
    if (!list) return;
    list.innerHTML = '';
    const myDeck = (lastState.mine && lastState.mine.runDeck) || [];
    const candidates = myDeck.filter(c => c.affix);  // only affixed cards are cleansable
    if (candidates.length === 0) {
      list.innerHTML = '<span class="text-xs italic text-rose-300">No affixed cards in your run deck.</span>';
      return;
    }
    for (const c of candidates) {
      const wrap = document.createElement('div');
      wrap.className = 'flex flex-col items-center gap-1';
      const btn = document.createElement('button');
      let cls = 'card card-face flex items-center justify-center text-xl font-bold text-black rounded';
      const ring = affixRingClass(c.affix);
      if (ring) cls += ' ' + ring;
      btn.className = cls;
      btn.textContent = c.rank;
      btn.title = 'Affix: ' + c.affix;
      wrap.appendChild(btn);
      const stripBtn = document.createElement('button');
      stripBtn.className = 'text-xs px-2 py-0.5 rounded bg-cyan-700 hover:bg-cyan-600';
      stripBtn.textContent = 'Strip ' + c.affix;
      stripBtn.addEventListener('click', () => {
        socket.emit('beta:applyCleanse', { target: { runDeckCardId: c.id, action: 'strip' } });
      });
      wrap.appendChild(stripBtn);
      if (c.affix === 'cursed') {
        const rmBtn = document.createElement('button');
        rmBtn.className = 'text-xs px-2 py-0.5 rounded bg-rose-700 hover:bg-rose-600';
        rmBtn.textContent = 'Remove Cursed';
        rmBtn.addEventListener('click', () => {
          socket.emit('beta:applyCleanse', { target: { runDeckCardId: c.id, action: 'removeCursed' } });
        });
        wrap.appendChild(rmBtn);
      }
      list.appendChild(wrap);
    }
  }

  // ===== Boss-relic phase =====
  function renderBossRelicPhase() {
    const s = lastState;
    const fork = document.getElementById('betaMpFork');
    if (!fork) return;
    fork.classList.remove('hidden');
    const offer = s.bossRelicOffer || {};
    const myPicked = (offer.picks && offer.picks[myPlayerId]) || null;
    let html = '<h3 class="text-xl font-bold mb-2">' + escapeHtml(offer.bossName || 'Boss') + ' defeated</h3>' +
               '<p class="text-emerald-200 mb-3">Pick one relic from this boss\'s pool.</p>';
    if (myPicked) {
      html += '<p class="text-emerald-300 mb-3">You took: <b>' + escapeHtml(myPicked) + '</b>. Waiting for others...</p>';
    } else {
      html += '<div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">';
      for (let i = 0; i < (offer.pool_meta || []).length; i++) {
        const r = offer.pool_meta[i];
        if (!r) continue;
        html += '<button data-relicid="' + escapeHtml(offer.pool[i]) + '" class="bg-pink-600 hover:bg-pink-500 px-4 py-3 rounded-lg text-left">' +
                '<div class="font-bold">' + escapeHtml(r.name) + '</div>' +
                '<div class="text-xs text-emerald-100 mt-1">' + escapeHtml(r.desc) + '</div>' +
                '</button>';
      }
      html += '</div>';
    }
    const total = s.players.filter(p => !p.eliminated).length;
    const picked = Object.keys(offer.picks || {}).length;
    html += '<p class="text-xs text-white/60 mt-3">' + picked + '/' + total + ' players have picked.</p>';
    fork.innerHTML = html;
    fork.querySelectorAll('button[data-relicid]').forEach(btn => {
      btn.addEventListener('click', () => socket.emit('beta:pickBossRelic', { relicId: btn.dataset.relicid }));
    });
  }


  // Build a single SP-style shop row for an item.
  function _buildMpShopRow(item, me) {
    const row = document.createElement('div');
    const myJokers = (lastState.mine && lastState.mine.jokers) || [];
    const myRelics = (lastState.mine && lastState.mine.relics) || [];
    const equipped = item.type === 'joker' && myJokers.some(j => j && j.id === item.id);
    const ownedRelic = item.type === 'relic' && myRelics.includes(item.id);
    const slotsFull = item.type === 'joker' && myJokers.every(j => j !== null);
    const inv = (lastState.mine && lastState.mine.inventory) || {};
    const owned = item.type === 'joker' ? (equipped ? 1 : 0)
                : item.type === 'relic' ? (ownedRelic ? 1 : 0)
                : (inv[item.id] || 0);
    const canAfford = me.gold >= item.price;
    const disabled = !item.enabled || !canAfford || equipped || ownedRelic ||
                     (item.type === 'joker' && slotsFull);
    let btnLabel = !item.enabled ? 'Soon' : equipped ? 'Equipped' : ownedRelic ? 'Owned'
                  : (item.type === 'joker' && slotsFull) ? 'Slots full' : 'Buy';
    row.className = 'bg-black/40 hover:bg-black/50 transition p-3 rounded-xl border border-white/10' +
                    (item.enabled ? '' : ' opacity-60');
    const priceColor = canAfford ? 'bg-yellow-400 text-black' : 'bg-rose-500 text-white';
    row.innerHTML =
      '<div class="font-bold">' + escapeHtml(item.name) + '</div>' +
      '<div class="text-xs text-emerald-200 mt-1 mb-2">' + escapeHtml(item.desc) + '</div>' +
      '<div class="flex items-center justify-between">' +
        '<div class="text-xs text-emerald-300">Owned: ' + owned + '</div>' +
        '<div class="flex items-center gap-2">' +
          '<span class="' + priceColor + ' px-2 py-0.5 rounded-full text-xs font-bold">' + item.price + 'g</span>' +
          '<button class="bg-yellow-500 hover:bg-yellow-400 text-black transition px-3 py-1 rounded font-bold text-sm disabled:opacity-40 disabled:cursor-not-allowed"' +
            (disabled ? ' disabled' : '') + '>' + btnLabel + '</button>' +
        '</div>' +
      '</div>';
    if (!disabled) {
      row.querySelector('button').addEventListener('click', () => {
        socket.emit('beta:shopBuy', { itemId: item.id });
      });
    }
    return row;
  }

  // Build a row for a buyable run-deck card (Cards section).
  function _buildMpShopCardRow(off, me) {
    const row = document.createElement('div');
    const deckCount = (lastState.mine && lastState.mine.runDeck && lastState.mine.runDeck.length) || 0;
    const cap = 24;
    const deckFull = deckCount >= cap;
    const canAfford = me.gold >= off.price;
    const bought = !!off.boughtByMe;
    const disabled = bought || !canAfford || deckFull;
    let btnLabel = bought ? 'Bought' : (deckFull ? 'Deck full' : 'Buy');
    const priceColor = canAfford ? 'bg-yellow-400 text-black' : 'bg-rose-500 text-white';
    row.className = 'bg-black/40 hover:bg-black/50 transition p-3 rounded-xl border border-white/10' +
                    (bought ? ' opacity-50' : '');
    const ring = affixRingClass(off.affix);
    const cardHtml =
      '<div class="card card-face flex items-center justify-center text-base font-bold text-black rounded ' + (ring || '') + '" style="width:32px;height:44px;">' + escapeHtml(off.rank) + '</div>';
    row.innerHTML =
      '<div class="flex items-center gap-3 mb-1">' +
        cardHtml +
        '<div>' +
          '<div class="font-bold">' + escapeHtml(off.rank) + (off.affix ? ' \u00b7 ' + escapeHtml(off.affix) : ' \u00b7 plain') + '</div>' +
          '<div class="text-xs text-emerald-200">' + (off.affix ? 'Affixed card joins your run deck.' : 'Plain card joins your run deck.') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="flex items-center justify-between">' +
        '<div class="text-xs text-emerald-300">Run deck: ' + deckCount + ' / ' + cap + '</div>' +
        '<div class="flex items-center gap-2">' +
          '<span class="' + priceColor + ' px-2 py-0.5 rounded-full text-xs font-bold">' + off.price + 'g</span>' +
          '<button class="bg-yellow-500 hover:bg-yellow-400 text-black transition px-3 py-1 rounded font-bold text-sm disabled:opacity-40 disabled:cursor-not-allowed"' + (disabled ? ' disabled' : '') + '>' + btnLabel + '</button>' +
        '</div>' +
      '</div>';
    if (!disabled) {
      row.querySelector('button').addEventListener('click', () => {
        socket.emit('beta:shopBuyCard', { offerId: off.offerId });
      });
    }
    return row;
  }

  function renderShopList() {
    const s = lastState;
    const me = s.players.find(p => p.id === myPlayerId);
    if (!me) return;

    // Render the 3 SP-style sections (jokers / cards / consumables).
    const jokersEl = document.getElementById('betaMpShopJokers');
    const cardsEl  = document.getElementById('betaMpShopCards');
    const consEl   = document.getElementById('betaMpShopConsumables');
    if (jokersEl) {
      jokersEl.innerHTML = '';
      const jokers = (s.shopOffer || []).filter(i => i.type === 'joker');
      if (jokers.length === 0) jokersEl.innerHTML = '<p class="text-xs text-white/40 italic">No jokers in stock.</p>';
      else for (const j of jokers) jokersEl.appendChild(_buildMpShopRow(j, me));
    }
    if (cardsEl) {
      cardsEl.innerHTML = '';
      const cardOffers = (s.shopCardOffer || []);
      if (cardOffers.length === 0) cardsEl.innerHTML = '<p class="text-xs text-white/40 italic">No cards in stock.</p>';
      else for (const off of cardOffers) cardsEl.appendChild(_buildMpShopCardRow(off, me));
    }
    if (consEl) {
      consEl.innerHTML = '';
      const cons = (s.shopOffer || []).filter(i => i.type !== 'joker' && i.type !== 'relic');
      if (cons.length === 0) consEl.innerHTML = '<p class="text-xs text-white/40 italic">No consumables in stock.</p>';
      else for (const c of cons) consEl.appendChild(_buildMpShopRow(c, me));
    }

    // Pending-service overlay still uses the original list element (now hidden
    // unless a service is mid-apply). It mounts above everything via fixed CSS
    // when needed. We re-show it when a pending service exists.
    const list = document.getElementById('betaMpShopList');
    if (!list) return;
    list.innerHTML = '';
    list.classList.add('hidden');
    const pending = s.mine && s.mine.pendingService;
    if (pending) {
      list.classList.remove('hidden');
      const overlay = document.createElement('div');
      overlay.className = 'col-span-full bg-amber-900/40 border border-amber-400 p-3 rounded-xl mb-3';
      overlay.innerHTML = '<div class="font-bold text-amber-200 mb-2">Apply: ' + escapeHtml(pending.itemId) + '</div>';
      // Engraver: rank picker. Other services: card picker.
      if (pending.itemId === 'engraver') {
        const row = document.createElement('div');
        row.className = 'flex gap-2 flex-wrap items-center';
        for (const r of ['A', 'K', 'Q', '10']) {
          const b = document.createElement('button');
          b.className = 'card card-face flex items-center justify-center text-2xl font-bold text-black rounded cursor-pointer hover:scale-105';
          b.textContent = r;
          b.addEventListener('click', () => socket.emit('beta:applyService', { target: { rank: r } }));
          row.appendChild(b);
        }
        overlay.appendChild(row);
      } else {
        const wrap = document.createElement('div');
        wrap.className = 'flex flex-wrap gap-2 items-center';
        const myDeck = (s.mine && s.mine.runDeck) || [];
        const isStripper = pending.itemId === 'stripper';
        const isForger = pending.itemId === 'forger';
        const forgerSourceId = window._forgerSourceId || null;
        const phase = isForger ? (forgerSourceId ? 'target' : 'source') : 'apply';
        let eligible = [];
        if (isForger) {
          eligible = phase === 'source'
            ? myDeck.filter(c => c.rank !== 'J')
            : myDeck.filter(c => c.rank !== 'J' && c.id !== forgerSourceId && c.affix !== 'steel');
          const phaseLabel = document.createElement('div');
          phaseLabel.className = 'col-span-full w-full text-xs text-emerald-200 mb-1';
          phaseLabel.textContent = phase === 'source'
            ? 'Forger — pick the SOURCE card (its rank + affix will be cloned).'
            : 'Forger — pick the TARGET card (becomes a copy of source). Steel cards cannot be changed.';
          wrap.appendChild(phaseLabel);
        } else if (isStripper) {
          eligible = myDeck.filter(c => c.rank !== 'J');
        } else {
          // Affix services: any non-Steel card (with or without existing affix).
          eligible = myDeck.filter(c => c.affix !== 'steel');
        }
        if (eligible.length === 0) {
          wrap.innerHTML = '<span class="text-xs italic text-rose-300">No eligible cards in your run deck.</span>';
        } else {
          for (const c of eligible) {
            const b = document.createElement('button');
            let cls = 'card card-face flex items-center justify-center text-xl font-bold text-black rounded cursor-pointer hover:scale-105';
            const ring = affixRingClass(c.affix);
            if (ring) cls += ' ' + ring;
            b.className = cls;
            b.textContent = c.rank;
            if (c.affix) b.title = 'Affix: ' + c.affix;
            b.addEventListener('click', () => {
              if (isForger && phase === 'source') {
                window._forgerSourceId = c.id;
                socket.emit('beta:applyService', { target: { sourceId: c.id } });
                renderShopList();
              } else if (isForger && phase === 'target') {
                socket.emit('beta:applyService', { target: { targetId: c.id } });
                window._forgerSourceId = null;
              } else {
                socket.emit('beta:applyService', { target: { cardId: c.id } });
              }
            });
            wrap.appendChild(b);
          }
        }
        overlay.appendChild(wrap);
      }
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'mt-2 bg-white/10 hover:bg-white/20 px-3 py-1 rounded text-xs';
      cancelBtn.textContent = 'Cancel (refund)';
      cancelBtn.addEventListener('click', () => socket.emit('beta:cancelService'));
      overlay.appendChild(cancelBtn);
      list.appendChild(overlay);
    }
  }

  // ==================== Live MP deck inspector ====================
  function openMpInspector() {
    if (!lastState || !lastState.mine) return;
    const modal = document.getElementById('betaMpInspectorModal');
    if (!modal) return;
    const order = ['A', 'K', 'Q', '10', 'J'];
    const myDeck = (lastState.mine.runDeck || []).slice().sort((a, b) =>
      order.indexOf(a.rank) - order.indexOf(b.rank));
    const runEl = document.getElementById('betaMpInspectorRun');
    runEl.innerHTML = '';
    for (const c of myDeck) {
      const div = document.createElement('div');
      let cls = 'card card-face flex items-center justify-center text-xl font-bold text-black rounded';
      const ring = affixRingClass(c.affix);
      if (ring) cls += ' ' + ring;
      div.className = cls;
      div.textContent = c.rank;
      div.title = c.rank + (c.affix ? ' (' + c.affix + ')' : '');
      runEl.appendChild(div);
    }
    // Live round summary: hand counts only (we don't see opponents' hands)
    const sum = document.getElementById('betaMpInspectorRound');
    sum.innerHTML = '';
    for (const p of lastState.players) {
      const row = document.createElement('div');
      row.className = 'flex items-center justify-between text-xs bg-black/30 px-2 py-1 rounded';
      row.innerHTML =
        '<span>' + escapeHtml(p.name) + '</span>' +
        '<span class="text-emerald-300">' + p.handCount + ' cards · run deck: ' + p.runDeckCount + '</span>';
      sum.appendChild(row);
    }
    document.getElementById('betaMpInspectorPile').textContent = lastState.pileSize;
    document.getElementById('betaMpInspectorDraw').textContent = lastState.drawSize;
    modal.classList.remove('hidden');
  }
  function closeMpInspector() {
    const modal = document.getElementById('betaMpInspectorModal');
    if (modal) modal.classList.add('hidden');
  }

  function renderGame() {
    const s = lastState;
    document.getElementById('betaMpFloor').textContent = s.currentFloor + '/' + s.totalFloors;
    document.getElementById('betaMpTarget').textContent = s.targetRank || '—';
    document.getElementById('betaMpPileSize').textContent = s.pileSize;
    document.getElementById('betaMpDrawSize').textContent = s.drawSize;
    const burnEl = document.getElementById('betaMpBurnCounter');
    if (burnEl) {
      const cnt = s.burnedCount || 0;
      const cap = s.burnCap || 8;
      burnEl.textContent = cnt + '/' + cap;
      burnEl.style.color = cnt >= cap - 1 ? '#fb923c' : '#67e8f9';
    }

    // Players row
    const playersEl = document.getElementById('betaMpPlayers');
    playersEl.innerHTML = '';
    for (let i = 0; i < s.players.length; i++) {
      const p = s.players[i];
      const isMe = p.id === myPlayerId;
      const isTurn = i === s.currentTurnIdx && !p.eliminated && !p.finishedThisRound;
      const isChallenger = s.challengeOpen && i === s.challengerIdx;
      const card = document.createElement('div');
      let cls = 'bg-black/40 px-3 py-2 rounded text-sm flex flex-col items-center min-w-[140px]';
      if (isTurn) cls += ' ring-2 ring-yellow-400';
      if (isChallenger) cls += ' ring-2 ring-rose-400';
      if (p.eliminated) cls += ' opacity-50';
      card.className = cls;
      card.innerHTML =
        '<div class="font-bold">' + escapeHtml(p.name) + (isMe ? ' (you)' : '') + '</div>' +
        '<div class="text-xs text-emerald-200">' + escapeHtml(p.characterName || '?') + '</div>' +
        '<div class="text-xs mt-1">' +
          '<span class="text-red-400">♥' + p.hearts + '</span> · ' +
          '<span class="text-yellow-300">' + p.gold + 'g</span> · ' +
          '<span class="text-cyan-300">' + p.handCount + ' cards</span>' +
        '</div>' +
        '<div class="text-xs text-white/60">Round wins: ' + p.roundsWon + '</div>';
      playersEl.appendChild(card);
    }

    // My hand
    const handEl = document.getElementById('betaMpHand');
    handEl.innerHTML = '';
    if (s.mine && s.mine.hand) {
      const myIdx = s.players.findIndex(p => p.id === myPlayerId);
      const myTurn = myIdx === s.currentTurnIdx && !s.challengeOpen &&
                     !s.players[myIdx].eliminated && !s.players[myIdx].finishedThisRound;
      for (const c of s.mine.hand) {
        const btn = document.createElement('button');
        let cls = 'relative card card-face flex items-center justify-center text-2xl font-bold text-black rounded transition';
        const ring = affixRingClass(c.affix);
        if (ring) cls += ' ' + ring;
        else if (c.owner === 0 || c.owner === myIdx) cls += ' ring-2 ring-emerald-400';
        if (selected.has(c.id)) cls += ' ring-4 ring-yellow-300 scale-110';
        const cursedLocked = c.affix === 'cursed' && (c.cursedTurnsLeft || 0) > 0;
        if (cursedLocked) cls += ' opacity-50 cursor-not-allowed';
        else if (myTurn) cls += ' cursor-pointer hover:scale-105';
        else cls += ' opacity-70 cursor-not-allowed';
        btn.className = cls;
        btn.innerHTML = escapeHtml(c.rank) +
          (cursedLocked ? '<span class="absolute -top-1 -right-1 bg-purple-700 text-white text-xs px-1 rounded-full">' + c.cursedTurnsLeft + '</span>' : '');
        if (c.affix) btn.title = 'Affix: ' + c.affix + (cursedLocked ? ' (locked ' + c.cursedTurnsLeft + ' turn' + (c.cursedTurnsLeft === 1 ? '' : 's') + ')' : '');
        if (myTurn && !cursedLocked) {
          btn.addEventListener('click', () => {
            if (selected.has(c.id)) selected.delete(c.id);
            else if (selected.size < 3) selected.add(c.id);
            renderGame();
          });
        }
        handEl.appendChild(btn);
      }
    }

    // Action buttons
    const myIdx = s.players.findIndex(p => p.id === myPlayerId);
    const me = s.players[myIdx];
    const myTurn = myIdx === s.currentTurnIdx && !s.challengeOpen &&
                   me && !me.eliminated && !me.finishedThisRound;
    const myCall = s.challengeOpen && myIdx === s.challengerIdx;

    const playBtn = document.getElementById('betaMpPlayBtn');
    const passBtn = document.getElementById('betaMpPassBtn');
    const liarBtn = document.getElementById('betaMpLiarBtn');
    if (playBtn) {
      playBtn.disabled = !myTurn || selected.size === 0 || selected.size > 3;
      playBtn.textContent = myTurn ? `Play ${selected.size || ''} as ${s.targetRank || '?'}`.trim() : 'Wait...';
    }
    if (passBtn) passBtn.disabled = !myCall;
    if (liarBtn) liarBtn.disabled = !myCall;

    // Status text
    const statusEl = document.getElementById('betaMpStatus');
    if (statusEl) {
      let txt = '';
      if (me && me.eliminated) txt = 'You are eliminated. Watching the run...';
      else if (myCall) txt = 'Challenge window: PASS or call LIAR.';
      else if (myTurn) txt = `Your turn. Play 1–3 cards as ${s.targetRank}.`;
      else if (s.challengeOpen) {
        const cp = s.players[s.challengerIdx];
        txt = `Waiting for ${cp ? cp.name : '?'} to call or pass...`;
      } else {
        const cp = s.players[s.currentTurnIdx];
        txt = `Waiting for ${cp ? cp.name : '?'} to play...`;
      }
      statusEl.textContent = txt;
    }

    // Last play summary
    const lastEl = document.getElementById('betaMpLastPlay');
    if (lastEl) {
      if (s.lastPlay) {
        const lp = s.players[s.lastPlay.playerIdx];
        lastEl.textContent =
          (lp ? lp.name : '?') + ' played ' + s.lastPlay.count + ' as ' + s.lastPlay.claim + '.';
      } else {
        lastEl.textContent = '';
      }
    }

    // Log
    const logEl = document.getElementById('betaMpLog');
    if (logEl) {
      logEl.innerHTML = (s.log || []).slice(-15).map(l => '<div>' + escapeHtml(l) + '</div>').join('');
      logEl.scrollTop = logEl.scrollHeight;
    }
    renderGameStatusExtras();

    // Show/hide fork panel based on phase. When in a non-round phase
    // (fork or bossRelic), also hide the in-round game UI so the fork
    // panel takes the full focus — matches the solo experience where
    // the shop replaces the game area instead of stacking below it.
    const forkPanel = document.getElementById('betaMpFork');
    const gamePanel = document.getElementById('betaMpGame');
    const inForkPhase = (s.phase === 'fork') || (s.phase === 'bossRelic');
    if (forkPanel) {
      if (s.phase === 'fork') renderForkPhase();
      else if (s.phase === 'bossRelic' && typeof renderBossRelicPhase === 'function') renderBossRelicPhase();
      else forkPanel.classList.add('hidden');
    }
    if (gamePanel) {
      if (inForkPhase) gamePanel.classList.add('hidden');
      else gamePanel.classList.remove('hidden');
    }

    // Host-only admin panel
    const admPanel = document.getElementById('betaMpAdminPanel');
    if (admPanel) {
      if (s.hostId === myPlayerId) admPanel.classList.remove('hidden');
      else admPanel.classList.add('hidden');
    }
  }

  function renderResult() {
    showResult();
    const titleEl = document.getElementById('betaMpResultTitle');
    const textEl = document.getElementById('betaMpResultText');
    const winnerName = lastState.runWinnerId
      ? (lastState.players.find(p => p.id === lastState.runWinnerId) || {}).name
      : null;
    const iWon = winnerName && lastState.runWinnerId === myPlayerId;
    if (titleEl) titleEl.textContent = winnerName
      ? (iWon ? 'You won the run!' : `${winnerName} won the run`)
      : 'Run over';
    if (textEl) {
      textEl.innerHTML = lastState.players.map(p =>
        '<div>' + escapeHtml(p.name) + ' — Floor ' + lastState.currentFloor +
        ' (♥' + p.hearts + ', ' + p.gold + 'g)</div>'
      ).join('');
    }

    // Report progression for the local player (re-uses solo endpoint)
    reportProgression(winnerName, lastState.currentFloor, iWon);
  }

  async function reportProgression(winnerName, maxFloor, won) {
    const token = getAuthToken();
    if (!token) return;
    try {
      const me = lastState.players.find(p => p.id === myPlayerId) || {};
      await fetch('/api/beta/run-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({
          characterId: me.characterId || null,
          characterName: me.characterName || null,
          result: won ? 'won' : 'lost',
          maxFloor: maxFloor || 1,
          hearts: me.hearts || 0,
          gold: me.gold || 0,
          mode: 'pvp',
        }),
      });
      await fetch('/api/beta/progression', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ maxFloor: maxFloor || 1, runWon: !!won }),
      });
    } catch (e) { /* ignore */ }
  }

  // ==================== UI wiring ====================
  function init() {
    // Open multiplayer entry from beta intro
    const openBtn = document.getElementById('betaMpOpenBtn');
    if (openBtn) {
      openBtn.addEventListener('click', () => {
        const beta = document.getElementById('betaTesting');
        if (beta) beta.classList.remove('hidden');
        const intro = document.getElementById('betaIntro');
        if (intro) intro.classList.add('hidden');
        const game = document.getElementById('betaGame');
        if (game) game.classList.add('hidden');
        ensureSocket();
        showEntry();
      });
    }

    const createBtn = document.getElementById('betaMpCreateBtn');
    if (createBtn) {
      createBtn.addEventListener('click', () => {
        ensureSocket();
        const nameEl = document.getElementById('betaMpName');
        socket.emit('beta:createRoom', { name: nameEl ? nameEl.value : '' });
      });
    }

    const joinBtn = document.getElementById('betaMpJoinBtn');
    if (joinBtn) {
      joinBtn.addEventListener('click', () => {
        ensureSocket();
        const codeEl = document.getElementById('betaMpJoinCode');
        const nameEl = document.getElementById('betaMpName');
        if (!codeEl || !codeEl.value.trim()) {
          alert('Enter a room code.');
          return;
        }
        socket.emit('beta:joinRoom', {
          roomId: codeEl.value.trim().toUpperCase(),
          name: nameEl ? nameEl.value : '',
        });
      });
    }

    const startBtn = document.getElementById('betaMpStartBtn');
    if (startBtn) startBtn.addEventListener('click', () => socket && socket.emit('beta:startRun'));

    const playBtn = document.getElementById('betaMpPlayBtn');
    if (playBtn) playBtn.addEventListener('click', () => {
      if (!socket || selected.size === 0) return;
      socket.emit('beta:play', { cardIds: Array.from(selected) });
      selected.clear();
    });

    const passBtn = document.getElementById('betaMpPassBtn');
    if (passBtn) passBtn.addEventListener('click', () => socket && socket.emit('beta:pass'));

    const liarBtn = document.getElementById('betaMpLiarBtn');
    if (liarBtn) liarBtn.addEventListener('click', () => socket && socket.emit('beta:liar'));

    const leaveBtn = document.getElementById('betaMpLeaveBtn');
    if (leaveBtn) leaveBtn.addEventListener('click', () => {
      if (socket) socket.emit('beta:leave');
      forgetSession();   // explicit leave → don't auto-rejoin on next connect
      myRoomId = null;
      myPlayerId = null;
      lastState = null;
      hideAllMpScreens();
      const intro = document.getElementById('betaIntro');
      if (intro) intro.classList.remove('hidden');
    });

    // Inspector
    const inspBtn = document.getElementById('betaMpInspectorBtn');
    if (inspBtn) inspBtn.addEventListener('click', openMpInspector);
    const inspClose = document.getElementById('betaMpInspectorCloseBtn');
    if (inspClose) inspClose.addEventListener('click', closeMpInspector);
    const inspModal = document.getElementById('betaMpInspectorModal');
    if (inspModal) inspModal.addEventListener('click', (e) => {
      if (e.target === inspModal) closeMpInspector();
    });
    // Tattletale
    const ttBtn = document.getElementById('betaMpTattletaleBtn');
    if (ttBtn) ttBtn.addEventListener('click', useTattletale);
    // Loaded Die
    const ldBtn = document.getElementById('betaMpLoadedDieBtn');
    if (ldBtn) ldBtn.addEventListener('click', () => socket && socket.emit('beta:useLoadedDie'));

    // Admin cheat buttons (host-only — server enforces)
    const admGoldBtn = document.getElementById('betaMpAdmGoldBtn');
    if (admGoldBtn) admGoldBtn.addEventListener('click', () => {
      if (!socket) return;
      const v = parseInt(document.getElementById('betaMpAdmGoldInput').value, 10) || 0;
      socket.emit('beta:adminAddGold', { amount: v });
    });
    const admHeartsBtn = document.getElementById('betaMpAdmHeartsBtn');
    if (admHeartsBtn) admHeartsBtn.addEventListener('click', () => {
      if (!socket) return;
      const v = parseInt(document.getElementById('betaMpAdmHeartsInput').value, 10) || 0;
      socket.emit('beta:adminSetHearts', { hearts: v });
    });
    const admFloorBtn = document.getElementById('betaMpAdmFloorBtn');
    if (admFloorBtn) admFloorBtn.addEventListener('click', () => {
      if (!socket) return;
      const v = parseInt(document.getElementById('betaMpAdmFloorInput').value, 10) || 1;
      socket.emit('beta:adminSkipFloor', { floor: v });
    });

    const resultBackBtn = document.getElementById('betaMpResultBackBtn');
    if (resultBackBtn) resultBackBtn.addEventListener('click', () => {
      if (socket) socket.emit('beta:leave');
      forgetSession();   // run is over — don't auto-rejoin
      myRoomId = null;
      myPlayerId = null;
      lastState = null;
      hideAllMpScreens();
      const intro = document.getElementById('betaIntro');
      if (intro) intro.classList.remove('hidden');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
