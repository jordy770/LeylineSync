-- supabase/functions_src/exile_until_cheaper.sql
-- CANONICAL current definition.
-- Shared by discover (mig 253) and cascade (mig 422): exile from the top of the
-- controller's library until the first NONLAND with mana_value <= p_max_mv; bottom
-- the looked-at pile in random order; return the found card's id (or null if none
-- qualified before the library ran out). Callers park their own "cast it?" decision.
create or replace function public.exile_until_cheaper(
  p_session_id uuid, p_controller uuid, p_max_mv integer
) returns uuid language plpgsql security definer set search_path = public
as $$
declare
  v_looked uuid[] := array[]::uuid[];
  v_tid uuid := null;
  v_len integer;
  v_type_line text;
  v_mana_cost text;
begin
  v_len := (select count(*) from public.game_cards
            where session_id = p_session_id and owner_id = p_controller and zone = 'library');
  while coalesce(array_length(v_looked, 1), 0) + (case when v_tid is null then 0 else 1 end) < v_len loop
    select gc.id, c.type_line, c.mana_cost into v_tid, v_type_line, v_mana_cost
    from public.game_cards gc join public.cards c on c.id = gc.card_id
    where gc.session_id = p_session_id and gc.owner_id = p_controller and gc.zone = 'library'
      and gc.id <> all(v_looked)
    order by gc.zone_position asc, gc.id asc limit 1;
    exit when v_tid is null;
    if v_type_line not ilike '%land%' and public.mana_value(v_mana_cost) <= coalesce(p_max_mv, 0) then
      update public.game_cards gc
      set zone = 'exile', controller_player_id = gc.owner_id, is_tapped = false,
          zone_position = (select coalesce(max(zone_position), -1) + 1
                           from public.game_cards x
                           where x.session_id = p_session_id and x.owner_id = gc.owner_id and x.zone = 'exile')
      where gc.id = v_tid;
      exit;
    end if;
    v_looked := v_looked || v_tid;
    v_tid := null;
  end loop;
  if coalesce(array_length(v_looked, 1), 0) > 0 then
    perform public.bottom_cards_random(p_session_id, p_controller, v_looked);
  end if;
  return v_tid;
end;
$$;
grant execute on function public.exile_until_cheaper(uuid, uuid, integer) to authenticated;
