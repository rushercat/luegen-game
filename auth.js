// auth.js - Authentication and stats backed by Supabase.
//
// All Supabase calls go through this module so the rest of the codebase
// doesn't need to know whether auth is enabled. If SUPABASE_URL or
// SUPABASE_SERVICE_KEY is missing, every operation no-ops and `enabled`
// stays false — the game still runs anonymously.
//
// Email/password signups use Node's built-in scrypt with a per-user salt.
// Google sign-in uses Supabase's hosted OAuth, then we map the resulting
// Supabase user onto our own users table by (provider, sub).
const crypto = require('crypto');
let createClient = null;
try { ({ createClient } = require('@supabase/supabase-js')); } catch (_) { /* package not installed */ }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SESSION_DAYS = 30;
const MIN_PASSWORD_LEN = 6;

const enabled = !!(createClient && SUPABASE_URL && SUPABASE_SERVICE_KEY);
const oauthEnabled = !!(enabled && SUPABASE_ANON_KEY);
const supabase = enabled
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

if (!enabled) {
  // eslint-disable-next-line no-console
  console.warn('[auth] Supabase not configured — running without accounts/stats. Set SUPABASE_URL + SUPABASE_SERVICE_KEY in .env to enable.');
} else if (!oauthEnabled) {
  // eslint-disable-next-line no-console
  console.warn('[auth] SUPABASE_ANON_KEY not set — Google sign-in disabled. Username/password still works.');
}

// ---- Helpers ----
function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  let computed;
  try { computed = crypto.scryptSync(password, salt, 64).toString('hex'); }
  catch (_) { return false; }
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isValidUsername(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9_-]{3,20}$/.test(name.trim());
}

// Normalize a username for slur-filter comparison: lowercase, strip
// digits/symbols, collapse common letter substitutions.
function normalizeForFilter(s) {
  return String(s).toLowerCase()
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/!/g, 'i')
    .replace(/\|/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/@/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/8/g, 'b')
    .replace(/[^a-z]/g, '');
}

// Substrings forbidden anywhere in a username (matched after normalization).
// Add or remove entries here as community standards evolve.
const PROHIBITED_SUBSTRINGS = [
  'nigg', 'nigga', 'niger',
  'fagg', 'faggot',
  'kike',
  'spic',
  'chink',
  'gook',
  'wetback',
  'tranny',
  'retard',
  'cunt',
  'whore',
  'rapist',
  'pedo',
  'pedophile',
  'nazi',
  'hitler',
  'kkk'
];

function isProhibitedUsername(name) {
  const norm = normalizeForFilter(name);
  for (const sub of PROHIBITED_SUBSTRINGS) {
    if (norm.includes(sub)) return true;
  }
  return false;
}

function sanitizeUsername(s) {
  return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20);
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    created_at: u.created_at,
    games_played: u.games_played || 0,
    games_won: u.games_won || 0,
    games_lost: u.games_lost || 0,
    classic_played: u.classic_played || 0,
    classic_won: u.classic_won || 0,
    classic_lost: u.classic_lost || 0,
    liarsbar_played: u.liarsbar_played || 0,
    liarsbar_won: u.liarsbar_won || 0,
    liarsbar_lost: u.liarsbar_lost || 0,
    liarsbar_eliminations: u.liarsbar_eliminations || 0,
    has_password: !!u.password_hash,
    oauth_provider: u.oauth_provider || null,
    beta_max_floor: u.beta_max_floor || 1,
    beta_run_won: !!u.beta_run_won,
    is_admin: !!u.is_admin
  };
}

