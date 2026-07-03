-- Collection-Aware Deck Optimizer — module schema (MVP).
--
-- Isolated from the game engine: all tables live in `public` with a `co_` prefix
-- (collection-optimizer), so nothing collides with the game's own `cards`/`decks`/
-- `game_*` tables and no game migration is touched. Card data is reused from the
-- existing public.cards ONLY via oracle_id (text) joins; this migration never alters
-- cards or game_cards.
--
-- Design notes:
--  * Card-data tables (co_card_printings, co_card_tags) are public read-only catalog
--    data — RLS on + open SELECT, no write policy (writes only via service-role import).
--  * Per-user tables are owner-scoped via auth.uid() = user_id; child tables scope
--    through their parent deck.
--  * Availability is a VIEW, never a stored column (single source of truth). It uses
--    security_invoker so the caller's RLS still applies through the view (PG15+).
--  * oracle_id is TEXT everywhere to match the live public.cards.oracle_id type.

-- ───────────────────────── Card data (public catalog) ─────────────────────────

-- Full Scryfall printing mirror owned by the optimizer. MVP is fed from the
-- oracle-cards bulk (one representative printing per oracle_id); re-running the
-- import against default-cards later fills every printing into the same table.
create table if not exists public.co_card_printings (
  scryfall_id      uuid primary key,
  oracle_id        text not null,
  name             text not null,
  set_code         text not null,
  collector_num    text not null,
  colors           text[] not null default '{}',
  color_identity   text[] not null default '{}',
  mana_cost        text,
  cmc              numeric not null default 0,
  type_line        text not null,
  oracle_text      text,
  keywords         text[] not null default '{}',
  rarity           text,
  layout           text,
  finishes         text[] not null default '{}',
  image_uris       jsonb,
  prices           jsonb,
  prices_synced_at timestamptz,
  search_tsv       tsvector generated always as (
    to_tsvector('english',
      coalesce(name, '') || ' ' || coalesce(type_line, '') || ' ' || coalesce(oracle_text, ''))
  ) stored
);
create index if not exists co_card_printings_oracle_idx   on public.co_card_printings (oracle_id);
create index if not exists co_card_printings_search_idx   on public.co_card_printings using gin (search_tsv);
create index if not exists co_card_printings_ci_idx       on public.co_card_printings using gin (color_identity);
create index if not exists co_card_printings_name_idx     on public.co_card_printings (lower(name));

-- Oracle-grain view: one row per gameplay identity (synergy/scoring/availability
-- hang on oracle_id). Picks the highest-priced printing as the representative so a
-- full-printings mirror still yields one stable row per card.
create or replace view public.co_card_oracle
with (security_invoker = true) as
select distinct on (oracle_id)
  oracle_id, name, color_identity, cmc, type_line, oracle_text, keywords, prices
from public.co_card_printings
order by oracle_id, coalesce((prices->>'eur')::numeric, 0) desc nulls last, scryfall_id;

-- Synergy tags (heuristic/manual/ai), keyed at oracle grain.
create table if not exists public.co_card_tags (
  oracle_id text not null,
  tag       text not null,
  weight    numeric not null default 1,
  source    text not null default 'heuristic',  -- heuristic | manual | ai
  primary key (oracle_id, tag)
);
create index if not exists co_card_tags_tag_idx on public.co_card_tags (tag);

-- ───────────────────────── Per-user data (RLS owner-scoped) ─────────────────────────

create table if not exists public.co_collection_items (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users on delete cascade,
  oracle_id     text not null,                       -- resolved gameplay identity (availability key)
  scryfall_id   uuid,                                -- captured printing, if resolved (no FK: mirror may be sparse)
  name          text not null,                       -- raw imported name (audit / unresolved rows)
  set_code      text,
  collector_num text,
  quantity      int not null check (quantity > 0),
  finish        text not null default 'nonfoil',     -- nonfoil | foil | etched
  language      text not null default 'en',
  condition     text,
  binder_type   text not null default 'binder',      -- binder | deck | list
  import_id     uuid,
  updated_at    timestamptz not null default now()
);
create index if not exists co_collection_items_user_oracle_idx on public.co_collection_items (user_id, oracle_id);
create unique index if not exists co_collection_items_uniq
  on public.co_collection_items (user_id, oracle_id, finish, language, coalesce(condition, ''), coalesce(set_code, ''), coalesce(collector_num, ''));

