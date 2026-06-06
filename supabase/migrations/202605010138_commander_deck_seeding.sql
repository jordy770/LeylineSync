-- Commander (EDH), slice 3 — the DECK side: designate a commander on a deck and
-- seed it into the command zone at game start.
--
-- decks gains commander_card_id (the card that starts in the command zone; kept
-- OUT of list_data, which is the other 99). spawn_deck_for_session is a new SQL RPC
-- that seeds a player's deck into a game: list_data → shuffled library, and — in a
-- Commander game — the deck's commander → the command zone (is_commander). It
-- replaces the untestable `spawn-deck` Deno edge function with an in-DB,
-- harness-testable path consistent with the rest of the engine.
--
-- DEFERRED (later slices): the text importer capturing a 'Commander' section into
-- commander_card_id (users set it via set_deck_commander for now), and deck legality
-- (100-card singleton + colour identity). (IDE T-SQL false-positives on $$ — ignore.)

-- ---------------------------------------------------------------------------
-- 1. The commander designation on a deck.
-- ---------------------------------------------------------------------------
alter table public.decks
  add column if not exists commander_card_id uuid;

comment on column public.decks.commander_card_id is
  'The deck''s commander (a catalog cards.id). Starts in the command zone at game start; not included in list_data.';

create or replace function public.set_deck_commander(p_deck_id uuid, p_card_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  update public.decks
  set commander_card_id = p_card_id
  where id = p_deck_id
    and owner_id = auth.uid();

  if not found then
    raise exception 'Deck not found or not owned by current user';
  end if;
end;
$$;

grant execute on function public.set_deck_commander(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. spawn_deck_for_session — seed the caller's deck into the game. Library is the
-- shuffled list_data; in a Commander game the deck's commander enters the command
-- zone instead. One deck per player per session (the guard the edge fn enforced).
-- ---------------------------------------------------------------------------
create or replace function public.spawn_deck_for_session(p_session_id uuid, p_deck_id uuid)
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

grant execute on function public.spawn_deck_for_session(uuid, uuid) to authenticated;
grant execute on function public.spawn_deck_for_session(uuid, uuid) to service_role;
