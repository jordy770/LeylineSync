-- Commander (EDH) — importer auto-captures the Commander.
--
-- import_deck_from_text previously treated a 'Commander' section header like
-- 'deck'/'sideboard' (skipped), so the commander card just landed in list_data and
-- the user had to designate it by hand (the ★ toggle). Now the importer tracks the
-- section: the FIRST card under a 'Commander' header is captured into the deck's
-- commander_card_id (and still counted in list_data — Commander decks are 100 cards
-- INCLUDING the commander; spawn_deck_for_session already excludes it from the
-- library so it isn't double-seeded). No Commander section → commander_card_id stays
-- null and the ★ toggle still works (backward compatible).
--
-- Baseline lift (no later migration redefines import_deck_from_text) — verbatim
-- except the section tracking + commander capture + the commander_card_id on insert.
-- (IDE T-SQL false-positives on $$ bodies — ignore.)

create or replace function public.import_deck_from_text(p_name text, p_decklist text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $_$
declare
  v_deck_name text := nullif(trim(p_name), '');
  v_line text;
  v_clean_line text;
  v_quantity integer;
  v_card_name text;
  v_card_id uuid;
  v_card_ids jsonb := '[]'::jsonb;
  v_missing jsonb := '[]'::jsonb;
  v_line_number integer := 0;
  v_total_count integer := 0;
  v_deck_id uuid;
  v_in_commander boolean := false;
  v_commander_id uuid := null;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if v_deck_name is null then
    raise exception 'Deck name is required';
  end if;

  if nullif(trim(coalesce(p_decklist, '')), '') is null then
    raise exception 'Decklist is required';
  end if;

  for v_line in
    select regexp_split_to_table(p_decklist, E'\r?\n')
  loop
    v_line_number := v_line_number + 1;
    v_clean_line := trim(v_line);

    -- Section headers: 'Commander' opens the commander section; any other section
    -- (Deck/Sideboard) closes it. Blank/# lines are skipped without changing it.
    if v_clean_line = '' or left(v_clean_line, 1) = '#' then
      continue;
    end if;
    if lower(v_clean_line) = 'commander' then
      v_in_commander := true;
      continue;
    end if;
    if lower(v_clean_line) in ('deck', 'sideboard') then
      v_in_commander := false;
      continue;
    end if;

    v_clean_line := regexp_replace(v_clean_line, '^[[:space:]]*SB:[[:space:]]*', '', 'i');

    if v_clean_line ~* '^[0-9]+x?[[:space:]]+.+' then
      v_quantity := substring(v_clean_line from '^[0-9]+')::integer;
      v_card_name := trim(regexp_replace(v_clean_line, '^[0-9]+x?[[:space:]]+', '', 'i'));
    else
      v_quantity := 1;
      v_card_name := v_clean_line;
    end if;

    v_card_name := trim(regexp_replace(v_card_name, '[[:space:]]+\([^)]*\)[[:space:]]+[0-9]+[[:space:]]*$', ''));
    v_card_name := trim(regexp_replace(v_card_name, '[[:space:]]+\([^)]*\)[[:space:]]*$', ''));
    v_card_name := trim(regexp_replace(v_card_name, '[[:space:]]+\[[^]]*\][[:space:]]*$', ''));

    if v_quantity <= 0 or v_card_name = '' then
      continue;
    end if;

    select cards.id
    into v_card_id
    from public.cards
    where lower(cards.name) = lower(v_card_name)
    order by
      case when cards.image_url is null then 1 else 0 end,
      cards.name,
      cards.id
    limit 1;

    if not found then
      v_missing := v_missing || jsonb_build_array(
        jsonb_build_object(
          'line_number', v_line_number,
          'line', v_clean_line,
          'name', v_card_name,
          'quantity', v_quantity
        )
      );
      continue;
    end if;

    -- The first resolved card under a Commander header is the commander.
    if v_in_commander and v_commander_id is null then
      v_commander_id := v_card_id;
    end if;

    for i in 1..v_quantity loop
      v_card_ids := v_card_ids || jsonb_build_array(v_card_id);
      v_total_count := v_total_count + 1;
    end loop;
  end loop;

  if v_total_count = 0 then
    return jsonb_build_object(
      'id', null,
      'name', v_deck_name,
      'card_count', 0,
      'commander_card_id', null,
      'missing', v_missing
    );
  end if;

  insert into public.decks (
    name,
    list_data,
    commander_card_id,
    created_by,
    owner_id
  )
  values (
    v_deck_name,
    v_card_ids,
    v_commander_id,
    auth.uid(),
    auth.uid()
  )
  returning id into v_deck_id;

  return jsonb_build_object(
    'id', v_deck_id,
    'name', v_deck_name,
    'card_count', v_total_count,
    'commander_card_id', v_commander_id,
    'missing', v_missing
  );
end;
$_$;

grant execute on function public.import_deck_from_text(text, text) to anon, authenticated, service_role;
