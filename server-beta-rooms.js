// server-beta-rooms.js — server-authoritative game state for beta multiplayer
// rooms. 2–4 humans share the same 9-floor run, each with their own personal
// run deck, hearts, and gold. MVP scope: core round/floor loop, hearts,
// best-of-3 floors, run end. Jokers / consumables / affixes / forks / shop /
// modifiers are NOT yet wired and can layer on top in later phases.

const crypto = require('crypto');

// ---------- Constants ----------
const RANKS_PLAYABLE = ['A', 'K', 'Q', '10'];        // valid target ranks
const ALL_RANKS = ['A', 'K', 'Q', '10', 'J'];        // includes Jack (wild bluff)
const HAND_SIZE = 5;
const RUN_DECK_PER_RANK = 3;                          // each player: 3 of A/K/Q/10 = 12 cards
const ROUND_DECK_RANK_CAP = 8;                        // max cards of any rank in a round
const BASE_JACKS_PER_ROUND = 6;                       // base J's added by the table
const STARTING_HEARTS = 3;
const ROUNDS_TO_WIN_FLOOR = 2;                        // best-of-3 → 2 wins clears the floor
const TOTAL_FLOORS = 9;
const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const GOLD_PLACE_1 = 20;
const GOLD_PLACE_2 = 10;
const GOLD_PER_FLOOR_WIN = 50;
const STARTING_GOLD = 50;
const CHALLENGE_WINDOW_MS = 8 * 1000;
const HEART_SHARDS_REQUIRED = 3;

// Character roster — kept in sync with public/beta.js characters. Server only
// honors the run-level effects (gold, run-deck Gilded), not jokers, since MVP
// doesn't run joker logic.
const CHARACTERS = {
  ace:       { id: 'ace',       name: 'The Ace',       startingJoker: 'sleightOfHand' },
  trickster: { id: 'trickster', name: 'The Trickster', startingJoker: 'doubletalk' },
  hoarder:   { id: 'hoarder',   name: 'The Hoarder',   handSizeBonus: 1, startingJoker: 'slowHand' },
  banker:    { id: 'banker',    name: 'The Banker',    startingGold: 150, startingGildedA: true, startingJoker: 'surveyor' },
  bait:      { id: 'bait',      name: 'The Bait',      startingJoker: 'spikedTrap', peekAtRoundStart: true },
  gambler:   { id: 'gambler',   name: 'The Gambler',   goldMultiplier: 1.5, startingJoker: 'blackHole', forcedCursedOnNewFloor: true },
  sharp:     { id: 'sharp',     name: 'The Sharp',     startingJoker: 'tattletale', sharpChallengeBonusMs: 1000 },
  whisper:   { id: 'whisper',   name: 'The Whisper',   startingJoker: 'eavesdropper', whisperPeek: true },
  // Variance archetype. Every round, every run-deck card sheds its affix
  // and gets a fresh random one (Steel included). Wired in startRound
  // below. The 20% card discount compensates the player for the volatility
  // — your build is unstable, so you should be able to buy more of it.
  randomExe: { id: 'randomExe', name: 'RANDOM.EXE',   startingJoker: null, apostateReroll: true, cardDiscount: 0.20 },
};

// Joker catalog — passive/active perks held in 2 slots.
const JOKER_CATALOG = {
  surveyor:       { id: 'surveyor',       name: 'The Surveyor',     rarity: 'Common',    price: 80,  desc: 'See the top card of the draw pile at all times.' },
  slowHand:       { id: 'slowHand',       name: 'Slow Hand',        rarity: 'Common',    price: 80,  desc: 'Your challenge window is 10 seconds (default 8).' },
  taxman:         { id: 'taxman',         name: 'The Taxman',       rarity: 'Common',    price: 80,  desc: 'When an opponent picks up a pile of 5+ cards, you gain 10g.' },
  eavesdropper:   { id: 'eavesdropper',   name: 'Eavesdropper',     rarity: 'Uncommon',  price: 150, desc: 'Every 2 rounds, see fuzzy match count from previous player (NONE/SOME/MANY).' },
  scapegoat:      { id: 'scapegoat',      name: 'The Scapegoat',    rarity: 'Uncommon',  price: 150, desc: 'Caught lying with a Jack? The Jack(s) go to the challenger.' },
  hotSeat:        { id: 'hotSeat',        name: 'Hot Seat',         rarity: 'Uncommon',  price: 150, desc: "Your right neighbour's challenge window is 3 seconds." },
  sleightOfHand:  { id: 'sleightOfHand',  name: 'Sleight of Hand',  rarity: 'Uncommon',  price: 150, desc: 'Once per round: draw 1 card from the draw pile on your turn.' },
  spikedTrap:     { id: 'spikedTrap',     name: 'Spiked Trap',      rarity: 'Rare',      price: 250, desc: 'If you tell the truth and are challenged, the challenger draws +3.' },
  tattletale:     { id: 'tattletale',     name: 'Tattletale',       rarity: 'Rare',      price: 250, desc: "Once per floor: peek at a player's full hand for 4 seconds." },
  safetyNet:      { id: 'safetyNet',      name: 'Safety Net',       rarity: 'Rare',      price: 250, desc: 'Your Jack limit is increased by 1.' },
  doubletalk:     { id: 'doubletalk',     name: 'Doubletalk',       rarity: 'Rare',      price: 250, desc: 'Once per round: play 2-4 cards instead of 1-3.' },
  blackHole:      { id: 'blackHole',      name: 'Black Hole',       rarity: 'Legendary', price: 400, desc: 'On a successful Jack bluff (no challenge), delete one non-Jack from your hand.' },
  coldRead:       { id: 'coldRead',       name: 'Cold Read',        rarity: 'Legendary', price: 400, desc: 'Round start: see one random card from each opponent.' },
  vengefulSpirit: { id: 'vengefulSpirit', name: 'Vengeful Spirit',  rarity: 'Legendary', price: 400, desc: 'If a Jack curse eliminates you, the next active player is also eliminated.' },
  callersMark:    { id: 'callersMark',    name: "Caller's Mark",    rarity: 'Uncommon',  price: 150, desc: "First LIAR call each round: +20g if right, -15g if wrong. Rewards reads, punishes spam." },
};

// Relic catalog — permanent passive bonuses, one of each per run.
// Boss-only relic pools. Each boss awards a choice of 2 relics from its pool.
const BOSS_RELIC_POOL = {
  auditor: ['crackedCoin', 'loadedDie'],
  cheater: ['pocketWatch', 'handMirror'],
  lugen:   ['ironStomach', 'ledger'],
};

const RELIC_CATALOG = {
  crackedCoin: { id: 'crackedCoin', name: 'Cracked Coin', price: 200, desc: 'Each round start: gain 5g × Hearts remaining.' },
  loadedDie:   { id: 'loadedDie',   name: 'Loaded Die',   price: 200, desc: 'Once per floor: reroll the Target Rank.' },
  pocketWatch: { id: 'pocketWatch', name: 'Pocket Watch', price: 200, desc: 'Your challenge window is +5 seconds (stacks).' },
  handMirror:  { id: 'handMirror',  name: 'Hand Mirror',  price: 250, desc: 'Round start: see one random card from each opponent.' },
  ironStomach: { id: 'ironStomach', name: 'Iron Stomach', price: 300, desc: 'Glass-burned run-deck cards return as Steel at end of round.' },
  ledger:      { id: 'ledger',      name: 'The Ledger',   price: 300, desc: '+25% gold from all sources (stacks).' },
  // Treasure-only relics (Act III treasure node).
  shroud:       { id: 'shroud',       name: 'The Shroud',       price: 0, desc: 'Run-deck card borders fade between rounds, harder to track.' },
  crookedCards: { id: 'crookedCards', name: 'Crooked Cards',    price: 0, desc: 'Once per floor, look at the entire draw pile and rearrange any 5 cards.' },
  blackMarket:  { id: 'blackMarket',  name: 'Black Market',     price: 0, desc: 'Shop prices 25% lower, but Jack-be-Nimble removed from your shop pool.' },
  gamblersMark: { id: 'gamblersMark', name: "Gambler's Mark",   price: 0, desc: '+1 joker slot, but you start each floor with one Cursed card forced into your hand.' },
};
const TREASURE_RELIC_POOL = ['shroud', 'crookedCards', 'blackMarket', 'gamblersMark'];

// Floor modifiers — Act 2+ non-boss floors roll one of these.
const FLOOR_MODIFIERS = {
  foggy:   { id: 'foggy',   name: 'Foggy',   desc: 'Target rank fades after 5 seconds.' },
  greedy:  { id: 'greedy',  name: 'Greedy',  desc: '+100% gold this floor, but Jack limit drops to 3.' },
  brittle: { id: 'brittle', name: 'Brittle', desc: 'Every card is temporarily Glass for this floor.' },
  echoing: { id: 'echoing', name: 'Echoing', desc: 'Each play: 20% chance the first card is flashed to all players.' },
  silent:  { id: 'silent',  name: 'Silent',  desc: 'Bot tells are hidden this floor (no effect in pure-PvP).' },
  tariff:  { id: 'tariff',  name: 'Tariff',  desc: 'Each LIAR call costs 5g.' },
};

// Boss floors — 3, 6, 9. Boss "specials" in PvP show as floor banners.
const BOSS_CATALOG = {
  auditor: { id: 'auditor', name: 'The Auditor', floor: 3, desc: 'Boss floor — challenge windows are halved.' },
  cheater: { id: 'cheater', name: 'The Cheater', floor: 6, desc: 'Boss floor — first play of each round is forced.' },
  lugen:   { id: 'lugen',   name: 'Lugen',       floor: 9, desc: 'Final boss — Jacks count as wild for callers.' },
};

// Shop items (services + relics + jokers — same shape as solo).
const SHOP_ITEMS = [
  { id: 'smokeBomb',     name: 'Smoke Bomb',          price: 35,  desc: 'Skip your turn (consumable).', enabled: true, type: 'consumable' },
  { id: 'counterfeit',   name: 'Counterfeit',         price: 35,  desc: 'Change target rank now and lock through next LIAR (consumable).', enabled: true, type: 'consumable' },
  { id: 'jackBeNimble',  name: 'Jack-be-Nimble',      price: 90,  desc: 'Discard up to 2 Jacks from your hand (consumable).', enabled: true, type: 'consumable' },
  { id: 'glassShard',    name: 'Glass Shard',         price: 30,  desc: 'Apply Glass to a run-deck card.', enabled: true, type: 'service' },
  { id: 'forger',        name: 'Forger',              price: 100, desc: 'Clone one run-deck card onto another (rank + affix). No Jacks.', enabled: true, type: 'service' },
  { id: 'spikedWire',    name: 'Spiked Wire',         price: 30,  desc: 'Apply Spiked to a run-deck card.', enabled: true, type: 'service' },
  { id: 'steelPlating',  name: 'Steel Plating',       price: 50,  desc: 'Apply Steel to a run-deck card.', enabled: true, type: 'service' },
  { id: 'mirageLens',    name: 'Mirage Lens',         price: 200, desc: 'Apply Mirage to a run-deck card.', enabled: true, type: 'service' },
  { id: 'stripper',      name: 'Stripper',            price: 60,  desc: 'Permanently remove a run-deck card (no Jacks).', enabled: true, type: 'service' },
  { id: 'engraver',      name: 'Engraver',            price: 80,  desc: 'Add a vanilla card to your run deck.', enabled: true, type: 'service' },
  { id: 'tracer',        name: 'Tracer',              price: 40,  desc: 'See top 3 of draw pile, rearrange them (consumable — use on your turn).', enabled: true, type: 'consumable' },
  { id: 'devilsBargain', name: "Devil's Bargain",     price: 55,  desc: 'Drop a hand card to bottom of draw pile; draw the top with Cursed (consumable).', enabled: true, type: 'consumable' },
  { id: 'magnet',        name: 'Magnet',              price: 75,  desc: 'Give one of your hand cards (not Steel) to a random opponent (consumable).', enabled: true, type: 'consumable' },
  { id: 'crackedCoin',   name: 'RELIC · Cracked Coin', price: 200, desc: '[Relic] Each round start: gain 5g × Hearts remaining.', enabled: true, type: 'relic' },
  { id: 'loadedDie',     name: 'RELIC · Loaded Die',   price: 200, desc: '[Relic] Once per floor, reroll the Target Rank.', enabled: true, type: 'relic' },
  { id: 'pocketWatch',   name: 'RELIC · Pocket Watch', price: 200, desc: '[Relic] +5 seconds challenge window (stacks).', enabled: true, type: 'relic' },
  { id: 'handMirror',    name: 'RELIC · Hand Mirror',  price: 250, desc: '[Relic] Round start: see one random card from each opponent.', enabled: true, type: 'relic' },
  { id: 'ironStomach',   name: 'RELIC · Iron Stomach', price: 300, desc: '[Relic] Glass-burned run-deck cards return as Steel.', enabled: true, type: 'relic' },
  { id: 'ledger',        name: 'RELIC · The Ledger',   price: 300, desc: '[Relic] +25% gold from all sources (stacks).', enabled: true, type: 'relic' },
  { id: 'surveyor',      name: 'JOKER · Surveyor',     price: 80,  desc: '[Common] See top of draw pile.', enabled: true, type: 'joker' },
  { id: 'slowHand',      name: 'JOKER · Slow Hand',    price: 80,  desc: '[Common] Challenge window 10s.', enabled: true, type: 'joker' },
  { id: 'taxman',        name: 'JOKER · The Taxman',   price: 80,  desc: '[Common] Opponent takes 5+ pile = +10g.', enabled: true, type: 'joker' },
  { id: 'eavesdropper',  name: 'JOKER · Eavesdropper', price: 150, desc: '[Uncommon] Every 2 rounds: fuzzy match count.', enabled: true, type: 'joker' },
  { id: 'scapegoat',     name: 'JOKER · The Scapegoat',price: 150, desc: '[Uncommon] Caught lying with Jack? Jack goes to challenger.', enabled: true, type: 'joker' },
  { id: 'hotSeat',       name: 'JOKER · Hot Seat',     price: 150, desc: '[Uncommon] Right neighbor 3s window.', enabled: true, type: 'joker' },
  { id: 'sleightOfHand', name: 'JOKER · Sleight of Hand', price: 150, desc: '[Uncommon] Once per round: draw 1 card.', enabled: true, type: 'joker' },
  { id: 'spikedTrap',    name: 'JOKER · Spiked Trap',  price: 250, desc: '[Rare] Truth + challenged = challenger draws +3.', enabled: true, type: 'joker' },
  { id: 'tattletale',    name: 'JOKER · Tattletale',   price: 250, desc: '[Rare] Once per floor: peek at a hand for 4s.', enabled: true, type: 'joker' },
  { id: 'safetyNet',     name: 'JOKER · Safety Net',   price: 250, desc: '[Rare] Jack limit +1 (stacks with Hoarder).', enabled: true, type: 'joker' },
  { id: 'doubletalk',    name: 'JOKER · Doubletalk',   price: 250, desc: '[Rare] Once per round: play 2-4 cards.', enabled: true, type: 'joker' },
  { id: 'blackHole',     name: 'JOKER · Black Hole',   price: 400, desc: '[Legendary] Successful Jack bluff: delete a non-Jack.', enabled: true, type: 'joker' },
  { id: 'coldRead',      name: 'JOKER · Cold Read',    price: 400, desc: '[Legendary] Round start: see 1 card from each opponent.', enabled: true, type: 'joker' },
  { id: 'vengefulSpirit',name: 'JOKER · Vengeful Spirit', price: 400, desc: '[Legendary] Jack-cursed = drag next active player down.', enabled: true, type: 'joker' },
];

