create or replace function public.untap_all(
  p_session_id uuid,
  p_player_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated_count integer;
begin
  if p_player_id <> auth.uid() then
    raise exception 'Cannot untap cards for another player';
  end if;

  update public.game_cards
  set is_tapped = false
  where session_id = p_session_id
    and owner_id = auth.uid()
    and zone = 'battlefield'
    and is_tapped = true;

  get diagnostics v_updated_count = row_count;

  return v_updated_count;
end;
$$;

grant execute on function public.untap_all(uuid, uuid) to authenticated;
