alter table public.decks
add column if not exists owner_id uuid;

update public.decks
set created_by = owner_id
where created_by is null
  and owner_id is not null;

update public.decks
set owner_id = created_by
where owner_id is null
  and created_by is not null;

drop policy if exists "Users can read own decks"
on public.decks;

create policy "Users can read own decks"
on public.decks
for select
to authenticated
using (
  created_by = auth.uid()
  or owner_id = auth.uid()
);

drop policy if exists "Users can insert own decks"
on public.decks;

create policy "Users can insert own decks"
on public.decks
for insert
to authenticated
with check (
  created_by = auth.uid()
  and owner_id = auth.uid()
);

drop policy if exists "Users can update own decks"
on public.decks;

create policy "Users can update own decks"
on public.decks
for update
to authenticated
using (
  created_by = auth.uid()
  or owner_id = auth.uid()
)
with check (
  created_by = auth.uid()
  and owner_id = auth.uid()
);

create or replace function public.import_deck_from_text(
  p_name text,
  p_decklist text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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

    if v_clean_line = ''
      or left(v_clean_line, 1) = '#'
      or lower(v_clean_line) in ('deck', 'sideboard', 'commander')
    then
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
      'missing', v_missing
    );
  end if;

  insert into public.decks (
    name,
    list_data,
    created_by,
    owner_id
  )
  values (
    v_deck_name,
    v_card_ids,
    auth.uid(),
    auth.uid()
  )
  returning id into v_deck_id;

  return jsonb_build_object(
    'id', v_deck_id,
    'name', v_deck_name,
    'card_count', v_total_count,
    'missing', v_missing
  );
end;
$$;

grant execute on function public.import_deck_from_text(text, text) to authenticated;

create or replace function public.update_deck_list(
  p_deck_id uuid,
  p_card_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deck public.decks;
  v_card_id uuid;
  v_missing uuid[] := '{}'::uuid[];
  v_card_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select *
  into v_deck
  from public.decks
  where id = p_deck_id
  for update;

  if not found then
    raise exception 'Deck not found';
  end if;

  if coalesce(v_deck.created_by, v_deck.owner_id) <> auth.uid()
    and v_deck.owner_id <> auth.uid()
  then
    raise exception 'Current user does not own this deck';
  end if;

  if p_card_ids is null or array_length(p_card_ids, 1) is null then
    raise exception 'Deck must contain at least one card';
  end if;

  foreach v_card_id in array p_card_ids
  loop
    if not exists (
      select 1
      from public.cards
      where id = v_card_id
    ) then
      v_missing := array_append(v_missing, v_card_id);
    end if;
  end loop;

  if array_length(v_missing, 1) is not null then
    raise exception 'Deck contains unknown card ids: %', array_to_string(v_missing, ', ');
  end if;

  v_card_count := array_length(p_card_ids, 1);

  update public.decks
  set
    list_data = to_jsonb(p_card_ids),
    created_by = coalesce(created_by, auth.uid()),
    owner_id = coalesce(owner_id, auth.uid())
  where id = p_deck_id;

  return jsonb_build_object(
    'id', p_deck_id,
    'card_count', v_card_count
  );
end;
$$;

grant execute on function public.update_deck_list(uuid, uuid[]) to authenticated;
