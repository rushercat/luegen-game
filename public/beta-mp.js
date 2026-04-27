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
    { id: 'ace',       name: 'The Ace',       passive: 'No special ability.' },
    { id: 'trickster', name: 'The Trickster', passive: 'No special ability.' },
    { id: 'hoarder',   name: 'The Hoarder',   passive: 'Hand size +1 (6 cards).' },
    { id: 'banker',    name: 'The Banker',    passive: 'Start with 150g + a Gilded Ace.' },
    { id: 'bait',      name: 'The Bait',      passive: 'No special ability (yet).' },
    { id: 'gambler',   name: 'The Gambler',   passive: '+50% gold from all sources.' },
  ];

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

  // ==================== Connect ====================
  function ensureSocket() {
    if (socket) return socket;
    const token = getAuthToken();
    socket = io({ auth: { token: token || undefined } });

    socket.on('beta:joined', ({ roomId, playerId }) => {
      myRoomId = roomId;
      myPlayerId = playerId;
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
          socket.emit('beta:pickCharacter', { characterId: c.id });
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
          const txt = (peek.payload.cards || []).map(c => c.rank + (c.affix ? '*' : '')).join(' ');
          alert('Tattletale — ' + peek.payload.target + ":\n" + txt);
        } else if (peek.kind === 'coldRead' || peek.kind === 'handMirror') {
          const txt = (peek.payload || []).map(p => p.player + ': ' + p.rank).join('\n');
          alert((peek.kind === 'coldRead' ? 'Cold Read' : 'Hand Mirror') + ':\n' + txt);
        } else if (peek.kind === 'eavesdropper') {
          alert('Eavesdropper - ' + peek.payload.source + ': ' + peek.payload.bucket + ' matches for the target rank.');
        } else if (peek.kind === 'bait') {
          alert('Bait - ' + peek.payload.player + ': ' + peek.payload.rank);
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
      '<h3 class="text-xl font-bold mb-2">Floor ' + offer.nextFloor + ' approaches</h3>' +
      (offer.nextFloorIsBoss && offer.nextBoss
        ? '<p class="text-rose-300 mb-3">&#128081; Boss next: ' + escapeHtml(offer.nextBoss.name) + ' — ' + escapeHtml(offer.nextBoss.desc) + '</p>'
        : '') +
      '<p class="text-emerald-200 mb-3">Pick one fork. Each player chooses independently.</p>';

    if (!isResolved && !isShopBrowsing) {
      html += '<div class="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">';
      if (offer.hasShop) {
        html += '<button data-fork="shop" class="bg-yellow-600 hover:bg-yellow-500 px-4 py-3 rounded-lg font-bold">&#129689; Shop</button>';
      }
      if (offer.hasReward) {
        html += '<button data-fork="reward" class="bg-emerald-600 hover:bg-emerald-500 px-4 py-3 rounded-lg font-bold">&#128176; Reward (+60g)</button>';
      }
      if (offer.hasTreasure) {
        html += '<button data-fork="treasure" class="bg-pink-600 hover:bg-pink-500 px-4 py-3 rounded-lg font-bold">&#127873; Treasure (+120g + Relic)</button>';
      }
      if (offer.hasEvent) {
        html += '<button data-fork="event" class="bg-purple-600 hover:bg-purple-500 px-4 py-3 rounded-lg font-bold">&#10068; Event</button>';
      }
      html += '</div>';
    } else if (isShopBrowsing) {
      html += '<div class="bg-black/30 p-4 rounded-xl mb-4">' +
              '<h4 class="font-bold mb-2">Shop</h4>' +
              '<div class="text-xs text-emerald-200 mb-3">Your gold: <b>' + (s.players.find(p => p.id === myPlayerId) || {}).gold + 'g</b></div>' +
              '<div id="betaMpShopList" class="grid grid-cols-1 sm:grid-cols-2 gap-2"></div>' +
              '</div>';
    } else if (myPick && myPick !== 'continue') {
      const labels = { 'reward-resolved': 'You took the Reward.', 'treasure-resolved': 'You took the Treasure.', 'event-resolved': 'Event resolved.', 'shop-browsing': 'Shopping...' };
      html += '<p class="text-emerald-300 mb-3">' + escapeHtml(labels[myPick] || myPick) + '</p>';
      if (me.eventResult) {
        html += '<p class="text-amber-200 mb-3">' + escapeHtml(me.eventResult.name) + ': ' + escapeHtml(me.eventResult.desc) + (me.eventResult.gold ? ' (' + me.eventResult.gold + 'g)' : '') + '</p>';
      }
    }

    // Continue button (only after resolved or never picked, but you have to pick first)
    if (myPick && myPick !== 'shop-browsing') {
      html += '<button id="betaMpContinueForkBtn" class="bg-blue-600 hover:bg-blue-500 px-6 py-2 rounded-lg font-bold">Continue to Floor ' + offer.nextFloor + '</button>';
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
  }

  function renderShopList() {
    const s = lastState;
    const list = document.getElementById('betaMpShopList');
    if (!list) return;
    list.innerHTML = '';
    const me = s.players.find(p => p.id === myPlayerId);
    // Pending-service picker — show above the shop grid until applied
    const pending = s.mine && s.mine.pendingService;
    if (pending) {
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
            : myDeck.filter(c => c.rank !== 'J' && c.id !== forgerSourceId);
          const phaseLabel = document.createElement('div');
          phaseLabel.className = 'col-span-full w-full text-xs text-emerald-200 mb-1';
          phaseLabel.textContent = phase === 'source'
            ? 'Forger — pick the SOURCE card (its rank + affix will be cloned).'
            : 'Forger — pick the TARGET card (becomes a copy of source).';
          wrap.appendChild(phaseLabel);
        } else if (isStripper) {
          eligible = myDeck.filter(c => c.rank !== 'J');
        } else {
          eligible = myDeck.filter(c => !c.affix);
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
    for (const item of (s.shopOffer || [])) {
      const canAfford = me.gold >= item.price;
      const myJokers = (s.mine && s.mine.jokers) || [];
      const equipped = item.type === 'joker' && myJokers.some(j => j && j.id === item.id);
      const myRelics = (s.mine && s.mine.relics) || [];
      const ownedRelic = item.type === 'relic' && myRelics.includes(item.id);
      const slotsFull = item.type === 'joker' && myJokers.every(j => j !== null);
      const disabled = !item.enabled || !canAfford || equipped || ownedRelic || (item.type === 'joker' && slotsFull);
      let label = !item.enabled ? 'Soon' : equipped ? 'Equipped' : ownedRelic ? 'Owned' : (slotsFull && item.type === 'joker') ? 'Slots full' : 'Buy';
      const row = document.createElement('div');
      row.className = 'relative bg-black/40 p-3 rounded-xl border border-white/10 text-sm';
      const priceCls = canAfford ? 'bg-yellow-400 text-black' : 'bg-rose-500 text-white';
      row.innerHTML =
        '<div class="absolute -top-2 left-3 px-2 py-0.5 rounded-full text-xs font-bold ' + priceCls + '">' + item.price + 'g</div>' +
        '<div class="font-bold mt-1">' + escapeHtml(item.name) + '</div>' +
        '<div class="text-xs text-emerald-200 mt-1 mb-2">' + escapeHtml(item.desc) + '</div>' +
        '<button class="bg-yellow-500 hover:bg-yellow-400 text-black px-3 py-1 rounded font-bold text-sm disabled:opacity-40 disabled:cursor-not-allowed"' +
          (disabled ? ' disabled' : '') + '>' + label + '</button>';
      const btn = row.querySelector('button');
      if (!disabled) btn.addEventListener('click', () => socket.emit('beta:shopBuy', { itemId: item.id }));
      list.appendChild(row);
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
        let cls = 'card card-face flex items-center justify-center text-2xl font-bold text-black rounded transition';
        const ring = affixRingClass(c.affix);
        if (ring) cls += ' ' + ring;
        else if (c.owner === 0 || c.owner === myIdx) cls += ' ring-2 ring-emerald-400';
        if (selected.has(c.id)) cls += ' ring-4 ring-yellow-300 scale-110';
        if (myTurn) cls += ' cursor-pointer hover:scale-105';
        else cls += ' opacity-70 cursor-not-allowed';
        btn.className = cls;
        btn.textContent = c.rank;
        if (c.affix) btn.title = 'Affix: ' + c.affix;
        if (myTurn) {
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

    // Show/hide fork panel based on phase
    const forkPanel = document.getElementById('betaMpFork');
    if (forkPanel) {
      if (s.phase === 'fork') renderForkPhase();
      else forkPanel.classList.add('hidden');
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

    const resultBackBtn = document.getElementById('betaMpResultBackBtn');
    if (resultBackBtn) resultBackBtn.addEventListener('click', () => {
      if (socket) socket.emit('beta:leave');
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
