// ============================================================
// Lügen — Beta Solo Prototype
//
// Phase 1: core round loop (deal, play, challenge, resolve, win)
// Phase 2: best-of-3 floor + 3 Hearts + 9-floor run frame
//
// Hierarchy: Run → 3 Acts → 9 Floors (best-of-3 rounds each) → Round → Turn.
// 4 players (1 human + 3 simple bots), 30-card deck, 5-card hands.
// First to empty hand wins the round. 4 Jacks = elimination.
// Lose floor = -1 Heart. 0 Hearts = run over.
// ============================================================

(function () {
  'use strict';

  if (!document.getElementById('betaTesting')) return;

  // ---- Config ----
  const RANKS = ['A', 'K', 'Q', '10'];
  const ALL_RANKS = ['A', 'K', 'Q', '10', 'J'];
  const HAND_SIZE = 5;
  const NUM_PLAYERS = 4;
  const CHALLENGE_MS = 5000;
  const JACK_LIMIT = 4;
  const STARTING_HEARTS = 3;
  const TOTAL_FLOORS = 9;
  const ROUNDS_TO_WIN_FLOOR = 2; // best-of-3
  const BOT_NAMES = ['Bot Alice', 'Bot Bob', 'Bot Cleo'];

  // Phase 3: economy
  const GOLD_PLACE_1 = 20;       // 1st-place finisher (emptied hand first)
  const GOLD_PLACE_2 = 10;       // 2nd-place finisher (emptied hand second)
  const GOLD_PER_FLOOR_WIN = 30; // floor win bonus
  const REWARD_NODE_GOLD = 75;

  // Phase 4: run deck — every player has 8 personal cards shuffled
  // into the round deck each round.
  const RUN_DECK_SIZE = 8;

  // Phase 5: characters — pick one at run start. Rookie is the always-
  // available default; the others unlock as you climb floors and win runs.
  const CHARACTER_CATALOG = {
    rookie: {
      id: 'rookie', name: 'The Rookie',
      flavor: "\"Hands shake. The cards don't care. Your first journey.\"",
      passive: 'No special abilities — pure mechanics.',
      startingJoker: null,
      unlockAlways: true,
    },
    sharp: {
      id: 'sharp', name: 'The Sharp',
      flavor: "\"Reads the table before striking. Sees the lie before it lands.\"",
      passive: 'Challenge window +1s.',
      challengeBonusMs: 1000,
      startingJoker: 'tattletale',
      unlockAtFloor: 2,
      unlockHint: 'Reach Floor 2 in any run.',
    },
    hoarder: {
      id: 'hoarder', name: 'The Hoarder',
      flavor: "\"Never met a card worth folding. Holds tight, dies last.\"",
      passive: 'Hand size +1 (6 cards). Jack limit 5.',
      handSizeBonus: 1,
      jackLimitBonus: 1,
      startingJoker: 'slowHand',
      unlockAtFloor: 4,
      unlockHint: 'Reach Floor 4 in any run.',
    },
    banker: {
      id: 'banker', name: 'The Banker',
      flavor: "\"Came in with capital. Every gilded card is just compounding.\"",
      passive: 'Start with 150g + a Gilded Ace in your run deck.',
      startingGold: 150,
      startingGildedA: true,
      startingJoker: 'surveyor',
      unlockAtFloor: 6,
      unlockHint: 'Reach Floor 6 in any run.',
    },
    bait: {
      id: 'bait', name: 'The Bait',
      flavor: "\"Looks like an easy mark. The trap snaps shut the moment you call.\"",
      passive: 'Round start: see 1 random card from a random opponent.',
      peekAtRoundStart: true,
      startingJoker: 'spikedTrap',
      unlockAtFloor: 8,
      unlockHint: 'Reach Floor 8 in any run.',
    },
    gambler: {
      id: 'gambler', name: 'The Gambler',
      flavor: "\"All-in or nothing. The curse is the cost of admission.\"",
      passive: '+50% gold from all sources. Each new floor: 1 Cursed card forced into hand.',
      goldMultiplier: 1.5,
      forcedCursedOnNewFloor: true,
      startingJoker: 'blackHole',
      unlockOnRunWin: true,
      unlockHint: 'Beat Floor 9 (win a full run).',
    },
  };

  // Phase 5+: progression tracking. Prefers server-side state (when the
  // user is signed in), falls back to localStorage for guests.
  const _STORAGE_MAX_FLOOR = 'lugenBetaMaxFloor';
  const _STORAGE_RUN_WON = 'lugenBetaRunWon';
  const _AUTH_TOKEN_KEY = 'lugen-auth-token';
  let _serverProgression = null;  // { maxFloor, runWon, isAdmin } once fetched

  function getAuthToken() {
    try { return localStorage.getItem(_AUTH_TOKEN_KEY) || null; }
    catch (e) { return null; }
  }

  // Local fallbacks
  function getLocalMaxFloor() {
    try { return parseInt(localStorage.getItem(_STORAGE_MAX_FLOOR) || '1', 10); }
    catch (e) { return 1; }
  }
  function setLocalMaxFloor(n) {
    try {
      const cur = getLocalMaxFloor();
      if (n > cur) localStorage.setItem(_STORAGE_MAX_FLOOR, String(n));
    } catch (e) {}
  }
  function getLocalRunWon() {
    try { return localStorage.getItem(_STORAGE_RUN_WON) === 'true'; }
    catch (e) { return false; }
  }
  function setLocalRunWon() {
    try { localStorage.setItem(_STORAGE_RUN_WON, 'true'); } catch (e) {}
  }

  // Fetch progression from the server (no-op if not signed in)
  async function fetchServerProgression() {
    const token = getAuthToken();
    if (!token) { _serverProgression = null; return null; }
    try {
      const r = await fetch('/api/beta/progression', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (!r.ok) { _serverProgression = null; return null; }
      const data = await r.json();
      _serverProgression = data && data.progression ? data.progression : null;
      return _serverProgression;
    } catch (e) {
      _serverProgression = null;
      return null;
    }
  }

  function postServerProgression(payload) {
    const token = getAuthToken();
    if (!token) return Promise.resolve(null);
    return fetch('/api/beta/progression', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify(payload || {})
    }).then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && data.progression) _serverProgression = data.progression;
        return _serverProgression;
      })
      .catch(() => null);
  }

  async function adminUnlockAllRequest() {
    const token = getAuthToken();
    if (!token) return null;
    try {
      const r = await fetch('/api/beta/admin/unlock-all', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (!r.ok) return null;
      const data = await r.json();
      _serverProgression = data && data.progression ? data.progression : null;
      return _serverProgression;
    } catch (e) { return null; }
  }

  // Phase 7: run history fetch + record
  async function fetchRunHistory() {
    const token = getAuthToken();
    if (!token) return [];
    try {
      const r = await fetch('/api/beta/run-history', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (!r.ok) return [];
      const data = await r.json();
      return Array.isArray(data && data.history) ? data.history : [];
    } catch (e) { return []; }
  }

  function postRunHistory(run) {
    const token = getAuthToken();
    if (!token) return Promise.resolve(null);
    return fetch('/api/beta/run-history', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify(run)
    }).then(r => r.ok ? r.json() : null).catch(() => null);
  }

  async function renderRunHistory() {
    const list = document.getElementById('betaRunHistoryList');
    if (!list) return;
    const token = getAuthToken();
    if (!token) {
      list.innerHTML = '<p class="text-xs text-emerald-300 text-center">Sign in to track run history.</p>';
      return;
    }
    list.innerHTML = '<p class="text-xs text-emerald-300 text-center">Loading...</p>';
    const history = await fetchRunHistory();
    if (!history.length) {
      list.innerHTML = '<p class="text-xs text-white/50 text-center italic">No runs recorded yet. Your next run will show up here.</p>';
      return;
    }
    list.innerHTML = '';
    for (const h of history.slice(0, 5)) {
      const row = document.createElement('div');
      const won = h.result === 'won';
      const tone = won ? 'text-emerald-300' : 'text-rose-300';
      const dateLabel = h.date ? new Date(h.date).toLocaleDateString() : '';
      row.className = 'flex items-center justify-between text-xs bg-black/30 px-3 py-1.5 rounded';
      row.innerHTML =
        '<span class="font-bold ' + tone + '">' + (won ? 'WON' : 'LOST') + '</span>' +
        '<span class="text-white/80">' + escapeHtml(h.characterName || h.characterId || '?') + '</span>' +
        '<span class="text-white/60">Floor ' + h.maxFloor + '</span>' +
        '<span class="text-white/40">' + escapeHtml(dateLabel) + '</span>';
      list.appendChild(row);
    }
  }

  // Public accessors used by the rest of the code
  function getMaxFloorReached() {
    if (_serverProgression) return _serverProgression.maxFloor || 1;
    return getLocalMaxFloor();
  }
  function setMaxFloorReached(n) {
    setLocalMaxFloor(n);
    // Fire-and-forget server update
    postServerProgression({ maxFloor: n });
  }
  function hasWonRun() {
    if (_serverProgression) return !!_serverProgression.runWon;
    return getLocalRunWon();
  }
  function setRunWon() {
    setLocalRunWon();
    postServerProgression({ runWon: true });
  }
  function isCurrentUserAdmin() {
    return !!(_serverProgression && _serverProgression.isAdmin);
  }
  function isCharUnlocked(char) {
    if (char.unlockAlways) return true;
    if (char.unlockOnRunWin) return hasWonRun();
    if (char.unlockAtFloor !== undefined) {
      return getMaxFloorReached() >= char.unlockAtFloor;
    }
    return true;
  }

  // Phase 8+: floor modifiers (Act 2+ on non-boss floors)
  const FLOOR_MODIFIERS = {
    foggy:   { id: 'foggy',   name: 'Foggy',   desc: 'Target rank fades after 5 seconds.' },
    greedy:  { id: 'greedy',  name: 'Greedy',  desc: '+100% gold, but Jack limit drops to 3.' },
    brittle: { id: 'brittle', name: 'Brittle', desc: 'Every card is temporarily Glass for this floor.' },
    echoing: { id: 'echoing', name: 'Echoing', desc: 'Each play: 20% chance the first card is flashed to all players.' },
    silent:  { id: 'silent',  name: 'Silent',  desc: 'No bot tells are visible this floor.' },
    tariff:  { id: 'tariff',  name: 'Tariff',  desc: 'Each Liar call you make costs 5g.' },
  };

  // Phase 8+: AI bot personalities — each teaches a different kind of read
  const PERSONALITY_CATALOG = {
    greedy:     { id: 'greedy',     name: 'Greedy',     bluffRate: 0.55, challengeRate: 0.20, tell: 'eyes the gold counter before this play' },
    coward:     { id: 'coward',     name: 'Coward',     bluffRate: 0.40, challengeRate: 0.05, tell: 'hesitates uneasily' },
    eager:      { id: 'eager',      name: 'Eager',      bluffRate: 0.50, challengeRate: 0.65, tell: 'fingers twitch over the LIAR button' },
    methodical: { id: 'methodical', name: 'Methodical', bluffRate: 0.25, challengeRate: 0.20, tell: 're-sorts their hand' },
    mimic:      { id: 'mimic',      name: 'Mimic',      bluffRate: 0.50, challengeRate: 0.30, tell: 'glances at you' },
    wildcard:   { id: 'wildcard',   name: 'Wildcard',   bluffRate: 0.50, challengeRate: 0.40, tell: 'shrugs (might mean anything)' },
  };

  // Phase 8+: bosses on Floor 3, 6, 9
  const BOSS_CATALOG = {
    auditor: { id: 'auditor', name: 'The Auditor', floor: 3, bluffRate: 0.30, challengeRate: 1.00, tell: 'always challenges — predictable', desc: 'Challenges every play.' },
    cheater: { id: 'cheater', name: 'The Cheater', floor: 6, bluffRate: 1.00, challengeRate: 0.30, tell: 'a tiny smirk on 1-in-4 lies', desc: 'Lies on every play.' },
    lugen:   { id: 'lugen',   name: 'Lugen',       floor: 9, bluffRate: 0.50, challengeRate: 0.50, tell: null, desc: 'No tells. Pure math. The final boss.' },
  };

  function isBossFloor(f) { return f === 3 || f === 6 || f === 9; }
  function getBoss(f) {
    for (const id of Object.keys(BOSS_CATALOG)) {
      if (BOSS_CATALOG[id].floor === f) return BOSS_CATALOG[id];
    }
    return null;
  }
  function getCurrentAct() {
    if (!runState) return 1;
    if (runState.currentFloor <= 3) return 1;
    if (runState.currentFloor <= 6) return 2;
    return 3;
  }
  function shouldShowTells() {
    if (runState && runState.currentFloorModifier === 'silent') return false;
    return getCurrentAct() <= 2;  // Act 3 = no tells
  }
  function getBotPersonality(botIdx) {
    if (!runState || !runState.botPersonalities) return null;
    return runState.botPersonalities[botIdx] || null;
  }

  // Phase 7+: relics — permanent passive bonuses (one of each per run)
  const RELIC_CATALOG = {
    crackedCoin: { id: 'crackedCoin', name: 'Cracked Coin', price: 200, desc: 'Each round start: gain 5g × Hearts remaining.' },
    loadedDie:   { id: 'loadedDie',   name: 'Loaded Die',   price: 200, desc: 'Once per floor, reroll the Target Rank for the current round.' },
    pocketWatch: { id: 'pocketWatch', name: 'Pocket Watch', price: 200, desc: 'Your challenge window is +5 seconds (stacks).' },
    handMirror:  { id: 'handMirror',  name: 'Hand Mirror',  price: 250, desc: 'At round start, see one random card from each opponent.' },
    ironStomach: { id: 'ironStomach', name: 'Iron Stomach', price: 300, desc: 'Glass-burned run-deck cards return as Steel at end of round.' },
    ledger:      { id: 'ledger',      name: 'The Ledger',   price: 300, desc: '+25% gold from all sources (stacks with Gambler).' },
  };

  const HEART_SHARDS_REQUIRED = 3;     // 3 shards = +1 Heart
  const LEDGER_GOLD_MULT = 1.25;       // The Ledger relic multiplier
  const BURN_CAP = 8;                  // Max burned cards per round before recycling
  const TREASURE_CHANCE_ACT_III = 0.33; // Act III non-boss floors swap Reward for Treasure

  // Phase 5: jokers — passive/triggered perks held in 2 slots
  const JOKER_CATALOG = {
    surveyor: { id: 'surveyor', name: 'The Surveyor', rarity: 'Common', price: 80, desc: "See the top card of the draw pile at all times." },
    slowHand: { id: 'slowHand', name: 'Slow Hand', rarity: 'Common', price: 80, desc: "Your challenge window is 10 seconds (default 5)." },
    taxman: { id: 'taxman', name: 'The Taxman', rarity: 'Common', price: 80, desc: "When an opponent picks up a pile of 5+ cards, you gain 10g." },
    eavesdropper: { id: 'eavesdropper', name: 'Eavesdropper', rarity: 'Uncommon', price: 150, desc: "Every 2 rounds, when the player before you plays, see whether their hand has NONE / SOME (1-2) / MANY (3+) matches for the Target." },
    scapegoat: { id: 'scapegoat', name: 'The Scapegoat', rarity: 'Uncommon', price: 150, desc: "If you are caught lying with a Jack, the Jack(s) go to the challenger's hand. The rest of the pile still goes to you." },
    hotSeat: { id: 'hotSeat', name: 'Hot Seat', rarity: 'Uncommon', price: 150, desc: "Your right neighbor's challenge window is 3 seconds (default 5)." },
    sleightOfHand: { id: 'sleightOfHand', name: 'Sleight of Hand', rarity: 'Uncommon', price: 150, desc: "Once per round, on your turn, draw 1 card from the top of the draw pile." },
    spikedTrap: { id: 'spikedTrap', name: 'Spiked Trap', rarity: 'Rare', price: 250, desc: "If you tell the truth and are challenged, the challenger draws 3 extra cards." },
    tattletale: { id: 'tattletale', name: 'Tattletale', rarity: 'Rare', price: 250, desc: "Once per floor, peek at a player's full hand for 4 seconds." },
    safetyNet: { id: 'safetyNet', name: 'Safety Net', rarity: 'Rare', price: 250, desc: "Your Jack limit is increased by 1 (4 -> 5, stacks with Hoarder)." },
    doubletalk: { id: 'doubletalk', name: 'Doubletalk', rarity: 'Rare', price: 250, desc: "Once per round, declare a double-turn: play 2-4 cards instead of 1-3." },
    blackHole: { id: 'blackHole', name: 'Black Hole', rarity: 'Legendary', price: 400, desc: "On a successful Jack bluff (no challenge), delete one non-Jack card from your hand." },
    coldRead: { id: 'coldRead', name: 'Cold Read', rarity: 'Legendary', price: 400, desc: "At the start of each round, see one random card from each opponent's hand." },
    vengefulSpirit: { id: 'vengefulSpirit', name: 'Vengeful Spirit', rarity: 'Legendary', price: 400, desc: "If the Jack curse eliminates you, the next active player is also eliminated." },
  };
  const SLOW_HAND_WINDOW_MS = 10000;
  const SPIKED_TRAP_DRAWS = 3;
  const TATTLETALE_CHARGES_PER_FLOOR = 1;
  const TATTLETALE_PEEK_MS = 4000;

  // Phase 5: affixes
  const GOLD_PER_GILDED_PER_TURN = 2;   // Gilded: +2g per held card at each turn start
  const SPIKED_DRAWS_ON_PICKUP = 1;     // Spiked: +1 draw per Spiked picked up
  const GLASS_BURN_RANDOM = 2;          // Glass: burn 2 random non-Steel pile cards

  // Singleplayer pacing — solo runs are tuned to feel snappy.
  // Reduce these further if bots still drag.
  const BOT_TURN_DELAY_MS = 400;
  const BOT_CHALLENGE_DELAY_MIN_MS = 500;
  const BOT_CHALLENGE_DELAY_RAND_MS = 700;
  const REVEAL_HOLD_MS = 1500;

  // Phase 3: shop catalogue. Only Smoke Bomb is wired up to actually do
  // something; the others are visible but disabled until Phase 4.
  const SHOP_ITEMS = [
    {
      id: 'smokeBomb',
      name: 'Smoke Bomb',
      price: 35,
      desc: 'Skip your turn. Useful when your hand is bad and you do not want to take the pile.',
      enabled: true,
    },
    {
      id: 'counterfeit',
      name: 'Counterfeit',
      price: 35,
      desc: 'Change the target rank now AND lock it through the next Liar call (target survives one rotation). Once per round.',
      enabled: true,
    },
    {
      id: 'jackBeNimble',
      name: 'Jack-be-Nimble',
      price: 90,
      desc: 'Discard up to 2 Jacks from your hand. Use anytime on your turn.',
      enabled: true,
    },
    {
      id: 'glassShard',
      name: 'Glass Shard',
      price: 30,
      desc: 'Apply Glass to a run-deck card. On reveal, burns itself + 2 random pile cards.',
      enabled: true,
      type: 'service',
    },
    {
      id: 'forger',
      name: 'Forger',
      price: 100,
      desc: 'Clone one run-deck card onto another (rank + affix). No Jacks. Permanent.',
      enabled: true,
      type: 'service',
    },
    { id: 'spikedWire',   name: 'Spiked Wire',   price: 30,  desc: 'Apply Spiked to a run-deck card (on pickup, taker draws +1).', enabled: true, type: 'service' },
    { id: 'steelPlating', name: 'Steel Plating', price: 50,  desc: 'Apply Steel to a run-deck card (immune to Glass burns and many effects).', enabled: true, type: 'service' },
    { id: 'mirageLens',   name: 'Mirage Lens',   price: 200, desc: 'Apply Mirage to a run-deck card (one-time wildcard, removed after play).', enabled: true, type: 'service' },
    { id: 'stripper',     name: 'Stripper',     price: 60,  desc: 'Permanently remove one card from your run deck (no Jacks).', enabled: true, type: 'service' },
    { id: 'tracer',        name: 'Tracer',         price: 40,  desc: 'See the top 3 cards of the draw pile and rearrange them.', enabled: true, type: 'service' },
    { id: 'devilsBargain', name: 'Devil\'s Bargain', price: 55, desc: 'Drop a hand card to the bottom of the draw pile; draw the top card with the Cursed affix.', enabled: true, type: 'service' },
    { id: 'magnet',        name: 'Magnet',         price: 75,  desc: 'Give one hand card (your choice, not Steel) to a random opponent.', enabled: true, type: 'service' },
    { id: 'crackedCoin',   name: 'RELIC · Cracked Coin', price: 200, desc: '[Relic] Each round start: gain 5g × Hearts remaining.', enabled: true, type: 'relic' },
    { id: 'loadedDie',     name: 'RELIC · Loaded Die',   price: 200, desc: '[Relic] Once per floor, reroll the Target Rank.',     enabled: true, type: 'relic' },
    { id: 'pocketWatch',   name: 'RELIC · Pocket Watch', price: 200, desc: '[Relic] +5 seconds challenge window (stacks).',       enabled: true, type: 'relic' },
    { id: 'handMirror',    name: 'RELIC · Hand Mirror',  price: 250, desc: '[Relic] Round start: see 1 random card from each opponent.', enabled: true, type: 'relic' },
    { id: 'ironStomach',   name: 'RELIC · Iron Stomach', price: 300, desc: '[Relic] Glass-burned run-deck cards return as Steel at end of round.', enabled: true, type: 'relic' },
    { id: 'ledger',        name: 'RELIC · The Ledger',   price: 300, desc: '[Relic] +25% gold from all sources (stacks).',         enabled: true, type: 'relic' },
    // Phase 5: jokers in the shop. Each joker has a unique id matching JOKER_CATALOG.
    { id: 'surveyor',     name: 'JOKER · Surveyor',        price: 80,  desc: '[Common] See top of draw pile.',                              enabled: true, type: 'joker' },
    { id: 'slowHand',     name: 'JOKER · Slow Hand',       price: 80,  desc: '[Common] Challenge window 10s.',                              enabled: true, type: 'joker' },
    { id: 'taxman',       name: 'JOKER · The Taxman',      price: 80,  desc: '[Common] Opponent takes 5+ pile = +10g.',                     enabled: true, type: 'joker' },
    { id: 'eavesdropper', name: 'JOKER · Eavesdropper',    price: 150, desc: '[Uncommon] Every 2 rounds: fuzzy match count from prev player.',enabled: true, type: 'joker' },
    { id: 'scapegoat',    name: 'JOKER · The Scapegoat',   price: 150, desc: '[Uncommon] Caught lying with Jack? Jack goes to challenger.', enabled: true, type: 'joker' },
    { id: 'hotSeat',      name: 'JOKER · Hot Seat',        price: 150, desc: '[Uncommon] Right neighbor has 3s window.',                    enabled: true, type: 'joker' },
    { id: 'sleightOfHand',name: 'JOKER · Sleight of Hand', price: 150, desc: '[Uncommon] Once per round: draw 1 card.',                      enabled: true, type: 'joker' },
    { id: 'spikedTrap',   name: 'JOKER · Spiked Trap',     price: 250, desc: '[Rare] Truth + challenged = challenger draws +3.',            enabled: true, type: 'joker' },
    { id: 'tattletale',   name: 'JOKER · Tattletale',      price: 250, desc: '[Rare] Once per floor: peek at a hand for 4s.',               enabled: true, type: 'joker' },
    { id: 'safetyNet',    name: 'JOKER · Safety Net',      price: 250, desc: '[Rare] Jack limit +1 (stacks with Hoarder).',                  enabled: true, type: 'joker' },
    { id: 'doubletalk',   name: 'JOKER · Doubletalk',      price: 250, desc: '[Rare] Once per round: play 2-4 cards.',                      enabled: true, type: 'joker' },
    { id: 'blackHole',    name: 'JOKER · Black Hole',      price: 400, desc: '[Legendary] Successful Jack bluff: delete a non-Jack.',       enabled: true, type: 'joker' },
    { id: 'coldRead',     name: 'JOKER · Cold Read',       price: 400, desc: '[Legendary] Round start: see 1 card from each opponent.',      enabled: true, type: 'joker' },
    { id: 'vengefulSpirit',name:'JOKER · Vengeful Spirit', price: 400, desc: '[Legendary] Jack-cursed = drag next active player down.',      enabled: true, type: 'joker' },
  ];

  // Phase 3: random events at the Event fork node.
  const EVENTS = [
    {
      title: 'Found Coins',
      text: 'You spot a few coins on the floor before sitting down at the next table.',
      run: () => { const g = addGold(30); return '+' + g + 'g'; },
    },
    {
      title: 'Generous Drunk',
      text: 'A patron buys you a drink and slips a tip into your pocket.',
      run: () => { const g = addGold(50); return '+' + g + 'g'; },
    },
    {
      title: "Charlatan's Bet",
      text: 'A stranger offers a coinflip: pay 25g, win 75g on heads.',
      run: () => {
        const cost = Math.min(runState.gold, 25);
        runState.gold -= cost;
        if (Math.random() < 0.5) {
          const g = addGold(75);
          return '-' + cost + 'g, +' + g + 'g (heads)';
        }
        return '-' + cost + 'g (tails)';
      },
    },
    {
      title: 'Pickpocket',
      text: 'Someone bumps into you in the crowd and slips out with some of your gold.',
      run: () => {
        const loss = Math.min(runState.gold, 20);
        runState.gold -= loss;
        return '-' + loss + 'g';
      },
    },
  ];

  // ---- State ----
  let runState = null;          // run-level: hearts, floor, round wins
  let state = null;             // round-level: hands, pile, turn, etc.
  let challengeTimer = null;
  let challengeBarTimer = null;
  let revealTimer = null;
  let selected = new Set();
  let resultContinueHandler = null;

  // ============================================================
  // Run lifecycle
  // ============================================================

  // Phase 8+: assign random personalities to bots; bosses override on boss floors
  function assignBotPersonalities() {
    if (!runState) return;
    const ids = Object.keys(PERSONALITY_CATALOG);
    runState.botPersonalities = [null];
    for (let i = 1; i < NUM_PLAYERS; i++) {
      runState.botPersonalities[i] = ids[Math.floor(Math.random() * ids.length)];
    }
    // Boss floor: bot 1 becomes the boss
    const boss = getBoss(runState.currentFloor);
    if (boss) {
      runState.botPersonalities[1] = boss.id;
    }
  }

  function startRun(characterId) {
    const character = (characterId && CHARACTER_CATALOG[characterId]) || null;
    runState = {
      hearts: STARTING_HEARTS,
      currentFloor: 1,
      roundsWon: new Array(NUM_PLAYERS).fill(0),
      gold: (character && character.startingGold) || 0,
      inventory: { smokeBomb: 0, counterfeit: 0, jackBeNimble: 0 },
      runDeck: buildInitialRunDeck(0),
      jokers: [null, null],
      tattletaleChargesThisFloor: 0,
      character: character,
      eavesdropperLastFiredRound: -99,
      relics: [],
      heartShards: 0,
      loadedDieUsedThisFloor: false,
      currentFloorModifier: null,    // Phase 8+
      botPersonalities: [null, null, null, null],  // Phase 8+
    };

    // Assign initial bot personalities
    assignBotPersonalities();

    if (character) {
      if (character.startingGildedA) {
        const aCard = runState.runDeck.find(c => c.rank === 'A' && !c.affix);
        if (aCard) aCard.affix = 'gilded';
      }
      if (character.startingJoker) {
        const jokerData = JOKER_CATALOG[character.startingJoker];
        if (jokerData) {
          equipJoker(jokerData);
          if (character.startingJoker === 'tattletale') {
            runState.tattletaleChargesThisFloor = TATTLETALE_CHARGES_PER_FLOOR;
          }
        }
      }
    }

    startRound();
    if (character) {
      log('Character: ' + character.name + ' \u2014 ' + character.passive);
    }
  }

  function endRun(victory) {
    const won = victory === true;
    if (won) setRunWon();  // Phase 5+: unlock Gambler on first run win
    // Phase 7: record run history (server-side, fire-and-forget)
    if (runState) {
      postRunHistory({
        characterId: runState.character ? runState.character.id : null,
        characterName: runState.character ? runState.character.name : null,
        result: won ? 'won' : 'lost',
        maxFloor: runState.currentFloor || 1,
        hearts: runState.hearts,
        gold: runState.gold
      });
    }
    showResultModal({
      tone: won ? 'win' : 'lose',
      title: won ? 'Run complete!' : 'Run over',
      text: won
        ? 'You cleared all ' + TOTAL_FLOORS + ' floors with ' +
          runState.hearts + ' Heart' + (runState.hearts === 1 ? '' : 's') + ' remaining.'
        : 'You ran out of Hearts on Floor ' + runState.currentFloor + '.',
      subtitle: '',
      buttonLabel: 'New run',
      onContinue: backToIntro,
    });
  }

  function backToIntro() {
    document.getElementById('betaResult').classList.add('hidden');
    document.getElementById('betaFork').classList.add('hidden');
    document.getElementById('betaShop').classList.add('hidden');
    document.getElementById('betaReward').classList.add('hidden');
    document.getElementById('betaEvent').classList.add('hidden');
    document.getElementById('betaGame').classList.add('hidden');
    const cs = document.getElementById('betaCharSelect');
    if (cs) cs.classList.add('hidden');
    document.getElementById('betaIntro').classList.remove('hidden');
    runState = null;
    state = null;
    selected.clear();
  }

  // ============================================================
  // Round lifecycle
  // ============================================================

  function startRound() {
    clearAllTimers();
    selected.clear();

    const deck = buildDeck();
    const { hands, drawPile } = deal(deck);
    applyJackFairness(hands, drawPile);

    // Phase 8+: Brittle modifier — every card becomes Glass for this round
    if (runState && runState.currentFloorModifier === 'brittle') {
      for (const hand of hands) {
        for (const c of hand) c.affix = 'glass';
      }
      for (const c of drawPile) c.affix = 'glass';
    }

    // Phase 5: Gambler — first round of a new floor forces a Cursed card
    // into the human's hand
    let gamblerCursedRank = null;
    if (runState && runState.character && runState.character.forcedCursedOnNewFloor &&
        runState.roundsWon.every(w => w === 0)) {
      gamblerCursedRank = ['A','K','Q','10'][Math.floor(Math.random()*4)];
      hands[0].push({
        rank: gamblerCursedRank,
        id: 'gambler_curse_' + Date.now() + '_' + Math.floor(Math.random()*1000),
        owner: 0,
        affix: 'cursed',
      });
    }
    const targetRank = RANKS[Math.floor(Math.random() * RANKS.length)];
    // Phase 5: Gilded now triggers on every turn start (see triggerGildedTurn).
    // Round-start gold accrues via the first turn's trigger.

    state = {
      hands,
      drawPile,
      targetRank,
      pile: [],
      lastPlay: null,
      currentTurn: 0,
      eliminated: new Array(NUM_PLAYERS).fill(false),
      finished: new Array(NUM_PLAYERS).fill(false),
      placements: [],          // ordered list of player indices who emptied their hand
      counterfeitUsed: false,  // Phase 4: Counterfeit is once per round
      counterfeitLock: false,  // Phase 4: when true, next rotateTargetRank() is suppressed
      echoArmedFor: -1,        // Phase 7+: player armed by Echo
      doubletalkArmed: false,  // Phase 7+: 2-4 cards this turn
      doubletalkUsedThisRound: false,
      sleightUsedThisRound: false,
      ironStomachBurned: [],   // Phase 7+: human's run-deck card IDs burned by Glass this round
      burnedCards: [],         // Phase 8+: cards burned this round (for burn cap recycling)
      gameOver: false,
      challengeOpen: false,
      challengerIdx: -1,
      log: [],
    };

    log('— Floor ' + runState.currentFloor + ', Round ' +
        (totalRoundsPlayed() + 1) +
        ' —  Target: ' + targetRank);

    if (hasJoker('coldRead')) {
      const peeks = [];
      for (let i = 1; i < NUM_PLAYERS; i++) {
        if (state.hands[i].length > 0) {
          const c = state.hands[i][Math.floor(Math.random() * state.hands[i].length)];
          peeks.push(playerLabel(i) + ': ' + c.rank);
        }
      }
      if (peeks.length > 0) log('Cold Read — ' + peeks.join(', ') + '.');
    }
    // Phase 7+: Cracked Coin relic
    if (hasRelic('crackedCoin')) {
      const got = addGold(5 * runState.hearts);
      if (got > 0) log('Cracked Coin: +' + got + 'g (' + runState.hearts + ' hearts).');
    }
    // Phase 7+: Hand Mirror relic — like Cold Read but a separate effect
    if (hasRelic('handMirror')) {
      const peeks = [];
      for (let i = 1; i < NUM_PLAYERS; i++) {
        if (state.hands[i].length > 0) {
          const c = state.hands[i][Math.floor(Math.random() * state.hands[i].length)];
          peeks.push(playerLabel(i) + ': ' + c.rank);
        }
      }
      if (peeks.length > 0) log('Hand Mirror — ' + peeks.join(', ') + '.');
    }

    // Phase 5: Bait peek — see one random card from a random opponent
    if (runState && runState.character && runState.character.peekAtRoundStart) {
      const others = [];
      for (let i = 1; i < NUM_PLAYERS; i++) {
        if (state.hands[i].length > 0 && !state.eliminated[i]) others.push(i);
      }
      if (others.length > 0) {
        const target = others[Math.floor(Math.random() * others.length)];
        const card = state.hands[target][Math.floor(Math.random() * state.hands[target].length)];
        log("Bait's eye: " + playerLabel(target) + ' has a ' + card.rank +
            (card.affix ? ' (' + card.affix + ')' : '') + '.');
      }
    }
    if (gamblerCursedRank) {
      log("Gambler's curse: a Cursed " + gamblerCursedRank + ' is forced into your hand.');
    }

    document.getElementById('betaIntro').classList.add('hidden');
    document.getElementById('betaGame').classList.remove('hidden');
    document.getElementById('betaResult').classList.add('hidden');
    document.getElementById('betaReveal').innerHTML = '';

    triggerGildedTurn();  // Phase 5: first turn triggers Gilded too
    render();
    // Phase 8+: Foggy — hide target rank after 5 seconds
    if (runState && runState.currentFloorModifier === 'foggy') {
      state.foggyHidden = false;
      setTimeout(() => {
        if (state) { state.foggyHidden = true; render(); }
      }, 5000);
    }
    if (state.currentTurn !== 0) setTimeout(botTurn, BOT_TURN_DELAY_MS);
  }

  function endRound(winnerIdx, message) {
    if (!state || state.gameOver) return;
    state.gameOver = true;
    state.challengeOpen = false;
    clearAllTimers();

    // Phase 7+: Iron Stomach — restore Glass-burned run-deck cards as Steel
    if (hasRelic('ironStomach') && state.ironStomachBurned && state.ironStomachBurned.length > 0) {
      let restored = 0;
      const seen = new Set();
      for (const id of state.ironStomachBurned) {
        if (seen.has(id)) continue;
        seen.add(id);
        const card = runState.runDeck.find(c => c.id === id);
        if (card) {
          card.affix = 'steel';
          restored++;
        }
      }
      if (restored > 0) {
        log('Iron Stomach: ' + restored + ' burned card(s) restored as Steel for next round.');
      }
    }

    const humanWonRound = winnerIdx === 0;
    const humanPlace = state.placements.indexOf(0);

    // Placement gold: 1st = 20g, 2nd = 10g, others 0g.
    // Only the human's placements pay out — bots don't shop yet.
    if (humanPlace === 0) {
      const got = addGold(GOLD_PLACE_1);
      log('You finish 1st: +' + got + 'g.');
    } else if (humanPlace === 1) {
      const got = addGold(GOLD_PLACE_2);
      log('You finish 2nd: +' + got + 'g.');
    }
    runState.roundsWon[winnerIdx]++;

    log('Round result: ' + (humanWonRound ? 'WON' : 'LOST') +
        ' — ' + scoreLine());
    if (state._gildedRoundEarnings && state._gildedRoundEarnings > 0) {
      log('Gilded earned this round: +' + state._gildedRoundEarnings + 'g.');
    }

    const leaderIdx = runState.roundsWon.findIndex(w => w >= ROUNDS_TO_WIN_FLOOR);
    const floorDecided = leaderIdx !== -1;

    if (floorDecided) {
      endFloor(leaderIdx === 0, message, leaderIdx);
    } else {
      const roundNum = totalRoundsPlayed();
      let tone, title;
      if (humanPlace === 0) {
        tone = 'win';
        title = 'Round won — +' + GOLD_PLACE_1 + 'g';
      } else if (humanPlace === 1) {
        tone = 'neutral';
        title = '2nd place — +' + GOLD_PLACE_2 + 'g';
      } else {
        tone = 'lose';
        title = 'Round lost';
      }
      showResultModal({
        tone: tone,
        title: title,
        text: message,
        subtitle: 'Floor ' + runState.currentFloor +
          ' · ' + scoreLine() +
          ' (round ' + roundNum + ' of best-of-3)',
        buttonLabel: 'Next round',
        onContinue: () => {
          document.getElementById('betaResult').classList.add('hidden');
          startRound();
        },
      });
    }
    render();
  }

  function totalRoundsPlayed() {
    return runState.roundsWon.reduce((a, b) => a + b, 0);
  }

  function scoreLine() {
    const labels = ['You', BOT_NAMES[0].replace('Bot ', ''),
                    BOT_NAMES[1].replace('Bot ', ''),
                    BOT_NAMES[2].replace('Bot ', '')];
    return labels.map((l, i) => l + ' ' + runState.roundsWon[i]).join(' · ');
  }

  // ============================================================
  // Floor lifecycle
  // ============================================================

  function endFloor(humanWonFloor, lastRoundMessage, winnerIdx) {
    const winnerLabel = playerLabel(winnerIdx);
    if (humanWonFloor) {
      const floorBonus = addGold(GOLD_PER_FLOOR_WIN);
      log('Floor ' + runState.currentFloor + ' WON. +' + floorBonus +
          'g (now ' + runState.gold + 'g).');
    } else {
      runState.hearts--;
      log('Floor ' + runState.currentFloor + ' LOST to ' + winnerLabel +
          '. -1 Heart (' + runState.hearts + ' left).');
    }

    if (runState.hearts <= 0) {
      endRun(false);
      return;
    }

    // Phase 7+: Heart shard — winning a floor while at 1 Heart awards a shard.
    // 3 shards = +1 Heart restored.
    if (humanWonFloor && runState.hearts === 1) {
      runState.heartShards = (runState.heartShards || 0) + 1;
      log('Heart shard earned! (' + runState.heartShards + '/' + HEART_SHARDS_REQUIRED + ')');
      if (runState.heartShards >= HEART_SHARDS_REQUIRED) {
        runState.hearts++;
        runState.heartShards = 0;
        log('Heart restored from shards!');
      }
    }

    const floorJustFinished = runState.currentFloor;
    runState.currentFloor++;
    runState.roundsWon = new Array(NUM_PLAYERS).fill(0);
    runState.loadedDieUsedThisFloor = false;  // Phase 7+: reset Loaded Die per floor
    runState.tattletaleChargesThisFloor =
      hasJoker('tattletale') ? TATTLETALE_CHARGES_PER_FLOOR : 0;
    setMaxFloorReached(runState.currentFloor);

    // Phase 8+: pick floor modifier (Act 2+ only on non-boss floors)
    if (runState.currentFloor >= 4 && !isBossFloor(runState.currentFloor)) {
      const ids = Object.keys(FLOOR_MODIFIERS);
      runState.currentFloorModifier = ids[Math.floor(Math.random() * ids.length)];
    } else {
      runState.currentFloorModifier = null;
    }
    // Reassign personalities (so each floor feels different)
    assignBotPersonalities();

    if (floorJustFinished >= TOTAL_FLOORS && humanWonFloor) {
      endRun(true);
      return;
    }
    if (runState.currentFloor > TOTAL_FLOORS) {
      endRun(false);
      return;
    }

    // Phase 3: skip the floor-result modal and go straight to the fork
    // screen, which has its own banner showing the floor outcome.
    showFork(floorJustFinished, humanWonFloor, winnerIdx, lastRoundMessage);
  }

  function heartsString(h) {
    return '♥'.repeat(h) + '♡'.repeat(STARTING_HEARTS - h);
  }

  // ============================================================
  // Result modal helper
  // ============================================================

  // Tone palettes for the result modal: green for wins, red for losses,
  // purple/pink for neutral fallbacks.
  const RESULT_TONES = {
    win: {
      box: 'bg-gradient-to-br from-emerald-600 via-green-600 to-emerald-700 p-8 rounded-2xl text-center max-w-md shadow-2xl',
      btn: 'bg-white text-emerald-700 px-8 py-3 rounded-lg font-bold hover:bg-emerald-50 transition',
    },
    lose: {
      box: 'bg-gradient-to-br from-rose-700 via-red-600 to-rose-800 p-8 rounded-2xl text-center max-w-md shadow-2xl',
      btn: 'bg-white text-rose-700 px-8 py-3 rounded-lg font-bold hover:bg-rose-50 transition',
    },
    neutral: {
      box: 'bg-gradient-to-br from-purple-700 via-pink-600 to-rose-600 p-8 rounded-2xl text-center max-w-md shadow-2xl',
      btn: 'bg-white text-purple-700 px-8 py-3 rounded-lg font-bold hover:bg-purple-50 transition',
    },
  };

  function showResultModal(opts) {
    const tone = RESULT_TONES[opts.tone] || RESULT_TONES.neutral;
    document.getElementById('betaResultBox').className = tone.box;
    document.getElementById('betaResultBtn').className = tone.btn;
    document.getElementById('betaResultTitle').textContent = opts.title;
    document.getElementById('betaResultText').textContent = opts.text || '';
    document.getElementById('betaResultSubtitle').textContent = opts.subtitle || '';
    document.getElementById('betaResultBtn').textContent = opts.buttonLabel || 'Continue';
    resultContinueHandler = opts.onContinue || null;
    document.getElementById('betaResult').classList.remove('hidden');
  }

  // ============================================================
  // Deck / hand
  // ============================================================

  function buildDeck() {
    // Jack-capped composition. Jacks are limited to 6 in the whole deck —
    // they're "pure bluff" cards in the design. Non-Jack ranks come
    // entirely from run decks (2 per rank per player × 4 players = 8 each).
    //   non-J ranks: 0 base + 8 from run decks = 8 each
    //   Jacks:       6 base (no run-deck contribution) = 6
    // Total deck size: 4*8 + 6 = 38 cards.
    const deck = [];
    for (let i = 0; i < 6; i++) {
      deck.push({ rank: 'J', id: 'rd_J_' + i, owner: -1, affix: null });
    }
    // Each bot's run deck — vanilla in Phase 4, no customization yet
    for (let bot = 1; bot < NUM_PLAYERS; bot++) {
      for (const card of buildInitialRunDeck(bot)) {
        deck.push({ ...card });
      }
    }
    // Human's run deck — the only one that can be customized
    for (const card of runState.runDeck) {
      deck.push({ ...card });
    }
    return shuffle(deck);
  }

  // Phase 4: each player starts with 8 personal cards (2 each of A/K/Q/10).
  // No Jacks in run decks — Jacks live only in the base round-deck pool.
  function buildInitialRunDeck(playerIdx) {
    const deck = [];
    for (const r of ['A', 'K', 'Q', '10']) {
      for (let i = 0; i < 2; i++) {
        deck.push({
          rank: r,
          id: 'p' + playerIdx + '_' + r + '_' + i,
          owner: playerIdx,
          affix: null,
        });
      }
    }
    return deck;
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function deal(deck) {
    // Random deal — pop 5 cards per player from the shuffled deck.
    // Phase 5: Hoarder character grants player 0 +1 cards.
    const hands = Array.from({ length: NUM_PLAYERS }, () => []);
    for (let i = 0; i < HAND_SIZE; i++) {
      for (let p = 0; p < NUM_PLAYERS; p++) {
        hands[p].push(deck.pop());
      }
    }
    const playerBonus = (runState && runState.character && runState.character.handSizeBonus) || 0;
    for (let i = 0; i < playerBonus; i++) {
      if (deck.length > 0) hands[0].push(deck.pop());
    }
    return { hands, drawPile: deck };
  }

  function applyJackFairness(hands, drawPile) {
    const playerLimitBonus = (runState && runState.character && runState.character.jackLimitBonus) || 0;
    const playerJokerBonus = hasJoker('safetyNet') ? 1 : 0;
    const greedyDrop = (runState && runState.currentFloorModifier === 'greedy') ? 1 : 0;
    for (let p = 0; p < hands.length; p++) {
      const hand = hands[p];
      const limit = JACK_LIMIT + (p === 0 ? (playerLimitBonus + playerJokerBonus) : 0) - greedyDrop;
      while (countJacks(hand) >= limit) {
        const jackIdx = hand.findIndex(c => c.rank === 'J');
        const replIdx = drawPile.findIndex(c => c.rank !== 'J');
        if (jackIdx === -1 || replIdx === -1) break;
        const jack = hand.splice(jackIdx, 1)[0];
        const repl = drawPile.splice(replIdx, 1)[0];
        hand.push(repl);
        drawPile.unshift(jack);
      }
    }
  }

  function countJacks(hand) {
    return hand.filter(c => c.rank === 'J').length;
  }

  // ============================================================
  // Turn flow
  // ============================================================

  function clearAllTimers() {
    if (challengeTimer) { clearTimeout(challengeTimer); challengeTimer = null; }
    if (challengeBarTimer) { clearInterval(challengeBarTimer); challengeBarTimer = null; }
    if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
  }

  function advanceTurn(fromIdx) {
    for (let i = 1; i <= NUM_PLAYERS; i++) {
      const next = (fromIdx + i) % NUM_PLAYERS;
      if (!state.eliminated[next] && !state.finished[next]) {
        state.currentTurn = next;
        triggerGildedTurn();  // Phase 5: Gilded ticks on every turn
        return;
      }
    }
    state.currentTurn = fromIdx;
  }

  function nextActivePlayer(fromIdx) {
    for (let i = 1; i <= NUM_PLAYERS; i++) {
      const idx = (fromIdx + i) % NUM_PLAYERS;
      if (idx === fromIdx) break;
      if (!state.eliminated[idx] && !state.finished[idx]) return idx;
    }
    return -1;
  }

  // After every Liar call resolves, the target rank rotates to a new
  // random non-Jack rank. Same target won't be picked twice in a row.
  // If a Counterfeit lock is active, the rotation is suppressed once and
  // the target carries over into the next play cycle.
  function rotateTargetRank() {
    if (state.counterfeitLock) {
      log('Counterfeit lock holds — target stays ' + state.targetRank + '.');
      state.counterfeitLock = false;
      return;
    }
    const candidates = RANKS.filter(r => r !== state.targetRank);
    const newTarget = candidates[Math.floor(Math.random() * candidates.length)];
    log('Target rank rotates: ' + state.targetRank + ' -> ' + newTarget + '.');
    state.targetRank = newTarget;
  }

  function playCards(playerIdx, cardIds) {
    if (state.gameOver || state.challengeOpen) return;
    const dtArmed = playerIdx === 0 && state.doubletalkArmed;
    const minCards = dtArmed ? 2 : 1;
    const maxCards = dtArmed ? 4 : 3;
    if (cardIds.length < minCards || cardIds.length > maxCards) return;

    const hand = state.hands[playerIdx];
    const cards = cardIds
      .map(id => hand.find(c => c.id === id))
      .filter(Boolean);
    if (cards.length !== cardIds.length) return;

    state.hands[playerIdx] = hand.filter(c => !cardIds.includes(c.id));
    for (const c of cards) {
      state.pile.push({
        rank: c.rank,
        claim: state.targetRank,
        owner: playerIdx,
        id: c.id,
      });
    }

    // Phase 7+: Echo trigger — peek for armed player before pile push
    if (state.echoArmedFor >= 0 && state.echoArmedFor !== playerIdx && cards.length > 0) {
      const peeker = state.echoArmedFor;
      const peeked = cards[0];
      state.echoArmedFor = -1;
      if (peeker === 0) {
        log("Echo's eye: " + playerLabel(playerIdx) + "'s first card is a " +
            peeked.rank + (peeked.affix ? ' (' + peeked.affix + ')' : '') + '.');
      }
    }

    state.lastPlay = {
      playerIdx,
      count: cards.length,
      claim: state.targetRank,
    };

    log(playerLabel(playerIdx) + ' plays ' + cards.length +
        (cards.length === 1 ? ' card' : ' cards') +
        ' as ' + state.targetRank + '.');

    // Phase 8+: Echoing modifier — 20% chance to flash first card to all
    if (runState && runState.currentFloorModifier === 'echoing' && cards.length > 0 && Math.random() < 0.2) {
      const c = cards[0];
      log('Echoing: ' + playerLabel(playerIdx) + "'s first card is a " + c.rank + '.');
    }

    // Phase 5: Mirage is a one-time wildcard — when played, remove it from
    // the human's run deck so it never returns.
    for (const card of cards) {
      if (card.affix === 'mirage' && card.owner === 0) {
        runState.runDeck = runState.runDeck.filter(c => c.id !== card.id);
        log('Your Mirage is consumed (one-time wildcard).');
      }
    }

    // Phase 7+: Hollow draws replacement
    const hollowCount = cards.filter(c => c.affix === 'hollow').length;
    if (hollowCount > 0) {
      let drew = 0;
      for (let i = 0; i < hollowCount; i++) {
        if (state.drawPile.length > 0) {
          state.hands[playerIdx].push(state.drawPile.pop());
          drew++;
        }
      }
      if (drew > 0) log(playerLabel(playerIdx) + ' draws ' + drew + ' from draw pile (Hollow).');
    }
    if (cards.some(c => c.affix === 'echo')) {
      state.echoArmedFor = playerIdx;
    }
    // Phase 7+: Eavesdropper — fires when previous player (NUM_PLAYERS-1) plays
    if (playerIdx === ((NUM_PLAYERS - 1) % NUM_PLAYERS) && hasJoker('eavesdropper') &&
        runState && (totalRoundsPlayed() - (runState.eavesdropperLastFiredRound !== undefined
          ? runState.eavesdropperLastFiredRound : -99)) >= 2) {
      const matches = state.hands[playerIdx].filter(c => c.rank === state.targetRank).length;
      const bucket = matches === 0 ? 'NONE' : (matches <= 2 ? 'SOME (1-2)' : 'MANY (3+)');
      log('Eavesdropper: ' + playerLabel(playerIdx) + ' has ' + bucket + ' matches for ' + state.targetRank + '.');
      runState.eavesdropperLastFiredRound = totalRoundsPlayed();
    }

    if (playerIdx === 0 && state.doubletalkArmed) {
      state.doubletalkArmed = false;
      state.doubletalkUsedThisRound = true;
    }

    selected.clear();
    openChallengeWindow(playerIdx);
    render();
  }

  function openChallengeWindow(playerIdx) {
    const challenger = nextActivePlayer(playerIdx);
    if (challenger === -1) {
      handlePassNoChallenge(playerIdx);
      return;
    }

    state.challengeOpen = true;
    state.challengerIdx = challenger;

    // Phase 5: Slow Hand stretches the human's challenge window;
    // Sharp character adds +1s on top.
    let windowMs = (challenger === 0 && hasJoker('slowHand'))
      ? SLOW_HAND_WINDOW_MS : CHALLENGE_MS;
    if (challenger === 0 && runState && runState.character && runState.character.challengeBonusMs) {
      windowMs += runState.character.challengeBonusMs;
    }
    if (challenger === (NUM_PLAYERS - 1) && hasJoker('hotSeat')) {
      windowMs = 3000;
    }
    // Phase 7+: Pocket Watch relic — +5s for the human's window
    if (challenger === 0 && hasRelic('pocketWatch')) {
      windowMs += 5000;
    }

    document.getElementById('betaChallengeBar').classList.remove('hidden');
    let remaining = windowMs;
    const fill = document.getElementById('betaChallengeBarFill');
    fill.style.width = '100%';
    challengeBarTimer = setInterval(() => {
      remaining -= 100;
      const pct = Math.max(0, (remaining / windowMs) * 100);
      fill.style.width = pct + '%';
    }, 100);

    if (challenger === 0) {
      challengeTimer = setTimeout(() => {
        handlePassNoChallenge(playerIdx);
      }, windowMs);
    } else {
      const delay = BOT_CHALLENGE_DELAY_MIN_MS + Math.random() * BOT_CHALLENGE_DELAY_RAND_MS;
      challengeTimer = setTimeout(() => {
        const willCall = botDecideChallenge(challenger);
        if (willCall) callLiar(challenger);
        else handlePassNoChallenge(playerIdx);
      }, delay);
    }
  }

  function handlePassNoChallenge(lastPlayerIdx) {
    state.challengeOpen = false;
    state.challengerIdx = -1;
    clearAllTimers();
    document.getElementById('betaChallengeBar').classList.add('hidden');

    // Phase 5: Black Hole — successful Jack bluff lets you delete one non-Jack.
    if (lastPlayerIdx === 0 && hasJoker('blackHole') && state.lastPlay) {
      const lp = state.lastPlay;
      const justPlayed = state.pile.slice(-lp.count);
      const playedJack = justPlayed.some(c => c.rank === 'J');
      if (playedJack) {
        const nonJackIdx = state.hands[0].findIndex(c => c.rank !== 'J');
        if (nonJackIdx >= 0) {
          const removed = state.hands[0].splice(nonJackIdx, 1)[0];
          log('Black Hole: deleted ' + removed.rank +
              ' from your hand (Jack bluff success).');
        }
      }
    }

    if (!state.eliminated[lastPlayerIdx] &&
        state.hands[lastPlayerIdx].length === 0) {
      markFinished(lastPlayerIdx);
      if (endRoundIfDone()) return;
    }

    advanceTurn(lastPlayerIdx);
    render();
    if (!state.gameOver && state.currentTurn !== 0) {
      setTimeout(botTurn, BOT_TURN_DELAY_MS);
    }
  }

  function callLiar(challengerIdx) {
    if (!state.challengeOpen || !state.lastPlay) return;
    state.challengeOpen = false;
    clearAllTimers();
    document.getElementById('betaChallengeBar').classList.add('hidden');

    // Phase 8+: Tariff modifier — human pays 5g per Liar call
    if (challengerIdx === 0 && runState && runState.currentFloorModifier === 'tariff') {
      const cost = Math.min(5, runState.gold);
      runState.gold -= cost;
      log('Tariff: Liar call costs ' + cost + 'g.');
    }

    const lp = state.lastPlay;
    const playedCards = state.pile.slice(-lp.count);
    // Phase 5: Mirage cards count as matching the claim (one-time wildcard)
    const allMatch = playedCards.every(c => c.rank === lp.claim || c.affix === 'mirage');

    log(playerLabel(challengerIdx) + ' calls LIAR on ' +
        playerLabel(lp.playerIdx) + '!');
    revealCards(playedCards);
    render();

    setTimeout(() => {
      // Phase 5: Glass on-reveal — burn the Glass card + 2 random non-Steel pile cards.
      // Phase 7+: Iron Stomach tracks human's run-deck cards as they burn.
      // Phase 8+: BURN_CAP — when total burned in round exceeds cap, all burned
      // cards (including this trigger's) shuffle back into the draw pile.
      const glassPlayed = playedCards.filter(c => c.affix === 'glass').length;
      if (glassPlayed > 0) {
        const ironOn = hasRelic('ironStomach');
        const burnedThisTrigger = [];
        for (let g = 0; g < glassPlayed; g++) {
          const glassIdx = state.pile.findIndex(c => c.affix === 'glass');
          if (glassIdx >= 0) {
            const bc = state.pile[glassIdx];
            if (ironOn && bc.owner === 0) state.ironStomachBurned.push(bc.id);
            burnedThisTrigger.push(bc);
            state.pile.splice(glassIdx, 1);
          }
          for (let i = 0; i < GLASS_BURN_RANDOM; i++) {
            const burnable = [];
            for (let j = 0; j < state.pile.length; j++) {
              if (state.pile[j].affix !== 'steel') burnable.push(j);
            }
            if (burnable.length === 0) break;
            const pick = burnable[Math.floor(Math.random() * burnable.length)];
            const bc2 = state.pile[pick];
            if (ironOn && bc2.owner === 0) state.ironStomachBurned.push(bc2.id);
            burnedThisTrigger.push(bc2);
            state.pile.splice(pick, 1);
          }
        }
        if (burnedThisTrigger.length > 0) {
          log('Glass burns ' + burnedThisTrigger.length + ' cards from the pile.');
          state.burnedCards.push(...burnedThisTrigger);
          // Burn cap check: if total exceeds cap, recycle all burned -> draw pile
          if (state.burnedCards.length > BURN_CAP) {
            const recycled = state.burnedCards.length;
            state.drawPile = shuffle(state.drawPile.concat(state.burnedCards));
            state.burnedCards = [];
            log('Burn cap exceeded — ' + recycled + ' burned cards recycled into the draw pile.');
          }
        }
      }

      const doSpikedDraws = (takerIdx) => {
        const spikedCount = state.pile.filter(c => c.affix === 'spiked').length;
        for (const c of state.pile) {
          state.hands[takerIdx].push({ rank: c.rank, id: c.id, owner: c.owner, affix: c.affix });
        }
        state.pile = [];
        let drawn = 0;
        for (let i = 0; i < spikedCount * SPIKED_DRAWS_ON_PICKUP; i++) {
          if (state.drawPile.length > 0) {
            state.hands[takerIdx].push(state.drawPile.pop());
            drawn++;
          }
        }
        if (drawn > 0) {
          log(playerLabel(takerIdx) + ' draws ' + drawn + ' from draw pile (Spiked).');
        }
      };

      if (allMatch) {
        const _truthPileSize = state.pile.length;
        log('Truth told. ' + playerLabel(challengerIdx) +
            ' takes the pile (' + _truthPileSize + ' cards) and is skipped.');
        if (challengerIdx !== 0 && _truthPileSize >= 5 && hasJoker('taxman')) {
          const got = addGold(10);
          log('Taxman: ' + playerLabel(challengerIdx) + ' took ' + _truthPileSize + ' cards. +' + got + 'g.');
        }

        // Phase 5: Spiked Trap fires when the human's truthful play is
        // wrongly challenged — challenger draws 3 extra cards.
        if (lp.playerIdx === 0 && challengerIdx !== 0 && hasJoker('spikedTrap')) {
          let drawn = 0;
          for (let i = 0; i < SPIKED_TRAP_DRAWS; i++) {
            if (state.drawPile.length > 0) {
              state.hands[challengerIdx].push(state.drawPile.pop());
              drawn++;
            }
          }
          if (drawn > 0) {
            log('Spiked Trap: ' + playerLabel(challengerIdx) + ' draws ' +
                drawn + ' extra cards.');
          }
        }

        doSpikedDraws(challengerIdx);
        if (checkJackCurse(challengerIdx)) return;

        if (state.hands[lp.playerIdx].length === 0 &&
            !state.eliminated[lp.playerIdx]) {
          markFinished(lp.playerIdx);
          if (endRoundIfDone()) return;
        }

        rotateTargetRank();
        advanceTurn(challengerIdx);
        render();
        if (!state.gameOver && state.currentTurn !== 0) {
          setTimeout(botTurn, BOT_TURN_DELAY_MS);
        }
      } else {
        // Phase 7+: Scapegoat — Jacks routed to challenger
        if (lp.playerIdx === 0 && hasJoker('scapegoat')) {
          const playedJackIds = playedCards.filter(c => c.rank === 'J').map(c => c.id);
          if (playedJackIds.length > 0) {
            const jacksInPile = state.pile.filter(c => playedJackIds.includes(c.id));
            state.pile = state.pile.filter(c => !playedJackIds.includes(c.id));
            for (const c of jacksInPile) {
              state.hands[challengerIdx].push({ rank: c.rank, id: c.id, owner: c.owner, affix: c.affix });
            }
            log('Scapegoat: ' + jacksInPile.length + ' Jack(s) routed to ' + playerLabel(challengerIdx) + '.');
          }
        }
        const _liePileSize = state.pile.length;
        log('Lie caught! ' + playerLabel(lp.playerIdx) +
            ' takes the pile (' + _liePileSize + ' cards). ' +
            playerLabel(challengerIdx) + ' leads next.');
        if (lp.playerIdx !== 0 && _liePileSize >= 5 && hasJoker('taxman')) {
          const got = addGold(10);
          log('Taxman: ' + playerLabel(lp.playerIdx) + ' took ' + _liePileSize + ' cards. +' + got + 'g.');
        }
        doSpikedDraws(lp.playerIdx);
        if (checkJackCurse(lp.playerIdx)) return;

        rotateTargetRank();
        state.currentTurn = challengerIdx;
        triggerGildedTurn();
        render();
        if (!state.gameOver && state.currentTurn !== 0) {
          setTimeout(botTurn, BOT_TURN_DELAY_MS);
        }
      }
    }, REVEAL_HOLD_MS);
  }

  function checkJackCurse(playerIdx) {
    let bonus = (playerIdx === 0 && runState && runState.character)
                 ? (runState.character.jackLimitBonus || 0) : 0;
    if (playerIdx === 0 && hasJoker('safetyNet')) bonus += 1;
    let limit = JACK_LIMIT + bonus;
    if (runState && runState.currentFloorModifier === 'greedy') limit -= 1;
    const jacks = countJacks(state.hands[playerIdx]);
    if (jacks >= limit) {
      log(playerLabel(playerIdx) + ' has ' + jacks +
          ' Jacks — eliminated by the Jack curse!');
      state.eliminated[playerIdx] = true;
      if (playerIdx === 0 && hasJoker('vengefulSpirit')) {
        for (let i = 1; i < NUM_PLAYERS; i++) {
          const target = (playerIdx + i) % NUM_PLAYERS;
          if (!state.eliminated[target] && !state.finished[target]) {
            state.eliminated[target] = true;
            log('Vengeful Spirit: ' + playerLabel(target) + ' is dragged down with you!');
            break;
          }
        }
      }
      if (endRoundIfDone()) return true;
    }
    return false;
  }

  // Mark a player as having finished (emptied hand). Adds them to the
  // placements list so we can award placement gold at round end.
  function markFinished(playerIdx) {
    if (state.finished[playerIdx] || state.eliminated[playerIdx]) return;
    state.finished[playerIdx] = true;
    state.placements.push(playerIdx);
    log(playerLabel(playerIdx) + ' finishes #' + state.placements.length + '.');
  }

  // Round ends when at most 2 players remain active (not finished, not
  // eliminated). Returns true if the round was just ended, false otherwise.
  function endRoundIfDone() {
    if (state.gameOver) return true;
    let active = 0;
    for (let i = 0; i < NUM_PLAYERS; i++) {
      if (!state.eliminated[i] && !state.finished[i]) active++;
    }
    if (active > 2) return false;

    let winnerIdx;
    let message;
    if (state.placements.length === 0) {
      winnerIdx = pickClosestActivePlayer();
      message = 'Nobody emptied their hand. ' +
                playerLabel(winnerIdx) + ' was closest to winning.';
    } else if (state.placements.length === 1) {
      winnerIdx = state.placements[0];
      message = playerLabel(state.placements[0]) + ' finished 1st.';
    } else {
      winnerIdx = state.placements[0];
      message = playerLabel(state.placements[0]) + ' finished 1st, ' +
                playerLabel(state.placements[1]) + ' 2nd.';
    }

    endRound(winnerIdx, message);
    return true;
  }

  // Picks the active player with the smallest hand. Tiebreak: lowest index.
  function pickClosestActivePlayer() {
    let best = -1;
    let min = Infinity;
    for (let i = 0; i < NUM_PLAYERS; i++) {
      if (state.eliminated[i] || state.finished[i]) continue;
      if (state.hands[i].length < min) {
        min = state.hands[i].length;
        best = i;
      }
    }
    return best === -1 ? 0 : best;
  }

  // ============================================================
  // Bot AI (Phase 1: simple)
  // ============================================================

  function botTurn() {
    if (!state || state.gameOver) return;
    if (state.challengeOpen) return;
    if (state.currentTurn === 0) return;

    const botIdx = state.currentTurn;
    if (state.eliminated[botIdx] || state.finished[botIdx]) {
      advanceTurn(botIdx);
      render();
      if (!state.gameOver && state.currentTurn !== 0) setTimeout(botTurn, BOT_TURN_DELAY_MS);
      return;
    }

    const hand = state.hands[botIdx];
    if (hand.length === 0) {
      markFinished(botIdx);
      if (endRoundIfDone()) return;
      advanceTurn(botIdx);
      render();
      if (!state.gameOver && state.currentTurn !== 0) setTimeout(botTurn, BOT_TURN_DELAY_MS);
      return;
    }

    // Phase 8+: pull personality (boss takes precedence on boss floors)
    const persId = runState ? runState.botPersonalities[botIdx] : null;
    const pers = persId
      ? (PERSONALITY_CATALOG[persId] || BOSS_CATALOG[persId] || null)
      : null;
    const bluffRate = pers ? pers.bluffRate : 0.30;

    const target = state.targetRank;
    const matching = hand.filter(c => c.rank === target);
    const nonMatching = hand.filter(c => c.rank !== target);

    // Phase 8+: bluff if matching available AND personality bluffs OR forced
    const willBluff = (matching.length === 0) || (Math.random() < bluffRate);
    const truthful = !willBluff && matching.length > 0;
    let cardsToPlay;
    if (truthful) {
      const max = Math.min(3, matching.length);
      const count = 1 + Math.floor(Math.random() * max);
      cardsToPlay = matching.slice(0, count);
    } else {
      const max = Math.min(3, hand.length);
      const count = 1 + Math.floor(Math.random() * max);
      const pool = nonMatching.length >= count ? shuffle(nonMatching) : shuffle(hand);
      cardsToPlay = pool.slice(0, count);
    }

    // Phase 8+: tell — log a personality cue if Acts 1-2 and tells visible
    if (pers && pers.tell && shouldShowTells() && Math.random() < (getCurrentAct() === 1 ? 0.7 : 0.35)) {
      log('[Tell] ' + playerLabel(botIdx) + ' (' + pers.name + ') ' + pers.tell + '.');
    }

    playCards(botIdx, cardsToPlay.map(c => c.id));
  }

  function botDecideChallenge(botIdx) {
    if (!state.lastPlay) return false;
    if (hasCursed(botIdx)) return false;  // Phase 5: Cursed blocks Liar
    const lp = state.lastPlay;
    // Phase 8+: personality-driven challenge rate
    const persId = runState ? runState.botPersonalities[botIdx] : null;
    const pers = persId
      ? (PERSONALITY_CATALOG[persId] || BOSS_CATALOG[persId] || null)
      : null;
    let base = lp.count === 3 ? 0.40 : lp.count === 2 ? 0.25 : 0.15;
    if (pers) {
      // Personality multiplier: pers.challengeRate / 0.25 (default baseline)
      base = base * (pers.challengeRate / 0.25);
      base = Math.min(1.0, Math.max(0.02, base));
    }
    return Math.random() < base;
  }

  // ============================================================
  // Rendering
  // ============================================================

  function render() {
    if (!state) return;

    refreshAdminButton();
    document.getElementById('betaTarget').textContent =
      (state.foggyHidden && runState && runState.currentFloorModifier === 'foggy') ? '?' : state.targetRank;
    document.getElementById('betaPileSize').textContent = state.pile.length;
    document.getElementById('betaDrawSize').textContent = state.drawPile.length;
    document.getElementById('betaHandCount').textContent = state.hands[0].length;

    const lpEl = document.getElementById('betaLastPlay');
    if (state.lastPlay && state.challengeOpen) {
      lpEl.textContent = playerLabel(state.lastPlay.playerIdx) +
        ' claims ' + state.lastPlay.count + ' × ' + state.lastPlay.claim;
    } else {
      lpEl.textContent = '';
    }

    renderStatusBar();
    renderJokerRow();
    renderConsumablesRow();
    renderOpponents();
    renderHand();
    renderTurnIndicator();
    renderActionButtons();
    renderLog();
  }

  function renderJokerRow() {
    if (!runState) return;
    for (let i = 0; i < 2; i++) {
      const slot = document.getElementById('betaJokerSlot' + i);
      if (!slot) continue;
      // Reset slot's click listener every render via cloneNode (simplest)
      const fresh = slot.cloneNode(false);
      slot.parentNode.replaceChild(fresh, slot);
      fresh.id = 'betaJokerSlot' + i;
      const j = runState.jokers[i];
      if (j) {
        fresh.innerHTML = '<span class="font-bold text-purple-200">' +
                         escapeHtml(j.name) + '</span>';
        fresh.title = j.desc || '';
        fresh.className = 'inline-flex items-center gap-1 px-2 py-1 rounded bg-purple-900/40 cursor-pointer hover:bg-purple-800/60 transition';
        fresh.addEventListener('click', () => {
          showInfoModal(j.name, '[' + (j.rarity || 'Joker') + '] (slot ' + (i + 1) + ')', j.desc || '');
        });
      } else {
        fresh.innerHTML = '<span class="italic text-white/40">Empty</span>';
        fresh.title = '';
        fresh.className = 'inline-flex items-center gap-1 px-2 py-1 rounded bg-black/40';
      }
    }
    // Surveyor — show top of draw pile when held
    const surveyorInfo = document.getElementById('betaSurveyorInfo');
    if (surveyorInfo) {
      if (state && hasJoker('surveyor') && state.drawPile.length > 0) {
        const top = state.drawPile[state.drawPile.length - 1];
        document.getElementById('betaSurveyorCard').textContent =
          top.rank + (top.affix ? '*' : '');
        surveyorInfo.classList.remove('hidden');
      } else {
        surveyorInfo.classList.add('hidden');
      }
    }
    // Tattletale — show peek button when held + charge available
    const tatBtn = document.getElementById('betaTattletaleBtn');
    if (tatBtn) {
      const usable = state && !state.gameOver && hasJoker('tattletale') &&
                     runState.tattletaleChargesThisFloor > 0;
      if (usable) {
        tatBtn.classList.remove('hidden');
        document.getElementById('betaTattletaleCharges').textContent =
          runState.tattletaleChargesThisFloor;
      } else {
        tatBtn.classList.add('hidden');
      }
    }
  }

  // Phase 5+: render the consumables row. Each consumable shows name + count,
  // is clickable when owned to open an info modal.
  const CONSUMABLE_INFO = {
    smokeBomb:   { name: 'Smoke Bomb',     desc: 'Skip your turn (your card pass passes to the next active player).' },
    counterfeit: { name: 'Counterfeit',    desc: 'Change the target rank for the rest of the round AND lock it through the next Liar call. Once per round.' },
    jackBeNimble:{ name: 'Jack-be-Nimble', desc: 'Discard up to 2 Jacks from your hand. Use anytime on your turn.' },
  };
  function renderConsumablesRow() {
    const list = document.getElementById('betaConsumablesList');
    if (!list || !runState) return;
    list.innerHTML = '';
    for (const id of Object.keys(CONSUMABLE_INFO)) {
      const info = CONSUMABLE_INFO[id];
      const count = runState.inventory[id] || 0;
      const pill = document.createElement('div');
      const owned = count > 0;
      pill.className = 'inline-flex items-center gap-1 px-2 py-1 rounded ' +
        (owned
          ? 'bg-amber-900/40 text-amber-100 cursor-pointer hover:bg-amber-800/60 transition'
          : 'bg-black/40 text-white/40');
      pill.innerHTML = escapeHtml(info.name) +
        ' <span class="font-bold">(' + count + ')</span>';
      pill.title = info.desc;
      if (owned) {
        pill.addEventListener('click', () => {
          showInfoModal(info.name, 'You own ' + count, info.desc);
        });
      }
      list.appendChild(pill);
    }
  }

  function showInfoModal(title, subtitle, desc) {
    document.getElementById('betaInfoTitle').textContent = title || '';
    document.getElementById('betaInfoSubtitle').textContent = subtitle || '';
    document.getElementById('betaInfoDesc').textContent = desc || '';
    document.getElementById('betaInfoModal').classList.remove('hidden');
  }

  function closeInfoModal() {
    document.getElementById('betaInfoModal').classList.add('hidden');
  }

  // ============================================================
  // Phase 8+: Admin cheats (only available to flagged admin accounts)
  // ============================================================

  function isAdminMode() {
    return isCurrentUserAdmin();
  }

  function adminAddGold(n) {
    if (!runState) return;
    runState.gold += n;
    log('Admin: +' + n + 'g.');
    render();
  }

  function adminSetHearts(n) {
    if (!runState) return;
    n = Math.max(0, Math.min(9, n | 0));
    runState.hearts = n;
    log('Admin: hearts set to ' + n + '.');
    if (state) render();
  }

  function adminSkipToFloor(targetFloor) {
    if (!runState) return;
    targetFloor = Math.max(1, Math.min(TOTAL_FLOORS, targetFloor | 0));
    runState.currentFloor = targetFloor;
    runState.roundsWon = new Array(NUM_PLAYERS).fill(0);
    runState.loadedDieUsedThisFloor = false;
    runState.tattletaleChargesThisFloor =
      hasJoker('tattletale') ? TATTLETALE_CHARGES_PER_FLOOR : 0;
    setMaxFloorReached(targetFloor);
    if (targetFloor >= 4 && !isBossFloor(targetFloor)) {
      const ids = Object.keys(FLOOR_MODIFIERS);
      runState.currentFloorModifier = ids[Math.floor(Math.random() * ids.length)];
    } else {
      runState.currentFloorModifier = null;
    }
    assignBotPersonalities();
    log('Admin: jumped to Floor ' + targetFloor + '.');
    closeAdminCheats();
    showFork(Math.max(1, targetFloor - 1), true, 0, 'Admin floor skip');
  }

  function adminTriggerFork() {
    if (!runState) return;
    if (state) {
      state.gameOver = true;
      clearAllTimers();
    }
    log('Admin: forcing fork (current floor counted as won).');
    closeAdminCheats();
    endFloor(true, 'Admin cheat: floor won.', 0);
  }

  function adminWinRound() {
    if (!state) return;
    if (state.gameOver) return;
    log('Admin: forcing round win.');
    closeAdminCheats();
    state.gameOver = true;
    clearAllTimers();
    endRound(0, 'Admin cheat: round won.');
  }

  function adminLoseRound() {
    if (!state) return;
    if (state.gameOver) return;
    log('Admin: forcing round loss.');
    closeAdminCheats();
    state.gameOver = true;
    clearAllTimers();
    endRound(1, 'Admin cheat: round lost.');
  }

  function adminStackConsumables() {
    if (!runState) return;
    runState.inventory.smokeBomb = (runState.inventory.smokeBomb || 0) + 10;
    runState.inventory.counterfeit = (runState.inventory.counterfeit || 0) + 10;
    runState.inventory.jackBeNimble = (runState.inventory.jackBeNimble || 0) + 10;
    log('Admin: +10 of each consumable.');
    render();
  }

  function adminEquipJokers() {
    if (!runState) return;
    const jokerIds = Object.keys(JOKER_CATALOG);
    for (let i = 0; i < runState.jokers.length; i++) {
      const id = jokerIds[Math.floor(Math.random() * jokerIds.length)];
      runState.jokers[i] = { ...JOKER_CATALOG[id] };
      if (id === 'tattletale') {
        runState.tattletaleChargesThisFloor = TATTLETALE_CHARGES_PER_FLOOR;
      }
    }
    log('Admin: random jokers equipped.');
    render();
  }

  function adminGrantAllRelics() {
    if (!runState) return;
    runState.relics = Object.keys(RELIC_CATALOG);
    log('Admin: all relics granted.');
    render();
  }

  function adminAddShard() {
    if (!runState) return;
    runState.heartShards = (runState.heartShards || 0) + 1;
    if (runState.heartShards >= HEART_SHARDS_REQUIRED) {
      runState.hearts++;
      runState.heartShards = 0;
      log('Admin: heart restored from shards!');
    } else {
      log('Admin: +1 shard (' + runState.heartShards + '/' + HEART_SHARDS_REQUIRED + ').');
    }
    render();
  }

  function adminRevealHands() {
    if (!state) return;
    for (let i = 1; i < NUM_PLAYERS; i++) {
      if (state.eliminated[i] || state.finished[i]) continue;
      const cards = state.hands[i].map(c => c.rank + (c.affix ? '*' : '')).join(', ');
      log('Admin reveal — ' + playerLabel(i) + ': ' + cards);
    }
  }

  function adminRefillHand() {
    if (!state) return;
    while (state.hands[0].length < 8 && state.drawPile.length > 0) {
      state.hands[0].push(state.drawPile.pop());
    }
    log('Admin: hand topped up to ' + state.hands[0].length + ' cards.');
    render();
  }

  function openAdminCheats() {
    if (!isAdminMode()) return;
    document.getElementById('betaAdminCheatsModal').classList.remove('hidden');
  }
  function closeAdminCheats() {
    const m = document.getElementById('betaAdminCheatsModal');
    if (m) m.classList.add('hidden');
  }

  function refreshAdminButton() {
    const btn = document.getElementById('betaAdminCheatsBtn');
    if (!btn) return;
    if (isAdminMode()) btn.classList.remove('hidden');
    else btn.classList.add('hidden');
  }

  // Phase 5: Tattletale — auto-target the bot with the most cards, then
  // reveal their hand for 4 seconds in a private modal.
  function useTattletale() {
    if (!state || state.gameOver) return;
    if (!hasJoker('tattletale')) return;
    if (runState.tattletaleChargesThisFloor < 1) return;

    let target = -1;
    let max = -1;
    for (let i = 1; i < NUM_PLAYERS; i++) {
      if (state.eliminated[i] || state.finished[i]) continue;
      if (state.hands[i].length > max) {
        max = state.hands[i].length;
        target = i;
      }
    }
    if (target < 0) return;

    runState.tattletaleChargesThisFloor--;
    log('Tattletale: peeking at ' + playerLabel(target) + ' for ' +
        (TATTLETALE_PEEK_MS / 1000) + 's.');

    const modal = document.getElementById('betaTattletalePeek');
    document.getElementById('betaTattletaleTarget').textContent = playerLabel(target);
    const cardsDiv = document.getElementById('betaTattletaleCards');
    cardsDiv.innerHTML = '';
    const order = ['A', 'K', 'Q', '10', 'J'];
    const sorted = state.hands[target].slice().sort((a, b) => {
      const ai = order.indexOf(a.rank), bi = order.indexOf(b.rank);
      if (ai !== bi) return ai - bi;
      return a.id.localeCompare(b.id);
    });
    for (const c of sorted) {
      const div = document.createElement('div');
      let cls = 'card card-face flex items-center justify-center text-2xl font-bold text-black rounded';
      const ring = affixRingClass(c.affix);
      if (ring) cls += ' ' + ring;
      else if (c.owner === 0) cls += ' ring-2 ring-emerald-400';
      div.className = cls;
      div.textContent = c.rank;
      if (c.affix) div.title = 'Affix: ' + c.affix;
      cardsDiv.appendChild(div);
    }
    modal.classList.remove('hidden');

    let remaining = Math.floor(TATTLETALE_PEEK_MS / 1000);
    const cd = document.getElementById('betaTattletaleCountdown');
    cd.textContent = remaining;
    const interval = setInterval(() => {
      remaining--;
      cd.textContent = remaining;
      if (remaining <= 0) {
        clearInterval(interval);
        modal.classList.add('hidden');
        render();
      }
    }, 1000);
  }

  function renderStatusBar() {
    if (!runState) return;
    let floorText = String(runState.currentFloor);
    const boss = getBoss(runState.currentFloor);
    if (boss) {
      floorText += ' · BOSS: ' + boss.name;
    } else if (runState.currentFloorModifier && FLOOR_MODIFIERS[runState.currentFloorModifier]) {
      floorText += ' · ' + FLOOR_MODIFIERS[runState.currentFloorModifier].name;
    }
    document.getElementById('betaFloor').textContent = floorText;
    if (false) document.getElementById('betaFloor').textContent = runState.currentFloor;
    document.getElementById('betaHearts').textContent = heartsString(runState.hearts) +
      (runState.heartShards > 0 ? ' (' + runState.heartShards + '/' + HEART_SHARDS_REQUIRED + ' shards)' : '');
    document.getElementById('betaGold').textContent = runState.gold;
    document.getElementById('betaInventoryCount').textContent = totalInventory();

    const labels = ['You', BOT_NAMES[0].replace('Bot ', ''),
                    BOT_NAMES[1].replace('Bot ', ''),
                    BOT_NAMES[2].replace('Bot ', '')];
    const parts = labels.map((label, i) => {
      const cls = i === 0 ? 'text-emerald-300' : 'text-rose-300';
      return label + ' <span class="font-bold ' + cls + '">' +
             runState.roundsWon[i] + '</span>';
    });
    document.getElementById('betaRoundScore').innerHTML = 'Round score: ' + parts.join(' · ');
  }

  function totalInventory() {
    if (!runState) return 0;
    return Object.values(runState.inventory).reduce((a, b) => a + b, 0);
  }

  // Phase 5: affix → ring color mapping
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

  // Phase 5: Cursed in hand blocks the holder from calling Liar.
  function hasCursed(playerIdx) {
    return state && state.hands[playerIdx] &&
           state.hands[playerIdx].some(c => c.affix === 'cursed');
  }

  // Phase 5: joker accessors
  function hasJoker(jokerId) {
    return runState && runState.jokers && runState.jokers.some(j => j && j.id === jokerId);
  }
  function equipJoker(jokerData) {
    for (let i = 0; i < runState.jokers.length; i++) {
      if (runState.jokers[i] === null) {
        runState.jokers[i] = { ...jokerData };
        return true;
      }
    }
    return false;
  }

  // Phase 7+: relic accessors
  function hasRelic(relicId) {
    return runState && Array.isArray(runState.relics) && runState.relics.includes(relicId);
  }

  // Phase 5: gold gains respect character multiplier (Gambler +50%)
  function addGold(amount) {
    if (!runState) return amount;
    let mult = (runState.character && runState.character.goldMultiplier) || 1;
    if (hasRelic('ledger')) mult *= LEDGER_GOLD_MULT;
    if (runState.currentFloorModifier === 'greedy') mult *= 2;  // Phase 8+
    const final = Math.floor(amount * mult);
    runState.gold += final;
    return final;
  }

  // Phase 5: Gilded — at every turn start, +2g per Gilded card in human's hand.
  // Tracks per-round earnings so we can log a tidy summary at round end without
  // spamming the log on every individual turn.
  function triggerGildedTurn() {
    if (!runState || !state || state.gameOver) return;
    const gilded = state.hands[0].filter(c => c.affix === 'gilded').length;
    if (gilded > 0) {
      const base = gilded * GOLD_PER_GILDED_PER_TURN;
      const gain = addGold(base);
      state._gildedRoundEarnings = (state._gildedRoundEarnings || 0) + gain;
    }
  }

  function renderOpponents() {
    const div = document.getElementById('betaOpponents');
    div.innerHTML = '';
    for (let i = 1; i < NUM_PLAYERS; i++) {
      const isCurrent = i === state.currentTurn && !state.gameOver && !state.challengeOpen;
      const isChallenging = state.challengeOpen && state.challengerIdx === i;
      const elim = state.eliminated[i];
      const fin = state.finished[i];
      const ringClass = isCurrent ? ' ring-2 ring-yellow-400' :
                         isChallenging ? ' ring-2 ring-red-500' : '';
      // Phase 8+: personality / boss labels
      let personaLabel = '';
      const persId = runState ? runState.botPersonalities[i] : null;
      if (persId) {
        const boss = BOSS_CATALOG[persId];
        if (boss) {
          personaLabel = '👑 ' + boss.name;
        } else if (getCurrentAct() === 1 && PERSONALITY_CATALOG[persId]) {
          personaLabel = PERSONALITY_CATALOG[persId].name;
        }
      }
      const status = elim ? '☠ eliminated' :
                     fin ? '✓ finished' :
                     isCurrent ? '▶ playing' :
                     isChallenging ? '? deciding' :
                     personaLabel;
      const card = document.createElement('div');
      card.className = 'bg-black/40 p-3 rounded-lg text-center min-w-[120px]' + ringClass;
      card.innerHTML =
        '<div class="text-sm font-bold">' + BOT_NAMES[i - 1] + '</div>' +
        '<div class="text-2xl font-extrabold my-1">' + state.hands[i].length + '</div>' +
        '<div class="text-xs text-emerald-300">cards</div>' +
        '<div class="text-xs text-yellow-300 mt-1 min-h-[1rem]">' + status + '</div>';
      div.appendChild(card);
    }
  }

  function renderHand() {
    const handDiv = document.getElementById('betaHand');
    handDiv.innerHTML = '';
    const myTurn = state.currentTurn === 0 && !state.gameOver && !state.challengeOpen
                   && !state.finished[0] && !state.eliminated[0];
    const order = ['A', 'K', 'Q', '10', 'J'];
    const sorted = state.hands[0].slice().sort((a, b) => {
      const ai = order.indexOf(a.rank), bi = order.indexOf(b.rank);
      if (ai !== bi) return ai - bi;
      return a.id.localeCompare(b.id);
    });
    for (const card of sorted) {
      const div = document.createElement('div');
      let cls = 'card card-face flex items-center justify-center text-2xl font-bold text-black rounded';
      // Phase 5: any affix ring takes precedence; otherwise emerald ring
      // marks cards from the human's run deck (Phase 4).
      const affixRing = affixRingClass(card.affix);
      if (affixRing) {
        cls += ' ' + affixRing;
      } else if (card.owner === 0) {
        cls += ' ring-2 ring-emerald-400';
      }
      if (card.affix) div.title = 'Affix: ' + card.affix;
      div.className = cls;
      if (selected.has(card.id)) div.classList.add('selected');
      div.textContent = card.rank;
      div.dataset.id = card.id;
      if (myTurn) {
        div.style.cursor = 'pointer';
        div.addEventListener('click', () => toggleSelect(card.id));
      } else {
        div.style.cursor = 'default';
      }
      handDiv.appendChild(div);
    }
  }

  function renderTurnIndicator() {
    const ti = document.getElementById('betaTurnIndicator');
    if (state.gameOver) {
      ti.textContent = 'Round over';
      ti.classList.remove('pulse-ring');
      return;
    }
    ti.classList.add('pulse-ring');
    if (state.challengeOpen) {
      const challenger = state.challengerIdx;
      ti.textContent = challenger === 0
        ? 'Your call — LIAR or Pass'
        : playerLabel(challenger) + ' is deciding...';
      return;
    }
    if (state.currentTurn === 0) {
      ti.textContent = 'Your turn — select 1-3 cards and play';
    } else {
      ti.textContent = playerLabel(state.currentTurn) + ' is playing...';
    }
  }

  function renderActionButtons() {
    const playBtn = document.getElementById('betaPlayBtn');
    const liarBtn = document.getElementById('betaLiarBtn');
    const passBtn = document.getElementById('betaPassBtn');

    playBtn.classList.add('hidden');
    liarBtn.classList.add('hidden');
    passBtn.classList.add('hidden');

    if (state.gameOver) return;

    if (state.challengeOpen && state.challengerIdx === 0) {
      // Phase 5: Cursed cards block Liar; only Pass is shown
      if (!hasCursed(0)) liarBtn.classList.remove('hidden');
      passBtn.classList.remove('hidden');
      return;
    }

    const myTurn = state.currentTurn === 0 && !state.challengeOpen
                   && !state.finished[0] && !state.eliminated[0];
    if (myTurn && selected.size > 0) {
      playBtn.classList.remove('hidden');
      playBtn.disabled = selected.size < 1 || selected.size > 3;
    }

    const smokeBtn = document.getElementById('betaUseSmokeBtn');
    smokeBtn.classList.add('hidden');
    if (myTurn && runState && runState.inventory.smokeBomb > 0) {
      smokeBtn.classList.remove('hidden');
      document.getElementById('betaSmokeCount').textContent = runState.inventory.smokeBomb;
    }

    // Counterfeit button + inline rank picker (Phase 4)
    const cfBtn = document.getElementById('betaUseCounterfeitBtn');
    cfBtn.classList.add('hidden');
    if (myTurn && runState && runState.inventory.counterfeit > 0 &&
        !state.counterfeitUsed) {
      cfBtn.classList.remove('hidden');
      document.getElementById('betaCounterfeitCount').textContent = runState.inventory.counterfeit;
    }
    const cfPicker = document.getElementById('betaCounterfeitPicker');
    if (counterfeitPickOpen && canUseCounterfeit()) {
      cfPicker.classList.remove('hidden');
      const buttonsDiv = document.getElementById('betaCounterfeitButtons');
      buttonsDiv.innerHTML = '';
      for (const r of RANKS) {
        if (r === state.targetRank) continue;
        const b = document.createElement('button');
        b.className = 'bg-blue-600 hover:bg-blue-700 transition px-4 py-2 rounded-lg font-bold text-lg';
        b.textContent = r;
        b.addEventListener('click', () => applyCounterfeit(r));
        buttonsDiv.appendChild(b);
      }
    } else {
      cfPicker.classList.add('hidden');
    }

    // Jack-be-Nimble button (Phase 4) — only show when there are Jacks to discard
    const jbnBtn = document.getElementById('betaUseJackBtn');
    jbnBtn.classList.add('hidden');
    if (myTurn && runState && runState.inventory.jackBeNimble > 0) {
      const jacksInHand = state.hands[0].filter(c => c.rank === 'J').length;
      if (jacksInHand > 0) {
        jbnBtn.classList.remove('hidden');
        document.getElementById('betaJackBtnCount').textContent = runState.inventory.jackBeNimble;
      }
    }

    const dtBtn = document.getElementById('betaDoubletalkBtn');
    if (dtBtn) {
      dtBtn.classList.add('hidden');
      if (myTurn && hasJoker('doubletalk') && !state.doubletalkUsedThisRound) {
        dtBtn.classList.remove('hidden');
        dtBtn.textContent = state.doubletalkArmed ? 'Doubletalk ON (cancel)' : 'Doubletalk';
      }
    }
    const sohBtn = document.getElementById('betaSleightBtn');
    if (sohBtn) {
      sohBtn.classList.add('hidden');
      if (myTurn && hasJoker('sleightOfHand') && !state.sleightUsedThisRound &&
          state.drawPile.length > 0) {
        sohBtn.classList.remove('hidden');
      }
    }
    // Phase 7+: Loaded Die relic button
    const ldBtn = document.getElementById('betaLoadedDieBtn');
    if (ldBtn) {
      ldBtn.classList.add('hidden');
      if (myTurn && hasRelic('loadedDie') && !runState.loadedDieUsedThisFloor) {
        ldBtn.classList.remove('hidden');
      }
    }
  }

  function renderLog() {
    const logDiv = document.getElementById('betaLog');
    logDiv.innerHTML = state.log
      .slice(-50)
      .map(m => '<div>' + escapeHtml(m) + '</div>')
      .join('');
    logDiv.scrollTop = logDiv.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function revealCards(cards) {
    const reveal = document.getElementById('betaReveal');
    reveal.innerHTML = '';
    for (const c of cards) {
      const div = document.createElement('div');
      const isMatch = c.rank === c.claim || c.affix === 'mirage';
      div.className = 'card card-face flex items-center justify-center text-2xl font-bold text-black rounded' +
                      (isMatch ? ' ring-2 ring-emerald-400' : ' ring-2 ring-red-500');
      div.textContent = c.rank;
      if (c.affix) div.title = 'Affix: ' + c.affix;
      reveal.appendChild(div);
    }
    revealTimer = setTimeout(() => { reveal.innerHTML = ''; }, REVEAL_HOLD_MS);
  }

  // ============================================================
  // Player input
  // ============================================================

  function toggleSelect(cardId) {
    if (selected.has(cardId)) selected.delete(cardId);
    else if (selected.size < 3) selected.add(cardId);
    render();
  }

  function playerLabel(i) {
    return i === 0 ? 'You' : BOT_NAMES[i - 1];
  }

  function log(msg) {
    if (state) state.log.push(msg);
  }

  // ============================================================
  // Wire up buttons
  // ============================================================

  document.getElementById('betaStartBtn').addEventListener('click', showCharSelect);

  function showCharSelect() {
    hideAllPanels();
    renderCharSelect();  // initial render with cached state
    document.getElementById('betaCharSelect').classList.remove('hidden');
    // Then asynchronously fetch fresh server progression and re-render
    fetchServerProgression().then(() => renderCharSelect());
  }

  function selectCharacter(charId) {
    const char = CHARACTER_CATALOG[charId];
    if (!char || !isCharUnlocked(char)) return;
    hideAllPanels();
    document.getElementById('betaGame').classList.remove('hidden');
    startRun(charId);
  }

  // Build the character grid dynamically based on unlock state.
  function renderCharSelect() {
    const grid = document.getElementById('betaCharGrid');
    if (!grid) return;
    grid.innerHTML = '';
    // Toggle admin "Unlock All" button visibility
    const adminBtn = document.getElementById('betaAdminUnlockBtn');
    if (adminBtn) {
      if (isCurrentUserAdmin()) adminBtn.classList.remove('hidden');
      else adminBtn.classList.add('hidden');
    }
    const charIds = Object.keys(CHARACTER_CATALOG);
    for (let i = 0; i < charIds.length; i++) {
      const char = CHARACTER_CATALOG[charIds[i]];
      const unlocked = isCharUnlocked(char);
      const btn = document.createElement('button');
      let cls = 'p-4 rounded-xl text-left border transition';
      if (unlocked) {
        cls += ' bg-black/40 hover:bg-emerald-900/40 border-white/10 hover:border-emerald-400 cursor-pointer';
      } else {
        cls += ' bg-black/20 border-white/5 opacity-60 cursor-not-allowed';
      }
      // Gambler spans full width to keep the grid balanced (5 chars + Rookie = 6)
      btn.className = cls;
      btn.dataset.char = char.id;

      let starterLine = '<span class="italic text-white/50">No starting joker</span>';
      if (char.startingJoker && JOKER_CATALOG[char.startingJoker]) {
        const jk = JOKER_CATALOG[char.startingJoker];
        starterLine = 'Starts with: ' + escapeHtml(jk.name) +
                      ' (' + escapeHtml(jk.rarity || '') + ')';
      }

      let inner = '<div class="text-xl font-bold mb-1">' + escapeHtml(char.name) +
                  (unlocked ? '' : ' <span class="text-rose-400">&#128274;</span>') + '</div>';
      inner += '<div class="text-xs italic text-white/60 mb-2">' +
               escapeHtml(char.flavor || '') + '</div>';
      if (unlocked) {
        inner += '<div class="text-xs text-emerald-200 mb-2">' +
                 escapeHtml(char.passive) + '</div>';
        inner += '<div class="text-xs text-purple-300">' + starterLine + '</div>';
      } else {
        inner += '<div class="text-xs text-rose-300">Locked &mdash; ' +
                 escapeHtml(char.unlockHint || 'Keep playing.') + '</div>';
      }
      btn.innerHTML = inner;

      if (unlocked) {
        const cid = char.id;
        btn.addEventListener('click', () => selectCharacter(cid));
      }
      grid.appendChild(btn);
    }
  }
  const _charCancel = document.getElementById('betaCharCancelBtn');
  if (_charCancel) _charCancel.addEventListener('click', backToIntro);
  const _adminBtn = document.getElementById('betaAdminUnlockBtn');
  if (_adminBtn) {
    _adminBtn.addEventListener('click', async () => {
      _adminBtn.disabled = true;
      _adminBtn.textContent = 'Unlocking...';
      const result = await adminUnlockAllRequest();
      _adminBtn.disabled = false;
      _adminBtn.textContent = '\ud83d\udee0 Unlock All (Admin)';
      if (result) {
        renderCharSelect();
      } else {
        alert('Admin unlock failed. Are you signed in as an admin user?');
      }
    });
  }

  document.getElementById('betaResultBtn').addEventListener('click', () => {
    const handler = resultContinueHandler;
    resultContinueHandler = null;
    if (typeof handler === 'function') {
      handler();
    } else {
      backToIntro();
    }
  });

  document.getElementById('betaPlayBtn').addEventListener('click', () => {
    if (selected.size < 1 || selected.size > 3) return;
    if (!state || state.gameOver || state.challengeOpen) return;
    if (state.currentTurn !== 0) return;
    const ids = Array.from(selected);
    playCards(0, ids);
  });

  document.getElementById('betaLiarBtn').addEventListener('click', () => {
    if (state && state.challengeOpen && state.challengerIdx === 0) {
      callLiar(0);
    }
  });

  document.getElementById('betaPassBtn').addEventListener('click', () => {
    if (state && state.challengeOpen && state.challengerIdx === 0) {
      const lp = state.lastPlay;
      handlePassNoChallenge(lp.playerIdx);
    }
  });

  // ============================================================
  // Phase 3: between-floor fork (Shop / Reward / Event)
  // ============================================================

  function hideAllPanels() {
    document.getElementById('betaIntro').classList.add('hidden');
    document.getElementById('betaGame').classList.add('hidden');
    document.getElementById('betaFork').classList.add('hidden');
    document.getElementById('betaShop').classList.add('hidden');
    document.getElementById('betaReward').classList.add('hidden');
    document.getElementById('betaEvent').classList.add('hidden');
    const cs = document.getElementById('betaCharSelect');
    if (cs) cs.classList.add('hidden');
    const tr = document.getElementById('betaTreasure');
    if (tr) tr.classList.add('hidden');
  }

  function showFork(floorJustFinished, humanWonFloor, winnerIdx, lastRoundMessage) {
    hideAllPanels();
    document.getElementById('betaResult').classList.add('hidden');

    // Phase 8+: Act III non-boss floors get a chance for Treasure (replaces Reward)
    runState.forkOfferTreasure = (
      runState.currentFloor >= 7 &&
      runState.currentFloor <= 8 &&
      Math.random() < TREASURE_CHANCE_ACT_III
    );

    const banner = document.getElementById('betaForkBanner');
    if (humanWonFloor) {
      banner.className = 'bg-emerald-700 p-4 rounded-xl mb-6 text-center';
      banner.innerHTML =
        '<div class="font-bold text-2xl">Floor ' + floorJustFinished +
        ' won! +' + GOLD_PER_FLOOR_WIN + 'g</div>' +
        '<div class="text-sm opacity-80 mt-1">' + escapeHtml(lastRoundMessage) + '</div>';
    } else {
      banner.className = 'bg-rose-800 p-4 rounded-xl mb-6 text-center';
      banner.innerHTML =
        '<div class="font-bold text-2xl">Floor ' + floorJustFinished +
        ' lost. -1 Heart</div>' +
        '<div class="text-sm opacity-80 mt-1">' +
        escapeHtml(playerLabel(winnerIdx) + ' took the floor.') + '</div>';
    }

    document.getElementById('betaForkNextFloor').textContent = runState.currentFloor;
    document.getElementById('betaForkHearts').textContent = heartsString(runState.hearts);
    document.getElementById('betaForkGold').textContent = runState.gold;
    document.getElementById('betaForkInventory').textContent = totalInventory();
    // Phase 8+: swap Reward button visuals for Treasure on lucky Act III floors
    const rewardBtn = document.getElementById('betaForkRewardBtn');
    if (rewardBtn) {
      if (runState.forkOfferTreasure) {
        rewardBtn.innerHTML = '<div class="text-2xl font-bold mb-1">&#128137; Treasure</div>' +
          '<div class="text-sm opacity-80">Free relic from a treasure pool.</div>';
        rewardBtn.className = 'bg-amber-700 hover:bg-amber-600 p-6 rounded-xl text-left transition';
      } else {
        rewardBtn.innerHTML = '<div class="text-2xl font-bold mb-1">&#128176; Reward</div>' +
          '<div class="text-sm opacity-80">Take 75g, no questions asked.</div>';
        rewardBtn.className = 'bg-emerald-700 hover:bg-emerald-600 p-6 rounded-xl text-left transition';
      }
    }
    document.getElementById('betaFork').classList.remove('hidden');
  }

  function chooseShop() {
    hideAllPanels();
    renderShop();
    document.getElementById('betaShop').classList.remove('hidden');
  }

  function chooseReward() {
    if (runState && runState.forkOfferTreasure) {
      chooseTreasure();
      return;
    }
    hideAllPanels();
    document.getElementById('betaRewardOptions').classList.remove('hidden');
    document.getElementById('betaRewardCardPicker').classList.add('hidden');
    document.getElementById('betaRewardConfirm').classList.add('hidden');
    document.getElementById('betaRewardNextFloor').textContent = runState.currentFloor;
    document.getElementById('betaReward').classList.remove('hidden');
  }

  // Phase 8+: Treasure node — pick a free relic from 2 random unowned ones
  function chooseTreasure() {
    hideAllPanels();
    const owned = (runState.relics || []);
    const allRelicIds = Object.keys(RELIC_CATALOG);
    const unowned = allRelicIds.filter(id => !owned.includes(id));
    const offers = shuffle(unowned).slice(0, Math.min(2, unowned.length));

    const list = document.getElementById('betaTreasureOffers');
    if (!list) return;
    list.innerHTML = '';
    if (offers.length === 0) {
      list.innerHTML = '<p class="text-rose-300 text-center">You already own every relic!</p>';
    } else {
      for (const id of offers) {
        const r = RELIC_CATALOG[id];
        const btn = document.createElement('button');
        btn.className = 'w-full bg-amber-700 hover:bg-amber-600 transition p-4 rounded-xl text-left mb-2';
        btn.innerHTML = '<div class="text-xl font-bold mb-1">' + escapeHtml(r.name) + '</div>' +
                        '<div class="text-xs opacity-80">' + escapeHtml(r.desc) + '</div>';
        btn.addEventListener('click', () => {
          runState.relics = runState.relics || [];
          runState.relics.push(id);
          log('Treasure node: gained ' + r.name + '!');
          document.getElementById('betaTreasureNextFloor').textContent = runState.currentFloor;
          document.getElementById('betaTreasureChoose').classList.add('hidden');
          document.getElementById('betaTreasureConfirm').classList.remove('hidden');
          document.getElementById('betaTreasureConfirmText').textContent = 'You gained ' + r.name + '.';
        });
        list.appendChild(btn);
      }
    }
    document.getElementById('betaTreasureChoose').classList.remove('hidden');
    document.getElementById('betaTreasureConfirm').classList.add('hidden');
    document.getElementById('betaTreasureNextFloor').textContent = runState.currentFloor;
    document.getElementById('betaTreasure').classList.remove('hidden');
  }

  // Phase 5: take the gold reward
  function takeRewardGold() {
    const got = addGold(REWARD_NODE_GOLD);
    log('Reward: +' + got + 'g (now ' + runState.gold + 'g).');
    showRewardConfirm('+' + got + 'g claimed.');
  }

  // Phase 5: open the card picker for the upgrade option
  function startRewardUpgrade() {
    document.getElementById('betaRewardOptions').classList.add('hidden');
    const list = document.getElementById('betaRewardCardList');
    list.innerHTML = '';
    let pickable = 0;
    for (const card of runState.runDeck) {
      if (card.affix) continue;  // skip already-affixed cards
      pickable++;
      const div = document.createElement('button');
      div.className = 'card card-face flex items-center justify-center text-2xl font-bold text-black rounded ring-2 ring-emerald-400 hover:ring-yellow-400 cursor-pointer transition';
      div.textContent = card.rank;
      const cardId = card.id;
      div.addEventListener('click', () => applyRewardUpgrade(cardId));
      list.appendChild(div);
    }
    if (pickable === 0) {
      list.innerHTML = '<p class="text-rose-300 text-sm">All your run-deck cards are already affixed. Take the gold instead.</p>';
    }
    document.getElementById('betaRewardCardPicker').classList.remove('hidden');
  }

  function applyRewardUpgrade(cardId) {
    const card = runState.runDeck.find(c => c.id === cardId);
    if (!card || card.affix) return;
    card.affix = 'gilded';
    log('Upgraded your ' + card.rank + ' to Gilded.');
    document.getElementById('betaRewardCardPicker').classList.add('hidden');
    showRewardConfirm('Upgraded ' + card.rank + ' to Gilded! +' +
                      GOLD_PER_GILDED_PER_TURN + 'g per turn while held in your hand.');
  }

  function cancelRewardUpgrade() {
    document.getElementById('betaRewardCardPicker').classList.add('hidden');
    document.getElementById('betaRewardOptions').classList.remove('hidden');
  }

  function showRewardConfirm(text) {
    document.getElementById('betaRewardConfirmText').textContent = text;
    document.getElementById('betaRewardConfirm').classList.remove('hidden');
  }

  function chooseEvent() {
    hideAllPanels();
    const ev = EVENTS[Math.floor(Math.random() * EVENTS.length)];
    const before = runState.gold;
    const result = ev.run();
    log('Event: ' + ev.title + ' — ' + result +
        ' (gold ' + before + 'g -> ' + runState.gold + 'g).');
    document.getElementById('betaEventTitle').textContent = ev.title;
    document.getElementById('betaEventText').textContent = ev.text;
    document.getElementById('betaEventResult').textContent = result;
    document.getElementById('betaEventNextFloor').textContent = runState.currentFloor;
    document.getElementById('betaEvent').classList.remove('hidden');
  }

  function continueAfterFork() {
    hideAllPanels();
    document.getElementById('betaGame').classList.remove('hidden');
    startRound();
  }

  function renderShop() {
    document.getElementById('betaShopGold').textContent = runState.gold;
    document.getElementById('betaShopNextFloor').textContent = runState.currentFloor;
    const list = document.getElementById('betaShopItems');
    list.innerHTML = '';
    for (const item of SHOP_ITEMS) {
      const isJoker = item.type === 'joker';
      const isRelic = item.type === 'relic';
      const equipped = isJoker && hasJoker(item.id);
      const ownedRelic = isRelic && hasRelic(item.id);
      const slotsFull = isJoker && runState.jokers.every(j => j !== null);
      const owned = isJoker ? (equipped ? 1 : 0) :
                    isRelic ? (ownedRelic ? 1 : 0) :
                    (runState.inventory[item.id] || 0);
      const canAfford = runState.gold >= item.price;
      const disabled = !item.enabled || !canAfford ||
                       (isJoker && (equipped || slotsFull)) ||
                       (isRelic && ownedRelic);

      const row = document.createElement('div');
      row.className = 'bg-black/40 p-4 rounded-xl flex items-center gap-4' +
                       (item.enabled ? '' : ' opacity-60');
      let btnLabel = item.enabled ? 'Buy' : 'Soon';
      if (isJoker && equipped) btnLabel = 'Equipped';
      else if (isJoker && slotsFull && !equipped) btnLabel = 'Slots full';
      else if (isRelic && ownedRelic) btnLabel = 'Owned';
      const priceTag = '<span class="text-yellow-300 font-bold">' + item.price + 'g</span>';
      row.innerHTML =
        '<div class="flex-1">' +
          '<div class="font-bold">' + escapeHtml(item.name) + ' &middot; ' + priceTag + '</div>' +
          '<div class="text-xs text-emerald-200 mt-1">' + escapeHtml(item.desc) + '</div>' +
          '<div class="text-xs text-emerald-300 mt-1">Owned: ' + owned + '</div>' +
        '</div>' +
        '<button class="bg-yellow-500 hover:bg-yellow-400 text-black transition px-4 py-2 rounded-lg font-bold disabled:opacity-40 disabled:cursor-not-allowed"' +
        (disabled ? ' disabled' : '') + '>' + btnLabel + '</button>';
      const buyBtn = row.querySelector('button');
      if (!disabled) {
        buyBtn.addEventListener('click', () => {
          if (runState.gold < item.price) return;
          if (item.type === 'service') {
            if (item.id === 'glassShard') startGlassShardApply(item);
            else if (item.id === 'forger') startForgerApply(item);
            else if (item.id === 'tracer') startTracerApply(item);
            else if (item.id === 'devilsBargain') startDevilsBargainApply(item);
            else if (item.id === 'magnet') startMagnetApply(item);
            else if (item.id === 'spikedWire') startAffixApply(item, 'spiked');
            else if (item.id === 'steelPlating') startAffixApply(item, 'steel');
            else if (item.id === 'mirageLens') startAffixApply(item, 'mirage');
            else if (item.id === 'stripper') startStripperApply(item);
          } else if (item.type === 'relic') {
            if (hasRelic(item.id)) return;
            runState.gold -= item.price;
            runState.relics = runState.relics || [];
            runState.relics.push(item.id);
            log('Acquired relic: ' + item.name + '. (-' + item.price + 'g)');
            renderShop();
          } else if (item.type === 'joker') {
            // Phase 5: equip joker into first empty slot
            if (hasJoker(item.id)) return;
            if (runState.jokers.every(j => j !== null)) {
              log('Both joker slots full. Cannot equip ' + item.name + '.');
              return;
            }
            const data = JOKER_CATALOG[item.id];
            if (!data) return;
            runState.gold -= item.price;
            equipJoker(data);
            // Tattletale gets its first charge immediately on equip
            if (item.id === 'tattletale') {
              runState.tattletaleChargesThisFloor = TATTLETALE_CHARGES_PER_FLOOR;
            }
            log('Equipped joker: ' + data.name + '. (-' + item.price + 'g)');
            renderShop();
          } else {
            runState.gold -= item.price;
            runState.inventory[item.id] = owned + 1;
            log('Bought ' + item.name + ' for ' + item.price + 'g (now ' + runState.gold + 'g).');
            renderShop();
          }
        });
      }
      list.appendChild(row);
    }
  }

  // ============================================================
  // Phase 5: Shop services — Glass Shard and Forger
  // ============================================================

  // Phase 8+: generic affix applicator for Spiked Wire / Steel Plating / Mirage Lens
  function startAffixApply(item, affixId) {
    const eligible = runState.runDeck.filter(c => !c.affix);
    if (eligible.length === 0) {
      log(item.name + ': no unaffixed run-deck cards.');
      return;
    }
    showServicePicker({
      title: item.name + ' — pick a run-deck card to apply ' + affixId,
      cards: eligible,
      onPick: (cardId) => {
        const card = runState.runDeck.find(c => c.id === cardId);
        if (!card) return;
        runState.gold -= item.price;
        card.affix = affixId;
        log(item.name + ' applied to ' + card.rank + '. (-' + item.price + 'g)');
        closeServicePicker();
        renderShop();
      },
    });
  }

  // Phase 8+: Stripper — remove a card from run deck permanently
  function startStripperApply(item) {
    const eligible = runState.runDeck.filter(c => c.rank !== 'J');
    if (eligible.length <= 4) {
      log('Stripper: run deck too small to remove from (min 4 cards).');
      return;
    }
    showServicePicker({
      title: 'Stripper — pick a card to remove from your run deck (permanent)',
      cards: eligible,
      onPick: (cardId) => {
        runState.gold -= item.price;
        runState.runDeck = runState.runDeck.filter(c => c.id !== cardId);
        log('Stripper: removed a card from your run deck. Run deck size: ' + runState.runDeck.length + '. (-' + item.price + 'g)');
        closeServicePicker();
        renderShop();
      },
    });
  }

  function startGlassShardApply(item) {
    const eligible = runState.runDeck.filter(c => !c.affix);
    if (eligible.length === 0) {
      log('No unaffixed run-deck cards. Glass Shard cancelled.');
      return;
    }
    showServicePicker({
      title: 'Glass Shard \u2014 pick a run-deck card to apply Glass',
      cards: eligible,
      onPick: (cardId) => {
        const card = runState.runDeck.find(c => c.id === cardId);
        if (!card) return;
        runState.gold -= item.price;
        card.affix = 'glass';
        log('Glass Shard applied to ' + card.rank + '. (-' + item.price + 'g)');
        closeServicePicker();
        renderShop();
      },
    });
  }

  let forgerSource = null;

  function startForgerApply(item) {
    forgerSource = null;
    const eligible = runState.runDeck.filter(c => c.rank !== 'J');
    if (eligible.length < 2) {
      log('Forger needs 2+ non-Jack run-deck cards. Cancelled.');
      return;
    }
    showServicePicker({
      title: 'Forger \u2014 pick a SOURCE card (will be copied)',
      cards: eligible,
      onPick: (cardId) => {
        forgerSource = runState.runDeck.find(c => c.id === cardId);
        if (!forgerSource) return;
        const targets = runState.runDeck.filter(c => c.rank !== 'J' && c.id !== cardId);
        if (targets.length === 0) { closeServicePicker(); return; }
        showServicePicker({
          title: 'Forger \u2014 pick TARGET (becomes ' + forgerSource.rank +
                 (forgerSource.affix ? ' [' + forgerSource.affix + ']' : '') + ')',
          cards: targets,
          onPick: (targetId) => {
            const target = runState.runDeck.find(c => c.id === targetId);
            if (!target || !forgerSource) return;
            runState.gold -= item.price;
            target.rank = forgerSource.rank;
            target.affix = forgerSource.affix;
            log('Forger: target becomes ' + target.rank +
                (target.affix ? ' [' + target.affix + ']' : '') +
                '. (-' + item.price + 'g)');
            forgerSource = null;
            closeServicePicker();
            renderShop();
          },
        });
      },
    });
  }

  function showServicePicker(opts) {
    const itemsDiv = document.getElementById('betaShopItems');
    const continueBtn = document.getElementById('betaShopContinueBtn');
    itemsDiv.classList.add('hidden');
    continueBtn.classList.add('hidden');
    let picker = document.getElementById('betaShopServicePicker');
    if (!picker) {
      picker = document.createElement('div');
      picker.id = 'betaShopServicePicker';
      picker.className = 'mb-6';
      itemsDiv.parentNode.insertBefore(picker, itemsDiv);
    }
    picker.innerHTML = '';
    const title = document.createElement('p');
    title.className = 'text-emerald-200 mb-3 text-center font-bold';
    title.textContent = opts.title;
    picker.appendChild(title);
    const list = document.createElement('div');
    list.className = 'flex flex-wrap gap-2 justify-center mb-4';
    for (const card of opts.cards) {
      const btn = document.createElement('button');
      let cls = 'card card-face flex items-center justify-center text-2xl font-bold text-black rounded cursor-pointer hover:scale-105 transition';
      const ring = affixRingClass(card.affix);
      if (ring) cls += ' ' + ring;
      else if (card.owner === 0) cls += ' ring-2 ring-emerald-400';
      btn.className = cls;
      btn.textContent = card.rank;
      if (card.affix) btn.title = 'Affix: ' + card.affix;
      const id = card.id;
      btn.addEventListener('click', () => opts.onPick(id));
      list.appendChild(btn);
    }
    picker.appendChild(list);
    const cancel = document.createElement('button');
    cancel.className = 'bg-white/10 hover:bg-white/20 transition px-4 py-1 rounded text-sm';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', closeServicePicker);
    picker.appendChild(cancel);
    picker.classList.remove('hidden');
  }

  function closeServicePicker() {
    const picker = document.getElementById('betaShopServicePicker');
    if (picker) picker.classList.add('hidden');
    document.getElementById('betaShopItems').classList.remove('hidden');
    document.getElementById('betaShopContinueBtn').classList.remove('hidden');
    forgerSource = null;
  }

  // ============================================================
  // Phase 3: Smoke Bomb consumable
  // ============================================================

  // Phase 7+: Tracer — see top 3 of draw pile and rearrange
  function startTracerApply(item) {
    if (state.drawPile.length < 1) {
      log('Tracer: draw pile is empty.');
      return;
    }
    const topCount = Math.min(3, state.drawPile.length);
    const topIndices = [];
    for (let i = 0; i < topCount; i++) {
      topIndices.push(state.drawPile.length - 1 - i);
    }
    // top is the LAST element of the array (popped first)
    const topCards = topIndices.map(idx => state.drawPile[idx]);

    // Build picker: show 6 permutations and let user pick
    const itemsDiv = document.getElementById('betaShopItems');
    const continueBtn = document.getElementById('betaShopContinueBtn');
    itemsDiv.classList.add('hidden');
    continueBtn.classList.add('hidden');
    let picker = document.getElementById('betaShopServicePicker');
    if (!picker) {
      picker = document.createElement('div');
      picker.id = 'betaShopServicePicker';
      picker.className = 'mb-6';
      itemsDiv.parentNode.insertBefore(picker, itemsDiv);
    }
    picker.innerHTML = '';
    const title = document.createElement('p');
    title.className = 'text-emerald-200 mb-3 text-center font-bold';
    title.textContent = 'Tracer — top of draw pile (pick new order, top first)';
    picker.appendChild(title);
    const cardsRow = document.createElement('div');
    cardsRow.className = 'flex flex-wrap gap-2 justify-center mb-3';
    for (const c of topCards) {
      const div = document.createElement('div');
      let cls = 'card card-face flex items-center justify-center text-2xl font-bold text-black rounded';
      const ring = affixRingClass(c.affix);
      if (ring) cls += ' ' + ring;
      div.className = cls;
      div.textContent = c.rank;
      cardsRow.appendChild(div);
    }
    picker.appendChild(cardsRow);
    const labels = topCards.map(c => c.rank + (c.affix ? '*' : ''));
    const perms = topCount === 1 ? [[0]] :
                  topCount === 2 ? [[0,1],[1,0]] :
                                   [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
    const buttonsDiv = document.createElement('div');
    buttonsDiv.className = 'flex flex-wrap gap-2 justify-center mb-3';
    for (const perm of perms) {
      const btn = document.createElement('button');
      btn.className = 'bg-blue-600 hover:bg-blue-700 transition px-3 py-1 rounded font-bold text-sm';
      btn.textContent = perm.map(i => labels[i]).join(' → ');
      btn.addEventListener('click', () => {
        // Apply this permutation to the top of draw pile
        const newTop = perm.map(i => topCards[i]);
        // Remove the original top cards (last topCount elements)
        for (let i = 0; i < topCount; i++) state.drawPile.pop();
        // Push back in reverse so newTop[0] is on top (last element)
        for (let i = newTop.length - 1; i >= 0; i--) {
          state.drawPile.push(newTop[i]);
        }
        runState.gold -= item.price;
        log('Tracer: rearranged top of draw pile. (-' + item.price + 'g)');
        closeServicePicker();
        renderShop();
      });
      buttonsDiv.appendChild(btn);
    }
    picker.appendChild(buttonsDiv);
    const cancel = document.createElement('button');
    cancel.className = 'bg-white/10 hover:bg-white/20 transition px-4 py-1 rounded text-sm';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', closeServicePicker);
    picker.appendChild(cancel);
    picker.classList.remove('hidden');
  }

  // Phase 7+: Devil's Bargain — drop a hand card, draw a Cursed card
  function startDevilsBargainApply(item) {
    if (state.hands[0].length === 0) {
      log("Devil's Bargain: your hand is empty.");
      return;
    }
    if (state.drawPile.length === 0) {
      log("Devil's Bargain: draw pile is empty.");
      return;
    }
    showServicePicker({
      title: "Devil's Bargain — pick a hand card to drop to the draw pile bottom",
      cards: state.hands[0],
      onPick: (cardId) => {
        const idx = state.hands[0].findIndex(c => c.id === cardId);
        if (idx < 0) return;
        const dropped = state.hands[0].splice(idx, 1)[0];
        state.drawPile.unshift(dropped);
        const drawn = state.drawPile.pop();
        if (drawn.affix !== 'steel') drawn.affix = 'cursed';
        state.hands[0].push(drawn);
        runState.gold -= item.price;
        log("Devil's Bargain: dropped " + dropped.rank + ', drew ' + drawn.rank +
            (drawn.affix === 'cursed' ? ' (now Cursed)' : ' (Steel — unaffected)') +
            '. (-' + item.price + 'g)');
        closeServicePicker();
        renderShop();
      },
    });
  }

  // Phase 7+: Magnet — give a hand card (no Steel) to a random opponent
  function startMagnetApply(item) {
    const eligible = state.hands[0].filter(c => c.affix !== 'steel');
    if (eligible.length === 0) {
      log('Magnet: no eligible cards.');
      return;
    }
    showServicePicker({
      title: 'Magnet — pick a hand card to send to a random opponent',
      cards: eligible,
      onPick: (cardId) => {
        const idx = state.hands[0].findIndex(c => c.id === cardId);
        if (idx < 0) return;
        const card = state.hands[0].splice(idx, 1)[0];
        const targets = [];
        for (let i = 1; i < NUM_PLAYERS; i++) {
          if (!state.eliminated[i] && !state.finished[i]) targets.push(i);
        }
        if (targets.length === 0) {
          state.hands[0].push(card);
          log('Magnet: no eligible opponents. Card returned.');
          closeServicePicker();
          return;
        }
        const target = targets[Math.floor(Math.random() * targets.length)];
        state.hands[target].push(card);
        runState.gold -= item.price;
        log('Magnet: sent ' + card.rank + ' to ' + playerLabel(target) + '. (-' + item.price + 'g)');
        closeServicePicker();
        renderShop();
      },
    });
  }

  // Phase 7+: Loaded Die relic — reroll target rank, once per floor
  function useLoadedDie() {
    if (!hasRelic('loadedDie')) return;
    if (runState.loadedDieUsedThisFloor) return;
    if (state.gameOver) return;
    const candidates = RANKS.filter(r => r !== state.targetRank);
    state.targetRank = candidates[Math.floor(Math.random() * candidates.length)];
    runState.loadedDieUsedThisFloor = true;
    log('Loaded Die: target rerolled to ' + state.targetRank + '.');
    render();
  }

  function useSmokeBomb() {
    if (!state || state.gameOver || state.challengeOpen) return;
    if (state.currentTurn !== 0) return;
    if (state.finished[0] || state.eliminated[0]) return;
    if (!runState || runState.inventory.smokeBomb < 1) return;

    runState.inventory.smokeBomb--;
    log('You use a Smoke Bomb. Turn skipped.');
    selected.clear();
    advanceTurn(0);
    render();
    if (!state.gameOver && state.currentTurn !== 0) {
      setTimeout(botTurn, BOT_TURN_DELAY_MS);
    }
  }

  // Phase 4: Counterfeit — change the target rank for the rest of the round.
  // Once per round.
  let counterfeitPickOpen = false;

  function canUseCounterfeit() {
    if (!state || state.gameOver || state.challengeOpen) return false;
    if (state.currentTurn !== 0) return false;
    if (state.finished[0] || state.eliminated[0]) return false;
    if (state.counterfeitUsed) return false;
    if (!runState || runState.inventory.counterfeit < 1) return false;
    return true;
  }

  function startCounterfeitPick() {
    if (!canUseCounterfeit()) return;
    counterfeitPickOpen = true;
    render();
  }

  function applyCounterfeit(newRank) {
    if (!canUseCounterfeit()) return;
    if (newRank === state.targetRank) return;
    runState.inventory.counterfeit--;
    state.counterfeitUsed = true;
    state.counterfeitLock = true;  // survives the next Liar call's rotation
    const oldRank = state.targetRank;
    state.targetRank = newRank;
    counterfeitPickOpen = false;
    log('You use Counterfeit. Target rank: ' + oldRank + ' -> ' + newRank +
        '. (Lock held through the next Liar call.)');
    render();
  }

  function cancelCounterfeit() {
    counterfeitPickOpen = false;
    render();
  }

  function toggleDoubletalk() {
    if (!hasJoker('doubletalk')) return;
    if (state.gameOver || state.challengeOpen) return;
    if (state.currentTurn !== 0) return;
    if (state.doubletalkUsedThisRound) return;
    state.doubletalkArmed = !state.doubletalkArmed;
    log(state.doubletalkArmed ? 'Doubletalk armed: play 2-4 cards this turn.' : 'Doubletalk cancelled.');
    render();
  }

  function useSleightOfHand() {
    if (!hasJoker('sleightOfHand')) return;
    if (state.gameOver || state.challengeOpen) return;
    if (state.currentTurn !== 0) return;
    if (state.sleightUsedThisRound) return;
    if (state.drawPile.length === 0) return;
    state.sleightUsedThisRound = true;
    const card = state.drawPile.pop();
    state.hands[0].push(card);
    log('Sleight of Hand: drew a ' + card.rank + (card.affix ? ' (' + card.affix + ')' : '') + '.');
    render();
  }

  // Phase 4: Jack-be-Nimble — discard up to 2 Jacks from your hand.
  function useJackBeNimble() {
    if (!state || state.gameOver || state.challengeOpen) return;
    if (state.currentTurn !== 0) return;
    if (state.finished[0] || state.eliminated[0]) return;
    if (!runState || runState.inventory.jackBeNimble < 1) return;

    const jacks = state.hands[0].filter(c => c.rank === 'J').slice(0, 2);
    if (jacks.length === 0) return;

    runState.inventory.jackBeNimble--;
    const jackIds = new Set(jacks.map(c => c.id));
    state.hands[0] = state.hands[0].filter(c => !jackIds.has(c.id));
    log('You use Jack-be-Nimble. Discarded ' + jacks.length +
        (jacks.length === 1 ? ' Jack.' : ' Jacks.'));
    selected.clear();
    render();
  }

  // ============================================================
  // Wire up Phase 3 buttons
  // ============================================================

  document.getElementById('betaForkShopBtn').addEventListener('click', chooseShop);
  document.getElementById('betaForkRewardBtn').addEventListener('click', chooseReward);
  document.getElementById('betaForkEventBtn').addEventListener('click', chooseEvent);

  document.getElementById('betaShopContinueBtn').addEventListener('click', continueAfterFork);
  document.getElementById('betaRewardContinueBtn').addEventListener('click', continueAfterFork);
  document.getElementById('betaEventContinueBtn').addEventListener('click', continueAfterFork);
  const _trCont = document.getElementById('betaTreasureContinueBtn');
  if (_trCont) _trCont.addEventListener('click', continueAfterFork);
  document.getElementById('betaRewardGoldBtn').addEventListener('click', takeRewardGold);
  document.getElementById('betaRewardUpgradeBtn').addEventListener('click', startRewardUpgrade);
  document.getElementById('betaRewardCancelUpgradeBtn').addEventListener('click', cancelRewardUpgrade);

  document.getElementById('betaUseSmokeBtn').addEventListener('click', useSmokeBomb);

  // Phase 8+: admin cheats wiring
  const _admBtn = document.getElementById('betaAdminCheatsBtn');
  if (_admBtn) _admBtn.addEventListener('click', openAdminCheats);
  const _admClose = document.getElementById('betaAdminCheatsCloseBtn');
  if (_admClose) _admClose.addEventListener('click', closeAdminCheats);
  const _admModal = document.getElementById('betaAdminCheatsModal');
  if (_admModal) _admModal.addEventListener('click', (e) => {
    if (e.target === _admModal) closeAdminCheats();
  });
  const _addGold = document.getElementById('betaCheatAddGoldBtn');
  if (_addGold) _addGold.addEventListener('click', () => {
    const v = parseInt(document.getElementById('betaCheatGoldInput').value, 10) || 0;
    adminAddGold(v);
  });
  const _setHearts = document.getElementById('betaCheatSetHeartsBtn');
  if (_setHearts) _setHearts.addEventListener('click', () => {
    const v = parseInt(document.getElementById('betaCheatHeartsInput').value, 10) || 0;
    adminSetHearts(v);
  });
  const _skipFloor = document.getElementById('betaCheatSkipFloorBtn');
  if (_skipFloor) _skipFloor.addEventListener('click', () => {
    const v = parseInt(document.getElementById('betaCheatFloorInput').value, 10) || 1;
    adminSkipToFloor(v);
  });
  const _trigFork = document.getElementById('betaCheatTriggerForkBtn');
  if (_trigFork) _trigFork.addEventListener('click', adminTriggerFork);
  const _winRound = document.getElementById('betaCheatWinRoundBtn');
  if (_winRound) _winRound.addEventListener('click', adminWinRound);
  const _loseRound = document.getElementById('betaCheatLoseRoundBtn');
  if (_loseRound) _loseRound.addEventListener('click', adminLoseRound);
  const _allCons = document.getElementById('betaCheatGetAllConsumablesBtn');
  if (_allCons) _allCons.addEventListener('click', adminStackConsumables);
  const _allJokers = document.getElementById('betaCheatGetAllJokersBtn');
  if (_allJokers) _allJokers.addEventListener('click', adminEquipJokers);
  const _allRelics = document.getElementById('betaCheatGetAllRelicsBtn');
  if (_allRelics) _allRelics.addEventListener('click', adminGrantAllRelics);
  const _addShard = document.getElementById('betaCheatAddShardBtn');
  if (_addShard) _addShard.addEventListener('click', adminAddShard);
  const _revealHands = document.getElementById('betaCheatRevealHandsBtn');
  if (_revealHands) _revealHands.addEventListener('click', adminRevealHands);
  const _refill = document.getElementById('betaCheatRefillHandBtn');
  if (_refill) _refill.addEventListener('click', adminRefillHand);

  // Phase 5+: info modal close handlers
  const _infoClose = document.getElementById('betaInfoCloseBtn');
  if (_infoClose) _infoClose.addEventListener('click', closeInfoModal);
  const _infoModal = document.getElementById('betaInfoModal');
  if (_infoModal) {
    _infoModal.addEventListener('click', (e) => {
      if (e.target === _infoModal) closeInfoModal();
    });
  }

  // Phase 6: resume/restart prompt when re-entering beta with an active run.
  // The inline script in index.html already toggles betaTesting visibility;
  // this handler runs in addition to it and surfaces the resume modal when
  // there's a runState to fall back into.
  // Phase 7: pause/resume timers when leaving/returning to beta mid-run
  let _pausedChallenge = false;

  function pauseBetaRun() {
    if (!state) return;
    clearAllTimers();
    const bar = document.getElementById('betaChallengeBar');
    if (bar) bar.classList.add('hidden');
    if (state.challengeOpen) {
      _pausedChallenge = true;
      state.challengeOpen = false;
    }
  }

  function resumeBetaRun() {
    if (!state || state.gameOver) return;
    if (_pausedChallenge && state.lastPlay) {
      _pausedChallenge = false;
      // Treat the paused challenge as a no-call (timer effectively expired)
      handlePassNoChallenge(state.lastPlay.playerIdx);
      return;
    }
    // If it's a bot's active turn, schedule its play
    if (state.currentTurn !== 0 &&
        !state.eliminated[state.currentTurn] &&
        !state.finished[state.currentTurn]) {
      setTimeout(botTurn, BOT_TURN_DELAY_MS);
    }
    render();
  }

  // Hook back-to-lobby button to pause
  const _betaBackBtnPause = document.getElementById('betaBackBtn');
  if (_betaBackBtnPause) {
    _betaBackBtnPause.addEventListener('click', () => {
      if (runState && state) pauseBetaRun();
    });
  }

  function showResumeModal() {
    const modal = document.getElementById('betaResumeModal');
    if (!modal || !runState) return;
    // Populate context line
    const floorEl = document.getElementById('betaResumeFloor');
    const charEl = document.getElementById('betaResumeChar');
    const heartsEl = document.getElementById('betaResumeHearts');
    if (floorEl) floorEl.textContent = 'Floor ' + (runState.currentFloor || 1) + '/' + TOTAL_FLOORS;
    if (charEl) charEl.textContent = (runState.character && runState.character.name) || 'No character';
    if (heartsEl) heartsEl.textContent = heartsString(runState.hearts);
    modal.classList.remove('hidden');
  }
  function closeResumeModal() {
    const modal = document.getElementById('betaResumeModal');
    if (modal) modal.classList.add('hidden');
  }

  const _betaTestBtn = document.getElementById('betaTestBtn');
  if (_betaTestBtn) {
    _betaTestBtn.addEventListener('click', () => {
      // Only prompt if there's an active run worth resuming
      if (runState) showResumeModal();
      // Phase 7: refresh run history (intro panel)
      renderRunHistory();
    });
  }

  const _resumeContinueBtn = document.getElementById('betaResumeContinueBtn');
  if (_resumeContinueBtn) {
    _resumeContinueBtn.addEventListener('click', () => {
      closeResumeModal();
      resumeBetaRun();  // Phase 7: restart paused timers
    });
  }

  const _resumeNewBtn = document.getElementById('betaResumeNewBtn');
  if (_resumeNewBtn) {
    _resumeNewBtn.addEventListener('click', () => {
      closeResumeModal();
      backToIntro();  // resets runState and shows the intro screen
    });
  }

  // Click outside the resume modal to close it (treat as "continue")
  const _resumeModal = document.getElementById('betaResumeModal');
  if (_resumeModal) {
    _resumeModal.addEventListener('click', (e) => {
      if (e.target === _resumeModal) closeResumeModal();
    });
  }
  const _tt = document.getElementById('betaTattletaleBtn');
  if (_tt) _tt.addEventListener('click', useTattletale);
  document.getElementById('betaUseCounterfeitBtn').addEventListener('click', startCounterfeitPick);
  document.getElementById('betaUseJackBtn').addEventListener('click', useJackBeNimble);
  document.getElementById('betaCounterfeitCancelBtn').addEventListener('click', cancelCounterfeit);
  const _dtBtn = document.getElementById('betaDoubletalkBtn');
  if (_dtBtn) _dtBtn.addEventListener('click', toggleDoubletalk);
  const _sohBtn = document.getElementById('betaSleightBtn');
  if (_sohBtn) _sohBtn.addEventListener('click', useSleightOfHand);
  const _ldBtn = document.getElementById('betaLoadedDieBtn');
  if (_ldBtn) _ldBtn.addEventListener('click', useLoadedDie);

})();
