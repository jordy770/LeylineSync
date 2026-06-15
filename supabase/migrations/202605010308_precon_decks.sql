-- 202605010308_precon_decks
-- Shared/global precon decks: curated Commander decklists every player can pick
-- in the lobby, not just decks they own.
--
-- decks gains `is_precon` (a shared deck) and `owner_id` becomes nullable (a
-- precon belongs to no player). An RLS SELECT policy exposes precon rows to all
-- authenticated users (writes stay owner-only — precons are seeded by the
-- service role via scripts/seed-precon-decks.mjs, which bypasses RLS). The two
-- functions below relax their deck lookup from `owner_id = auth.uid()` to also
-- accept `is_precon = true`, so any player can legality-check and spawn one.
--
-- Generated from supabase/functions_src (spawn_deck_for_session, commander_deck_legality) — those files are
-- the canonical current definitions; edit them, not past migrations.

alter table public.decks
  add column if not exists is_precon boolean not null default false;

-- A precon has no owner; existing owner-scoped rows are unaffected.
alter table public.decks
  alter column owner_id drop not null;

comment on column public.decks.is_precon is
  'A shared, curated precon deck (owner_id null) selectable by every player in the lobby.';

create index if not exists idx_decks_precon on public.decks (is_precon) where is_precon;

-- Everyone may read precon decks (in addition to the existing own-deck policies).
drop policy if exists "Anyone can read precon decks" on public.decks;
create policy "Anyone can read precon decks"
  on public.decks for select
  to authenticated
  using (is_precon = true);

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
