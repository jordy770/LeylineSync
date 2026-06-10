-- supabase/functions_src/keep_opening_hand.sql
-- CANONICAL current definition (created in mig 221).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs.

-- London mulligan, the keep half (mig 221): after N mulligans the CALLER keeps
-- by putting exactly N cards from their hand on the BOTTOM of their library
-- (any order; we preserve the order given). N = 0 keeps the hand as-is.
create or replace function public.keep_opening_hand(
  p_session_id uuid,
  p_bottom_card_ids uuid[] default array[]::uuid[]
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kept boolean;
  v_mulligans integer;
  v_bottom uuid[];
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

  v_bottom := coalesce(p_bottom_card_ids, array[]::uuid[]);
  if cardinality(v_bottom) <> v_mulligans then
    raise exception 'Put exactly % card(s) on the bottom of your library (one per mulligan)', v_mulligans;
  end if;
  if (select count(distinct e) from unnest(v_bottom) e) <> cardinality(v_bottom) then
    raise exception 'Each card can only be bottomed once';
  end if;
  if cardinality(v_bottom) > 0 and (
    select count(*) from public.game_cards
    where id = any(v_bottom) and session_id = p_session_id
      and owner_id = auth.uid() and zone = 'hand'
  ) <> cardinality(v_bottom) then
    raise exception 'Bottomed cards must come from your hand';
  end if;

  foreach v_card in array v_bottom loop
    select coalesce(max(zone_position), -1) + 1 into v_pos
    from public.game_cards
    where session_id = p_session_id and owner_id = auth.uid() and zone = 'library';

    update public.game_cards
    set zone = 'library', zone_position = v_pos
    where id = v_card;
  end loop;

  update public.game_session_players
  set opening_hand_kept = true
  where session_id = p_session_id and player_id = auth.uid();

  return true;
end;
$$;
grant execute on function public.keep_opening_hand(uuid, uuid[]) to authenticated;