// Random events at the Event fork node.
const EVENTS = [
  { id: 'foundCoins',  name: 'Found Coins',  desc: 'Pocket change on the floor.',         payout: () => ({ gold: 30 }) },
  { id: 'lostBet',     name: 'Lost Bet',     desc: 'A passing stranger calls your debt.', payout: () => ({ gold: -20 }) },
  { id: 'kindStranger',name: 'Kind Stranger',desc: 'Someone tips you for a smile.',       payout: () => ({ gold: 50 }) },
  { id: 'paranoia',    name: 'Paranoia',     desc: 'Skipped sleep — pay 25g or take 1 heart shard hit.', payout: () => ({ gold: -25 }) },
  { id: 'doubleOrNothing', name: 'Double or Nothing', desc: '50/50: -50g or +100g.', payout: () => ({ gold: Math.random() < 0.5 ? -50 : 100 }) },
];

const SLOW_HAND_WINDOW_MS = 10000;
const HOT_SEAT_WINDOW_MS = 3000;
const POCKET_WATCH_BONUS_MS = 5000;
const SPIKED_TRAP_DRAWS = 3;
const TATTLETALE_PEEK_MS = 4000;
const TREASURE_CHANCE_ACT_III = 0.33;

const SHOP_RARITY_WEIGHTS = { Common: 60, Uncommon: 25, Rare: 10, Legendary: 5 };
const SHOP_OFFER_CONSUMABLES = 3;
const SHOP_OFFER_JOKERS = 3;
const SHOP_OFFER_RELICS = 2;
const FLOOR_AFFIX_POOL = ['gilded', 'glass', 'spiked', 'cursed',
                          'steel', 'mirage', 'hollow', 'echo'];

// ---------- Helpers ----------
function newId() { return crypto.randomBytes(8).toString('hex'); }

function makeRoomId() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 5; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

// ---------- Module state ----------
const betaRooms = {};

function newBetaRoom(id) {
  return {
    id,
    type: 'beta',
    hostId: null,
    players: [],
    started: false,
    runStarted: false,
    currentFloor: 1,
    targetRank: null,
    currentTurnIdx: 0,
    pile: [],
    drawPile: [],
    lastPlay: null,
    challengeOpen: false,
    challengerIdx: -1,
    challengeDeadline: null,
    challengeTimer: null,
    placements: [],
    log: [],
    runOver: false,
    runWinnerId: null,
    createdAt: Date.now(),
    // ===== Phase / fork state =====
    phase: 'lobby',         // 'lobby' | 'round' | 'fork' | 'shop' | 'reward' | 'event' | 'treasure' | 'gameover'
    forkOffer: null,        // { hasShop: true, hasReward: true, hasEvent: true, hasTreasure: bool }
    forkPicks: {},          // playerId -> 'shop' | 'reward' | 'event' | 'treasure' | 'continue'
    shopOffer: [],          // generated SHOP_ITEMS subset for this floor
    shopCardOffer: [],      // generated card offers (3 per visit) — see regenerateShopOffer
    rewardChoice: {},       // playerId -> { type: 'gold' | 'upgrade', resolved: bool }
    eventResults: {},       // playerId -> { event, gold }
    currentFloorModifier: null,
    currentBoss: null,
    burnedCards: [],            // cards Glass-burned this round (capped at BURN_CAP, then recycled)
    echoArmedFor: -1,           // playerIdx armed by Echo (peeks the next opponent's first card)
    counterfeitLockedRanks: {}, // playerId -> bool (locks one target rotation)
    counterfeitUsedRound: {},   // playerId -> bool (once per round)
    sleightUsedRound: {},       // playerId -> bool
    doubletalkArmed: {},        // playerId -> bool (next play can be 2-4 cards)
    doubletalkUsedRound: {},    // playerId -> bool
    loadedDieUsedFloor: {},     // playerId -> bool
    tattletaleChargesFloor: {}, // playerId -> int (charges remaining)
    activePeeks: {},            // playerId -> { targetIdx, cards: [cardIds], revealedAt, ms } — server-side tracked, sent in personalized snapshot
  };
}

function findPlayerById(room, id) { return room.players.find(p => p.id === id); }
function findPlayerBySocket(room, sid) { return room.players.find(p => p.socketId === sid); }

// Joker slot count is a flat 5 across the game now (was 2). This helper
// migrates any older player object (which was created with a 2-slot array)
// up to the new size by appending nulls. Idempotent — calling it on a
// 5-slot array does nothing. Called from every joker-touching code path
// so existing in-progress runs can use the full 5 slots immediately.
const PVP_JOKER_SLOTS = 5;
function ensurePlayerJokerSlots(p) {
  if (!p) return;
  if (!Array.isArray(p.jokers)) p.jokers = [];
  while (p.jokers.length < PVP_JOKER_SLOTS) p.jokers.push(null);
}

// ---------- Public state shape (sent to clients) ----------
function publicBetaState(room, requestingPlayerId) {
  const me = requestingPlayerId ? findPlayerById(room, requestingPlayerId) : null;
  // Drain pendingPeeks for `me` — they're delivered exactly once per snapshot
  let myPeeks = [];
  if (me && me.pendingPeeks && me.pendingPeeks.length > 0) {
    myPeeks = me.pendingPeeks.slice();
    me.pendingPeeks = [];
  }
  // Surveyor: top of draw pile (if me has it)
  let surveyorTop = null;
  if (me && playerHasJoker(me, 'surveyor') && room.drawPile && room.drawPile.length > 0) {
    const top = room.drawPile[room.drawPile.length - 1];
    surveyorTop = { rank: top.rank, affix: top.affix || null };
  }
  return {
    id: room.id,
    type: 'beta',
    hostId: room.hostId,
    started: room.started,
    runStarted: room.runStarted,
    runOver: room.runOver,
    runWinnerId: room.runWinnerId,
    phase: room.phase,
    currentFloor: room.currentFloor,
    totalFloors: TOTAL_FLOORS,
    targetRank: room.targetRank,
    currentTurnIdx: room.currentTurnIdx,
    pileSize: room.pile.length,
    drawSize: room.drawPile.length,
    burnedCount: (room.burnedCards || []).length,
    burnCap: BURN_CAP,
    seed: room.seed || null,
    lastPlay: room.lastPlay
      ? { playerIdx: room.lastPlay.playerIdx, claim: room.lastPlay.claim, count: room.lastPlay.count }
      : null,
    challengeOpen: room.challengeOpen,
    challengerIdx: room.challengerIdx,
    challengeDeadline: room.challengeDeadline,
    placements: room.placements.slice(),
    log: room.log.slice(-40),
    currentFloorModifier: room.currentFloorModifier,
    currentFloorModifierInfo: room.currentFloorModifier ? FLOOR_MODIFIERS[room.currentFloorModifier] : null,
    currentBoss: room.currentBoss || null,
    forkOffer: room.forkOffer || null,
    forkPicks: Object.assign({}, room.forkPicks || {}),
    bossRelicOffer: room.bossRelicOffer ? {
      bossId: room.bossRelicOffer.bossId,
      bossName: room.bossRelicOffer.bossName,
      pool: room.bossRelicOffer.pool.slice(),
      pool_meta: room.bossRelicOffer.pool.map(rid => RELIC_CATALOG[rid]),
      picks: Object.assign({}, room.bossRelicOffer.picks),
    } : null,
    shopOffer: (room.shopOffer || []).map(i => ({
      id: i.id, name: i.name, price: i.price, desc: i.desc, type: i.type, enabled: i.enabled,
    })),
    shopCardOffer: (room.shopCardOffer || []).map(c => ({
      offerId: c.offerId, rank: c.rank, affix: c.affix,
      // `price` is the BUYER's effective price (factors in any character
      // discount like RANDOM.EXE). The base 100g lives on the server; we
      // never expose other players' discounted prices, just our own.
      price: shopCardPriceFor(me, c),
      boughtByMe: !!(c.bought && me && c.bought[me.id]),
    })),
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      username: p.username || null,
      characterId: p.character ? p.character.id : null,
      characterName: p.character ? p.character.name : null,
      hearts: p.hearts,
      gold: p.gold,
      roundsWon: p.roundsWon,
      heartShards: p.heartShards || 0,
      handCount: p.hand ? p.hand.length : 0,
      runDeckCount: p.runDeck ? p.runDeck.length : 0,
      eliminated: !!p.eliminated,
      finishedThisRound: !!p.finishedThisRound,
      connected: !!p.connected,
      // Pad to 5 slots so any legacy 2-slot player object on the server
      // surfaces as a full 5-slot UI on the client. Doesn't mutate the
      // server-side array — the migration call elsewhere does that.
      jokers: (() => {
        const arr = (p.jokers || []).map(j => j ? { id: j.id, name: j.name, rarity: j.rarity, desc: j.desc } : null);
        while (arr.length < PVP_JOKER_SLOTS) arr.push(null);
        return arr;
      })(),
      relics: (p.relics || []).slice(),
      inventoryCount: Object.values(p.inventory || {}).reduce((a, b) => a + b, 0),
    })),
    mine: me
      ? {
          id: me.id,
          hand: (me.hand || []).map(c => ({ rank: c.rank, id: c.id, owner: c.owner, affix: c.affix || null, cursedTurnsLeft: c.cursedTurnsLeft || 0 })),
          runDeck: (me.runDeck || []).map(c => ({ rank: c.rank, id: c.id, affix: c.affix || null })),
          inventory: Object.assign({}, me.inventory || {}),
          jokers: (me.jokers || []).map(j => j ? { id: j.id, name: j.name, rarity: j.rarity, desc: j.desc } : null),
          relics: (me.relics || []).slice(),
          tattletaleCharges: (room.tattletaleChargesFloor && room.tattletaleChargesFloor[me.id]) || 0,
          loadedDieUsed: !!(room.loadedDieUsedFloor && room.loadedDieUsedFloor[me.id]),
          counterfeitUsedRound: !!(room.counterfeitUsedRound && room.counterfeitUsedRound[me.id]),
          peeks: myPeeks,
          surveyorTop,
          forkPick: (room.forkPicks && room.forkPicks[me.id]) || null,
          eventResult: (room.eventResults && room.eventResults[me.id]) || null,
          pendingService: (room.pendingServices && room.pendingServices[me.id]) || null,
          rewardOffer: (room.rewardOffers && room.rewardOffers[me.id]) || null,
        }
      : null,
  };
}

function broadcast(io, room) {
  // Each connected player gets a personalized snapshot (different `mine` data)
  for (const p of room.players) {
    if (!p.connected || !p.socketId) continue;
    io.to(p.socketId).emit('beta:state', publicBetaState(room, p.id));
  }
}

function log(room, msg) {
  room.log.push(msg);
  if (room.log.length > 200) room.log.splice(0, room.log.length - 200);
}

// ---------- Run setup ----------
function buildInitialRunDeck(playerIdx) {
  const deck = [];
  for (const r of ['A', 'K', 'Q', '10']) {
    for (let i = 0; i < RUN_DECK_PER_RANK; i++) {
      deck.push({
        rank: r,
        id: 'p' + playerIdx + '_' + r + '_' + i + '_' + newId().slice(0, 4),
        owner: playerIdx,
        affix: null,
      });
    }
  }
  return deck;
}

function applyCharacter(player) {
  const ch = player.character;
  if (!ch) return;
  if (ch.startingGold) player.gold = ch.startingGold;
  if (ch.startingGildedA) {
    const aCard = player.runDeck.find(c => c.rank === 'A' && !c.affix);
    if (aCard) aCard.affix = 'gilded';
  }
  if (ch.startingJoker && JOKER_CATALOG[ch.startingJoker]) {
    player.jokers[0] = { ...JOKER_CATALOG[ch.startingJoker] };
  }
}

