-- Commander (EDH) — SERVER-SIDE deck legality enforcement.
--
-- The deck editor already shows a legality verdict (client-only, lib/game/
-- deck-insights.ts: commanderDeckLegality). This adds the authoritative server
-- counterpart so an illegal Commander deck cannot be seeded into a Commander game.
--
-- New:
--   * card_color_identity(card_id) — a card's colour identity from the mana symbols
--     in its mana_cost AND the {...} symbols in its oracle_text (mirrors the client's
--     cardColorIdentity), reusing card_color_set (mig 131). NOT raw-text scanning —
--     oracle text is reduced to its {...} symbols first so stray letters in words
--     (Whenever/Goblin/Forest) don't pollute the identity.
--   * commander_deck_legality(deck_id) -> jsonb {legal, card_count, issues[]} — the
--     server verdict: exactly 100 cards (commander counted in list_data, per the
--     importer), singleton (no duplicate non-basics), every card within the
--     commander's colour identity.
--   * spawn_deck_for_session gains p_enforce_legality (default true): a Commander
--     game refuses to seed an illegal deck. Reproduced from mig 138 + the gate; the
--     2-arg version is dropped so only the enforcing signature remains (production
--     omits the arg → default true; the test harness passes false for its minimal
--     fixtures). Library/commander seeding is otherwise byte-identical to mig 138.
-- (IDE T-SQL false-positives on $$ bodies — ignore.)

-- ---------------------------------------------------------------------------
-- 1. card_color_identity — mana_cost + oracle {...} symbols → colour names.
-- ---------------------------------------------------------------------------
create or replace function public.card_color_identity(p_card_id uuid)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select public.card_color_set(
    coalesce((select mana_cost from public.cards where id = p_card_id), '')
    || ' ' ||
    coalesce((
      select string_agg(m[1], ' ')
      from public.cards c,
           lateral regexp_matches(coalesce(c.oracle_text, ''), '\{([^}]+)\}', 'g') as m
      where c.id = p_card_id
    ), '')
  );
$$;

grant execute on function public.card_color_identity(uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. commander_deck_legality — the whole-deck verdict (CR 903.5).
-- ---------------------------------------------------------------------------
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
  where id = p_deck_id and owner_id = auth.uid();
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

-- ---------------------------------------------------------------------------
-- 3. spawn_deck_for_session + legality gate (mig 138 lift + p_enforce_legality).
-- ---------------------------------------------------------------------------
drop function if exists public.spawn_deck_for_session(uuid, uuid);

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

  select list_data, commander_card_id
  into v_list, v_commander
  from public.decks
  where id = p_deck_id and owner_id = auth.uid();
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