// ---- Email / password ----
async function signup(username, password) {
  if (!enabled) throw new Error('Accounts are disabled on this server.');
  username = String(username || '').trim();
  password = String(password || '');
  if (!isValidUsername(username)) throw new Error('Username must be 3–20 chars: letters, digits, _ or -.');
  if (isProhibitedUsername(username)) throw new Error('That username is not allowed.');
  if (password.length < MIN_PASSWORD_LEN) throw new Error(`Password must be at least ${MIN_PASSWORD_LEN} characters.`);
  const lower = username.toLowerCase();
  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('username_lower', lower)
    .maybeSingle();
  if (existing) throw new Error('Username already taken.');
  const { hash, salt } = hashPassword(password);
  const { data: user, error } = await supabase
    .from('users')
    .insert({ username, username_lower: lower, password_hash: hash, password_salt: salt })
    .select()
    .single();
  if (error) throw new Error('Signup failed: ' + error.message);
  return user;
}

async function login(username, password) {
  if (!enabled) throw new Error('Accounts are disabled on this server.');
  const lower = String(username || '').trim().toLowerCase();
  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('username_lower', lower)
    .maybeSingle();
  if (!user) throw new Error('Wrong username or password.');
  if (!user.password_hash) throw new Error('This account uses Google sign-in, not a password.');
  if (!verifyPassword(password, user.password_hash, user.password_salt)) {
    throw new Error('Wrong username or password.');
  }
  return user;
}

// ---- Sessions ----
async function createSession(userId) {
  if (!enabled) return null;
  const token = makeToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase.from('sessions').insert({ token, user_id: userId, expires_at: expires });
  if (error) throw new Error('Could not create session: ' + error.message);
  return token;
}

async function deleteSession(token) {
  if (!enabled || !token) return;
  await supabase.from('sessions').delete().eq('token', token);
}

async function getUserByToken(token) {
  if (!enabled || !token) return null;
  const { data: session } = await supabase
    .from('sessions')
    .select('user_id, expires_at')
    .eq('token', token)
    .maybeSingle();
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    await supabase.from('sessions').delete().eq('token', token);
    return null;
  }
  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('id', session.user_id)
    .maybeSingle();
  return user || null;
}