// ---------- Roguelike helpers ----------
function isBossFloor(f) { return f === 3 || f === 6 || f === 9; }
function getBoss(f) {
  for (const id of Object.keys(BOSS_CATALOG)) {
    if (BOSS_CATALOG[id].floor === f) return BOSS_CATALOG[id];
  }
  return null;
}
function getCurrentAct(floor) {
  if (floor <= 3) return 1;
  if (floor <= 6) return 2;
  return 3;
}
function playerHasJoker(p, jokerId) {
  return p.jokers && p.jokers.some(j => j && j.id === jokerId);
}
function playerHasRelic(p, relicId) {
  return p.relics && p.relics.includes(relicId);
}
function challengeWindowMsFor(p) {
  let ms = CHALLENGE_WINDOW_MS;
  if (playerHasJoker(p, 'slowHand')) ms = SLOW_HAND_WINDOW_MS;
  // Pocket Watch stacks
  const pw = (p.relics || []).filter(r => r === 'pocketWatch').length;
  ms += pw * POCKET_WATCH_BONUS_MS;
  // The Sharp character: +1 second
  if (p.character && p.character.sharpChallengeBonusMs) ms += p.character.sharpChallengeBonusMs;
  return ms;
}
function jackLimitFor(p) {
  let limit = 4;
  if (p.character && p.character.handSizeBonus) limit += 1;  // Hoarder
  if (playerHasJoker(p, 'safetyNet')) limit += 1;
  return limit;
}
function applyGoldGain(p, n, reason) {
  if (!n || n === 0) return 0;
  let multiplier = 1;
  if (p.character && p.character.goldMultiplier) multiplier *= p.character.goldMultiplier;
  // Ledger relic +25% per copy
  const ledgers = (p.relics || []).filter(r => r === 'ledger').length;
  multiplier *= (1 + 0.25 * ledgers);
  const amt = Math.floor(n * multiplier);
  p.gold = (p.gold || 0) + amt;
  return amt;
}
const BURN_CAP = 8;
const GOLD_PER_GILDED_PER_TURN = 2;
const SPIKED_DRAWS_ON_PICKUP = 1;
const GLASS_BURN_RANDOM = 2;

// Gilded — fired when a player begins their turn. Pays out for each Gilded
// card currently in their hand.
const CURSED_TURN_LOCK = 2;
// Mark a single card with the Cursed-hold timer when it enters a hand.
function markCursedOnEntry(card) {
  if (card && card.affix === 'cursed' && (card.cursedTurnsLeft === undefined || card.cursedTurnsLeft <= 0)) {
    card.cursedTurnsLeft = CURSED_TURN_LOCK;
  }
}
function markAllCursedOnEntry(cards) {
  if (!cards) return;
  for (const c of cards) markCursedOnEntry(c);
}
// Tick down Cursed counters on the active player's turn START. Auto-draw if
// the player has no playable cards because all are Cursed-locked.
function onTurnStart(room, playerIdx) {
  const p = room.players[playerIdx];
  if (!p || !p.hand) return;
  for (const c of p.hand) {
    if (c.affix === 'cursed' && c.cursedTurnsLeft > 0) c.cursedTurnsLeft--;
  }
  // If every card is Cursed-locked, draw 1 from the draw pile (if available)
  const allLocked = p.hand.length > 0 && p.hand.every(c => c.affix === 'cursed' && (c.cursedTurnsLeft || 0) > 0);
  if (allLocked && room.drawPile.length > 0) {
    const drawn = room.drawPile.pop();
    p.hand.push(drawn);
    log(room, `${p.name} - all hand cards Cursed-locked; auto-draws a ${drawn.rank}.`);
  }
}

function triggerGildedTurn(room, playerIdx) {
  const p = room.players[playerIdx];
  if (!p || p.eliminated || !p.hand) return;
  let gilded = 0;
  for (const c of p.hand) if (c.affix === 'gilded') gilded++;
  if (gilded > 0) {
    const got = applyGoldGain(p, gilded * GOLD_PER_GILDED_PER_TURN, 'gilded');
    if (got > 0) log(room, `${p.name} (Gilded × ${gilded}): +${got}g.`);
  }
}

// Spiked + Glass + Steel resolution when a player picks up the pile.
// Mutates the pile array in place (cards removed by Glass burns are gone).
// Returns the (possibly trimmed) pile to be appended to the picker's hand.
function applyPickupAffixes(room, picker, pile) {
  if (!pile || pile.length === 0) return pile;
  // 1) Spiked: each Spiked in the pile = picker draws +1 from draw pile.
  let spikedCount = pile.filter(c => c.affix === 'spiked').length;
  let drew = 0;
  while (spikedCount > 0 && room.drawPile.length > 0) {
    picker.hand.push(room.drawPile.pop());
    spikedCount--;
    drew++;
  }
  if (drew > 0) log(room, `Spiked: ${picker.name} draws +${drew}.`);
  // 2) Glass: each Glass card burns itself + GLASS_BURN_RANDOM random
  //    non-Steel pile cards. Track burned run-deck cards on the OWNER for
  //    Iron Stomach restoration at end of round.
  const glassCards = pile.filter(c => c.affix === 'glass');
  for (const glass of glassCards) {
    if (!pile.includes(glass)) continue;
    const burnedThisTrigger = [];
    const gi = pile.indexOf(glass);
    if (gi !== -1) pile.splice(gi, 1);
    burnedThisTrigger.push(glass);
    if (glass.owner !== undefined && glass.owner >= 0) {
      const owner = room.players[glass.owner];
      if (owner) owner._ironStomachBurned = (owner._ironStomachBurned || []).concat([glass.id]);
    }
    const burnable = pile.filter(c => c.affix !== 'steel');
    const sh = shuffle(burnable);
    const targets = sh.slice(0, GLASS_BURN_RANDOM);
    for (const t of targets) {
      const ti = pile.indexOf(t);
      if (ti !== -1) pile.splice(ti, 1);
      burnedThisTrigger.push(t);
      if (t.owner !== undefined && t.owner >= 0) {
        const owner = room.players[t.owner];
        if (owner) owner._ironStomachBurned = (owner._ironStomachBurned || []).concat([t.id]);
      }
    }
    // Track total burns this round
    room.burnedCards = (room.burnedCards || []).concat(burnedThisTrigger);
    log(room, `Glass: burned ${burnedThisTrigger.length} card${burnedThisTrigger.length === 1 ? '' : 's'} (${room.burnedCards.length}/${BURN_CAP} total).`);
    // Burn cap overflow — when total burns exceed cap, all burned cards
    // (including this trigger's) shuffle back into the draw pile.
    if (room.burnedCards.length > BURN_CAP) {
      const recycled = room.burnedCards.length;
      // Strip affixes? Design says recycled, not specified. Keep affixes intact.
      for (const c of room.burnedCards) room.drawPile.push(c);
      room.drawPile = shuffle(room.drawPile);
      room.burnedCards = [];
      log(room, `Burn cap reached — ${recycled} burned cards shuffled back into the draw pile. Counter resets.`);
    }
  }
  return pile;
}

// Iron Stomach: at end of round, restore burned run-deck cards as Steel.
function applyIronStomach(room) {
  for (const p of room.players) {
    if (!playerHasRelic(p, 'ironStomach')) {
      p._ironStomachBurned = [];
      continue;
    }
    const ids = p._ironStomachBurned || [];
    if (ids.length === 0) continue;
    const seen = new Set();
    let restored = 0;
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const card = (p.runDeck || []).find(c => c.id === id);
      if (card) { card.affix = 'steel'; restored++; }
    }
    if (restored > 0) log(room, `${p.name} - Iron Stomach: restored ${restored} burned card${restored === 1 ? '' : 's'} as Steel.`);
    p._ironStomachBurned = [];
  }
}

function jokerSlotsForFloor(floor) {
  // Act I (1-3): 2 slots, Act II (4-6): 3 slots, Act III (7-9): 5 slots.
  if (floor <= 3) return 2;
  if (floor <= 6) return 3;
  return 5;
}
function ensureJokerSlots(p, floor) {
  const want = jokerSlotsForFloor(floor);
  while ((p.jokers || []).length < want) p.jokers.push(null);
}

function regenerateShopOffer(room) {
  const consumables = SHOP_ITEMS.filter(i => i.type === 'consumable' || i.type === 'service');
  const enabledConsumables = consumables.filter(i => i.enabled);
  const pickedConsumables = shuffle(enabledConsumables).slice(0, SHOP_OFFER_CONSUMABLES);
  // Jokers — rarity weighted, exclude jokers any player already owns? In MP we just exclude by rarity.
  const jokers = SHOP_ITEMS.filter(i => i.type === 'joker');
  const pickedJokers = [];
  const remaining = jokers.slice();
  while (pickedJokers.length < SHOP_OFFER_JOKERS && remaining.length > 0) {
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
  // Relics removed from regular shop — they are awarded post-boss only.
  room.shopOffer = [].concat(pickedConsumables, pickedJokers);
  // Cards section: 3 randomly-rolled run-deck cards. 50% chance of an
  // affix from the positive-or-neutral pool (no Cursed). Mirrors the SP shop.
  const SHOP_CARD_AFFIXES = ['gilded', 'mirage', 'echo', 'hollow', 'glass', 'steel', 'spiked'];
  const SHOP_CARD_RANKS = ['A', 'K', 'Q', '10'];
  const SHOP_CARD_PRICE = 100;
  room.shopCardOffer = [];
  for (let i = 0; i < 3; i++) {
    const rank = SHOP_CARD_RANKS[Math.floor(Math.random() * SHOP_CARD_RANKS.length)];
    const hasAffix = Math.random() < 0.5;
    const affix = hasAffix ? SHOP_CARD_AFFIXES[Math.floor(Math.random() * SHOP_CARD_AFFIXES.length)] : null;
    room.shopCardOffer.push({
      offerId: 'shopcard_' + Date.now() + '_' + i + '_' + Math.floor(Math.random() * 100000),
      rank, affix, price: SHOP_CARD_PRICE,
      bought: {}, // map of playerId -> true once bought
    });
  }
}

// Compute the effective price of a shop card for a specific player.
// Discounts stack multiplicatively. Sources:
//   - RANDOM.EXE character: 20% off (compensates for affix-reroll volatility).
// Exposed so the client/state broadcast can show the buyer's true price.
function shopCardPriceFor(player, offer) {
  const base = (offer && offer.price) || 0;
  const cardDisc = (player && player.character && player.character.cardDiscount) || 0;
  let mult = 1;
  if (cardDisc > 0) mult *= (1 - cardDisc);
  return Math.max(1, Math.floor(base * mult));
}

// Buy a card from the shop's Cards section. Each player may buy each
// offer at most once. Base price is 100g; deck cap is 24. Effective price
// is computed per-player so a discounted character (RANDOM.EXE) doesn't
// accidentally discount everyone else in the same room.
function shopBuyCard(room, playerId, offerId) {
  const p = findPlayerById(room, playerId);
  if (!p) return { error: 'Not in room.' };
  if (room.phase !== 'fork') return { error: 'Shop is closed.' };
  const off = (room.shopCardOffer || []).find(c => c.offerId === offerId);
  if (!off) return { error: 'Card offer not found.' };
  if (off.bought && off.bought[playerId]) return { error: 'You already bought this card.' };
  const effectivePrice = shopCardPriceFor(p, off);
  if ((p.gold || 0) < effectivePrice) return { error: 'Not enough gold.' };
  if ((p.runDeck || []).length >= 24) return { error: 'Run deck is at the cap (24).' };
  p.gold -= effectivePrice;
  const newId = 'p' + room.players.indexOf(p) + '_shop_' + off.offerId;
  p.runDeck.push({ rank: off.rank, id: newId, owner: room.players.indexOf(p), affix: off.affix || null });
  off.bought = off.bought || {};
  off.bought[playerId] = true;
  log(room, p.name + ' bought a ' + off.rank + (off.affix ? ' [' + off.affix + ']' : ' (plain)') + ' for ' + effectivePrice + 'g.');
  return { ok: true };
}
function addPendingPeek(p, kind, payload) {
  p.pendingPeeks = p.pendingPeeks || [];
  p.pendingPeeks.push({ kind, payload });
}

// Generate a human-readable run seed like "4F2K-9A7B". Same alphabet as
// the solo client; players can share it for matched seeds in future runs.
function _generateRunSeed() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) s += '-';
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

function startRun(room) {
  room.runStarted = true;
  room.currentFloor = 1;
  room.runOver = false;
  room.runWinnerId = null;
  room.currentFloorModifier = null;
  room.seed = _generateRunSeed();
  room.currentBoss = isBossFloor(1) ? getBoss(1) : null;
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    p.runDeck = buildInitialRunDeck(i);
    p.hearts = STARTING_HEARTS;
    p.gold = STARTING_GOLD;
    p.roundsWon = 0;
    p.heartShards = 0;
    p.eliminated = false;
    p.jokers = [];
    ensureJokerSlots(p, 1);
    p.inventory = {};
    p.relics = [];
    applyCharacter(p);
  }
  room.phase = 'round';
  log(room, `Run started — Floor 1 of ${TOTAL_FLOORS}.`);
  startRound(room);
}

// ---------- Round dealer ----------
function buildRoundDeck(room) {
  const deck = [];
  for (let i = 0; i < BASE_JACKS_PER_ROUND; i++) {
    deck.push({ rank: 'J', id: 'rd_J_' + i, owner: -1, affix: null });
  }
  const buckets = { 'A': [], 'K': [], 'Q': [], '10': [], 'J': [] };
  for (const p of room.players) {
    for (const c of (p.runDeck || [])) {
      if (buckets[c.rank]) buckets[c.rank].push({ ...c });
    }
  }
  for (const r of Object.keys(buckets)) {
    const cards = buckets[r];
    const cap = (r === 'J')
      ? Math.max(0, ROUND_DECK_RANK_CAP - BASE_JACKS_PER_ROUND)
      : ROUND_DECK_RANK_CAP;
    if (cards.length <= cap) {
      for (const c of cards) deck.push(c);
      continue;
    }
    const affixed = shuffle(cards.filter(c => c.affix));
    const plain = shuffle(cards.filter(c => !c.affix));
    const ordered = affixed.concat(plain);
    for (let i = 0; i < cap; i++) deck.push(ordered[i]);
  }
  return shuffle(deck);
}

