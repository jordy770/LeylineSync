-- Playgroup meta profile (AI personalization).
--
-- One free-text row per user describing what their playgroup plays ("lots of
-- graveyard recursion, treasures, one stax player"). Injected into every AI
-- Deck Doctor run so advice is tuned to the actual meta. Unlike entitlements
-- this is harmless preference text, so users read AND write their own row.

create table if not exists public.co_player_meta (
  user_id uuid primary key references auth.users(id) on delete cascade,
  meta text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.co_player_meta enable row level security;

create policy co_player_meta_own on public.co_player_meta
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
