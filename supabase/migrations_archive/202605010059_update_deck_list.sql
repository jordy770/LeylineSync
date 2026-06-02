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

  if v_deck.created_by <> auth.uid() then
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
  set list_data = to_jsonb(p_card_ids)
  where id = p_deck_id;

  return jsonb_build_object(
    'id', p_deck_id,
    'card_count', v_card_count
  );
end;
$$;

grant execute on function public.update_deck_list(uuid, uuid[]) to authenticated;
