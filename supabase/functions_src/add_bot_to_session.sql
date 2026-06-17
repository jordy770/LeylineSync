-- supabase/functions_src/add_bot_to_session.sql
-- CANONICAL current definition. Edit THIS file, then generate a migration with
-- scripts/new-migration.mjs — never re-extract from past migrations.
--
-- Seats an AI CPU opponent: a synthetic player flagged is_bot in an OPEN session,
-- with a simple vanilla library (a basic land + a cheap script-free creature,
-- shuffled) seeded so the game can start immediately. Its turns are driven by
-- `scripts/bot-runner.mjs --watch`. LOCAL ONLY: the bot's player_id has no
-- auth.users row, which the relaxed-FK local DB allows but hosted does not.
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
