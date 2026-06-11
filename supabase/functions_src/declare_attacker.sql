-- supabase/functions_src/declare_attacker.sql
-- CANONICAL current definition (seeded from 202605010199_curse_of_disturbance.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

create or replace function public.declare_attacker(
  p_session_id uuid,
  p_attacker_card_id uuid,
  p_defending_player_id uuid,
  p_defending_planeswalker_id uuid default null,
  p_exert boolean default false
) returns public.game_combat_assignments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_attacker record;
  v_pw record;
  v_defending_player uuid := p_defending_player_id;
  v_assignment public.game_combat_assignments;
  v_curse record;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  -- Attacking a planeswalker: the defending player is its controller.
  if p_defending_planeswalker_id is not null then
    select coalesce(gc.controller_player_id, gc.owner_id) as controller, c.type_line
    into v_pw
    from public.game_cards gc
    join public.cards c on c.id = gc.card_id
    where gc.id = p_defending_planeswalker_id
      and gc.session_id = p_session_id
      and gc.zone = 'battlefield';
    if not found or coalesce(v_pw.type_line, '') not ilike '%planeswalker%' then
      raise exception 'Defending planeswalker not found on the battlefield';
    end if;
    v_defending_player := v_pw.controller;
  end if;

  if not public.is_session_player(p_session_id, v_defending_player) then
    raise exception 'Defending player is not a player in this session';
  end if;

  if v_defending_player = auth.uid() then
    raise exception 'A player cannot attack themselves';
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
    raise exception 'Cannot declare attackers in a finished game session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if v_turn_state.active_player_id <> auth.uid() then
    raise exception 'Only the active player can declare attackers';
  end if;

  if v_turn_state.step <> 'declare_attackers' then
    raise exception 'Attackers can only be declared during Declare Attackers Step';
  end if;

  select
    game_cards.id,
    game_cards.is_tapped,
    game_cards.entered_battlefield_turn_number,
    cards.type_line
  into v_attacker
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_attacker_card_id
    and game_cards.session_id = p_session_id
    and coalesce(game_cards.controller_player_id, game_cards.owner_id) = auth.uid()
    and game_cards.zone = 'battlefield'
  for update of game_cards;

  if not found then
    raise exception 'Attacker card not found, not on battlefield, or not controlled by active player';
  end if;

  if coalesce(v_attacker.type_line, '') not ilike '%creature%' then
    raise exception 'Only creatures can be declared as attackers';
  end if;

  if v_attacker.is_tapped then
    raise exception 'Tapped creatures cannot be declared as attackers';
  end if;

  if coalesce(v_attacker.entered_battlefield_turn_number, v_turn_state.turn_number) >= v_turn_state.turn_number
    and not public.card_has_haste(p_session_id, p_attacker_card_id)
  then
    raise exception 'Creature has summoning sickness';
  end if;

  -- Attack restriction (Gadrak: "can't attack unless you control four or more
  -- artifacts"). A top-level script prop {count, at_least}; the count is read
  -- for the attacking player (auth.uid()).
  declare
    v_restrict jsonb := public.effective_script(p_session_id, p_attacker_card_id) -> 'cant_attack_unless';
  begin
    if v_restrict is not null
       and public.resolve_count_amount(p_session_id, auth.uid(), v_restrict)
           < coalesce((v_restrict ->> 'at_least')::integer, 1)
    then
      raise exception 'This creature cannot attack: an attack condition is not met';
    end if;
  end;

  -- Goad (mig 249): a goaded creature can't attack the player who goaded it
  -- while another opponent is available ("attacks a player other than you if
  -- able"). With only one opponent, attacking the goader is legal.
  if exists (
    select 1 from public.game_continuous_effects ce
    where ce.session_id = p_session_id and ce.effect_type = 'goaded'
      and ce.affected_card_id = p_attacker_card_id
      and nullif(ce.payload ->> 'goaded_by', '')::uuid = v_defending_player
  ) and exists (
    select 1 from public.game_session_players sp
    where sp.session_id = p_session_id
      and sp.player_id not in (auth.uid(), v_defending_player)
  ) then
    raise exception 'This creature is goaded: it must attack a player other than its goader';
  end if;

  -- Territorial Hellkite (mig 249): a must_attack marker pins THIS combat's
  -- defender to the randomly chosen opponent.
  if (select gc.counters ->> 'must_attack' from public.game_cards gc where gc.id = p_attacker_card_id)
       is not null
     and (select gc.counters ->> 'must_attack' from public.game_cards gc where gc.id = p_attacker_card_id)
       is distinct from v_defending_player::text then
    raise exception 'This creature must attack the randomly chosen player this combat';
  end if;

  update public.game_cards
  set is_tapped = true
  where id = p_attacker_card_id
    and not public.card_has_vigilance(p_session_id, p_attacker_card_id);

  insert into public.game_combat_assignments (
    session_id,
    turn_number,
    attacker_card_id,
    attacking_player_id,
    defending_player_id,
    defending_planeswalker_id
  )
  values (
    p_session_id,
    v_turn_state.turn_number,
    p_attacker_card_id,
    auth.uid(),
    v_defending_player,
    p_defending_planeswalker_id
  )
  returning * into v_assignment;

  -- Remember the defender + consume the pin (mig 249, Territorial Hellkite's
  -- "an opponent that this creature didn't attack during your last combat").
  -- Only stamped for creatures whose script uses territorial_attack, so the
  -- counter bag stays clean for everything else.
  if (select gc.counters ? 'must_attack' from public.game_cards gc where gc.id = p_attacker_card_id)
     or public.effective_script(p_session_id, p_attacker_card_id)::text like '%territorial_attack%' then
    update public.game_cards
    set counters = (coalesce(counters, '{}'::jsonb) - 'must_attack')
          || jsonb_build_object('last_attacked', v_defending_player::text)
    where id = p_attacker_card_id and session_id = p_session_id;
  end if;

  -- Exert (mig 236, Glorybringer): "You may exert this creature as it attacks.
  -- When you do, <effects>." Exerting marks it (so it skips its next untap, see
  -- advance_step) and enqueues the exert effects (a targeted attack trigger).
  if p_exert then
    declare
      v_exert jsonb := public.effective_script(p_session_id, p_attacker_card_id) -> 'exert';
    begin
      if v_exert is not null and jsonb_typeof(v_exert) = 'array' then
        update public.game_cards
        set counters = public.adjust_counter_bag(coalesce(counters, '{}'::jsonb), 'exerted', 1)
        where id = p_attacker_card_id and session_id = p_session_id;
        perform public.enqueue_triggered_ability(
          p_session_id, auth.uid(), p_attacker_card_id, 'Exert', v_exert);
      end if;
    end;
  end if;

  -- Curse of Disturbance: when the defending player is attacked, each curse
  -- enchanting them makes its controller create a 2/2 black Zombie — and "each
  -- opponent attacking that player does the same" (the attacking player too).
  for v_curse in
    select ce.source_card_id, coalesce(gc.controller_player_id, gc.owner_id) as curse_controller
    from public.game_continuous_effects ce
    join public.game_cards gc on gc.id = ce.source_card_id
      and gc.session_id = p_session_id and gc.zone = 'battlefield'
    where ce.session_id = p_session_id
      and ce.effect_type = 'curse_attacked'
      and ce.affected_player_id = v_defending_player
  loop
    perform public.enqueue_triggered_ability(
      p_session_id, v_curse.curse_controller, v_curse.source_card_id,
      'Curse of Disturbance', jsonb_build_array(jsonb_build_object('type', 'create_token', 'token', 'Zombie Token')));
    if auth.uid() is distinct from v_curse.curse_controller then
      perform public.enqueue_triggered_ability(
        p_session_id, auth.uid(), v_curse.source_card_id,
        'Curse of Disturbance', jsonb_build_array(jsonb_build_object('type', 'create_token', 'token', 'Zombie Token')));
    end if;
  end loop;

  return v_assignment;
end;
$$;
grant execute on function public.declare_attacker(uuid, uuid, uuid, uuid, boolean) to authenticated;
grant execute on function public.declare_attacker(uuid, uuid, uuid, uuid, boolean) to service_role;
