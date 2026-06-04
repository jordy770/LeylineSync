create table if not exists public.decks (
  id uuid primary key default gen_random_uuid(),
  name text,
  list_data jsonb not null default '[]'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now()
);

alter table public.decks
add column if not exists name text;

alter table public.decks
add column if not exists created_by uuid;

alter table public.decks
add column if not exists created_at timestamptz not null default now();

alter table public.decks enable row level security;

drop policy if exists "Authenticated users can read decks"
on public.decks;

create policy "Users can read own decks"
on public.decks
for select
to authenticated
using (created_by = auth.uid());

drop policy if exists "Users can insert own decks"
on public.decks;

create policy "Users can insert own decks"
on public.decks
for insert
to authenticated
with check (created_by = auth.uid());

drop policy if exists "Users can update own decks"
on public.decks;

create policy "Users can update own decks"
on public.decks
for update
to authenticated
using (created_by = auth.uid())
with check (created_by = auth.uid());

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
    select regexp_split_to_table(p_decklist, E'\\r?\\n')
  loop
    v_line_number := v_line_number + 1;
    v_clean_line := trim(v_line);

    if v_clean_line = ''
      or left(v_clean_line, 1) = '#'
      or lower(v_clean_line) in ('deck', 'sideboard', 'commander')
    then
      continue;
    end if;

    v_clean_line := regexp_replace(v_clean_line, '^\\s*SB:\\s*', '', 'i');

    if v_clean_line ~* '^\\d+x?\\s+.+' then
      v_quantity := substring(v_clean_line from '^\\d+')::integer;
      v_card_name := trim(regexp_replace(v_clean_line, '^\\d+x?\\s+', '', 'i'));
    else
      v_quantity := 1;
      v_card_name := v_clean_line;
    end if;

    v_card_name := trim(regexp_replace(v_card_name, '\\s+\\([^)]*\\)\\s+\\d+\\s*$', ''));
    v_card_name := trim(regexp_replace(v_card_name, '\\s+\\([^)]*\\)\\s*$', ''));
    v_card_name := trim(regexp_replace(v_card_name, '\\s+\\[[^]]*\\]\\s*$', ''));

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
    raise exception 'No matching cards found in decklist';
  end if;

  insert into public.decks (
    name,
    list_data,
    created_by
  )
  values (
    v_deck_name,
    v_card_ids,
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
