-- 202605010317_commander_free_mulligan
-- TODO: describe the change.
-- Generated from supabase/functions_src (keep_opening_hand) — those files are
-- the canonical current definitions; edit them, not past migrations.

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
  v_format text;
  v_required integer;
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

  -- Bottom count: London = one per mulligan. Commander's FIRST mulligan is free,
  -- so it bottoms one fewer (min 0).
  select format into v_format from public.game_sessions where id = p_session_id;
  v_required := case when v_format = 'commander' then greatest(v_mulligans - 1, 0) else v_mulligans end;

  v_bottom := coalesce(p_bottom_card_ids, array[]::uuid[]);
  if cardinality(v_bottom) <> v_required then
    raise exception 'Put exactly % card(s) on the bottom of your library', v_required;
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
