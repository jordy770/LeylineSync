-- supabase/functions_src/commander_deck_legality.sql
-- CANONICAL current definition (seeded from 202605010141_commander_deck_legality.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.
--
-- Precon support: the deck lookup also accepts a shared precon deck (is_precon,
-- owner_id null) so spawn_deck_for_session can legality-check one before seeding.

create or replace function public.commander_deck_legality(p_deck_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_list jsonb;
  v_commander uuid;
  v_card_count integer;
  v_allowed text[];
  v_issues text[] := array[]::text[];
  v_singleton integer;
  v_offidentity integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select list_data, commander_card_id
  into v_list, v_commander
  from public.decks
  where id = p_deck_id and (owner_id = auth.uid() or is_precon = true);
  if not found then
    raise exception 'Deck not found or not owned by current user';
  end if;

  if jsonb_typeof(coalesce(v_list, '[]'::jsonb)) <> 'array' then
    v_list := '[]'::jsonb;
  end if;

  -- Card count (the commander is counted in list_data, per the importer).
  v_card_count := jsonb_array_length(v_list);
  if v_commander is null then
    v_issues := v_issues || 'No commander designated';
  end if;
  if v_card_count <> 100 then
    v_issues := v_issues || format('%s cards (a Commander deck must be exactly 100)', v_card_count);
  end if;

  -- Singleton: any non-basic card listed more than once.
  select count(*)
  into v_singleton
  from (
    select t.cid, count(*) as n
    from jsonb_array_elements_text(v_list) as t(cid)
    join public.cards c on c.id = t.cid::uuid
    where not (lower(coalesce(c.type_line, '')) like '%basic%'
               and lower(coalesce(c.type_line, '')) like '%land%')
    group by t.cid
    having count(*) > 1
  ) dupes;
  if v_singleton > 0 then
    v_issues := v_issues || format('%s card(s) listed more than once (singleton rule)', v_singleton);
  end if;

  -- Colour identity: every distinct card must be within the commander's identity.
  if v_commander is not null then
    v_allowed := public.card_color_identity(v_commander);
    select count(*)
    into v_offidentity
    from (
      select distinct t.cid::uuid as cid
      from jsonb_array_elements_text(v_list) as t(cid)
    ) cards
    where exists (
      select 1
      from unnest(public.card_color_identity(cards.cid)) as col
      where col <> all (v_allowed)
    );
    if v_offidentity > 0 then
      v_issues := v_issues || format('%s card(s) outside the commander''s colour identity', v_offidentity);
    end if;
  end if;

  return jsonb_build_object(
    'legal', array_length(v_issues, 1) is null,
    'card_count', v_card_count,
    'issues', to_jsonb(v_issues)
  );
end;
$$;

grant execute on function public.commander_deck_legality(uuid) to authenticated, service_role;
