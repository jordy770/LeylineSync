-- 202605010290_no_restamp_sickness
-- False summoning sickness fix (mig 290): move_card_to_zone re-stamped
-- entered_battlefield_turn_number (and force-untapped) whenever called with
-- 'battlefield', even for a card ALREADY there — board repositioning or
-- judge-view re-sends made veteran creatures sick again. Both effects now
-- fire only on a genuine entry.
-- Generated from supabase/functions_src (move_card_to_zone) — those files are
-- the canonical current definitions; edit them, not past migrations.

create or replace function public.move_card_to_zone(
  p_game_card_id uuid,
  p_zone text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
  v_turn_number integer;
begin
  if p_zone not in ('library', 'hand', 'stack', 'battlefield', 'graveyard', 'exile') then
    raise exception 'Invalid zone: %', p_zone;
  end if;

  if p_zone = 'battlefield' then
    select turn_number
    into v_turn_number
    from public.game_turn_state
    where session_id = (
      select session_id
      from public.game_cards
      where id = p_game_card_id
        and owner_id = auth.uid()
    );
  end if;

  update public.game_cards
  set
    zone = p_zone,
    -- Stamp only on a GENUINE entry (mig 290): re-sending 'battlefield' for
    -- a card already there (board repositioning / judge corrections) must
    -- not reset summoning sickness — or untap it, for that matter.
    entered_battlefield_turn_number = case
      when p_zone = 'battlefield' and zone is distinct from 'battlefield'
        then coalesce(v_turn_number, entered_battlefield_turn_number, 0)
      else entered_battlefield_turn_number
    end,
    is_tapped = case
      when p_zone = 'battlefield' and zone = 'battlefield' then is_tapped
      else false
    end
  where id = p_game_card_id
    and owner_id = auth.uid()
  returning session_id into v_session_id;

  if not found then
    raise exception 'Card not found or not owned by current user';
  end if;

  perform public.rebuild_scripted_continuous_effects(v_session_id);
end;
$$;
grant execute on function public.move_card_to_zone(uuid, text) to authenticated;
