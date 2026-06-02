-- Baseline bootstrap for local / from-scratch builds.
--
-- The incremental migrations (202605010000+) were authored on top of a base
-- schema that was created out-of-band on the hosted project (dashboard), so
-- they assume these four tables already exist and never create them:
--   public.cards         (card catalog)
--   public.game_cards    (in-play card instances)
--   public.game_players  (per-player mana pool / life / active flag)
--   public.profiles      (usernames; referenced by the username RPCs)
-- On a clean `supabase db reset` those tables are absent, so 202605010000's
-- first statement (`update public.game_cards`) fails with 42P01. This baseline
-- (sorted first by its all-zero timestamp) fills that gap.
--
-- Definitions mirror the hosted schema dump. Intentionally OMITTED here:
--   * Foreign keys — several point at tables created by LATER migrations
--     (e.g. game_sessions), so they can't be added this early; and dropping the
--     owner_id -> profiles / player_id -> profiles FKs lets the test harness use
--     throwaway player UUIDs without seeding profiles. FK enforcement exists on
--     prod; it is not needed for the rules-engine logic or its tests.
--   * RLS + policies — owned by later migrations (e.g. 028 runtime_state_rls);
--     the rules RPCs are SECURITY DEFINER, so RLS does not affect them.
--
-- This file is for local DB builds only. Hosted already has these tables, where
-- `create table if not exists` makes re-running a no-op.

create table if not exists public.profiles (
  id uuid not null,
  username text,
  is_pro boolean default false,
  updated_at timestamptz default timezone('utc', now()),
  constraint profiles_pkey primary key (id)
);

create table if not exists public.cards (
  id uuid not null,
  name text not null,
  mana_cost text,
  type_line text,
  oracle_text text,
  power_toughness text,
  keywords jsonb default '[]'::jsonb,
  script jsonb default '{}'::jsonb,
  image_url text,
  power integer,
  toughness integer,
  is_token boolean default false not null,
  oracle_id text,
  constraint cards_pkey primary key (id)
);

create index if not exists cards_oracle_id_idx
  on public.cards using btree (oracle_id) where (oracle_id is not null);

create table if not exists public.game_cards (
  id uuid default gen_random_uuid() not null,
  session_id uuid not null,
  card_id uuid not null,
  owner_id uuid not null,
  zone text default 'library',
  is_tapped boolean default false,
  position_x smallint default 0,
  position_y smallint default 0,
  inserted_at timestamptz default timezone('utc', now()),
  zone_position integer default 0 not null,
  damage_marked integer default 0 not null,
  controller_player_id uuid,
  copied_script jsonb,
  static_effects_suppressed boolean default false not null,
  entered_battlefield_turn_number integer,
  is_face_down boolean default false not null,
  dealt_deathtouch_damage boolean default false not null,
  plus_one_counters integer default 0 not null,
  constraint game_cards_pkey primary key (id),
  constraint game_cards_damage_marked_check check (damage_marked >= 0),
  constraint game_cards_zone_check check (
    zone = any (array['library','hand','stack','battlefield','graveyard','exile'])
  )
);

create index if not exists game_cards_library_draw_idx
  on public.game_cards using btree (session_id, owner_id, zone, zone_position, id);
create index if not exists idx_game_cards_owner
  on public.game_cards using btree (owner_id);
create index if not exists idx_game_cards_session
  on public.game_cards using btree (session_id);

create table if not exists public.game_players (
  id uuid default gen_random_uuid() not null,
  session_id uuid not null,
  player_id uuid not null,
  life_total integer default 40,
  mana_pool jsonb default '{"B": 0, "C": 0, "G": 0, "R": 0, "U": 0, "W": 0}'::jsonb,
  is_active boolean default true,
  constraint game_players_pkey primary key (id),
  constraint game_players_session_id_player_id_key unique (session_id, player_id)
);
