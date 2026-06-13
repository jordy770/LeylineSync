-- supabase/functions_src/bottom_cards_random.sql
-- CANONICAL current definition (created in mig 223).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs.

create or replace function public.bottom_cards_random(
  p_session_id uuid, p_owner uuid, p_ids uuid[]
) returns void
language plpgsql security definer set search_path = public
as $fn$
declare
  v_base integer;
begin
  if p_ids is null or cardinality(p_ids) = 0 then
    return;
  end if;
  -- Bottom = the highest zone_positions. Place the given cards below every
  -- OTHER library card (which keeps its position), shuffled among themselves.
  select coalesce(max(zone_position), -1) into v_base
  from public.game_cards
  where session_id = p_session_id and owner_id = p_owner and zone = 'library'
    and not (id = any(p_ids));

  update public.game_cards gc
  set zone = 'library', zone_position = v_base + r.rn
  from (select id, row_number() over (order by random()) as rn from unnest(p_ids) as id) r
  where gc.id = r.id and gc.session_id = p_session_id;
end;
$fn$;
grant execute on function public.bottom_cards_random(uuid, uuid, uuid[]) to authenticated, service_role;
