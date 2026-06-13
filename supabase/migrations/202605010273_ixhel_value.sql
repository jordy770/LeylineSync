-- 202605010273_ixhel_value
-- Ixhel value batch (12 cards, mig 273): Golgari Signet, Grateful
-- Apparition, Ichor Rats, Ichorclaw Myr, Infectious Inquiry, Karn's
-- Bastion, Night's Whisper, Mortify, Pestilent Syphoner, Painful Truths,
-- Necroblossom Snarl, plus the becomes_blocked event.
-- Engine: declare_blocker fires 'becomes_blocked' card triggers on the
-- attacker (Ichorclaw Myr +2/+2; multi-blocker combats fire once per
-- blocker — approximation). Everything else is script-only:
-- Ichor Rats = add_poison each_opponent + controller (each player);
-- Painful Truths = flat draw 3 / lose 3 (converge not counted);
-- Necroblossom Snarl rides the enters_tapped unless hand_has_type gate.
-- Generated from supabase/functions_src (declare_blocker) — those files are
-- the canonical current definitions; edit them, not past migrations.

create or replace function public.declare_blocker(
  p_session_id uuid, p_blocker_card_id uuid, p_attacker_card_id uuid
) returns public.game_combat_assignments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_assignment public.game_combat_assignments;
  v_blocker_type_line text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select status
  into v_session_status
  from public.game_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Game session not found';
  end if;

  if v_session_status = 'finished' then
    raise exception 'Cannot declare blockers in a finished game session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if v_turn_state.step <> 'declare_blockers' then
    raise exception 'Blockers can only be declared during Declare Blockers Step';
  end if;

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can declare blockers';
  end if;

  select *
  into v_assignment
  from public.game_combat_assignments
  where session_id = p_session_id
    and turn_number = v_turn_state.turn_number
    and attacker_card_id = p_attacker_card_id
  for update;

  if not found then
    raise exception 'Attacker assignment not found';
  end if;

  if v_assignment.defending_player_id <> auth.uid() then
    raise exception 'Only the defending player can block this attacker';
  end if;

  perform 1
  from public.game_combat_blockers
  where session_id = p_session_id
    and turn_number = v_turn_state.turn_number
    and blocker_card_id = p_blocker_card_id;

  if found then
    raise exception 'This blocker is already assigned';
  end if;

  select cards.type_line
  into v_blocker_type_line
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_blocker_card_id
    and game_cards.session_id = p_session_id
    and coalesce(game_cards.controller_player_id, game_cards.owner_id) = auth.uid()
    and game_cards.zone = 'battlefield'
    and game_cards.is_tapped = false;

  if not found then
    raise exception 'Blocker card not found, not on battlefield, not controlled by defending player, or already tapped';
  end if;

  if coalesce(v_blocker_type_line, '') not ilike '%creature%' then
    raise exception 'Only creatures can be declared as blockers';
  end if;

  -- Flying legality: only flying or reach creatures can block a flying attacker.
  if public.card_has_flying(p_session_id, p_attacker_card_id) then
    if not (
      public.card_has_flying(p_session_id, p_blocker_card_id) or
      public.card_has_reach(p_session_id, p_blocker_card_id)
    ) then
      raise exception 'Only creatures with flying or reach can block a flying creature';
    end if;
  end if;

  -- Protection: an attacker with protection from the blocker's colour can't be
  -- blocked by it.
  if public.card_has_protection_from_any(
       p_session_id, p_attacker_card_id,
       public.game_card_color_set(p_session_id, p_blocker_card_id)
     ) then
    raise exception 'Attacker has protection from this blocker''s colour and cannot be blocked by it';
  end if;

  -- Intimidate: only artifact creatures and/or creatures sharing a colour with the
  -- attacker can block it.
  if public.card_has_intimidate(p_session_id, p_attacker_card_id) then
    if not (
      exists (
        select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.id = p_blocker_card_id and gc.session_id = p_session_id and c.type_line ilike '%artifact%'
      )
      or public.game_card_color_set(p_session_id, p_blocker_card_id)
         && public.game_card_color_set(p_session_id, p_attacker_card_id)
    ) then
      raise exception 'An intimidating creature can only be blocked by artifact creatures or creatures that share a colour with it';
    end if;
  end if;

  insert into public.game_combat_blockers (
    assignment_id,
    session_id,
    turn_number,
    attacker_card_id,
    blocker_card_id,
    blocking_player_id
  )
  values (
    v_assignment.id,
    p_session_id,
    v_turn_state.turn_number,
    p_attacker_card_id,
    p_blocker_card_id,
    auth.uid()
  );

  update public.game_combat_assignments
  set blocker_card_id = coalesce(blocker_card_id, p_blocker_card_id)
  where id = v_assignment.id
  returning * into v_assignment;

  -- "Whenever this creature becomes blocked" (mig 273, Ichorclaw Myr): fired
  -- once per block declaration against the ATTACKER. (Multi-blocker combats
  -- fire once per blocker — approximation; the real event fires once.)
  perform public.fire_card_triggers(
    p_session_id, p_attacker_card_id, array['becomes_blocked']);

  return v_assignment;
end;
$$;
grant execute on function public.declare_blocker(uuid, uuid, uuid) to anon, authenticated, service_role;