create table if not exists public.co_decks (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users on delete cascade,
  name                text not null,
  commander_oracle_id text,                           -- oracle_id; validated in app layer
  partner_oracle_id   text,
  color_identity      text[] not null default '{}',
  source              text,                           -- moxfield | archidekt | manabox | txt
  source_url          text,
  power_score         numeric,
  updated_at          timestamptz not null default now()
);
create index if not exists co_decks_user_idx on public.co_decks (user_id);

create table if not exists public.co_deck_cards (
  deck_id      uuid not null references public.co_decks on delete cascade,
  oracle_id    text not null,
  quantity     int not null default 1 check (quantity > 0),
  is_commander boolean not null default false,
  category     text,
  primary key (deck_id, oracle_id)
);

create table if not exists public.co_imports (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users on delete cascade,
  kind           text not null,                       -- collection | deck
  source         text not null,                       -- manabox | moxfield | archidekt | txt
  filename       text,
  rows_total     int,
  rows_matched   int,
  rows_unmatched int,
  unmatched      jsonb,
  created_at     timestamptz not null default now()
);
create index if not exists co_imports_user_idx on public.co_imports (user_id, created_at desc);

create table if not exists public.co_deck_analyses (
  deck_id     uuid primary key references public.co_decks on delete cascade,
  computed_at timestamptz not null default now(),
  power_score numeric,
  buckets     jsonb,        -- {ramp:9, removal:7, draw:6, wipes:2, …}
  curve       jsonb,        -- {0:3,1:8,2:14,…}
  colors      jsonb,
  avg_mv      numeric,
  land_count  int,
  explanation text          -- cached AI explanation
);

-- ───────────────────────── Availability view (single source of truth) ─────────────────────────
-- available(oracle_id) = owned − Σ committed-to-decks. security_invoker so RLS on the
-- underlying per-user tables is enforced for the calling user.
create or replace view public.co_card_availability
with (security_invoker = true) as
select
  ci.user_id,
  ci.oracle_id,
  sum(ci.quantity)                                          as owned_qty,
  sum(ci.quantity) filter (where ci.binder_type = 'binder') as free_qty,
  coalesce(dc.committed_qty, 0)                             as committed_qty
from public.co_collection_items ci
left join (
  select d.user_id, dk.oracle_id, sum(dk.quantity) as committed_qty
  from public.co_deck_cards dk
  join public.co_decks d on d.id = dk.deck_id
  group by d.user_id, dk.oracle_id
) dc on dc.user_id = ci.user_id and dc.oracle_id = ci.oracle_id
group by ci.user_id, ci.oracle_id, dc.committed_qty;

-- ───────────────────────── RLS ─────────────────────────

-- Card-data: open read (public catalog), writes only via service role (no policy).
alter table public.co_card_printings enable row level security;
alter table public.co_card_tags      enable row level security;
drop policy if exists "co_card_printings read" on public.co_card_printings;
create policy "co_card_printings read" on public.co_card_printings
  for select to anon, authenticated using (true);
drop policy if exists "co_card_tags read" on public.co_card_tags;
create policy "co_card_tags read" on public.co_card_tags
  for select to anon, authenticated using (true);

-- Per-user: owner-scoped.
alter table public.co_collection_items enable row level security;
alter table public.co_decks            enable row level security;
alter table public.co_deck_cards       enable row level security;
alter table public.co_imports          enable row level security;
alter table public.co_deck_analyses    enable row level security;

drop policy if exists "co_collection_items owner" on public.co_collection_items;
create policy "co_collection_items owner" on public.co_collection_items
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "co_decks owner" on public.co_decks;
create policy "co_decks owner" on public.co_decks
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "co_imports owner" on public.co_imports;
create policy "co_imports owner" on public.co_imports
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Child tables scope through their parent deck's ownership.
drop policy if exists "co_deck_cards via deck" on public.co_deck_cards;
create policy "co_deck_cards via deck" on public.co_deck_cards
  for all to authenticated
  using      (exists (select 1 from public.co_decks d where d.id = deck_id and d.user_id = auth.uid()))
  with check (exists (select 1 from public.co_decks d where d.id = deck_id and d.user_id = auth.uid()));

drop policy if exists "co_deck_analyses via deck" on public.co_deck_analyses;
create policy "co_deck_analyses via deck" on public.co_deck_analyses
  for all to authenticated
  using      (exists (select 1 from public.co_decks d where d.id = deck_id and d.user_id = auth.uid()))
  with check (exists (select 1 from public.co_decks d where d.id = deck_id and d.user_id = auth.uid()));
