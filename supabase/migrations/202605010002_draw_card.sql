alter table public.game_cards
add column if not exists zone_position integer not null default 0;

with ordered_cards as (
  select
    id,
    row_number() over (
      partition by session_id, owner_id, zone
      order by zone_position, id
    ) - 1 as next_position
  from public.game_cards
)
update public.game_cards
set zone_position = ordered_cards.next_position
from ordered_cards
where public.game_cards.id = ordered_cards.id;

create index if not exists game_cards_library_draw_idx
on public.game_cards (session_id, owner_id, zone, zone_position, id);

create or replace function public.draw_card(
  p_session_id uuid,
  p_player_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card_id uuid;
  v_next_hand_position integer;
begin
  if p_player_id <> auth.uid() then
    raise exception 'Cannot draw for another player';
  end if;

  select coalesce(max(zone_position), -1) + 1
  into v_next_hand_position
  from public.game_cards
  where session_id = p_session_id
    and owner_id = auth.uid()
    and zone = 'hand';

  select id
  into v_card_id
  from public.game_cards
  where session_id = p_session_id
    and owner_id = auth.uid()
    and zone = 'library'
  order by zone_position asc, id asc
  limit 1
  for update skip locked;

  if v_card_id is null then
    raise exception 'Library is empty';
  end if;

  update public.game_cards
  set
    zone = 'hand',
    zone_position = v_next_hand_position,
    is_tapped = false
  where id = v_card_id;

  return v_card_id;
end;
$$;

grant execute on function public.draw_card(uuid, uuid) to authenticated;
