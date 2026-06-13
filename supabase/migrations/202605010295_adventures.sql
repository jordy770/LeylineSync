-- 202605010295_adventures
-- Adventure mechanic (mig 295). cast_spell_effect gains a p_adventure flag: when
-- set, the source card is exiled (not sent to the graveyard) with a non-expiring
-- play_from_exile permission, so its creature face can be cast from exile later
-- (Hypnotic Sprite, Murderous Rider, Hildibrand Manderville). advance_step's
-- impulse-window cleanup now skips permission rows flagged payload.permanent.
-- Adding p_adventure changes the signature, so the old 5-arg overload is dropped
-- first (5-arg positional callers resolve to the new 6-arg via the default).
-- Generated from supabase/functions_src (cast_spell_effect, advance_step) — those files are
-- the canonical current definitions; edit them, not past migrations.

drop function if exists public.cast_spell_effect(uuid, jsonb, uuid, integer, uuid);

create or replace function public.cast_spell_effect(
  p_session_id uuid,
  p_actions jsonb,
  p_source_card_id uuid default null,
  p_x_value integer default null,
  p_target_card_id uuid default null,
  -- Adventure (mig 295): casting the adventure HALF of a card. On resolution the
  -- source goes to exile (not the graveyard) with a non-expiring play_from_exile
  -- permission, so the creature face can be cast from exile later.
  p_adventure boolean default false
)
returns public.game_stack_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn public.game_turn_state;
  v_session_status text;
  v_source_type_line text;
  v_source_zone text;
  v_source_mana_cost text;
  v_source_script jsonb;
  v_flashback_cost text;
  v_flashback_life integer;
  v_is_flashback boolean := false;
  v_program jsonb;
  v_timing text;
  v_pending integer;
  v_next_position integer;
  v_next_graveyard integer;
  v_next_exile integer;
  v_resolved_actions jsonb;
  v_stack public.game_stack_items;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if jsonb_typeof(p_actions) <> 'array' or jsonb_array_length(p_actions) < 1 then
    raise exception 'Spell effect needs at least one action';
  end if;

  select status into v_session_status
  from public.game_sessions where id = p_session_id for update;
  if not found then
    raise exception 'Game session not found';
  end if;
  if v_session_status = 'finished' then
    raise exception 'Cannot cast in a finished game session';
  end if;

  select * into v_turn
  from public.game_turn_state where session_id = p_session_id for update;
  if not found then
    raise exception 'Turn state not found';
  end if;
  if coalesce(v_turn.priority_player_id, v_turn.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can cast';
  end if;

  if p_source_card_id is not null then
    select cards.type_line, cards.mana_cost, game_cards.zone, cards.script
      into v_source_type_line, v_source_mana_cost, v_source_zone, v_source_script
    from public.game_cards
    join public.cards on cards.id = game_cards.card_id
    where game_cards.id = p_source_card_id
      and game_cards.session_id = p_session_id
      and game_cards.owner_id = auth.uid();
    if not found then
      raise exception 'Source card not found or not owned by current user';
    end if;
  end if;

  -- Timing: instants any time the caster has priority; sorceries main-phase only,
  -- empty stack, active player. A sourceless cast (tests) defaults to instant.
  if v_source_type_line ilike '%sorcery%' then
    v_timing := 'sorcery';
  else
    v_timing := 'instant';
  end if;

  if v_timing = 'sorcery' then
    if v_turn.active_player_id <> auth.uid() then
      raise exception 'Sorcery actions can only be used by the active player';
    end if;
    if v_turn.step not in ('precombat_main', 'postcombat_main') then
      raise exception 'Sorcery actions can only be used during a main phase';
    end if;
    select count(*) into v_pending
    from public.game_stack_items
    where session_id = p_session_id and status = 'pending';
    if v_pending > 0 then
      raise exception 'Sorcery actions can only be used while the stack is empty';
    end if;
  end if;

  -- The spell program. A FLASHBACK (graveyard) cast uses the script's
  -- `flashback_effect` actions when present, REPLACING the normal effect (the
  -- "Increasing …" cards do more / different on flashback). The engine selects by
  -- cast zone — it does not trust the client's actions for the flashback effect.
  if v_source_zone = 'graveyard'
     and jsonb_typeof(v_source_script -> 'flashback_effect' -> 'actions') = 'array'
     and jsonb_array_length(v_source_script -> 'flashback_effect' -> 'actions') > 0 then
    v_program := v_source_script -> 'flashback_effect' -> 'actions';
  else
    v_program := p_actions;
  end if;

  -- Resolve any top-level "X" amount/count to the caster-chosen x_value before it
  -- is stored on the stack item (resolution code never sees the "X" token).
  select coalesce(jsonb_agg(
    case
      when (elem ->> 'amount') = 'X' or (elem ->> 'count') = 'X' then
        elem
          || (case when (elem ->> 'amount') = 'X'
                then jsonb_build_object('amount', greatest(coalesce(p_x_value, 0), 0)) else '{}'::jsonb end)
          || (case when (elem ->> 'count') = 'X'
                then jsonb_build_object('count', greatest(coalesce(p_x_value, 0), 0)) else '{}'::jsonb end)
      else elem
    end
    order by ord
  ), '[]'::jsonb)
  into v_resolved_actions
  from jsonb_array_elements(v_program) with ordinality as t(elem, ord);

  -- Pay the cast cost. A hand cast pays the printed mana cost (incl {X}). A graveyard
  -- cast is a FLASHBACK: it requires the card's script to carry a `flashback` cost,
  -- pays that instead, and marks the card for exile (below). No-op when the source is
  -- sourceless or free (the free-cast test fixtures).
  if p_source_card_id is not null and v_source_zone = 'hand' then
    if v_source_mana_cost is not null and btrim(v_source_mana_cost) <> '' then
      -- Cost reduction (mig 231, Draconic Lore: "costs {2} less if you control a
      -- Dragon"). Generic mana is auto-paid here (null generic payment), so the
      -- reduced cost is consumed with no client change.
      perform public.pay_mana_cost(
        p_session_id, auth.uid(),
        public.reduced_mana_cost(p_session_id, auth.uid(), p_source_card_id, v_source_mana_cost),
        null, coalesce(p_x_value, 0));
    end if;
  elsif p_source_card_id is not null and v_source_zone = 'graveyard' then
    v_flashback_cost := v_source_script ->> 'flashback';
    if v_flashback_cost is null then
      raise exception 'This card cannot be cast from your graveyard';
    end if;
    v_is_flashback := true;
    if btrim(v_flashback_cost) <> '' then
      perform public.pay_mana_cost(p_session_id, auth.uid(), v_flashback_cost, null, coalesce(p_x_value, 0));
    end if;
    -- Additional "Pay N life" flashback cost (Deep Analysis). You cannot pay life
    -- you do not have.
    v_flashback_life := coalesce((v_source_script ->> 'flashback_life')::integer, 0);
    if v_flashback_life > 0 then
      if (select life_total from public.game_session_players
          where session_id = p_session_id and player_id = auth.uid()) < v_flashback_life then
        raise exception 'Not enough life to pay the flashback cost (need %)', v_flashback_life;
      end if;
      update public.game_session_players
      set life_total = life_total - v_flashback_life
      where session_id = p_session_id and player_id = auth.uid();
    end if;
    -- Turn-stamped graveyard-cast tracker (mig 206, Laboratory Drudge).
    perform public.note_graveyard_cast(p_session_id, auth.uid());
  end if;

  select coalesce(max(position), 0) + 1 into v_next_position
  from public.game_stack_items where session_id = p_session_id;

  insert into public.game_stack_items (
    session_id, controller_player_id, source_card_id, action_type, payload, position, status
  )
  values (
    p_session_id,
    auth.uid(),
    p_source_card_id,
    'spell_effect',
    jsonb_build_object('effects', v_resolved_actions, 'controller_player_id', auth.uid(), 'timing', v_timing)
      || (case when p_target_card_id is not null
               then jsonb_build_object('target_card_id', p_target_card_id) else '{}'::jsonb end),
    v_next_position,
    'pending'
  )
  returning * into v_stack;

  -- "Whenever you/an opponent cast a spell" (mig 234, Taurean Mauler): broadcast
  -- the cast to spell_cast watchers. The caster is the source's controller.
  if p_source_card_id is not null then
    perform public.fire_watcher_triggers(p_session_id, p_source_card_id, auth.uid(), 'spell_cast');
  end if;

  -- Adventure (mig 295): the card is exiled with a non-expiring play_from_exile
  -- permission so its creature face can be cast from exile later. Checked before
  -- the type_line graveyard rule because the source is a CREATURE card.
  if p_adventure and p_source_card_id is not null then
    select coalesce(max(zone_position), -1) + 1 into v_next_exile
    from public.game_cards
    where session_id = p_session_id and owner_id = auth.uid() and zone = 'exile';

    update public.game_cards
    set zone = 'exile', zone_position = v_next_exile, controller_player_id = owner_id,
        is_tapped = false, damage_marked = 0
    where id = p_source_card_id;

    insert into public.game_continuous_effects (
      session_id, source_card_id, affected_player_id, effect_type, payload
    ) values (
      p_session_id, p_source_card_id, auth.uid(), 'play_from_exile',
      jsonb_build_object('card_ids', jsonb_build_array(p_source_card_id), 'permanent', true)
    );

  -- Non-permanent spell leaves its cast zone on cast: a hand cast goes to the
  -- graveyard; a flashback cast (from the graveyard) is exiled instead.
  elsif v_is_flashback then
    select coalesce(max(zone_position), -1) + 1 into v_next_exile
    from public.game_cards
    where session_id = p_session_id and owner_id = auth.uid() and zone = 'exile';

    update public.game_cards
    set zone = 'exile', zone_position = v_next_exile, controller_player_id = owner_id,
        is_tapped = false, damage_marked = 0
    where id = p_source_card_id;

  elsif p_source_card_id is not null
    and v_source_zone = 'hand'
    and (v_source_type_line ilike '%instant%' or v_source_type_line ilike '%sorcery%')
  then
    select coalesce(max(zone_position), -1) + 1 into v_next_graveyard
    from public.game_cards
    where session_id = p_session_id and owner_id = auth.uid() and zone = 'graveyard';

    update public.game_cards
    set zone = 'graveyard', zone_position = v_next_graveyard, is_tapped = false, damage_marked = 0
    where id = p_source_card_id;
  end if;

  return v_stack;
end;
$$;
grant execute on function public.cast_spell_effect(uuid, jsonb, uuid, integer, uuid, boolean) to authenticated;

create or replace function public.advance_step(p_session_id uuid)
returns public.game_turn_state
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_state public.game_turn_state;
  v_session_status text;
  v_required_player_id uuid;
  v_next_active_player_id uuid;
  v_next_priority_player_id uuid;
  v_next_phase text;
  v_next_step text;
  v_next_turn_number integer;
  v_next_lands_played_this_turn integer;
  v_drawn_card_id uuid;
  v_next_hand_position integer;
  v_revert uuid;
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
    raise exception 'Cannot advance a finished game session';
  end if;

  select *
  into v_current_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  v_required_player_id := coalesce(v_current_state.priority_player_id, v_current_state.active_player_id);

  if v_required_player_id <> auth.uid() then
    raise exception 'Only the priority player can advance the step';
  end if;

  perform public.clear_mana_pool_for_step(
    p_session_id,
    v_current_state.phase,
    v_current_state.step
  );

  perform public.expire_continuous_effects_for_step(
    p_session_id,
    v_current_state.turn_number,
    v_current_state.phase,
    v_current_state.step
  );

  -- Impulse play windows (mig 230, Atsushi: "until the end of your next turn").
  -- A play_from_exile permission survives the turn it was created in and expires
  -- when its owner leaves the end step of a LATER turn (their next turn).
  if v_current_state.step = 'end' then
    delete from public.game_continuous_effects ce
    where ce.session_id = p_session_id
      and ce.effect_type = 'play_from_exile'
      and ce.affected_player_id = v_current_state.active_player_id
      -- Adventure permissions (mig 295) never expire — the creature face can be
      -- cast from exile at any later time.
      and coalesce((ce.payload ->> 'permanent')::boolean, false) = false
      and coalesce((ce.payload ->> 'created_turn')::integer, 0) < v_current_state.turn_number;

    -- Territorial Hellkite (mig 249): an unconsumed must_attack pin lapses
    -- when the combat is over (end step).
    update public.game_cards
    set counters = counters - 'must_attack'
    where session_id = p_session_id and counters ? 'must_attack';

    -- Hellkite Courser (mig 248): "return it to the command zone at the
    -- beginning of the next end step" — processed when the end step is left.
    for v_revert in
      select gc.id from public.game_cards gc
      where gc.session_id = p_session_id and gc.zone = 'battlefield'
        and gc.counters ? 'return_to_command'
    loop
      update public.game_cards gc
      set zone = 'command', is_tapped = false, damage_marked = 0,
          controller_player_id = gc.owner_id,
          counters = gc.counters - 'return_to_command',
          zone_position = (select coalesce(max(zone_position), -1) + 1
                           from public.game_cards x
                           where x.session_id = p_session_id and x.owner_id = gc.owner_id
                             and x.zone = 'command')
      where gc.id = v_revert;
    end loop;

    -- Become-copy "until end of turn" (mig 240, Sarkhan, Soul Aflame): revert
    -- when the end step is left. Every effect row the copy sources is dropped
    -- (incl. the except-keyword grants), card_id flips back to the original,
    -- and the re-register restores the original's script effects.
    for v_revert in
      select gc.id from public.game_cards gc
      where gc.session_id = p_session_id and gc.zone = 'battlefield'
        and gc.copy_revert_at_turn is not null
        and gc.copy_revert_at_turn <= v_current_state.turn_number
    loop
      delete from public.game_continuous_effects
      where session_id = p_session_id and source_card_id = v_revert;
      update public.game_cards
      set card_id = copy_original_card_id,
          copied_script = null,
          copy_original_card_id = null,
          copy_revert_at_turn = null
      where id = v_revert;
      perform public.register_card_continuous_effects(p_session_id, v_revert);
    end loop;
  end if;

  v_next_active_player_id := v_current_state.active_player_id;
  v_next_priority_player_id := v_current_state.active_player_id;
  v_next_turn_number := v_current_state.turn_number;
  v_next_lands_played_this_turn := coalesce(v_current_state.lands_played_this_turn, 0);
  v_next_phase := v_current_state.phase;
  v_next_step := v_current_state.step;

  case v_current_state.step
    when 'untap' then
      delete from public.game_combat_assignments
      where session_id = p_session_id;

      -- Exert (mig 236, Glorybringer): an exerted creature "won't untap during
      -- your next untap step." Skip untapping it this once, then clear the marker
      -- so it untaps normally next time.
      update public.game_cards
      set is_tapped = false
      where session_id = p_session_id
        and owner_id = v_current_state.active_player_id
        and zone = 'battlefield'
        and is_tapped = true
        and coalesce((counters ->> 'exerted')::integer, 0) = 0;

      update public.game_cards
      set counters = counters - 'exerted'
      where session_id = p_session_id
        and owner_id = v_current_state.active_player_id
        and zone = 'battlefield'
        and counters ? 'exerted';

      v_next_phase := 'beginning';
      v_next_step := 'upkeep';
    when 'upkeep' then
      v_next_phase := 'beginning';
      v_next_step := 'draw';
    when 'draw' then
      if coalesce(v_current_state.skip_next_draw, false) then
        -- CR 103.8a (mig 221): in a TWO-player game the starting player skips
        -- the draw step of their first turn. start_game_session sets the flag;
        -- consume it instead of drawing.
        update public.game_turn_state
        set skip_next_draw = false
        where session_id = p_session_id;
      else
        select coalesce(max(zone_position), -1) + 1
        into v_next_hand_position
        from public.game_cards
        where session_id = p_session_id
          and owner_id = v_current_state.active_player_id
          and zone = 'hand';

        select id
        into v_drawn_card_id
        from public.game_cards
        where session_id = p_session_id
          and owner_id = v_current_state.active_player_id
          and zone = 'library'
        order by zone_position asc, id asc
        limit 1
        for update skip locked;

        if v_drawn_card_id is null then
          raise exception 'Library is empty';
        end if;

        update public.game_cards
        set
          zone = 'hand',
          zone_position = v_next_hand_position,
          is_tapped = false,
          damage_marked = 0
        where id = v_drawn_card_id;
      end if;

      v_next_phase := 'main_1';
      v_next_step := 'precombat_main';
    when 'precombat_main' then
      v_next_phase := 'combat';
      v_next_step := 'beginning_of_combat';
    when 'beginning_of_combat' then
      v_next_phase := 'combat';
      v_next_step := 'declare_attackers';
    when 'declare_attackers' then
      v_next_phase := 'combat';
      v_next_step := 'declare_blockers';

      select defending_player_id
      into v_next_priority_player_id
      from public.game_combat_assignments
      where session_id = p_session_id
        and turn_number = v_current_state.turn_number
        and blocker_card_id is null
      order by created_at
      limit 1;

      v_next_priority_player_id := coalesce(v_next_priority_player_id, v_current_state.active_player_id);
    when 'declare_blockers' then
      -- Menace: a blocked attacker with menace must have two or more blockers.
      -- Checked here (block declaration is finished) — a lone blocker is illegal.
      -- Blockers live one-row-per-blocker in game_combat_blockers.
      if exists (
        select 1
        from public.game_combat_blockers cb
        where cb.session_id = p_session_id
          and cb.turn_number = v_current_state.turn_number
          and public.card_has_menace(p_session_id, cb.attacker_card_id)
        group by cb.attacker_card_id
        having count(*) = 1
      ) then
        raise exception 'A creature with menace must be blocked by two or more creatures';
      end if;

      v_next_priority_player_id := v_current_state.active_player_id;
      v_next_phase := 'combat';
      v_next_step := 'combat_damage';
    when 'combat_damage' then
      v_next_phase := 'combat';
      v_next_step := 'end_of_combat';
    when 'end_of_combat' then
      delete from public.game_combat_assignments
      where session_id = p_session_id;

      -- Extra combat phase (mig 250, Scourge of the Throne): consume one
      -- pending extra combat and loop back instead of moving to main 2.
      if coalesce(v_current_state.extra_combats, 0) > 0 then
        update public.game_turn_state
        set extra_combats = extra_combats - 1
        where session_id = p_session_id;
        v_next_phase := 'combat';
        v_next_step := 'beginning_of_combat';
      else
        v_next_phase := 'main_2';
        v_next_step := 'postcombat_main';
      end if;
    when 'postcombat_main' then
      v_next_phase := 'ending';
      v_next_step := 'end';
      -- Monarch draw (mig 262, Regal Behemoth): "at the beginning of the
      -- monarch's end step, that player draws a card." Best-effort: an empty
      -- library skips the draw instead of erroring.
      if v_current_state.monarch_player_id = v_current_state.active_player_id then
        select id into v_drawn_card_id
        from public.game_cards
        where session_id = p_session_id
          and owner_id = v_current_state.active_player_id and zone = 'library'
        order by zone_position asc, id asc
        limit 1;
        if v_drawn_card_id is not null then
          select coalesce(max(zone_position), -1) + 1 into v_next_hand_position
          from public.game_cards
          where session_id = p_session_id
            and owner_id = v_current_state.active_player_id and zone = 'hand';
          update public.game_cards
          set zone = 'hand', zone_position = v_next_hand_position, is_tapped = false
          where id = v_drawn_card_id;
        end if;
      end if;
    when 'end' then
      v_next_phase := 'ending';
      v_next_step := 'cleanup';
    when 'cleanup' then
      delete from public.game_combat_assignments
      where session_id = p_session_id;

      update public.game_cards
      set damage_marked = 0
      where session_id = p_session_id
        and damage_marked <> 0;

      -- Hand the turn to the next LIVING player by seat order (skip eliminated).
      select next_player.player_id
      into v_next_active_player_id
      from public.game_session_players current_player
      join public.game_session_players next_player
        on next_player.session_id = current_player.session_id
       and next_player.seat_number > current_player.seat_number
       and next_player.life_total > 0
      where current_player.session_id = p_session_id
        and current_player.player_id = v_current_state.active_player_id
      order by next_player.seat_number
      limit 1;

      if v_next_active_player_id is null then
        select player_id
        into v_next_active_player_id
        from public.game_session_players
        where session_id = p_session_id
          and life_total > 0
        order by seat_number
        limit 1;
      end if;

      if v_next_active_player_id is null then
        raise exception 'No players found for game session';
      end if;

      v_next_priority_player_id := v_next_active_player_id;
      v_next_turn_number := v_current_state.turn_number + 1;
      v_next_lands_played_this_turn := 0;
      v_next_phase := 'beginning';
      v_next_step := 'untap';
    else
      raise exception 'Unsupported turn step: %', v_current_state.step;
  end case;

  update public.game_turn_state
  set
    active_player_id = v_next_active_player_id,
    priority_player_id = v_next_priority_player_id,
    priority_cycle_started_by = null,
    priority_pass_count = 0,
    lands_played_this_turn = v_next_lands_played_this_turn,
    turn_number = v_next_turn_number,
    phase = v_next_phase,
    step = v_next_step
  where session_id = p_session_id
  returning * into v_current_state;

  -- Reset per-turn life-loss tracking at the start of each new turn (mig 294).
  -- 'untap' is reached only on the end -> next-turn transition, so this fires
  -- once per turn AFTER the end-step triggers (Y'shtola) have read the tally.
  if v_next_step = 'untap' then
    update public.game_session_players
    set life_lost_this_turn = 0
    where session_id = p_session_id;
  end if;

  return v_current_state;
end;
$$;
grant execute on function public.advance_step(uuid) to authenticated;
