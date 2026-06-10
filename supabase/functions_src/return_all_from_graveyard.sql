-- supabase/functions_src/return_all_from_graveyard.sql
-- CANONICAL current definition (seeded from 202605010185_mass_destroy_and_reanimate.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

create or replace function public.return_all_from_graveyard(
  p_session_id uuid,
  p_controller_id uuid,
  p_creature_type text,
  p_to text,
  -- mig 214 (Grimoire of the Dead): true = sweep ALL graveyards (any owner) and
  -- put the cards onto the battlefield under p_controller_id's control.
  p_all_graveyards boolean default false
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card uuid;
  v_pos integer;
  v_turn integer;
  v_zone text;
begin
  v_zone := case when p_to = 'hand' then 'hand' else 'battlefield' end;
  select turn_number into v_turn from public.game_turn_state where session_id = p_session_id;
  for v_card in
    select gc.id
    from public.game_cards gc
    join public.cards c on c.id = gc.card_id
    where gc.session_id = p_session_id
      and gc.zone = 'graveyard'
      and (p_all_graveyards or gc.owner_id = p_controller_id)
      and c.type_line ilike '%creature%'
      and (p_creature_type is null or c.type_line ilike '%' || p_creature_type || '%')
    order by gc.zone_position, gc.id
  loop
    select coalesce(max(zone_position), -1) + 1 into v_pos
    from public.game_cards
    where session_id = p_session_id
      and owner_id = (select owner_id from public.game_cards where id = v_card)
      and zone = v_zone;
    if v_zone = 'battlefield' then
      update public.game_cards
      set zone = 'battlefield', zone_position = v_pos,
          controller_player_id = case when p_all_graveyards then p_controller_id else owner_id end,
          is_tapped = false, damage_marked = 0, plus_one_counters = 0,
          entered_battlefield_turn_number = coalesce(v_turn, 0)
      where id = v_card;
    else
      update public.game_cards
      set zone = 'hand', zone_position = v_pos, is_tapped = false
      where id = v_card;
    end if;
  end loop;
end;
$$;
grant execute on function public.return_all_from_graveyard(uuid, uuid, text, text, boolean) to authenticated;
