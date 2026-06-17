-- 202605010315_bot_seat
-- AI CPU opponent (local testing): flag a synthetic player seat as a bot, add an
-- RPC to seat one with a seeded vanilla library, and label bots "CPU 🤖" in the
-- player list. Turns are driven by scripts/bot-runner.mjs --watch.
-- Generated from supabase/functions_src (add_bot_to_session, get_session_players) — those files are
-- the canonical current definitions; edit them, not past migrations.

alter table public.game_session_players
  add column if not exists is_bot boolean not null default false;

create or replace function public.add_bot_to_session(p_session_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_format text;
  v_seat integer;
  v_bot uuid := gen_random_uuid();
  v_land uuid;
  v_creature uuid;
  v_life integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select status, format into v_status, v_format
  from public.game_sessions where id = p_session_id for update;
  if not found then raise exception 'Game session not found'; end if;
  if v_status <> 'open' then raise exception 'Game session is not open'; end if;

  select coalesce(max(seat_number), 0) + 1 into v_seat
  from public.game_session_players where session_id = p_session_id;

  v_life := case when v_format = 'commander' then 40 else 20 end;

  insert into public.game_session_players
    (session_id, player_id, seat_number, life_total, is_bot, autopass_settings)
  values
    (p_session_id, v_bot, v_seat, v_life, true, '{"op":true,"own":true}'::jsonb);

  -- Vanilla library: a basic land + the cheapest script-free creature, shuffled.
  select id into v_land from public.cards where type_line ilike 'Basic Land%' order by name limit 1;
  if v_land is null then
    select id into v_land from public.cards where type_line ilike '%land%' order by name limit 1;
  end if;
  select id into v_creature from public.cards
    where type_line ilike '%creature%' and mana_cost is not null
      and (script is null or script::text in ('null', '{}'))
    order by length(coalesce(mana_cost, '')), name limit 1;
  if v_land is null or v_creature is null then
    raise exception 'Catalog has no land/creature to build a bot deck';
  end if;

  insert into public.game_cards
    (session_id, card_id, owner_id, controller_player_id, zone, zone_position)
  select p_session_id, t.cid, v_bot, v_bot, 'library',
         (row_number() over (order by random()))::integer - 1
  from (
    select v_land as cid from generate_series(1, 22)
    union all
    select v_creature from generate_series(1, 18)
  ) t;

  return v_bot;
end;
$$;
grant execute on function public.add_bot_to_session(uuid) to authenticated;

-- supabase/functions_src/get_session_players.sql
-- CANONICAL current definition (seeded from 00_baseline.sql; mig 222 added
-- mulligans + opening_hand_kept for the opening-hand overlay).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs.
-- NOTE: changing the RETURNS TABLE shape needs `drop function if exists
-- public.get_session_players(uuid);` in the migration prelude.

CREATE OR REPLACE FUNCTION "public"."get_session_players"("p_session_id" "uuid") RETURNS TABLE("session_id" "uuid", "player_id" "uuid", "username" "text", "seat_number" integer, "life_total" integer, "mulligans" integer, "opening_hand_kept" boolean, "joined_at" timestamp with time zone)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select
    game_session_players.session_id,
    game_session_players.player_id,
    coalesce(
      nullif(profiles.username, ''),
      case when game_session_players.is_bot then 'CPU 🤖'
           else left(game_session_players.player_id::text, 8) end
    ) as username,
    game_session_players.seat_number,
    game_session_players.life_total,
    game_session_players.mulligans,
    game_session_players.opening_hand_kept,
    game_session_players.joined_at
  from public.game_session_players
  left join public.profiles
    on profiles.id = game_session_players.player_id
  where game_session_players.session_id = p_session_id
    and public.is_session_player(p_session_id, auth.uid())
  order by game_session_players.seat_number;
$$;
grant execute on function public.get_session_players(uuid) to authenticated;
