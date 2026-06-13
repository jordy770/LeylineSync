-- supabase/functions_src/return_all_from_graveyard.sql
-- CANONICAL current definition (seeded from 202605010214_grimoire_of_the_dead.sql,
-- the newest definition in supabase/migrations — verified per bug-682).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs.

create or replace function public.return_all_from_graveyard(
  p_session_id uuid,
  p_controller_id uuid,
  p_creature_type text,
  p_to text,
  -- mig 214 (Grimoire of the Dead): true = sweep ALL graveyards (any owner) and
  -- put the cards onto the battlefield under p_controller_id's control.
  p_all_graveyards boolean default false,
  -- mig 269 (Open the Vaults): a types array replaces the creature filter
  -- ('artifact','enchantment'), and under_owner returns each card to ITS
  -- owner's battlefield control instead of the caster's.
  p_types jsonb default null,
  p_under_owner boolean default false
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
      -- types array (mig 269, Open the Vaults: artifacts AND enchantments)
      -- replaces the default creature filter when present.
      and (case when jsonb_typeof(p_types) = 'array' then
                  exists (select 1 from jsonb_array_elements_text(p_types) t
                          where c.type_line ilike '%' || t.value || '%')
                else c.type_line ilike '%creature%'
                  and (p_creature_type is null or c.type_line ilike '%' || p_creature_type || '%')
           end)
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
          controller_player_id = case when p_all_graveyards and not p_under_owner then p_controller_id else owner_id end,
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
grant execute on function public.return_all_from_graveyard(uuid, uuid, text, text, boolean, jsonb, boolean) to authenticated;
grant execute on function public.return_all_from_graveyard(uuid, uuid, text, text, boolean, jsonb, boolean) to service_role;
