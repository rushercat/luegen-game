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
      // Design doc: starts with Safety Net (extends the "I can hold more"
      // identity). Was 'slowHand' which is a different fantasy.
      startingJoker: 'safetyNet',
      unlockAtFloor: 4,
      unlockHint: 'Reach Floor 4 in any run.',
    },
    banker: {
      id: 'banker', name: 'The Banker',
      flavor: "\"Came in with capital. Every gilded card is just compounding.\"",
      passive: 'Start with 150g + a Gilded Ace in your run deck.',
      startingGold: 150,
      startingGildedA: true,
      // Design doc: starts with The Taxman (extends the "I print money"
      // identity). Was 'surveyor' which is information, not income.
      startingJoker: 'taxman',
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
    magician: {
      id: 'magician', name: 'The Magician',
      flavor: "\"Sleight is just slow magic. Once a round, the deck bends to me.\"",
      passive: 'Once per round: transform a hand card to a different rank (lossy: rank changes, affix wiped).',
      transformPerRound: true,
      startingJoker: 'sleightOfHand',
      unlockAtFloor: 3,
      unlockHint: 'Reach Floor 3 in any run.',
    },
    engineer: {
      id: 'engineer', name: 'The Engineer',
      flavor: "\"Affixes have grain — you just need to know where to apply pressure.\"",
      passive: 'Run deck starts with 1 random affixed card. Affix services 25% off.',
      engineerStartingAffix: true,
      affixDiscount: 0.25,
      startingJoker: 'forgeHand',
      unlockAtFloor: 5,
      unlockHint: 'Reach Floor 5 in any run.',
    },
    witch: {
      id: 'witch', name: 'The Witch',
      flavor: "\"Glass cuts both ways. Mine never reaches the cap.\"",
      passive: "Glass burns don't count toward the burn cap. Run deck starts with 1 Glass card.",
      witchUncappedGlass: true,
      startingGlassCard: true,
      startingJoker: null,
      unlockAtFloor: 7,
      unlockHint: 'Reach Floor 7 in any run.',
    },
    // Design doc — was missing entirely from CHARACTER_CATALOG. The
    // whisperPeek flag is read at round start (see startRound) and triggers
    // a directional peek picker: choose left or right neighbour, see one
    // random card from their starting hand. Distinct from Bait, which peeks
    // a random opponent automatically.
    whisper: {
      id: 'whisper', name: 'The Whisper',
      flavor: "\"Half a word from the right neighbour is worth a hand of cards.\"",
      passive: 'Round start: choose a neighbour (left/right) and see one random card from their hand.',
      whisperPeek: true,
      startingJoker: 'eavesdropper',
      unlockAtFloor: 9,
      unlockHint: 'Reach Floor 9 in any run.',
    },
    // Wildcard-coded variance archetype. Every round, every run-deck card
    // sheds its current affix and gets a fresh random one — Steel included
    // (this character explicitly violates Steel's normal "immune to affix
    // mutation" rule, which is the point of the build). The reroll picks
    // uniformly from all 8 affixes and re-fires every round, so a Glass-
    // burned RANDOM.EXE Ace might come back as Spiked next round, then as
    // Cursed, then as Steel, then back to Gilded. Builds favour breadth
    // over depth: Wildcard / Trickster jokers, Tracer for Spiked timing,
    // Lucky Coin to pre-roll favourable affixes when the bias matters.
    //
    // Compensation: 20% off run-deck card purchases in the shop. The reroll
    // makes long-term card investment less reliable (your Gilded Ace might
    // become a Cursed Ace next round), so the discount lets the player buy
    // *more* cards to soak the variance.
    randomExe: {
      id: 'randomExe', name: 'RANDOM.EXE',
      flavor: "\">>> seed = roll(now); commit; reboot.\"",
      passive: 'Round start: every run-deck card sheds its affix and gains a new random one (Steel is not safe). Run-deck cards in the shop cost 20% less.',
      apostateReroll: true,
      cardDiscount: 0.20,
      startingJoker: null,
      unlockAtFloor: 6,
      unlockHint: 'Reach Floor 6 in any run.',
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
    // Guests (no account) only get The Rookie. Sign in to unlock the rest
    // through floor progression / run wins.
    if (!getAuthToken()) return false;
    if (char.unlockOnRunWin) return hasWonRun();
    if (char.unlockAtFloor !== undefined) {
      return getMaxFloorReached() >= char.unlockAtFloor;
    }
    return true;
  }

  // Phase 8+: floor modifiers (Act 2+ on non-boss floors)
  const FLOOR_MODIFIERS = {
    foggy:    { id: 'foggy',    name: 'Foggy',    desc: 'Target rank fades after 5 seconds.' },
    greedy:   { id: 'greedy',   name: 'Greedy',   desc: '+100% gold, but Jack limit drops to 3.' },
    brittle:  { id: 'brittle',  name: 'Brittle',  desc: 'Every card is temporarily Glass for this floor.' },
    echoing:  { id: 'echoing',  name: 'Echoing',  desc: 'Each play: 20% chance the first card is flashed to all players.' },
    silent:   { id: 'silent',   name: 'Silent',   desc: 'No bot tells are visible this floor.' },
    tariff:   { id: 'tariff',   name: 'Tariff',   desc: 'Each Liar call you make costs 5g.' },
    inverted: { id: 'inverted', name: 'Inverted', desc: 'Target rank is locked to J this floor — Jacks are truth, all other ranks are bluffs.' },
    sticky:   { id: 'sticky',   name: 'Sticky',   desc: 'Once a card is revealed, it stays face-up in the pile area for the rest of the round.' },
    rapid:    { id: 'rapid',    name: 'Rapid',    desc: 'Challenge windows are 2 seconds for everyone.' },
    richFolk: { id: 'richFolk', name: 'Rich Folk', desc: 'Gold rewards halved, but joker prices in the shop are 50% off.' },
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
  // Floor 9 has 3 possible bosses — Lugen (default), and the alts
  // The Mirror and The Hollow that unlock after the first run win.
  const BOSS_CATALOG = {
    auditor: { id: 'auditor', name: 'The Auditor', floor: 3, bluffRate: 0.30, challengeRate: 1.00, tell: 'snaps the ledger shut', desc: 'Challenges every Nth play (N rolls 1–5 each round).' },
    cheater: { id: 'cheater', name: 'The Cheater', floor: 6, bluffRate: 1.00, challengeRate: 0.30, tell: 'a tiny smirk on 1-in-4 lies', desc: 'Lies on every play.' },
    lugen:   { id: 'lugen',   name: 'Lugen',       floor: 9, bluffRate: 0.55, challengeRate: 0.50, tell: null, desc: 'Starts with 7 cards, Jack limit 6, every play is randomly affixed. Can call Liar out-of-turn once per round.' },
    mirror:  { id: 'mirror',  name: 'The Mirror',  floor: 9, bluffRate: 0.50, challengeRate: 0.50, tell: null, alt: true, desc: 'Plays whatever you played last turn. Disrupt your own pattern to beat it.' },
    hollow:  { id: 'hollow',  name: 'The Hollow',  floor: 9, bluffRate: 0.50, challengeRate: 0.50, tell: null, alt: true, desc: 'Hand size is hidden from you. Pure paranoia.' },
  };

  function isBossFloor(f) { return f === 3 || f === 6 || f === 9; }
  // Returns the *active* boss for a given floor, considering Floor 9 alts.
  function getBoss(f) {
    if (f === 9 && runState && runState.floor9BossId) {
      return BOSS_CATALOG[runState.floor9BossId] || BOSS_CATALOG.lugen;
    }
    for (const id of Object.keys(BOSS_CATALOG)) {
      const b = BOSS_CATALOG[id];
      if (b.floor === f && !b.alt) return b;
    }
    return null;
  }
  // Pick which Floor 9 boss the player faces. Lugen is the default;
  // Mirror and Hollow unlock after the first full run win.
  function pickFloor9Boss() {
    if (!hasWonRun()) return 'lugen';
    const pool = ['lugen', 'mirror', 'hollow'];
    return pool[Math.floor(Math.random() * pool.length)];
  }
  function getCurrentAct() {
    if (!runState) return 1;
    if (runState.currentFloor <= 3) return 1;
    if (runState.currentFloor <= 6) return 2;
    return 3;
  }
  function shouldShowTells() {
    if (runState && runState.currentFloorModifier === 'silent') return false;
    if (hasRelic('compass')) return true;  // Compass: tells visible in Act III too.
    return getCurrentAct() <= 2;  // Act 3 = no tells (without Compass)
  }
  function getBotPersonality(botIdx) {
    if (!runState || !runState.botPersonalities) return null;
    return runState.botPersonalities[botIdx] || null;
  }

  // Phase 7+: relics — permanent passive bonuses (one of each per run)
  const BOSS_RELIC_POOL = {
    auditor: ['crackedCoin', 'loadedDie', 'tarnishedCrown'],
    cheater: ['pocketWatch', 'handMirror', 'compass'],
    lugen:   ['ironStomach', 'ledger', 'bookmark'],
  };
  // Treasure-pool relics — only offered at Treasure nodes (Act III). Mogul is
  // not in the regular pool because it has a separate unlock (5 Lugen kills);
  // it's still pickable via the unlock-aware filter in chooseTreasure.
  const TREASURE_POOL = [
    'hourglass', 'seersEye', 'crackedMirror', 'dragonScale',
    'cowardsCloak', 'steelSpine', 'stackedDeck', 'mogul',
  ];
  const RELIC_CATALOG = {
    crackedCoin: { id: 'crackedCoin', name: 'Cracked Coin', price: 200, desc: 'Each round start: gain 5g × Hearts remaining.' },
    loadedDie:   { id: 'loadedDie',   name: 'Loaded Die',   price: 200, desc: 'Once per floor, reroll the Target Rank for the current round.' },
    pocketWatch: { id: 'pocketWatch', name: 'Pocket Watch', price: 200, desc: 'Your challenge window is +5 seconds (stacks).' },
    handMirror:  { id: 'handMirror',  name: 'Hand Mirror',  price: 250, desc: 'At round start, see one random card from each opponent.' },
    ironStomach: { id: 'ironStomach', name: 'Iron Stomach', price: 300, desc: 'Glass-burned run-deck cards return as Steel at end of round.' },
    ledger:      { id: 'ledger',      name: 'The Ledger',   price: 300, desc: '+25% gold from all sources (stacks with Gambler).' },
    hourglass:    { id: 'hourglass',    name: 'The Hourglass',    price: 250, desc: 'Treasure. Your challenge window is +4s. Bots without it have their windows reduced by 30%.' },
    seersEye:     { id: 'seersEye',     name: "Seer's Eye",       price: 250, desc: 'Treasure. See the affix ring (not rank) on every card in every opponent\'s hand.' },
    crackedMirror:{ id: 'crackedMirror',name: 'Cracked Mirror',   price: 300, desc: 'Treasure. Once per floor: rewind your last play (cards back to hand, pile reverted) — bots\' choices are NOT redone.' },
    dragonScale:  { id: 'dragonScale',  name: 'Dragon Scale',     price: 300, desc: 'Treasure. Steel cards in your hand grant +1 Jack limit (max +1, regardless of Steel count) and +10% gold per Steel card.' },
    compass:      { id: 'compass',      name: 'The Compass',      price: 300, desc: 'Boss reward. Bot tells become readable in Act III (normally silent).' },
    tarnishedCrown:{ id: 'tarnishedCrown', name: 'Tarnished Crown', price: 250, desc: 'Boss reward. Win a floor without losing any Hearts on it = +50g bonus.' },
    cowardsCloak: { id: 'cowardsCloak', name: "Coward's Cloak",   price: 200, desc: 'Treasure. Your "Pass" actions never trigger Echo / Eavesdropper / Cold Read peeks on your hand.' },
    bookmark:     { id: 'bookmark',     name: 'The Bookmark',     price: 350, desc: 'Boss reward. End of each round: optionally save a hand card into your run deck (replacing one).' },
    steelSpine:   { id: 'steelSpine',   name: 'Steel Spine',      price: 200, desc: 'Treasure. Cursed cards block Liar for 1 turn instead of 2 after pickup.' },
    stackedDeck:  { id: 'stackedDeck',  name: 'Stacked Deck',     price: 250, desc: 'Treasure. Run deck cap raised from 24 to 32.' },
    mogul:        { id: 'mogul',        name: 'The Mogul',        price: 400, desc: "Treasure (Lugen-locked). Shop offers +1 of each (4 jokers, 4 cards, 4 consumables) and 10% off everything. Unlocks after 5 Lugen kills.", unlock: { type: 'lugenKills', count: 5 } },
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
    scapegoat: { id: 'scapegoat', name: 'The Scapegoat', rarity: 'Uncommon', price: 150, desc: "If you are caught lying with a Jack in the pile, ONE Jack is forced into the challenger's hand. The rest of the pile still goes to you." },
    hotSeat: { id: 'hotSeat', name: 'Hot Seat', rarity: 'Uncommon', price: 150, desc: "Your right neighbor's challenge window is 3 seconds (default 5)." },
    sleightOfHand: { id: 'sleightOfHand', name: 'Sleight of Hand', rarity: 'Uncommon', price: 150, desc: "Once per round, on your turn, draw 1 card from the top of the draw pile." },
    spikedTrap: { id: 'spikedTrap', name: 'Spiked Trap', rarity: 'Rare', price: 250, desc: "If you tell the truth and are challenged, the challenger draws 3 extra cards." },
    tattletale: { id: 'tattletale', name: 'Tattletale', rarity: 'Rare', price: 250, desc: "Once per floor, peek at a player's full hand for 4 seconds." },
    safetyNet: { id: 'safetyNet', name: 'Safety Net', rarity: 'Rare', price: 250, desc: "Your Jack limit is increased by 1 (4 -> 5, stacks with Hoarder)." },
    doubletalk: { id: 'doubletalk', name: 'Doubletalk', rarity: 'Rare', price: 250, desc: "Once per round, declare a double-turn: play 2-4 cards instead of 1-3." },
    blackHole: { id: 'blackHole', name: 'Black Hole', rarity: 'Legendary', price: 400, desc: "On a successful Jack bluff (no challenge), delete one non-Jack card from your hand." },
    coldRead: { id: 'coldRead', name: 'Cold Read', rarity: 'Legendary', price: 400, desc: "At the start of each round, see one random card from each opponent's hand." },
    vengefulSpirit: { id: 'vengefulSpirit', name: 'Vengeful Spirit', rarity: 'Legendary', price: 400, desc: "If the Jack curse takes you, the next active player starts the next round with 2 forced Jacks." },
    magpie:        { id: 'magpie',        name: 'The Magpie',     rarity: 'Common',    price: 80,  desc: "When an opponent picks up the pile, gain 1g per affixed card in it." },
    forgeHand:     { id: 'forgeHand',     name: 'Forge Hand',     rarity: 'Common',    price: 80,  desc: "Affix-applying shop services (Glass Shard, Spiked Wire, Steel Plating) cost 25% less." },
    lastWord:      { id: 'lastWord',      name: 'Last Word',      rarity: 'Uncommon',  price: 150, desc: "Once per floor: when caught lying, veto the result (pile goes to challenger). Can't use if your last hand card was in the play." },
    ricochet:      { id: 'ricochet',      name: 'Ricochet',       rarity: 'Uncommon',  price: 150, desc: "When you take a pile of 3+ Jacks, half (rounded down) bounce to a random opponent." },
    memorizer:     { id: 'memorizer',     name: 'The Memorizer',  rarity: 'Uncommon',  price: 150, desc: "Every revealed card on a Liar call is logged in a private side panel for the rest of the round." },
    trickster:     { id: 'trickster',     name: 'The Trickster',  rarity: 'Uncommon',  price: 150, desc: "Once per round, mark a hand card as a +/-1 wildcard (counts as truth if its rank is one step from the target)." },
    carouser:      { id: 'carouser',      name: 'The Carouser',   rarity: 'Rare',      price: 250, desc: "Smoke Bomb, Counterfeit, and Jack-be-Nimble each get 1 free use per floor (no charge consumed)." },
    hotPotato:     { id: 'hotPotato',     name: 'Hot Potato',     rarity: 'Rare',      price: 250, desc: "After picking up 5+ cards, your max play is 5 cards (instead of 3) for the next turn only." },
    saboteur:      { id: 'saboteur',      name: 'The Saboteur',   rarity: 'Rare',      price: 250, desc: "Once per floor, force a target opponent to take 1 random card from your hand (Jacks are ~30% more likely to be picked)." },
    doppelganger:  { id: 'doppelganger',  name: 'Doppelganger',   rarity: 'Legendary', price: 400, desc: "Once per round, your next play exactly mimics the previous play (same count, same claim)." },
    deadHand:      { id: 'deadHand',      name: 'Dead Hand',      rarity: 'Legendary', price: 400, desc: "Once per floor: when you take the pile, the first 2 Jacks stay in the pile (sent to the bottom of the draw pile instead of your hand)." },
    patron:        { id: 'patron',        name: 'The Patron',     rarity: 'Legendary', price: 400, desc: "+1g per Gilded card in your hand on every turn (stacks with Gilded's base +2g)." },
    hometownHero:  { id: 'hometownHero',  name: 'Hometown Hero',   rarity: 'Uncommon',  price: 150, desc: 'Each round: at least 50% of your starting hand is drawn from your own run deck (vs. 30% baseline).' },
    alchemist:     { id: 'alchemist',     name: 'The Alchemist',   rarity: 'Rare',      price: 250, desc: 'Once per round: transform a hand card (even Steel) into a different card with a random positive affix (Gilded / Mirage / Echo / Hollow).' },
    callersMark:   { id: 'callersMark',   name: "Caller's Mark",   rarity: 'Uncommon',  price: 150, desc: 'The first time each round you call LIAR, you gain 20g if right or lose 15g if wrong. Rewards reads, punishes spam.' },
    // Sixth Sense — stackable Uncommon. After every opponent's play, rolls
    // a 15% × stack chance to silently reveal whether the play was a bluff.
    // Buying again while equipped bumps the stack (max 3 = up to 45%/play).
    // The reveal is private — opponents don't know you peeked.
    sixthSense:    { id: 'sixthSense',    name: 'Sixth Sense',     rarity: 'Uncommon',  price: 150, stackable: true, maxStack: 3, desc: 'After each opponent play: 15% chance per stack to privately learn if it was a bluff. Stacks up to 3 (max 45% per play). Rebuy to stack.' },
    // The Screamer — once per floor, name a rank. For the rest of that
    // round, every card of that rank in any hand is publicly revealed in
    // the opponents panel (face-up beneath the hand-size number). Loud,
    // asymmetric. Activate via window.lugenUseScreamer('K') (or whichever
    // rank). UI button is a follow-up; the gameplay is wired.
    screamer:      { id: 'screamer',      name: 'The Screamer',    rarity: 'Legendary', price: 400, desc: "Once per floor: name a rank. For the rest of that round, every card of that rank in any hand is publicly revealed. Activate via lugenUseScreamer('K')." },
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
      // Bumped from 35g to 50g and gated to once-per-floor (was once-per-round)
      // to match the design doc. Cheaper-and-faster turned this into a reflex
      // button; floor-locked makes it a real timing decision.
      price: 50,
      floorLocked: true,
      desc: 'Change the target rank now AND lock it through the next Liar call (target survives one rotation). Once per floor.',
      enabled: true,
    },
    {
      id: 'jackBeNimble',
      name: 'Jack-be-Nimble',
      price: 90,
      desc: 'Discard up to 2 Jacks from your hand. Use anytime on your turn.',
      enabled: true,
    },
    { id: 'whisperNetwork', name: 'Whisper Network', price: 30,  desc: 'Hear how many Jacks each opponent currently holds (private, single read).', enabled: true },
    { id: 'luckyCoin',      name: 'Lucky Coin',      price: 20,  desc: "Re-roll the affix on one hand card to a random new one (Steel-immune; Cursed clears).", enabled: true },
    { id: 'snakeEyes',      name: 'Snake Eyes',      price: 45,  desc: 'Cancel the next Target Rank rotation (target stays the same after the next Liar call).', enabled: true },
    { id: 'emptyThreat',    name: 'Empty Threat',    price: 40,  desc: 'Floor-locked. Feign a Liar call against the next bot play — they react cautiously, no real call.', enabled: true },
    { id: 'distillation',   name: 'Distillation',    price: 60,  desc: 'Merge 2 same-rank hand cards into 1 with a random affix (Steel/Mirage-immune).', enabled: true },
    { id: 'pickpocket',     name: 'Pickpocket',      price: 90,  desc: 'Floor-locked. Steal a random non-Jack from an opponent (positive affixes weighted higher).', enabled: true },
    { id: 'deadDrop',       name: 'Dead Drop',       price: 70,  desc: 'Discard 3 random hand cards, then draw 3 from the draw pile.', enabled: true },
    { id: 'markedDeck',     name: 'Marked Deck',     price: 100, desc: 'Floor-locked. Apply a chosen affix to a random draw-pile card.', enabled: true },
    { id: 'jokersMask',     name: "The Joker's Mask",price: 75,  desc: 'One-shot: tag a non-Jack so it counts as a Jack for the curse (use with Safety Net / Vengeful Spirit).', enabled: true },
    { id: 'mirrorShard',    name: 'Mirror Shard',    price: 45,  desc: 'Arm: the next Liar call against you reveals only the result, not the cards.', enabled: true },
    { id: 'stackedHand',    name: 'Stacked Hand',    price: 100, desc: 'Arm: next round, +20% extra of your starting hand is pulled from your run deck. Stacks with Hometown Hero.', enabled: true },
    // Crooked Die — the Loaded Die relic effect, but as a consumable.
    // Floor-locked so you can't stockpile rerolls; per design.
    { id: 'crookedDie',     name: 'Crooked Die',     price: 50,  desc: 'Re-roll the Target Rank for this round only. Floor-locked (one purchase per floor).', enabled: true, floorLocked: true },
    // Lie Detector — armable. Once armed, the next time you can call LIAR
    // a "peek" button appears; clicking it shows truth/lie privately, then
    // you decide whether to actually call.
    { id: 'lieDetector',    name: 'Lie Detector',    price: 60,  desc: 'Arm: the next time you can call LIAR, peek the truth privately before deciding.', enabled: true },
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
    { id: 'engraver',     name: 'Engraver',     price: 80,  desc: 'Add one new vanilla card (A, K, Q, or 10) to your run deck.', enabled: true, type: 'service' },
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
    { id: 'vengefulSpirit',name:'JOKER · Vengeful Spirit', price: 400, desc: '[Legendary] Jack-cursed = next active player starts next round with 2 forced Jacks.', enabled: true, type: 'joker' },
    { id: 'magpie',       name: 'JOKER · The Magpie',     price: 80,  desc: '[Common] Opponent pickup = +1g per affixed card.',                                                              enabled: true, type: 'joker' },
    { id: 'forgeHand',    name: 'JOKER · Forge Hand',     price: 80,  desc: '[Common] Glass Shard / Spiked Wire / Steel Plating cost 25% less.',                                            enabled: true, type: 'joker' },
    { id: 'lastWord',     name: 'JOKER · Last Word',      price: 150, desc: '[Uncommon] Once per floor: veto a Liar call against you.',                                                     enabled: true, type: 'joker' },
    { id: 'ricochet',     name: 'JOKER · Ricochet',       price: 150, desc: '[Uncommon] Pile of 3+ Jacks taken = half bounce to a random opponent.',                                        enabled: true, type: 'joker' },
    { id: 'memorizer',    name: 'JOKER · The Memorizer',  price: 150, desc: '[Uncommon] Reveals are logged in a private panel for the round.',                                              enabled: true, type: 'joker' },
    { id: 'trickster',    name: 'JOKER · The Trickster',  price: 150, desc: '[Uncommon] Once per round: mark a hand card as a +/-1 wildcard.',                                              enabled: true, type: 'joker' },
    { id: 'carouser',     name: 'JOKER · The Carouser',   price: 250, desc: '[Rare] Smoke / Counterfeit / Jack-be-Nimble: 1 free use each per floor.',                                       enabled: true, type: 'joker' },
    { id: 'hotPotato',    name: 'JOKER · Hot Potato',     price: 250, desc: '[Rare] After 5+ pickup: next turn max play = 5 cards.',                                                         enabled: true, type: 'joker' },
    { id: 'saboteur',     name: 'JOKER · The Saboteur',   price: 250, desc: '[Rare] Once per floor: dump a random card from your hand (Jacks more likely) into a chosen opponent.',         enabled: true, type: 'joker' },
    { id: 'doppelganger', name: 'JOKER · Doppelganger',   price: 400, desc: '[Legendary] Once per round: next play forced to match previous play (count + claim).',                          enabled: true, type: 'joker' },
    { id: 'deadHand',     name: 'JOKER · Dead Hand',      price: 400, desc: '[Legendary] Once per floor: 2 Jacks in a pile you take are kept out of your hand.',                             enabled: true, type: 'joker' },
    { id: 'patron',       name: 'JOKER · The Patron',     price: 400, desc: '[Legendary] +1g per Gilded card in hand each turn (stacks with Gilded base).',                                  enabled: true, type: 'joker' },
    { id: 'hometownHero', name: 'JOKER · Hometown Hero',  price: 150, desc: '[Uncommon] Starting hand draws at least 50% from your own run deck (vs 30% base).',                                  enabled: true, type: 'joker' },
    { id: 'alchemist',    name: 'JOKER · The Alchemist',   price: 250, desc: '[Rare] Once per round: transform a hand card (any, even Steel) into a different card with a random positive affix.', enabled: true, type: 'joker' },
    { id: 'callersMark',  name: "JOKER · Caller's Mark",   price: 150, desc: "[Uncommon] First LIAR call each round: +20g if right, -15g if wrong.",                                                  enabled: true, type: 'joker' },
    { id: 'sixthSense',   name: 'JOKER · Sixth Sense',     price: 150, desc: '[Uncommon · stacks ×3] After each opponent play: 15%/stack chance to privately learn truth/lie.',                          enabled: true, type: 'joker' },
    { id: 'screamer',     name: 'JOKER · The Screamer',    price: 400, desc: '[Legendary] Once per floor: name a rank, every card of that rank in any hand is publicly revealed for the rest of the round.', enabled: true, type: 'joker' },
  ];

  // Phase 3: random events at the Event fork node.
  // Random affix pool used by several events.
  const _EVENT_AFFIX_POOL = ['gilded', 'glass', 'spiked', 'cursed', 'steel', 'mirage', 'hollow', 'echo'];
  function _randAffix() { return _EVENT_AFFIX_POOL[Math.floor(Math.random() * _EVENT_AFFIX_POOL.length)]; }
  function _randRank() { return ['A','K','Q','10'][Math.floor(Math.random() * 4)]; }

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
          if (runState.ach) {
            runState.ach.charlatanStreak = (runState.ach.charlatanStreak || 0) + 1;
            if (runState.ach.charlatanStreak >= 5) _achGrant('gamblersHand');
          }
          return '-' + cost + 'g, +' + g + 'g (heads)';
        }
        if (runState.ach) runState.ach.charlatanStreak = 0;
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
    {
      title: 'Mysterious Stranger',
      text: "A hooded figure offers a trade: a random card from your run deck for one of theirs (rumored to carry odd affixes).",
      run: () => {
        if (!runState.runDeck || runState.runDeck.length === 0) return 'No deck to trade.';
        const idx = Math.floor(Math.random() * runState.runDeck.length);
        const lost = runState.runDeck[idx];
        const newAffix = _randAffix();
        const newRank = _randRank();
        runState.runDeck[idx] = {
          rank: newRank,
          id: 'mystery_' + Date.now() + '_' + Math.floor(Math.random()*1000),
          owner: 0,
          affix: newAffix,
        };
        return 'Traded ' + lost.rank + (lost.affix ? '['+lost.affix+']' : '') +
               ' for ' + newRank + ' [' + newAffix + ']';
      },
    },
    {
      title: 'Wandering Merchant',
      text: 'A merchant offers one rare consumable at 60% price.',
      run: () => {
        // Pick a random consumable id from inventory-trackable ids.
        const POOL = ['whisperNetwork', 'luckyCoin', 'snakeEyes', 'distillation', 'deadDrop', 'jokersMask', 'mirrorShard', 'smokeBomb', 'counterfeit', 'jackBeNimble'];
        const PRICES = { whisperNetwork: 30, luckyCoin: 20, snakeEyes: 45, distillation: 60, deadDrop: 70, jokersMask: 75, mirrorShard: 45, smokeBomb: 35, counterfeit: 50, jackBeNimble: 90 };
        const NAMES = { whisperNetwork: 'Whisper Network', luckyCoin: 'Lucky Coin', snakeEyes: 'Snake Eyes', distillation: 'Distillation', deadDrop: 'Dead Drop', jokersMask: "Joker's Mask", mirrorShard: 'Mirror Shard', smokeBomb: 'Smoke Bomb', counterfeit: 'Counterfeit', jackBeNimble: 'Jack-be-Nimble' };
        const pickId = POOL[Math.floor(Math.random() * POOL.length)];
        const price = Math.floor(PRICES[pickId] * 0.60);
        if (runState.gold < price) return 'Could not afford ' + NAMES[pickId] + ' (' + price + 'g).';
        runState.gold -= price;
        runState.inventory[pickId] = (runState.inventory[pickId] || 0) + 1;
        return 'Bought ' + NAMES[pickId] + ' (-' + price + 'g).';
      },
    },
    {
      title: 'Card Sharp',
      text: 'A sharp eyes you. "50g and I tell you what tomorrow brings."',
      run: () => {
        const cost = Math.min(50, runState.gold);
        if (cost < 50) return 'Not enough gold (50g needed).';
        runState.gold -= cost;
        // Pre-roll the next floor's modifier so we can show it now AND lock it in.
        const nextFloor = (runState.currentFloor || 1) + 1;
        let nextMod = null;
        if (nextFloor >= 4 && nextFloor <= 8 && (nextFloor !== 6)) {  // not a boss floor
          const ids = Object.keys(FLOOR_MODIFIERS);
          nextMod = ids[Math.floor(Math.random() * ids.length)];
          runState.preRolledNextFloorMod = nextMod;
        }
        return nextMod
          ? 'Next floor will be ' + (FLOOR_MODIFIERS[nextMod] ? FLOOR_MODIFIERS[nextMod].name : nextMod) + '.'
          : 'No modifier coming next floor.';
      },
    },
    {
      title: 'The Old Soldier',
      text: 'A drunk veteran offers to "watch your back" — 25g for one round of Jack-curse immunity.',
      run: () => {
        const cost = Math.min(25, runState.gold);
        if (cost < 25) return 'Not enough gold (25g needed).';
        runState.gold -= cost;
        runState.oldSoldierImmuneNextRound = true;
        return 'Granted Jack-curse immunity for the next round.';
      },
    },
    {
      title: 'Lucky Find',
      text: 'You stumble across a strange charm. It clings to one of your cards.',
      run: () => {
        if (!runState.runDeck || runState.runDeck.length === 0) return 'No deck cards.';
        const candidates = runState.runDeck.filter(c => c.affix !== 'steel');
        if (candidates.length === 0) return 'All cards Steel — charm slides off.';
        const card = candidates[Math.floor(Math.random() * candidates.length)];
        const old = card.affix;
        card.affix = _randAffix();
        return 'Random affix on ' + card.rank + ': ' + (old || 'plain') + ' -> ' + card.affix + '.';
      },
    },
    {
      title: 'Shrine of Hearts',
      text: 'A small shrine pulses with warmth. Donate 100g for a Heart shard.',
      run: () => {
        if (runState.gold < 100) return 'Not enough gold (100g needed).';
        runState.gold -= 100;
        runState.heartShards = (runState.heartShards || 0) + 1;
        if (runState.heartShards >= HEART_SHARDS_REQUIRED) {
          runState.hearts++;
          runState.heartShards = 0;
          return '+1 shard. Shards completed -> +1 Heart!';
        }
        return '+1 shard (' + runState.heartShards + '/' + HEART_SHARDS_REQUIRED + ').';
      },
    },
    {
      title: 'Drunken Brawl',
      text: 'A brawl breaks out. You take a hit but pocket a Counterfeit on the way out.',
      run: () => {
        const cost = Math.min(30, runState.gold);
        runState.gold -= cost;
        runState.inventory.counterfeit = (runState.inventory.counterfeit || 0) + 1;
        return '-' + cost + 'g, +1 Counterfeit.';
      },
    },
    {
      title: "The Auditor's Apprentice",
      text: 'A note at the table reads: "80g and I show you who you\'ll face next floor."',
      run: () => {
        if (runState.gold < 80) return 'Not enough gold (80g needed).';
        runState.gold -= 80;
        // Pre-roll next floor's bot personalities so we can preview them.
        const ids = Object.keys(PERSONALITY_CATALOG);
        const preview = [];
        for (let i = 1; i < NUM_PLAYERS; i++) {
          preview.push(ids[Math.floor(Math.random() * ids.length)]);
        }
        runState.preRolledNextFloorPersonalities = preview;
        const names = preview.map(id => PERSONALITY_CATALOG[id] ? PERSONALITY_CATALOG[id].name : id);
        return 'Next floor: ' + names.join(', ') + '.';
      },
    },
  ];

  // ============================================================
  // Achievements (Phase 9+) — local catalog, localStorage persistence,
  // and a tiny on-screen toast when one is unlocked.
  // ============================================================
  const ACHIEVEMENT_CATALOG = {
    // Mastery
    pacifist:      { id: 'pacifist',      cat: 'Mastery',     name: 'The Pacifist',     desc: 'Win a run without ever calling Liar.',                              unlocks: '\"Pacifist\" card back' },
    truthWins:     { id: 'truthWins',     cat: 'Mastery',     name: 'Truth Wins',       desc: 'Survive 10 challenges where you told the truth in a single run.', unlocks: 'Gold border tint' },
    liarsTongue:   { id: 'liarsTongue',   cat: 'Mastery',     name: "Liar's Tongue",    desc: 'Lie 10 times in a single round and never get caught.',           unlocks: '\"Smirk\" elimination animation' },
    bossSlayer:    { id: 'bossSlayer',    cat: 'Mastery',     name: 'Boss Slayer',      desc: 'Beat all three Floor 9 alt bosses (Lugen, Mirror, Hollow).',     unlocks: '\"Crown\" card back' },
    untouched:     { id: 'untouched',     cat: 'Mastery',     name: 'Untouched',        desc: 'Beat Lugen without losing a single Heart.',                       unlocks: 'Alt Lugen card art' },
    // Build identity
    ironWill:      { id: 'ironWill',      cat: 'Build',       name: 'Iron Will',        desc: 'Win a run with at least 4 Steel-affixed cards in your run deck.', unlocks: 'Steel border tint' },
    glassCannon:   { id: 'glassCannon',   cat: 'Build',       name: 'Glass Cannon',     desc: 'Burn 100 cards across all runs.',                                  unlocks: 'Glass alt VFX' },
    massForgery:   { id: 'massForgery',   cat: 'Build',       name: 'Mass Forgery',     desc: 'Make 7 of your run-deck cards be the same card via Forger.',     unlocks: '\"Forger\" alt joker portrait' },
    pacifier:      { id: 'pacifier',      cat: 'Build',       name: 'The Pacifier',     desc: 'Hold a Cursed card for 5 consecutive rounds.',                    unlocks: 'Cursed alt VFX' },
    affixConn:     { id: 'affixConn',     cat: 'Build',       name: 'Affix Connoisseur',desc: 'Have all 8 affixes appear simultaneously in your run deck.',     unlocks: 'Rainbow border tint' },
    // Economy / fluff
    wallet:        { id: 'wallet',        cat: 'Economy',     name: 'The Wallet',       desc: 'End a run with 1000+ gold.',                                       unlocks: 'Banker alt portrait' },
    spendthrift:   { id: 'spendthrift',   cat: 'Economy',     name: 'Spendthrift',      desc: 'Spend 2000g in a single run.',                                     unlocks: '\"Coin shower\" victory animation' },
    speedDemon:    { id: 'speedDemon',    cat: 'Economy',     name: 'Speed Demon',      desc: 'Win a floor in under 2 minutes.',                                  unlocks: 'Lightning elimination animation' },
    heartSurgeon:  { id: 'heartSurgeon',  cat: 'Economy',     name: 'Heart Surgeon',    desc: 'Collect 10 Heart shards across all runs.',                         unlocks: 'Heart card back' },
    emptyHand:     { id: 'emptyHand',     cat: 'Economy',     name: 'Empty Hand',       desc: 'Empty your hand on the very first turn of a round.',              unlocks: '\"Magician\" alt portrait' },
    // Run-defining
    strippedDown:  { id: 'strippedDown',  cat: 'Run-defining',name: 'Stripped Down',    desc: 'Win a run with only 4 cards in your run deck.',                    unlocks: 'Minimalist card back' },
    jokersWild:    { id: 'jokersWild',    cat: 'Run-defining',name: "Joker's Wild",     desc: 'Equip 5 jokers in a single run.',                                  unlocks: "Joker's Wild PvP starter deck" },
    lastStand:     { id: 'lastStand',     cat: 'Run-defining',name: 'Last Stand',       desc: 'Win a round with 1 card in hand and 1 Heart remaining.',          unlocks: 'Phoenix border tint' },
    gamblersHand:  { id: 'gamblersHand',  cat: 'Run-defining',name: "The Gambler's Hand", desc: "Win Charlatan's Bet 5 times in a row in a single run.",           unlocks: 'Coin-flip animation' },
    stoic:         { id: 'stoic',         cat: 'Run-defining',name: 'Stoic',            desc: 'Use no consumables in an entire run.',                              unlocks: '\"Monk\" character portrait' },
  };

  const _ACH_STORAGE_KEY = 'lugenBetaAchievements';
  const _ACH_PROGRESS_KEY = 'lugenBetaAchievementProgress';

  function _achGetUnlocked() {
    try {
      const raw = localStorage.getItem(_ACH_STORAGE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function _achIsUnlocked(id) { return _achGetUnlocked().includes(id); }
  function _achGetProgress() {
    try {
      const raw = localStorage.getItem(_ACH_PROGRESS_KEY);
      if (!raw) return {};
      const o = JSON.parse(raw);
      return (o && typeof o === 'object') ? o : {};
    } catch (e) { return {}; }
  }
  function _achSaveProgress(p) {
    try { localStorage.setItem(_ACH_PROGRESS_KEY, JSON.stringify(p)); } catch (e) {}
  }
  function _achAddProgress(key, n) {
    const p = _achGetProgress();
    p[key] = (p[key] || 0) + n;
    _achSaveProgress(p);
    return p[key];
  }
  function _achGrantBossKill(bossId) {
    const p = _achGetProgress();
    p.bossKills = p.bossKills || {};
    p.bossKills[bossId] = (p.bossKills[bossId] || 0) + 1;
    _achSaveProgress(p);
    if (p.bossKills.lugen && p.bossKills.mirror && p.bossKills.hollow) {
      _achGrant('bossSlayer');
    }
  }
  function _achGrant(id) {
    if (!ACHIEVEMENT_CATALOG[id]) return;
    if (_achIsUnlocked(id)) return;
    const cur = _achGetUnlocked();
    cur.push(id);
    try { localStorage.setItem(_ACH_STORAGE_KEY, JSON.stringify(cur)); } catch (e) {}
    _achToast(ACHIEVEMENT_CATALOG[id]);
    log('\u2728 Achievement unlocked: ' + ACHIEVEMENT_CATALOG[id].name);
  }
  function _achToast(ach) {
    let toast = document.getElementById('betaAchToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'betaAchToast';
      toast.className = 'fixed top-4 right-1/2 translate-x-1/2 max-w-sm bg-gradient-to-br from-yellow-500 to-amber-700 text-black rounded-xl shadow-2xl p-4 z-50 hidden cursor-pointer';
      toast.style.transform = 'translateX(50%)';
      toast.addEventListener('click', () => toast.classList.add('hidden'));
      document.body.appendChild(toast);
      toast._timer = null;
    }
    toast.innerHTML =
      '<div class="text-xs uppercase tracking-widest font-bold">\ud83c\udfc6 Achievement unlocked</div>' +
      '<div class="text-lg font-extrabold">' + escapeHtml(ach.name) + '</div>' +
      '<div class="text-xs">' + escapeHtml(ach.desc) + '</div>' +
      '<div class="text-xs italic mt-1">Unlocks: ' + escapeHtml(ach.unlocks || '\u2014') + '</div>' +
      '<div class="text-[10px] mt-1 opacity-70">click to dismiss</div>';
    toast.classList.remove('hidden');
    if (toast._timer) clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.add('hidden'), 7000);
  }

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
    if (runState.currentFloor === 9) {
      // Floor 9: roll the alt boss if unlocked; otherwise Lugen.
      runState.floor9BossId = pickFloor9Boss();
      runState.botPersonalities[1] = runState.floor9BossId;
    } else {
      const boss = getBoss(runState.currentFloor);
      if (boss) runState.botPersonalities[1] = boss.id;
    }
    // Auditor's "every Nth play" cadence — rolls fresh per floor.
    // Range 1..5: N=1 means every play (gauntlet); N=5 means every fifth.
    if (runState.botPersonalities.includes('auditor')) {
      runState.auditorEveryN = 1 + Math.floor(Math.random() * 5);
    } else {
      runState.auditorEveryN = 0;
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
      // Stack counts for stackable jokers, keyed by jokerId. Default stack
      // when a stackable joker is first equipped is 1. Buying again while
      // already equipped bumps the count instead of consuming a 2nd slot,
      // up to the joker's maxStack.
      jokerStacks: {},
      tattletaleChargesThisFloor: 0,
      character: character,
      eavesdropperLastFiredRound: -99,
      relics: [],
      heartShards: 0,
      loadedDieUsedThisFloor: false,
      currentFloorModifier: null,    // Phase 8+
      botPersonalities: [null, null, null, null],  // Phase 8+
      floorLockedBoughtThisFloor: {},  // Tracks Forger / Jack-be-Nimble per-floor purchases
      vengefulNextRoundTargets: [],    // Bots that owe a forced-Jack penalty next round
      lastWordUsedThisFloor: false,
      saboteurUsedThisFloor: false,
      deadHandUsedThisFloor: false,
      carouserUsedThisFloor: { smokeBomb: false, counterfeit: false, jackBeNimble: false },
      pickpocketUsedThisFloor: false,
      markedDeckUsedThisFloor: false,
      emptyThreatUsedThisFloor: false,
      crackedMirrorUsedThisFloor: false,
      bookmarkUsedThisRound: false,
      floorStartHearts: STARTING_HEARTS,
      // Achievement tracking (per-run)
      ach: {
        liarCalls: 0,            // Pacifist: must stay at 0
        truthSurvivals: 0,       // Truth Wins: 10+ within run
        consumableUses: 0,       // Stoic: must stay at 0
        spent: 0,                // Spendthrift: 2000+ in single run
        jokersEverEquipped: 0,   // Joker's Wild: 5+
        cursedHoldStreak: 0,     // Pacifier: 5 consecutive rounds with same Cursed card
        cursedHeldId: null,
        charlatanStreak: 0,      // Gambler's Hand: 5 wins in a row
        floorStartTimestamp: 0,  // Speed Demon: track current floor start
      },
    };

    // Assign initial bot personalities
    assignBotPersonalities();
    if (runState.ach) runState.ach.floorStartTimestamp = Date.now(); // Speed Demon (Floor 1)

    if (character) {
      if (character.startingGildedA) {
        const aCard = runState.runDeck.find(c => c.rank === 'A' && !c.affix);
        if (aCard) aCard.affix = 'gilded';
      }
      if (character.engineerStartingAffix) {
        const candidates = runState.runDeck.filter(c => !c.affix && c.rank !== 'J');
        if (candidates.length > 0) {
          const card = candidates[Math.floor(Math.random() * candidates.length)];
          const POOL = ['gilded', 'glass', 'spiked', 'steel', 'mirage', 'hollow', 'echo'];
          card.affix = POOL[Math.floor(Math.random() * POOL.length)];
        }
      }
      if (character.startingGlassCard) {
        const candidates = runState.runDeck.filter(c => !c.affix && c.rank !== 'J');
        if (candidates.length > 0) {
          const card = candidates[Math.floor(Math.random() * candidates.length)];
          card.affix = 'glass';
        }
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
    // Achievement checks at run-end.
    if (runState && runState.ach) {
      // Pacifist: never called Liar this run.
      if (won && (runState.ach.liarCalls || 0) === 0) _achGrant('pacifist');
      // Stoic: never used a consumable this run.
      if (won && (runState.ach.consumableUses || 0) === 0) _achGrant('stoic');
      // Wallet: ended a run with 1000+ gold (any outcome).
      if ((runState.gold || 0) >= 1000) _achGrant('wallet');
      // Spendthrift: spent 2000+g this run.
      if ((runState.ach.spent || 0) >= 2000) _achGrant('spendthrift');
      // Iron Will (only on win): 4+ Steel-affixed cards in run deck.
      if (won && runState.runDeck) {
        const steel = runState.runDeck.filter(c => c.affix === 'steel').length;
        if (steel >= 4) _achGrant('ironWill');
      }
      // Stripped Down (only on win): exactly 4 cards in run deck.
      if (won && runState.runDeck && runState.runDeck.length <= 4) _achGrant('strippedDown');
      // Affix Connoisseur (only on win): all 8 affix kinds in run deck.
      if (won && runState.runDeck) {
        const present = new Set(runState.runDeck.filter(c => c.affix).map(c => c.affix));
        const ALL = ['gilded','glass','spiked','cursed','steel','mirage','hollow','echo'];
        if (ALL.every(a => present.has(a))) _achGrant('affixConn');
      }
    }
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
    _resetPerRoundRelicFlags();

    // The Apostate: shed every run-deck card's affix and re-roll a fresh
    // random one. Done BEFORE buildDeck so the new affixes propagate into
    // the dealt copies (buildDeck spreads each runDeck card via {...card}).
    // Explicitly overrides Steel — the whole identity of the character is
    // "no card is locked." Cursed cards' lock counter is also reset since
    // the affix itself is being replaced, not just dispelled.
    if (runState && runState.character && runState.character.apostateReroll &&
        Array.isArray(runState.runDeck)) {
      let changed = 0;
      for (const card of runState.runDeck) {
        if (!card || card.rank === 'J') continue; // never affix Jacks
        const next = _randAffix();
        if (card.affix !== next) changed++;
        card.affix = next;
        // Cursed cards track a turn lock; clear it so the new affix takes
        // effect cleanly even if the previous affix was Cursed.
        if (card.cursedTurnsLeft !== undefined) card.cursedTurnsLeft = 0;
      }
      if (changed > 0) {
        log("RANDOM.EXE: " + changed + " run-deck card" + (changed === 1 ? '' : 's') +
            " rerolled their affix.");
      }
    }

    const deck = buildDeck();
    const { hands, drawPile } = deal(deck);
    applyJackFairness(hands, drawPile);
    enforceOwnDeckMinimum(hands, drawPile);

    // Vengeful Spirit: preload Jacks into targets' hands. We swap their non-Jack
    // cards back into the draw pile to make room. Cap at limit-1 so we never
    // instantly Jack-curse them (that would be too brutal).
    if (runState && Array.isArray(runState.vengefulNextRoundTargets) &&
        runState.vengefulNextRoundTargets.length > 0) {
      for (const target of runState.vengefulNextRoundTargets) {
        if (target == null || target < 0 || target >= NUM_PLAYERS) continue;
        const targetLimit = jackLimitFor(target);
        let preloaded = 0;
        for (let i = 0; i < 2; i++) {
          if (jackCurseWeight(hands[target]) >= targetLimit - 1) break;
          const jackIdx = drawPile.findIndex(c => c.rank === 'J');
          if (jackIdx === -1) break;
          const swapIdx = hands[target].findIndex(c => c.rank !== 'J');
          if (swapIdx === -1) break;
          const jack = drawPile.splice(jackIdx, 1)[0];
          const out = hands[target].splice(swapIdx, 1)[0];
          hands[target].push(jack);
          drawPile.unshift(out);
          preloaded++;
        }
        if (preloaded > 0) {
          log("Vengeful Spirit: " + (BOT_NAMES[target - 1] || ('seat ' + target)) +
              ' starts with ' + preloaded + ' forced Jack' + (preloaded === 1 ? '' : 's') + '.');
        }
      }
      runState.vengefulNextRoundTargets = [];
    }

    // Phase 8+: Brittle modifier — every card becomes Glass for this round
    if (runState && runState.currentFloorModifier === 'brittle') {
      for (const hand of hands) {
        for (const c of hand) c.affix = 'glass';
      }
      for (const c of drawPile) c.affix = 'glass';
    }

    // Per-floor random-affix infusion (skipped on Brittle floors —
    // Brittle already glassed everything).
    if (runState && runState.currentFloorModifier !== 'brittle') {
      const infused = applyFloorAffixesToDrawPile(drawPile, runState.currentFloor || 1);
      if (infused > 0) {
        log('Floor ' + (runState.currentFloor || 1) + ' static: ' + infused +
            ' card' + (infused === 1 ? '' : 's') + ' in the draw pile carry random affixes.');
      }
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
    // Target rank is biased toward whichever non-Jack rank the starter has
    // the most of in their RUN DECK (70% biased, 30% pure random). The run
    // deck is the persistent build — what the player has actually invested
    // gold and choices into via Forger / Distillation / shop swaps / reward
    // upgrades. Reading from the hand was noisier (the hand is a random
    // sample of the round deck each round), and it could fluctuate based on
    // a single lucky deal even when the underlying build wasn't stacked.
    //
    // Tie rule (per design intent): if there's no clear winner — i.e. the
    // top rank count is shared by more than one rank — fall back to pure
    // random. So the default 3-3-3-3 starter deck always rolls random, and
    // partial customizations (e.g. 4-3-3-2) bias only when one rank pulls
    // clearly ahead. This way the bias only fires on intentional stacking.
    //
    // Inverted floor modifier still overrides everything: target = J.
    const TARGET_BIAS_CHANCE = 0.70;
    function _pickTargetWithBias() {
      const deck = (runState && runState.runDeck) || [];
      const counts = {};
      for (const r of RANKS) counts[r] = 0;
      for (const c of deck) {
        if (counts[c.rank] !== undefined) counts[c.rank]++;
      }
      let maxCount = 0;
      for (const r of RANKS) if (counts[r] > maxCount) maxCount = counts[r];
      const top = RANKS.filter(r => counts[r] === maxCount);
      // No data, or every rank tied → random. ("If all are equal then just
      // random" — including 2- and 3-way ties at the top, since that's not
      // a clear-winner build either.)
      if (maxCount === 0 || top.length > 1) {
        return RANKS[Math.floor(Math.random() * RANKS.length)];
      }
      if (Math.random() >= TARGET_BIAS_CHANCE) {
        return RANKS[Math.floor(Math.random() * RANKS.length)];
      }
      return top[0];
    }
    let targetRank = _pickTargetWithBias();
    if (runState && runState.currentFloorModifier === 'inverted') {
      targetRank = 'J';
    }
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
      auditorChances: 0,       // Bug-fix: Auditor only challenges every Nth chance (N from runState.auditorEveryN)
      lugenLiarUsedThisRound: false, // Lugen's once-per-round out-of-turn Liar
      lastHumanPlay: null,     // For The Mirror — what the human played most recently
      tricksterMarkedId: null,   // Trickster: id of the marked +/-1 wildcard
      tricksterUsedThisRound: false,
      doppelArmed: false,        // Doppelganger: arms the next play to copy lastPlay
      doppelUsedThisRound: false,
      hotPotatoArmed: false,     // Hot Potato: bonus max-play for next turn
      memorizerLog: [],          // Memorizer: revealed cards this round
      snakeEyesLock: false,      // Snake Eyes: cancel next rotation
      jokersMaskCardId: null,    // Joker's Mask: id of the card counting as a Jack
      mirrorShardArmed: false,   // Mirror Shard: blind the next reveal against you
      emptyThreatPending: false, // Empty Threat: next bot bluffs cautiously once
      magicianUsedThisRound: false, // Magician character: per-round transform
      alchemistUsedThisRound: false, // Alchemist joker: per-round transform
      callersMarkFiredThisRound: false, // Caller's Mark joker: first LIAR call only
      screamerRevealedRank: null,   // The Screamer: while set, every card of this rank is publicly revealed
      lieDetectorArmed: false,      // Lie Detector consumable: arm flag
      stackedHandActive: !!(runState && runState.stackedHandPending), // Stacked Hand: own-deck +20% this round
      // Achievement: Liar's Tongue tracks human lies per round.
      humanLiesThisRound: 0,
      humanCaughtThisRound: false,
      // Achievement: Empty Hand — first turn of a round.
      humanFirstTurn: true,
      // Achievement: Glass Cannon — count cards burned this run.
      // (cumulative across runs done via localStorage progress.)
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
      if (peeks.length > 0) privatePeek('Cold Read — ' + peeks.join(', ') + '.');
    }
    // Coward's Cloak (defensive): would block bots' Cold Read on YOUR hand.
    // In solo only the human has jokers, so this acts as a documented hook.
    if (hasRelic('cowardsCloak')) {
      // No-op in solo; in PvP this prevents opposing Cold/Echo/Eavesdropper
      // from peeking the holder's hand on a Pass action.
    }
    // Phase 7+: Cracked Coin relic
    if (hasRelic('crackedCoin')) {
      const got = addGold(5 * runState.hearts);
      if (got > 0) log('Cracked Coin: +' + got + 'g (' + runState.hearts + ' hearts).');
    }
    // Phase 7+: Hand Mirror relic — peek at one random card from each opponent
    // who currently holds 2 or more cards. Opponents at 1 card are spared
    // (you never get to peek at someone's final card).
    if (hasRelic('handMirror')) {
      const peeks = [];
      for (let i = 1; i < NUM_PLAYERS; i++) {
        if (state.hands[i].length >= 2) {
          const c = state.hands[i][Math.floor(Math.random() * state.hands[i].length)];
          peeks.push(playerLabel(i) + ': ' + c.rank);
        }
      }
      if (peeks.length > 0) privatePeek('Hand Mirror — ' + peeks.join(', ') + '.');
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
        privatePeek("Bait's eye: " + playerLabel(target) + ' has a ' + card.rank +
            (card.affix ? ' (' + card.affix + ')' : '') + '.');
      }
    }

    // Whisper peek — directional. The human chooses a direction (left = next
    // player, right = previous player) which is stored on runState. Default
    // is 'left' (the next player to act); the player can flip it from the
    // run sidebar before each round. See toggleWhisperDirection() below.
    if (runState && runState.character && runState.character.whisperPeek) {
      if (!runState.whisperDirection) runState.whisperDirection = 'left';
      // Human is seat 0 in solo mode. Left = +1 (next), right = -1 (prev).
      const offset = runState.whisperDirection === 'right' ? -1 : 1;
      const target = ((0 + offset) % NUM_PLAYERS + NUM_PLAYERS) % NUM_PLAYERS;
      if (target !== 0 && state.hands[target] && state.hands[target].length > 0 && !state.eliminated[target]) {
        const card = state.hands[target][Math.floor(Math.random() * state.hands[target].length)];
        const dirLabel = runState.whisperDirection === 'right' ? 'right (prev)' : 'left (next)';
        privatePeek("Whisper [" + dirLabel + "]: " + playerLabel(target) + ' has a ' + card.rank +
            (card.affix ? ' (' + card.affix + ')' : '') + '.');
      }
    }
    if (gamblerCursedRank) {
      log("Gambler's curse: a Cursed " + gamblerCursedRank + ' is forced into your hand.');
    }
    if (runState && runState.stackedHandPending) {
      runState.stackedHandPending = false;
      log('Stacked Hand: own-deck floor +20% applied to this round.');
    }

    state.humanFirstTurn = true;
    state.humanLiesThisRound = 0;
    state.humanCaughtThisRound = false;
    document.getElementById('betaIntro').classList.add('hidden');
    document.getElementById('betaGame').classList.remove('hidden');
    document.getElementById('betaResult').classList.add('hidden');
    document.getElementById('betaReveal').innerHTML = '';  // Sticky reveal also gets cleared between rounds.

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

    // Old Soldier event: immunity expires at the end of the next round it
    // covered (i.e., this round if the event ran between floors).
    if (runState && runState.oldSoldierImmuneNextRound) {
      runState.oldSoldierImmuneNextRound = false;
    }
    // Liar's Tongue: 10+ lies in a round + never caught -> grant.
    if (state && (state.humanLiesThisRound || 0) >= 10 && !state.humanCaughtThisRound) {
      _achGrant('liarsTongue');
    }
    // Pacifier: track holding the SAME Cursed card across rounds.
    if (state && state.hands && state.hands[0] && runState && runState.ach) {
      const cursed = state.hands[0].find(c => c.affix === 'cursed');
      if (cursed) {
        if (runState.ach.cursedHeldId === cursed.id) {
          runState.ach.cursedHoldStreak = (runState.ach.cursedHoldStreak || 0) + 1;
        } else {
          runState.ach.cursedHeldId = cursed.id;
          runState.ach.cursedHoldStreak = 1;
        }
        if (runState.ach.cursedHoldStreak >= 5) _achGrant('pacifier');
      } else {
        runState.ach.cursedHeldId = null;
        runState.ach.cursedHoldStreak = 0;
      }
    }
    // Last Stand: human won the round with 1 card in hand and 1 Heart left.
    if (humanWonRound && runState && runState.hearts === 1 && state.hands[0].length === 1) {
      _achGrant('lastStand');
    }
    log('Round result: ' + (humanWonRound ? 'WON' : 'LOST') +
        ' — ' + scoreLine());
    if (state._gildedRoundEarnings && state._gildedRoundEarnings > 0) {
      log('Gilded earned this round: +' + state._gildedRoundEarnings + 'g.');
    }

    // The Bookmark relic: end-of-round, offer to save 1 hand card into the
    // run deck (replacing one). Optional, once per round, only if you still
    // have at least one card in hand.
    if (hasRelic('bookmark') && !runState.bookmarkUsedThisRound &&
        state.hands[0] && state.hands[0].length > 0 &&
        runState.runDeck && runState.runDeck.length > 0) {
      runState.bookmarkUsedThisRound = true;
      // Defer any modal interaction until after the round-result modal logic
      // by queueing this micro-task. We don't block the natural flow.
      setTimeout(() => {
        try { _showBookmarkPicker(); } catch (e) {}
      }, 0);
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
      // Speed Demon: floor cleared in under 2 minutes.
      if (runState.ach && runState.ach.floorStartTimestamp) {
        const elapsed = Date.now() - runState.ach.floorStartTimestamp;
        if (elapsed < 120000) _achGrant('speedDemon');
      }
      // Tarnished Crown relic: clean-floor bonus.
      if (hasRelic('tarnishedCrown') &&
          typeof runState.floorStartHearts === 'number' &&
          runState.hearts >= runState.floorStartHearts) {
        const tcBonus = addGold(50);
        log('Tarnished Crown: clean-floor bonus +' + tcBonus + 'g.');
      }
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
      const total = _achAddProgress('heartShardsTotal', 1);
      if (total >= 10) _achGrant('heartSurgeon');
      if (runState.heartShards >= HEART_SHARDS_REQUIRED) {
        runState.hearts++;
        runState.heartShards = 0;
        log('Heart restored from shards!');
      }
    }

    const floorJustFinished = runState.currentFloor;
    runState.currentFloor++;
    ensureSoloJokerSlots(runState.currentFloor);
    runState.roundsWon = new Array(NUM_PLAYERS).fill(0);
    runState.loadedDieUsedThisFloor = false;  // Phase 7+: reset Loaded Die per floor
    runState.crookedDieUsedThisFloor = false; // Crooked Die consumable per-floor cap
    runState.screamerUsedThisFloor = false;   // The Screamer joker per-floor cap
    runState.floorLockedBoughtThisFloor = {};  // Reset floor-locked shop items
    runState.lastWordUsedThisFloor = false;    // Last Word joker
    runState.saboteurUsedThisFloor = false;    // Saboteur joker
    runState.deadHandUsedThisFloor = false;    // Dead Hand joker
    runState.carouserUsedThisFloor = { smokeBomb: false, counterfeit: false, jackBeNimble: false };
    runState.pickpocketUsedThisFloor = false;  // Pickpocket consumable
    runState.markedDeckUsedThisFloor = false;  // Marked Deck consumable
    runState.emptyThreatUsedThisFloor = false; // Empty Threat consumable
    runState.crackedMirrorUsedThisFloor = false; // Cracked Mirror relic
    runState.floorStartHearts = runState.hearts; // Tarnished Crown reference point
    if (runState.ach) runState.ach.floorStartTimestamp = Date.now(); // Speed Demon
    runState.tattletaleChargesThisFloor =
      hasJoker('tattletale') ? TATTLETALE_CHARGES_PER_FLOOR : 0;
    setMaxFloorReached(runState.currentFloor);

    // Phase 8+: pick floor modifier (Act 2+ only on non-boss floors)
    if (runState.currentFloor >= 4 && !isBossFloor(runState.currentFloor)) {
      if (runState.preRolledNextFloorMod && FLOOR_MODIFIERS[runState.preRolledNextFloorMod]) {
        runState.currentFloorModifier = runState.preRolledNextFloorMod;
        runState.preRolledNextFloorMod = null;
      } else {
        const ids = Object.keys(FLOOR_MODIFIERS);
        runState.currentFloorModifier = ids[Math.floor(Math.random() * ids.length)];
      }
    } else {
      runState.currentFloorModifier = null;
    }
    // Reassign personalities (so each floor feels different)
    if (Array.isArray(runState.preRolledNextFloorPersonalities) &&
        runState.preRolledNextFloorPersonalities.length === NUM_PLAYERS - 1) {
      runState.botPersonalities = [null].concat(runState.preRolledNextFloorPersonalities);
      runState.preRolledNextFloorPersonalities = null;
      // Boss override still applies if we're entering a boss floor.
      const boss = getBoss(runState.currentFloor);
      if (boss) runState.botPersonalities[1] = boss.id;
    } else {
      assignBotPersonalities();
    }

    if (floorJustFinished >= TOTAL_FLOORS && humanWonFloor) {
      endRun(true);
      return;
    }
    if (runState.currentFloor > TOTAL_FLOORS) {
      endRun(false);
      return;
    }

    // Track boss kills for the Boss Slayer achievement (Floor 9 alts).
    if (humanWonFloor) {
      const justFinished = floorJustFinished;
      if (justFinished === 9) {
        const f9 = runState.floor9BossId || 'lugen';
        _achGrantBossKill(f9);
        // Untouched: clear Lugen with all starting hearts intact.
        if (f9 === 'lugen' && runState.hearts >= STARTING_HEARTS) {
          _achGrant('untouched');
        }
      }
    }
    // Boss-relic pickup. After defeating a boss (Floor 3 / 6), offer the player
    // 2 relics from that boss's pool. Floor 9 victory ends the run, so its
    // relics (ironStomach / ledger) carry into the next run via meta-progression.
    if (humanWonFloor && isBossFloor(floorJustFinished) && floorJustFinished < TOTAL_FLOORS) {
      const bossId = (floorJustFinished === 3) ? 'auditor'
                   : (floorJustFinished === 6) ? 'cheater'
                   : null;
      if (bossId && BOSS_RELIC_POOL[bossId]) {
        showBossRelicPicker(bossId, () => {
          showFork(floorJustFinished, humanWonFloor, winnerIdx, lastRoundMessage);
        });
        return;
      }
    }

    // Phase 3: skip the floor-result modal and go straight to the fork
    // screen, which has its own banner showing the floor outcome.
    showFork(floorJustFinished, humanWonFloor, winnerIdx, lastRoundMessage);
  }

  // Boss relic picker — lets the player choose 1 of 2 relics from a boss pool.
  function showBossRelicPicker(bossId, onPicked) {
    const pool = BOSS_RELIC_POOL[bossId] || [];
    // Filter out relics the player already owns.
    const owned = runState.relics || [];
    const available = pool.filter(id => !owned.includes(id));
    // If both pool entries are owned, fall back to any unowned relic from
    // the catalog so the boss reward isn't wasted.
    let offers;
    if (available.length >= 2) {
      offers = available.slice(0, 2);
    } else if (available.length === 1) {
      const others = Object.keys(RELIC_CATALOG).filter(id => !owned.includes(id) && !available.includes(id));
      offers = available.concat(shuffle(others).slice(0, 1));
    } else {
      const others = Object.keys(RELIC_CATALOG).filter(id => !owned.includes(id));
      offers = shuffle(others).slice(0, 2);
    }

    let modal = document.getElementById('betaBossRelicModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'betaBossRelicModal';
      modal.className = 'fixed inset-0 bg-black/85 backdrop-blur z-50 flex items-center justify-center p-4';
      modal.innerHTML =
        '<div class="bg-gradient-to-br from-amber-700 via-yellow-700 to-amber-900 border-2 border-yellow-300 p-6 rounded-2xl shadow-2xl max-w-lg w-full">' +
          '<h3 class="text-2xl font-extrabold mb-1 text-center">&#128081; Boss defeated</h3>' +
          '<p id="betaBossRelicSubtitle" class="text-xs text-yellow-100 mb-4 text-center"></p>' +
          '<div id="betaBossRelicOffers" class="space-y-2"></div>' +
        '</div>';
      document.body.appendChild(modal);
    }
    const boss = BOSS_CATALOG[bossId];
    const subtitle = modal.querySelector('#betaBossRelicSubtitle');
    if (subtitle) subtitle.textContent = (boss ? boss.name : 'Boss') + ' yields a relic. Pick one — the other is gone.';
    const list = modal.querySelector('#betaBossRelicOffers');
    list.innerHTML = '';
    if (offers.length === 0) {
      const note = document.createElement('p');
      note.className = 'text-rose-200 text-center';
      note.textContent = 'You already own every relic — nothing to pick.';
      list.appendChild(note);
      const ok = document.createElement('button');
      ok.className = 'mt-4 w-full bg-yellow-400 hover:bg-yellow-300 text-black px-4 py-2 rounded font-bold transition';
      ok.textContent = 'Continue';
      ok.addEventListener('click', () => {
        modal.classList.add('hidden');
        if (typeof onPicked === 'function') onPicked();
      });
      list.appendChild(ok);
    } else {
      for (const id of offers) {
        const r = RELIC_CATALOG[id];
        if (!r) continue;
        const btn = document.createElement('button');
        btn.className = 'w-full bg-amber-800 hover:bg-amber-700 transition p-4 rounded-xl text-left';
        btn.innerHTML = '<div class="text-xl font-bold mb-1">' + escapeHtml(r.name) + '</div>' +
                        '<div class="text-xs opacity-80">' + escapeHtml(r.desc) + '</div>';
        btn.addEventListener('click', () => {
          runState.relics = runState.relics || [];
          runState.relics.push(id);
          log('Boss relic gained: ' + r.name + '!');
          modal.classList.add('hidden');
          if (typeof onPicked === 'function') onPicked();
        });
        list.appendChild(btn);
      }
    }
    modal.classList.remove('hidden');
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

  // Per-rank cap used when syncing all 4 players' run decks into the round deck.
  // Each player can build their own deck however they like; the round itself
  // never contains more than this many of any single rank.
  //
  // Was 8, raised to 16 to match the design doc's "30 + N*8" target. Math at
  // 4 players, 12-card run decks, 3-per-rank: 4*3 = 12 cards per non-Jack rank
  // get gathered. Cap 8 was discarding 4 of every 12, shrinking the round
  // deck from ~62 (design) down to ~38 (impl) and starving Spiked / Tracer /
  // Spiked Trap of fuel. Cap 16 is well above 12 so player contributions
  // pass through intact, while still clamping any future degenerate build
  // (e.g. a Forger spam that pushes one rank past 16).
  const ROUND_DECK_RANK_CAP = 16;
  const BASE_JACKS_PER_ROUND = 6;
  // Base non-Jack cards added to every round deck. The design's "30-card base"
  // is 6 of each of A/K/Q/10 plus 6 Jacks. Without this, the only Jacks were
  // base and every other rank came purely from player run decks, leaving the
  // draw pile thin and Spiked effects routinely fizzling.
  const BASE_NON_JACK_PER_ROUND = 6;

  function buildDeck() {
    // 1) Base 30: 6 each of A/K/Q/10 and 6 Jacks (per design doc). These are
    //    the vanilla, no-owner cards that anchor the deck regardless of how
    //    many players are at the table or what their run decks look like.
    const deck = [];
    for (let i = 0; i < BASE_JACKS_PER_ROUND; i++) {
      deck.push({ rank: 'J', id: 'rd_J_' + i, owner: -1, affix: null });
    }
    for (const r of ['A', 'K', 'Q', '10']) {
      for (let i = 0; i < BASE_NON_JACK_PER_ROUND; i++) {
        deck.push({ rank: r, id: 'rd_' + r + '_' + i, owner: -1, affix: null });
      }
    }

    // 2) Gather every player's run deck into per-rank buckets. Each player
    //    has their own complete deck (12+ cards) and can customize freely;
    //    the cap below is what keeps a single round balanced.
    const buckets = { 'A': [], 'K': [], 'Q': [], '10': [], 'J': [] };
    for (let p = 0; p < NUM_PLAYERS; p++) {
      const personalDeck = (p === 0)
        ? runState.runDeck
        : buildInitialRunDeck(p);
      for (const card of personalDeck) {
        if (buckets[card.rank]) buckets[card.rank].push({ ...card });
      }
    }

    // 3) For each rank, count what's already in the deck (the base cards we
    //    just pushed above) and only let player-deck cards fill up to
    //    ROUND_DECK_RANK_CAP total per rank. Affixed cards first so a
    //    player's gold investment isn't silently dropped on a degenerate
    //    over-cap build.
    for (const r of Object.keys(buckets)) {
      const cards = buckets[r];
      const alreadyInDeck = deck.filter(c => c.rank === r).length;
      const remainingSlots = Math.max(0, ROUND_DECK_RANK_CAP - alreadyInDeck);
      if (remainingSlots === 0) continue;
      if (cards.length <= remainingSlots) {
        for (const c of cards) deck.push(c);
        continue;
      }
      const affixed = shuffle(cards.filter(c => c.affix));
      const plain   = shuffle(cards.filter(c => !c.affix));
      const ordered = affixed.concat(plain);
      for (let i = 0; i < remainingSlots; i++) deck.push(ordered[i]);
    }

    return shuffle(deck);
  }

  // Each player's personal deck. 12 cards (3 each of A/K/Q/10) — players
  // can customize via shop services / rewards / consumables. The ROUND_DECK
  // cap above keeps any one round balanced, so building stacked decks is
  // safe and meaningful (you bias what's likely to land in play).
  const RUN_DECK_PER_RANK = 3;

  function buildInitialRunDeck(playerIdx) {
    const deck = [];
    for (const r of ['A', 'K', 'Q', '10']) {
      for (let i = 0; i < RUN_DECK_PER_RANK; i++) {
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
    // Lugen specials: starts with 7 cards (2 extra) instead of 5.
    if (runState && runState.botPersonalities) {
      for (let p = 1; p < NUM_PLAYERS; p++) {
        if (runState.botPersonalities[p] === 'lugen') {
          for (let i = 0; i < 2; i++) {
            if (deck.length > 0) hands[p].push(deck.pop());
          }
        }
      }
    }
    return { hands, drawPile: deck };
  }

  // Jack limit for a given seat. Player 0 (human) gets character / joker
  // bonuses; bots default to 4 except Lugen (6). Greedy modifier knocks
  // 1 off everybody.
  function _humanSteelCount() {
    if (!state || !state.hands || !state.hands[0]) return 0;
    return state.hands[0].filter(c => c.affix === 'steel').length;
  }
  function jackLimitFor(p) {
    const playerLimitBonus = (runState && runState.character && runState.character.jackLimitBonus) || 0;
    const playerJokerBonus = (p === 0 && hasJoker('safetyNet')) ? 1 : 0;
    const greedyDrop = (runState && runState.currentFloorModifier === 'greedy') ? 1 : 0;
    let limit = JACK_LIMIT;
    if (p === 0) {
      limit += playerLimitBonus + playerJokerBonus;
      // Dragon Scale: +1 Jack limit per Steel card in hand.
      if (hasRelic('dragonScale')) limit += Math.min(1, _humanSteelCount());
    }
    if (runState && runState.botPersonalities && runState.botPersonalities[p] === 'lugen') {
      limit = 6;
    }
    return limit - greedyDrop;
  }

  // Minimum fraction of the human's starting hand that must come from their
  // own run deck. Default 30%; jokers/consumables can raise it.
  const OWN_DECK_MIN_FRACTION_BASE = 0.30;
  function ownDeckMinFraction() {
    let f = OWN_DECK_MIN_FRACTION_BASE;
    if (hasJoker('hometownHero')) f = Math.max(f, 0.50);
    if (state && state.stackedHandActive) f += 0.20;
    if (f > 1.0) f = 1.0;
    return f;
  }

  // Post-deal: force the human's starting hand to contain at least N cards
  // from their own run deck (where N = ceil(handSize * minFraction)). We
  // swap non-own cards out of the hand and own cards in from the draw pile.
  // Steel/Cursed/etc. all count fine since they're identified by owner.
  function enforceOwnDeckMinimum(hands, drawPile) {
    if (!runState || !hands || !hands[0]) return;
    const handSize = hands[0].length;
    if (handSize === 0) return;
    const target = Math.ceil(handSize * ownDeckMinFraction());
    const ownCount = () => hands[0].filter(c => c.owner === 0).length;
    let safety = handSize * 4;
    while (ownCount() < target && safety-- > 0) {
      const outIdx = hands[0].findIndex(c => c.owner !== 0);
      const inIdx = drawPile.findIndex(c => c.owner === 0);
      if (outIdx === -1 || inIdx === -1) break;
      const out = hands[0].splice(outIdx, 1)[0];
      const inn = drawPile.splice(inIdx, 1)[0];
      hands[0].push(inn);
      drawPile.unshift(out);
    }
  }

  function applyJackFairness(hands, drawPile) {
    for (let p = 0; p < hands.length; p++) {
      const hand = hands[p];
      const limit = jackLimitFor(p);
      while (jackCurseWeight(hand) >= limit) {
        // Prefer evicting a Steel Jack (weight 2) to bring weight down faster,
        // otherwise any plain Jack will do.
        let jackIdx = hand.findIndex(c => c.rank === 'J' && c.affix === 'steel');
        if (jackIdx === -1) jackIdx = hand.findIndex(c => c.rank === 'J');
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

  // Jack-curse weight: each card contributes 1 toward the curse, except
  // Steel Jacks which contribute 2 per the design. Joker's Mask consumable
  // can also tag a non-Jack to count as 1 toward the curse for that round.
  function jackCurseWeight(hand) {
    let w = 0;
    const maskedId = (state && state.jokersMaskCardId) || null;
    for (const c of hand) {
      if (c.rank === 'J') {
        w += (c.affix === 'steel') ? 2 : 1;
      } else if (maskedId && c.id === maskedId) {
        w += 1;
      }
    }
    return w;
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
    if (runState && runState.currentFloorModifier === 'inverted') {
      // Target stays at J for the entire Inverted round — no rotation at all.
      return;
    }
    if (state.counterfeitLock) {
      log('Counterfeit lock holds — target stays ' + state.targetRank + '.');
      state.counterfeitLock = false;
      return;
    }
    if (state.snakeEyesLock) {
      log('Snake Eyes — target stays ' + state.targetRank + ' for one more cycle.');
      state.snakeEyesLock = false;
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
    const dgArmed = playerIdx === 0 && state.doppelArmed && state.lastPlay;
    const hpArmed = playerIdx === 0 && state.hotPotatoArmed;
    let minCards = dtArmed ? 2 : 1;
    let maxCards = dtArmed ? 4 : 3;
    if (hpArmed && !dtArmed) maxCards = 5;
    if (dgArmed) {
      // Doppelganger forces the count to match the previous play exactly.
      minCards = state.lastPlay.count;
      maxCards = state.lastPlay.count;
    }
    if (cardIds.length < minCards || cardIds.length > maxCards) return;

    const hand = state.hands[playerIdx];
    const cards = cardIds
      .map(id => hand.find(c => c.id === id))
      .filter(Boolean);
    if (cards.length !== cardIds.length) return;
    // Cursed-lock: cards just picked up can't be played for N turns.
    if (playerIdx === 0) {
      const stillLocked = cards.find(c => c.cursedLockTurns && c.cursedLockTurns > 0);
      if (stillLocked) {
        log('A Cursed card is still locked (' + stillLocked.cursedLockTurns + ' turn(s) left).');
        return;
      }
    }

    // Cracked Mirror: snapshot the human's pre-play state so the relic can
    // rewind it after the challenge resolves. Only snap on human plays.
    if (playerIdx === 0 && hasRelic('crackedMirror') && !runState.crackedMirrorUsedThisFloor) {
      state._mirrorSnapshot = {
        prevHand: state.hands[0].slice(),
        playedIds: cardIds.slice(),
        prevPileLen: state.pile.length,
      };
    }
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
        privatePeek("Echo's eye: " + playerLabel(playerIdx) + "'s first card is a " +
            peeked.rank + (peeked.affix ? ' (' + peeked.affix + ')' : '') + '.');
      }
    }

    // Doppelganger override: claim is forced to the previous play's claim
    // (so even if the target has rotated, we mimic the prior turn). Consumed
    // here once it actually gets used.
    let _claimOverride = null;
    if (playerIdx === 0 && state.doppelArmed && state.lastPlay) {
      _claimOverride = state.lastPlay.claim;
      // Re-stamp the pile entries we just pushed with the override claim.
      for (let i = state.pile.length - cards.length; i < state.pile.length; i++) {
        if (i >= 0 && state.pile[i]) state.pile[i].claim = _claimOverride;
      }
      state.doppelArmed = false;
      state.doppelUsedThisRound = true;
      log('Doppelganger: your play mimics the previous (' + cards.length + ' x ' + _claimOverride + ').');
    }
    // Consume Hot Potato (single use after the bonus play).
    if (playerIdx === 0 && state.hotPotatoArmed) {
      state.hotPotatoArmed = false;
    }
    state.lastPlay = {
      playerIdx,
      count: cards.length,
      claim: _claimOverride || state.targetRank,
    };

    // Track human's most recent play for Mimic personality + The Mirror boss.
    if (playerIdx === 0) {
      const wasBluff = !cards.every(c => c.rank === state.targetRank || c.affix === 'mirage');
      state.lastHumanPlay = {
        count: cards.length,
        claim: state.targetRank,
        wasBluff: wasBluff,
      };
      if (wasBluff) state.humanLiesThisRound = (state.humanLiesThisRound || 0) + 1;
    }

    log(playerLabel(playerIdx) + ' plays ' + cards.length +
        (cards.length === 1 ? ' card' : ' cards') +
        ' as ' + state.targetRank + '.');

    // Sixth Sense (HUMAN only, fires on every OPPONENT play): 15% per stack
    // chance to silently learn whether the play was a bluff. Stacks up to
    // 3 → up to 45% per play. Reveal is private (privatePeek toast); the
    // opponent doesn't know we peeked. Trickster-marked +/-1 cards still
    // count as truth here — we mirror the same logic the LIAR resolver uses
    // so a Trickster bluff doesn't get falsely flagged.
    if (playerIdx !== 0 && hasJoker('sixthSense')) {
      const stacks = jokerStack('sixthSense');
      const chance = 0.15 * stacks;
      if (Math.random() < chance) {
        const _RANK_ORDER_SS = ['J', '10', 'Q', 'K', 'A'];
        const _isTricksterMatch = (card, claim) => {
          if (!state.tricksterMarkedId || card.id !== state.tricksterMarkedId) return false;
          const ci = _RANK_ORDER_SS.indexOf(card.rank);
          const ti = _RANK_ORDER_SS.indexOf(claim);
          if (ci < 0 || ti < 0) return false;
          return Math.abs(ci - ti) === 1;
        };
        const isBluff = !cards.every(c =>
          c.rank === state.targetRank || c.affix === 'mirage' || _isTricksterMatch(c, state.targetRank));
        privatePeek('Sixth Sense (' + Math.round(chance * 100) + '%): ' +
          playerLabel(playerIdx) + "'s play was " + (isBluff ? 'a BLUFF' : 'truth') + '.');
      }
    }

    // Phase 8+: Echoing modifier — 20% chance to flash first card to all
    if (runState && runState.currentFloorModifier === 'echoing' && cards.length > 0 && Math.random() < 0.2) {
      const c = cards[0];
      log('Echoing: ' + playerLabel(playerIdx) + "'s first card is a " + c.rank + '.');
    }

    // Mirage: 3-use wildcard. Track usage on the run-deck card; remove only
    // after the third resolution.
    for (const card of cards) {
      if (card.affix === 'mirage' && card.owner === 0) {
        const deckCard = runState.runDeck.find(c => c.id === card.id);
        if (deckCard) {
          deckCard.mirageUses = (deckCard.mirageUses || 0) + 1;
          if (deckCard.mirageUses >= 3) {
            runState.runDeck = runState.runDeck.filter(c => c.id !== card.id);
            log('Your Mirage is consumed (3rd and final use).');
          } else {
            const left = 3 - deckCard.mirageUses;
            log('Your Mirage triggers — ' + left + ' use' + (left === 1 ? '' : 's') + ' left.');
          }
        }
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
    // Phase 7+: Eavesdropper — fires when the player just BEFORE the joker
    // owner plays. Was hardcoded as `playerIdx === NUM_PLAYERS - 1`, which
    // only works because the human (joker owner) is always at seat 0 in
    // solo. The seat-relative form below is correct in solo and ports
    // cleanly to PvP: just replace EAVESDROPPER_OWNER_SEAT with the seat
    // that holds the joker for this client.
    const EAVESDROPPER_OWNER_SEAT = 0; // human in solo; PvP: the local seat
    const prevSeat = (EAVESDROPPER_OWNER_SEAT - 1 + NUM_PLAYERS) % NUM_PLAYERS;
    if (playerIdx === prevSeat && hasJoker('eavesdropper') &&
        runState && (totalRoundsPlayed() - (runState.eavesdropperLastFiredRound !== undefined
          ? runState.eavesdropperLastFiredRound : -99)) >= 2) {
      const matches = state.hands[playerIdx].filter(c => c.rank === state.targetRank).length;
      const bucket = matches === 0 ? 'NONE' : (matches <= 2 ? 'SOME (1-2)' : 'MANY (3+)');
      privatePeek('Eavesdropper: ' + playerLabel(playerIdx) + ' has ' + bucket + ' matches for ' + state.targetRank + '.');
      runState.eavesdropperLastFiredRound = totalRoundsPlayed();
    }

    if (playerIdx === 0 && state.doubletalkArmed) {
      state.doubletalkArmed = false;
      state.doubletalkUsedThisRound = true;
    }
    // Empty Hand: emptied hand on the very first turn of the round.
    if (playerIdx === 0 && state.humanFirstTurn) {
      if (state.hands[0].length === 0) _achGrant('emptyHand');
      state.humanFirstTurn = false;
    }

    selected.clear();
    openChallengeWindow(playerIdx);
    render();
  }

  // Find Lugen's seat index, or -1 if Lugen isn't at the table.
  function findLugenSeat() {
    if (!runState || !runState.botPersonalities) return -1;
    for (let i = 0; i < runState.botPersonalities.length; i++) {
      if (runState.botPersonalities[i] === 'lugen') return i;
    }
    return -1;
  }

  function openChallengeWindow(playerIdx) {
    const challenger = nextActivePlayer(playerIdx);
    if (challenger === -1) {
      handlePassNoChallenge(playerIdx);
      return;
    }

    // Lugen specials: once per round, Lugen can call Liar out-of-turn.
    // The "once per round" cap applies *only* to the out-of-turn override —
    // when Lugen is the natural next challenger, they go through the normal
    // challenge window without consuming the flag (that's a regular call,
    // not an interrupt). This is consistent with the design doc's "It can
    // call Liar out-of-turn once per round." Per-round normal challenges
    // are uncapped.
    //
    // The override is gated on Lugen being a different seat from both the
    // last player and the natural challenger so we don't double-count
    // their normal challenge as an "interrupt."
    const lugenIdx = findLugenSeat();
    if (lugenIdx >= 0 && lugenIdx !== playerIdx && lugenIdx !== challenger &&
        !state.eliminated[lugenIdx] && !state.finished[lugenIdx] &&
        !state.lugenLiarUsedThisRound) {
      // Lugen is more interested when more cards were claimed (bigger lies
      // are juicier). Modest base rate so this isn't always burned on play 1.
      const lp = state.lastPlay;
      const base = lp && lp.count === 3 ? 0.45 : lp && lp.count === 2 ? 0.30 : 0.18;
      if (Math.random() < base) {
        state.lugenLiarUsedThisRound = true;
        log('Lugen interrupts! Out-of-turn Liar call.');
        // Skip the natural challenge window — go straight to the call.
        state.challengeOpen = true;
        state.challengerIdx = lugenIdx;
        callLiar(lugenIdx);
        return;
      }
    }

    state.challengeOpen = true;
    state.challengerIdx = challenger;

    // Lie Detector consumable: if the human is the challenger and they've
    // armed it, fire the peek now so they see truth/lie BEFORE deciding
    // whether to click LIAR. The arm is consumed regardless of what they
    // do next (calling LIAR or passing). One use per arm.
    if (challenger === 0 && state.lieDetectorArmed && state.lastPlay) {
      state.lieDetectorArmed = false;
      const _RANK_ORDER_LD = ['J', '10', 'Q', 'K', 'A'];
      const _isTricksterMatch = (card, claim) => {
        if (!state.tricksterMarkedId || card.id !== state.tricksterMarkedId) return false;
        const ci = _RANK_ORDER_LD.indexOf(card.rank);
        const ti = _RANK_ORDER_LD.indexOf(claim);
        if (ci < 0 || ti < 0) return false;
        return Math.abs(ci - ti) === 1;
      };
      const lp2 = state.lastPlay;
      const peekedCards = state.pile.slice(-lp2.count);
      const isBluff = !peekedCards.every(c =>
        c.rank === lp2.claim || c.affix === 'mirage' || _isTricksterMatch(c, lp2.claim));
      privatePeek('Lie Detector: ' + playerLabel(lp2.playerIdx) + "'s play was " +
        (isBluff ? 'a BLUFF' : 'truth') + '. Decide whether to call LIAR.');
    }

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
    // The Hourglass relic: +4s for the human; bots without it have -30% window.
    if (hasRelic('hourglass')) {
      if (challenger === 0) {
        windowMs += 4000;
      } else {
        // bots don't hold relics in solo, so they always get the cut
        windowMs = Math.max(1500, Math.floor(windowMs * 0.70));
      }
    }
    // Rapid floor modifier: challenge windows clamp to 2 seconds for everyone.
    if (runState && runState.currentFloorModifier === 'rapid') {
      windowMs = 2000;
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

  // Continue the turn-advance after a no-challenge resolution. Split out
  // so the Black Hole picker can defer it until after the player picks.
  function _continueAfterPass(lastPlayerIdx) {
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

  function handlePassNoChallenge(lastPlayerIdx) {
    state.challengeOpen = false;
    state.challengerIdx = -1;
    clearAllTimers();
    document.getElementById('betaChallengeBar').classList.add('hidden');

    // Phase 5: Black Hole — successful Jack bluff lets the player CHOOSE
    // one non-Jack card to delete from hand. Open a picker; resume turn
    // flow once they pick (or skip).
    if (lastPlayerIdx === 0 && hasJoker('blackHole') && state.lastPlay) {
      const lp = state.lastPlay;
      const justPlayed = state.pile.slice(-lp.count);
      const playedJack = justPlayed.some(c => c.rank === 'J');
      const nonJacks = state.hands[0].filter(c => c.rank !== 'J');
      if (playedJack && nonJacks.length > 0) {
        openBlackHolePicker(() => _continueAfterPass(lastPlayerIdx));
        return;
      }
    }

    _continueAfterPass(lastPlayerIdx);
  }

  // Black Hole picker — let the player click a non-Jack card to delete.
  // "Skip" is also valid (don't have to use the trigger).
  function openBlackHolePicker(onClose) {
    let modal = document.getElementById('betaBlackHoleModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'betaBlackHoleModal';
      modal.className = 'fixed inset-0 bg-black/80 backdrop-blur z-50 flex items-center justify-center p-4';
      modal.innerHTML =
        '<div class="bg-slate-800 border-2 border-purple-400 p-6 rounded-2xl shadow-2xl max-w-lg w-full">' +
          '<h3 class="text-xl font-bold mb-1 text-center">&#127769; Black Hole</h3>' +
          '<p class="text-xs text-emerald-200 mb-3 text-center">Successful Jack bluff! Pick a non-Jack to delete from your hand, or skip.</p>' +
          '<div id="betaBlackHoleCards" class="flex flex-wrap gap-2 justify-center mb-4"></div>' +
          '<div class="text-center"><button id="betaBlackHoleSkipBtn" class="bg-white/10 hover:bg-white/20 px-4 py-2 rounded-lg text-sm">Skip</button></div>' +
        '</div>';
      document.body.appendChild(modal);
    }
    const cardsDiv = modal.querySelector('#betaBlackHoleCards');
    cardsDiv.innerHTML = '';
    const order = ['A', 'K', 'Q', '10', 'J'];
    const sorted = state.hands[0].slice().sort((a, b) => {
      const ai = order.indexOf(a.rank), bi = order.indexOf(b.rank);
      if (ai !== bi) return ai - bi;
      return a.id.localeCompare(b.id);
    });
    for (const c of sorted) {
      if (c.rank === 'J') continue;  // can't delete Jacks
      const btn = document.createElement('button');
      let cls = 'card card-face flex items-center justify-center text-2xl font-bold text-black rounded cursor-pointer hover:scale-105 transition';
      const ring = affixRingClass(c.affix);
      if (ring) cls += ' ' + ring;
      else if (c.owner === 0) cls += ' ring-2 ring-emerald-400';
      btn.className = cls;
      btn.textContent = c.rank;
      if (c.affix) btn.title = 'Affix: ' + c.affix;
      const cid = c.id;
      btn.addEventListener('click', () => {
        const idx = state.hands[0].findIndex(h => h.id === cid);
        if (idx >= 0) {
          const removed = state.hands[0].splice(idx, 1)[0];
          log('Black Hole: deleted ' + removed.rank +
              (removed.affix ? ' [' + removed.affix + ']' : '') +
              ' from your hand (Jack bluff success).');
        }
        modal.classList.add('hidden');
        if (typeof onClose === 'function') onClose();
      });
      cardsDiv.appendChild(btn);
    }
    const skipBtn = modal.querySelector('#betaBlackHoleSkipBtn');
    // Replace the skip button to clear old listeners
    const freshSkip = skipBtn.cloneNode(true);
    skipBtn.parentNode.replaceChild(freshSkip, skipBtn);
    freshSkip.addEventListener('click', () => {
      log('Black Hole: skipped.');
      modal.classList.add('hidden');
      if (typeof onClose === 'function') onClose();
    });
    modal.classList.remove('hidden');
  }

  function callLiar(challengerIdx) {
    if (!state.challengeOpen || !state.lastPlay) return;
    if (challengerIdx === 0 && runState && runState.ach) {
      runState.ach.liarCalls = (runState.ach.liarCalls || 0) + 1;
    }
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
    // Trickster joker (human-only): one card per round can be a +/-1 wildcard.
    // It counts as truth if its rank is one step away from the claim on the
    // rank ladder A > K > Q > 10 > J. Cleared at end of round.
    const _RANK_ORDER = ['J', '10', 'Q', 'K', 'A'];
    function _tricksterMatch(card, claim) {
      if (!state.tricksterMarkedId || card.id !== state.tricksterMarkedId) return false;
      const ci = _RANK_ORDER.indexOf(card.rank);
      const ti = _RANK_ORDER.indexOf(claim);
      if (ci < 0 || ti < 0) return false;
      return Math.abs(ci - ti) === 1;
    }
    // Phase 5: Mirage cards count as matching the claim (one-time wildcard)
    const allMatch = playedCards.every(c => c.rank === lp.claim || c.affix === 'mirage' || _tricksterMatch(c, lp.claim));

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
          // Glass Cannon: cumulative across runs.
          const total = _achAddProgress('glassBurned', burnedThisTrigger.length);
          if (total >= 100) _achGrant('glassCannon');
          state.burnedCards.push(...burnedThisTrigger);
          // Burn cap check: if total exceeds cap, recycle all burned -> draw pile.
          // The Witch character: their Glass burns don't trigger the recycle —
          // we just don't track their burns toward the cap.
          const witchOn = !!(runState.character && runState.character.witchUncappedGlass);
          if (witchOn) {
            // Witch ignores the burn cap entirely.
            state.burnedCards = [];
          } else if (state.burnedCards.length > BURN_CAP) {
            const recycled = state.burnedCards.length;
            state.drawPile = shuffle(state.drawPile.concat(state.burnedCards));
            state.burnedCards = [];
            log('Burn cap exceeded — ' + recycled + ' burned cards recycled into the draw pile.');
          }
        }
      }

      const doSpikedDraws = (takerIdx) => {
        const spikedCount = state.pile.filter(c => c.affix === 'spiked').length;
        const pileSnapshot = state.pile.slice();
        // Magpie joker (held by HUMAN): when an opponent takes a pile, gain 1g
        // per affixed card in it. Doesn't fire when the human takes the pile.
        if (takerIdx !== 0 && hasJoker('magpie')) {
          const affixed = pileSnapshot.filter(c => c.affix).length;
          if (affixed > 0) {
            const got = addGold(affixed);
            log('Magpie: ' + playerLabel(takerIdx) + ' picks up ' + affixed + ' affixed card(s). +' + got + 'g.');
          }
        }
        // Dead Hand joker (HUMAN only, once per floor): the first 2 Jacks in a
        // pile you take don't join your hand; they go to the bottom of the
        // draw pile instead.
        let deadHandJackIds = new Set();
        if (takerIdx === 0 && hasJoker('deadHand') && runState && !runState.deadHandUsedThisFloor) {
          let kept = 0;
          for (const c of pileSnapshot) {
            if (c.rank !== 'J') continue;
            if (kept >= 2) break;
            deadHandJackIds.add(c.id);
            kept++;
          }
          if (kept > 0) {
            runState.deadHandUsedThisFloor = true;
            log('Dead Hand: ' + kept + ' Jack(s) stay out of your hand and slide under the draw pile.');
          }
        }
        // Ricochet joker (HUMAN only): if the pile has 3+ Jacks, half (rounded
        // down) get bounced to a random active opponent instead of joining
        // your hand. Excludes Dead-Hand-held Jacks from the count.
        let ricochetIds = new Set();
        let ricochetTarget = -1;
        if (takerIdx === 0 && hasJoker('ricochet')) {
          const eligibleJacks = pileSnapshot.filter(c => c.rank === 'J' && !deadHandJackIds.has(c.id));
          if (eligibleJacks.length >= 3) {
            const bounceN = Math.floor(eligibleJacks.length / 2);
            const targets = [];
            for (let i = 1; i < NUM_PLAYERS; i++) {
              if (!state.eliminated[i] && !state.finished[i]) targets.push(i);
            }
            if (targets.length > 0) {
              ricochetTarget = targets[Math.floor(Math.random() * targets.length)];
              for (let i = 0; i < bounceN; i++) {
                ricochetIds.add(eligibleJacks[i].id);
              }
            }
          }
        }
        // Tag Cursed cards with a turn lock as they get picked up.
        // Steel Spine relic shortens the lock from 2 to 1.
        const cursedLockTurns = hasRelic('steelSpine') ? 1 : 2;
        // Distribute pile cards.
        for (const c of pileSnapshot) {
          const card = { rank: c.rank, id: c.id, owner: c.owner, affix: c.affix };
          if (card.affix === 'cursed' && takerIdx === 0) {
            card.cursedLockTurns = cursedLockTurns;
          }
          if (deadHandJackIds.has(c.id)) {
            // To bottom of draw pile (unshift puts it at the start, which is
            // the bottom of the popped stack).
            state.drawPile.unshift(card);
          } else if (ricochetIds.has(c.id) && ricochetTarget >= 0) {
            state.hands[ricochetTarget].push(card);
          } else {
            state.hands[takerIdx].push(card);
          }
        }
        if (ricochetIds.size > 0 && ricochetTarget >= 0) {
          log('Ricochet: ' + ricochetIds.size + ' Jack(s) bounce into ' + playerLabel(ricochetTarget) + '\'s hand.');
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
        // Hot Potato joker (HUMAN only): picking up 5+ cards arms the bonus
        // for the next play (max play = 5 instead of 3). Counted on the
        // pile size before pickup.
        if (takerIdx === 0 && hasJoker('hotPotato') && pileSnapshot.length >= 5) {
          state.hotPotatoArmed = true;
          log('Hot Potato: next play allows up to 5 cards.');
        }
        // Memorizer joker — log pile contents privately for the joker holder
        // (the human). Fires on any pile reveal where the pile lands somewhere.
        if (hasJoker('memorizer') && pileSnapshot.length > 0) {
          state.memorizerLog = state.memorizerLog || [];
          for (const c of pileSnapshot) {
            state.memorizerLog.push({ rank: c.rank, affix: c.affix || null, claim: c.claim || null });
          }
        }
      };

      // Caller's Mark joker (HUMAN only): the first LIAR call you make each
      // round pays out (+20g) if you were right or stings (-15g) if you were
      // wrong. Subsequent calls in the same round don't trigger — that's the
      // "encourages skilled calling, not spam" part of the design.
      // Fired here, after the reveal but before the pile is distributed, so
      // the gold change is associated with this specific reveal in the log.
      if (challengerIdx === 0 && hasJoker('callersMark') && !state.callersMarkFiredThisRound) {
        state.callersMarkFiredThisRound = true;
        if (allMatch) {
          // Truth told → the human's call was wrong.
          const lost = Math.min(15, runState.gold);
          runState.gold -= lost;
          log("Caller's Mark: wrong call. -" + lost + 'g.');
        } else {
          // Lie caught → the human's call was right. Gold goes through the
          // normal pipeline (Ledger / Greedy / Gambler multipliers apply).
          const got = addGold(20);
          log("Caller's Mark: clean read. +" + got + 'g.');
        }
      }

      if (allMatch) {
        if (lp.playerIdx === 0 && runState && runState.ach) {
          runState.ach.truthSurvivals = (runState.ach.truthSurvivals || 0) + 1;
          if (runState.ach.truthSurvivals >= 10) _achGrant('truthWins');
        }
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
        // Last Word joker (HUMAN only, once per floor): when you're caught
        // lying you can veto the result. The pile flips to the challenger
        // (truth ruling) and the round continues. You can't veto if the
        // played cards emptied your hand (since the round was about to end).
        if (lp.playerIdx === 0 && hasJoker('lastWord') && runState && !runState.lastWordUsedThisFloor) {
          const emptiedHand = state.hands[0].length === 0;
          if (!emptiedHand) {
            runState.lastWordUsedThisFloor = true;
            log('Last Word: you veto the call. Pile goes to ' + playerLabel(challengerIdx) + ' (treated as truth).');
            doSpikedDraws(challengerIdx);
            if (checkJackCurse(challengerIdx)) return;
            rotateTargetRank();
            advanceTurn(challengerIdx);
            render();
            if (!state.gameOver && state.currentTurn !== 0) {
              setTimeout(botTurn, BOT_TURN_DELAY_MS);
            }
            return;
          } else {
            log('Last Word would have triggered, but the play emptied your hand — no veto.');
          }
        }
        // Phase 7+: Scapegoat — *one* Jack routed to challenger (per design,
        // not all of them — that was strictly stronger).
        if (lp.playerIdx === 0 && hasJoker('scapegoat')) {
          const playedJackIds = playedCards.filter(c => c.rank === 'J').map(c => c.id);
          if (playedJackIds.length > 0) {
            const targetId = playedJackIds[0];
            const jackPileIdx = state.pile.findIndex(c => c.id === targetId);
            if (jackPileIdx >= 0) {
              const jack = state.pile.splice(jackPileIdx, 1)[0];
              state.hands[challengerIdx].push({ rank: jack.rank, id: jack.id, owner: jack.owner, affix: jack.affix });
              log('Scapegoat: 1 Jack routed to ' + playerLabel(challengerIdx) + ' (the rest stays with the pile).');
            }
          }
        }
        if (lp.playerIdx === 0) state.humanCaughtThisRound = true;
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
    // Old Soldier event: human is immune to the Jack curse for one round.
    if (playerIdx === 0 && runState && runState.oldSoldierImmuneNextRound) {
      // Active flag persists for the round; we'll clear it at endRound.
      const limit = jackLimitFor(playerIdx);
      const weight = jackCurseWeight(state.hands[playerIdx]);
      if (weight >= limit) {
        log("The Old Soldier shields you — Jack curse skipped this round.");
      }
      return false;
    }
    const limit = jackLimitFor(playerIdx);
    const weight = jackCurseWeight(state.hands[playerIdx]);
    const jacks = countJacks(state.hands[playerIdx]);
    if (weight >= limit) {
      const detail = (weight !== jacks)
        ? jacks + ' Jacks (weight ' + weight + ', Steel Jacks count double)'
        : jacks + ' Jacks';
      log(playerLabel(playerIdx) + ' has ' + detail +
          ' — eliminated by the Jack curse!');
      state.eliminated[playerIdx] = true;
      // Vengeful Spirit (Legendary): when the human is taken by the Jack
      // curse, drag the next active player into next round with 2 forced
      // Jacks. We don't kill them in this round (that would auto-end and
      // override the natural placement winner); instead the penalty carries
      // forward as a hand handicap. This is the closest solo equivalent of
      // the design's "they lose a Heart" — bots don't have Hearts.
      if (playerIdx === 0 && hasJoker('vengefulSpirit')) {
        for (let i = 1; i < NUM_PLAYERS; i++) {
          const target = (playerIdx + i) % NUM_PLAYERS;
          if (!state.eliminated[target] && !state.finished[target]) {
            runState.vengefulNextRoundTargets = runState.vengefulNextRoundTargets || [];
            runState.vengefulNextRoundTargets.push(target);
            log('Vengeful Spirit: ' + playerLabel(target) + ' will start the next round with 2 forced Jacks.');
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

    // Personality-specific bluff rate. Replaces the previous "fixed pers.bluffRate"
    // for personalities that should react to game state instead of rolling a die.
    let bluffRate = pers ? pers.bluffRate : 0.30;
    const target = state.targetRank;
    const matching = hand.filter(c => c.rank === target);
    const nonMatching = hand.filter(c => c.rank !== target);
    const myJacks = countJacks(hand);
    const limit = jackLimitFor(botIdx);

    if (persId === 'methodical') {
      // Math-aware: only bluffs when conditions are favorable.
      // - few Jacks held (<= limit-3 means a comfy buffer)
      // - lots of matching cards in hand (>= 2)
      // Otherwise plays truth if possible, else minimum-risk bluff.
      const safeJacks = myJacks <= Math.max(0, limit - 3);
      const goodHand = matching.length >= 2;
      bluffRate = (safeJacks && goodHand) ? 0.65 : 0.10;
    } else if (persId === 'mimic') {
      // Copy the human's most recent play type. If they last bluffed, this
      // bot bluffs; if they told the truth (or haven't played), it plays it safe.
      if (state.lastHumanPlay && state.lastHumanPlay.wasBluff) {
        bluffRate = 0.80;
      } else if (state.lastHumanPlay) {
        bluffRate = 0.10;
      } else {
        bluffRate = 0.40;
      }
    } else if (persId === 'wildcard') {
      // Genuinely random — re-roll the bluff rate every single play.
      bluffRate = Math.random();
    }
    // Empty Threat: a single feint cools the next bot's bluff rate.
    if (state.emptyThreatPending) {
      bluffRate = Math.max(0.05, bluffRate - 0.40);
      state.emptyThreatPending = false;
      log('[Tell] ' + playerLabel(botIdx) + ' eyes you warily — your fake call worked.');
    }

    let cardsToPlay = null;

    // The Mirror boss copies whatever the human played last turn — same count,
    // same claim. If the human hasn't played yet, fall back to normal AI.
    if (persId === 'mirror' && state.lastHumanPlay) {
      const wantCount = Math.min(state.lastHumanPlay.count, hand.length, 3);
      // Prefer honest matches, but if not enough, pad with anything.
      const honestPicks = matching.slice(0, wantCount);
      const padCount = wantCount - honestPicks.length;
      const padPool = shuffle(nonMatching);
      cardsToPlay = honestPicks.concat(padPool.slice(0, padCount));
      if (cardsToPlay.length === 0) cardsToPlay = shuffle(hand).slice(0, 1);
    }

    if (!cardsToPlay) {
      // Phase 8+: bluff if no matching available, else roll bluffRate
      const willBluff = (matching.length === 0) || (Math.random() < bluffRate);
      const truthful = !willBluff && matching.length > 0;
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
    }

    // Lugen specials: every card it plays is randomly affixed (overwriting
    // existing affixes). This makes Lugen's plays unpredictable and uses the
    // full reveal-time affix kit every turn.
    if (persId === 'lugen') {
      const lugenAffixes = ['gilded', 'glass', 'spiked', 'cursed', 'steel', 'mirage', 'hollow', 'echo'];
      for (const c of cardsToPlay) {
        c.affix = lugenAffixes[Math.floor(Math.random() * lugenAffixes.length)];
      }
    }

    // Phase 8+: tell — fire only when the play is actually deceptive (or for
    // Wildcard, fire on any play because its inconsistency IS the lesson).
    const isBluff = !cardsToPlay.every(c => c.rank === target || c.affix === 'mirage');
    const shouldTellOnBluff = (persId !== 'coward' && persId !== 'eager');
    const tellFires =
      pers && pers.tell && shouldShowTells() && (
        persId === 'wildcard' ? (Math.random() < 0.5) :
        persId === 'mimic'    ? (state.lastHumanPlay && Math.random() < 0.6) :
        shouldTellOnBluff     ? isBluff :
        false
      );
    if (tellFires) {
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

    // The Auditor: challenges every Nth opportunity (N = runState.auditorEveryN,
    // rolled once per floor in [1..5]). Counter ticks every time we get here.
    if (persId === 'auditor') {
      const N = (runState && runState.auditorEveryN) || 3;
      state.auditorChances = (state.auditorChances || 0) + 1;
      const fires = (state.auditorChances % N) === 0;
      if (fires) log('[Tell] The Auditor flips its ledger — challenge incoming.');
      return fires;
    }

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
      // Foggy hides the rank as well as the target — show "?" so the player
      // genuinely has to remember.
      const foggyHide = state.foggyHidden && runState && runState.currentFloorModifier === 'foggy';
      const claimText = foggyHide ? '?' : state.lastPlay.claim;
      lpEl.textContent = playerLabel(state.lastPlay.playerIdx) +
        ' claims ' + state.lastPlay.count + ' × ' + claimText;
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
    // Ensure DOM has the right number of slots — create or remove as needed.
    const jokerRow = document.getElementById('betaJokerRow');
    const surveyorMarker = document.getElementById('betaSurveyorInfo');
    if (jokerRow && surveyorMarker) {
      const need = runState.jokers.length;
      // Remove extras
      let slot = document.getElementById('betaJokerSlot' + need);
      while (slot) { slot.remove(); slot = document.getElementById('betaJokerSlot' + (need + (slot ? 1 : 0))); break; }
      // Easier: remove all betaJokerSlot* and recreate.
      Array.from(jokerRow.querySelectorAll('[id^="betaJokerSlot"]')).forEach(el => el.remove());
      for (let i = 0; i < need; i++) {
        const div = document.createElement('div');
        div.id = 'betaJokerSlot' + i;
        div.className = 'inline-flex items-center gap-1 px-2 py-1 rounded bg-black/40';
        div.innerHTML = '<span class="italic text-white/40">Empty</span>';
        jokerRow.insertBefore(div, surveyorMarker);
      }
    }
    for (let i = 0; i < runState.jokers.length; i++) {
      const slot = document.getElementById('betaJokerSlot' + i);
      if (!slot) continue;
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
    smokeBomb:     { name: 'Smoke Bomb',     desc: 'Skip your turn (play passes to the next active player).' },
    counterfeit:   { name: 'Counterfeit',    desc: 'Change the target rank for the rest of the round AND lock it through the next Liar call. Once per round.' },
    jackBeNimble:  { name: 'Jack-be-Nimble', desc: 'Discard up to 2 Jacks from your hand. Use anytime on your turn.' },
    whisperNetwork:{ name: 'Whisper Network',desc: 'Hear how many Jacks each opponent currently holds (private read).' },
    luckyCoin:     { name: 'Lucky Coin',     desc: 'Re-roll the affix on a chosen hand card (Steel-immune; Cursed clears).' },
    snakeEyes:     { name: 'Snake Eyes',     desc: 'Cancel the next Target Rank rotation. One-shot lock.' },
    emptyThreat:   { name: 'Empty Threat',   desc: 'Floor-locked. Fake a Liar call against the next bot play; the bot reacts cautiously, but no real call fires.' },
    distillation:  { name: 'Distillation',   desc: 'Merge 2 same-rank hand cards into 1 with a random affix.' },
    pickpocket:    { name: 'Pickpocket',     desc: 'Floor-locked. Steal a random non-Jack from a chosen opponent (positive affixes weighted higher).' },
    deadDrop:      { name: 'Dead Drop',      desc: 'Discard 3 random hand cards, then draw 3 from the draw pile.' },
    markedDeck:    { name: 'Marked Deck',    desc: 'Floor-locked. Apply a chosen affix to a random draw-pile card.' },
    jokersMask:    { name: "The Joker's Mask",desc: 'Tag a non-Jack so it counts as a Jack for the Jack curse this round.' },
    mirrorShard:   { name: 'Mirror Shard',   desc: 'Arm: the next Liar call against you shows only the result, not the cards.' },
    stackedHand:   { name: 'Stacked Hand',   desc: 'Arm: next round, your starting hand pulls +20% additional cards from your own run deck.' },
    crookedDie:    { name: 'Crooked Die',    desc: 'Re-roll the Target Rank for this round only. Floor-locked.' },
    lieDetector:   { name: 'Lie Detector',   desc: 'Arm: the next time you can call LIAR, peek the truth privately before deciding.' },
  };
  // Map id -> use-handler for new consumables. Old ones (smoke / counterfeit /
  // jackBeNimble) still have their own buttons in the action bar; we let those
  // stay primary but also let players use them via the row when convenient.
  const CONSUMABLE_USE_HANDLERS = {
    smokeBomb:      () => useSmokeBomb(),
    counterfeit:    () => startCounterfeitPick(),
    jackBeNimble:   () => useJackBeNimble(),
    whisperNetwork: () => useWhisperNetwork(),
    luckyCoin:      () => useLuckyCoin(),
    snakeEyes:      () => useSnakeEyes(),
    emptyThreat:    () => useEmptyThreat(),
    distillation:   () => useDistillation(),
    pickpocket:     () => usePickpocket(),
    deadDrop:       () => useDeadDrop(),
    markedDeck:     () => useMarkedDeck(),
    jokersMask:     () => useJokersMask(),
    mirrorShard:    () => useMirrorShard(),
    stackedHand:    () => useStackedHand(),
    crookedDie:     () => useCrookedDie(),
    lieDetector:    () => useLieDetector(),
  };

  function _consumableUsableNow(id) {
    if (!state || state.gameOver) return false;
    if (state.currentTurn !== 0) return false;
    if (state.challengeOpen) return false;
    if (state.finished[0] || state.eliminated[0]) return false;
    // Some consumables are floor-locked: blocked if the per-floor flag is set.
    if (id === 'pickpocket' && runState.pickpocketUsedThisFloor) return false;
    if (id === 'markedDeck' && runState.markedDeckUsedThisFloor) return false;
    if (id === 'emptyThreat' && runState.emptyThreatUsedThisFloor) return false;
    if (id === 'crookedDie' && runState.crookedDieUsedThisFloor) return false;
    return true;
  }

  function renderConsumablesRow() {
    const list = document.getElementById('betaConsumablesList');
    if (!list || !runState) return;
    list.innerHTML = '';
    for (const id of Object.keys(CONSUMABLE_INFO)) {
      const info = CONSUMABLE_INFO[id];
      const count = runState.inventory[id] || 0;
      const pill = document.createElement('div');
      const owned = count > 0;
      const usable = owned && _consumableUsableNow(id);
      let cls = 'inline-flex items-center gap-1 px-2 py-1 rounded transition ';
      if (usable) cls += 'bg-amber-700/70 text-amber-50 cursor-pointer hover:bg-amber-600/80 ring-1 ring-amber-300';
      else if (owned) cls += 'bg-amber-900/40 text-amber-100 cursor-pointer hover:bg-amber-800/60';
      else cls += 'bg-black/40 text-white/40';
      pill.className = cls;
      const useHint = usable ? ' &middot; <span class="text-[10px] text-amber-200">click to use</span>' : '';
      pill.innerHTML = escapeHtml(info.name) +
        ' <span class="font-bold">(' + count + ')</span>' + useHint;
      pill.title = info.desc;
      if (owned) {
        pill.addEventListener('click', () => {
          if (usable && CONSUMABLE_USE_HANDLERS[id]) {
            CONSUMABLE_USE_HANDLERS[id]();
          } else {
            showInfoModal(info.name, 'You own ' + count, info.desc);
          }
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
  // Card Inspector — shows the full deck composition + affixes
  // ============================================================

  const _AFFIX_NAMES = {
    gilded: 'Gilded',
    glass:  'Glass',
    spiked: 'Spiked',
    cursed: 'Cursed',
    steel:  'Steel',
    mirage: 'Mirage',
    hollow: 'Hollow',
    echo:   'Echo',
  };

  function _makeInspectorCardEl(card, opts) {
    opts = opts || {};
    const div = document.createElement('div');
    let cls = 'card card-face flex items-center justify-center text-xl font-bold text-black rounded';
    const ring = affixRingClass(card.affix);
    if (ring) cls += ' ' + ring;
    else if (opts.markYours && card.owner === 0) cls += ' ring-2 ring-emerald-400';
    div.className = cls;
    div.textContent = card.rank;
    const owner = card.owner === 0 ? 'You' :
                  card.owner === -1 ? 'Base deck' :
                  ('Bot ' + card.owner);
    const affixLabel = card.affix ? (_AFFIX_NAMES[card.affix] || card.affix) : '—';
    div.title = card.rank + ' — ' + owner + ' — Affix: ' + affixLabel;
    return div;
  }

  function renderDeckInspector() {
    if (!runState) return;

    // 1) Player's run deck — sorted A, K, Q, 10
    const runDeckDiv = document.getElementById('betaInspectorRunDeck');
    runDeckDiv.innerHTML = '';
    const order = ['A', 'K', 'Q', '10', 'J'];
    const sortedRun = runState.runDeck.slice().sort((a, b) => {
      const ai = order.indexOf(a.rank), bi = order.indexOf(b.rank);
      if (ai !== bi) return ai - bi;
      // affixed cards first within same rank
      if ((a.affix ? 1 : 0) !== (b.affix ? 1 : 0)) return (b.affix ? 1 : 0) - (a.affix ? 1 : 0);
      return a.id.localeCompare(b.id);
    });
    for (const c of sortedRun) {
      runDeckDiv.appendChild(_makeInspectorCardEl(c, { markYours: false }));
    }

    // 2) Round-deck composition — show the LIVE deck (every card currently in
    //    the round). This includes hands, draw pile, pile, and the last-play
    //    cards, so per-floor random-affix infusions and mid-round changes are
    //    reflected accurately. If no round is active yet, fall back to a
    //    capped preview.
    const all = [];
    if (state) {
      // Live snapshot — all cards currently in play
      for (const hand of (state.hands || [])) for (const c of hand) all.push({ ...c });
      for (const c of (state.drawPile || [])) all.push({ ...c });
      for (const c of (state.pile || [])) all.push({ ...c });
      if (state.lastPlay && Array.isArray(state.lastPlay.cards)) {
        for (const c of state.lastPlay.cards) all.push({ ...c });
      }
      // De-duplicate by id (lastPlay cards may also live in pile/hands)
      const seen = new Set();
      for (let i = all.length - 1; i >= 0; i--) {
        const id = all[i].id;
        if (id && seen.has(id)) all.splice(i, 1);
        else if (id) seen.add(id);
      }
    } else {
      // No live round — preview using the cap logic so the count matches
      // what would actually be dealt.
      for (let i = 0; i < 6; i++) {
        all.push({ rank: 'J', owner: -1, affix: null, id: 'rd_J_' + i });
      }
      const buckets = { 'A': [], 'K': [], 'Q': [], '10': [] };
      for (let p = 0; p < 4; p++) {
        const personalDeck = (p === 0) ? runState.runDeck : buildInitialRunDeck(p);
        for (const c of personalDeck) {
          if (buckets[c.rank]) buckets[c.rank].push({ ...c });
        }
      }
      for (const r of Object.keys(buckets)) {
        const cards = buckets[r];
        const cap = 8;
        if (cards.length <= cap) {
          for (const c of cards) all.push(c);
        } else {
          const affixed = cards.filter(c => c.affix);
          const plain = cards.filter(c => !c.affix);
          const ordered = affixed.concat(plain);
          for (let i = 0; i < cap; i++) all.push(ordered[i]);
        }
      }
    }

    // Sort: rank order, owner asc (you=0 first inside each rank? show base J's first)
    all.sort((a, b) => {
      const ai = order.indexOf(a.rank), bi = order.indexOf(b.rank);
      if (ai !== bi) return ai - bi;
      if (a.owner !== b.owner) {
        // your cards first within rank, then bots, then base
        const wa = (a.owner === 0) ? 0 : (a.owner === -1 ? 9 : a.owner);
        const wb = (b.owner === 0) ? 0 : (b.owner === -1 ? 9 : b.owner);
        return wa - wb;
      }
      if ((a.affix ? 1 : 0) !== (b.affix ? 1 : 0)) return (b.affix ? 1 : 0) - (a.affix ? 1 : 0);
      return 0;
    });

    const roundDeckDiv = document.getElementById('betaInspectorRoundDeck');
    roundDeckDiv.innerHTML = '';
    let lastRank = null;
    for (const c of all) {
      if (lastRank !== null && c.rank !== lastRank) {
        const sep = document.createElement('div');
        sep.className = 'w-full h-1';
        roundDeckDiv.appendChild(sep);
      }
      lastRank = c.rank;
      roundDeckDiv.appendChild(_makeInspectorCardEl(c, { markYours: true }));
    }

    // Counts summary
    const counts = {};
    for (const r of order) counts[r] = 0;
    for (const c of all) counts[c.rank] = (counts[c.rank] || 0) + 1;
    const affixed = all.filter(c => c.affix).length;
    const summary = order.filter(r => counts[r]).map(r => r + '×' + counts[r]).join('  ·  ');
    document.getElementById('betaInspectorRoundCounts').textContent =
      summary + '   —   Total: ' + all.length + ' cards   —   Affixed: ' + affixed;
  }

  function openDeckInspector() {
    if (!runState) return;
    renderDeckInspector();
    document.getElementById('betaDeckInspectorModal').classList.remove('hidden');
  }

  function closeDeckInspector() {
    document.getElementById('betaDeckInspectorModal').classList.add('hidden');
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
    document.getElementById('betaFloor').textContent = runState.currentFloor;

    // Phase 8+: clickable modifier / boss badge — opens the info modal
    const badge = document.getElementById('betaFloorModBadge');
    if (badge) {
      const fresh = badge.cloneNode(false);
      fresh.id = 'betaFloorModBadge';
      badge.parentNode.replaceChild(fresh, badge);
      const boss = getBoss(runState.currentFloor);
      const mod = runState.currentFloorModifier && FLOOR_MODIFIERS[runState.currentFloorModifier];
      if (boss) {
        fresh.innerHTML = '<button class="bg-rose-700 hover:bg-rose-600 transition px-2 py-0.5 rounded text-xs font-bold cursor-pointer">&#128081; BOSS: ' + escapeHtml(boss.name) + '</button>';
        fresh.querySelector('button').addEventListener('click', () => {
          showInfoModal(boss.name, 'Boss \u2014 Floor ' + boss.floor, boss.desc);
        });
      } else if (mod) {
        fresh.innerHTML = '<button class="bg-purple-700 hover:bg-purple-600 transition px-2 py-0.5 rounded text-xs font-bold cursor-pointer">' + escapeHtml(mod.name) + '</button>';
        fresh.querySelector('button').addEventListener('click', () => {
          showInfoModal(mod.name, 'Floor Modifier', mod.desc);
        });
      } else {
        fresh.innerHTML = '';
      }
    }
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


  // Per-floor random-affix infusion: each round, sprinkle some random
  // affixes onto draw-pile cards. Floor scales the count (more affixes
  // deeper into the run). Cards that already have an affix are skipped
  // (so a Banker's Gilded Ace, Brittle modifier, etc. aren't overwritten).
  const FLOOR_AFFIX_POOL = ['gilded', 'glass', 'spiked', 'cursed',
                            'steel', 'mirage', 'hollow', 'echo'];
  function affixCountForFloor(floor) {
    // floor 1 => 1, floor 2 => 2, ..., floor 9 => 9. Tunable.
    return Math.max(0, Math.min(9, floor | 0));
  }
  function applyFloorAffixesToDrawPile(drawPile, floor) {
    const target = affixCountForFloor(floor);
    if (target <= 0 || !drawPile || drawPile.length === 0) return 0;
    const candidates = drawPile.filter(c => !c.affix);
    if (candidates.length === 0) return 0;
    const shuffled = shuffle(candidates);
    const n = Math.min(target, shuffled.length);
    let infused = 0;
    for (let i = 0; i < n; i++) {
      const affix = FLOOR_AFFIX_POOL[Math.floor(Math.random() * FLOOR_AFFIX_POOL.length)];
      shuffled[i].affix = affix;
      infused++;
    }
    return infused;
  }

  function jokerSlotsForFloor(floor) {
    if (floor <= 3) return 2;
    if (floor <= 6) return 3;
    return 5;
  }
  function ensureSoloJokerSlots(floor) {
    if (!runState) return;
    const want = jokerSlotsForFloor(floor);
    while (runState.jokers.length < want) runState.jokers.push(null);
  }

  // Phase 5: affix → ring color mapping
  function affixRingClass(affix) {
    switch (affix) {
      case 'gilded': return 'ring-2 ring-yellow-400';
      case 'glass':  return 'ring-2 ring-cyan-400';
      case 'spiked': return 'ring-2 ring-red-400';
      case 'cursed': return 'ring-2 ring-purple-500';
      case 'steel':  return 'ring-2 ring-gray-300';
      case 'mirage': return 'card-rainbow';
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
  // Stack count for a joker. 0 = not equipped. 1 = base equip. Stackable
  // jokers can go above 1 via repeat purchases (e.g. Sixth Sense → max 3).
  // Non-stackable jokers always return 1 when equipped.
  function jokerStack(jokerId) {
    if (!hasJoker(jokerId)) return 0;
    if (runState && runState.jokerStacks && runState.jokerStacks[jokerId]) {
      return runState.jokerStacks[jokerId];
    }
    return 1;
  }
  function equipJoker(jokerData) {
    // Stackable joker already equipped → bump the stack instead of taking
    // another slot. Caller (the shop buy flow) is responsible for checking
    // we haven't hit maxStack before calling this.
    if (jokerData && jokerData.stackable && hasJoker(jokerData.id)) {
      const cur = jokerStack(jokerData.id);
      const cap = jokerData.maxStack || 1;
      if (cur >= cap) return false;
      runState.jokerStacks = runState.jokerStacks || {};
      runState.jokerStacks[jokerData.id] = cur + 1;
      return true;
    }
    for (let i = 0; i < runState.jokers.length; i++) {
      if (runState.jokers[i] === null) {
        runState.jokers[i] = { ...jokerData };
        if (jokerData && jokerData.stackable) {
          runState.jokerStacks = runState.jokerStacks || {};
          runState.jokerStacks[jokerData.id] = 1;
        }
        if (runState.ach) {
          runState.ach.jokersEverEquipped = (runState.ach.jokersEverEquipped || 0) + 1;
          if (runState.ach.jokersEverEquipped >= 5) _achGrant('jokersWild');
        }
        return true;
      }
    }
    return false;
  }

  // Per-account relic unlock check. Returns true if no condition or condition met.
  function isRelicUnlocked(id) {
    const r = RELIC_CATALOG[id];
    if (!r || !r.unlock) return true;
    const u = r.unlock;
    if (u.type === 'lugenKills') {
      const prog = (typeof _achGetProgress === 'function') ? _achGetProgress() : {};
      const kills = (prog.bossKills && prog.bossKills.lugen) || 0;
      return kills >= (u.count || 0);
    }
    return true;
  }
  function relicUnlockHint(id) {
    const r = RELIC_CATALOG[id];
    if (!r || !r.unlock) return null;
    const u = r.unlock;
    if (u.type === 'lugenKills') {
      const prog = (typeof _achGetProgress === 'function') ? _achGetProgress() : {};
      const kills = (prog.bossKills && prog.bossKills.lugen) || 0;
      return 'Beat Lugen ' + (u.count || 0) + ' times (progress ' + kills + '/' + (u.count || 0) + ').';
    }
    return null;
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
    if (runState.currentFloorModifier === 'richFolk') mult *= 0.5;  // Rich Folk: gold halved
    // Dragon Scale: +10% gold per Steel card in hand.
    if (hasRelic('dragonScale')) mult *= (1 + 0.10 * _humanSteelCount());
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
      // Patron joker: +1g per Gilded card on top of the base Gilded amount.
      const perCard = GOLD_PER_GILDED_PER_TURN + (hasJoker('patron') ? 1 : 0);
      const base = gilded * perCard;
      const gain = addGold(base);
      state._gildedRoundEarnings = (state._gildedRoundEarnings || 0) + gain;
    }
    // Decrement Cursed lock counters on the human's turn-start.
    if (state.currentTurn === 0) {
      for (const c of state.hands[0]) {
        if (c.cursedLockTurns && c.cursedLockTurns > 0) {
          c.cursedLockTurns -= 1;
        }
      }
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
      // The Hollow boss hides their hand size from the player.
      const hollowHide = persId === 'hollow';
      const handSizeDisplay = hollowHide ? '?' : state.hands[i].length;
      // Seer's Eye: show affix dots beside the hand-size number, one per card.
      let seerStrip = '';
      if (hasRelic('seersEye') && !hollowHide) {
        const dotColors = {
          gilded: 'bg-yellow-400',
          glass: 'bg-cyan-400',
          spiked: 'bg-red-400',
          cursed: 'bg-purple-500',
          steel: 'bg-gray-300',
          mirage: 'bg-pink-400',
          hollow: 'bg-indigo-400',
          echo: 'bg-fuchsia-400',
        };
        const dots = state.hands[i].map(c => {
          const col = dotColors[c.affix] || 'bg-white/20';
          return '<span class="inline-block w-2 h-2 rounded-full mx-0.5 ' + col + '"></span>';
        }).join('');
        seerStrip = '<div class="my-1 min-h-[0.5rem]">' + dots + '</div>';
      }
      // The Screamer: render face-up mini-cards for every card of the
      // screamed rank in this opponent's hand. Hidden if Hollow boss is
      // hiding hand size — that takes precedence (paranoia tier intact).
      let screamerStrip = '';
      if (state.screamerRevealedRank && !hollowHide) {
        const matches = state.hands[i].filter(c => c.rank === state.screamerRevealedRank);
        if (matches.length > 0) {
          const minis = matches.map(c => {
            const ring = affixRingClass(c.affix) || 'ring-2 ring-rose-400';
            return '<div class="card card-face inline-flex items-center justify-center text-base font-bold text-black rounded ' + ring +
              '" style="width:28px;height:38px;margin:0 1px;" title="Screamer reveal">' + escapeHtml(c.rank) + '</div>';
          }).join('');
          screamerStrip = '<div class="my-1">' + minis + '</div>';
        } else {
          screamerStrip = '<div class="text-[10px] text-rose-300 my-1 italic">no ' + escapeHtml(state.screamerRevealedRank) + 's</div>';
        }
      }
      const card = document.createElement('div');
      card.className = 'bg-black/40 p-3 rounded-lg text-center min-w-[120px]' + ringClass;
      card.innerHTML =
        '<div class="text-sm font-bold">' + BOT_NAMES[i - 1] + '</div>' +
        '<div class="text-2xl font-extrabold my-1">' + handSizeDisplay + '</div>' + seerStrip +
        '<div class="text-xs text-emerald-300">cards</div>' +
        screamerStrip +
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
      // Trickster: mark the +/-1 wildcard card with a fuchsia outer ring + tooltip.
      if (state && state.tricksterMarkedId === card.id) {
        div.style.boxShadow = '0 0 0 3px #d946ef';
        div.title = (div.title ? div.title + ' \u2014 ' : '') + 'Trickster +/-1 wildcard';
      }
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
    const carouserSmokeFree = hasJoker('carouser') && runState && runState.carouserUsedThisFloor && !runState.carouserUsedThisFloor.smokeBomb;
    if (myTurn && runState && (runState.inventory.smokeBomb > 0 || carouserSmokeFree)) {
      smokeBtn.classList.remove('hidden');
      document.getElementById('betaSmokeCount').textContent = (runState.inventory.smokeBomb || 0) + (carouserSmokeFree ? '+1\u2728' : '');
    }

    // Counterfeit button + inline rank picker (Phase 4)
    const cfBtn = document.getElementById('betaUseCounterfeitBtn');
    cfBtn.classList.add('hidden');
    const carouserCfFree = hasJoker('carouser') && runState && runState.carouserUsedThisFloor && !runState.carouserUsedThisFloor.counterfeit;
    if (myTurn && runState && (runState.inventory.counterfeit > 0 || carouserCfFree) &&
        !state.counterfeitUsed) {
      cfBtn.classList.remove('hidden');
      document.getElementById('betaCounterfeitCount').textContent = (runState.inventory.counterfeit || 0) + (carouserCfFree ? '+1\u2728' : '');
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
    const carouserJbnFree = hasJoker('carouser') && runState && runState.carouserUsedThisFloor && !runState.carouserUsedThisFloor.jackBeNimble;
    if (myTurn && runState && (runState.inventory.jackBeNimble > 0 || carouserJbnFree)) {
      const jacksInHand = state.hands[0].filter(c => c.rank === 'J').length;
      if (jacksInHand > 0) {
        jbnBtn.classList.remove('hidden');
        document.getElementById('betaJackBtnCount').textContent = (runState.inventory.jackBeNimble || 0) + (carouserJbnFree ? '+1\u2728' : '');
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
    // Cracked Mirror "Rewind" button — visible whenever a fresh snapshot is
    // available and it's still the human's option (after challenge resolved,
    // before next play). Once per floor.
    _ensureMirrorRewindButton(
      hasRelic('crackedMirror') && !runState.crackedMirrorUsedThisFloor &&
      state._mirrorSnapshot && !state.gameOver
    );
    // New joker action buttons: Trickster, Doppelganger, Saboteur, Last Word.
    // We create + reuse them on demand to avoid touching index.html.
    _ensureJokerActionButton('betaTricksterBtn', 'fuchsia', '\ud83c\udfb4 Trickster',
      myTurn && hasJoker('trickster') && !state.tricksterUsedThisRound,
      onTricksterClick);
    _ensureJokerActionButton('betaDoppelgangerBtn', 'pink', '\ud83d\udc65 Doppelganger',
      myTurn && hasJoker('doppelganger') && !state.doppelUsedThisRound && state.lastPlay,
      onDoppelgangerClick);
    _ensureJokerActionButton('betaSaboteurBtn', 'orange', '\u2620 Saboteur',
      myTurn && hasJoker('saboteur') && runState && !runState.saboteurUsedThisFloor && state.hands[0].length > 0,
      onSaboteurClick);
    // Magician character: once per round, transform a hand card.
    const magUsable = myTurn && runState && runState.character &&
                      runState.character.transformPerRound &&
                      !state.magicianUsedThisRound && state.hands[0].length > 0;
    _ensureJokerActionButton('betaMagicianBtn', 'fuchsia', '\u2728 Transmute',
      magUsable, onMagicianClick);
    // The Alchemist joker: once per round, transform a hand card to a positive-affixed card.
    const alchUsable = myTurn && hasJoker('alchemist') && !state.alchemistUsedThisRound && state.hands[0].length > 0;
    _ensureJokerActionButton('betaAlchemistBtn', 'pink', '\u2697 Alchemy',
      alchUsable, onAlchemistClick);
    // Doppelganger label changes if armed.
    const dgBtn = document.getElementById('betaDoppelgangerBtn');
    if (dgBtn && myTurn && hasJoker('doppelganger')) {
      dgBtn.textContent = state.doppelArmed
        ? 'Doppelganger ON (cancel)'
        : '\ud83d\udc65 Doppelganger';
    }
    // Trickster label changes if a card is marked.
    const trBtn = document.getElementById('betaTricksterBtn');
    if (trBtn && myTurn && hasJoker('trickster')) {
      trBtn.textContent = state.tricksterMarkedId
        ? 'Trickster: marked'
        : '\ud83c\udfb4 Trickster';
    }
    // Render the Memorizer side panel (private to joker holder).
    renderMemorizerPanel();
  }

  function _ensureMirrorRewindButton(visible) {
    let btn = document.getElementById('betaMirrorRewindBtn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'betaMirrorRewindBtn';
      btn.className = 'hidden bg-amber-700 hover:bg-amber-600 transition px-4 py-2 rounded-lg font-bold text-sm';
      btn.textContent = '\u23ee Rewind (Cracked Mirror)';
      btn.addEventListener('click', _doMirrorRewind);
      const ld = document.getElementById('betaLoadedDieBtn');
      if (ld && ld.parentNode) ld.parentNode.appendChild(btn);
      else document.body.appendChild(btn);
    }
    if (visible) btn.classList.remove('hidden');
    else btn.classList.add('hidden');
  }
  function _doMirrorRewind() {
    if (!state || !state._mirrorSnapshot) return;
    if (!hasRelic('crackedMirror') || runState.crackedMirrorUsedThisFloor) return;
    // Restore hand and pile.
    const snap = state._mirrorSnapshot;
    state.hands[0] = snap.prevHand.map(c => ({ ...c }));
    // Trim the pile back to its pre-play length, but skip any cards that have
    // since been picked up (which means the pile is shorter).
    while (state.pile.length > snap.prevPileLen) state.pile.pop();
    state._mirrorSnapshot = null;
    runState.crackedMirrorUsedThisFloor = true;
    log('Cracked Mirror: your last play is rewound. Hand and pile restored.');
    render();
  }
  // Tiny helper: create-or-reuse a joker action button beside the others,
  // toggling visibility based on availability.
  function _ensureJokerActionButton(id, tone, label, visible, onClick) {
    let btn = document.getElementById(id);
    const colorMap = {
      fuchsia: 'bg-fuchsia-700 hover:bg-fuchsia-600',
      pink:    'bg-pink-700 hover:bg-pink-600',
      orange:  'bg-orange-700 hover:bg-orange-600',
    };
    const tonecls = colorMap[tone] || 'bg-purple-700 hover:bg-purple-600';
    if (!btn) {
      btn = document.createElement('button');
      btn.id = id;
      btn.className = 'hidden ' + tonecls + ' transition px-4 py-2 rounded-lg font-bold text-sm';
      btn.textContent = label;
      btn.addEventListener('click', () => onClick());
      const ld = document.getElementById('betaLoadedDieBtn');
      if (ld && ld.parentNode) ld.parentNode.appendChild(btn);
      else document.body.appendChild(btn);
    }
    if (visible) btn.classList.remove('hidden');
    else btn.classList.add('hidden');
  }

  // Memorizer side panel — bottom-left, click to dismiss the most recent
  // entry isn't supported (kept simple). Cleared on round end.
  function renderMemorizerPanel() {
    let panel = document.getElementById('betaMemorizerPanel');
    if (!hasJoker('memorizer') || !state || !state.memorizerLog || state.memorizerLog.length === 0) {
      if (panel) panel.classList.add('hidden');
      return;
    }
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'betaMemorizerPanel';
      panel.className = 'fixed bottom-4 left-4 max-w-xs bg-fuchsia-900/95 border border-fuchsia-300 text-fuchsia-50 text-xs rounded-lg shadow-2xl p-3 z-40';
      document.body.appendChild(panel);
    }
    const items = state.memorizerLog.slice(-30).map(e => {
      const aff = e.affix ? ' [' + e.affix + ']' : '';
      const claim = e.claim ? (' / claim: ' + e.claim) : '';
      return '<div>' + escapeHtml(e.rank + aff + claim) + '</div>';
    }).join('');
    panel.innerHTML = '<div class="text-[10px] uppercase tracking-widest text-fuchsia-200 font-bold mb-1">\ud83e\udde0 Memorizer (revealed cards)</div>' + items;
    panel.classList.remove('hidden');
  }

  // Trickster: prompt the player to mark one of their hand cards as +/-1
  // wildcard. Re-uses the inline picker pattern.
  function onTricksterClick() {
    if (!hasJoker('trickster')) return;
    if (state.tricksterUsedThisRound) return;
    if (state.gameOver || state.challengeOpen || state.currentTurn !== 0) return;
    if (state.tricksterMarkedId) {
      // Toggle off
      state.tricksterMarkedId = null;
      log('Trickster: mark cleared.');
      render();
      return;
    }
    // Show a picker: list each hand card; click to mark.
    let modal = document.getElementById('betaTricksterModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'betaTricksterModal';
      modal.className = 'fixed inset-0 bg-black/80 backdrop-blur z-50 flex items-center justify-center p-4';
      modal.innerHTML =
        '<div class="bg-slate-800 border-2 border-fuchsia-400 p-6 rounded-2xl shadow-2xl max-w-lg w-full">' +
          '<h3 class="text-xl font-bold mb-1 text-center">\ud83c\udfb4 Trickster</h3>' +
          '<p class="text-xs text-emerald-200 mb-3 text-center">Pick a hand card to mark as +/-1 wildcard for this round.</p>' +
          '<div id="betaTricksterCards" class="flex flex-wrap gap-2 justify-center mb-4"></div>' +
          '<div class="text-center"><button id="betaTricksterCancel" class="bg-white/10 hover:bg-white/20 px-4 py-2 rounded-lg text-sm">Cancel</button></div>' +
        '</div>';
      document.body.appendChild(modal);
      modal.querySelector('#betaTricksterCancel').addEventListener('click', () => modal.classList.add('hidden'));
    }
    const cardsDiv = modal.querySelector('#betaTricksterCards');
    cardsDiv.innerHTML = '';
    const order = ['A', 'K', 'Q', '10', 'J'];
    const sorted = state.hands[0].slice().sort((a, b) => {
      const ai = order.indexOf(a.rank), bi = order.indexOf(b.rank);
      if (ai !== bi) return ai - bi;
      return a.id.localeCompare(b.id);
    });
    for (const c of sorted) {
      const btn = document.createElement('button');
      let cls = 'card card-face flex items-center justify-center text-2xl font-bold text-black rounded cursor-pointer hover:scale-105 transition';
      const ring = affixRingClass(c.affix);
      if (ring) cls += ' ' + ring;
      else if (c.owner === 0) cls += ' ring-2 ring-emerald-400';
      btn.className = cls;
      btn.textContent = c.rank;
      const cid = c.id;
      btn.addEventListener('click', () => {
        state.tricksterMarkedId = cid;
        state.tricksterUsedThisRound = true;
        log('Trickster: marked a ' + c.rank + ' as +/-1 wildcard.');
        modal.classList.add('hidden');
        render();
      });
      cardsDiv.appendChild(btn);
    }
    modal.classList.remove('hidden');
  }

  // Doppelganger: arm/cancel the next-play mimic. Requires a previous play.
  function onDoppelgangerClick() {
    if (!hasJoker('doppelganger')) return;
    if (state.doppelUsedThisRound) return;
    if (state.gameOver || state.challengeOpen || state.currentTurn !== 0) return;
    if (!state.lastPlay) {
      log('Doppelganger: no previous play to copy yet.');
      return;
    }
    state.doppelArmed = !state.doppelArmed;
    log(state.doppelArmed
      ? 'Doppelganger armed: your next play will mirror the previous (' + state.lastPlay.count + ' x ' + state.lastPlay.claim + ').'
      : 'Doppelganger cancelled.');
    render();
  }

  // Saboteur: pick a target opponent, then dump a random card from your hand
  // (Jacks ~30% more likely) into their hand. Once per floor.
  function onSaboteurClick() {
    if (!hasJoker('saboteur')) return;
    if (!runState || runState.saboteurUsedThisFloor) return;
    if (state.gameOver || state.challengeOpen || state.currentTurn !== 0) return;
    if (state.hands[0].length === 0) return;
    let modal = document.getElementById('betaSaboteurModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'betaSaboteurModal';
      modal.className = 'fixed inset-0 bg-black/80 backdrop-blur z-50 flex items-center justify-center p-4';
      modal.innerHTML =
        '<div class="bg-slate-800 border-2 border-orange-400 p-6 rounded-2xl shadow-2xl max-w-lg w-full">' +
          '<h3 class="text-xl font-bold mb-1 text-center">\u2620 Saboteur</h3>' +
          '<p class="text-xs text-emerald-200 mb-3 text-center">Pick a target — they\'ll get a random card from your hand. Jacks are weighted heavily.</p>' +
          '<div id="betaSaboteurTargets" class="flex flex-wrap gap-2 justify-center mb-4"></div>' +
          '<div class="text-center"><button id="betaSaboteurCancel" class="bg-white/10 hover:bg-white/20 px-4 py-2 rounded-lg text-sm">Cancel</button></div>' +
        '</div>';
      document.body.appendChild(modal);
      modal.querySelector('#betaSaboteurCancel').addEventListener('click', () => modal.classList.add('hidden'));
    }
    const list = modal.querySelector('#betaSaboteurTargets');
    list.innerHTML = '';
    let any = 0;
    for (let i = 1; i < NUM_PLAYERS; i++) {
      if (state.eliminated[i] || state.finished[i]) continue;
      any++;
      const btn = document.createElement('button');
      btn.className = 'bg-orange-700 hover:bg-orange-600 transition px-4 py-3 rounded font-bold';
      btn.textContent = playerLabel(i) + ' (' + state.hands[i].length + ' cards)';
      const tgt = i;
      btn.addEventListener('click', () => {
        // Weighted random: each card weight 1; Jacks weight 1.30 (~30% more).
        const hand = state.hands[0];
        const weights = hand.map(c => c.rank === 'J' ? 1.30 : 1);
        const total = weights.reduce((a, b) => a + b, 0);
        let r = Math.random() * total;
        let picked = 0;
        for (let k = 0; k < hand.length; k++) {
          r -= weights[k];
          if (r <= 0) { picked = k; break; }
        }
        const card = hand.splice(picked, 1)[0];
        state.hands[tgt].push(card);
        runState.saboteurUsedThisFloor = true;
        log('Saboteur: ' + card.rank + (card.affix ? ' [' + card.affix + ']' : '') +
            ' pushed into ' + playerLabel(tgt) + '\'s hand.');
        modal.classList.add('hidden');
        if (checkJackCurse(tgt)) return;
        render();
      });
      list.appendChild(btn);
    }
    if (any === 0) {
      list.innerHTML = '<p class="text-rose-300 text-sm">No valid targets.</p>';
    }
    modal.classList.remove('hidden');
  }

  // Magician character — pick a hand card and choose a new rank for it.
  function onMagicianClick() {
    if (!runState || !runState.character || !runState.character.transformPerRound) return;
    if (state.magicianUsedThisRound) return;
    if (state.gameOver || state.challengeOpen || state.currentTurn !== 0) return;
    if (state.hands[0].length === 0) return;
    let modal = document.getElementById('betaMagicianModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'betaMagicianModal';
      modal.className = 'fixed inset-0 bg-black/80 backdrop-blur z-50 flex items-center justify-center p-4';
      document.body.appendChild(modal);
    }
    modal.innerHTML =
      '<div class="bg-slate-800 border-2 border-fuchsia-400 p-6 rounded-2xl shadow-2xl max-w-lg w-full">' +
        '<h3 class="text-xl font-bold mb-1 text-center">\u2728 Transmute</h3>' +
        '<p class="text-xs text-emerald-200 mb-3 text-center">Pick a hand card. Affix is wiped, rank changes.</p>' +
        '<div id="magCards" class="flex flex-wrap gap-2 justify-center mb-4"></div>' +
        '<div id="magRanks" class="hidden text-center mb-2"></div>' +
        '<div class="text-center"><button id="magCancel" class="bg-white/10 hover:bg-white/20 px-4 py-2 rounded-lg text-sm">Cancel</button></div>' +
      '</div>';
    const cardsDiv = modal.querySelector('#magCards');
    const ranksDiv = modal.querySelector('#magRanks');
    cardsDiv.innerHTML = '';
    const order = ['A','K','Q','10','J'];
    const sorted = state.hands[0].slice().sort((a, b) => {
      const ai = order.indexOf(a.rank), bi = order.indexOf(b.rank);
      if (ai !== bi) return ai - bi;
      return a.id.localeCompare(b.id);
    });
    for (const c of sorted) {
      const btn = document.createElement('button');
      let cls = 'card card-face flex items-center justify-center text-2xl font-bold text-black rounded cursor-pointer hover:scale-105 transition';
      const ring = affixRingClass(c.affix);
      if (ring) cls += ' ' + ring;
      else if (c.owner === 0) cls += ' ring-2 ring-emerald-400';
      btn.className = cls;
      btn.textContent = c.rank;
      const cid = c.id;
      btn.addEventListener('click', () => {
        cardsDiv.classList.add('hidden');
        ranksDiv.classList.remove('hidden');
        ranksDiv.innerHTML = '<p class="text-xs text-fuchsia-200 mb-2">Pick the new rank for that card:</p>';
        const rwrap = document.createElement('div');
        rwrap.className = 'flex flex-wrap gap-2 justify-center';
        for (const r of ['A','K','Q','10','J']) {
          const rb = document.createElement('button');
          rb.className = 'card card-face flex items-center justify-center text-2xl font-bold text-black rounded cursor-pointer hover:scale-105 transition';
          rb.textContent = r;
          rb.addEventListener('click', () => {
            const card = state.hands[0].find(x => x.id === cid);
            if (!card) { modal.classList.add('hidden'); return; }
            const oldRank = card.rank, oldAffix = card.affix;
            card.rank = r;
            card.affix = null;
            state.magicianUsedThisRound = true;
            log('Transmute: ' + oldRank + (oldAffix ? '['+oldAffix+']' : '') + ' -> ' + r + ' (affix wiped).');
            modal.classList.add('hidden');
            if (checkJackCurse(0)) return;
            render();
          });
          rwrap.appendChild(rb);
        }
        ranksDiv.appendChild(rwrap);
      });
      cardsDiv.appendChild(btn);
    }
    modal.querySelector('#magCancel').addEventListener('click', () => modal.classList.add('hidden'));
    modal.classList.remove('hidden');
  }

  // The Alchemist joker — pick a hand card, transform it into a different
  // card with a random positive affix. Works on any rank/affix, including
  // Steel cards (this joker bypasses the usual Steel-immunity).
  function onAlchemistClick() {
    if (!hasJoker('alchemist')) return;
    if (state.alchemistUsedThisRound) return;
    if (state.gameOver || state.challengeOpen || state.currentTurn !== 0) return;
    if (state.hands[0].length === 0) return;
    let modal = document.getElementById('betaAlchemistModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'betaAlchemistModal';
      modal.className = 'fixed inset-0 bg-black/80 backdrop-blur z-50 flex items-center justify-center p-4';
      document.body.appendChild(modal);
    }
    modal.innerHTML =
      '<div class="bg-slate-800 border-2 border-pink-400 p-6 rounded-2xl shadow-2xl max-w-lg w-full">' +
        '<h3 class="text-xl font-bold mb-1 text-center">\u2697 Alchemy</h3>' +
        '<p class="text-xs text-emerald-200 mb-3 text-center">Pick a hand card. It becomes a different card with a random positive affix (Gilded / Mirage / Echo / Hollow).</p>' +
        '<div id="alchCards" class="flex flex-wrap gap-2 justify-center mb-4"></div>' +
        '<div class="text-center"><button id="alchCancel" class="bg-white/10 hover:bg-white/20 px-4 py-2 rounded-lg text-sm">Cancel</button></div>' +
      '</div>';
    const cardsDiv = modal.querySelector('#alchCards');
    cardsDiv.innerHTML = '';
    const order = ['A','K','Q','10','J'];
    const sorted = state.hands[0].slice().sort((a, b) => {
      const ai = order.indexOf(a.rank), bi = order.indexOf(b.rank);
      if (ai !== bi) return ai - bi;
      return a.id.localeCompare(b.id);
    });
    const POSITIVE_AFFIXES = ['gilded', 'mirage', 'echo', 'hollow'];
    const RANKS_NON_J = ['A', 'K', 'Q', '10'];
    for (const c of sorted) {
      const btn = document.createElement('button');
      let cls = 'card card-face flex items-center justify-center text-2xl font-bold text-black rounded cursor-pointer hover:scale-105 transition';
      const ring = affixRingClass(c.affix);
      if (ring) cls += ' ' + ring;
      else if (c.owner === 0) cls += ' ring-2 ring-emerald-400';
      btn.className = cls;
      btn.textContent = c.rank;
      const cid = c.id;
      btn.addEventListener('click', () => {
        const card = state.hands[0].find(x => x.id === cid);
        if (!card) { modal.classList.add('hidden'); return; }
        // Pick a random rank (non-Jack) different from current.
        const rankCandidates = RANKS_NON_J.filter(r => r !== card.rank);
        let newRank = rankCandidates[Math.floor(Math.random() * rankCandidates.length)];
        // Pick a random positive affix.
        let newAffix = POSITIVE_AFFIXES[Math.floor(Math.random() * POSITIVE_AFFIXES.length)];
        // Ensure overall signature differs from current. (If by chance they
        // match, reroll the affix once — different rank already guarantees
        // difference, but keep this guard for safety.)
        if (newRank === card.rank && newAffix === card.affix) {
          newAffix = POSITIVE_AFFIXES[(POSITIVE_AFFIXES.indexOf(newAffix) + 1) % POSITIVE_AFFIXES.length];
        }
        const oldRank = card.rank, oldAffix = card.affix || null;
        card.rank = newRank;
        card.affix = newAffix;
        // Reset Mirage use counter if the new affix is Mirage.
        if (newAffix === 'mirage') card.mirageUses = 0;
        state.alchemistUsedThisRound = true;
        log('Alchemy: ' + oldRank + (oldAffix ? '['+oldAffix+']' : '') +
            ' -> ' + newRank + ' [' + newAffix + ']');
        modal.classList.add('hidden');
        if (checkJackCurse(0)) return;
        render();
      });
      cardsDiv.appendChild(btn);
    }
    modal.querySelector('#alchCancel').addEventListener('click', () => modal.classList.add('hidden'));
    modal.classList.remove('hidden');
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

  // Private-peek toast — used by Cold Read, Hand Mirror, Bait, Surveyor reads,
  // Eavesdropper, Echo. Stays visible for ~6s, click to dismiss. Distinct from
  // the public round log so the same code path can later go to the player's
  // private feed in PvP without leaking to all players.
  function privatePeek(msg) {
    let toast = document.getElementById('betaPrivatePeek');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'betaPrivatePeek';
      toast.className = 'fixed bottom-4 right-4 max-w-xs bg-cyan-900/95 border border-cyan-300 text-cyan-50 text-sm rounded-lg shadow-2xl p-3 z-50 hidden';
      toast.style.cursor = 'pointer';
      toast.addEventListener('click', () => { toast.classList.add('hidden'); });
      document.body.appendChild(toast);
      toast._lines = [];
      toast._timer = null;
    }
    toast._lines = (toast._lines || []).slice(-3);  // keep last 3 messages
    toast._lines.push(msg);
    toast.innerHTML = '<div class="text-xs uppercase tracking-widest text-cyan-200 font-bold mb-1">&#128064; Private read</div>' +
      toast._lines.map(l => '<div class="mb-1">' + escapeHtml(l) + '</div>').join('') +
      '<div class="text-[10px] text-cyan-200/70 mt-1">click to dismiss</div>';
    toast.classList.remove('hidden');
    if (toast._timer) clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.classList.add('hidden'); toast._lines = []; }, 6000);
    // Also append to the round log for posterity.
    log(msg);
  }

  function revealCards(cards) {
    const reveal = document.getElementById('betaReveal');
    const sticky = !!(runState && runState.currentFloorModifier === 'sticky');
    if (!sticky) reveal.innerHTML = '';
    // Mirror Shard: if armed and the play being revealed is the human's, the
    // reveal shows card BACKS only (the result still stands). Consumed on use.
    const lp = state.lastPlay;
    const blind = state.mirrorShardArmed && lp && lp.playerIdx === 0;
    if (blind) {
      state.mirrorShardArmed = false;
      log('Mirror Shard: reveal hidden from the table.');
    }
    for (const c of cards) {
      const div = document.createElement('div');
      const isMatch = c.rank === c.claim || c.affix === 'mirage';
      if (blind) {
        div.className = 'card card-back rounded';
      } else {
        div.className = 'card card-face flex items-center justify-center text-2xl font-bold text-black rounded' +
                        (isMatch ? ' ring-2 ring-emerald-400' : ' ring-2 ring-red-500');
        div.textContent = c.rank;
        if (c.affix) div.title = 'Affix: ' + c.affix;
      }
      reveal.appendChild(div);
    }
    if (!sticky) {
      revealTimer = setTimeout(() => { reveal.innerHTML = ''; }, REVEAL_HOLD_MS);
    }
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

  // Open a detail modal for a character — shows flavor, passive, and the
  // full starting-joker description. Includes a Pick button that calls
  // selectCharacter to actually start the run.
  function _showCharacterDetailSP(charId) {
    const char = CHARACTER_CATALOG[charId];
    if (!char) return;
    let modal = document.getElementById('betaSpCharDetailModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'betaSpCharDetailModal';
      modal.className = 'fixed inset-0 bg-black/85 backdrop-blur z-50 flex items-center justify-center p-4';
      document.body.appendChild(modal);
      modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
    }
    const RARITY_TONE = {
      Common: 'bg-gray-700 text-gray-100',
      Uncommon: 'bg-emerald-700 text-emerald-100',
      Rare: 'bg-blue-700 text-blue-100',
      Legendary: 'bg-amber-700 text-amber-100',
    };
    const jokerInfo = (char.startingJoker && JOKER_CATALOG[char.startingJoker]) || null;
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
      '<div class="bg-slate-800 border-2 border-emerald-400 p-6 rounded-2xl shadow-2xl max-w-md w-full">' +
        '<div class="flex items-start justify-between mb-2">' +
          '<h3 class="text-2xl font-extrabold">' + escapeHtml(char.name) + '</h3>' +
          '<button id="betaSpCharDetailClose" class="bg-white/10 hover:bg-white/20 px-3 py-1 rounded-lg text-sm">Close</button>' +
        '</div>' +
        (char.flavor ? '<div class="text-xs italic text-white/60 mb-3">' + escapeHtml(char.flavor) + '</div>' : '') +
        '<div class="text-sm text-emerald-200 mb-4">' + escapeHtml(char.passive || '') + '</div>' +
        jokerSection +
        '<div class="flex gap-2 mt-4">' +
          '<button id="betaSpCharDetailPick" class="flex-1 bg-yellow-500 hover:bg-yellow-400 text-black font-bold px-4 py-2 rounded-lg transition">Pick ' + escapeHtml(char.name) + '</button>' +
        '</div>' +
      '</div>';
    modal.querySelector('#betaSpCharDetailClose').addEventListener('click', () => modal.classList.add('hidden'));
    modal.querySelector('#betaSpCharDetailPick').addEventListener('click', () => {
      modal.classList.add('hidden');
      selectCharacter(charId);
    });
    modal.classList.remove('hidden');
  }

  // Build the character grid dynamically based on unlock state.
  function renderCharSelect() {
    const grid = document.getElementById('betaCharGrid');
    if (!grid) return;
    grid.innerHTML = '';
    const isGuest = !getAuthToken();
    // Show / refresh a guest banner above the grid prompting sign-in.
    let banner = document.getElementById('betaCharGuestBanner');
    if (isGuest) {
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'betaCharGuestBanner';
        banner.className = 'mb-4 px-4 py-3 rounded-xl border border-yellow-400/60 bg-yellow-900/30 text-sm text-yellow-100 text-center';
        grid.parentNode.insertBefore(banner, grid);
      }
      banner.innerHTML =
        '<b>Playing as guest.</b> Only <span class="text-yellow-300 font-bold">The Rookie</span> is available. ' +
        'Sign in to unlock the other characters as you reach new floors and beat bosses — your progress is saved across runs.';
    } else if (banner) {
      banner.remove();
    }
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
        const isGuest = !getAuthToken();
        const lockText = isGuest
          ? 'Sign in to start unlocking — then ' + (char.unlockHint || 'keep playing.')
          : (char.unlockHint || 'Keep playing.');
        inner += '<div class="text-xs text-rose-300">Locked &mdash; ' + escapeHtml(lockText) + '</div>';
      }
      btn.innerHTML = inner;

      if (unlocked) {
        const cid = char.id;
        btn.addEventListener('click', () => _showCharacterDetailSP(cid));
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
    const cl = document.getElementById('betaCleanse');
    if (cl) cl.classList.add('hidden');
  }

  // Cleanse fork node — replaces Event on floors 2, 5, 8 per the design path.
  // Lets the player either remove a Cursed run-deck card permanently, OR
  // strip one affix from an affixed run-deck card.
  function isCleanseFloor() {
    const f = runState ? runState.currentFloor : 0;
    return f === 2 || f === 5 || f === 8;
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
          '<div class="text-sm opacity-80">Take 75g / Gilded upgrade / pick a joker.</div>';
        rewardBtn.className = 'bg-emerald-700 hover:bg-emerald-600 p-6 rounded-xl text-left transition';
      }
    }

    // Swap Event for Cleanse on floors 2, 5, 8 to match the design path.
    const eventBtn = document.getElementById('betaForkEventBtn');
    if (eventBtn) {
      // Replace the node so we can re-attach a clean click handler each visit.
      const fresh = eventBtn.cloneNode(false);
      fresh.id = 'betaForkEventBtn';
      eventBtn.parentNode.replaceChild(fresh, eventBtn);
      if (isCleanseFloor()) {
        fresh.innerHTML = '<div class="text-2xl font-bold mb-1">&#10024; Cleanse</div>' +
          '<div class="text-sm opacity-80">Strip an affix or remove a Cursed card from your run deck.</div>';
        fresh.className = 'bg-cyan-700 hover:bg-cyan-600 p-6 rounded-xl text-left transition';
        fresh.addEventListener('click', chooseCleanse);
      } else {
        fresh.innerHTML = '<div class="text-2xl font-bold mb-1">&#10067; Event</div>' +
          '<div class="text-sm opacity-80">A random encounter. Risk and reward.</div>';
        fresh.className = 'bg-purple-700 hover:bg-purple-600 p-6 rounded-xl text-left transition';
        fresh.addEventListener('click', chooseEvent);
      }
    }
    document.getElementById('betaFork').classList.remove('hidden');
  }

  // Cleanse panel — built dynamically so we don't need new index.html markup.
  function ensureCleansePanel() {
    let panel = document.getElementById('betaCleanse');
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'betaCleanse';
    panel.className = 'hidden max-w-md mx-auto pt-2 pb-10 text-center';
    panel.innerHTML =
      '<h2 class="text-3xl font-bold mb-4">&#10024; Cleanse</h2>' +
      '<p class="text-emerald-200 mb-4">A quiet moment. Mend the run deck — pick what you want to undo.</p>' +
      '<div id="betaCleanseOptions" class="space-y-3"></div>' +
      '<div id="betaCleansePicker" class="hidden mt-4">' +
        '<p id="betaCleansePickerTitle" class="text-emerald-200 mb-3"></p>' +
        '<div id="betaCleansePickerCards" class="flex flex-wrap gap-2 justify-center mb-3"></div>' +
        '<button id="betaCleansePickerCancel" class="bg-white/10 hover:bg-white/20 transition px-4 py-1 rounded text-sm">Back</button>' +
      '</div>' +
      '<div id="betaCleanseConfirm" class="hidden mt-4">' +
        '<p id="betaCleanseConfirmText" class="text-2xl font-bold text-cyan-300 my-6"></p>' +
        '<button id="betaCleanseContinueBtn" class="w-full bg-blue-600 hover:bg-blue-700 transition px-6 py-3 rounded-lg font-bold">Continue to Floor <span id="betaCleanseNextFloor">2</span></button>' +
      '</div>';
    // Insert next to the existing fork-related panels in the beta layout.
    const beta = document.getElementById('betaTesting');
    if (beta) beta.appendChild(panel);
    else document.body.appendChild(panel);
    panel.querySelector('#betaCleansePickerCancel').addEventListener('click', () => {
      panel.querySelector('#betaCleansePicker').classList.add('hidden');
      panel.querySelector('#betaCleanseOptions').classList.remove('hidden');
    });
    panel.querySelector('#betaCleanseContinueBtn').addEventListener('click', continueAfterFork);
    return panel;
  }

  function chooseCleanse() {
    hideAllPanels();
    const panel = ensureCleansePanel();
    panel.querySelector('#betaCleanseNextFloor').textContent = runState.currentFloor;
    panel.querySelector('#betaCleanseConfirm').classList.add('hidden');
    panel.querySelector('#betaCleansePicker').classList.add('hidden');
    const options = panel.querySelector('#betaCleanseOptions');
    options.classList.remove('hidden');
    options.innerHTML = '';

    const cursedInDeck = (runState.runDeck || []).filter(c => c.affix === 'cursed');
    const affixedInDeck = (runState.runDeck || []).filter(c => c.affix);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'w-full bg-rose-700 hover:bg-rose-600 transition p-4 rounded-xl text-left disabled:opacity-40 disabled:cursor-not-allowed';
    removeBtn.disabled = cursedInDeck.length === 0;
    removeBtn.innerHTML =
      '<div class="text-xl font-bold">&#128163; Remove a Cursed card</div>' +
      '<div class="text-sm opacity-80">Permanently strip a Cursed card from your run deck. (' +
      cursedInDeck.length + ' Cursed in deck)</div>';
    removeBtn.addEventListener('click', () => startCleansePick('removeCursed', cursedInDeck));
    options.appendChild(removeBtn);

    const stripBtn = document.createElement('button');
    stripBtn.className = 'w-full bg-cyan-700 hover:bg-cyan-600 transition p-4 rounded-xl text-left disabled:opacity-40 disabled:cursor-not-allowed';
    stripBtn.disabled = affixedInDeck.length === 0;
    stripBtn.innerHTML =
      '<div class="text-xl font-bold">&#10024; Strip an affix</div>' +
      '<div class="text-sm opacity-80">Remove the affix from one run-deck card (rank stays). (' +
      affixedInDeck.length + ' affixed in deck)</div>';
    stripBtn.addEventListener('click', () => startCleansePick('stripAffix', affixedInDeck));
    options.appendChild(stripBtn);

    if (cursedInDeck.length === 0 && affixedInDeck.length === 0) {
      const note = document.createElement('p');
      note.className = 'text-rose-300 text-sm mt-3';
      note.textContent = 'Nothing to cleanse — your run deck is already pristine.';
      options.appendChild(note);
      const skip = document.createElement('button');
      skip.className = 'mt-3 w-full bg-blue-600 hover:bg-blue-700 transition px-6 py-3 rounded-lg font-bold';
      skip.textContent = 'Continue to Floor ' + runState.currentFloor;
      skip.addEventListener('click', continueAfterFork);
      options.appendChild(skip);
    }

    panel.classList.remove('hidden');
  }

  function startCleansePick(mode, cards) {
    const panel = document.getElementById('betaCleanse');
    panel.querySelector('#betaCleanseOptions').classList.add('hidden');
    const picker = panel.querySelector('#betaCleansePicker');
    picker.classList.remove('hidden');
    panel.querySelector('#betaCleansePickerTitle').textContent =
      mode === 'removeCursed'
        ? 'Pick a Cursed card to remove (permanent)'
        : 'Pick an affixed card to strip (affix removed, rank kept)';
    const list = panel.querySelector('#betaCleansePickerCards');
    list.innerHTML = '';
    for (const c of cards) {
      const btn = document.createElement('button');
      let cls = 'card card-face flex items-center justify-center text-2xl font-bold text-black rounded cursor-pointer hover:scale-105 transition';
      const ring = affixRingClass(c.affix);
      if (ring) cls += ' ' + ring;
      btn.className = cls;
      btn.textContent = c.rank;
      btn.title = 'Affix: ' + (c.affix || '—');
      const id = c.id;
      btn.addEventListener('click', () => applyCleansePick(mode, id));
      list.appendChild(btn);
    }
  }

  function applyCleansePick(mode, cardId) {
    if (!runState || !runState.runDeck) return;
    const idx = runState.runDeck.findIndex(c => c.id === cardId);
    if (idx < 0) return;
    let msg = '';
    if (mode === 'removeCursed') {
      const removed = runState.runDeck.splice(idx, 1)[0];
      msg = 'Removed Cursed ' + removed.rank + ' from your run deck.';
    } else {
      const card = runState.runDeck[idx];
      const old = card.affix;
      card.affix = null;
      msg = 'Stripped ' + (old || 'affix') + ' from ' + card.rank + '.';
    }
    log('Cleanse: ' + msg);
    const panel = document.getElementById('betaCleanse');
    panel.querySelector('#betaCleansePicker').classList.add('hidden');
    const confirm = panel.querySelector('#betaCleanseConfirm');
    confirm.classList.remove('hidden');
    panel.querySelector('#betaCleanseConfirmText').textContent = msg;
  }

  // Phase 8+: rotating shop offer — pick a small subset each shop visit
  const SHOP_RARITY_WEIGHTS = { Common: 60, Uncommon: 25, Rare: 10, Legendary: 5 };
  const SHOP_OFFER_CONSUMABLES_BASE = 3;
  const SHOP_OFFER_JOKERS_BASE = 3;
  const SHOP_OFFER_CARDS_BASE = 3;
  const SHOP_OFFER_RELICS = 2;
  function shopOfferCounts() {
    const bonus = hasRelic('mogul') ? 1 : 0;
    return {
      consumables: SHOP_OFFER_CONSUMABLES_BASE + bonus,
      jokers: SHOP_OFFER_JOKERS_BASE + bonus,
      cards: SHOP_OFFER_CARDS_BASE + bonus,
    };
  }

  function regenerateShopOffer() {
    if (!runState) return;
    // Consumables/services pool — anything not a joker or relic
    const consumablesPool = SHOP_ITEMS.filter(i => i.type !== 'joker' && i.type !== 'relic');
    const counts = shopOfferCounts();
    const pickedConsumables = shuffle(consumablesPool).slice(0, counts.consumables);

    // Jokers — rarity-weighted, skip already-equipped
    const ownedJokerIds = (runState.jokers || []).filter(j => j).map(j => j.id);
    const jokerPool = SHOP_ITEMS.filter(i => i.type === 'joker' && !ownedJokerIds.includes(i.id));
    const pickedJokers = [];
    const remaining = jokerPool.slice();
    while (pickedJokers.length < counts.jokers && remaining.length > 0) {
      let totalWeight = 0;
      for (const j of remaining) {
        const cat = JOKER_CATALOG[j.id];
        const rarity = cat ? cat.rarity : 'Common';
        totalWeight += (SHOP_RARITY_WEIGHTS[rarity] || 1);
      }
      let r = Math.random() * totalWeight;
      let pickedIdx = 0;
      for (let i = 0; i < remaining.length; i++) {
        const cat = JOKER_CATALOG[remaining[i].id];
        const rarity = cat ? cat.rarity : 'Common';
        r -= (SHOP_RARITY_WEIGHTS[rarity] || 1);
        if (r <= 0) { pickedIdx = i; break; }
      }
      pickedJokers.push(remaining[pickedIdx]);
      remaining.splice(pickedIdx, 1);
    }

    // Relics removed from the regular shop — awarded post-boss only.
    runState.shopOffer = [].concat(pickedConsumables, pickedJokers);

    // Cards section — 3 randomly-rolled run-deck cards per shop visit.
    // 50% chance of a positive-or-neutral affix; never Cursed.
    const SHOP_CARD_AFFIXES = ['gilded', 'mirage', 'echo', 'hollow', 'glass', 'steel', 'spiked'];
    const SHOP_CARD_RANKS = ['A', 'K', 'Q', '10'];
    const SHOP_CARD_PRICE = 100;
    runState.shopCardOffer = [];
    for (let i = 0; i < counts.cards; i++) {
      const rank = SHOP_CARD_RANKS[Math.floor(Math.random() * SHOP_CARD_RANKS.length)];
      const hasAffix = Math.random() < 0.5;
      const affix = hasAffix ? SHOP_CARD_AFFIXES[Math.floor(Math.random() * SHOP_CARD_AFFIXES.length)] : null;
      runState.shopCardOffer.push({
        offerId: 'shopcard_' + Date.now() + '_' + i + '_' + Math.floor(Math.random() * 10000),
        rank: rank,
        affix: affix,
        price: SHOP_CARD_PRICE,
        bought: false,
      });
    }
  }

  function chooseShop() {
    hideAllPanels();
    regenerateShopOffer();  // fresh rotation each visit
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
    const jokerPicker = document.getElementById('betaRewardJokerPicker');
    if (jokerPicker) jokerPicker.classList.add('hidden');
    document.getElementById('betaRewardNextFloor').textContent = runState.currentFloor;

    // Add a "pick 1 of 2 jokers" button into the reward options if not present.
    ensureRewardJokerButton();
    document.getElementById('betaReward').classList.remove('hidden');
  }

  function ensureRewardJokerButton() {
    const options = document.getElementById('betaRewardOptions');
    if (!options) return;
    let btn = document.getElementById('betaRewardJokerBtn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'betaRewardJokerBtn';
      btn.className = 'w-full bg-purple-700 hover:bg-purple-600 transition p-4 rounded-xl text-left disabled:opacity-40 disabled:cursor-not-allowed';
      btn.innerHTML = '<div class="text-xl font-bold">&#127183; Pick 1 of 2 random jokers</div>' +
                      '<div class="text-sm opacity-80">Reroll-weighted by rarity. Free.</div>';
      btn.addEventListener('click', startRewardJokerPick);
      options.appendChild(btn);
    }
    // Disable + relabel if all joker slots are full
    const slotsFull = (runState.jokers || []).every(j => j !== null);
    btn.disabled = slotsFull;
    if (slotsFull) {
      btn.querySelector('.opacity-80').textContent = 'All joker slots are full.';
    } else {
      btn.querySelector('.opacity-80').textContent = 'Reroll-weighted by rarity. Free.';
    }
  }

  function startRewardJokerPick() {
    if ((runState.jokers || []).every(j => j !== null)) return;
    document.getElementById('betaRewardOptions').classList.add('hidden');

    // Use a dedicated picker wrapper (created on demand) so we don't clobber
    // the gilded-upgrade picker's original markup.
    let wrap = document.getElementById('betaRewardJokerPicker');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'betaRewardJokerPicker';
      const reward = document.getElementById('betaReward');
      const confirm = document.getElementById('betaRewardConfirm');
      if (reward && confirm) reward.insertBefore(wrap, confirm);
      else if (reward) reward.appendChild(wrap);
    }
    wrap.innerHTML = '';
    wrap.className = '';
    const title = document.createElement('p');
    title.className = 'text-emerald-200 mb-3';
    title.textContent = 'Pick a joker to equip:';
    wrap.appendChild(title);

    // 2 random unowned jokers, rarity-weighted
    const ownedJokerIds = (runState.jokers || []).filter(j => j).map(j => j.id);
    const pool = Object.keys(JOKER_CATALOG).filter(id => !ownedJokerIds.includes(id));
    const weights = { Common: 60, Uncommon: 25, Rare: 10, Legendary: 5 };
    const offers = [];
    const remaining = pool.slice();
    while (offers.length < 2 && remaining.length > 0) {
      let total = 0;
      for (const id of remaining) total += (weights[JOKER_CATALOG[id].rarity] || 1);
      let r = Math.random() * total;
      let pickedIdx = 0;
      for (let i = 0; i < remaining.length; i++) {
        r -= (weights[JOKER_CATALOG[remaining[i]].rarity] || 1);
        if (r <= 0) { pickedIdx = i; break; }
      }
      offers.push(remaining[pickedIdx]);
      remaining.splice(pickedIdx, 1);
    }

    const list = document.createElement('div');
    list.className = 'space-y-2';
    if (offers.length === 0) {
      list.innerHTML = '<p class="text-rose-300 text-sm">No jokers left to offer.</p>';
    } else {
      for (const id of offers) {
        const j = JOKER_CATALOG[id];
        const opt = document.createElement('button');
        opt.className = 'w-full bg-purple-800 hover:bg-purple-700 transition p-4 rounded-xl text-left';
        opt.innerHTML =
          '<div class="text-lg font-bold mb-1">' + escapeHtml(j.name) + ' <span class="text-xs text-purple-200">[' + escapeHtml(j.rarity || '') + ']</span></div>' +
          '<div class="text-xs opacity-80">' + escapeHtml(j.desc) + '</div>';
        opt.addEventListener('click', () => {
          equipJoker({ ...j });
          if (id === 'tattletale') {
            runState.tattletaleChargesThisFloor = TATTLETALE_CHARGES_PER_FLOOR;
          }
          log('Reward: equipped joker ' + j.name + '.');
          wrap.classList.add('hidden');
          showRewardConfirm('Equipped ' + j.name + '.');
        });
        list.appendChild(opt);
      }
    }
    wrap.appendChild(list);
    const back = document.createElement('button');
    back.className = 'mt-3 bg-white/10 hover:bg-white/20 transition px-4 py-1 rounded text-sm';
    back.textContent = 'Back';
    back.addEventListener('click', () => {
      wrap.classList.add('hidden');
      document.getElementById('betaRewardOptions').classList.remove('hidden');
    });
    wrap.appendChild(back);
    wrap.classList.remove('hidden');
  }

  // Phase 8+: Treasure node — pick a free relic from 2 random unowned
  // relics in the TREASURE_POOL specifically. Boss-pool relics are kept out
  // so the post-boss relic picker stays meaningful (the design treats those
  // pools as separate fork rewards). If the treasure pool is exhausted (all
  // owned), fall back to other unowned relics so the player still gets
  // something for triggering the node.
  function chooseTreasure() {
    hideAllPanels();
    const owned = (runState.relics || []);
    const treasureUnowned = TREASURE_POOL.filter(id =>
      !owned.includes(id) && RELIC_CATALOG[id] && isRelicUnlocked(id)
    );
    let offers = shuffle(treasureUnowned).slice(0, Math.min(2, treasureUnowned.length));
    if (offers.length === 0) {
      // Defensive fallback: every treasure relic owned. Offer non-boss
      // unowned relics rather than blocking the node entirely.
      const allRelicIds = Object.keys(RELIC_CATALOG);
      const fallback = allRelicIds.filter(id => !owned.includes(id) && isRelicUnlocked(id));
      offers = shuffle(fallback).slice(0, Math.min(2, fallback.length));
    }

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

  function _buildShopRow(item) {
      const isJoker = item.type === 'joker';
      const isRelic = item.type === 'relic';
      const equipped = isJoker && hasJoker(item.id);
      const ownedRelic = isRelic && hasRelic(item.id);
      const slotsFull = isJoker && runState.jokers.every(j => j !== null);
      const owned = isJoker ? (equipped ? 1 : 0) :
                    isRelic ? (ownedRelic ? 1 : 0) :
                    (runState.inventory[item.id] || 0);
      // Forge Hand joker AND Engineer character: 25% off affix services.
      // Engineer's discount applies to a wider pool (also Mirage Lens) per design.
      const FORGE_HAND_IDS = ['glassShard', 'spikedWire', 'steelPlating'];
      const ENGINEER_IDS = ['glassShard', 'spikedWire', 'steelPlating', 'mirageLens'];
      const engOn = !!(runState.character && runState.character.affixDiscount);
      const isAffixSvc = engOn ? ENGINEER_IDS.includes(item.id) : false;
      const richFolkOn = !!(runState && runState.currentFloorModifier === 'richFolk');
      const mogulOn = hasRelic('mogul');
      // Stack: prefer the bigger discount available.
      let baseDisc = 0;
      if (hasJoker('forgeHand') && FORGE_HAND_IDS.includes(item.id)) baseDisc = Math.max(baseDisc, 0.25);
      if (engOn && isAffixSvc) baseDisc = Math.max(baseDisc, runState.character.affixDiscount || 0);
      if (richFolkOn && item.type === 'joker') baseDisc = Math.max(baseDisc, 0.50);
      if (mogulOn) baseDisc = Math.max(baseDisc, 0.10);  // The Mogul: 10% off everything in shop
      const forgeDiscount = baseDisc;
      // Mutate item.price so the rest of the buy flow uses the discounted price.
      if (forgeDiscount > 0 && !item._origPrice) {
        item._origPrice = item.price;
        item.price = Math.floor(item.price * (1 - forgeDiscount));
      } else if (forgeDiscount === 0 && item._origPrice) {
        item.price = item._origPrice;
        delete item._origPrice;
      }
      const canAfford = runState.gold >= item.price;
      // Floor-locked items per design: Forger, Jack-be-Nimble, and now
      // Counterfeit (bumped to once-per-floor when its price went 35g -> 50g).
      const FLOOR_LOCKED_IDS = ['forger', 'jackBeNimble', 'counterfeit', 'crookedDie'];
      const floorLocked = FLOOR_LOCKED_IDS.includes(item.id) &&
                          runState.floorLockedBoughtThisFloor &&
                          runState.floorLockedBoughtThisFloor[item.id];
      // Stackable jokers (e.g. Sixth Sense): "equipped" doesn't disable
      // re-buying, and they don't need a fresh slot — buying again bumps
      // the stack on the existing slot. Disabled only at maxStack.
      const _catalogJoker = isJoker ? (JOKER_CATALOG[item.id] || null) : null;
      const _stackable    = !!(_catalogJoker && _catalogJoker.stackable);
      const _maxStack     = (_catalogJoker && _catalogJoker.maxStack) || 1;
      const _curStack     = (isJoker && equipped) ? jokerStack(item.id) : 0;
      const _stackedFull  = isJoker && _stackable && equipped && _curStack >= _maxStack;
      const disabled = !item.enabled || !canAfford ||
                       (isJoker && !_stackable && (equipped || slotsFull)) ||
                       (isJoker &&  _stackable && (_stackedFull || (slotsFull && !equipped))) ||
                       (isRelic && ownedRelic) ||
                       floorLocked;
      const row = document.createElement('div');
      row.className = 'bg-black/40 hover:bg-black/50 transition p-3 rounded-xl border border-white/10' +
                       (item.enabled ? '' : ' opacity-60');
      let btnLabel = item.enabled ? 'Buy' : 'Soon';
      if (isJoker && _stackable && equipped) {
        btnLabel = _stackedFull ? ('Maxed (' + _curStack + '/' + _maxStack + ')')
                                : ('Stack ' + _curStack + '/' + _maxStack + ' — Buy');
      } else if (isJoker && equipped) {
        btnLabel = 'Equipped';
      } else if (isJoker && slotsFull && !equipped) {
        btnLabel = 'Slots full';
      } else if (isRelic && ownedRelic) {
        btnLabel = 'Owned';
      } else if (floorLocked) {
        btnLabel = 'Floor-locked';
      }
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
      const buyBtn = row.querySelector('button');
      if (!disabled) {
        buyBtn.addEventListener('click', () => {
          if (runState.gold < item.price) return;
          // Track floor-locked items at click-time so a second click is blocked.
          if (FLOOR_LOCKED_IDS.includes(item.id)) {
            runState.floorLockedBoughtThisFloor = runState.floorLockedBoughtThisFloor || {};
            runState.floorLockedBoughtThisFloor[item.id] = true;
          }
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
            else if (item.id === 'engraver') startEngraverApply(item);
          } else if (item.type === 'relic') {
            if (hasRelic(item.id)) return;
            runState.gold -= item.price;
            runState.relics = runState.relics || [];
            runState.relics.push(item.id);
            log('Acquired relic: ' + item.name + '. (-' + item.price + 'g)');
            renderShop();
          } else if (item.type === 'joker') {
            const data = JOKER_CATALOG[item.id];
            if (!data) return;
            const alreadyHave = hasJoker(item.id);
            // Stackable jokers: buying again while equipped bumps the stack
            // (no slot consumed). Block at maxStack.
            if (alreadyHave) {
              if (!data.stackable) return;
              const cur = jokerStack(item.id);
              const cap = data.maxStack || 1;
              if (cur >= cap) return;
              runState.gold -= item.price;
              equipJoker(data);
              log("Stacked joker: " + data.name + " (now " + (cur + 1) + "/" + cap + "). (-" + item.price + 'g)');
              renderShop();
              return;
            }
            // Fresh equip — needs an open slot.
            if (runState.jokers.every(j => j !== null)) {
              log('Both joker slots full. Cannot equip ' + item.name + '.');
              return;
            }
            runState.gold -= item.price;
            equipJoker(data);
            if (item.id === 'tattletale') {
              runState.tattletaleChargesThisFloor = TATTLETALE_CHARGES_PER_FLOOR;
            }
            log('Equipped joker: ' + data.name + '. (-' + item.price + 'g)');
            renderShop();
          } else {
            runState.gold -= item.price;
            runState.inventory[item.id] = owned + 1;
            if (runState.ach) runState.ach.spent = (runState.ach.spent || 0) + item.price;
            log('Bought ' + item.name + ' for ' + item.price + 'g (now ' + runState.gold + 'g).');
            renderShop();
          }
        });
      }
      return row;
  }

  function renderShop() {
    document.getElementById('betaShopGold').textContent = runState.gold;
    document.getElementById('betaShopNextFloor').textContent = runState.currentFloor;
    const offer = (runState && runState.shopOffer && runState.shopOffer.length > 0)
      ? runState.shopOffer
      : SHOP_ITEMS;
    const jokers = offer.filter(i => i.type === 'joker');
    const consumables = offer.filter(i => i.type !== 'joker' && i.type !== 'relic');

    const sections = [
      ['betaShopJokers', jokers, 'No jokers in stock.'],
      ['betaShopConsumables', consumables, 'No consumables in stock.'],
    ];
    for (const [id, items, emptyMsg] of sections) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.innerHTML = '';
      if (items.length === 0) {
        el.innerHTML = '<p class="text-xs text-white/40 italic">' + emptyMsg + '</p>';
        continue;
      }
      for (const item of items) {
        el.appendChild(_buildShopRow(item));
      }
    }

    // Cards section — fills the slot where Relics used to live.
    const cardsEl = document.getElementById('betaShopRelics');
    if (cardsEl) {
      // Repurpose the section's heading from "Relics" -> "Cards" if not done already.
      const sectionWrap = cardsEl.closest('.bg-black\\/30');
      if (sectionWrap) {
        const h = sectionWrap.querySelector('h3');
        if (h) {
          h.innerHTML = '\ud83c\udca0 Cards';
          h.className = 'text-xs uppercase tracking-widest text-blue-300 font-bold mb-2';
        }
        sectionWrap.className = sectionWrap.className.replace('border-pink-500/30', 'border-blue-500/30');
      }
      cardsEl.innerHTML = '';
      const offers = (runState.shopCardOffer || []);
      if (offers.length === 0) {
        cardsEl.innerHTML = '<p class="text-xs text-white/40 italic">No cards in stock.</p>';
      } else {
        for (const off of offers) cardsEl.appendChild(_buildShopCardRow(off));
      }
    }
  }

  // Build a shop row for a buyable run-deck card (replaces the old Relics
  // section). Up to 3 per shop visit; each card has 50% chance to come with
  // a positive-or-neutral affix. Adds the chosen card to the player's run deck.
  function _buildShopCardRow(off) {
    const row = document.createElement('div');
    const cap = (typeof runDeckCap === 'function') ? runDeckCap() : 24;
    const deckFull = (runState.runDeck || []).length >= cap;
    // Discount stack on run-deck card prices. Sources:
    //   - Mogul relic: 10% off
    //   - RANDOM.EXE character: 20% off (compensation for the affix
    //     reroll volatility — letting them buy more cards to soak variance)
    // We always recompute from _origPrice so the live price reflects the
    // current set of active discounts (e.g. picking up Mogul mid-run, or
    // re-rendering the shop after a buy).
    const mogulOn = hasRelic('mogul');
    const cardDisc = (runState.character && runState.character.cardDiscount) || 0;
    if (off._origPrice === undefined) off._origPrice = off.price;
    let mult = 1;
    if (mogulOn)        mult *= 0.90;
    if (cardDisc > 0)   mult *= (1 - cardDisc);
    off.price = Math.max(1, Math.floor(off._origPrice * mult));
    const canAfford = runState.gold >= off.price;
    const disabled = off.bought || !canAfford || deckFull;
    let btnLabel = off.bought ? 'Bought' : (deckFull ? 'Deck full' : 'Buy');
    const priceColor = canAfford ? 'bg-yellow-400 text-black' : 'bg-rose-500 text-white';
    row.className = 'bg-black/40 hover:bg-black/50 transition p-3 rounded-xl border border-white/10' +
                    (off.bought ? ' opacity-50' : '');
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
        '<div class="text-xs text-emerald-300">Run deck: ' + (runState.runDeck ? runState.runDeck.length : 0) + ' / ' + cap + '</div>' +
        '<div class="flex items-center gap-2">' +
          '<span class="' + priceColor + ' px-2 py-0.5 rounded-full text-xs font-bold">' + off.price + 'g</span>' +
          '<button class="bg-yellow-500 hover:bg-yellow-400 text-black transition px-3 py-1 rounded font-bold text-sm disabled:opacity-40 disabled:cursor-not-allowed"' + (disabled ? ' disabled' : '') + '>' + btnLabel + '</button>' +
        '</div>' +
      '</div>';
    if (!disabled) {
      row.querySelector('button').addEventListener('click', () => {
        if (off.bought || runState.gold < off.price) return;
        const cap2 = (typeof runDeckCap === 'function') ? runDeckCap() : 24;
        if ((runState.runDeck || []).length >= cap2) return;
        runState.gold -= off.price;
        if (runState.ach) runState.ach.spent = (runState.ach.spent || 0) + off.price;
        const newId = 'p0_' + off.rank + '_shop_' + Date.now() + '_' + Math.floor(Math.random()*10000);
        runState.runDeck.push({ rank: off.rank, id: newId, owner: 0, affix: off.affix || null });
        off.bought = true;
        log('Bought a ' + off.rank + (off.affix ? ' [' + off.affix + ']' : ' (plain)') +
            ' for ' + off.price + 'g.');
        renderShop();
      });
    }
    return row;
  }

  // (legacy guard — old loop body removed; original anchor below was for ref only)
  function _legacyRenderShopGuard() {
    if (false) {
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
            else if (item.id === 'engraver') startEngraverApply(item);
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
      // legacy
    }
  }

  // ============================================================
  // Phase 5: Shop services — Glass Shard and Forger
  // ============================================================

  // Phase 8+: generic affix applicator for Spiked Wire / Steel Plating / Mirage Lens
  function startAffixApply(item, affixId) {
    // Steel cards cannot be changed; everything else (with or without affix) can be overwritten.
    const eligible = runState.runDeck.filter(c => c.affix !== 'steel');
    if (eligible.length === 0) {
      log(item.name + ': no eligible run-deck cards (all Steel).');
      return;
    }
    showServicePicker({
      title: item.name + ' — pick a run-deck card to apply ' + affixId + ' (overwrites existing affix)',
      cards: eligible,
      onPick: (cardId) => {
        const card = runState.runDeck.find(c => c.id === cardId);
        if (!card) return;
        runState.gold -= item.price;
        const prev = card.affix;
        card.affix = affixId;
        const verb = prev ? 'overwrote ' + prev + ' with ' + affixId : 'applied ' + affixId;
        log(item.name + ': ' + verb + ' on ' + card.rank + '. (-' + item.price + 'g)');
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
            // Mass Forgery: count copies of this rank+affix in the run deck.
            const sig = target.rank + ':' + (target.affix || '_');
            const matches = runState.runDeck.filter(c => (c.rank + ':' + (c.affix || '_')) === sig).length;
            if (matches >= 7) _achGrant('massForgery');
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


  // Engraver — let the player pick a rank to ADD as a new vanilla card
  // into their run deck. Cap is 24 by default, 32 with Stacked Deck.
  const RUN_DECK_MAX = 24;
  function runDeckCap() {
    return RUN_DECK_MAX + (hasRelic('stackedDeck') ? 8 : 0);
  }
  function startEngraverApply(item) {
    if (!runState || !runState.runDeck) return;
    const cap = runDeckCap();
    if (runState.runDeck.length >= cap) {
      log('Engraver: your run deck is at the cap (' + cap + '). Strip a card first.');
      return;
    }
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
    title.textContent = 'Engraver — pick a rank to add a vanilla card to your run deck';
    picker.appendChild(title);
    const list = document.createElement('div');
    list.className = 'flex flex-wrap gap-2 justify-center mb-4';
    for (const r of ['A', 'K', 'Q', '10']) {
      const btn = document.createElement('button');
      btn.className = 'card card-face flex items-center justify-center text-2xl font-bold text-black rounded cursor-pointer hover:scale-105 transition';
      btn.textContent = r;
      btn.addEventListener('click', () => {
        if (runState.gold < item.price) return;
        runState.gold -= item.price;
        const newId = 'p0_' + r + '_eng_' + Date.now() + '_' + Math.floor(Math.random()*1000);
        runState.runDeck.push({ rank: r, id: newId, owner: 0, affix: null });
        log('Engraver: added a ' + r + ' to your run deck. Run deck size: ' +
            runState.runDeck.length + '. (-' + item.price + 'g)');
        closeServicePicker();
        renderShop();
      });
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

  // The Screamer — name a rank; for the rest of the round every card of
  // that rank in any hand is publicly revealed (rendered face-up beneath
  // each opponent's hand-size). Once per floor.
  function useScreamer(rank) {
    if (!hasJoker('screamer')) {
      log('The Screamer is not equipped.');
      return false;
    }
    if (!state || state.gameOver) {
      log('The Screamer can only be used during a round.');
      return false;
    }
    if (runState.screamerUsedThisFloor) {
      log('The Screamer has already been used this floor.');
      return false;
    }
    if (!RANKS.includes(rank)) {
      log("The Screamer needs a valid rank: 'A', 'K', 'Q', or '10'.");
      return false;
    }
    runState.screamerUsedThisFloor = true;
    state.screamerRevealedRank = rank;
    // Count for the log line so the player sees the immediate impact.
    let total = 0;
    for (let i = 0; i < NUM_PLAYERS; i++) {
      if (state.hands[i]) total += state.hands[i].filter(c => c.rank === rank).length;
    }
    log("THE SCREAMER: every " + rank + " in every hand is revealed for the rest of this round (" +
        total + " card" + (total === 1 ? '' : 's') + " visible).");
    render();
    return true;
  }

  // Crooked Die consumable — same effect as Loaded Die but consumes the
  // item and gates on its own per-floor flag (so a player who has both
  // could in principle use both per floor, which is fine).
  function useCrookedDie() {
    if (!state || state.gameOver) return;
    if (runState.crookedDieUsedThisFloor) return;
    if (!runState.inventory.crookedDie || runState.inventory.crookedDie < 1) return;
    const candidates = RANKS.filter(r => r !== state.targetRank);
    if (candidates.length === 0) return;
    runState.inventory.crookedDie--;
    state.targetRank = candidates[Math.floor(Math.random() * candidates.length)];
    runState.crookedDieUsedThisFloor = true;
    log('Crooked Die: target rerolled to ' + state.targetRank + '.');
    render();
  }

  // Lie Detector consumable — armable. Once armed, the next time the
  // human is the legitimate challenger (state.challengeOpen + their seat),
  // a "Peek (Lie Detector)" button is exposed; clicking it consumes the
  // arm and reveals truth/lie privately, leaving the LIAR button live so
  // the player can decide whether to actually call.
  function useLieDetector() {
    if (!runState.inventory.lieDetector || runState.inventory.lieDetector < 1) return;
    if (state && state.lieDetectorArmed) {
      log('Lie Detector is already armed.');
      return;
    }
    runState.inventory.lieDetector--;
    if (state) state.lieDetectorArmed = true;
    log('Lie Detector armed: next challenge window will let you peek before calling.');
    render();
  }

  function useSmokeBomb() {
    if (!state || state.gameOver || state.challengeOpen) return;
    if (state.currentTurn !== 0) return;
    if (state.finished[0] || state.eliminated[0]) return;
    const carouserFreeSmoke = hasJoker('carouser') && runState.carouserUsedThisFloor && !runState.carouserUsedThisFloor.smokeBomb;
    if (!carouserFreeSmoke && (!runState || runState.inventory.smokeBomb < 1)) return;

    if (carouserFreeSmoke) {
      runState.carouserUsedThisFloor.smokeBomb = true;
      log('You use a Smoke Bomb (Carouser free use). Turn skipped.');
    } else {
      runState.inventory.smokeBomb--;
      log('You use a Smoke Bomb. Turn skipped.');
    }
    if (runState.ach) runState.ach.consumableUses = (runState.ach.consumableUses || 0) + 1;
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
    const carouserFree = hasJoker('carouser') && runState.carouserUsedThisFloor && !runState.carouserUsedThisFloor.counterfeit;
    if (!carouserFree && (!runState || runState.inventory.counterfeit < 1)) return false;
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
    const carouserFree = hasJoker('carouser') && runState.carouserUsedThisFloor && !runState.carouserUsedThisFloor.counterfeit;
    if (carouserFree) {
      runState.carouserUsedThisFloor.counterfeit = true;
    } else {
      runState.inventory.counterfeit--;
    }
    if (runState.ach) runState.ach.consumableUses = (runState.ach.consumableUses || 0) + 1;
    state.counterfeitUsed = true;
    state.counterfeitLock = true;  // survives the next Liar call's rotation
    const oldRank = state.targetRank;
    state.targetRank = newRank;
    counterfeitPickOpen = false;
    log('You use Counterfeit' + (carouserFree ? ' (Carouser free use)' : '') +
        '. Target rank: ' + oldRank + ' -> ' + newRank +
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
    const carouserFree = hasJoker('carouser') && runState.carouserUsedThisFloor && !runState.carouserUsedThisFloor.jackBeNimble;
    if (!carouserFree && (!runState || runState.inventory.jackBeNimble < 1)) return;

    const jacks = state.hands[0].filter(c => c.rank === 'J').slice(0, 2);
    if (jacks.length === 0) return;

    if (carouserFree) {
      runState.carouserUsedThisFloor.jackBeNimble = true;
    } else {
      runState.inventory.jackBeNimble--;
    }
    if (runState.ach) runState.ach.consumableUses = (runState.ach.consumableUses || 0) + 1;
    const jackIds = new Set(jacks.map(c => c.id));
    state.hands[0] = state.hands[0].filter(c => !jackIds.has(c.id));
    log('You use Jack-be-Nimble' + (carouserFree ? ' (Carouser free use)' : '') +
        '. Discarded ' + jacks.length +
        (jacks.length === 1 ? ' Jack.' : ' Jacks.'));
    selected.clear();
    render();
  }

  // ============================================================
  // The Bookmark relic — end-of-round save-a-card-into-deck picker
  // ============================================================
  function _showBookmarkPicker() {
    if (!state || !runState) return;
    if (!state.hands[0] || state.hands[0].length === 0) return;
    let modal = document.getElementById('betaBookmarkModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'betaBookmarkModal';
      modal.className = 'fixed inset-0 bg-black/85 backdrop-blur z-50 flex items-center justify-center p-4';
      document.body.appendChild(modal);
    }
    modal.innerHTML =
      '<div class="bg-gradient-to-br from-yellow-700 via-amber-700 to-yellow-900 border-2 border-yellow-300 p-6 rounded-2xl shadow-2xl max-w-lg w-full">' +
        '<h3 class="text-xl font-extrabold mb-1 text-center">\ud83d\udcd6 The Bookmark</h3>' +
        '<p class="text-xs text-yellow-100 mb-4 text-center">Pick a hand card to save into your run deck (it will replace one of your run-deck cards). Or skip.</p>' +
        '<div class="text-center text-xs text-yellow-200 mb-1">Hand:</div>' +
        '<div id="bookmarkHandCards" class="flex flex-wrap gap-2 justify-center mb-4"></div>' +
        '<div class="text-center mt-2"><button id="bookmarkSkipBtn" class="bg-white/10 hover:bg-white/20 px-4 py-2 rounded-lg text-sm">Skip</button></div>' +
      '</div>';
    const cards = modal.querySelector('#bookmarkHandCards');
    cards.innerHTML = '';
    const order = ['A', 'K', 'Q', '10', 'J'];
    const sorted = state.hands[0].slice().sort((a, b) => {
      const ai = order.indexOf(a.rank), bi = order.indexOf(b.rank);
      if (ai !== bi) return ai - bi;
      return a.id.localeCompare(b.id);
    });
    for (const c of sorted) {
      if (c.rank === 'J') continue;  // Jacks aren't saveable
      const btn = document.createElement('button');
      let cls = 'card card-face flex items-center justify-center text-2xl font-bold text-black rounded cursor-pointer hover:scale-105 transition';
      const ring = affixRingClass(c.affix);
      if (ring) cls += ' ' + ring;
      else if (c.owner === 0) cls += ' ring-2 ring-emerald-400';
      btn.className = cls;
      btn.textContent = c.rank;
      const cid = c.id;
      btn.addEventListener('click', () => {
        const handCard = state.hands[0].find(x => x.id === cid);
        if (!handCard) { modal.classList.add('hidden'); return; }
        _showBookmarkReplacePicker(handCard, modal);
      });
      cards.appendChild(btn);
    }
    modal.querySelector('#bookmarkSkipBtn').addEventListener('click', () => {
      modal.classList.add('hidden');
    });
    modal.classList.remove('hidden');
  }
  function _showBookmarkReplacePicker(handCard, modal) {
    const inner = modal.querySelector('div.bg-gradient-to-br');
    inner.innerHTML =
      '<h3 class="text-xl font-extrabold mb-1 text-center">\ud83d\udcd6 Replace which run-deck card?</h3>' +
      '<p class="text-xs text-yellow-100 mb-4 text-center">' + handCard.rank + (handCard.affix ? ' [' + handCard.affix + ']' : '') + ' will replace the card you pick.</p>' +
      '<div id="bookmarkRunCards" class="flex flex-wrap gap-2 justify-center mb-4"></div>' +
      '<div class="text-center mt-2"><button id="bookmarkBackBtn" class="bg-white/10 hover:bg-white/20 px-4 py-2 rounded-lg text-sm">Back</button></div>';
    const list = inner.querySelector('#bookmarkRunCards');
    const order = ['A', 'K', 'Q', '10', 'J'];
    const sorted = runState.runDeck.slice().sort((a, b) => {
      const ai = order.indexOf(a.rank), bi = order.indexOf(b.rank);
      if (ai !== bi) return ai - bi;
      return a.id.localeCompare(b.id);
    });
    for (const c of sorted) {
      const btn = document.createElement('button');
      let cls = 'card card-face flex items-center justify-center text-2xl font-bold text-black rounded cursor-pointer hover:scale-105 transition';
      const ring = affixRingClass(c.affix);
      if (ring) cls += ' ' + ring;
      btn.className = cls;
      btn.textContent = c.rank;
      const targetId = c.id;
      btn.addEventListener('click', () => {
        const idx = runState.runDeck.findIndex(x => x.id === targetId);
        if (idx < 0) { modal.classList.add('hidden'); return; }
        // Replace: keep the original id so deck tracking stays clean, but
        // adopt the saved card's rank + affix.
        runState.runDeck[idx] = {
          rank: handCard.rank,
          id: runState.runDeck[idx].id,
          owner: 0,
          affix: handCard.affix || null,
        };
        log('Bookmark: saved ' + handCard.rank + (handCard.affix ? ' [' + handCard.affix + ']' : '') +
            ' into your run deck.');
        modal.classList.add('hidden');
      });
      list.appendChild(btn);
    }
    inner.querySelector('#bookmarkBackBtn').addEventListener('click', () => {
      _showBookmarkPicker();
    });
  }

  // Reset bookmark per-round flag at startRound time
  function _resetPerRoundRelicFlags() {
    if (runState) runState.bookmarkUsedThisRound = false;
  }

    // ============================================================
  // New consumables (use* functions)
  // ============================================================

  // Helper used by several pickers — clear the "are you sure" sub-modal we
  // append to document.body for each consumable. We reuse a single id.
  function _consumableModal(id, opts) {
    let modal = document.getElementById(id);
    if (!modal) {
      modal = document.createElement('div');
      modal.id = id;
      modal.className = 'fixed inset-0 bg-black/80 backdrop-blur z-50 flex items-center justify-center p-4';
      document.body.appendChild(modal);
    }
    const tone = opts.borderColor || 'amber-400';
    modal.innerHTML =
      '<div class="bg-slate-800 border-2 border-' + tone + ' p-6 rounded-2xl shadow-2xl max-w-lg w-full">' +
        '<h3 class="text-xl font-bold mb-1 text-center">' + (opts.title || '') + '</h3>' +
        (opts.subtitle ? '<p class="text-xs text-emerald-200 mb-3 text-center">' + opts.subtitle + '</p>' : '') +
        '<div id="' + id + 'Body"></div>' +
        '<div class="text-center mt-4"><button id="' + id + 'Cancel" class="bg-white/10 hover:bg-white/20 px-4 py-2 rounded-lg text-sm">Cancel</button></div>' +
      '</div>';
    modal.querySelector('#' + id + 'Cancel').addEventListener('click', () => modal.classList.add('hidden'));
    modal.classList.remove('hidden');
    return { modal, body: modal.querySelector('#' + id + 'Body') };
  }

  function _consumeCharge(id) {
    runState.inventory[id] = Math.max(0, (runState.inventory[id] || 0) - 1);
    if (runState.ach) runState.ach.consumableUses = (runState.ach.consumableUses || 0) + 1;
  }

  // ---- Whisper Network ----
  function useWhisperNetwork() {
    if (!_consumableUsableNow('whisperNetwork')) return;
    if ((runState.inventory.whisperNetwork || 0) < 1) return;
    _consumeCharge('whisperNetwork');
    const lines = [];
    for (let i = 1; i < NUM_PLAYERS; i++) {
      if (state.eliminated[i] || state.finished[i]) continue;
      lines.push(playerLabel(i) + ': ' + countJacks(state.hands[i]) + ' Jack(s)');
    }
    privatePeek('Whisper Network — ' + (lines.length ? lines.join('; ') : 'no targets') + '.');
    render();
  }

  // ---- Lucky Coin ----
  const LUCKY_COIN_AFFIXES = ['gilded', 'glass', 'spiked', 'mirage', 'hollow', 'echo', null];
  function useLuckyCoin() {
    if (!_consumableUsableNow('luckyCoin')) return;
    if ((runState.inventory.luckyCoin || 0) < 1) return;
    if (state.hands[0].length === 0) return;
    const eligible = state.hands[0].filter(c => c.affix !== 'steel');
    if (eligible.length === 0) {
      log('Lucky Coin: no eligible cards (all Steel).');
      return;
    }
    const { modal, body } = _consumableModal('betaLuckyCoinModal', {
      borderColor: 'yellow-400',
      title: '\ud83e\ude99 Lucky Coin',
      subtitle: 'Pick a hand card to re-roll its affix (Steel-immune; Cursed clears).',
    });
    body.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'flex flex-wrap gap-2 justify-center';
    for (const c of eligible) {
      const btn = document.createElement('button');
      let cls = 'card card-face flex items-center justify-center text-2xl font-bold text-black rounded cursor-pointer hover:scale-105 transition';
      const ring = affixRingClass(c.affix);
      if (ring) cls += ' ' + ring;
      else if (c.owner === 0) cls += ' ring-2 ring-emerald-400';
      btn.className = cls;
      btn.textContent = c.rank;
      const cid = c.id;
      btn.addEventListener('click', () => {
        const card = state.hands[0].find(x => x.id === cid);
        if (!card) { modal.classList.add('hidden'); return; }
        const newAffix = LUCKY_COIN_AFFIXES[Math.floor(Math.random() * LUCKY_COIN_AFFIXES.length)];
        const old = card.affix || 'plain';
        card.affix = newAffix;
        _consumeCharge('luckyCoin');
        log('Lucky Coin: ' + card.rank + ' ' + old + ' -> ' + (newAffix || 'plain') + '.');
        modal.classList.add('hidden');
        render();
      });
      list.appendChild(btn);
    }
    body.appendChild(list);
  }

  // ---- Snake Eyes ----
  function useSnakeEyes() {
    if (!_consumableUsableNow('snakeEyes')) return;
    if ((runState.inventory.snakeEyes || 0) < 1) return;
    if (state.snakeEyesLock) {
      log('Snake Eyes already armed.');
      return;
    }
    _consumeCharge('snakeEyes');
    state.snakeEyesLock = true;
    log('Snake Eyes armed: target rank stays through the next Liar call.');
    render();
  }

  // ---- Empty Threat ----
  function useEmptyThreat() {
    if (!_consumableUsableNow('emptyThreat')) return;
    if ((runState.inventory.emptyThreat || 0) < 1) return;
    if (runState.emptyThreatUsedThisFloor) return;
    _consumeCharge('emptyThreat');
    runState.emptyThreatUsedThisFloor = true;
    state.emptyThreatPending = true;
    // A 1-second mock "challenge" animation as the visual cue.
    const bar = document.getElementById('betaChallengeBar');
    if (bar) {
      bar.classList.remove('hidden');
      const fill = document.getElementById('betaChallengeBarFill');
      if (fill) {
        fill.style.transition = 'none';
        fill.style.width = '100%';
        setTimeout(() => {
          if (fill) { fill.style.transition = 'width 0.9s linear'; fill.style.width = '0%'; }
        }, 30);
        setTimeout(() => { bar.classList.add('hidden'); }, 1000);
      }
    }
    log('Empty Threat: you fake a Liar call. The next bot will play more cautiously.');
    render();
  }

  // ---- Distillation ----
  function useDistillation() {
    if (!_consumableUsableNow('distillation')) return;
    if ((runState.inventory.distillation || 0) < 1) return;
    // Find ranks with at least 2 eligible (non-Steel, non-Mirage) hand cards.
    const buckets = {};
    for (const c of state.hands[0]) {
      if (c.affix === 'steel' || c.affix === 'mirage') continue;
      buckets[c.rank] = buckets[c.rank] || [];
      buckets[c.rank].push(c);
    }
    const ranks = Object.keys(buckets).filter(r => buckets[r].length >= 2);
    if (ranks.length === 0) {
      log('Distillation: no two same-rank cards available.');
      return;
    }
    const { modal, body } = _consumableModal('betaDistillModal', {
      borderColor: 'cyan-400',
      title: '\u2697 Distillation',
      subtitle: 'Pick a rank — two of those cards become one with a random affix.',
    });
    body.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'flex flex-wrap gap-2 justify-center';
    for (const r of ranks) {
      const btn = document.createElement('button');
      btn.className = 'card card-face flex items-center justify-center text-2xl font-bold text-black rounded cursor-pointer hover:scale-105 transition ring-2 ring-cyan-300';
      btn.textContent = r;
      btn.title = buckets[r].length + ' available';
      btn.addEventListener('click', () => {
        const cards = buckets[r];
        const a = cards[0], b = cards[1];
        // Remove both from hand
        state.hands[0] = state.hands[0].filter(c => c.id !== a.id && c.id !== b.id);
        // Forge a new card with random affix
        const pool = ['gilded', 'glass', 'spiked', 'cursed', 'mirage', 'hollow', 'echo', null];
        const newAffix = pool[Math.floor(Math.random() * pool.length)];
        const newCard = {
          rank: r,
          id: 'distill_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
          owner: 0,
          affix: newAffix,
        };
        state.hands[0].push(newCard);
        _consumeCharge('distillation');
        log('Distillation: 2x ' + r + ' -> 1x ' + r + (newAffix ? ' [' + newAffix + ']' : ' (plain)') + '.');
        modal.classList.add('hidden');
        render();
      });
      list.appendChild(btn);
    }
    body.appendChild(list);
  }

  // ---- Pickpocket ----
  // Affix weight model: positive (gilded, mirage, echo) = heavy; neutral
  // (no affix, hollow, spiked, cursed) = standard; steel = very low.
  function _pickpocketWeight(card) {
    if (card.rank === 'J') return 0;            // Jacks excluded
    const a = card.affix;
    if (a === 'steel') return 0.2;
    if (a === 'gilded' || a === 'mirage' || a === 'echo') return 3.0;
    if (a === 'cursed' || a === 'spiked') return 0.6;
    if (a === 'hollow') return 0.9;
    return 1.0;                                  // plain
  }

  function usePickpocket() {
    if (!_consumableUsableNow('pickpocket')) return;
    if ((runState.inventory.pickpocket || 0) < 1) return;
    if (runState.pickpocketUsedThisFloor) return;
    const targets = [];
    for (let i = 1; i < NUM_PLAYERS; i++) {
      if (state.eliminated[i] || state.finished[i]) continue;
      if (state.hands[i].some(c => c.rank !== 'J')) targets.push(i);
    }
    if (targets.length === 0) {
      log('Pickpocket: no targets with non-Jack cards.');
      return;
    }
    const { modal, body } = _consumableModal('betaPickpocketModal', {
      borderColor: 'rose-400',
      title: '\ud83d\udd75 Pickpocket',
      subtitle: 'Pick an opponent — you steal a random non-Jack (positive affixes weighted higher).',
    });
    body.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'flex flex-wrap gap-2 justify-center';
    for (const t of targets) {
      const btn = document.createElement('button');
      btn.className = 'bg-rose-700 hover:bg-rose-600 transition px-4 py-3 rounded font-bold';
      btn.textContent = playerLabel(t) + ' (' + state.hands[t].length + ')';
      btn.addEventListener('click', () => {
        const hand = state.hands[t];
        const eligible = hand.filter(c => c.rank !== 'J');
        if (eligible.length === 0) { modal.classList.add('hidden'); return; }
        const weights = eligible.map(_pickpocketWeight);
        const total = weights.reduce((a, b) => a + b, 0);
        let r = Math.random() * total;
        let pickedIdx = 0;
        for (let k = 0; k < eligible.length; k++) {
          r -= weights[k];
          if (r <= 0) { pickedIdx = k; break; }
        }
        const card = eligible[pickedIdx];
        // Remove from target hand and add to ours.
        state.hands[t] = hand.filter(c => c.id !== card.id);
        state.hands[0].push(card);
        _consumeCharge('pickpocket');
        runState.pickpocketUsedThisFloor = true;
        log('Pickpocket: stole ' + card.rank + (card.affix ? ' [' + card.affix + ']' : '') + ' from ' + playerLabel(t) + '.');
        modal.classList.add('hidden');
        render();
      });
      list.appendChild(btn);
    }
    body.appendChild(list);
  }

  // ---- Dead Drop ----
  function useDeadDrop() {
    if (!_consumableUsableNow('deadDrop')) return;
    if ((runState.inventory.deadDrop || 0) < 1) return;
    if (state.hands[0].length === 0) return;
    _consumeCharge('deadDrop');
    const hand = state.hands[0].slice();
    const dropN = Math.min(3, hand.length);
    const idsToDrop = shuffle(hand).slice(0, dropN).map(c => c.id);
    state.hands[0] = state.hands[0].filter(c => !idsToDrop.includes(c.id));
    let drawn = 0;
    for (let i = 0; i < dropN; i++) {
      if (state.drawPile.length === 0) break;
      state.hands[0].push(state.drawPile.pop());
      drawn++;
    }
    log('Dead Drop: discarded ' + dropN + ', drew ' + drawn + '.');
    selected.clear();
    render();
  }

  // ---- Marked Deck ----
  const MARKED_DECK_AFFIXES = ['gilded', 'glass', 'spiked', 'cursed', 'steel', 'mirage', 'hollow', 'echo'];
  function useMarkedDeck() {
    if (!_consumableUsableNow('markedDeck')) return;
    if ((runState.inventory.markedDeck || 0) < 1) return;
    if (runState.markedDeckUsedThisFloor) return;
    if (state.drawPile.length === 0) {
      log('Marked Deck: draw pile is empty.');
      return;
    }
    const { modal, body } = _consumableModal('betaMarkedDeckModal', {
      borderColor: 'fuchsia-400',
      title: '\ud83c\udca0 Marked Deck',
      subtitle: 'Pick an affix to apply to a random draw-pile card.',
    });
    body.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'flex flex-wrap gap-2 justify-center';
    for (const a of MARKED_DECK_AFFIXES) {
      const btn = document.createElement('button');
      btn.className = 'px-3 py-2 rounded font-bold transition ' + 'bg-fuchsia-700 hover:bg-fuchsia-600';
      btn.textContent = a;
      btn.addEventListener('click', () => {
        // Pick a random card from the draw pile and overwrite its affix.
        const idx = Math.floor(Math.random() * state.drawPile.length);
        const card = state.drawPile[idx];
        const old = card.affix;
        card.affix = a;
        _consumeCharge('markedDeck');
        runState.markedDeckUsedThisFloor = true;
        log('Marked Deck: a draw-pile card now carries ' + a + (old ? ' (was ' + old + ')' : '') + '.');
        modal.classList.add('hidden');
        render();
      });
      list.appendChild(btn);
    }
    body.appendChild(list);
  }

  // ---- The Joker's Mask ----
  function useJokersMask() {
    if (!_consumableUsableNow('jokersMask')) return;
    if ((runState.inventory.jokersMask || 0) < 1) return;
    if (state.jokersMaskCardId) {
      log("Joker's Mask already in play this round.");
      return;
    }
    const eligible = state.hands[0].filter(c => c.rank !== 'J');
    if (eligible.length === 0) {
      log("Joker's Mask: no non-Jack cards in hand.");
      return;
    }
    const { modal, body } = _consumableModal('betaJokersMaskModal', {
      borderColor: 'purple-400',
      title: "\ud83c\udfad The Joker's Mask",
      subtitle: 'Pick a non-Jack to count as a Jack toward the curse for the rest of this round.',
    });
    body.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'flex flex-wrap gap-2 justify-center';
    for (const c of eligible) {
      const btn = document.createElement('button');
      let cls = 'card card-face flex items-center justify-center text-2xl font-bold text-black rounded cursor-pointer hover:scale-105 transition';
      const ring = affixRingClass(c.affix);
      if (ring) cls += ' ' + ring;
      else if (c.owner === 0) cls += ' ring-2 ring-emerald-400';
      btn.className = cls;
      btn.textContent = c.rank;
      const cid = c.id;
      btn.addEventListener('click', () => {
        state.jokersMaskCardId = cid;
        _consumeCharge('jokersMask');
        log("Joker's Mask: a " + c.rank + " is now counted as a Jack for the curse.");
        modal.classList.add('hidden');
        // If this immediately triggers the curse, handle it.
        if (checkJackCurse(0)) return;
        render();
      });
      list.appendChild(btn);
    }
    body.appendChild(list);
  }

  // ---- Mirror Shard ----
  function useMirrorShard() {
    if (!_consumableUsableNow('mirrorShard')) return;
    if ((runState.inventory.mirrorShard || 0) < 1) return;
    if (state.mirrorShardArmed) {
      log('Mirror Shard already armed.');
      return;
    }
    _consumeCharge('mirrorShard');
    state.mirrorShardArmed = true;
    log('Mirror Shard armed: the next Liar call against you reveals only the result.');
    render();
  }

  // ---- Stacked Hand ----
  // Arms a one-time +20% own-deck floor for the NEXT round's deal.
  // We persist the flag on runState so it survives the round transition.
  function useStackedHand() {
    if (!_consumableUsableNow('stackedHand')) return;
    if ((runState.inventory.stackedHand || 0) < 1) return;
    if (runState.stackedHandPending) {
      log('Stacked Hand already armed for next round.');
      return;
    }
    _consumeCharge('stackedHand');
    runState.stackedHandPending = true;
    log('Stacked Hand armed: next round\'s starting hand pulls +20% extra from your run deck.');
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

  // Card Inspector — open/close handlers
  const _inspectorBtn = document.getElementById('betaDeckInspectorBtn');
  if (_inspectorBtn) _inspectorBtn.addEventListener('click', openDeckInspector);
  const _inspectorClose = document.getElementById('betaDeckInspectorCloseBtn');
  if (_inspectorClose) _inspectorClose.addEventListener('click', closeDeckInspector);
  const _inspectorModal = document.getElementById('betaDeckInspectorModal');
  if (_inspectorModal) {
    _inspectorModal.addEventListener('click', (e) => {
      if (e.target === _inspectorModal) closeDeckInspector();
    });
  }

  // Affix-legend click-to-explain — wires every legend button in the Card
  // Inspector to open the existing info modal with the affix's full effect.
  const AFFIX_DETAILS = {
    gilded: {
      name: 'Gilded',
      tag: 'Passive (while held)',
      desc: 'Each turn this card stays in your hand: +' + GOLD_PER_GILDED_PER_TURN +
            'g (or +' + (GOLD_PER_GILDED_PER_TURN + 1) + 'g with The Patron joker). Stacks per Gilded card.',
    },
    glass: {
      name: 'Glass',
      tag: 'On reveal',
      desc: 'When revealed by a Liar call, the Glass card and 2 random non-Steel cards in the pile burn (out of play for the rest of the round). The Witch character ignores the burn cap; otherwise hitting the cap recycles burned cards back into the draw pile. Iron Stomach relic restores burned run-deck cards as Steel.',
    },
    spiked: {
      name: 'Spiked',
      tag: 'On pickup',
      desc: 'Whoever takes a pile containing Spiked cards draws +1 from the draw pile per Spiked card.',
    },
    cursed: {
      name: 'Cursed',
      tag: 'Passive (while held)',
      desc: "You cannot call Liar while holding any Cursed card. Picking up a Cursed card locks it in your hand for 2 turns (1 with Steel Spine relic). Devil's Bargain and the Gambler character force Cursed into your hand.",
    },
    steel: {
      name: 'Steel',
      tag: 'Passive',
      desc: 'Immune to Glass burns and most affix overwrites. Steel Jacks count DOUBLE toward the Jack curse. Dragon Scale relic: Steel cards grant +1 Jack limit (max +1 total — otherwise it would be absurd) and +10% gold PER Steel card.',
    },
    mirage: {
      name: 'Mirage',
      tag: 'On play (3-use)',
      desc: 'Treated as a wildcard — always matches the claimed Target Rank. After 3 resolutions, it is removed from your run deck for the rest of the run.',
    },
    hollow: {
      name: 'Hollow',
      tag: 'On play',
      desc: "You played it but your hand size doesn't drop — you immediately draw a replacement from the draw pile. Useful for stalling, dangerous if challenged.",
    },
    echo: {
      name: 'Echo',
      tag: 'On play',
      desc: "When you play an Echo card, its rank is mirrored from one of the previous player's played cards (random pick if they played multiple). It still claims the target rank, so the result depends on whether they told the truth.",
    },
  };
  document.querySelectorAll('button.beta-affix-legend').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-beta-affix');
      const a = AFFIX_DETAILS[id];
      if (!a) return;
      showInfoModal(a.name, a.tag, a.desc);
    });
  });

  // ============================================================
  // Catalog browse modals (Jokers / Relics / Affixes / Consumables)
  // ============================================================
  // One reusable modal element. Each browse button rebuilds its body.
  function _ensureCatalogModal() {
    let modal = document.getElementById('betaCatalogModal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'betaCatalogModal';
    modal.className = 'hidden fixed inset-0 bg-black/80 backdrop-blur z-50 flex items-center justify-center p-4';
    modal.innerHTML =
      '<div class="bg-slate-800 border-2 border-purple-400 p-6 rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto scrollbar-thin">' +
        '<div class="flex items-start justify-between mb-3 sticky top-0 bg-slate-800 pb-2">' +
          '<div>' +
            '<h3 id="betaCatalogTitle" class="text-xl font-bold"></h3>' +
            '<p id="betaCatalogSubtitle" class="text-xs text-emerald-200"></p>' +
          '</div>' +
          '<button id="betaCatalogCloseBtn" class="bg-white/10 hover:bg-white/20 px-3 py-1 rounded-lg text-sm">Close</button>' +
        '</div>' +
        '<div id="betaCatalogBody" class="space-y-2"></div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.querySelector('#betaCatalogCloseBtn').addEventListener('click', () => modal.classList.add('hidden'));
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
    return modal;
  }

  // Pretty rarity badge color for jokers.
  const _RARITY_TONE = {
    Common:    'bg-gray-700 text-gray-100',
    Uncommon:  'bg-emerald-700 text-emerald-100',
    Rare:      'bg-blue-700 text-blue-100',
    Legendary: 'bg-amber-700 text-amber-100',
  };

  function _openCatalog(kind) {
    const modal = _ensureCatalogModal();
    const titleEl = modal.querySelector('#betaCatalogTitle');
    const subEl   = modal.querySelector('#betaCatalogSubtitle');
    const body    = modal.querySelector('#betaCatalogBody');
    body.innerHTML = '';
    if (kind === 'jokers') {
      titleEl.textContent = '\ud83c\udca0 Jokers';
      const equipped = (runState && runState.jokers) ? runState.jokers.filter(j => j).map(j => j.id) : [];
      subEl.textContent = 'Every joker in the game. ' + (equipped.length ? equipped.length + ' currently equipped — highlighted.' : '(none equipped right now)');
      // Group by rarity for readability.
      const ORDER = ['Common', 'Uncommon', 'Rare', 'Legendary'];
      const byRarity = {};
      for (const id of Object.keys(JOKER_CATALOG)) {
        const j = JOKER_CATALOG[id];
        const r = j.rarity || 'Common';
        (byRarity[r] = byRarity[r] || []).push(j);
      }
      for (const rarity of ORDER) {
        const arr = byRarity[rarity];
        if (!arr || arr.length === 0) continue;
        const header = document.createElement('div');
        header.className = 'text-xs uppercase tracking-widest font-bold mt-2 mb-1 text-purple-300';
        header.textContent = rarity + ' (' + arr.length + ')';
        body.appendChild(header);
        for (const j of arr) {
          const isEq = equipped.includes(j.id);
          const row = document.createElement('div');
          row.className = 'rounded-lg p-3 border ' + (isEq
            ? 'bg-fuchsia-900/40 border-fuchsia-400'
            : 'bg-black/30 border-white/10');
          const tone = _RARITY_TONE[rarity] || 'bg-gray-700 text-gray-100';
          row.innerHTML =
            '<div class="flex items-baseline gap-2 mb-1">' +
              '<span class="font-bold">' + escapeHtml(j.name) + '</span>' +
              '<span class="text-[10px] uppercase tracking-widest font-bold px-1.5 rounded ' + tone + '">' + escapeHtml(rarity) + '</span>' +
              (isEq ? '<span class="text-[10px] uppercase tracking-widest font-bold px-1.5 rounded bg-fuchsia-500 text-white">Equipped</span>' : '') +
              '<span class="ml-auto text-xs text-yellow-300">' + (j.price || 0) + 'g</span>' +
            '</div>' +
            '<div class="text-xs text-emerald-100">' + escapeHtml(j.desc) + '</div>';
          body.appendChild(row);
        }
      }
    } else if (kind === 'relics') {
      titleEl.textContent = '\ud83d\udc51 Relics';
      const owned = (runState && runState.relics) || [];
      subEl.textContent = 'Every relic in the game. ' + owned.length + ' currently owned — highlighted.';
      // Group by source: boss-pool entries first, then treasure/other.
      const sources = {};
      for (const bossId of Object.keys(BOSS_RELIC_POOL)) {
        for (const id of BOSS_RELIC_POOL[bossId]) {
          sources[id] = bossId;
        }
      }
      const POOL_LABEL = { auditor: 'Auditor (Floor 3)', cheater: 'Cheater (Floor 6)', lugen: 'Lugen (Floor 9)' };
      // Render boss pools first.
      for (const bossId of ['auditor', 'cheater', 'lugen']) {
        const ids = BOSS_RELIC_POOL[bossId] || [];
        const header = document.createElement('div');
        header.className = 'text-xs uppercase tracking-widest font-bold mt-2 mb-1 text-amber-300';
        header.textContent = 'Boss reward — ' + (POOL_LABEL[bossId] || bossId);
        body.appendChild(header);
        for (const id of ids) {
          const r = RELIC_CATALOG[id];
          if (!r) continue;
          body.appendChild(_relicRow(r, owned.includes(id)));
        }
      }
      // Treasure / other (anything not in any boss pool).
      const restIds = Object.keys(RELIC_CATALOG).filter(id => !sources[id]);
      if (restIds.length > 0) {
        const header = document.createElement('div');
        header.className = 'text-xs uppercase tracking-widest font-bold mt-2 mb-1 text-amber-300';
        header.textContent = 'Treasure pool / shop';
        body.appendChild(header);
        for (const id of restIds) {
          body.appendChild(_relicRow(RELIC_CATALOG[id], owned.includes(id)));
        }
      }
    } else if (kind === 'affixes') {
      titleEl.textContent = '\u2728 Affixes';
      subEl.textContent = 'How each affix triggers and what it does.';
      const order = ['gilded', 'glass', 'spiked', 'cursed', 'steel', 'mirage', 'hollow', 'echo'];
      for (const id of order) {
        const a = AFFIX_DETAILS[id];
        if (!a) continue;
        const ringClass = affixRingClass(id);
        const row = document.createElement('div');
        row.className = 'rounded-lg p-3 border bg-black/30 border-white/10';
        row.innerHTML =
          '<div class="flex items-baseline gap-2 mb-1">' +
            '<div class="card card-face flex items-center justify-center text-base font-bold text-black rounded ' + (ringClass || '') + '" style="width:28px;height:38px;">A</div>' +
            '<span class="font-bold text-base">' + escapeHtml(a.name) + '</span>' +
            '<span class="text-[10px] uppercase tracking-widest font-bold px-1.5 rounded bg-cyan-700 text-cyan-100">' + escapeHtml(a.tag) + '</span>' +
          '</div>' +
          '<div class="text-xs text-emerald-100">' + escapeHtml(a.desc) + '</div>';
        body.appendChild(row);
      }
    } else if (kind === 'consumables') {
      titleEl.textContent = '\ud83c\udf81 Consumables';
      subEl.textContent = 'Every consumable, what it does, and how many you currently own.';
      const inv = (runState && runState.inventory) || {};
      // Render in a stable order (catalog key order).
      for (const id of Object.keys(CONSUMABLE_INFO)) {
        const c = CONSUMABLE_INFO[id];
        const count = inv[id] || 0;
        const owned = count > 0;
        const row = document.createElement('div');
        row.className = 'rounded-lg p-3 border ' + (owned
          ? 'bg-amber-900/40 border-amber-400'
          : 'bg-black/30 border-white/10');
        // Look up shop price if present.
        const shopItem = SHOP_ITEMS.find(s => s.id === id);
        const price = shopItem ? shopItem.price : null;
        row.innerHTML =
          '<div class="flex items-baseline gap-2 mb-1">' +
            '<span class="font-bold">' + escapeHtml(c.name) + '</span>' +
            (owned ? '<span class="text-[10px] uppercase tracking-widest font-bold px-1.5 rounded bg-amber-500 text-black">Owned ' + count + '</span>' : '') +
            (price !== null ? '<span class="ml-auto text-xs text-yellow-300">' + price + 'g</span>' : '') +
          '</div>' +
          '<div class="text-xs text-emerald-100">' + escapeHtml(c.desc) + '</div>';
        body.appendChild(row);
      }
    } else if (kind === 'achievements') {
      titleEl.textContent = '\ud83c\udfc6 Achievements';
      const unlocked = _achGetUnlocked();
      const progress = _achGetProgress();
      const total = Object.keys(ACHIEVEMENT_CATALOG).length;
      subEl.textContent = unlocked.length + ' / ' + total + ' unlocked. Progress is saved across runs.';
      // Group by category in a stable order.
      const ORDER = ['Mastery', 'Build', 'Economy', 'Run-defining'];
      const PRETTY = { Mastery: 'Mastery', Build: 'Build identity', Economy: 'Economy / fluff', 'Run-defining': 'Run-defining' };
      const byCat = {};
      for (const id of Object.keys(ACHIEVEMENT_CATALOG)) {
        const a = ACHIEVEMENT_CATALOG[id];
        (byCat[a.cat] = byCat[a.cat] || []).push(a);
      }
      // Inline progress hints — best-effort; show what we can compute.
      function _progressHint(id) {
        const ach = (runState && runState.ach) || {};
        switch (id) {
          case 'truthWins':    return (ach.truthSurvivals || 0) + ' / 10 (this run)';
          case 'liarsTongue':  return (state ? (state.humanLiesThisRound || 0) : 0) + ' / 10 (this round)';
          case 'glassCannon':  return (progress.glassBurned || 0) + ' / 100 (across runs)';
          case 'heartSurgeon': return (progress.heartShardsTotal || 0) + ' / 10 (across runs)';
          case 'bossSlayer': {
            const bk = progress.bossKills || {};
            const seen = ['lugen','mirror','hollow'].filter(b => bk[b]).length;
            return seen + ' / 3 floor-9 alts beaten';
          }
          case 'pacifier':     return (ach.cursedHoldStreak || 0) + ' / 5 (this run)';
          case 'gamblersHand': return (ach.charlatanStreak || 0) + ' / 5 (this run)';
          case 'jokersWild':   return (ach.jokersEverEquipped || 0) + ' / 5 (this run)';
          case 'spendthrift':  return (ach.spent || 0) + ' / 2000g (this run)';
          case 'wallet':       return ((runState && runState.gold) || 0) + ' / 1000g (current)';
          case 'pacifist':     return (ach.liarCalls || 0) === 0 ? 'still eligible (no Liar calls)' : 'broken — already called Liar';
          case 'stoic':        return (ach.consumableUses || 0) === 0 ? 'still eligible (no consumables used)' : 'broken — already used a consumable';
          case 'ironWill':     return runState && runState.runDeck
            ? runState.runDeck.filter(c => c.affix === 'steel').length + ' / 4 Steel cards in deck'
            : '\u2014';
          case 'strippedDown': return runState && runState.runDeck
            ? runState.runDeck.length + ' cards in deck (need <= 4 at run win)'
            : '\u2014';
          case 'affixConn': {
            if (!runState || !runState.runDeck) return '\u2014';
            const present = new Set(runState.runDeck.filter(c => c.affix).map(c => c.affix));
            return present.size + ' / 8 affixes present in deck';
          }
          default: return null;
        }
      }
      for (const cat of ORDER) {
        const arr = byCat[cat];
        if (!arr || arr.length === 0) continue;
        const header = document.createElement('div');
        header.className = 'text-xs uppercase tracking-widest font-bold mt-2 mb-1 text-yellow-300';
        const got = arr.filter(a => unlocked.includes(a.id)).length;
        header.textContent = (PRETTY[cat] || cat) + ' (' + got + ' / ' + arr.length + ')';
        body.appendChild(header);
        for (const a of arr) {
          const isUnlocked = unlocked.includes(a.id);
          const row = document.createElement('div');
          row.className = 'rounded-lg p-3 border ' + (isUnlocked
            ? 'bg-yellow-900/40 border-yellow-400'
            : 'bg-black/30 border-white/10');
          const hint = _progressHint(a.id);
          row.innerHTML =
            '<div class="flex items-baseline gap-2 mb-1">' +
              '<span class="font-bold">' + (isUnlocked ? '\ud83c\udfc6 ' : '\ud83d\udd12 ') + escapeHtml(a.name) + '</span>' +
              (isUnlocked
                ? '<span class="text-[10px] uppercase tracking-widest font-bold px-1.5 rounded bg-yellow-400 text-black">Unlocked</span>'
                : '<span class="text-[10px] uppercase tracking-widest font-bold px-1.5 rounded bg-white/10 text-white/60">Locked</span>') +
            '</div>' +
            '<div class="text-xs text-emerald-100">' + escapeHtml(a.desc) + '</div>' +
            (hint
              ? '<div class="text-[10px] text-emerald-300 mt-1">Progress: ' + escapeHtml(String(hint)) + '</div>'
              : '') +
            '<div class="text-[10px] italic text-white/60 mt-1">Unlocks: ' + escapeHtml(a.unlocks || '\u2014') + '</div>';
          body.appendChild(row);
        }
      }
    }
    modal.classList.remove('hidden');
  }
  function _relicRow(r, ownedFlag) {
    const row = document.createElement('div');
    const locked = !ownedFlag && r.unlock && !isRelicUnlocked(r.id);
    row.className = 'rounded-lg p-3 border ' + (ownedFlag
      ? 'bg-amber-900/50 border-amber-300'
      : (locked ? 'bg-black/40 border-white/5 opacity-70' : 'bg-black/30 border-white/10'));
    const badges =
      (ownedFlag ? '<span class="text-[10px] uppercase tracking-widest font-bold px-1.5 rounded bg-amber-400 text-black">Owned</span>' : '') +
      (locked ? '<span class="text-[10px] uppercase tracking-widest font-bold px-1.5 rounded bg-rose-500 text-white">Locked</span>' : '');
    const hint = locked ? relicUnlockHint(r.id) : null;
    row.innerHTML =
      '<div class="flex items-baseline gap-2 mb-1">' +
        '<span class="font-bold">' + escapeHtml(r.name) + '</span>' + badges +
        '<span class="ml-auto text-xs text-yellow-300">' + (r.price || 0) + 'g</span>' +
      '</div>' +
      '<div class="text-xs text-emerald-100">' + escapeHtml(r.desc) + '</div>' +
      (hint ? '<div class="text-[10px] text-rose-200 mt-1">Unlock: ' + escapeHtml(hint) + '</div>' : '');
    return row;
  }

  // Wire the four status-bar catalog buttons.
  const _catJokers = document.getElementById('betaCatalogJokersBtn');
  if (_catJokers) _catJokers.addEventListener('click', () => _openCatalog('jokers'));
  const _catRelics = document.getElementById('betaCatalogRelicsBtn');
  if (_catRelics) _catRelics.addEventListener('click', () => _openCatalog('relics'));
  const _catAffixes = document.getElementById('betaCatalogAffixesBtn');
  if (_catAffixes) _catAffixes.addEventListener('click', () => _openCatalog('affixes'));
  const _catCons = document.getElementById('betaCatalogConsumablesBtn');
  if (_catCons) _catCons.addEventListener('click', () => _openCatalog('consumables'));
  const _catAch = document.getElementById('betaCatalogAchievementsBtn');
  if (_catAch) _catAch.addEventListener('click', () => _openCatalog('achievements'));

  // Expose the catalog modal globally so the PvP UI (beta-mp.js / inline
  // markup with data-mp-catalog) can open it without re-implementing the
  // browse modal. Also expose the deck inspector for symmetry.
  try {
    window.lugenOpenCatalog = (kind) => _openCatalog(kind);
    window.lugenJokerCatalog = JOKER_CATALOG;
    window.lugenRelicCatalog = RELIC_CATALOG;
    window.lugenAffixDetails = AFFIX_DETAILS;
    window.lugenCharacterCatalog = CHARACTER_CATALOG;
    // Whisper character toggle. Until a dedicated button is wired into the
    // run sidebar, players can flip the peek direction from the dev console
    // (`lugenToggleWhisper()`). The next round's start-of-round peek uses
    // the current setting. Default direction is 'left' (next player).
    // The Screamer activation. Pass a rank: 'A', 'K', 'Q', or '10'. Once
    // per floor; sets state.screamerRevealedRank for the rest of this round.
    window.lugenUseScreamer = (rank) => useScreamer((rank || '').toUpperCase());
    window.lugenToggleWhisper = () => {
      if (!runState || !runState.character || !runState.character.whisperPeek) {
        console.log('[Whisper] Active character is not The Whisper.');
        return null;
      }
      runState.whisperDirection = runState.whisperDirection === 'right' ? 'left' : 'right';
      const label = runState.whisperDirection === 'right' ? 'right (previous player)' : 'left (next player)';
      log('Whisper direction set to ' + label + '.');
      return runState.whisperDirection;
    };
  } catch (e) {}

  // Wire any PvP catalog buttons defined via data-mp-catalog="<kind>".
  document.querySelectorAll('[data-mp-catalog]').forEach(btn => {
    btn.addEventListener('click', () => {
      const kind = btn.getAttribute('data-mp-catalog');
      if (kind) _openCatalog(kind);
    });
  });

  // Phase 6: resume/restart prompt when re-entering beta with an active run.
  function showResumeModal() {
    const modal = document.getElementById('betaResumeModal');
    if (!modal || !runState) return;
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

  // Resume an in-progress run. If a round is live (state != null) show the
  // game panel and re-render. Otherwise we lost the round state somehow —
  // start a fresh round on the current floor.
  function resumeBetaRun() {
    if (!runState) { backToIntro(); return; }
    hideAllPanels();
    document.getElementById('betaGame').classList.remove('hidden');
    if (state && !state.gameOver) {
      render();
      if (!state.challengeOpen && state.currentTurn !== 0) {
        setTimeout(botTurn, BOT_TURN_DELAY_MS);
      }
    } else {
      startRound();
    }
  }

  const _betaTestBtn = document.getElementById('betaTestBtn');
  if (_betaTestBtn) {
    _betaTestBtn.addEventListener('click', () => {
      if (runState) showResumeModal();
      renderRunHistory();
    });
  }

  const _resumeContinueBtn = document.getElementById('betaResumeContinueBtn');
  if (_resumeContinueBtn) {
    _resumeContinueBtn.addEventListener('click', () => {
      closeResumeModal();
      resumeBetaRun();
    });
  }

  const _resumeNewBtn = document.getElementById('betaResumeNewBtn');
  if (_resumeNewBtn) {
    _resumeNewBtn.addEventListener('click', () => {
      closeResumeModal();
      backToIntro();
    });
  }

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
