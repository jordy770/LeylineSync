-- 202605010327_realtime_game_tables
-- Make the rest of the game tables realtime sources. Only game_pending_decisions
-- was added to supabase_realtime by a migration (mig 092); the others were added
-- on hosted via the dashboard, so a fresh LOCAL db only published that one table.
-- The controller/board hooks subscribe to all of these, so without them realtime
-- is silent and the UI only updated via the fallback poll. Guarded (ADD TABLE
-- errors if already a member), so it's a no-op on hosted. (IDE T-SQL false-
-- positives on $$.)

do $$
declare
  t text;
begin
  foreach t in array array[
    'game_cards', 'game_sessions', 'game_players', 'game_session_players',
    'game_turn_state', 'game_stack_items', 'game_combat_assignments',
    'game_combat_blockers', 'game_continuous_effects', 'game_commander_damage'
  ]
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;