function applyFloorAffixesToDrawPile(drawPile, floor) {
  const target = Math.max(0, Math.min(9, floor | 0));
  if (target <= 0 || !drawPile || drawPile.length === 0) return 0;
  const candidates = drawPile.filter(c => !c.affix);
  if (candidates.length === 0) return 0;
  const sh = shuffle(candidates);
  const n = Math.min(target, sh.length);
  for (let i = 0; i < n; i++) {
    sh[i].affix = FLOOR_AFFIX_POOL[Math.floor(Math.random() * FLOOR_AFFIX_POOL.length)];
  }
  return n;
}

function startRound(room) {
  // Reset round-level state
  room.phase = 'round';
  room.burnedCards = [];
  for (const p of room.players) {
    p.hand = [];
    p.finishedThisRound = false;
  }
  room.pile = [];
  room.lastPlay = null;
  room.placements = [];
  room.challengeOpen = false;
  room.challengerIdx = -1;
  // Reset per-round flags
  room.echoArmedFor = -1;
  room.counterfeitUsedRound = {};
  room.counterfeitLockedRanks = {};
  room.sleightUsedRound = {};
  room.doubletalkArmed = {};
  room.doubletalkUsedRound = {};
  room.callersMarkFiredRound = {};   // Caller's Mark joker: first LIAR call only
  if (room.challengeTimer) { clearTimeout(room.challengeTimer); room.challengeTimer = null; }

  // The Apostate: reroll every run-deck card's affix to a fresh random one.
  // Run for every player whose character has apostateReroll. Done BEFORE
  // buildRoundDeck so the new affixes propagate into the dealt copies.
  // Steel is intentionally NOT exempt — that's the character's whole point.
  for (const p of room.players) {
    if (!p.character || !p.character.apostateReroll) continue;
    if (!Array.isArray(p.runDeck)) continue;
    let changed = 0;
    for (const card of p.runDeck) {
      if (!card || card.rank === 'J') continue; // never affix Jacks
      const next = FLOOR_AFFIX_POOL[Math.floor(Math.random() * FLOOR_AFFIX_POOL.length)];
      if (card.affix !== next) changed++;
      card.affix = next;
      // Cursed has a per-card turn lock; reset it since the affix is being
      // wholesale replaced.
      if (card.cursedTurnsLeft !== undefined) card.cursedTurnsLeft = 0;
    }
    if (changed > 0) {
      log(room, `${p.name} (RANDOM.EXE): ${changed} run-deck card${changed === 1 ? '' : 's'} rerolled their affix.`);
    }
  }

  // Build deck and deal
  const deck = buildRoundDeck(room);
  const hands = room.players.map(() => []);
  // Hoarder gets +1 hand size
  const handSizeFor = (p) => {
    const bonus = (p.character && p.character.handSizeBonus) || 0;
    return HAND_SIZE + bonus;
  };
  // Deal round-robin up to per-player hand size
  let dealIdx = 0;
  let round = 0;
  while (round < 10) {
    let dealt = 0;
    for (let i = 0; i < room.players.length; i++) {
      const p = room.players[i];
      if (p.eliminated) continue;
      if (hands[i].length < handSizeFor(p) && deck.length > 0) {
        hands[i].push(deck.pop());
        dealt++;
      }
    }
    if (dealt === 0) break;
    round++;
  }
  for (let i = 0; i < room.players.length; i++) {
    room.players[i].hand = hands[i];
  }
  room.drawPile = deck;

  // Jack-fairness — no player begins a round at their Jack limit.
  // Excess Jacks are pushed to the bottom of the draw pile; the top of the
  // draw pile (non-Jack only) is pulled up as replacements. If swap-eligible
  // non-Jack cards run out, the swap stops (best-effort).
  applyJackFairness(room);

  // Brittle floor modifier — every card becomes Glass for this round
  if (room.currentFloorModifier === 'brittle') {
    for (const p of room.players) for (const c of p.hand) c.affix = 'glass';
    for (const c of room.drawPile) c.affix = 'glass';
    log(room, 'Brittle floor: all cards are Glass this round.');
  } else {
    // Per-floor random-affix infusion on the draw pile
    const infused = applyFloorAffixesToDrawPile(room.drawPile, room.currentFloor);
    if (infused > 0) {
      log(room, `Floor ${room.currentFloor} static: ${infused} draw-pile card${infused === 1 ? '' : 's'} carry random affixes.`);
    }
  }

  // Gambler / Gambler's Mark — forced Cursed card on first round of each floor
  for (const p of room.players) {
    const hasMark = playerHasRelic(p, 'gamblersMark');
    const isGamblerChar = p.character && p.character.forcedCursedOnNewFloor;
    if ((hasMark || isGamblerChar) && (p.roundsWon || 0) === 0) {
      const r = ['A','K','Q','10'][Math.floor(Math.random()*4)];
      const cursedCard = {
        rank: r,
        id: 'curse_' + p.id + '_' + Date.now() + '_' + Math.floor(Math.random()*1000),
        owner: room.players.indexOf(p),
        affix: 'cursed',
      };
      markCursedOnEntry(cursedCard);
      p.hand.push(cursedCard);
    }
  }

  // Cracked Coin relic: +5g × hearts on round start
  for (const p of room.players) {
    if (playerHasRelic(p, 'crackedCoin')) {
      const got = applyGoldGain(p, 5 * (p.hearts || 0), 'crackedCoin');
      if (got > 0) log(room, `${p.name}'s Cracked Coin: +${got}g.`);
    }
  }

  // Eavesdropper joker: every 2 rounds, fuzzy match count from previous player
  for (const p of room.players) {
    if (!playerHasJoker(p, 'eavesdropper')) continue;
    const totalRounds = room.players.reduce((a, pp) => a + (pp.roundsWon || 0), 0);
    if (totalRounds - (p.eavesdropperLastFiredRound || -99) >= 2) {
      // The "previous player" is the one to our LEFT in seating order
      const myIdx = room.players.indexOf(p);
      const prev = room.players[(myIdx + room.players.length - 1) % room.players.length];
      if (prev && prev.hand && prev.hand.length > 0) {
        const matches = prev.hand.filter(c => c.rank === room.targetRank).length;
        const bucket = matches === 0 ? 'NONE' : matches <= 2 ? 'SOME' : 'MANY';
        addPendingPeek(p, 'eavesdropper', { source: prev.name, bucket });
        p.eavesdropperLastFiredRound = totalRounds;
      }
    }
  }

  // Cold Read joker: see 1 random card from each opponent
  for (const p of room.players) {
    if (playerHasJoker(p, 'coldRead')) {
      const peeks = [];
      for (const op of room.players) {
        if (op === p || op.eliminated || !op.hand || op.hand.length === 0) continue;
        const c = op.hand[Math.floor(Math.random() * op.hand.length)];
        peeks.push({ player: op.name, rank: c.rank });
      }
      if (peeks.length > 0) addPendingPeek(p, 'coldRead', peeks);
    }
  }

  // Bait character: round start peek at 1 random card from 1 random opponent
  for (const p of room.players) {
    if (!p.character || !p.character.peekAtRoundStart) continue;
    const opps = room.players.filter(op => op !== p && !op.eliminated && op.hand && op.hand.length > 0);
    if (opps.length === 0) continue;
    const target = opps[Math.floor(Math.random() * opps.length)];
    const c = target.hand[Math.floor(Math.random() * target.hand.length)];
    addPendingPeek(p, 'bait', { player: target.name, rank: c.rank });
  }

  // Whisper character: round start peek at next-seat opponent's random card
  for (const p of room.players) {
    if (!p.character || !p.character.whisperPeek) continue;
    const myIdx = room.players.indexOf(p);
    const dir = (room.whisperDirection && room.whisperDirection[p.id]) === 'right' ? -1 : 1;
    let nextIdx = myIdx;
    for (let n = 1; n < room.players.length; n++) {
      const ni = (myIdx + n * dir + room.players.length * room.players.length) % room.players.length;
      const np = room.players[ni];
      if (np && !np.eliminated && np.hand && np.hand.length > 0) { nextIdx = ni; break; }
    }
    const target = room.players[nextIdx];
    if (target && target !== p && target.hand.length > 0) {
      const c = target.hand[Math.floor(Math.random() * target.hand.length)];
      addPendingPeek(p, 'whisper', { player: target.name, direction: (dir === 1 ? 'left/next' : 'right/prev'), rank: c.rank });
    }
  }

  // Hand Mirror relic: same as Cold Read (overlap acceptable)
  for (const p of room.players) {
    if (playerHasRelic(p, 'handMirror')) {
      const peeks = [];
      for (const op of room.players) {
        if (op === p || op.eliminated || !op.hand || op.hand.length === 0) continue;
        const c = op.hand[Math.floor(Math.random() * op.hand.length)];
        peeks.push({ player: op.name, rank: c.rank });
      }
      if (peeks.length > 0) addPendingPeek(p, 'handMirror', peeks);
    }
  }

  // Pick first turn — first non-eliminated player. Done BEFORE the target
  // pick so the bias below can read the starter's run deck.
  room.currentTurnIdx = 0;
  for (let i = 0; i < room.players.length; i++) {
    if (!room.players[i].eliminated) { room.currentTurnIdx = i; break; }
  }

  // Target rank is biased toward whichever non-Jack rank the starter has
  // the most of in their RUN DECK (70% biased, 30% pure random). The run
  // deck is the persistent build (Forger / Distillation / shop swaps /
  // reward upgrades have all gone in there); reading from the dealt hand
  // was noisier and rewarded lucky deals over actual build choices.
  //
  // Tie rule: if there's no clear winner — top count shared by more than
  // one rank — fall back to pure random. So a stock 3-3-3-3 deck always
  // rolls random, and only intentional stacking biases the target.
  const TARGET_BIAS_CHANCE = 0.70;
  const _starter = room.players[room.currentTurnIdx];
  const _starterDeck = (_starter && _starter.runDeck) || [];
  const _counts = {};
  for (const r of RANKS_PLAYABLE) _counts[r] = 0;
  for (const c of _starterDeck) {
    if (_counts[c.rank] !== undefined) _counts[c.rank]++;
  }
  let _maxCount = 0;
  for (const r of RANKS_PLAYABLE) if (_counts[r] > _maxCount) _maxCount = _counts[r];
  const _top = RANKS_PLAYABLE.filter(r => _counts[r] === _maxCount);
  if (_maxCount > 0 && _top.length === 1 && Math.random() < TARGET_BIAS_CHANCE) {
    room.targetRank = _top[0];
  } else {
    room.targetRank = RANKS_PLAYABLE[Math.floor(Math.random() * RANKS_PLAYABLE.length)];
  }

  log(room, `Floor ${room.currentFloor} round — target rank: ${room.targetRank}.`);
  // Turn-start hook (Cursed tick + auto-draw + Gilded gold)
  onTurnStart(room, room.currentTurnIdx);
  triggerGildedTurn(room, room.currentTurnIdx);

  // Cheater boss (Floor 6): auto-play one random card from the first player's hand.
  if (room.currentBoss && room.currentBoss.id === 'cheater') {
    const firstP = room.players[room.currentTurnIdx];
    if (firstP && firstP.hand && firstP.hand.length > 0) {
      const c = firstP.hand[Math.floor(Math.random() * firstP.hand.length)];
      firstP.hand = firstP.hand.filter(x => x.id !== c.id);
      room.pile.push(c);
      room.lastPlay = { playerIdx: room.currentTurnIdx, claim: room.targetRank, count: 1, cardIds: [c.id] };
      log(room, `Cheater: ${firstP.name}'s first play is forced (auto-played a card as ${room.targetRank}).`);
      if (firstP.hand.length === 0) {
        firstP.finishedThisRound = true;
        room.placements.push(room.currentTurnIdx);
      }
      openChallengeWindow(room);
    }
  }
}

// ---------- Action handling ----------
function isPlayerActive(p) {
  return !p.eliminated && !p.finishedThisRound;
}

function activeCount(room) {
  return room.players.filter(isPlayerActive).length;
}

function findNextActiveIdx(room, fromIdx) {
  if (room.players.length === 0) return 0;
  let i = fromIdx;
  for (let n = 0; n < room.players.length; n++) {
    i = (i + 1) % room.players.length;
    if (isPlayerActive(room.players[i])) return i;
  }
  return fromIdx;
}

