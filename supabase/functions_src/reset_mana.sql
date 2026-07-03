-- supabase/functions_src/reset_mana.sql
-- "Undo tap mana" — a trust-based QoL action (like the manual life / tap buttons):
-- untaps the caller's tapped MANA SOURCES (lands + any permanent with a mana
-- ability — rocks, dorks) and empties their floating mana (open + restricted).
-- Only ever touches the caller's own permanents/pool. Edit THIS file, then
-- generate a migration with scripts/new-migration.mjs.
create or replace function public.reset_mana(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  -- Untap the caller's tapped mana sources: lands, or any permanent whose
  -- effective script has an is_mana_ability (mana rocks / dorks).
  update public.game_cards gc
  set is_tapped = false
  where gc.session_id = p_session_id
    and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
    and gc.zone = 'battlefield'
    and gc.is_tapped = true
    and (
      exists (
        select 1 from public.cards c
        where c.id = gc.card_id and c.type_line ilike '%land%'
      )
      or exists (
        select 1
        from jsonb_array_elements(
          coalesce(public.effective_script(p_session_id, gc.id) -> 'activated_abilities', '[]'::jsonb)
        ) a
        where coalesce((a ->> 'is_mana_ability')::boolean, false)
      )
    );

  -- Empty the caller's floating mana (open pool + any restricted mana).
  update public.game_players
  set mana_pool = jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0),
      restricted_mana = '[]'::jsonb
  where session_id = p_session_id and player_id = auth.uid();
end;
$$;
grant execute on function public.reset_mana(uuid) to authenticated;
