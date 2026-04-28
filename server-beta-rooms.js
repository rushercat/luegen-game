// server-beta-rooms.js — server-authoritative game state for beta multiplayer
// rooms. 2–4 humans share the same 9-floor run, each with their own personal
// run deck, hearts, and gold. MVP scope: core round/floor loop, hearts,
// best-of-3 floors, run end. Jokers / consumables / affixes / forks / shop /
// modifiers are NOT yet wired and can layer on top in later phases.

const crypto = require('crypto');

// ============================================================
// BALANCE — All tunable numbers live in the top of this file. Group is
// organized: deck shape → economy → tempo → cap rules → affix tuning.
// If you find a balance number not in this region, lift it up here.
// ============================================================

// ---------- Deck / round shape ----------
const RANKS_PLAYABLE = ['A', 'K', 'Q', '10'];        // valid target ranks
const ALL_RANKS = ['A', 'K', 'Q', '10', 'J'];        // includes Jack (wild bluff)
const HAND_SIZE = 5;
const RUN_DECK_PER_RANK = 2;                          // each player: 2 of A/K/Q/10 = 8 cards (matches design doc)
const ROUND_DECK_RANK_CAP = 8;                        // max cards of any rank in a round
const BASE_JACKS_PER_ROUND = 6;                       // base J's added by the table
const STARTING_HEARTS = 3;
const ROUNDS_TO_WIN_FLOOR = 2;                        // best-of-3 → 2 wins clears the floor
const TOTAL_FLOORS = 9;
const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;

// ---------- Economy ----------
const GOLD_PLACE_1 = 20;
const GOLD_PLACE_2 = 10;
const GOLD_PER_FLOOR_WIN = 50;
const STARTING_GOLD = 50;

// ---------- Tempo ----------
const CHALLENGE_WINDOW_MS = 8 * 1000;
const HEART_SHARDS_REQUIRED = 3;

// ---------- Cap rules ----------
// Cap on how many of a single consumable a player may stockpile at once.
// Buying past the cap is rejected; using a consumable that bumps a counter
// (Lucky Charm) still pulls from inventory but never raises it past CAP.
const CONSUMABLE_CAP = 3;
// (More cap-style numbers further down: BURN_CAP, GOLD_PER_GILDED_PER_TURN,
// SPIKED_DRAWS_ON_PICKUP, GLASS_BURN_RANDOM, CURSED_TURN_LOCK, SPIKED_TRAP_DRAWS,
// TATTLETALE_PEEK_MS, SLOW_HAND_WINDOW_MS, HOT_SEAT_WINDOW_MS,
// POCKET_WATCH_BONUS_MS. Inlined where used for now — promote to this block
// when next touching them.)

// Character roster — kept in sync with public/beta.js characters. Server only
// honors the run-level effects (gold, run-deck Gilded), not jokers, since MVP
// doesn't run joker logic.
const CHARACTERS = {
  ace:       { id: 'ace',       name: 'The Ace',       startingJoker: 'sleightOfHand' },
  trickster: { id: 'trickster', name: 'The Trickster', startingJoker: 'doubletalk' },
  hoarder:   { id: 'hoarder',   name: 'The Hoarder',   handSizeBonus: 1, startingJoker: 'slowHand' },
  banker:    { id: 'banker',    name: 'The Banker',    startingGold: 0,   startingGildedA: true, startingJoker: 'surveyor' },
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
  vengefulSpirit: { id: 'vengefulSpirit', name: 'Vengeful Spirit',  rarity: 'Legendary', price: 400, desc: 'If a Jack curse eliminates you, the next active player loses 2 heart-shards (cascades to a Heart on underflow).' },
  callersMark:    { id: 'callersMark',    name: "Caller's Mark",    rarity: 'Uncommon',  price: 150, desc: "First LIAR call each round: +20g if right, -15g if wrong. Rewards reads, punishes spam." },
  screamer:       { id: 'screamer',       name: 'The Screamer',     rarity: 'Mythic',    price: 500, desc: 'Once per floor: name a rank. For the rest of that round, every card of that rank in any hand is publicly revealed.' },
  cardCounter:    { id: 'cardCounter',    name: 'Card Counter',     rarity: 'Uncommon',  price: 90,  desc: 'Always-on math overlay: see the live probability that the current target rank is still out in opponents\' hands.' },
  magpie:         { id: 'magpie',         name: 'Magpie',           rarity: 'Common',    price: 80,  desc: 'When an opponent picks up a pile, +1g per affixed card in it (you don\'t fire when YOU pick up the pile).' },
  hotPotato:      { id: 'hotPotato',      name: 'Hot Potato',       rarity: 'Uncommon',  price: 150, desc: 'Pick up a pile of 5+ cards: your next play allows up to 5 cards instead of 1-3 (one-shot per arm).' },
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
  auditor: { id: 'auditor', name: 'The Auditor', floor: 3, desc: 'Boss floor — every Nth play is auto-challenged. Count plays.' },
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
  { id: 'luckyCharm',    name: 'Lucky Charm',         price: 60,  desc: 'Use to add a stack: the NEXT shop visit gets +100% per stack on Rare / Legendary / Mythic joker chance. Stacks burn on the next shop.', enabled: true, type: 'consumable' },
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
  { id: 'vengefulSpirit',name: 'JOKER · Vengeful Spirit', price: 400, desc: '[Legendary] Jack-cursed: next active player loses 2 shards (cascades to ♥).', enabled: true, type: 'joker' },
  { id: 'screamer',      name: 'JOKER · The Screamer', price: 500, desc: '[Mythic] Once per floor: name a rank, all matching cards in every hand revealed for the rest of the round.', enabled: true, type: 'joker' },
  { id: 'cardCounter',   name: 'JOKER · Card Counter', price: 90,  desc: '[Uncommon] Always-on heatmap: probability the target rank is still out in opponents\' hands.', enabled: true, type: 'joker' },
  { id: 'magpie',        name: 'JOKER · Magpie',       price: 80,  desc: '[Common] Opponent picks up a pile: +1g per affixed card in it.', enabled: true, type: 'joker' },
  { id: 'hotPotato',     name: 'JOKER · Hot Potato',   price: 150, desc: '[Uncommon] Picking up 5+ cards arms a 5-card play next turn.', enabled: true, type: 'joker' },
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

// ---------- Seeded PRNG for fork variation ----------
// Mirrors the client (beta.js) so server picks line up with what a shared
// seed would imply. Deterministic per (run seed, floor).
function _seedToInt(seed) {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h || 1;
}
function _seededRng(seedInt) {
  let a = seedInt >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function floorRng(seed, floor) {
  const intSeed = _seedToInt((seed || 'NOSEED') + ':floor:' + (floor | 0));
  return _seededRng(intSeed);
}

// Mythic = same shop weight as Legendary (5). Renders red on the client.
const SHOP_RARITY_WEIGHTS = { Common: 60, Uncommon: 25, Rare: 10, Legendary: 5, Mythic: 5 };
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
  // Surveyor: top of draw pile (if me has it). Ascension tiers extend
  // the read: tier 1 = top 2 cards, tier 2 = top 3, tier 3+ = top 5.
  let surveyorTop = null;
  let surveyorTopList = null;
  if (me && playerHasJoker(me, 'surveyor') && room.drawPile && room.drawPile.length > 0) {
    const tier = ascensionTierFor(me, 'surveyor');
    const want = tier <= 0 ? 1 : tier === 1 ? 2 : tier === 2 ? 3 : 5;
    const got = Math.min(want, room.drawPile.length);
    surveyorTopList = [];
    for (let i = 0; i < got; i++) {
      const c = room.drawPile[room.drawPile.length - 1 - i];
      surveyorTopList.push({ rank: c.rank, affix: c.affix || null });
    }
    surveyorTop = surveyorTopList[0]; // back-compat for the single-card client field
  }
  // Card Counter (5.5): heatmap reading — probability the target rank is
  // still in opponents' hands. From me's POV: total target-rank copies in
  // the round = base 6 (the round deck has 6 each of A/K/Q/10) + however
  // many run-deck cards of that rank are owned by anyone. Subtract what
  // me knows: target cards in me's own hand, plus any visible elsewhere
  // (Screamer-revealed). Remaining unknowns are split between opponents'
  // hands, the played pile, the draw pile, and the burn pile by a uniform
  // prior — we just report "expected number of target cards in opponent
  // hands" and the equivalent percentage of opponent hand size.
  let targetRankReadout = null;
  if (me && playerHasJoker(me, 'cardCounter') && room.targetRank && room.phase === 'round') {
    const target = room.targetRank;
    // Total copies of target in this round's deck: 6 base + any run-deck
    // copies players own (capped at ROUND_DECK_RANK_CAP = 8 for safety).
    let totalCopies = 6;
    for (const pl of room.players) {
      for (const c of (pl.runDeck || [])) {
        if (c.rank === target) totalCopies += 1;
      }
    }
    totalCopies = Math.min(totalCopies, ROUND_DECK_RANK_CAP);
    // Subtract what me can see:
    let known = 0;
    if (me.hand) for (const c of me.hand) if (c.rank === target) known++;
    // Screamer-revealed cards of target rank in OTHER hands (visible to me)
    if (room.screamerRevealedRank === target) {
      for (const pl of room.players) {
        if (pl === me) continue;
        for (const c of (pl.hand || [])) if (c.rank === target) known++;
      }
    }
    // Pile + burn pile + drawPile are unknowns from me's POV unless
    // Surveyor reveals one. Count Surveyor-known top of draw if it's
    // target rank (cheap extra signal for stacked information builds).
    if (surveyorTop && surveyorTop.rank === target) known++;
    const unknown = Math.max(0, totalCopies - known);
    // Split unknowns by where they could plausibly live: other players'
    // hands vs. pile/burn/draw. Use the proportion of cards-in-opponent-
    // hands relative to (opp hands + pile + draw + burn). burnedCards is
    // out of play so it counts toward unreachable.
    let oppHandSizes = 0;
    for (const pl of room.players) {
      if (pl === me) continue;
      if (pl.eliminated) continue;
      oppHandSizes += (pl.hand || []).length;
    }
    const reachable = oppHandSizes;
    const unreachable = (room.pile || []).length +
                        (room.drawPile || []).length +
                        (room.burnedCards || []).length;
    const denom = Math.max(1, reachable + unreachable);
    const expectedInOpp = unknown * (reachable / denom);
    targetRankReadout = {
      target,
      known,
      totalCopies,
      unknown,
      // expected number of target-rank cards in opponents' hands right now
      expectedInOpp: Math.round(expectedInOpp * 10) / 10,
      // "danger" — probability AT LEAST ONE opponent hand has the rank
      // (1 - chance all opponents hold none), rough binomial approx
      atLeastOneProb: oppHandSizes <= 0 || unknown <= 0
        ? 0
        : Math.round((1 - Math.pow(1 - (reachable / denom), unknown)) * 100),
    };
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
    // Per-floor counter (was per-round buffer length). Display matches the
    // design doc's "live counter" of total burns toward the floor cap.
    burnedCount: room.burnedCountThisFloor || 0,
    burnedThisRound: (room.burnedCards || []).length,
    burnCap: BURN_CAP,
    // 7 — Public burn-pile faces (rank + affix). Lets the client render
    // small tiles instead of just the X/8 counter. Affix info is already
    // public via the live burn log; revealing the rank too matches the
    // design doc's "burn pile is visible to all players" wording.
    burnedFaces: (room.burnedCards || []).map(c => ({
      rank: c.rank, affix: c.affix || null,
    })),
    // 5.2 — spectator (eliminated-from-round) sees the draw pile contents
    // top-first. Active players never see this array.
    spectatorDrawPile: (me && me.eliminated && room.drawPile)
      ? room.drawPile.slice().reverse().map(c => ({ rank: c.rank, affix: c.affix || null }))
      : [],
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
    // Screamer's "publicly revealed rank" — when set, every player sees the
    // matching cards in every other player's hand. Counts only, not ids,
    // since the hidden cards never leave the server.
    screamerRevealedRank: room.screamerRevealedRank || null,
    // 5.2 — Spectator mode: a player who was round-eliminated by the
    // Jack curse (but whose run is still alive — `finishedThisRound`
    // means they finished cleanly; `eliminated && hearts > 0`-equivalent
    // is "round-out, run-on") gets extra visibility — opponents' real
    // hands and the draw pile. We expose this only to that specific
    // viewer by checking `me.eliminated`. Keeps run information secret
    // for everyone else.
    //
    // The `eliminated` field is overloaded: it flips true on Jack curse
    // mid-round AND on hearts-going-to-0 (run end). We treat them the
    // same here since both states mean "the round is over for me." The
    // run-end variant doesn't need spectator info but it's harmless.
    spectator: !!(me && me.eliminated),
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      username: p.username || null,
      characterId: p.character ? p.character.id : null,
      characterName: p.character ? p.character.name : (p.isLugen ? 'Final Boss' : null),
      // Hearts: Lugen has 99 internally so it can't be heart-eliminated;
      // display "∞" client-side instead of leaking the number.
      hearts: p.isLugen ? null : p.hearts,
      gold: p.isLugen ? null : p.gold,
      roundsWon: p.roundsWon,
      heartShards: p.heartShards || 0,
      handCount: p.hand ? p.hand.length : 0,
      runDeckCount: p.runDeck ? p.runDeck.length : 0,
      eliminated: !!p.eliminated,
      finishedThisRound: !!p.finishedThisRound,
      connected: !!p.connected,
      isLugen: !!p.isLugen,
      // Spectator-only field: the actual contents of this player's hand,
      // delivered only when the requesting player is round-eliminated.
      // Otherwise [], so nothing leaks to active players.
      spectatorHand: (me && me.eliminated && p !== me && p.hand)
        ? p.hand.map(c => ({ rank: c.rank, affix: c.affix || null }))
        : [],
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
      // If The Screamer is active this round, leak each player's matching
      // cards (rank+affix only — no ids, so the cards still can't be
      // referenced for play by anyone else).
      revealedCards: (room.screamerRevealedRank && p.hand)
        ? p.hand.filter(c => c.rank === room.screamerRevealedRank)
                .map(c => ({ rank: c.rank, affix: c.affix || null }))
        : [],
    })),
    mine: me
      ? {
          id: me.id,
          hand: (me.hand || []).map(c => ({ rank: c.rank, id: c.id, owner: c.owner, affix: c.affix || null, cursedTurnsLeft: c.cursedTurnsLeft || 0 })),
          runDeck: (me.runDeck || []).map(c => ({ rank: c.rank, id: c.id, affix: c.affix || null })),
          inventory: Object.assign({}, me.inventory || {}),
          jokers: (me.jokers || []).map(j => j ? {
            id: j.id, name: j.name, rarity: j.rarity, desc: j.desc,
            // 5.8 — pass through this player's ascension tier for the joker.
            ascensionTier: ascensionTierFor(me, j.id),
          } : null),
          relics: (me.relics || []).slice(),
          jokerAscensionTiers: Object.assign({}, me.jokerAscensionTiers || {}),
          tattletaleCharges: (room.tattletaleChargesFloor && room.tattletaleChargesFloor[me.id]) || 0,
          screamerCharges:   (room.screamerChargesFloor   && room.screamerChargesFloor[me.id])   || 0,
          loadedDieUsed: !!(room.loadedDieUsedFloor && room.loadedDieUsedFloor[me.id]),
          counterfeitUsedRound: !!(room.counterfeitUsedRound && room.counterfeitUsedRound[me.id]),
          // Doubletalk + Sleight of Hand: surface arm + per-round used flags
          // so the UI can render correct button states (was: silent, joker
          // looked broken to the player).
          doubletalkArmed:     !!(room.doubletalkArmed && room.doubletalkArmed[me.id]),
          doubletalkUsedRound: !!(room.doubletalkUsedRound && room.doubletalkUsedRound[me.id]),
          sleightUsedRound:    !!(room.sleightUsedRound && room.sleightUsedRound[me.id]),
          // Counterfeit's lock — a single shared flag while a Counterfeit
          // is in effect until the next LIAR resolution.
          targetLockedUntilLiar: !!room.targetLockedUntilLiar,
          peeks: myPeeks,
          surveyorTop,
          surveyorTopList, // ascension-extended list (tier 0 → 1 card, tier 1 → 2, tier 2 → 3, tier 3+ → 5)
          // Card Counter heatmap (null unless the player owns the joker)
          targetRankReadout,
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
    if (p.isLugen) continue; // Lugen has no socket; skip rather than crash io.to(null)
    io.to(p.socketId).emit('beta:state', publicBetaState(room, p.id));
  }
  // Schedule Lugen's next action if it's their turn or their challenge.
  tickLugen(io, room);
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
  // Use typeof check so a literal `0` (Banker now starts broke) actually
  // applies — `if (ch.startingGold)` would slip past 0 and leave the
  // default 50g, defeating the nerf.
  if (typeof ch.startingGold === 'number') player.gold = ch.startingGold;
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