function handlePlay(room, playerId, cardIds) {
  const p = findPlayerById(room, playerId);
  if (!p) return { error: 'Not in room.' };
  const idx = room.players.indexOf(p);
  if (idx !== room.currentTurnIdx) return { error: 'Not your turn.' };
  if (room.challengeOpen) return { error: 'Challenge is open — wait.' };
  if (!isPlayerActive(p)) return { error: 'You are not active this round.' };
  if (!Array.isArray(cardIds) || cardIds.length === 0 || cardIds.length > 3) {
    return { error: 'Play 1–3 cards.' };
  }
  // Duplicate-id guard. Without this, a client sending ['X','X'] would clone
  // the card: it gets pushed to the pile twice but filtered from the hand
  // only once.
  const idSet = new Set(cardIds);
  if (idSet.size !== cardIds.length) return { error: 'Duplicate card in play.' };
  // Belt-and-suspenders: every id must be a string of reasonable length.
  // Stops a malicious client from sending oversized strings or non-strings.
  for (const id of cardIds) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 80) {
      return { error: 'Bad card id.' };
    }
  }
  const cards = [];
  for (const id of cardIds) {
    const c = p.hand.find(x => x.id === id);
    if (!c) return { error: 'You do not have that card.' };
    if (c.affix === 'cursed' && (c.cursedTurnsLeft || 0) > 0) {
      return { error: 'A Cursed card is locked for ' + c.cursedTurnsLeft + ' more of your turn(s).' };
    }
    cards.push(c);
  }
  // Remove from hand using the deduped set rather than the raw array — both
  // are equivalent now that we reject duplicates, but using the set is a bit
  // faster on an Array.includes check.
  p.hand = p.hand.filter(c => !idSet.has(c.id));
  // Add to pile
  for (const c of cards) room.pile.push(c);

  // Echo: peek for the previously-armed player on this play (reveals first card).
  if (room.echoArmedFor >= 0 && room.echoArmedFor !== idx && cards.length > 0) {
    const peeker = room.players[room.echoArmedFor];
    if (peeker) {
      addPendingPeek(peeker, 'echo', { player: p.name, rank: cards[0].rank, affix: cards[0].affix || null });
      log(room, `Echo's eye: ${peeker.name} sees ${p.name}'s first card.`);
    }
    room.echoArmedFor = -1;
  }

  // Hollow: each Hollow card played → draw a replacement.
  const hollowCount = cards.filter(c => c.affix === 'hollow').length;
  if (hollowCount > 0) {
    let drew = 0;
    for (let i = 0; i < hollowCount && room.drawPile.length > 0; i++) {
      const card = room.drawPile.pop();
      markCursedOnEntry(card);
      p.hand.push(card);
      drew++;
    }
    if (drew > 0) log(room, `${p.name} draws +${drew} (Hollow).`);
  }

  // Echoing floor modifier — 20% chance to publicly flash the first card
  if (room.currentFloorModifier === 'echoing' && cards.length > 0 && Math.random() < 0.2) {
    log(room, `Echoing: ${p.name}'s first card is a ${cards[0].rank}.`);
  }

  // Mirage cards are consumed (already removed when revealed in handleLiar; here
  // we eagerly remove them from run deck on play so they aren't re-dealt).
  for (const c of cards) {
    if (c.affix === 'mirage' && c.owner !== undefined && c.owner >= 0) {
      const owner = room.players[c.owner];
      if (owner && owner.runDeck) {
        owner.runDeck = owner.runDeck.filter(rc => rc.id !== c.id);
      }
    }
  }

  // If any Echo cards were played, arm THIS player to peek the next play.
  if (cards.some(c => c.affix === 'echo')) {
    room.echoArmedFor = idx;
  }

  room.lastPlay = {
    playerIdx: idx,
    claim: room.targetRank,
    count: cards.length,
    cardIds: cards.map(c => c.id),
  };
  log(room, `${p.name} plays ${cards.length} card${cards.length === 1 ? '' : 's'} as ${room.targetRank}.`);

  // Check finish (after Hollow draws which may un-finish them)
  if (p.hand.length === 0) {
    p.finishedThisRound = true;
    room.placements.push(idx);
    log(room, `${p.name} finished their hand.`);
  }

  // Hollow draws may push player past Jack limit
  checkJackCurse(room);

  // Open challenge window for next active player
  openChallengeWindow(room);

  return { ok: true };
}

function openChallengeWindow(room) {
  room.challengeOpen = true;
  const nextIdx = findNextActiveIdx(room, room.currentTurnIdx);
  room.challengerIdx = nextIdx;
  const challenger = room.players[nextIdx];
  let ms = challengeWindowMsFor(challenger);
  // Hot Seat from the player on challenger's left (the previous player)
  const leftIdx = (nextIdx === 0 ? room.players.length - 1 : nextIdx - 1);
  const left = room.players[leftIdx];
  if (left && playerHasJoker(left, 'hotSeat')) ms = Math.min(ms, HOT_SEAT_WINDOW_MS);
  // Auditor boss (floor 3): halved windows
  if (room.currentBoss && room.currentBoss.id === 'auditor') ms = Math.floor(ms / 2);
  room.challengeDeadline = Date.now() + ms;
  if (room.challengeTimer) clearTimeout(room.challengeTimer);
  room.challengeTimer = setTimeout(() => {
    if (!betaRooms[room.id]) return;
    if (!room.challengeOpen) return;
    // Race guard: if a human LIAR call is mid-resolution we must not also
    // fire the no-challenge fallback. _handleLiarInner sets the flag for
    // the duration of the resolution; if it races us, defer briefly and
    // re-check on the next tick.
    if (room.challengeInFlight) {
      setTimeout(() => {
        if (!betaRooms[room.id]) return;
        if (!room.challengeOpen) return;
        if (room.challengeInFlight) return; // give up — LIAR resolved it
        handlePassNoChallengeInternal(room);
        if (room._io) broadcast(room._io, room);
      }, 25);
      return;
    }
    handlePassNoChallengeInternal(room);
    if (room._io) broadcast(room._io, room);
  }, ms + 50);
}

function handlePass(room, playerId) {
  const p = findPlayerById(room, playerId);
  if (!p) return { error: 'Not in room.' };
  const idx = room.players.indexOf(p);
  if (!room.challengeOpen) return { error: 'Nothing to pass on.' };
  if (idx !== room.challengerIdx) return { error: 'Not your call.' };
  return handlePassNoChallengeInternal(room);
}

function handlePassNoChallengeInternal(room) {
  room.challengeOpen = false;
  if (room.challengeTimer) { clearTimeout(room.challengeTimer); room.challengeTimer = null; }
  room.challengeDeadline = null;
  // Round may end if too few active
  if (activeCount(room) <= 1) {
    return endRoundIfDone(room);
  }
  // Black Hole joker: successful Jack bluff → delete one non-Jack from hand
  if (room.lastPlay) {
    const lp = room.players[room.lastPlay.playerIdx];
    if (lp && playerHasJoker(lp, 'blackHole')) {
      const lastIds = room.lastPlay.cardIds || [];
      const playedCards = room.pile.filter(c => lastIds.includes(c.id));
      const allJacks = playedCards.length > 0 && playedCards.every(c => c.rank === 'J');
      if (allJacks) {
        const nonJ = (lp.hand || []).filter(c => c.rank !== 'J');
        if (nonJ.length > 0) {
          const target = nonJ[Math.floor(Math.random() * nonJ.length)];
          lp.hand = lp.hand.filter(c => c.id !== target.id);
          log(room, `${lp.name} - Black Hole: deleted a ${target.rank} from hand.`);
        }
      }
    }
  }
  // Advance turn to next active player AFTER the challenger position
  room.currentTurnIdx = findNextActiveIdx(room, room.challengerIdx - 1);
  // Turn-start hook (Cursed tick + auto-draw + Gilded gold)
  onTurnStart(room, room.currentTurnIdx);
  triggerGildedTurn(room, room.currentTurnIdx);
  return { ok: true };
}

function handleLiar(room, playerId) {
  // In-flight lock: same pattern as live server.js callLiar. Two near-
  // simultaneous LIAR calls (e.g. a bot timeout firing in the same tick as a
  // human click) used to both pass the validation block, both clear the pile,
  // and double-mutate room state. The flag plus try/finally guarantees only
  // one resolution per challenge window.
  if (room.challengeInFlight) return { error: 'Challenge already resolving.' };
  room.challengeInFlight = true;
  try {
    return _handleLiarInner(room, playerId);
  } finally {
    room.challengeInFlight = false;
  }
}

function _handleLiarInner(room, playerId) {
  const p = findPlayerById(room, playerId);
  if (!p) return { error: 'Not in room.' };
  const idx = room.players.indexOf(p);
  if (!room.challengeOpen) return { error: 'No claim to challenge.' };
  if (idx !== room.challengerIdx) return { error: 'Not your call.' };
  if (!room.lastPlay) return { error: 'No play to challenge.' };

  // Cursed in hand blocks the challenger from calling LIAR
  if ((p.hand || []).some(c => c.affix === 'cursed')) {
    return { error: 'A Cursed card in your hand blocks you from calling LIAR.' };
  }

  // Tariff floor modifier — each LIAR call costs 5g
  if (room.currentFloorModifier === 'tariff') {
    const cost = Math.min(p.gold || 0, 5);
    p.gold = (p.gold || 0) - cost;
    log(room, `Tariff: ${p.name} pays ${cost}g for the LIAR call.`);
  }

  const lastIds = room.lastPlay.cardIds || [];
  const claim = room.lastPlay.claim;
  const playedCards = room.pile.filter(c => lastIds.includes(c.id));
  // Mirage cards count as the target rank (one-time wildcard) — they're NOT lies.
  let wasLie;
  if (room.currentBoss && room.currentBoss.id === 'lugen' && playedCards.length > 0 && playedCards.every(c => c.rank === 'J')) {
    // Lugen final-boss: pure-Jack plays count as a lie (Jack bluffing is punished here).
    wasLie = true;
    log(room, 'Lugen: pure-Jack plays count as a lie.');
  } else {
    wasLie = playedCards.some(c => c.rank !== claim && c.rank !== 'J' && c.affix !== 'mirage');
  }

  room.challengeOpen = false;
  if (room.challengeTimer) { clearTimeout(room.challengeTimer); room.challengeTimer = null; }
  room.challengeDeadline = null;

  const liarIdx = room.lastPlay.playerIdx;
  const liarP = room.players[liarIdx];
  const challengerP = p;

  // Caller's Mark joker: the challenger's first LIAR call this round pays
  // out (+20g if right, -15g if wrong). Subsequent calls don't trigger.
  // Per-player flag lives on room.callersMarkFiredRound (reset in startRound).
  if (playerHasJoker(challengerP, 'callersMark') &&
      !(room.callersMarkFiredRound && room.callersMarkFiredRound[playerId])) {
    room.callersMarkFiredRound = room.callersMarkFiredRound || {};
    room.callersMarkFiredRound[playerId] = true;
    if (wasLie) {
      // Right call → +20g (run through applyGoldGain so Ledger / Greedy
      // / character multipliers stack correctly).
      const got = applyGoldGain(challengerP, 20, 'callersMark');
      log(room, `${challengerP.name} - Caller's Mark: clean read. +${got}g.`);
    } else {
      // Wrong call → -15g, clamped at 0 so we never push gold negative.
      const lost = Math.min(15, challengerP.gold || 0);
      challengerP.gold = (challengerP.gold || 0) - lost;
      log(room, `${challengerP.name} - Caller's Mark: wrong call. -${lost}g.`);
    }
  }

  // Mirage: any Mirage card revealed is consumed — remove from the liarP run deck
  for (const c of playedCards) {
    if (c.affix === 'mirage' && c.owner !== undefined && c.owner >= 0) {
      const owner = room.players[c.owner];
      if (owner && owner.runDeck) {
        owner.runDeck = owner.runDeck.filter(rc => rc.id !== c.id);
      }
    }
  }

  // Spiked Trap joker: truth-teller + challenged → challenger draws +3
  if (!wasLie && playerHasJoker(liarP, 'spikedTrap')) {
    let drew = 0;
    while (drew < SPIKED_TRAP_DRAWS && room.drawPile.length > 0) {
      challengerP.hand.push(room.drawPile.pop());
      drew++;
    }
    if (drew > 0) log(room, `${liarP.name} - Spiked Trap: ${challengerP.name} draws +${drew}.`);
  }

  if (wasLie) {
    log(room, `${challengerP.name} called LIAR — caught! ${liarP.name} takes the pile back.`);
    let pile = room.pile.slice();
    // Scapegoat joker: caught lying with Jack → Jack goes to challenger
    if (playerHasJoker(liarP, 'scapegoat')) {
      const jacks = playedCards.filter(c => c.rank === 'J');
      if (jacks.length > 0) {
        for (const j of jacks) {
          const i = pile.indexOf(j);
          if (i !== -1) {
            pile.splice(i, 1);
            challengerP.hand.push(j);
          }
        }
        log(room, `${liarP.name} - Scapegoat: ${jacks.length} Jack${jacks.length === 1 ? '' : 's'} sent to ${challengerP.name}.`);
      }
    }
    // Apply pickup affixes (Spiked draws + Glass burns)
    pile = applyPickupAffixes(room, liarP, pile);
    // Push remaining pile to liar's hand (mark Cursed on entry)
    markAllCursedOnEntry(pile);
    for (const c of pile) liarP.hand.push(c);
    room.pile = [];
    if (liarP.finishedThisRound) {
      liarP.finishedThisRound = false;
      const pos = room.placements.indexOf(liarIdx);
      if (pos !== -1) room.placements.splice(pos, 1);
    }
    room.currentTurnIdx = liarIdx;
    // Taxman joker: any other player with Taxman gets +10g if pickup was 5+
    if (pile.length + (playedCards.filter(c => c.rank === 'J' && playerHasJoker(liarP, 'scapegoat')).length) >= 5) {
      for (const tp of room.players) {
        if (tp === liarP) continue;
        if (playerHasJoker(tp, 'taxman')) {
          const got = applyGoldGain(tp, 10, 'taxman');
          if (got > 0) log(room, `${tp.name} - Taxman: +${got}g.`);
        }
      }
    }
  } else {
    log(room, `${challengerP.name} called LIAR — wrong! ${challengerP.name} takes the pile.`);
    let pile = room.pile.slice();
    pile = applyPickupAffixes(room, challengerP, pile);
    markAllCursedOnEntry(pile);
    for (const c of pile) challengerP.hand.push(c);
    room.pile = [];
    if (challengerP.finishedThisRound) {
      challengerP.finishedThisRound = false;
      const pos = room.placements.indexOf(idx);
      if (pos !== -1) room.placements.splice(pos, 1);
    }
    room.currentTurnIdx = idx;
    // Taxman triggers on the wrong-call pickup too
    if (pile.length >= 5) {
      for (const tp of room.players) {
        if (tp === challengerP) continue;
        if (playerHasJoker(tp, 'taxman')) {
          const got = applyGoldGain(tp, 10, 'taxman');
          if (got > 0) log(room, `${tp.name} - Taxman: +${got}g.`);
        }
      }
    }
  }

  // Turn-start hook (Cursed tick + auto-draw + Gilded gold)
  onTurnStart(room, room.currentTurnIdx);
  triggerGildedTurn(room, room.currentTurnIdx);

  // After taking pile, run Jack-curse check (in case picker now hits the Jack limit)
  checkJackCurse(room);

  // After taking pile, check round end
  if (activeCount(room) <= 1) {
    return endRoundIfDone(room);
  }
  return { ok: true };
}

