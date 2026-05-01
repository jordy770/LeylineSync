update public.game_cards
set zone = 'battlefield'
where zone is null
   or zone not in ('library', 'hand', 'battlefield', 'graveyard', 'exile');

alter table public.game_cards
drop constraint if exists game_cards_zone_check;

alter table public.game_cards
add constraint game_cards_zone_check
check (zone in ('library', 'hand', 'battlefield', 'graveyard', 'exile'));

create or replace function public.move_card_to_zone(
  p_game_card_id uuid,
  p_zone text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_zone not in ('library', 'hand', 'battlefield', 'graveyard', 'exile') then
    raise exception 'Invalid zone: %', p_zone;
  end if;

  update public.game_cards
  set
    zone = p_zone,
    is_tapped = false
  where id = p_game_card_id
    and owner_id = auth.uid();

  if not found then
    raise exception 'Card not found or not owned by current user';
  end if;
end;
$$;

grant execute on function public.move_card_to_zone(uuid, text) to authenticated;
