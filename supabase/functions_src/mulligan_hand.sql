-- supabase/functions_src/mulligan_hand.sql
-- CANONICAL current definition (created in mig 221).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs.

-- London mulligan, the shuffle-back half (mig 221): the CALLER's whole hand
-- goes back into their library, the library is reshuffled, and they draw seven
-- again; mulligans increments. keep_opening_hand then bottoms N = mulligans
-- cards. Only while the opening hand is undecided.
create or replace function public.mulligan_hand(p_session_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kept boolean;
  v_mulligans integer;
  v_i integer;
  v_card uuid;
  v_pos integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select opening_hand_kept, mulligans into v_kept, v_mulligans
  from public.game_session_players
  where session_id = p_session_id and player_id = auth.uid()
  for update;
  if not found then
    raise exception 'Current user is not a player in this session';
  end if;
  if v_kept then
    raise exception 'You have already kept your opening hand';
  end if;

  -- Hand back into the library…
  update public.game_cards
  set zone = 'library'
  where session_id = p_session_id and owner_id = auth.uid() and zone = 'hand';

  -- …shuffle (reassign every library position randomly)…
  update public.game_cards gc
  set zone_position = shuffled.rn
  from (
    select id, row_number() over (order by random()) - 1 as rn
    from public.game_cards
    where session_id = p_session_id and owner_id = auth.uid() and zone = 'library'
  ) shuffled
  where gc.id = shuffled.id;

  -- …draw seven again (London: always seven; keep bottoms the difference).
  for v_i in 1..7 loop
    select id into v_card
    from public.game_cards
    where session_id = p_session_id and owner_id = auth.uid() and zone = 'library'
    order by zone_position asc, id asc
    limit 1
    for update skip locked;
    exit when v_card is null;

    select coalesce(max(zone_position), -1) + 1 into v_pos
    from public.game_cards
    where session_id = p_session_id and owner_id = auth.uid() and zone = 'hand';

    update public.game_cards
    set zone = 'hand', zone_position = v_pos, is_tapped = false
    where id = v_card;
  end loop;

  update public.game_session_players
  set mulligans = mulligans + 1
  where session_id = p_session_id and player_id = auth.uid();

  return v_mulligans + 1;
end;
$$;
grant execute on function public.mulligan_hand(uuid) to authenticated;