// ---------- Round / floor / run resolution ----------
function pickClosestActivePlayer(room) {
  let best = -1, bestSize = Infinity;
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    if (!isPlayerActive(p)) continue;
    if (p.hand.length < bestSize) {
      best = i;
      bestSize = p.hand.length;
    }
  }
  if (best === -1) {
    // No active — pick the latest finisher
    best = room.placements[room.placements.length - 1] || 0;
  }
  return best;
}

function endRoundIfDone(room) {
  // If 0 or 1 active player remains, resolve round
  let winnerIdx;
  let message;
  if (room.placements.length === 0) {
    winnerIdx = pickClosestActivePlayer(room);
    message = `Nobody emptied their hand. ${room.players[winnerIdx].name} was closest.`;
  } else {
    winnerIdx = room.placements[0];
    message = `${room.players[winnerIdx].name} finished 1st`;
    if (room.placements.length >= 2) {
      message += `, ${room.players[room.placements[1]].name} 2nd`;
    }
    message += '.';
  }
  endRound(room, winnerIdx, message);
  return { ok: true, roundEnded: true };
}

function endRound(room, winnerIdx, message) {
  const winner = room.players[winnerIdx];
  log(room, `Round end: ${message}`);
  applyIronStomach(room);

  // Placement gold: 1st = +20g, 2nd = +10g
  if (room.placements.length >= 1) {
    const first = room.players[room.placements[0]];
    first.gold = (first.gold || 0) + GOLD_PLACE_1;
  }
  if (room.placements.length >= 2) {
    const second = room.players[room.placements[1]];
    second.gold = (second.gold || 0) + GOLD_PLACE_2;
  }

  // Round wins
  winner.roundsWon = (winner.roundsWon || 0) + 1;

  if (winner.roundsWon >= ROUNDS_TO_WIN_FLOOR) {
    endFloor(room, winnerIdx);
  } else {
    // Next round on same floor
    setTimeout(() => {
      if (!betaRooms[room.id]) return;
      startRound(room);
      if (room._io) broadcast(room._io, room);
    }, 1500);
  }
}

function endFloor(room, winnerIdx) {
  const winner = room.players[winnerIdx];
  log(room, `Floor ${room.currentFloor} cleared by ${winner.name}.`);
  // +Gold for floor winner
  winner.gold = (winner.gold || 0) + GOLD_PER_FLOOR_WIN;

  // Hearts loss for players with 0 round wins this floor (the laggers)
  const survivors = [];
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    if (p.eliminated) continue;
    if ((p.roundsWon || 0) === 0) {
      p.hearts = Math.max(0, (p.hearts || 0) - 1);
      log(room, `${p.name} lost a Heart (no round wins this floor) — ${p.hearts} left.`);
      // Heart shards (if won floor at 1 heart — doesn't apply to laggers)
      if (p.hearts <= 0) {
        p.eliminated = true;
        log(room, `${p.name} ran out of Hearts and is eliminated.`);
      } else {
        survivors.push(p);
      }
    } else {
      // Floor winner: heart-shard logic — winning at 1 Heart gives a shard
      if (i === winnerIdx && p.hearts === 1) {
        p.heartShards = (p.heartShards || 0) + 1;
        log(room, `${p.name} earned a Heart shard (${p.heartShards}/${HEART_SHARDS_REQUIRED}).`);
        if (p.heartShards >= HEART_SHARDS_REQUIRED) {
          p.hearts++;
          p.heartShards = 0;
          log(room, `${p.name} restored a Heart from shards!`);
        }
      }
      survivors.push(p);
    }
  }

  // Reset round wins for next floor
  for (const p of room.players) p.roundsWon = 0;

  // Check run end conditions
  const aliveCount = room.players.filter(p => !p.eliminated).length;
  if (aliveCount === 0) {
    endRun(room, null);
    return;
  }
  if (aliveCount === 1 && room.players.length > 1) {
    // Last player standing wins
    const sole = room.players.find(p => !p.eliminated);
    endRun(room, sole.id);
    return;
  }
  if (room.currentFloor >= TOTAL_FLOORS) {
    // Floor 9 cleared — winner clears the run; run ends for everyone
    endRun(room, winner.id);
    return;
  }

  // Boss floors: each player picks 1 of 2 relics from the boss's pool first.
  const beatenBoss = room.currentBoss;
  if (beatenBoss && BOSS_RELIC_POOL[beatenBoss.id]) {
    enterBossRelicPhase(room, beatenBoss);
    return;
  }
  // Otherwise enter the normal fork phase.
  enterForkPhase(room);
}

// ---------- Boss-relic offer phase ----------
function enterBossRelicPhase(room, boss) {
  room.phase = 'bossRelic';
  room.bossRelicOffer = {
    bossId: boss.id,
    bossName: boss.name,
    pool: BOSS_RELIC_POOL[boss.id].slice(),
    picks: {},  // playerId -> relicId picked
  };
  log(room, `Post-boss reward — pick 1 of 2 relics from ${boss.name}'s pool.`);
}

function pickBossRelic(room, playerId, relicId) {
  if (room.phase !== 'bossRelic') return { error: 'No relic offer active.' };
  const offer = room.bossRelicOffer;
  if (!offer) return { error: 'No relic offer active.' };
  const p = findPlayerById(room, playerId);
  if (!p) return { error: 'Not in room.' };
  if (offer.picks[playerId]) return { error: 'Already picked.' };
  if (!offer.pool.includes(relicId)) return { error: 'Relic not in this pool.' };
  if (playerHasRelic(p, relicId)) {
    // Convert to gold instead if already owned (rare edge case)
    const got = applyGoldGain(p, 75, 'bossRelicGold');
    log(room, `${p.name} already owns ${relicId} — took ${got}g instead.`);
  } else {
    p.relics = (p.relics || []).concat([relicId]);
    log(room, `${p.name} took the relic ${RELIC_CATALOG[relicId].name}.`);
  }
  offer.picks[playerId] = relicId;
  // If all eligible players have picked, move to fork phase
  const eligible = room.players.filter(x => !x.eliminated);
  const allPicked = eligible.every(x => offer.picks[x.id]);
  if (allPicked) enterForkPhase(room);
  return { ok: true };
}

// ---------- Fork phase ----------
function enterForkPhase(room) {
  room.phase = 'fork';
  room.forkPicks = {};
  // Decide if a Treasure node replaces Reward this floor (Act III non-boss only)
  const nextFloor = room.currentFloor + 1;
  const isAct3 = nextFloor >= 7 && nextFloor <= 9;
  const willBeBoss = isBossFloor(nextFloor);
  const forkOffersTreasure = isAct3 && !willBeBoss && Math.random() < TREASURE_CHANCE_ACT_III;
  room.forkOffer = {
    nextFloor,
    nextFloorIsBoss: willBeBoss,
    nextBoss: willBeBoss ? getBoss(nextFloor) : null,
    hasShop: true,
    hasReward: !forkOffersTreasure,
    hasEvent: true,
    hasTreasure: forkOffersTreasure,
    hasCleanse: true,
  };
  // Generate a new shop offer for this fork
  regenerateShopOffer(room);
  log(room, `Fork: pick Shop, Reward${forkOffersTreasure ? '/Treasure' : ''}, or Event before Floor ${nextFloor}.`);
}

function maybeAdvanceFromFork(room) {
  // All connected, non-eliminated players have hit "continue"
  const eligible = room.players.filter(p => !p.eliminated);
  if (eligible.length === 0) return;
  const allReady = eligible.every(p => room.forkPicks[p.id] === 'continue');
  if (!allReady) return;
  // Roll modifier for the new floor
  room.currentFloor++;
  room.currentBoss = isBossFloor(room.currentFloor) ? getBoss(room.currentFloor) : null;
  if (room.currentFloor >= 4 && !isBossFloor(room.currentFloor)) {
    const ids = Object.keys(FLOOR_MODIFIERS);
    room.currentFloorModifier = ids[Math.floor(Math.random() * ids.length)];
    log(room, `Floor ${room.currentFloor} modifier: ${FLOOR_MODIFIERS[room.currentFloorModifier].name}.`);
  } else {
    room.currentFloorModifier = null;
  }
  if (room.currentBoss) {
    log(room, `Boss floor ${room.currentFloor}: ${room.currentBoss.name} — ${room.currentBoss.desc}`);
  }
  // Reset per-floor flags
  room.loadedDieUsedFloor = {};
  for (const p of room.players) {
    if (playerHasJoker(p, 'tattletale')) {
      room.tattletaleChargesFloor[p.id] = 1;
    }
  }
  // Expand joker slots for the new act
  for (const p of room.players) ensureJokerSlots(p, room.currentFloor);
  log(room, `Advancing to Floor ${room.currentFloor}.`);
  startRound(room);
}

function pickFork(room, playerId, choice) {
  if (room.phase !== 'fork') return { error: 'Not in fork phase.' };
  const p = findPlayerById(room, playerId);
  if (!p) return { error: 'Not in room.' };
  if (p.eliminated) {
    room.forkPicks[playerId] = 'continue';
    return { ok: true };
  }
  // 'shop' / 'reward' / 'event' / 'treasure' / 'continue'
  // 'continue' is always allowed — it's the commit step from any prior pick.
  if (choice === 'continue') {
    room.forkPicks[playerId] = 'continue';
    return { ok: true };
  }
  // Lock: once a fork has been picked (browsing or resolved), block other
  // fork choices. Players must finish or 'continue' out before changing.
  // Without this guard a player could shop, take a Reward, then fire an
  // Event — grabbing every fork's payout from a single visit.
  const cur = room.forkPicks[playerId];
  if (cur && cur !== 'continue') {
    return { error: 'You already picked a fork — finish or continue first.' };
  }
  if (choice === 'reward') {
    if (!room.forkOffer.hasReward) return { error: 'Reward not offered this fork.' };
    if (!room.rewardOffers) room.rewardOffers = {};
    if (!room.rewardOffers[playerId]) {
      const ownedIds = (p.jokers || []).filter(j => j).map(j => j.id);
      const eligible = SHOP_ITEMS.filter(i => i.type === 'joker' &&
        !ownedIds.includes(i.id) &&
        ((JOKER_CATALOG[i.id] && JOKER_CATALOG[i.id].rarity) !== 'Legendary'));
      const picks = shuffle(eligible).slice(0, 2);
      room.rewardOffers[playerId] = picks.map(p2 => ({
        id: p2.id, name: p2.name, price: p2.price, desc: p2.desc, type: p2.type,
      }));
    }
    log(room, `${p.name} entered the Reward.`);
    room.forkPicks[playerId] = 'reward-browsing';
    return { ok: true };
  }
  if (choice === 'treasure') {
    if (!room.forkOffer.hasTreasure) return { error: 'Treasure not offered this fork.' };
    // Treasure: bigger gold + a guaranteed treasure-only relic.
    const gold = applyGoldGain(p, 120, 'treasure');
    const owned = p.relics || [];
    const candidates = TREASURE_RELIC_POOL.filter(rid => !owned.includes(rid));
    if (candidates.length > 0) {
      const pickId = candidates[Math.floor(Math.random() * candidates.length)];
      p.relics = (p.relics || []).concat([pickId]);
      // Gambler's Mark: +1 joker slot
      if (pickId === 'gamblersMark') {
        p.jokers.push(null);
      }
      log(room, `${p.name} took the Treasure (+${gold}g + treasure-relic ${RELIC_CATALOG[pickId].name}).`);
    } else {
      log(room, `${p.name} took the Treasure (+${gold}g, no new treasure relics available).`);
    }
    room.forkPicks[playerId] = 'treasure-resolved';
    return { ok: true };
  }
  if (choice === 'event') {
    const evt = EVENTS[Math.floor(Math.random() * EVENTS.length)];
    const result = evt.payout();
    if (result.gold > 0) {
      const got = applyGoldGain(p, result.gold, 'event');
      log(room, `${p.name} - Event "${evt.name}": ${evt.desc} (+${got}g)`);
    } else if (result.gold < 0) {
      const cost = Math.min(p.gold || 0, -result.gold);
      p.gold = (p.gold || 0) - cost;
      log(room, `${p.name} - Event "${evt.name}": ${evt.desc} (-${cost}g)`);
    } else {
      log(room, `${p.name} - Event "${evt.name}": ${evt.desc}`);
    }
    room.eventResults[playerId] = { event: evt.id, name: evt.name, desc: evt.desc, gold: result.gold };
    room.forkPicks[playerId] = 'event-resolved';
    return { ok: true };
  }
  if (choice === 'cleanse') {
    if (!room.forkOffer.hasCleanse) return { error: 'Cleanse not offered.' };
    // Mark as browsing — player will send a follow-up applyCleanse to choose target.
    room.forkPicks[playerId] = 'cleanse-browsing';
    return { ok: true };
  }
  if (choice === 'shop') {
    // Shop is interactive — player marks "browsing", buys items via separate events,
    // then sends 'continue' when done.
    room.forkPicks[playerId] = 'shop-browsing';
    return { ok: true };
  }
  return { error: 'Unknown fork choice.' };
}

