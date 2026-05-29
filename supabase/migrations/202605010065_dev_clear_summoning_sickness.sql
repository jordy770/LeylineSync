-- Judge tool: zero out entered_battlefield_turn_number so the creature
-- passes the summoning sickness check on its next attack declaration.
create or replace function public.dev_clear_summoning_sickness(
  p_session_id uuid,
  p_game_card_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card public.game_cards;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select *
  into v_card
  from public.game_cards
  where id = p_game_card_id
    and session_id = p_session_id
  for update;

  if not found then
    raise exception 'Card not found in this session';
  end if;

  update public.game_cards
  set entered_battlefield_turn_number = 0
  where id = p_game_card_id
    and session_id = p_session_id;

  perform public.dev_log_action(
    p_session_id,
    null,
    'dev_clear_summoning_sickness',
    format('Cleared summoning sickness on card %s', p_game_card_id),
    jsonb_build_object('entered_battlefield_turn_number', v_card.entered_battlefield_turn_number),
    jsonb_build_object('entered_battlefield_turn_number', 0)
  );
end;
$$;

grant execute on function public.dev_clear_summoning_sickness(uuid, uuid) to authenticated;
