-- Lugen game database schema for Supabase
-- Run this once in the Supabase SQL editor (Project -> SQL Editor -> New query).
-- Safe to re-run: every CREATE uses IF NOT EXISTS.

create extension if not exists pgcrypto;

-- ===== Users =====
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  username_lower text not null unique,
  password_hash text not null,
  password_salt text not null,
  created_at timestamptz not null default now(),
  -- aggregate stats
  games_played int not null default 0,
  games_won int not null default 0,
  games_lost int not null default 0,
  -- per-mode stats
  classic_played int not null default 0,
  classic_won int not null default 0,
  classic_lost int not null default 0,
  liarsbar_played int not null default 0,
  liarsbar_won int not null default 0,
  liarsbar_lost int not null default 0,
  liarsbar_eliminations int not null default 0
);

-- ===== Per-modifier breakdown =====
create table if not exists modifier_stats (
  user_id uuid not null references users(id) on delete cascade,
  modifier_key text not null,
  games_active int not null default 0,
  games_won int not null default 0,
  primary key (user_id, modifier_key)
);

-- ===== Session tokens =====
create table if not exists sessions (
  token text primary key,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists idx_sessions_user_id on sessions(user_id);
create index if not exists idx_sessions_expires_at on sessions(expires_at);

-- ===== Optional: a Postgres function for atomic stat increments =====
-- Lets the server call rpc('increment_user_stats', { ... }) instead of
-- read-then-update. Pure SQL is more concurrent-safe.
create or replace function increment_user_stats(
  p_user_id uuid,
  p_won boolean,
  p_lost boolean,
  p_mode text,
  p_eliminated boolean
) returns void as $$
begin
  update users set
    games_played = games_played + 1,
    games_won = games_won + (case when p_won then 1 else 0 end),
    games_lost = games_lost + (case when p_lost then 1 else 0 end),
    classic_played = classic_played + (case when p_mode = 'classic' then 1 else 0 end),
    classic_won = classic_won + (case when p_mode = 'classic' and p_won then 1 else 0 end),
    classic_lost = classic_lost + (case when p_mode = 'classic' and p_lost then 1 else 0 end),
    liarsbar_played = liarsbar_played + (case when p_mode = 'liarsbar' then 1 else 0 end),
    liarsbar_won = liarsbar_won + (case when p_mode = 'liarsbar' and p_won then 1 else 0 end),
    liarsbar_lost = liarsbar_lost + (case when p_mode = 'liarsbar' and p_lost then 1 else 0 end),
    liarsbar_eliminations = liarsbar_eliminations + (case when p_eliminated then 1 else 0 end)
  where id = p_user_id;
end;
$$ language plpgsql;

create or replace function increment_modifier_stats(
  p_user_id uuid,
  p_modifier_key text,
  p_won boolean
) returns void as $$
begin
  insert into modifier_stats (user_id, modifier_key, games_active, games_won)
  values (p_user_id, p_modifier_key, 1, case when p_won then 1 else 0 end)
  on conflict (user_id, modifier_key) do update set
    games_active = modifier_stats.games_active + 1,
    games_won = modifier_stats.games_won + (case when p_won then 1 else 0 end);
end;
$$ language plpgsql;

-- ===== Useful view for the leaderboard =====
create or replace view leaderboard as
  select id, username, games_played, games_won, games_lost,
         case when games_played > 0
              then round(games_won::numeric / games_played * 100, 1)
              else 0 end as win_rate
  from users
  where games_played > 0
  order by games_won desc, games_played asc
  limit 50;