// Pick a reward joker (or take 75g instead).
function rewardPick(room, playerId, choice) {
  const p = findPlayerById(room, playerId);
  if (!p) return { error: 'Not in room.' };
  if (room.phase !== 'fork') return { error: 'Reward closed.' };
  if (!room.rewardOffers || !room.rewardOffers[playerId]) return { error: 'No reward offer.' };
  if (choice && choice.gold) {
    const got = applyGoldGain(p, 75, 'rewardGold');
    log(room, `${p.name} took ${got}g instead of a Reward joker.`);
    delete room.rewardOffers[playerId];
    room.forkPicks[playerId] = 'reward-resolved';
    return { ok: true };
  }
  const itemId = choice && choice.itemId;
  const offer = room.rewardOffers[playerId];
  const item = offer.find(o => o.id === itemId);
  if (!item) return { error: 'Item not in your offer.' };
  if (playerHasJoker(p, item.id)) return { error: 'Already equipped.' };
  ensurePlayerJokerSlots(p); // legacy 2-slot players get grown to 5
  if (p.jokers.every(j => j !== null)) return { error: 'All joker slots full — take 75g instead.' };
  const data = JOKER_CATALOG[item.id];
  if (!data) return { error: 'Unknown joker.' };
  for (let i = 0; i < p.jokers.length; i++) {
    if (p.jokers[i] === null) { p.jokers[i] = { ...data }; break; }
  }
  if (item.id === 'tattletale') {
    room.tattletaleChargesFloor[p.id] = 1;
  }
  log(room, `${p.name} took the Reward joker: ${data.name}.`);
  delete room.rewardOffers[playerId];
  room.forkPicks[playerId] = 'reward-resolved';
  return { ok: true };
}

// Apply Cleanse — either remove a Cursed run-deck card (rare) or strip an
// affix from a run-deck card. target shape: { runDeckCardId, action: 'strip' }
// or { handCardId, action: 'removeCursed' }
function applyCleanse(room, playerId, target) {
  const p = findPlayerById(room, playerId);
  if (!p) return { error: 'Not in room.' };
  if (room.phase !== 'fork') return { error: 'Not in fork.' };
  if (room.forkPicks[playerId] !== 'cleanse-browsing') return { error: 'Pick Cleanse first.' };
  target = target || {};
  if (target.action === 'strip') {
    const card = (p.runDeck || []).find(c => c.id === target.runDeckCardId);
    if (!card) return { error: 'Run-deck card not found.' };
    if (!card.affix) return { error: 'That card has no affix to strip.' };
    log(room, `${p.name} cleansed: stripped ${card.affix} from a ${card.rank}.`);
    card.affix = null;
    room.forkPicks[playerId] = 'cleanse-resolved';
    return { ok: true };
  }
  if (target.action === 'removeCursed') {
    const card = (p.runDeck || []).find(c => c.id === target.runDeckCardId && c.affix === 'cursed');
    if (!card) return { error: 'Cursed run-deck card not found.' };
    p.runDeck = p.runDeck.filter(c => c.id !== card.id);
    log(room, `${p.name} cleansed: removed a Cursed ${card.rank} from their run deck.`);
    room.forkPicks[playerId] = 'cleanse-resolved';
    return { ok: true };
  }
  return { error: 'Pick action: strip or removeCursed.' };
}

// Buy from the shared shop offer; player-side gold check.
function shopBuy(room, playerId, itemId) {
  const p = findPlayerById(room, playerId);
  if (!p) return { error: 'Not in room.' };
  if (room.phase !== 'fork') return { error: 'Shop is closed.' };
  const item = (room.shopOffer || []).find(i => i.id === itemId);
  if (!item) return { error: 'Item not in shop offer.' };
  if (!item.enabled) return { error: 'Item not available.' };
  // Black Market: skip Jack-be-Nimble for owners.
  if (playerHasRelic(p, 'blackMarket') && item.id === 'jackBeNimble') {
    return { error: "Black Market: Jack-be-Nimble removed from your shop pool." };
  }
  // Black Market: 25% discount on the actual cost.
  const discount = playerHasRelic(p, 'blackMarket') ? 0.75 : 1;
  const realPrice = Math.ceil(item.price * discount);
  if ((p.gold || 0) < realPrice) return { error: 'Not enough gold.' };
  // Override the deduction below by stashing realPrice on the closure.
  item._realPrice = realPrice;
  if (item.type === 'joker') {
    if (playerHasJoker(p, item.id)) return { error: 'Already equipped.' };
    ensurePlayerJokerSlots(p); // grow legacy 2-slot players to 5
    const slotIdx = p.jokers.findIndex(j => j === null);
    if (slotIdx === -1) return { error: 'All joker slots full (' + p.jokers.length + ').' };
    const data = JOKER_CATALOG[item.id];
    if (!data) return { error: 'Unknown joker.' };
    p.gold -= (item._realPrice != null ? item._realPrice : item.price);
    p.jokers[slotIdx] = { ...data };
    if (item.id === 'tattletale') {
      room.tattletaleChargesFloor[p.id] = 1;
    }
    log(room, `${p.name} equipped joker: ${data.name} (-${item.price}g).`);
    return { ok: true };
  }
  if (item.type === 'relic') {
    if (playerHasRelic(p, item.id)) return { error: 'Already owned.' };
    p.gold -= (item._realPrice != null ? item._realPrice : item.price);
    p.relics = (p.relics || []).concat([item.id]);
    log(room, `${p.name} acquired relic: ${item.name} (-${item.price}g).`);
    return { ok: true };
  }
  if (item.type === 'consumable') {
    p.gold -= (item._realPrice != null ? item._realPrice : item.price);
    p.inventory[item.id] = (p.inventory[item.id] || 0) + 1;
    log(room, `${p.name} bought ${item.name} (-${item.price}g).`);
    return { ok: true };
  }
  if (item.type === 'service') {
    // Two-step: payment is held until the player picks a target. Mark as pending.
    if (!room.pendingServices) room.pendingServices = {};
    if (room.pendingServices[playerId]) return { error: 'You already have a service to apply.' };
    if ((p.gold || 0) < item.price) return { error: 'Not enough gold.' };
    p.gold -= (item._realPrice != null ? item._realPrice : item.price);
    room.pendingServices[playerId] = { itemId: item.id, price: item.price };
    log(room, `${p.name} bought ${item.name} (-${item.price}g) — pick a target.`);
    return { ok: true, pendingService: item.id };
  }
  return { error: 'Unknown item type.' };
}

// Apply a pending service. `target` shape depends on the service:
//   glassShard / spikedWire / steelPlating / mirageLens: { cardId }
//   stripper:                                              { cardId }
//   engraver:                                              { rank }
function applyService(room, playerId, target) {
  const p = findPlayerById(room, playerId);
  if (!p) return { error: 'Not in room.' };
  const ps = (room.pendingServices || {})[playerId];
  if (!ps) return { error: 'No pending service.' };
  const itemId = ps.itemId;
  target = target || {};

  const finalize = (msg) => {
    delete room.pendingServices[playerId];
    log(room, `${p.name} - ${msg}`);
    return { ok: true };
  };
  const refund = (msg) => {
    p.gold = (p.gold || 0) + ps.price;
    delete room.pendingServices[playerId];
    return { error: (msg || 'Service cancelled — gold refunded.') };
  };

  // Apply-an-affix services. Steel cards cannot be modified at all; every
  // other card (with or without an existing affix) can be overwritten.
  const affixMap = {
    glassShard: 'glass',
    spikedWire: 'spiked',
    steelPlating: 'steel',
    mirageLens: 'mirage',
  };
  if (affixMap[itemId]) {
    const card = (p.runDeck || []).find(c => c.id === target.cardId);
    if (!card) return { error: 'Card not found in your run deck.' };
    if (card.affix === 'steel') return { error: 'Steel cards cannot be changed.' };
    const prev = card.affix;
    card.affix = affixMap[itemId];
    const verb = prev ? `overwrote ${prev} with ${affixMap[itemId]}` : `applied ${affixMap[itemId]}`;
    return finalize(`${verb} on ${card.rank}.`);
  }

  if (itemId === 'stripper') {
    const card = (p.runDeck || []).find(c => c.id === target.cardId);
    if (!card) return { error: 'Card not found in your run deck.' };
    if (card.rank === 'J') return { error: 'Cannot strip a Jack.' };
    p.runDeck = p.runDeck.filter(c => c.id !== card.id);
    return finalize(`stripped a ${card.rank} from their run deck.`);
  }

  if (itemId === 'engraver') {
    const r = (target.rank || '').toUpperCase();
    if (!['A', 'K', 'Q', '10'].includes(r)) return { error: 'Pick a rank: A, K, Q, or 10.' };
    if ((p.runDeck || []).length >= 24) return refund('Run deck is at the cap (24).');
    const newId = 'p' + room.players.indexOf(p) + '_eng_' + r + '_' + Date.now() + '_' + Math.floor(Math.random()*1000);
    p.runDeck.push({ rank: r, id: newId, owner: room.players.indexOf(p), affix: null });
    return finalize(`engraved a new vanilla ${r} into their run deck (size ${p.runDeck.length}).`);
  }

  if (itemId === 'forger') {
    // Two-step: first call sends only sourceId; we stash it. Second call sends targetId; we clone.
    if (target.sourceId && !target.targetId) {
      const src = (p.runDeck || []).find(c => c.id === target.sourceId);
      if (!src) return { error: 'Source not found in your run deck.' };
      if (src.rank === 'J') return { error: 'Cannot use a Jack as the source.' };
      ps.forgerSourceId = src.id;
      // Don't finalize yet — wait for target
      return { ok: true, awaitingTarget: true };
    }
    if (target.targetId) {
      const sourceId = ps.forgerSourceId;
      if (!sourceId) return { error: 'Pick a source first.' };
      const src = (p.runDeck || []).find(c => c.id === sourceId);
      const tgt = (p.runDeck || []).find(c => c.id === target.targetId);
      if (!src) return { error: 'Source not found.' };
      if (!tgt) return { error: 'Target not found.' };
      if (tgt.id === src.id) return { error: 'Pick a different target.' };
      if (tgt.rank === 'J') return { error: 'Cannot target a Jack.' };
      tgt.rank = src.rank;
      tgt.affix = src.affix;
      return finalize(`forged ${tgt.id} into a ${src.rank}${src.affix ? ' [' + src.affix + ']' : ''}.`);
    }
    return { error: 'Pick a source first, then a target.' };
  }

  return refund('Service not yet wired.');
}

// Cancel a pending service (refund).
function cancelService(room, playerId) {
  const p = findPlayerById(room, playerId);
  if (!p) return { error: 'Not in room.' };
  const ps = (room.pendingServices || {})[playerId];
  if (!ps) return { error: 'No pending service.' };
  p.gold = (p.gold || 0) + ps.price;
  delete room.pendingServices[playerId];
  log(room, `${p.name} cancelled a service (refunded ${ps.price}g).`);
  return { ok: true };
}

function endRun(room, winnerId) {
  room.runOver = true;
  room.runWinnerId = winnerId;
  if (winnerId) {
    const w = room.players.find(p => p.id === winnerId);
    log(room, `Run over — ${w ? w.name : 'someone'} wins!`);
  } else {
    log(room, 'Run over — everyone is eliminated.');
  }
  // Progression report happens client-side (server fires a 'beta:runEnded' event
  // and clients POST to /api/beta/run-history etc.)
}

// ---------- Player management ----------
function addPlayer(room, socket, name, user) {
  if (room.players.length >= MAX_PLAYERS) return { error: `Room is full (${MAX_PLAYERS} max).` };
  if (room.runStarted) return { error: 'Run already started — cannot join mid-run.' };
  const displayName = (user && user.username) ||
                      ((name || '').trim().slice(0, 20) || `Player${room.players.length + 1}`);
  const player = {
    id: newId(),
    socketId: socket.id,
    userId: user ? user.id : null,
    username: user ? user.username : null,
    name: displayName,
    character: null,
    runDeck: [],
    hand: [],
    hearts: STARTING_HEARTS,
    gold: STARTING_GOLD,
    roundsWon: 0,
    heartShards: 0,
    eliminated: false,
    finishedThisRound: false,
    connected: true,
    removalTimer: null,
    // Roguelike resources
    jokers: [null, null, null, null, null],  // 5 slots, flat (no per-act ramp)
    inventory: {},             // consumableId -> count
    relics: [],                // relicId list
    eavesdropperLastFiredRound: -99,
    // Round-state notifications (delivered as private 'mine' fields once)
    pendingPeeks: [],          // [{ kind, payload }] cleared on next broadcast
  };
  room.players.push(player);
  socket.join(room.id);
  if (!room.hostId) room.hostId = player.id;
  log(room, `${displayName} joined the room.`);
  return { ok: true, player };
}

function pickCharacter(room, playerId, characterId) {
  const p = findPlayerById(room, playerId);
  if (!p) return { error: 'Not in room.' };
  if (room.runStarted) return { error: 'Run already in progress.' };
  const ch = CHARACTERS[characterId];
  if (!ch) return { error: 'Unknown character.' };
  p.character = ch;
  log(room, `${p.name} picked ${ch.name}.`);
  return { ok: true };
}

function removePlayer(room, playerId) {
  const idx = room.players.findIndex(p => p.id === playerId);
  if (idx === -1) return false;
  const wasHost = room.hostId === playerId;
  const removed = room.players[idx];
  room.players.splice(idx, 1);
  if (room.players.length === 0) {
    delete betaRooms[room.id];
    return true;
  }
  if (wasHost) {
    const nh = room.players.find(p => p.connected) || room.players[0];
    room.hostId = nh.id;
  }
  log(room, `${removed.name} left.`);
  // Adjust current turn if needed
  if (room.runStarted) {
    if (room.currentTurnIdx >= room.players.length) room.currentTurnIdx = 0;
    if (activeCount(room) <= 1) {
      // Force round end
      endRoundIfDone(room);
    }
  }
  return true;
}

