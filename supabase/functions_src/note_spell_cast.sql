-- supabase/functions_src/note_spell_cast.sql
-- CANONICAL current definition (new in mig 369, Alisaie's Dualcast).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs.
--
-- Increments a per-turn, per-player tally of spells cast (turn-stamped like
-- note_graveyard_cast). Called from fire_watcher_triggers on the 'spell_cast'
-- event, so it counts exactly what the engine treats as "a spell you cast".
-- Read via resolve_count_amount('spells_cast_this_turn'); powers "the Nth spell
-- you cast each turn costs less" (Alisaie Leveilleur — Dualcast).

create or replace function public.note_spell_cast(
  p_session_id uuid, p_player_id uuid
) returns void
language plpgsql security definer set search_path = public
as $fn$
declare
  v_turn integer;
begin
  select turn_number into v_turn
  from public.game_turn_state where session_id = p_session_id;

  update public.game_session_players
  set turn_spells_cast = case
        when turn_spells_cast_turn = v_turn then turn_spells_cast + 1
        else 1
      end,
      turn_spells_cast_turn = v_turn
  where session_id = p_session_id and player_id = p_player_id;
end;
$fn$;
grant execute on function public.note_spell_cast(uuid, uuid) to authenticated, service_role;
