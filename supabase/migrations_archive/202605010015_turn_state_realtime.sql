do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'game_turn_state'
  ) then
    alter publication supabase_realtime add table public.game_turn_state;
  end if;
end;
$$;
