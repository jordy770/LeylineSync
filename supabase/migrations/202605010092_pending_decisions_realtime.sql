-- Phase 1: make game_pending_decisions a realtime source.
--
-- The controller subscribes to postgres_changes on game_pending_decisions so the
-- decision prompt appears/clears live. A table only emits realtime events if it's
-- in the supabase_realtime publication; the new table wasn't, so add it (guarded,
-- since ADD TABLE errors if it's already a member). (IDE T-SQL false-positives on $$.)

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'game_pending_decisions'
  ) then
    alter publication supabase_realtime add table public.game_pending_decisions;
  end if;
end;
$$;