// Jack-fairness deal rule. Limit-1 max Jacks at deal time. Swap excess to
// bottom of draw pile, pulling non-Jacks from the top.
function applyJackFairness(room) {
  for (const p of room.players) {
    if (!p || !p.hand) continue;
    let limit = jackLimitFor(p);
    if (room.currentFloorModifier === 'greedy') limit = 3;
    let jacks = p.hand.filter(c => c.rank === 'J');
    while (jacks.length >= limit) {
      // Find a non-Jack at the top of the draw pile
      let swapIdx = -1;
      for (let i = room.drawPile.length - 1; i >= 0; i--) {
        if (room.drawPile[i].rank !== 'J') { swapIdx = i; break; }
      }
      if (swapIdx === -1) break;
      // Pop a Jack from hand, push to bottom of draw pile (start of array).
      const jackOut = jacks[jacks.length - 1];
      p.hand = p.hand.filter(c => c.id !== jackOut.id);
      room.drawPile.unshift(jackOut);
      // The swapIdx may have shifted by 1 now; recompute.
      let newIdx = -1;
      for (let i = room.drawPile.length - 1; i >= 0; i--) {
        if (room.drawPile[i].rank !== 'J') { newIdx = i; break; }
      }
      if (newIdx === -1) break;
      const swapIn = room.drawPile[newIdx];
      room.drawPile.splice(newIdx, 1);
      p.hand.push(swapIn);
      jacks = p.hand.filter(c => c.rank === 'J');
    }
  }
}

// Jack-curse elimination — too many Jacks in hand eliminates the player from
// the round. Vengeful Spirit drags the next active player down too.
function checkJackCurse(room) {
  let any = false;
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    if (p.eliminated || p.finishedThisRound) continue;
    const jacks = (p.hand || []).filter(c => c.rank === 'J').length;
    let limit = jackLimitFor(p);
    if (room.currentFloorModifier === 'greedy') limit = 3;
    if (jacks >= limit) {
      p.eliminated = true;
      any = true;
      log(room, `${p.name} - Jack curse: ${jacks} Jacks (limit ${limit}). Eliminated from this round.`);
      if (playerHasJoker(p, 'vengefulSpirit')) {
        for (let n = 1; n < room.players.length; n++) {
          const ni = (i + n) % room.players.length;
          const np = room.players[ni];
          if (!np || np.eliminated || np.finishedThisRound) continue;
          np.eliminated = true;
          log(room, `${np.name} - Vengeful Spirit pulls them down too.`);
          break;
        }
      }
    }
  }
  if (any) {
    const cur = room.players[room.currentTurnIdx];
    if (!cur || cur.eliminated || cur.finishedThisRound) {
      room.currentTurnIdx = findNextActiveIdx(room, room.currentTurnIdx);
    }
  }
  return any;
}

// ---------- Tattletale active ----------
function useTattletale(room, playerId, targetIdx) {
  const p = findPlayerById(room, playerId);
  if (!p) return { error: 'Not in room.' };
  if (!playerHasJoker(p, 'tattletale')) return { error: 'You do not have Tattletale.' };
  const charges = (room.tattletaleChargesFloor && room.tattletaleChargesFloor[playerId]) || 0;
  if (charges <= 0) return { error: 'No Tattletale charges left this floor.' };
  if (typeof targetIdx !== 'number' || targetIdx < 0 || targetIdx >= room.players.length) {
    return { error: 'Invalid target.' };
  }
  const target = room.players[targetIdx];
  if (!target || target.eliminated || target.id === playerId) return { error: 'Invalid target.' };
  room.tattletaleChargesFloor[playerId] = charges - 1;
  const cards = (target.hand || []).map(c => ({ rank: c.rank, affix: c.affix || null }));
  addPendingPeek(p, 'tattletale', { target: target.name, cards, ms: TATTLETALE_PEEK_MS });
  log(room, `${p.name} peeked at ${target.name}'s hand (Tattletale).`);
  return { ok: true };
}

// ---------- Consumables ----------
function useConsumable(room, playerId, itemId, options) {
  const p = findPlayerById(room, playerId);
  if (!p) return { error: 'Not in room.' };
  if (room.phase !== 'round') return { error: 'Cannot use consumables outside a round.' };
  if (!p.inventory || (p.inventory[itemId] || 0) < 1) return { error: 'You do not own that.' };
  const idx = room.players.indexOf(p);
  options = options || {};

  if (itemId === 'smokeBomb') {
    if (idx !== room.currentTurnIdx) return { error: 'Use Smoke Bomb on your turn.' };
    if (room.challengeOpen) return { error: 'Cannot use during a challenge.' };
    p.inventory[itemId]--;
    log(room, `${p.name} used Smoke Bomb (skip turn).`);
    // Skip to next active player
    room.currentTurnIdx = findNextActiveIdx(room, idx);
    return { ok: true };
  }

  if (itemId === 'counterfeit') {
    if (idx !== room.currentTurnIdx) return { error: 'Use Counterfeit on your turn.' };
    if (room.counterfeitUsedRound[playerId]) return { error: 'Already used this round.' };
    const newRank = options.newRank;
    if (!RANKS_PLAYABLE.includes(newRank)) return { error: 'Invalid target rank.' };
    if (newRank === room.targetRank) return { error: 'Target is already that rank.' };
    p.inventory[itemId]--;
    room.counterfeitUsedRound[playerId] = true;
    room.counterfeitLockedRanks[playerId] = true;
    const oldRank = room.targetRank;
    room.targetRank = newRank;
    log(room, `${p.name} used Counterfeit: target ${oldRank} → ${newRank} (locked once).`);
    return { ok: true };
  }

  if (itemId === 'jackBeNimble') {
    if (idx !== room.currentTurnIdx) return { error: 'Use Jack-be-Nimble on your turn.' };
    const jacks = (p.hand || []).filter(c => c.rank === 'J').slice(0, 2);
    if (jacks.length === 0) return { error: 'No Jacks in hand.' };
    p.inventory[itemId]--;
    const ids = new Set(jacks.map(c => c.id));
    p.hand = p.hand.filter(c => !ids.has(c.id));
    log(room, `${p.name} used Jack-be-Nimble (discarded ${jacks.length} Jack${jacks.length === 1 ? '' : 's'}).`);
    return { ok: true };
  }

  if (itemId === 'tracer') {
    if (idx !== room.currentTurnIdx) return { error: 'Use Tracer on your turn.' };
    if (room.challengeOpen) return { error: 'Cannot use during a challenge.' };
    const top = room.drawPile.length;
    if (top === 0) return { error: 'Draw pile is empty.' };
    const perm = options && Array.isArray(options.perm) ? options.perm : null;
    if (!perm) {
      // First call: send the top 3 to the player as a peek; client requests again with permutation
      const topCount = Math.min(3, top);
      const tops = [];
      for (let i = 0; i < topCount; i++) {
        const c = room.drawPile[top - 1 - i];
        tops.push({ id: c.id, rank: c.rank, affix: c.affix || null });
      }
      addPendingPeek(p, 'tracerPeek', { topCards: tops });
      return { ok: true };
    }
    // perm contains indices [0..topCount-1] in the new top-first order.
    const topCount = Math.min(perm.length, top);
    const newTopFirst = [];
    for (let i = 0; i < topCount; i++) {
      const idx2 = perm[i];
      if (typeof idx2 !== 'number' || idx2 < 0 || idx2 >= topCount) return { error: 'Bad permutation.' };
      const c = room.drawPile[top - 1 - idx2];
      newTopFirst.push(c);
    }
    // Replace the top topCount cards in drawPile with newTopFirst (first one ends up at the top = last index)
    for (let i = 0; i < topCount; i++) {
      room.drawPile[top - 1 - i] = newTopFirst[i];
    }
    p.inventory[itemId]--;
    log(room, `${p.name} used Tracer.`);
    return { ok: true };
  }

  if (itemId === 'devilsBargain') {
    if (idx !== room.currentTurnIdx) return { error: 'Use Devil\'s Bargain on your turn.' };
    if (room.challengeOpen) return { error: 'Cannot use during a challenge.' };
    const handCardId = options && options.handCardId;
    const card = (p.hand || []).find(c => c.id === handCardId);
    if (!card) return { error: 'Pick a hand card.' };
    if (room.drawPile.length === 0) return { error: 'Draw pile empty.' };
    p.inventory[itemId]--;
    // Drop the chosen card to BOTTOM of draw pile
    p.hand = p.hand.filter(c => c.id !== card.id);
    room.drawPile.unshift(card);
    // Draw the top card; apply Cursed
    const drawn = room.drawPile.pop();
    drawn.affix = 'cursed';
    markCursedOnEntry(drawn);
    p.hand.push(drawn);
    log(room, `${p.name} used Devil's Bargain — gained a Cursed ${drawn.rank}.`);
    return { ok: true };
  }

  if (itemId === 'magnet') {
    if (idx !== room.currentTurnIdx) return { error: 'Use Magnet on your turn.' };
    if (room.challengeOpen) return { error: 'Cannot use during a challenge.' };
    const handCardId = options && options.handCardId;
    const card = (p.hand || []).find(c => c.id === handCardId);
    if (!card) return { error: 'Pick a hand card.' };
    if (card.affix === 'steel') return { error: 'Cannot give a Steel card.' };
    const opps = room.players.filter(op => op !== p && !op.eliminated && !op.finishedThisRound);
    if (opps.length === 0) return { error: 'No eligible opponent.' };
    p.inventory[itemId]--;
    p.hand = p.hand.filter(c => c.id !== card.id);
    const target = opps[Math.floor(Math.random() * opps.length)];
    markCursedOnEntry(card);
    target.hand.push(card);
    log(room, `${p.name} used Magnet — sent a ${card.rank} to ${target.name}.`);
    // Magnet can push receiver over Jack limit
    checkJackCurse(room);
    return { ok: true };
  }

  return { error: 'Consumable not yet wired in PvP.' };
}

// ---------- Loaded Die relic active ----------
function useLoadedDie(room, playerId) {
  const p = findPlayerById(room, playerId);
  if (!p) return { error: 'Not in room.' };
  if (!playerHasRelic(p, 'loadedDie')) return { error: 'You do not own Loaded Die.' };
  if (room.loadedDieUsedFloor && room.loadedDieUsedFloor[playerId]) return { error: 'Already used this floor.' };
  if (room.phase !== 'round') return { error: 'Round not active.' };
  const candidates = RANKS_PLAYABLE.filter(r => r !== room.targetRank);
  const newRank = candidates[Math.floor(Math.random() * candidates.length)];
  room.targetRank = newRank;
  room.loadedDieUsedFloor = room.loadedDieUsedFloor || {};
  room.loadedDieUsedFloor[playerId] = true;
  log(room, `${p.name} used Loaded Die: target rerolled to ${newRank}.`);
  return { ok: true };
}

// Whisper toggle direction — left/right neighbor for next round.
function setWhisperDirection(room, playerId, dir) {
  if (!room.whisperDirection) room.whisperDirection = {};
  if (dir !== 'left' && dir !== 'right') return { error: 'Bad direction.' };
  room.whisperDirection[playerId] = dir;
  return { ok: true };
}

// ---------- Admin cheats (host-only) ----------
function adminAddGold(room, playerId, amount) {
  const p = findPlayerById(room, playerId);
  if (!p) return { error: 'Not in room.' };
  if (room.hostId !== playerId) return { error: 'Host only.' };
  const n = Math.max(-9999, Math.min(9999, parseInt(amount, 10) || 0));
  p.gold = Math.max(0, (p.gold || 0) + n);
  log(room, `Admin: ${p.name} gold ${n >= 0 ? '+' : ''}${n} (now ${p.gold}g).`);
  return { ok: true };
}

function adminSetHearts(room, playerId, hearts) {
  const p = findPlayerById(room, playerId);
  if (!p) return { error: 'Not in room.' };
  if (room.hostId !== playerId) return { error: 'Host only.' };
  p.hearts = Math.max(0, Math.min(9, parseInt(hearts, 10) || 0));
  if (p.hearts > 0) p.eliminated = false;
  log(room, `Admin: ${p.name} hearts set to ${p.hearts}.`);
  return { ok: true };
}

function adminSkipFloor(room, playerId, floor) {
  const p = findPlayerById(room, playerId);
  if (!p) return { error: 'Not in room.' };
  if (room.hostId !== playerId) return { error: 'Host only.' };
  const n = Math.max(1, Math.min(TOTAL_FLOORS, parseInt(floor, 10) || 1));
  room.currentFloor = n;
  for (const pp of room.players) pp.roundsWon = 0;
  room.currentBoss = isBossFloor(n) ? getBoss(n) : null;
  if (n >= 4 && !isBossFloor(n)) {
    const ids = Object.keys(FLOOR_MODIFIERS);
    room.currentFloorModifier = ids[Math.floor(Math.random() * ids.length)];
  } else {
    room.currentFloorModifier = null;
  }
  log(room, `Admin: skipped to Floor ${n}.`);
  startRound(room);
  return { ok: true };
}

// ---------- Module exports ----------
module.exports = {
  betaRooms,
  CHARACTERS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  // Catalogs (exposed for client mirror reasons / debug)
  JOKER_CATALOG,
  RELIC_CATALOG,
  FLOOR_MODIFIERS,
  BOSS_CATALOG,
  TREASURE_RELIC_POOL,
  SHOP_ITEMS,
  // Constructors / lifecycle
  newBetaRoom,
  makeRoomId,
  addPlayer,
  removePlayer,
  pickCharacter,
  startRun,
  // Action handlers
  handlePlay,
  handlePass,
  handleLiar,
  // Fork phase
  pickFork,
  pickBossRelic,
  rewardPick,
  applyCleanse,
  shopBuy,
  shopBuyCard,
  applyService,
  cancelService,
  maybeAdvanceFromFork,
  // Roguelike actions
  useTattletale,
  useConsumable,
  useLoadedDie,
  setWhisperDirection,
  // Admin
  adminAddGold,
  adminSetHearts,
  adminSkipFloor,
  // State + broadcasting
  publicBetaState,
  broadcast,
  // Lookup
  findPlayerById,
  findPlayerBySocket,
};
