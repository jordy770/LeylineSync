-- supabase/functions_src/spawn_deck_for_session.sql
-- CANONICAL current definition (seeded from 202605010141_commander_deck_legality.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.
--
-- Precon support: the deck lookup also accepts a shared precon deck (is_precon,
-- owner_id null) so any player can spawn one — not just decks they own.

create or replace function public.spawn_deck_for_session(
  p_session_id uuid,
  p_deck_id uuid,
  p_enforce_legality boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_format text;
  v_list jsonb;
  v_commander uuid;
  v_library_count integer;
  v_seeded_commander boolean := false;
  v_legality jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if exists (
    select 1 from public.game_cards
    where session_id = p_session_id and owner_id = auth.uid()
  ) then
    raise exception 'You already have a deck in this session';
  end if;

  select format into v_format
  from public.game_sessions where id = p_session_id;
  if not found then
    raise exception 'Game session not found';
  end if;

  -- A player may seed a deck they own OR a shared precon deck.
  select list_data, commander_card_id
  into v_list, v_commander
  from public.decks
  where id = p_deck_id and (owner_id = auth.uid() or is_precon = true);
  if not found then
    raise exception 'Deck not found or not owned by current user';
  end if;

  if jsonb_typeof(coalesce(v_list, '[]'::jsonb)) <> 'array' then
    raise exception 'Deck list is empty or not an array';
  end if;

  -- A Commander game refuses an illegal deck (100/singleton/colour identity).
  if v_format = 'commander' and p_enforce_legality then
    v_legality := public.commander_deck_legality(p_deck_id);
    if not (v_legality ->> 'legal')::boolean then
      raise exception 'Deck is not Commander-legal: %',
        coalesce(
          (select string_agg(issue, '; ')
           from jsonb_array_elements_text(v_legality -> 'issues') as issue),
          'unknown'
        );
    end if;
  end if;

  -- Library: list_data shuffled (0-based zone_position). In a Commander game the
  -- commander is excluded here — it goes to the command zone below — so a decklist
  -- that still lists the commander (e.g. imported from text) isn't double-seeded.
  insert into public.game_cards (
    session_id, card_id, owner_id, controller_player_id, zone, zone_position
  )
  select
    p_session_id,
    t.cid::uuid,
    auth.uid(),
    auth.uid(),
    'library',
    (row_number() over (order by random()))::integer - 1
  from jsonb_array_elements_text(coalesce(v_list, '[]'::jsonb)) as t(cid)
  where v_format <> 'commander' or v_commander is null or t.cid::uuid <> v_commander;

  get diagnostics v_library_count = row_count;

  -- Commander → command zone (Commander games only).
  if v_format = 'commander' and v_commander is not null then
    insert into public.game_cards (
      session_id, card_id, owner_id, controller_player_id, zone, zone_position, is_commander
    )
    values (
      p_session_id, v_commander, auth.uid(), auth.uid(), 'command', 0, true
    );
    v_seeded_commander := true;
  end if;

  return jsonb_build_object(
    'library', v_library_count,
    'commander_seeded', v_seeded_commander
  );
end;
$$;

grant execute on function public.spawn_deck_for_session(uuid, uuid, boolean) to authenticated;
grant execute on function public.spawn_deck_for_session(uuid, uuid, boolean) to service_role;