// 5.8 — Ascension tier the player has on a particular joker (0 if they
// don't own this joker or haven't won runs with it). Tiers come from the
// auth-backend lookup that fires on join (server.js _attachAscensions);
// missing dict means tier 0 across the board.
function ascensionTierFor(p, jokerId) {
  if (!p || !p.jokerAscensionTiers) return 0;
  return Math.max(0, Math.min(4, p.jokerAscensionTiers[jokerId] || 0));
}
function challengeWindowMsFor(p) {
  let ms = CHALLENGE_WINDOW_MS;
  if (playerHasJoker(p, 'slowHand')) {
    // Ascension: each tier adds 2 more seconds. Tier 0 = 10s, tier 3 = 16s.
    const tier = ascensionTierFor(p, 'slowHand');
    ms = SLOW_HAND_WINDOW_MS + (tier * 2000);
  }
  // Pocket Watch stacks
  const pw = (p.relics || []).filter(r => r === 'pocketWatch').length;
  ms += pw * POCKET_WATCH_BONUS_MS;
  // The Sharp character: +1 second
  if (p.character && p.character.sharpChallengeBonusMs) ms += p.character.sharpChallengeBonusMs;
  return ms;
}
function jackLimitFor(p) {
  // Lugen's design-doc passive: Jack limit 6.
  if (p && p.isLugen) return 6;
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

// Glass burns fire ON REVEAL (every successful LIAR resolution that flips
// the played cards face-up), per the design doc. Each Glass card in the
// just-revealed plays burns itself + GLASS_BURN_RANDOM other random non-
// Steel cards from the wider pile (which can include prior plays). The
// trimmed pile is what subsequently gets distributed to the liar or the
// challenger. Burned cards are tracked on `room.burnedCards` for the
// per-round burn cap; on overflow they recycle into the draw pile.
//
// Pre-refactor (before this fix) Glass triggered inside applyPickupAffixes
// — i.e. only when somebody actually picked up a pile. That made Glass a
// no-op on passed challenges and broke the design's Glass-on-reveal rule.
function applyGlassBurnOnReveal(room, revealedCards) {
  if (!revealedCards || revealedCards.length === 0) return;
  const glassRevealed = revealedCards.filter(c => c.affix === 'glass');
  if (glassRevealed.length === 0) return;
  for (const glass of glassRevealed) {
    if (!room.pile.includes(glass)) continue;
    const burnedThisTrigger = [];
    const gi = room.pile.indexOf(glass);
    if (gi !== -1) room.pile.splice(gi, 1);
    burnedThisTrigger.push(glass);
    if (glass.owner !== undefined && glass.owner >= 0) {
      const owner = room.players[glass.owner];
      if (owner) owner._ironStomachBurned = (owner._ironStomachBurned || []).concat([glass.id]);
    }
    const burnable = room.pile.filter(c => c.affix !== 'steel');
    const sh = shuffle(burnable);
    const targets = sh.slice(0, GLASS_BURN_RANDOM);
    for (const t of targets) {
      const ti = room.pile.indexOf(t);
      if (ti !== -1) room.pile.splice(ti, 1);
      burnedThisTrigger.push(t);
      if (t.owner !== undefined && t.owner >= 0) {
        const owner = room.players[t.owner];
        if (owner) owner._ironStomachBurned = (owner._ironStomachBurned || []).concat([t.id]);
      }
    }
    room.burnedCards = (room.burnedCards || []).concat(burnedThisTrigger);
    // Per-floor burn counter: previously this was per-round, which let a
    // Glass build burn 8 cards every single round (24+ across a floor).
    // Now it accumulates across all rounds of the floor; reset only on
    // floor advance.
    room.burnedCountThisFloor = (room.burnedCountThisFloor || 0) + burnedThisTrigger.length;
    log(room, `Glass: burned ${burnedThisTrigger.length} card${burnedThisTrigger.length === 1 ? '' : 's'} (${room.burnedCountThisFloor}/${BURN_CAP} this floor).`);
    if (room.burnedCountThisFloor > BURN_CAP) {
      // Cap reached for the FLOOR. Recycle whatever's in the current
      // round's burn buffer back into the draw pile (we can't reach into
      // prior rounds — those cards already returned to their owners on
      // round-end). Reset the counter so a new burn cycle can begin.
      const recycled = room.burnedCards.length;
      for (const c of room.burnedCards) room.drawPile.push(c);
      room.drawPile = shuffle(room.drawPile);
      room.burnedCards = [];
      room.burnedCountThisFloor = 0;
      log(room, `Burn cap reached — ${recycled} burned cards (this round) shuffled back into the draw pile. Floor counter resets.`);
    }
  }
}

// Spiked + Steel resolution when a player picks up the pile.
// (Glass used to live here too — it now fires on reveal, see
// applyGlassBurnOnReveal above.)
// Returns the pile (untouched here; Glass already trimmed it on reveal).
function applyPickupAffixes(room, picker, pile) {
  if (!pile || pile.length === 0) return pile;
  // Spiked: each Spiked in the pile = picker draws +1 from draw pile.
  let spikedCount = pile.filter(c => c.affix === 'spiked').length;
  let drew = 0;
  while (spikedCount > 0 && room.drawPile.length > 0) {
    picker.hand.push(room.drawPile.pop());
    spikedCount--;
    drew++;
  }
  if (drew > 0) log(room, `Spiked: ${picker.name} draws +${drew}.`);
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
  // Lucky Charm boost — sums every player's accumulated stacks. Each stack
  // adds +100% to the rarity weight of Rare / Legendary / Mythic jokers
  // for THIS shop generation. Stacks burn here so the next shop is fresh.
  // Pooling across players is intentional: in PvP everyone shares the
  // shopOffer, so anyone can prime it for everyone (co-op-leaning).
  let luckStacks = 0;
  if (room.luckyCharmStacks) {
    for (const k of Object.keys(room.luckyCharmStacks)) {
      luckStacks += (room.luckyCharmStacks[k] || 0);
    }
  }
  const luckMult = 1 + luckStacks; // 1 stack → 2x, 2 stacks → 3x, etc.
  const BOOSTED = { Rare: true, Legendary: true, Mythic: true };
  const weightFor = (rarity) =>
    (SHOP_RARITY_WEIGHTS[rarity] || 1) * (BOOSTED[rarity] ? luckMult : 1);
  // Jokers — rarity weighted, exclude jokers any player already owns? In MP we just exclude by rarity.
  const jokers = SHOP_ITEMS.filter(i => i.type === 'joker');
  const pickedJokers = [];
  const remaining = jokers.slice();
  while (pickedJokers.length < SHOP_OFFER_JOKERS && remaining.length > 0) {
    let totalWeight = 0;
    for (const j of remaining) {
      const cat = JOKER_CATALOG[j.id];
      const rarity = cat ? cat.rarity : 'Common';
      totalWeight += weightFor(rarity);
    }
    let r = Math.random() * totalWeight;
    let pickedIdx = 0;
    for (let i = 0; i < remaining.length; i++) {
      const cat = JOKER_CATALOG[remaining[i].id];
      const rarity = cat ? cat.rarity : 'Common';
      r -= weightFor(rarity);
      if (r <= 0) { pickedIdx = i; break; }
    }
    pickedJokers.push(remaining[pickedIdx]);
    remaining.splice(pickedIdx, 1);
  }
  if (luckStacks > 0) {
    log(room, `Lucky Charm: ${luckStacks} stack${luckStacks === 1 ? '' : 's'} boosted Rare/Legendary/Mythic by ×${luckMult}. Stacks consumed.`);
    room.luckyCharmStacks = {};
  }
  // Relics removed from regular shop — they are awarded post-boss only.
  room.shopOffer = [].concat(pickedConsumables, pickedJokers);
  // 5.9 — Cards section is now FOUR cards: 2 plain (vanilla, no affix)
  // and 2 random-affixed. Plain stays cheap so a player can always pad
  // their build with reliable rank diversity; affixed costs more so it
  // remains the gambling slot.
  const SHOP_CARD_AFFIXES = ['gilded', 'mirage', 'echo', 'hollow', 'glass', 'steel', 'spiked'];
  const SHOP_CARD_RANKS = ['A', 'K', 'Q', '10'];
  const SHOP_CARD_PRICE_PLAIN  = 60;
  const SHOP_CARD_PRICE_AFFIX = 120;
  room.shopCardOffer = [];
  // 2 plain
  for (let i = 0; i < 2; i++) {
    const rank = SHOP_CARD_RANKS[Math.floor(Math.random() * SHOP_CARD_RANKS.length)];
    room.shopCardOffer.push({
      offerId: 'shopcard_plain_' + Date.now() + '_' + i + '_' + Math.floor(Math.random() * 100000),
      rank, affix: null, price: SHOP_CARD_PRICE_PLAIN,
      bought: {},
    });
  }
  // 2 affixed
  for (let i = 0; i < 2; i++) {
    const rank = SHOP_CARD_RANKS[Math.floor(Math.random() * SHOP_CARD_RANKS.length)];
    const affix = SHOP_CARD_AFFIXES[Math.floor(Math.random() * SHOP_CARD_AFFIXES.length)];
    room.shopCardOffer.push({
      offerId: 'shopcard_affix_' + Date.now() + '_' + i + '_' + Math.floor(Math.random() * 100000),
      rank, affix, price: SHOP_CARD_PRICE_AFFIX,
      bought: {},
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
  // Renamed from `newId` (which shadowed the imported helper at file top).
  const cardId = 'p' + room.players.indexOf(p) + '_shop_' + off.offerId;
  p.runDeck.push({ rank: off.rank, id: cardId, owner: room.players.indexOf(p), affix: off.affix || null });
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
  // Honor a pre-set seed (replay flow). startRunWithSeed sets room.seed
  // before calling startRun via setRoomSeed; this branch picks it up.
  // Otherwise roll a fresh seed.
  if (!room.seed || typeof room.seed !== 'string' || room.seed.length === 0) {
    room.seed = _generateRunSeed();
  }
  room.currentBoss = isBossFloor(1) ? getBoss(1) : null;
  // Per-floor charge counters — must exist before startRound runs so any
  // floor-1 char that grants Tattletale (e.g. The Sharp) sees a real charge.
  room.tattletaleChargesFloor = {};
  room.screamerChargesFloor = {};
  room.loadedDieUsedFloor = {};
  // Burn cap is per-floor — reset on run start and floor advance.
  room.burnedCountThisFloor = 0;
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
    // Seed Tattletale charge for any character that started with it
    // (currently The Sharp). Without this, floor 1's charge counter is 0
    // because the per-floor seeder only runs when ADVANCING to a new floor.
    if (playerHasJoker(p, 'tattletale')) {
      room.tattletaleChargesFloor[p.id] = 1 + ascensionTierFor(p, 'tattletale');
    }
    if (playerHasJoker(p, 'screamer')) {
      room.screamerChargesFloor[p.id] = 1;
    }
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
  // Per-round buffer (used for the recycle-into-draw-pile mechanic when
  // the per-floor cap fires) — clears every round. The PER-FLOOR counter
  // (room.burnedCountThisFloor) intentionally does NOT reset here; only
  // floor advance / boss progression clears it.
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
  // Clear the Counterfeit "lock" each round in case a round ended with no
  // LIAR call (e.g. someone emptied their hand on a passed challenge).
  room.targetLockedUntilLiar = false;
  // Auditor's per-round play counter. The boss's N is per-floor, but the
  // counter resets each round so the tell stays legible across rounds.
  room.auditorPlayCount = 0;
  // Screamer's "publicly revealed rank" lasts only the round it was named.
  room.screamerRevealedRank = null;
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
    // Lugen specials: 7-card opening hand (per design doc).
    if (p && p.isLugen) return 7;
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
    const len = room.players.length;
    let nextIdx = myIdx;
    for (let n = 1; n < len; n++) {
      // (n * dir) can be negative for the right-direction Whisper. A single
      // `+ len` is enough to make the modulus positive (n < len, so the most
      // negative offset is -(len-1) which + len ≥ 1). The earlier `len*len`
      // term was an overcautious guard.
      const ni = ((myIdx + n * dir) % len + len) % len;
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

  // BUG FIX — Cursed-on-deal lock. Any Cursed card sitting in a player's
  // opening hand (Apostate reroll, Gambler's forced curse, future shop
  // services) needs cursedTurnsLeft set BEFORE the first onTurnStart tick
  // fires (which would burn one of the locked turns immediately). We use
  // CURSED_TURN_LOCK + 1 so the post-tick value lines up with the
  // mid-turn entry path (Devil's Bargain / Magnet etc., where the card
  // arrives mid-turn and the first tick happens on the NEXT turn). Net
  // result: every Cursed card stays locked for 2 of the owner's turns no
  // matter how it entered the hand.
  for (const p of room.players) {
    if (!p.hand) continue;
    for (const c of p.hand) {
      if (c.affix === 'cursed' && (c.cursedTurnsLeft === undefined || c.cursedTurnsLeft <= 0)) {
        c.cursedTurnsLeft = CURSED_TURN_LOCK + 1;
      }
    }
  }

  // Pick first turn — rotate leadership so seat 0 doesn't always lead.
  // Within a floor: previous round's winner leads next round (room
  // .nextRoundLeaderIdx is set in endRound). Across floors / on run start,
  // we rotate by total rounds played so the long-run lead distribution is
  // even. If the chosen leader is eliminated, we walk forward to the next
  // active seat.
  let leadIdx;
  if (typeof room.nextRoundLeaderIdx === 'number' &&
      room.players[room.nextRoundLeaderIdx] &&
      !room.players[room.nextRoundLeaderIdx].eliminated) {
    leadIdx = room.nextRoundLeaderIdx;
  } else {
    const baseRotation = (room.totalRoundsStarted || 0) % room.players.length;
    leadIdx = baseRotation;
    for (let n = 0; n < room.players.length; n++) {
      const i = (baseRotation + n) % room.players.length;
      if (room.players[i] && !room.players[i].eliminated) { leadIdx = i; break; }
    }
  }
  room.currentTurnIdx = leadIdx;
  room.totalRoundsStarted = (room.totalRoundsStarted || 0) + 1;

  // Target rank: pure random per design doc. (Removed: an earlier 70%-bias
  // toward the starter's most-stacked run-deck rank, which compounded with
  // seat-0-always-leads to give one seat a target it could nearly always
  // play truthfully.)
  room.targetRank = RANKS_PLAYABLE[Math.floor(Math.random() * RANKS_PLAYABLE.length)];

  log(room, `Floor ${room.currentFloor} round — target rank: ${room.targetRank}.`);
  // Turn-start hook (Cursed tick + auto-draw + Gilded gold)
  onTurnStart(room, room.currentTurnIdx);
  triggerGildedTurn(room, room.currentTurnIdx);

  // Cheater boss (Floor 6): auto-play one random card from the first
  // player's hand. Honor the Cursed lock — a card with cursedTurnsLeft > 0
  // can't be played by the player normally, so the boss can't force-play
  // it either. (Skips silently if every card is locked, which is rare but
  // possible on a freshly-Cursed deal.)
  if (room.currentBoss && room.currentBoss.id === 'cheater') {
    const firstP = room.players[room.currentTurnIdx];
    if (firstP && firstP.hand && firstP.hand.length > 0) {
      const eligible = firstP.hand.filter(x =>
        !(x.affix === 'cursed' && (x.cursedTurnsLeft || 0) > 0));
      if (eligible.length === 0) {
        log(room, `Cheater: ${firstP.name}'s hand is fully Cursed-locked — force-play skipped this round.`);
      } else {
        const c = eligible[Math.floor(Math.random() * eligible.length)];
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
  // Doubletalk joker arms the play to allow 2-4 cards. The arm is consumed
  // when the play resolves (whether or not we hit the upper bound).
  const doubletalkOn = !!(room.doubletalkArmed && room.doubletalkArmed[playerId]);
  // 6.1 — Hot Potato (ported from solo): pickup of 5+ arms next play to
  // up to 5 cards. Stacks with Doubletalk → 2-5. Consumed after the play.
  const hotPotatoOn = !!(room.hotPotatoArmedFor && room.hotPotatoArmedFor[playerId]);
  const minCount = doubletalkOn ? 2 : 1;
  const maxCount = hotPotatoOn ? 5 : (doubletalkOn ? 4 : 3);
  if (!Array.isArray(cardIds) || cardIds.length < minCount || cardIds.length > maxCount) {
    return { error: doubletalkOn || hotPotatoOn
      ? 'Play ' + minCount + '–' + maxCount + ' cards.'
      : 'Play 1–3 cards.' };
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
  // Consume Doubletalk arm if it was used. The "once per round" guard
  // (doubletalkUsedRound) was already set when the player armed it.
  if (doubletalkOn) {
    room.doubletalkArmed[playerId] = false;
    log(room, `${p.name} - Doubletalk: played ${cards.length} cards.`);
  }
  // Consume Hot Potato arm whether or not the player used the +5 cap.
  if (hotPotatoOn) {
    room.hotPotatoArmedFor[playerId] = false;
    if (cards.length >= 4) {
      log(room, `${p.name} - Hot Potato: spent the bonus cap (${cards.length} cards).`);
    }
  }
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
  // Auditor boss (floor 3): every Nth play in the floor auto-fires the
  // challenger's LIAR call. N is rolled once per floor in [2..4] (excluding
  // 1 which would auto-fire every play, and 5+ which is barely noticeable).
  // Predictability is the tell — count plays and you'll know which one is
  // the forced reveal. (Was: half-window. Different mechanic, didn't match
  // the solo Auditor's behavior; this version mirrors solo.)
  if (room.currentBoss && room.currentBoss.id === 'auditor') {
    room.auditorPlayCount = (room.auditorPlayCount || 0) + 1;
    const N = room.auditorEveryN || 3;
    if (room.auditorPlayCount % N === 0) {
      log(room, `The Auditor flips its ledger — challenge incoming (every ${N} plays).`);
      // Defer one tick so client sees the play before the auto-resolution.
      // The deferred fire goes through handleLiar which has the same
      // in-flight lock as a human call — no double-resolution risk.
      room.challengeDeadline = Date.now() + 250;
      if (room.challengeTimer) clearTimeout(room.challengeTimer);
      room.challengeTimer = setTimeout(() => {
        if (!betaRooms[room.id]) return;
        if (!room.challengeOpen) return;
        if (room.challengeInFlight) return;
        handleLiar(room, challenger.id);
        if (room._io) broadcast(room._io, room);
      }, 250);
      return;
    }
  }
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

  // Clear Counterfeit's lock — the design says "lock through next LIAR",
  // which means *any* LIAR resolution releases the rank for further changes.
  room.targetLockedUntilLiar = false;

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

  // Glass triggers ON REVEAL — burn each played Glass + 2 random non-Steel
  // pile cards. This trims room.pile in place; whichever path picks up the
  // pile below sees the trimmed version. Was incorrectly running on pickup
  // only, which silently broke Glass on passed challenges.
  applyGlassBurnOnReveal(room, playedCards);

  // Spiked Trap joker: truth-teller + challenged → challenger draws +3.
  // Per design: "Fizzles if the pile has fewer than 3 left." We honor the
  // fizzle as all-or-nothing — partial draws used to make Spiked Trap
  // stronger than designed in shallow late-round states.
  if (!wasLie && playerHasJoker(liarP, 'spikedTrap')) {
    if (room.drawPile.length < SPIKED_TRAP_DRAWS) {
      log(room, `${liarP.name} - Spiked Trap fizzles (only ${room.drawPile.length} left in draw pile, needs ${SPIKED_TRAP_DRAWS}).`);
    } else {
      let drew = 0;
      while (drew < SPIKED_TRAP_DRAWS && room.drawPile.length > 0) {
        challengerP.hand.push(room.drawPile.pop());
        drew++;
      }
      log(room, `${liarP.name} - Spiked Trap: ${challengerP.name} draws +${drew}.`);
    }
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
    // 6.1 — Magpie joker (other players): +1g per affixed card the
    // pickup contains. Snapshotted BEFORE applyPickupAffixes since Spiked
    // draws come from the draw pile and don't change the pile composition,
    // but the snapshot is the public-info view at pickup time.
    const _affixedCount = pile.filter(c => c.affix).length;
    if (_affixedCount > 0) {
      for (const tp of room.players) {
        if (tp === liarP) continue;
        if (playerHasJoker(tp, 'magpie')) {
          const got = applyGoldGain(tp, _affixedCount, 'magpie');
          if (got > 0) log(room, `${tp.name} - Magpie: +${got}g (${_affixedCount} affixed in ${liarP.name}'s pickup).`);
        }
      }
    }
    // Apply pickup affixes (Spiked draws + Glass burns)
    pile = applyPickupAffixes(room, liarP, pile);
    // Push remaining pile to liar's hand (mark Cursed on entry)
    markAllCursedOnEntry(pile);
    for (const c of pile) liarP.hand.push(c);
    // 6.1 — Hot Potato (own joker): pickup of 5+ → arm next play to allow 5 cards.
    if (pile.length >= 5 && playerHasJoker(liarP, 'hotPotato')) {
      room.hotPotatoArmedFor = room.hotPotatoArmedFor || {};
      room.hotPotatoArmedFor[liarP.id] = true;
      log(room, `${liarP.name} - Hot Potato armed: next play allows up to 5 cards.`);
    }
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
    // Magpie: same as the wasLie branch but the picker is the challenger.
    const _affixedCount = pile.filter(c => c.affix).length;
    if (_affixedCount > 0) {
      for (const tp of room.players) {
        if (tp === challengerP) continue;
        if (playerHasJoker(tp, 'magpie')) {
          const got = applyGoldGain(tp, _affixedCount, 'magpie');
          if (got > 0) log(room, `${tp.name} - Magpie: +${got}g (${_affixedCount} affixed in ${challengerP.name}'s pickup).`);
        }
      }
    }
    pile = applyPickupAffixes(room, challengerP, pile);
    markAllCursedOnEntry(pile);
    for (const c of pile) challengerP.hand.push(c);
    // Hot Potato on a wrong-call pickup of 5+
    if (pile.length >= 5 && playerHasJoker(challengerP, 'hotPotato')) {
      room.hotPotatoArmedFor = room.hotPotatoArmedFor || {};
      room.hotPotatoArmedFor[challengerP.id] = true;
      log(room, `${challengerP.name} - Hot Potato armed: next play allows up to 5 cards.`);
    }
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
  // Lugen reseats after every LIAR call. Done AFTER all the index-
  // sensitive logic above (turn-advance, Jack curse, round-end check)
  // since reseating shifts indices around. The fixup helpers in
  // _shiftIndexesForRemove/Insert keep currentTurnIdx, challengerIdx,
  // placements, lastPlay.playerIdx, etc. consistent.
  _reseatLugen(room);
  return { ok: true };
}

// ---------- Round / floor / run resolution ----------
function pickClosestActivePlayer(room) {
  // Find the smallest hand size among active players, then pick uniformly
  // at random from the players tied at that size. Earlier code took the
  // first index, which compounded the seat-0 lead bias on edge-case round
  // resolutions where nobody emptied their hand.
  let bestSize = Infinity;
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    if (!isPlayerActive(p)) continue;
    if (p.hand.length < bestSize) bestSize = p.hand.length;
  }
  if (bestSize === Infinity) {
    // No active — pick the latest finisher (or seat 0 as a final fallback).
    const last = room.placements[room.placements.length - 1];
    return typeof last === 'number' ? last : 0;
  }
  const candidates = [];
  for (let i = 0; i < room.players.length; i++) {
    if (isPlayerActive(room.players[i]) && room.players[i].hand.length === bestSize) {
      candidates.push(i);
    }
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
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

  // Next round of this floor: the round winner leads. (startRound reads
  // this and falls back to a rotation if the chosen seat is eliminated.)
  room.nextRoundLeaderIdx = winnerIdx;

  if (winner.roundsWon >= ROUNDS_TO_WIN_FLOOR) {
    endFloor(room, winnerIdx);
  } else {
    // Next round on same floor — short delay so clients can render the
    // round-end state before the new deal lands. Was 1500ms; tightened to
    // 600ms to reduce the "stale state" race surface (see review 2.7).
    setTimeout(() => {
      if (!betaRooms[room.id]) return;
      startRound(room);
      if (room._io) broadcast(room._io, room);
    }, 600);
  }
}

function endFloor(room, winnerIdx) {
  const winner = room.players[winnerIdx];
  log(room, `Floor ${room.currentFloor} cleared by ${winner.name}.`);
  // +Gold for floor winner
  winner.gold = (winner.gold || 0) + GOLD_PER_FLOOR_WIN;

  // Pass 1 — heart loss for players with 0 round wins this floor (laggers).
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    if (p.eliminated) continue;
    if ((p.roundsWon || 0) === 0) {
      p.hearts = Math.max(0, (p.hearts || 0) - 1);
      log(room, `${p.name} lost a Heart (no round wins this floor) — ${p.hearts} left.`);
      if (p.hearts <= 0) {
        p.eliminated = true;
        log(room, `${p.name} ran out of Hearts and is eliminated.`);
      }
    }
  }
  // Pass 2 — heart-shard awards. Anyone still alive at exactly 1 Heart at
  // end of floor earns a shard (3 shards = +1 Heart). This includes the
  // runner-up who survived on 1 Heart but didn't win — design 4.7. The
  // earlier rule only awarded the floor winner, which felt unfair to a
  // last-place finisher who scrapped through on a single Heart.
  for (const p of room.players) {
    if (p.eliminated) continue;
    if (p.hearts === 1) {
      p.heartShards = (p.heartShards || 0) + 1;
      log(room, `${p.name} earned a Heart shard (${p.heartShards}/${HEART_SHARDS_REQUIRED}).`);
      if (p.heartShards >= HEART_SHARDS_REQUIRED) {
        p.hearts++;
        p.heartShards = 0;
        log(room, `${p.name} restored a Heart from shards!`);
      }
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
// Per-floor fork = exactly ONE offering, seeded by run seed + next floor.
// The player can either take the offered fork or skip (Continue) straight
// to the next floor. Pool: {Shop, Reward, Event, Cleanse, Treasure}, with
// Treasure only available on Act III non-boss floors. Deterministic so
// the same seed produces the same fork sequence every replay.
function enterForkPhase(room) {
  room.phase = 'fork';
  room.forkPicks = {};
  const nextFloor = room.currentFloor + 1;
  const isAct3 = nextFloor >= 7 && nextFloor <= 9;
  const willBeBoss = isBossFloor(nextFloor);

  const rng = floorRng(room.seed || 'NOSEED', nextFloor);
  const pool = ['shop', 'reward', 'event', 'cleanse'];
  if (isAct3 && !willBeBoss && rng() < TREASURE_CHANCE_ACT_III) {
    pool.push('treasure');
  }
  // Pick exactly ONE option deterministically.
  const idx = Math.floor(rng() * pool.length);
  const pick = pool[idx];

  room.forkOffer = {
    nextFloor,
    nextFloorIsBoss: willBeBoss,
    nextBoss: willBeBoss ? getBoss(nextFloor) : null,
    hasShop:     pick === 'shop',
    hasReward:   pick === 'reward',
    hasEvent:    pick === 'event',
    hasCleanse:  pick === 'cleanse',
    hasTreasure: pick === 'treasure',
  };
  // Always regenerate the shop offer in case the pick is shop. Cheap.
  regenerateShopOffer(room);
  const label = pick.charAt(0).toUpperCase() + pick.slice(1);
  log(room, `Fork: ${label} appears before Floor ${nextFloor}. Take it or skip.`);
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
      room.tattletaleChargesFloor[p.id] = 1 + ascensionTierFor(p, 'tattletale');
    }
    if (playerHasJoker(p, 'screamer')) {
      room.screamerChargesFloor = room.screamerChargesFloor || {};
      room.screamerChargesFloor[p.id] = 1;
    }
  }
  // Clear the round-leader pin so the new floor's first round picks via
  // rotation, not via "whoever won the last round of the previous floor."
  // Without this clear, the boss-floor winner would lead every round of
  // the next floor too.
  room.nextRoundLeaderIdx = null;
  // Reset the per-floor burn counter — Glass builds get 8 burns per floor,
  // not per round.
  room.burnedCountThisFloor = 0;
  // Auditor boss: roll N for "every Nth play auto-fires LIAR" once per
  // floor. Range [2..4] keeps the tell legible (1 = every play, too loud;
  // 5+ rarely fires in best-of-3).
  if (room.currentBoss && room.currentBoss.id === 'auditor') {
    room.auditorEveryN = 2 + Math.floor(Math.random() * 3);
    log(room, `The Auditor: every ${room.auditorEveryN} plays will be auto-challenged.`);
  } else {
    room.auditorEveryN = null;
  }
  // Expand joker slots for the new act
  for (const p of room.players) ensureJokerSlots(p, room.currentFloor);
  log(room, `Advancing to Floor ${room.currentFloor}.`);
  // Floor 9 boss: spawn Lugen as a real seat. (Solo Lugen has its own
  // floor-9 brain in beta.js; PvP needed an actual table presence.)
  if (room.currentBoss && room.currentBoss.id === 'lugen') {
    _spawnLugen(room);
  }
  // 5.6 — Last Stand: the FIRST time per run a player enters a floor at
  // exactly 1 Heart (and isn't eliminated), they get a free Smoke Bomb
  // OR +50g (50/50). The flag lives on the player so it can never fire
  // twice in the same run, even if they roller-coaster back to 1 Heart
  // multiple times.
  for (const p of room.players) {
    if (p.eliminated) continue;
    if (p.hearts !== 1) continue;
    if (p._lastStandUsed) continue;
    p._lastStandUsed = true;
    if (Math.random() < 0.5) {
      p.inventory = p.inventory || {};
      p.inventory.smokeBomb = (p.inventory.smokeBomb || 0) + 1;
      log(room, `${p.name} - Last Stand: free Smoke Bomb (1 Heart, first time).`);
    } else {
      const got = applyGoldGain(p, 50, 'lastStand');
      log(room, `${p.name} - Last Stand: +${got}g (1 Heart, first time).`);
    }
  }
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
  if (item.id === 'screamer') {
    room.screamerChargesFloor = room.screamerChargesFloor || {};
    room.screamerChargesFloor[p.id] = 1;
  }
  log(room, `${p.name} took the Reward joker: ${data.name}.`);
  delete room.rewardOffers[playerId];
  room.forkPicks[playerId] = 'reward-resolved';
  return { ok: true };
}

// Apply Cleanse — strip an affix from a run-deck card.
// target shape: { runDeckCardId, action: 'strip' }
//
// (The earlier `removeCursed` branch — delete a Cursed run-deck card —
// was only reachable for RANDOM.EXE, since the Apostate reroll is the
// only path that puts Cursed onto a run-deck card. The `strip` action
// already neutralizes a Cursed card by removing the affix, which covers
// that edge case without a separate code path. Branch removed.)
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
  return { error: 'Cleanse action must be: strip.' };
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
  // (Was: stashing realPrice on the shared `item` reference — gross and
  // fragile. realPrice is a local now and the per-type branches use it
  // directly.)
  if (item.type === 'joker') {
    if (playerHasJoker(p, item.id)) return { error: 'Already equipped.' };
    ensurePlayerJokerSlots(p); // grow legacy 2-slot players to 5
    const slotIdx = p.jokers.findIndex(j => j === null);
    if (slotIdx === -1) return { error: 'All joker slots full (' + p.jokers.length + ').' };
    const data = JOKER_CATALOG[item.id];
    if (!data) return { error: 'Unknown joker.' };
    p.gold -= realPrice;
    p.jokers[slotIdx] = { ...data };
    if (item.id === 'tattletale') {
      room.tattletaleChargesFloor[p.id] = 1 + ascensionTierFor(p, 'tattletale');
    }
    if (item.id === 'screamer') {
      room.screamerChargesFloor = room.screamerChargesFloor || {};
      room.screamerChargesFloor[p.id] = 1;
    }
    log(room, `${p.name} equipped joker: ${data.name} (-${realPrice}g).`);
    return { ok: true };
  }
  if (item.type === 'relic') {
    if (playerHasRelic(p, item.id)) return { error: 'Already owned.' };
    p.gold -= realPrice;
    p.relics = (p.relics || []).concat([item.id]);
    log(room, `${p.name} acquired relic: ${item.name} (-${realPrice}g).`);
    return { ok: true };
  }
  if (item.type === 'consumable') {
    // CONSUMABLE_CAP: don't let a single item's stockpile blow past the cap.
    // Verified BEFORE the gold deduction so a rejected purchase doesn't
    // also cost gold.
    const currentCount = (p.inventory[item.id] || 0);
    if (currentCount >= CONSUMABLE_CAP) {
      return { error: `You already hold ${CONSUMABLE_CAP} of ${item.name} (cap).` };
    }
    p.gold -= realPrice;
    p.inventory[item.id] = currentCount + 1;
    log(room, `${p.name} bought ${item.name} (-${realPrice}g).`);
    return { ok: true };
  }
  if (item.type === 'service') {
    // Two-step: payment is held until the player picks a target. Mark as pending.
    if (!room.pendingServices) room.pendingServices = {};
    if (room.pendingServices[playerId]) return { error: 'You already have a service to apply.' };
    // Use realPrice for the affordability check so the Black Market relic
    // (25% off) actually lets a player buy a service they can afford at the
    // discount. The earlier `< item.price` check rejected discounted buyers.
    if ((p.gold || 0) < realPrice) return { error: 'Not enough gold.' };
    p.gold -= realPrice;
    // Stash realPrice on the pending entry so a cancelService refund returns
    // the correct amount (was originally `item.price` — would have over-refunded
    // Black Market buyers).
    room.pendingServices[playerId] = { itemId: item.id, price: realPrice };
    log(room, `${p.name} bought ${item.name} (-${realPrice}g) — pick a target.`);
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
    // Use the cryptographically random helper (newId) instead of Date.now()
    // so back-to-back engraves can't collide. Local var renamed to avoid
    // shadowing the helper.
    const cardId = 'p' + room.players.indexOf(p) + '_eng_' + r + '_' + newId();
    p.runDeck.push({ rank: r, id: cardId, owner: room.players.indexOf(p), affix: null });
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
  // Lugen never claims a run win — if Lugen happens to be the last one
  // standing (every human eliminated), credit the last-finishing human
  // as the loser and report the run as a defeat (winnerId = null).
  if (winnerId) {
    const w = room.players.find(p => p.id === winnerId);
    if (w && w.isLugen) winnerId = null;
  }
  room.runOver = true;
  room.runWinnerId = winnerId;
  if (winnerId) {
    const w = room.players.find(p => p.id === winnerId);
    log(room, `Run over — ${w ? w.name : 'someone'} wins!`);
  } else {
    log(room, 'Run over — everyone is eliminated (Lugen prevails).');
  }
  // Despawn Lugen so a post-run lobby state doesn't show its seat.
  _despawnLugen(room);
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

// 5.3 — Pre-seed the room's run seed before startRun fires. Host-only
// (only the host should pin the seed for everyone). Restricted to the
// "lobby" phase so seeds can't be swapped mid-run. Letters/digits, no
// dashes — we strip dashes if the user pasted a "4F2K-9A7B" seed.
function setRoomSeed(room, playerId, seedRaw) {
  if (room.hostId !== playerId) return { error: 'Host only.' };
  if (room.runStarted) return { error: 'Run already started.' };
  const seed = (seedRaw || '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (seed.length < 4 || seed.length > 24) return { error: 'Bad seed format.' };
  // Re-insert the canonical dash form for display consistency with
  // _generateRunSeed (8 chars + dash + 8 chars). Shorter seeds keep their
  // raw form.
  const display = seed.length === 8 ? seed.slice(0, 4) + '-' + seed.slice(4) : seed;
  room.seed = display;
  log(room, `Seed set to ${display} for the next run.`);
  return { ok: true };
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
  const wasChallenger = room.challengeOpen && room.challengerIdx === idx;
  const wasCurrentTurn = room.currentTurnIdx === idx;
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
  // Re-fix any indices that referenced seats AFTER the splice point. All
  // earlier code stored seat indices (currentTurnIdx, challengerIdx,
  // placements, lastPlay.playerIdx, etc.); when we removed seat `idx`,
  // anything > idx slides down by 1 and anything === idx is now invalid.
  if (room.runStarted) {
    // currentTurnIdx
    if (room.currentTurnIdx > idx) room.currentTurnIdx -= 1;
    else if (wasCurrentTurn) room.currentTurnIdx = idx % room.players.length;
    if (room.currentTurnIdx >= room.players.length) room.currentTurnIdx = 0;
    // placements (1st/2nd-place finishers' seat indices)
    if (Array.isArray(room.placements)) {
      room.placements = room.placements
        .filter(p => p !== idx)
        .map(p => (p > idx ? p - 1 : p));
    }
    // echoArmedFor — armed-seat reference
    if (typeof room.echoArmedFor === 'number') {
      if (room.echoArmedFor === idx) room.echoArmedFor = -1;
      else if (room.echoArmedFor > idx) room.echoArmedFor -= 1;
    }
    // nextRoundLeaderIdx
    if (typeof room.nextRoundLeaderIdx === 'number') {
      if (room.nextRoundLeaderIdx === idx) room.nextRoundLeaderIdx = null;
      else if (room.nextRoundLeaderIdx > idx) room.nextRoundLeaderIdx -= 1;
    }
    // lastPlay
    if (room.lastPlay) {
      if (room.lastPlay.playerIdx === idx) room.lastPlay = null;
      else if (room.lastPlay.playerIdx > idx) room.lastPlay.playerIdx -= 1;
    }
    // Challenge window: if the leaving player WAS the challenger, the
    // window is dead — pass-no-challenge it cleanly so play doesn't stall.
    // Otherwise, just shift the index down if needed.
    if (room.challengeOpen) {
      if (wasChallenger) {
        if (room.challengeTimer) { clearTimeout(room.challengeTimer); room.challengeTimer = null; }
        room.challengeOpen = false;
        room.challengerIdx = -1;
        room.challengeDeadline = null;
        if (activeCount(room) > 1) {
          // Use the no-challenge fall-through to advance the turn cleanly.
          handlePassNoChallengeInternal(room);
        }
      } else if (room.challengerIdx > idx) {
        room.challengerIdx -= 1;
      }
    }
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

// Apply a -N shards penalty cascading into hearts when shards underflow.
// Used by Vengeful Spirit. Shards fill up to HEART_SHARDS_REQUIRED (3) per
// heart, so -2 from a player at full life (3 hearts, 0 shards) leaves them
// at "2 hearts + 1 shard" — i.e. 2 1/3 hearts. If shards go negative we
// pull from a heart (-1 heart, refill shards by HEART_SHARDS_REQUIRED).
// Caps at 0 hearts (can still mark eliminated downstream).
function applyShardPenalty(room, victim, n) {
  if (!victim || n <= 0) return;
  victim.heartShards = victim.heartShards || 0;
  let shards = victim.heartShards - n;
  while (shards < 0 && victim.hearts > 0) {
    victim.hearts -= 1;
    shards += HEART_SHARDS_REQUIRED;
    log(room, `${victim.name} loses a Heart from Vengeful Spirit (now ♥${victim.hearts} + ${shards} shard${shards === 1 ? '' : 's'}).`);
  }
  if (shards < 0) shards = 0;
  victim.heartShards = shards;
  if (victim.hearts <= 0) {
    victim.hearts = 0;
    if (!victim.eliminated) {
      victim.eliminated = true;
      log(room, `${victim.name} ran out of Hearts and is eliminated.`);
    }
  }
}

// Jack-curse elimination — too many Jacks in hand eliminates the player
// from the ROUND.
//
// Vengeful Spirit (Legendary joker): when YOU are eliminated by the curse,
// the next active player loses 2 heart-shards (cascading into a heart loss
// when shards underflow). This replaces an earlier "drag them into the
// round-elimination" effect, which was much stronger than the design
// intent. Shard-bleed is a long-term punishment that scales with how the
// run has gone — a low-shard victim feels it immediately.
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
          if (!np || np.eliminated) continue; // can hit a finished player
          log(room, `${np.name} - Vengeful Spirit: -2 shards.`);
          applyShardPenalty(room, np, 2);
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
    if (room.targetLockedUntilLiar) {
      return { error: 'Target rank is locked until the next LIAR resolution.' };
    }
    const newRank = options.newRank;
    if (!RANKS_PLAYABLE.includes(newRank)) return { error: 'Invalid target rank.' };
    if (newRank === room.targetRank) return { error: 'Target is already that rank.' };
    p.inventory[itemId]--;
    room.counterfeitUsedRound[playerId] = true;
    // Single room-level lock flag — blocks Loaded Die / future Counterfeits
    // until the next LIAR resolution clears it. (counterfeitLockedRanks dict
    // was set but never read; we replaced it with this flag.)
    room.targetLockedUntilLiar = true;
    const oldRank = room.targetRank;
    room.targetRank = newRank;
    log(room, `${p.name} used Counterfeit: target ${oldRank} → ${newRank} (locked until next LIAR).`);
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

  if (itemId === 'luckyCharm') {
    // No turn restriction — primes the next shop. The "stackable but you
    // have to USE it to be stackable" rule lives here: we increment a per-
    // player stack on every use and decrement inventory.
    p.inventory[itemId]--;
    room.luckyCharmStacks = room.luckyCharmStacks || {};
    room.luckyCharmStacks[playerId] = (room.luckyCharmStacks[playerId] || 0) + 1;
    log(room, `${p.name} used Lucky Charm — next shop is ×${1 + room.luckyCharmStacks[playerId]} on Rare/Legendary/Mythic.`);
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
  // Counterfeit's lock blocks any target-changing effect until the next
  // LIAR resolves. Without this check, a Counterfeit-locked target could
  // be flipped right back by a Loaded Die owner.
  if (room.targetLockedUntilLiar) {
    return { error: 'Target rank is locked until the next LIAR resolution.' };
  }
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

// ---------- Doubletalk active (joker) ----------
// Arms the player's NEXT play to allow 2-4 cards instead of 1-3. Once per
// round. handlePlay reads room.doubletalkArmed[playerId] and consumes the
// arm when the player actually plays.
function useDoubletalk(room, playerId) {
  const p = findPlayerById(room, playerId);
  if (!p) return { error: 'Not in room.' };
  if (!playerHasJoker(p, 'doubletalk')) return { error: 'You do not have Doubletalk.' };
  if (room.phase !== 'round') return { error: 'Round not active.' };
  const idx = room.players.indexOf(p);
  if (idx !== room.currentTurnIdx) return { error: 'Use Doubletalk on your turn.' };
  if (room.challengeOpen) return { error: 'Cannot arm during a challenge.' };
  if (room.doubletalkUsedRound && room.doubletalkUsedRound[playerId]) {
    return { error: 'Doubletalk already used this round.' };
  }
  if (room.doubletalkArmed && room.doubletalkArmed[playerId]) {
    return { error: 'Doubletalk is already armed — play 2–4 cards now.' };
  }
  room.doubletalkArmed = room.doubletalkArmed || {};
  room.doubletalkUsedRound = room.doubletalkUsedRound || {};
  room.doubletalkArmed[playerId] = true;
  room.doubletalkUsedRound[playerId] = true;
  log(room, `${p.name} - Doubletalk armed: next play is 2–4 cards.`);
  return { ok: true };
}

// ---------- Sleight of Hand active (joker) ----------
// Once per round on your turn: draw 1 card from the top of the draw pile.
function useSleightOfHand(room, playerId) {
  const p = findPlayerById(room, playerId);
  if (!p) return { error: 'Not in room.' };
  if (!playerHasJoker(p, 'sleightOfHand')) return { error: 'You do not have Sleight of Hand.' };
  if (room.phase !== 'round') return { error: 'Round not active.' };
  const idx = room.players.indexOf(p);
  if (idx !== room.currentTurnIdx) return { error: 'Use Sleight of Hand on your turn.' };
  if (room.challengeOpen) return { error: 'Cannot use during a challenge.' };
  if (room.sleightUsedRound && room.sleightUsedRound[playerId]) {
    return { error: 'Sleight of Hand already used this round.' };
  }
  if (!room.drawPile || room.drawPile.length === 0) return { error: 'Draw pile is empty.' };
  const drawn = room.drawPile.pop();
  markCursedOnEntry(drawn);
  p.hand.push(drawn);
  room.sleightUsedRound = room.sleightUsedRound || {};
  room.sleightUsedRound[playerId] = true;
  log(room, `${p.name} - Sleight of Hand: drew 1 card from the draw pile.`);
  return { ok: true };
}

// ============================================================
// Lugen — server-driven AI seat (PvP only). Joins the table on floor 9
// (the boss floor), takes turns automatically, and reseats randomly
// after every LIAR resolution so they don't always sit between the
// same two humans. Per design: 7-card opening hand, Jack limit 6,
// every play is randomly affixed.
// ============================================================

const LUGEN_AFFIX_POOL = ['gilded','glass','spiked','cursed','steel','mirage','hollow','echo'];
const LUGEN_PLAY_DELAY_MS    = 1500; // before Lugen plays
const LUGEN_CHALLENGE_DELAY_MS = 1100; // before Lugen calls/passes
const LUGEN_BLUFF_RATE       = 0.55; // mirrors solo
const LUGEN_CHALLENGE_RATE   = 0.45;

function _isLugen(p) { return !!(p && p.isLugen); }

function lugenSeated(room) {
  return room.players.findIndex(p => _isLugen(p));
}

function _spawnLugen(room) {
  if (lugenSeated(room) !== -1) return; // already seated
  const lugen = {
    id: 'lugen_' + newId(),
    socketId: null,
    userId: null,
    username: null,
    name: 'Lugen',
    character: null,        // Lugen has no character; passive lives in helpers
    isLugen: true,
    runDeck: [],            // Lugen doesn't get a run deck (rounds deal vanilla into its hand)
    hand: [],
    hearts: 99,             // effectively can't be heart-eliminated; round-elim still applies
    gold: 0,
    roundsWon: 0,
    heartShards: 0,
    eliminated: false,
    finishedThisRound: false,
    connected: true,        // pretend connected so broadcast doesn't try to send to it
    removalTimer: null,
    jokers: [null, null, null, null, null],
    inventory: {},
    relics: [],
    pendingPeeks: [],
  };
  // Random insertion position. Uses splice so all existing index-based
  // state must be patched; that's what _shiftIndexesForInsert handles.
  const insertAt = Math.floor(Math.random() * (room.players.length + 1));
  _shiftIndexesForInsert(room, insertAt);
  room.players.splice(insertAt, 0, lugen);
  log(room, `Lugen takes a seat (position ${insertAt + 1}).`);
}

function _despawnLugen(room) {
  const i = lugenSeated(room);
  if (i === -1) return;
  room.players.splice(i, 1);
  _shiftIndexesForRemove(room, i);
  log(room, 'Lugen leaves the table.');
}

// Reseat: remove from current position, insert at a different random one.
// Called after LIAR resolutions so Lugen rotates around the table.
//
// Subtle: when Lugen is the CURRENTLY-INDEXED seat (currentTurnIdx /
// challengerIdx / etc., e.g. after a caught-lying pile-pickup landed on
// Lugen), the bare _shiftIndexesForRemove logic stays at the same idx,
// which would point to whoever slid into Lugen's old slot. So we
// remember which roles Lugen owned before the splice and re-point them
// to Lugen's new seat after.
function _reseatLugen(room) {
  const cur = lugenSeated(room);
  if (cur === -1) return;
  if (room.players.length <= 2) return; // pointless if only Lugen + 1 human

  const wasCurrentTurn = room.currentTurnIdx === cur;
  const wasChallenger  = room.challengerIdx === cur;
  const wasNextLeader  = room.nextRoundLeaderIdx === cur;
  const wasEcho        = room.echoArmedFor === cur;
  const wasLastPlayer  = room.lastPlay && room.lastPlay.playerIdx === cur;

  const lugen = room.players[cur];
  room.players.splice(cur, 1);
  _shiftIndexesForRemove(room, cur);
  // Pick a NEW position different from the original (modulo array shrink).
  let newAt;
  do {
    newAt = Math.floor(Math.random() * (room.players.length + 1));
  } while (newAt === cur && room.players.length > 1);
  _shiftIndexesForInsert(room, newAt);
  room.players.splice(newAt, 0, lugen);

  // Restore Lugen's role-pointers to its new index.
  if (wasCurrentTurn) room.currentTurnIdx = newAt;
  if (wasChallenger)  room.challengerIdx  = newAt;
  if (wasNextLeader)  room.nextRoundLeaderIdx = newAt;
  if (wasEcho)        room.echoArmedFor   = newAt;
  if (wasLastPlayer && room.lastPlay) room.lastPlay.playerIdx = newAt;
  log(room, `Lugen reseats (now position ${newAt + 1}).`);
}

// When a player is REMOVED at index i, every index >= i in room state
// references shifts down by 1. Mirrors removePlayer's fixup.
function _shiftIndexesForRemove(room, idx) {
  if (room.currentTurnIdx > idx) room.currentTurnIdx -= 1;
  if (room.challengerIdx > idx)  room.challengerIdx -= 1;
  if (typeof room.echoArmedFor === 'number' && room.echoArmedFor > idx) room.echoArmedFor -= 1;
  if (typeof room.nextRoundLeaderIdx === 'number' && room.nextRoundLeaderIdx > idx) room.nextRoundLeaderIdx -= 1;
  if (room.lastPlay && room.lastPlay.playerIdx > idx) room.lastPlay.playerIdx -= 1;
  if (Array.isArray(room.placements)) {
    room.placements = room.placements
      .filter(p => p !== idx)
      .map(p => (p > idx ? p - 1 : p));
  }
}
// Inverse: every index >= idx shifts UP by 1 (because a new seat slid in).
function _shiftIndexesForInsert(room, idx) {
  if (room.currentTurnIdx >= idx) room.currentTurnIdx += 1;
  if (room.challengerIdx >= idx)  room.challengerIdx += 1;
  if (typeof room.echoArmedFor === 'number' && room.echoArmedFor >= idx) room.echoArmedFor += 1;
  if (typeof room.nextRoundLeaderIdx === 'number' && room.nextRoundLeaderIdx >= idx) room.nextRoundLeaderIdx += 1;
  if (room.lastPlay && room.lastPlay.playerIdx >= idx) room.lastPlay.playerIdx += 1;
  if (Array.isArray(room.placements)) {
    room.placements = room.placements.map(p => (p >= idx ? p + 1 : p));
  }
}

// Lugen's turn — picks 1-3 cards. Mostly bluffs; occasionally truthful
// when matching cards exist. Affixes every played card with a random
// pool entry (per design) before submitting via handlePlay.
function _lugenPlay(room) {
  const idx = lugenSeated(room);
  if (idx === -1) return;
  if (idx !== room.currentTurnIdx) return;
  if (room.challengeOpen) return;
  const lugen = room.players[idx];
  if (lugen.eliminated || lugen.finishedThisRound) return;
  if (!lugen.hand || lugen.hand.length === 0) return;
  // Filter out Cursed-locked cards — handlePlay rejects them and we'd
  // ping-pong forever. If everything in hand is Cursed-locked, Lugen
  // forfeits the turn (handed off to the next player via Smoke-Bomb-
  // equivalent: just advance the turn).
  const playable = lugen.hand.filter(c =>
    !(c.affix === 'cursed' && (c.cursedTurnsLeft || 0) > 0));
  if (playable.length === 0) {
    log(room, 'Lugen — every hand card is Cursed-locked. Skipping turn.');
    room.currentTurnIdx = findNextActiveIdx(room, idx);
    return;
  }
  const target = room.targetRank;
  const matching = playable.filter(c => c.rank === target);
  const willBluff = matching.length === 0 || Math.random() < LUGEN_BLUFF_RATE;
  const maxCount = Math.min(3, playable.length);
  const count = 1 + Math.floor(Math.random() * maxCount);
  let pick;
  if (willBluff) pick = shuffle(playable).slice(0, count);
  else            pick = matching.slice(0, count);
  // Lugen specials: every played card is randomly affixed. We mutate
  // the hand card directly so handlePlay sees the new affix when moving
  // it to the pile. Owner is preserved (some are owner=-1 round-deck
  // cards, others are stolen-from-pickup with owner set).
  for (const c of pick) {
    c.affix = LUGEN_AFFIX_POOL[Math.floor(Math.random() * LUGEN_AFFIX_POOL.length)];
  }
  log(room, `Lugen prepares ${count} card${count === 1 ? '' : 's'} (random affixes).`);
  handlePlay(room, lugen.id, pick.map(c => c.id));
}

// Lugen's challenge decision when it's the open-challenge challenger.
function _lugenDecideChallenge(room) {
  const idx = lugenSeated(room);
  if (idx === -1) return;
  if (!room.challengeOpen) return;
  if (room.challengerIdx !== idx) return;
  const willCall = Math.random() < LUGEN_CHALLENGE_RATE;
  const lugen = room.players[idx];
  if (willCall) {
    log(room, `Lugen calls LIAR.`);
    handleLiar(room, lugen.id);
  } else {
    log(room, `Lugen passes.`);
    handlePass(room, lugen.id);
  }
}

// Scheduler — called from broadcast(). If Lugen is the active turn or
// the open challenger, fire the action after a short delay so clients
// see the state first. Re-entrant: chains to itself when the action
// resolves into another Lugen turn (e.g. Lugen plays, next challenger
// is also Lugen — unlikely but possible).
function tickLugen(io, room) {
  if (!room || room.runOver) return;
  if (room.phase !== 'round') return;
  const idx = lugenSeated(room);
  if (idx === -1) return;
  const lugen = room.players[idx];
  if (lugen.eliminated || lugen.finishedThisRound) return;

  // Avoid stacking timers — only one pending Lugen action at a time.
  if (room._lugenActionPending) return;

  if (room.challengeOpen && room.challengerIdx === idx) {
    room._lugenActionPending = true;
    setTimeout(() => {
      room._lugenActionPending = false;
      if (!betaRooms[room.id]) return;
      if (!room.challengeOpen) return;
      _lugenDecideChallenge(room);
      if (io) broadcast(io, room);
    }, LUGEN_CHALLENGE_DELAY_MS);
    return;
  }
  if (!room.challengeOpen && room.currentTurnIdx === idx) {
    room._lugenActionPending = true;
    setTimeout(() => {
      room._lugenActionPending = false;
      if (!betaRooms[room.id]) return;
      if (room.challengeOpen) return;
      if (room.runOver) return;
      _lugenPlay(room);
      if (io) broadcast(io, room);
    }, LUGEN_PLAY_DELAY_MS);
  }
}

// 5.11 — Forfeit: a player may concede the run mid-floor. They drop to
// 0 hearts and are marked eliminated; the run continues for everyone
// else. If only 1 player remains alive afterwards, the run resolves
// normally. Idempotent — repeated forfeits no-op.
function forfeitRun(room, playerId) {
  const p = findPlayerById(room, playerId);
  if (!p) return { error: 'Not in room.' };
  if (!room.runStarted) return { error: 'Run has not started yet.' };
  if (room.runOver) return { error: 'Run is already over.' };
  if (p.eliminated) return { error: 'You are already eliminated.' };
  log(room, `${p.name} forfeited the run.`);
  p.hearts = 0;
  p.heartShards = 0;
  p.eliminated = true;
  // If they were the active turn or the open challenger, hand off the
  // round cleanly via the same machinery used when a player disconnects.
  if (room.runStarted) {
    if (room.challengeOpen && room.challengerIdx === room.players.indexOf(p)) {
      if (room.challengeTimer) { clearTimeout(room.challengeTimer); room.challengeTimer = null; }
      room.challengeOpen = false;
      room.challengerIdx = -1;
      room.challengeDeadline = null;
      if (activeCount(room) > 1) handlePassNoChallengeInternal(room);
    } else if (room.currentTurnIdx === room.players.indexOf(p)) {
      room.currentTurnIdx = findNextActiveIdx(room, room.currentTurnIdx);
    }
    // Resolve the round if forfeit emptied the table.
    if (activeCount(room) <= 1) endRoundIfDone(room);
    // Run-end check: only one alive → that player wins; all dead → null.
    const aliveCount = room.players.filter(pp => !pp.eliminated).length;
    if (aliveCount === 0) endRun(room, null);
    else if (aliveCount === 1 && room.players.length > 1) {
      const sole = room.players.find(pp => !pp.eliminated);
      endRun(room, sole.id);
    }
  }
  return { ok: true };
}

// ---------- The Screamer active (Mythic joker) ----------
// Once per floor: name a rank in {A, K, Q, 10, J}. For the rest of the
// round, every card of that rank in any hand is publicly revealed (the
// per-player snapshot pushes the matching cards into each opponent's
// `revealedCards` array). The flag clears at the start of the next round.
function useScreamer(room, playerId, rank) {
  const p = findPlayerById(room, playerId);
  if (!p) return { error: 'Not in room.' };
  if (!playerHasJoker(p, 'screamer')) return { error: 'You do not have The Screamer.' };
  if (room.phase !== 'round') return { error: 'Round not active.' };
  const charges = (room.screamerChargesFloor && room.screamerChargesFloor[playerId]) || 0;
  if (charges <= 0) return { error: 'No Screamer charges left this floor.' };
  const r = (rank || '').toString().toUpperCase();
  if (!ALL_RANKS.includes(r)) return { error: 'Pick a rank: A, K, Q, 10, or J.' };
  if (room.screamerRevealedRank) {
    return { error: 'A rank is already publicly revealed this round.' };
  }
  room.screamerChargesFloor[playerId] = charges - 1;
  room.screamerRevealedRank = r;
  room.screamerRevealedBy = playerId;
  log(room, `${p.name} - The Screamer: every ${r} in every hand is now publicly visible until end of round.`);
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

// ---- Admin cheats (host-only) ----
// adminGiveJoker / adminGiveRelic / adminGiveConsumable / adminApplyAffix /
// adminGotoPhase. All of these treat the host as a developer console — no
// gold deduction, no rarity weighting, no "already owned" rejection. Used
// for testing balance and demoing builds.

function adminGiveJoker(room, playerId, jokerId) {
  const p = findPlayerById(room, playerId);
  if (!p) return { error: 'Not in room.' };
  if (room.hostId !== playerId) return { error: 'Host only.' };
  const data = JOKER_CATALOG[jokerId];
  if (!data) return { error: 'Unknown joker id: ' + jokerId };
  ensurePlayerJokerSlots(p);
  if (playerHasJoker(p, jokerId)) return { error: 'Already equipped: ' + jokerId };
  const slot = p.jokers.findIndex(j => j === null);
  if (slot === -1) return { error: 'All joker slots full.' };
  p.jokers[slot] = { ...data };
  if (jokerId === 'tattletale') room.tattletaleChargesFloor[p.id] = 1 + ascensionTierFor(p, 'tattletale');
  if (jokerId === 'screamer')   room.screamerChargesFloor[p.id]   = 1;
  log(room, `Admin: gave ${p.name} joker ${data.name}.`);
  return { ok: true };
}

function adminGiveRelic(room, playerId, relicId) {
  const p = findPlayerById(room, playerId);
  if (!p) return { error: 'Not in room.' };
  if (room.hostId !== playerId) return { error: 'Host only.' };
  if (!RELIC_CATALOG[relicId]) return { error: 'Unknown relic id: ' + relicId };
  if (playerHasRelic(p, relicId)) return { error: 'Already owned: ' + relicId };
  p.relics = (p.relics || []).concat([relicId]);
  log(room, `Admin: gave ${p.name} relic ${RELIC_CATALOG[relicId].name}.`);
  return { ok: true };
}

function adminGiveConsumable(room, playerId, itemId, count) {
  const p = findPlayerById(room, playerId);
  if (!p) return { error: 'Not in room.' };
  if (room.hostId !== playerId) return { error: 'Host only.' };
  const item = SHOP_ITEMS.find(i => i.id === itemId && i.type === 'consumable');
  if (!item) return { error: 'Unknown consumable id: ' + itemId };
  const n = Math.max(1, Math.min(CONSUMABLE_CAP, parseInt(count, 10) || 1));
  p.inventory = p.inventory || {};
  p.inventory[itemId] = Math.min(CONSUMABLE_CAP, (p.inventory[itemId] || 0) + n);
  log(room, `Admin: gave ${p.name} ${n}× ${item.name} (now holds ${p.inventory[itemId]}).`);
  return { ok: true };
}

// Apply an affix to a target run-deck card by id. Pass `affix: null` to
// strip the affix.
function adminApplyAffix(room, playerId, cardId, affix) {
  const p = findPlayerById(room, playerId);
  if (!p) return { error: 'Not in room.' };
  if (room.hostId !== playerId) return { error: 'Host only.' };
  const VALID = [null, 'gilded', 'glass', 'spiked', 'cursed', 'steel', 'mirage', 'hollow', 'echo'];
  if (!VALID.includes(affix)) return { error: 'Bad affix: ' + affix };
  const card = (p.runDeck || []).find(c => c.id === cardId);
  if (!card) return { error: 'Card not in your run deck.' };
  card.affix = affix;
  if (affix === 'cursed') markCursedOnEntry(card);
  log(room, `Admin: ${p.name}'s ${card.rank} now ${affix || '(plain)'}.`);
  return { ok: true };
}

// Skip directly into a fork sub-phase. Use to test shop / reward / event
// / cleanse / treasure flows without needing to play through a floor. Sets
// up the room as if the floor just ended and only the chosen option is
// offered.
function adminGotoPhase(room, playerId, which) {
  const p = findPlayerById(room, playerId);
  if (!p) return { error: 'Not in room.' };
  if (room.hostId !== playerId) return { error: 'Host only.' };
  const allowed = ['shop', 'reward', 'event', 'cleanse', 'treasure'];
  if (!allowed.includes(which)) return { error: 'Bad phase: ' + which };
  // Force the room into a clean fork phase. Round state is wiped so the
  // game UI doesn't try to render a half-resolved round.
  if (room.challengeTimer) { clearTimeout(room.challengeTimer); room.challengeTimer = null; }
  room.challengeOpen = false;
  room.challengerIdx = -1;
  room.challengeDeadline = null;
  room.pile = [];
  room.lastPlay = null;
  room.placements = [];
  for (const pp of room.players) { pp.finishedThisRound = false; pp.hand = []; }
  room.phase = 'fork';
  room.forkPicks = {};
  const nextFloor = Math.min(TOTAL_FLOORS, room.currentFloor + 1);
  room.forkOffer = {
    nextFloor,
    nextFloorIsBoss: isBossFloor(nextFloor),
    nextBoss: isBossFloor(nextFloor) ? getBoss(nextFloor) : null,
    hasShop:     which === 'shop',
    hasReward:   which === 'reward',
    hasEvent:    which === 'event',
    hasCleanse:  which === 'cleanse',
    hasTreasure: which === 'treasure',
  };
  // Always regenerate the shop offer so the panel has data even if the
  // forced phase isn't shop (cheap; matches enterForkPhase's behavior).
  regenerateShopOffer(room);
  log(room, `Admin: forced fork phase = ${which}.`);
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
  // Re-seed Auditor's N if jumping into Floor 3, else clear.
  if (room.currentBoss && room.currentBoss.id === 'auditor') {
    room.auditorEveryN = 2 + Math.floor(Math.random() * 3);
  } else {
    room.auditorEveryN = null;
  }
  // Burn cap is per-floor — reset when admin jumps floors too.
  room.burnedCountThisFloor = 0;
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
  useDoubletalk,
  useSleightOfHand,
  useScreamer,
  setWhisperDirection,
  setRoomSeed,
  forfeitRun,
  // Admin
  adminAddGold,
  adminSetHearts,
  adminSkipFloor,
  adminGiveJoker,
  adminGiveRelic,
  adminGiveConsumable,
  adminApplyAffix,
  adminGotoPhase,
  // State + broadcasting
  publicBetaState,
  broadcast,
  // Lookup
  findPlayerById,
  findPlayerBySocket,
};
