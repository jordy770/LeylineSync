-- supabase/functions_src/note_graveyard_cast.sql
-- CANONICAL current definition (created in mig 206).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs.

create or replace function public.note_graveyard_cast(
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
  set turn_graveyard_casts = case
        when turn_graveyard_casts_turn = v_turn then turn_graveyard_casts + 1
        else 1
      end,
      turn_graveyard_casts_turn = v_turn
  where session_id = p_session_id and player_id = p_player_id;
end;
$fn$;
grant execute on function public.note_graveyard_cast(uuid, uuid) to authenticated, service_role;
