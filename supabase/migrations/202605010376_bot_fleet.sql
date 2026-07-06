-- Multi-bot Add CPU: seat ANY free provisioned CPU user (mig 375 allowed one).
--
-- Mig 375 matched exactly ONE profile ('CPU 🤖'), so a 4-player game with three
-- CPUs was impossible on hosted. create-bot-user.mjs now provisions extra bots
-- with distinct names ('CPU 🤖 2', 'CPU 🤖 3', …); this reproduction of
-- add_bot_to_session (from mig 375) widens the match to any FREE profile whose
-- username starts with 'CPU 🤖', seated in name order. Taken seats give the
-- same clear error; the bare-UUID local-dev fallback is unchanged. The
-- bot-runner's --watch loop plays every is_bot seat, so no runner change.

create or replace function public.add_bot_to_session(
  p_session_id uuid,
  p_deck_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_format text;
  v_seat integer;
  v_bot uuid;
  v_land uuid;
  v_creature uuid;
  v_life integer;
  v_deck_id uuid;
  v_list jsonb;
  v_commander uuid;
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

  -- Seat id: any FREE provisioned CPU auth-user (hosted — the FK target is
  -- real), in name order; bare-UUID fallback for local dev without one.
  select p.id into v_bot
  from public.profiles p
  where p.username like 'CPU 🤖%'
    and not exists (
      select 1 from public.game_session_players s
      where s.session_id = p_session_id and s.player_id = p.id
    )
  order by p.username
  limit 1;
  if v_bot is null then
    if exists (select 1 from public.profiles where username like 'CPU 🤖%') then
      raise exception 'Every provisioned CPU player is already seated in this game — provision another (scripts/create-bot-user.mjs)';
    end if;
    v_bot := gen_random_uuid();
  end if;

  select coalesce(max(seat_number), 0) + 1 into v_seat
  from public.game_session_players where session_id = p_session_id;

  v_life := case when v_format = 'commander' then 40 else 20 end;

  insert into public.game_session_players
    (session_id, player_id, seat_number, life_total, is_bot, autopass_settings)
  values
    (p_session_id, v_bot, v_seat, v_life, true, '{"op":true,"own":true}'::jsonb);

  -- Resolve a real deck. Explicit p_deck_id wins (caller-owned or shared precon);
  -- otherwise pick a shared precon — in Commander, one that actually has a
  -- commander so the seat is legal.
  if p_deck_id is not null then
    select id, list_data, commander_card_id into v_deck_id, v_list, v_commander
    from public.decks
    where id = p_deck_id and (is_precon = true or owner_id = auth.uid());
  end if;
  if v_deck_id is null then
    select id, list_data, commander_card_id into v_deck_id, v_list, v_commander
    from public.decks
    where is_precon = true
      and jsonb_typeof(list_data) = 'array'
      and (v_format <> 'commander' or commander_card_id is not null)
    order by random()
    limit 1;
  end if;

  -- Seed the bot's library from the deck (commander excluded → command zone).
  if v_deck_id is not null and jsonb_typeof(coalesce(v_list, '[]'::jsonb)) = 'array' then
    insert into public.game_cards
      (session_id, card_id, owner_id, controller_player_id, zone, zone_position)
    select p_session_id, t.cid::uuid, v_bot, v_bot, 'library',
           (row_number() over (order by random()))::integer - 1
    from jsonb_array_elements_text(coalesce(v_list, '[]'::jsonb)) as t(cid)
    where v_format <> 'commander' or v_commander is null or t.cid::uuid <> v_commander;

    if v_format = 'commander' and v_commander is not null then
      insert into public.game_cards
        (session_id, card_id, owner_id, controller_player_id, zone, zone_position, is_commander)
      values (p_session_id, v_commander, v_bot, v_bot, 'command', 0, true);
    end if;

    return v_bot;
  end if;

  -- Vanilla fallback: a basic land + the cheapest script-free creature, shuffled.
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
grant execute on function public.add_bot_to_session(uuid, uuid) to authenticated;