// ---- Stats ----
async function recordGameStats(entries, activeModifiers) {
  if (!enabled) return;
  const mods = Array.isArray(activeModifiers) ? activeModifiers : [];
  for (const e of entries || []) {
    if (!e || !e.userId) continue;
    try {
      await supabase.rpc('increment_user_stats', {
        p_user_id: e.userId,
        p_won: !!e.won,
        p_lost: !!e.lost,
        p_mode: e.mode === 'liarsbar' ? 'liarsbar' : 'classic',
        p_eliminated: !!e.eliminated
      });
      for (const mod of mods) {
        await supabase.rpc('increment_modifier_stats', {
          p_user_id: e.userId,
          p_modifier_key: String(mod),
          p_won: !!e.won
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[auth] stats update failed for', e.userId, err && err.message);
    }
  }
}

async function leaderboard(limit) {
  if (!enabled) return [];
  const max = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
  const { data, error } = await supabase
    .from('users')
    .select('id, username, games_played, games_won, games_lost, classic_won, liarsbar_won, liarsbar_eliminations')
    .gt('games_played', 0)
    .order('games_won', { ascending: false })
    .order('games_played', { ascending: true })
    .limit(max);
  if (error) {
    // eslint-disable-next-line no-console
    console.error('[auth] leaderboard query failed', error.message);
    return [];
  }
  return (data || []).map(u => ({
    ...u,
    win_rate: u.games_played > 0 ? Math.round((u.games_won / u.games_played) * 1000) / 10 : 0
  }));
}

async function userModifierStats(userId) {
  if (!enabled || !userId) return [];
  const { data } = await supabase
    .from('modifier_stats')
    .select('modifier_key, games_active, games_won')
    .eq('user_id', userId)
    .order('games_active', { ascending: false });
  return data || [];
}

// ---- Google OAuth bridge ----
//
// The browser does the Google OAuth dance with Supabase's JS client. After
// the redirect, the browser posts the resulting Supabase JWT to our backend.
// We verify it by calling Supabase's /auth/v1/user (which only answers if
// the token is valid), then look up or create a row in our users table
// keyed on (oauth_provider, oauth_sub).
async function verifySupabaseUser(jwt) {
  if (!oauthEnabled || !jwt) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'apikey': SUPABASE_ANON_KEY
      }
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) {
    return null;
  }
}

async function findOrCreateOAuthUser({ provider, sub, email, username }) {
  if (!enabled) throw new Error('Accounts are disabled on this server.');
  if (!provider || !sub) throw new Error('OAuth payload is incomplete.');

  // 1) Existing link by (provider, sub).
  const { data: byOauth } = await supabase
    .from('users')
    .select('*')
    .eq('oauth_provider', provider)
    .eq('oauth_sub', sub)
    .maybeSingle();
  if (byOauth) return { user: byOauth, isNew: false };

  // 2) New user — must have a username.
  const trimmed = (username || '').trim();
  if (!trimmed) {
    const suggested = email ? sanitizeUsername(email.split('@')[0]) : '';
    return { needsUsername: true, suggested };
  }
  if (!isValidUsername(trimmed)) throw new Error('Username must be 3–20 chars: letters, digits, _ or -.');

  const lower = trimmed.toLowerCase();
  const { data: dup } = await supabase
    .from('users')
    .select('id')
    .eq('username_lower', lower)
    .maybeSingle();
  if (dup) throw new Error('Username already taken.');

  const { data: user, error } = await supabase
    .from('users')
    .insert({
      username: trimmed,
      username_lower: lower,
      email: email || null,
      oauth_provider: provider,
      oauth_sub: sub
    })
    .select()
    .single();
  if (error) throw new Error('Could not create account: ' + error.message);
  return { user, isNew: true };
}

// ---- Beta prototype progression ----

async function getBetaProgression(userId) {
  if (!enabled || !userId) return null;
  const { data, error } = await supabase
    .from('users')
    .select('beta_max_floor, beta_run_won, is_admin')
    .eq('id', userId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    maxFloor: data.beta_max_floor || 1,
    runWon: !!data.beta_run_won,
    isAdmin: !!data.is_admin
  };
}

async function updateBetaProgression(userId, opts) {
  if (!enabled || !userId) return null;
  const cur = await getBetaProgression(userId);
  if (!cur) return null;
  const updates = {};
  const next = { ...cur };
  if (opts && typeof opts.maxFloor === 'number' && opts.maxFloor > cur.maxFloor) {
    updates.beta_max_floor = opts.maxFloor;
    next.maxFloor = opts.maxFloor;
  }
  if (opts && opts.runWon === true && !cur.runWon) {
    updates.beta_run_won = true;
    next.runWon = true;
  }
  if (Object.keys(updates).length === 0) return cur;
  const { error } = await supabase.from('users').update(updates).eq('id', userId);
  if (error) return cur;
  return next;
}

async function adminUnlockAllProgression(userId) {
  if (!enabled || !userId) return null;
  const cur = await getBetaProgression(userId);
  if (!cur || !cur.isAdmin) return null;
  const { error } = await supabase
    .from('users')
    .update({ beta_max_floor: 99, beta_run_won: true })
    .eq('id', userId);
  if (error) return null;
  return { maxFloor: 99, runWon: true, isAdmin: true };
}

// ---- Phase 6: cosmetics + achievements ----

async function getCosmetics(userId) {
  if (!enabled || !userId) return null;
  const { data, error } = await supabase
    .from('users')
    .select('owned_cosmetics, earned_achievements')
    .eq('id', userId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    owned: Array.isArray(data.owned_cosmetics) ? data.owned_cosmetics : [],
    achievements: Array.isArray(data.earned_achievements) ? data.earned_achievements : []
  };
}

// Grant a cosmetic / achievement (future-use). Idempotent: re-granting is a no-op.
async function grantCosmetic(userId, cosmeticId) {
  if (!enabled || !userId || !cosmeticId) return null;
  const cur = await getCosmetics(userId);
  if (!cur) return null;
  if (cur.owned.includes(cosmeticId)) return cur;
  const next = cur.owned.concat([cosmeticId]);
  const { error } = await supabase.from('users').update({ owned_cosmetics: next }).eq('id', userId);
  if (error) return cur;
  return { owned: next, achievements: cur.achievements };
}

async function grantAchievement(userId, achievementId) {
  if (!enabled || !userId || !achievementId) return null;
  const cur = await getCosmetics(userId);
  if (!cur) return null;
  if (cur.achievements.includes(achievementId)) return cur;
  const next = cur.achievements.concat([achievementId]);
  const { error } = await supabase.from('users').update({ earned_achievements: next }).eq('id', userId);
  if (error) return cur;
  return { owned: cur.owned, achievements: next };
}

// ---- Username change (with slur filter + uniqueness) ----

async function changeUsername(userId, newUsername) {
  if (!enabled) throw new Error('Accounts are disabled on this server.');
  if (!userId) throw new Error('Not signed in.');
  newUsername = String(newUsername || '').trim();
  if (!isValidUsername(newUsername)) {
    throw new Error('Username must be 3–20 chars: letters, digits, _ or -.');
  }
  if (isProhibitedUsername(newUsername)) {
    throw new Error('That username is not allowed.');
  }
  const lower = newUsername.toLowerCase();
  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('username_lower', lower)
    .maybeSingle();
  if (existing && existing.id !== userId) {
    throw new Error('Username already taken.');
  }
  const { data: updated, error } = await supabase
    .from('users')
    .update({ username: newUsername, username_lower: lower })
    .eq('id', userId)
    .select()
    .single();
  if (error) throw new Error('Could not change username: ' + error.message);
  return updated;
}

// ---- Phase 7: beta run history ----

const RUN_HISTORY_CAP = 20;

async function getBetaRunHistory(userId) {
  if (!enabled || !userId) return [];
  const { data, error } = await supabase
    .from('users')
    .select('beta_run_history')
    .eq('id', userId)
    .maybeSingle();
  if (error || !data) return [];
  return Array.isArray(data.beta_run_history) ? data.beta_run_history : [];
}

async function recordBetaRun(userId, run) {
  if (!enabled || !userId || !run || typeof run !== 'object') return null;
  const cur = await getBetaRunHistory(userId);
  // Sanitize: only allow expected fields, server-set timestamp
  const sanitized = {
    date: new Date().toISOString(),
    characterId: typeof run.characterId === 'string' ? run.characterId.slice(0, 32) : null,
    characterName: typeof run.characterName === 'string' ? run.characterName.slice(0, 32) : null,
    result: run.result === 'won' ? 'won' : 'lost',
    maxFloor: Math.max(1, Math.min(99, parseInt(run.maxFloor, 10) || 1)),
    hearts: Math.max(0, Math.min(9, parseInt(run.hearts, 10) || 0)),
    gold: Math.max(0, Math.min(99999, parseInt(run.gold, 10) || 0))
  };
  const next = [sanitized, ...cur].slice(0, RUN_HISTORY_CAP);
  const { error } = await supabase.from('users').update({ beta_run_history: next }).eq('id', userId);
  if (error) return cur;
  return next;
}

module.exports = {
  enabled,
  oauthEnabled,
  supabaseUrl: SUPABASE_URL || '',
  supabaseAnonKey: SUPABASE_ANON_KEY || '',
  signup,
  login,
  createSession,
  deleteSession,
  getUserByToken,
  publicUser,
  recordGameStats,
  leaderboard,
  userModifierStats,
  isValidUsername,
  verifySupabaseUser,
  findOrCreateOAuthUser,
  MIN_PASSWORD_LEN,
  getBetaProgression,
  updateBetaProgression,
  adminUnlockAllProgression,
  getCosmetics,
  grantCosmetic,
  grantAchievement,
  getBetaRunHistory,
  recordBetaRun,
  changeUsername,
  isProhibitedUsername
};
