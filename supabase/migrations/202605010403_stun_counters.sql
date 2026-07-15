-- 202605010403_stun_counters
-- TODO: describe the change.
-- Generated from supabase/functions_src (advance_step, apply_creature_effect) — those files are
-- the canonical current definitions; edit them, not past migrations.

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
  v_cleanup record;
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

    -- "Sacrifice/exile it at the beginning of the next end step" (Electroduplicate
    -- / Flameshadow Conjuring, mig 347): remove copy tokens marked for cleanup.
    for v_cleanup in
      select id from public.game_cards
      where session_id = p_session_id and zone = 'battlefield' and counters ? 'cleanup_at_end_step'
    loop
      perform public.put_in_graveyard(p_session_id, v_cleanup.id);
    end loop;

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
        and coalesce((counters ->> 'exerted')::integer, 0) = 0
        -- Stun (mig 403, Frost Titan): a stunned permanent skips this untap.
        and coalesce((counters ->> 'stun')::integer, 0) = 0;

      -- Each skipped untap consumes ONE stun counter (a multi-stunned permanent
      -- stays down for that many of its untap steps).
      update public.game_cards
      set counters = public.adjust_counter_bag(counters, 'stun', -1)
      where session_id = p_session_id
        and owner_id = v_current_state.active_player_id
        and zone = 'battlefield'
        and is_tapped = true
        and coalesce((counters ->> 'stun')::integer, 0) > 0;

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

        -- card_drawn watcher (mig 401): tally + broadcast with the 1-based
        -- draw index (Ethereal Investigator's "second card each turn").
        perform public.fire_watcher_triggers(
          p_session_id, v_drawn_card_id, v_current_state.active_player_id, 'card_drawn',
          jsonb_build_object('draw_number',
            public.note_card_drawn(p_session_id, v_current_state.active_player_id)));
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
      -- "Exile the tokens at end of combat" (Myriad / Delina / Echoing Assault,
      -- mig 355): remove copy tokens marked for end-of-combat cleanup.
      for v_cleanup in
        select id from public.game_cards
        where session_id = p_session_id and zone = 'battlefield' and counters ? 'cleanup_at_end_combat'
      loop
        perform public.put_in_graveyard(p_session_id, v_cleanup.id);
      end loop;
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

create or replace function public.apply_creature_effect(
  p_session_id uuid,
  p_kind text,
  p_target_card_id uuid,
  p_params jsonb default '{}'::jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount integer;
  v_pump_power integer;
  v_pump_tough integer;
  v_target_owner_id uuid;
  v_next_position integer;
  v_keyword text;
  v_acting_controller uuid;
  v_duration text;
  v_prev_controller uuid;
  v_counter_type text;
  v_all boolean;
  v_top_card uuid;
  v_top_type text;
  v_turn integer;
  v_goad_players integer;
begin
  if p_target_card_id is null then
    return;
  end if;

  -- Amount may be a number, "X" (→0), or { counters, of } resolved against game state.
  -- of:"you" → the acting controller; of:"target" → this target permanent.
  v_amount := public.resolve_dynamic_amount(
    p_session_id, null,
    nullif(p_params ->> 'acting_controller', '')::uuid,
    p_params -> 'amount',
    p_target_card_id);

  if p_kind = 'deal_damage' then
    if v_amount > 0 then
      perform public.apply_damage_to_creature(
        p_session_id, p_target_card_id, v_amount, null, false,
        coalesce((p_params ->> 'deathtouch')::boolean, false)
      );
    end if;

  elsif p_kind = 'destroy' then
    perform public.put_in_graveyard(p_session_id, p_target_card_id);

  elsif p_kind = 'exile' then
    select owner_id into v_target_owner_id
    from public.game_cards
    where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield';
    if found then
      select coalesce(max(zone_position), -1) + 1 into v_next_position
      from public.game_cards
      where session_id = p_session_id and owner_id = v_target_owner_id and zone = 'exile';
      update public.game_cards
      set zone = 'exile', zone_position = v_next_position, controller_player_id = owner_id,
          is_tapped = false, damage_marked = 0, dealt_deathtouch_damage = false, plus_one_counters = 0
      where id = p_target_card_id;
    end if;

  elsif p_kind = 'animate' then
    -- Land animation (mig 277, Obuun / Embodiment of Insight / Waker of the
    -- Wilds): "target land becomes an X/X Elemental creature … It's still a
    -- land." An 'animated' row marks creature-ness for the combat gates
    -- (declare_attacker / declare_blocker); set_pt pins the P/T; keywords
    -- ride along. permanent:true (Waker) skips the end-of-turn expiry.
    if exists (select 1 from public.game_cards where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield') then
      v_pump_power := public.resolve_dynamic_amount(
        p_session_id, nullif(p_params ->> 'acting_source', '')::uuid,
        nullif(p_params ->> 'acting_controller', '')::uuid,
        p_params -> 'power', p_target_card_id);
      v_pump_tough := public.resolve_dynamic_amount(
        p_session_id, nullif(p_params ->> 'acting_source', '')::uuid,
        nullif(p_params ->> 'acting_controller', '')::uuid,
        p_params -> 'toughness', p_target_card_id);
      insert into public.game_continuous_effects (
        session_id, source_card_id, affected_card_id, effect_type, payload,
        source_zone_required, expires_at_phase, expires_at_step
      )
      select p_session_id, p_target_card_id, p_target_card_id, e.kind, e.payload,
             'battlefield',
             case when coalesce((p_params ->> 'permanent')::boolean, false) then null else 'ending' end,
             case when coalesce((p_params ->> 'permanent')::boolean, false) then null else 'cleanup' end
      from (
        select 'set_pt'::text as kind,
               jsonb_build_object('power', v_pump_power, 'toughness', v_pump_tough,
                                  'until_end_of_turn', not coalesce((p_params ->> 'permanent')::boolean, false)) as payload
        union all
        select 'animated', '{}'::jsonb
        union all
        select lower(k.value), '{}'::jsonb
        from jsonb_array_elements_text(coalesce(p_params -> 'keywords', '[]'::jsonb)) k
        where lower(k.value) in ('trample', 'haste', 'flying', 'vigilance', 'first_strike',
                                 'double_strike', 'reach', 'deathtouch', 'menace',
                                 'indestructible', 'hexproof')
      ) e;
    end if;

  elsif p_kind = 'exile_until_leaves' then
    -- Bronzebeak Foragers (mig 262): exile the target until the ACTING SOURCE
    -- leaves the battlefield (fire_zone_change_triggers returns it). Without
    -- a known source this falls back to a plain exile.
    select owner_id into v_target_owner_id
    from public.game_cards
    where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield';
    if found then
      select coalesce(max(zone_position), -1) + 1 into v_next_position
      from public.game_cards
      where session_id = p_session_id and owner_id = v_target_owner_id and zone = 'exile';
      update public.game_cards
      set zone = 'exile', zone_position = v_next_position, controller_player_id = owner_id,
          is_tapped = false, damage_marked = 0, dealt_deathtouch_damage = false, plus_one_counters = 0
      where id = p_target_card_id;
      if nullif(p_params ->> 'acting_source', '') is not null then
        insert into public.game_continuous_effects (
          session_id, source_card_id, affected_card_id, effect_type, payload, source_zone_required
        ) values (
          p_session_id, (p_params ->> 'acting_source')::uuid, p_target_card_id,
          'exiled_until_leaves', '{}'::jsonb, 'battlefield'
        );
      end if;
    end if;

  elsif p_kind = 'bounce' then
    select owner_id into v_target_owner_id
    from public.game_cards
    where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield';
    if found then
      select coalesce(max(zone_position), -1) + 1 into v_next_position
      from public.game_cards
      where session_id = p_session_id and owner_id = v_target_owner_id and zone = 'hand';
      update public.game_cards
      set zone = 'hand', zone_position = v_next_position, controller_player_id = owner_id,
          is_tapped = false, damage_marked = 0, dealt_deathtouch_damage = false, plus_one_counters = 0
      where id = p_target_card_id;
    end if;

  elsif p_kind = 'blink' then
    -- Flicker (Conjurer's Closet, mig 351): exile the target, then return it to
    -- the battlefield under the acting controller — re-entering re-fires its ETB.
    -- A token ceases on exile and cannot return.
    if exists (select 1 from public.game_cards
               where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield'
                 and not coalesce(is_token, false)) then
      update public.game_cards set zone = 'exile', controller_player_id = owner_id,
        is_tapped = false, damage_marked = 0, plus_one_counters = 0
      where id = p_target_card_id and session_id = p_session_id;
      update public.game_cards gc set zone = 'battlefield',
        zone_position = (select coalesce(max(x.zone_position), -1) + 1 from public.game_cards x
                         where x.session_id = p_session_id and x.owner_id = gc.owner_id and x.zone = 'battlefield'),
        controller_player_id = coalesce(nullif(p_params ->> 'acting_controller', '')::uuid, gc.owner_id),
        is_tapped = false,
        entered_battlefield_turn_number = (select turn_number from public.game_turn_state where session_id = p_session_id)
      where gc.id = p_target_card_id and gc.session_id = p_session_id;
      perform public.rebuild_scripted_continuous_effects(p_session_id);
    end if;

  elsif p_kind = 'saw_in_half' then
    -- Saw in Half (mig 356): "Destroy target creature. If it dies, its controller
    -- creates two tokens that are copies of it with half its power/toughness,
    -- rounded up." Grant a dies-trigger (copy_self ×2 with the half P/T baked from
    -- the creature's CURRENT effective P/T) then destroy it, so the copies appear
    -- only on an actual death.
    if exists (select 1 from public.game_cards where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield') then
      insert into public.game_continuous_effects (
        session_id, source_card_id, affected_card_id, effect_type, payload, source_zone_required
      ) values (
        p_session_id, p_target_card_id, p_target_card_id, 'granted_dies_effect',
        jsonb_build_object('effects', jsonb_build_array(jsonb_build_object(
          'type', 'copy_self', 'count', 2,
          'except', jsonb_build_object(
            'power', ceil(coalesce(public.card_effective_power(p_session_id, p_target_card_id), 0) / 2.0)::integer,
            'toughness', ceil(coalesce(public.card_effective_toughness(p_session_id, p_target_card_id), 0) / 2.0)::integer)))),
        'battlefield');
      perform public.put_in_graveyard(p_session_id, p_target_card_id);
    end if;

  elsif p_kind = 'shuffle_into_library' then
    -- Chaos Warp (mig 242): the OWNER shuffles the target into their library
    -- (modelled as inserting at a random position), then reveals the top card
    -- of that library; a permanent card goes onto the battlefield under the
    -- owner's control. Tokens shuffled in simply cease (the cease trigger).
    select owner_id into v_target_owner_id
    from public.game_cards
    where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield';
    if found then
      select floor(random() * (count(*) + 1))::integer into v_next_position
      from public.game_cards
      where session_id = p_session_id and owner_id = v_target_owner_id and zone = 'library';
      update public.game_cards
      set zone_position = zone_position + 1
      where session_id = p_session_id and owner_id = v_target_owner_id and zone = 'library'
        and zone_position >= v_next_position;
      update public.game_cards
      set zone = 'library', zone_position = v_next_position, controller_player_id = owner_id,
          is_tapped = false, damage_marked = 0, dealt_deathtouch_damage = false, plus_one_counters = 0
      where id = p_target_card_id;

      if coalesce((p_params ->> 'then_reveal_top_to_battlefield')::boolean, false) then
        select gc.id, c.type_line into v_top_card, v_top_type
        from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.session_id = p_session_id and gc.owner_id = v_target_owner_id and gc.zone = 'library'
        order by gc.zone_position asc, gc.id asc
        limit 1;
        if v_top_card is not null and (
             v_top_type ilike '%creature%' or v_top_type ilike '%artifact%'
             or v_top_type ilike '%enchantment%' or v_top_type ilike '%land%'
             or v_top_type ilike '%planeswalker%' or v_top_type ilike '%battle%') then
          select turn_number into v_turn
          from public.game_turn_state where session_id = p_session_id;
          update public.game_cards gc
          set zone = 'battlefield', controller_player_id = gc.owner_id, is_tapped = false,
              entered_battlefield_turn_number = coalesce(v_turn, 0),
              zone_position = (select coalesce(max(zone_position), -1) + 1
                               from public.game_cards x
                               where x.session_id = p_session_id and x.owner_id = gc.owner_id
                                 and x.zone = 'battlefield')
          where gc.id = v_top_card;
          perform public.register_card_continuous_effects(p_session_id, v_top_card);
        end if;
      end if;
    end if;

  elsif p_kind in ('tap', 'untap') then
    update public.game_cards
    set is_tapped = (p_kind = 'tap')
    where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield';
    -- stun rider (mig 403, Frost Titan: "It doesn't untap during its
    -- controller's next untap step") — a 'stun' bag counter; advance_step's
    -- untap skips stunned permanents and removes one counter instead.
    if p_kind = 'tap' and coalesce((p_params ->> 'stun')::boolean, false) then
      update public.game_cards
      set counters = public.adjust_counter_bag(counters, 'stun', 1)
      where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield';
    end if;

  elsif p_kind = 'add_counters' then
    v_counter_type := p_params ->> 'counter_type';
    v_all := coalesce((p_params ->> 'all')::boolean, false);
    if v_amount <> 0 or v_all then
      -- Doubling Season etc: the recipient's controller's replacement multiplies
      -- counters PUT ON it. Removal (negative) / `all` are not doubled.
      if v_amount > 0 then
        v_amount := v_amount * public.counter_factor(
          p_session_id,
          (select controller_player_id from public.game_cards
           where id = p_target_card_id and session_id = p_session_id));
      end if;
      if public.is_plus_one_counter(v_counter_type) then
        update public.game_cards
        set plus_one_counters = case when v_all then 0 else greatest(0, plus_one_counters + v_amount) end
        where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield';
      else
        update public.game_cards
        set counters = case when v_all then counters - lower(v_counter_type)
                            else public.adjust_counter_bag(counters, lower(v_counter_type), v_amount) end
        where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield';
      end if;
      -- Any counter change can annihilate (+1/+1 vs −1/−1) or drop toughness to lethal.
      perform public.recheck_counter_state(p_session_id);
    end if;

  elsif p_kind = 'pump' then
    if exists (select 1 from public.game_cards where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield') then
      -- power/toughness may be a fixed number OR a { count, … } object; negate per
      -- value (Liliana −2: -X/-X where X = Zombies you control). Count is relative to
      -- the acting controller.
      v_pump_power := public.resolve_dynamic_amount(
        p_session_id, p_target_card_id,
        nullif(p_params ->> 'acting_controller', '')::uuid,
        p_params -> 'power', p_target_card_id);
      if coalesce((p_params -> 'power' ->> 'negate')::boolean, false) then
        v_pump_power := -v_pump_power;
      end if;
      v_pump_tough := public.resolve_dynamic_amount(
        p_session_id, p_target_card_id,
        nullif(p_params ->> 'acting_controller', '')::uuid,
        p_params -> 'toughness', p_target_card_id);
      if coalesce((p_params -> 'toughness' ->> 'negate')::boolean, false) then
        v_pump_tough := -v_pump_tough;
      end if;
      perform public.create_pt_pump(p_session_id, p_target_card_id, v_pump_power, v_pump_tough);
      -- A debuff dropping toughness to ≤ 0 is lethal.
      if v_pump_tough < 0 then
        perform public.move_lethal_damaged_creatures_to_graveyard(p_session_id);
      end if;
    end if;

  elsif p_kind = 'set_pt' then
    if exists (select 1 from public.game_cards where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield') then
      insert into public.game_continuous_effects (
        session_id, source_card_id, affected_card_id, effect_type, payload,
        source_zone_required, expires_at_phase, expires_at_step
      )
      values (
        p_session_id, p_target_card_id, p_target_card_id, 'set_pt',
        jsonb_build_object(
          'power', coalesce((p_params ->> 'power')::integer, 0),
          'toughness', coalesce((p_params ->> 'toughness')::integer, 0),
          'until_end_of_turn', true
        ),
        'battlefield', 'ending', 'cleanup'
      );
    end if;

  elsif p_kind = 'grant_keyword' then
    v_keyword := lower(coalesce(p_params ->> 'keyword', ''));
    if v_keyword not in (
      'flying', 'reach', 'trample', 'vigilance', 'haste',
      'first_strike', 'double_strike', 'deathtouch', 'indestructible',
      -- mig 285 (found by the deck smoke test): the schema and CHECK list
      -- accepted these long before this resolver did — Rattlechains' hexproof
      -- grant had been erroring at runtime since mig 280.
      'hexproof', 'menace', 'lifelink',
      -- mig 397: "can't be blocked this turn" (Rogue's Passage, Hraesvelgr);
      -- declare_blocker enforces it via card_has_unblockable.
      'unblockable'
    ) then
      raise exception 'Unsupported keyword grant: %', v_keyword;
    end if;
    if exists (select 1 from public.game_cards where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield') then
      insert into public.game_continuous_effects (
        session_id, source_card_id, affected_card_id, effect_type, payload,
        source_zone_required, expires_at_phase, expires_at_step
      )
      values (
        p_session_id, p_target_card_id, p_target_card_id, v_keyword,
        jsonb_build_object('until_end_of_turn', true),
        'battlefield', 'ending', 'cleanup'
      );
    end if;

  elsif p_kind = 'grant_dies_effect' then
    -- Clavileño (mig 344): grant the target creature a "when this dies, <effects>"
    -- ability, stored as a granted_dies_effect continuous effect ON the creature
    -- (source = the creature, so it is swept when the creature leaves and SURVIVES
    -- the granter leaving). put_in_graveyard fires payload.effects on its death.
    if exists (select 1 from public.game_cards where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield') then
      insert into public.game_continuous_effects (
        session_id, source_card_id, affected_card_id, effect_type, payload, source_zone_required
      ) values (
        p_session_id, p_target_card_id, p_target_card_id, 'granted_dies_effect',
        jsonb_build_object('effects', coalesce(p_params -> 'effects', '[]'::jsonb)),
        'battlefield'
      );
    end if;

  elsif p_kind = 'ignition' then
    -- Chandra's Ignition (mig 257): target creature deals damage equal to its
    -- power to each other creature and each opponent of the caster.
    v_amount := greatest(0, coalesce(public.card_effective_power(p_session_id, p_target_card_id), 0));
    if v_amount > 0 and exists (
      select 1 from public.game_cards
      where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield'
    ) then
      for v_top_card in
        select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.session_id = p_session_id and gc.zone = 'battlefield'
          and c.type_line ilike '%creature%' and gc.id <> p_target_card_id
      loop
        perform public.apply_damage_to_creature(
          p_session_id, v_top_card, v_amount, p_target_card_id, false, false, false);
      end loop;
      v_acting_controller := nullif(p_params ->> 'acting_controller', '')::uuid;
      update public.game_session_players
      set life_total = greatest(0, life_total - v_amount)
      where session_id = p_session_id and player_id is distinct from v_acting_controller;
      perform public.move_lethal_damaged_creatures_to_graveyard(p_session_id);
      perform public.maybe_finish_game_session(p_session_id);
    end if;

  elsif p_kind = 'exile_and_manifest' then
    -- Reality Shift (mig 251): exile target creature; its CONTROLLER
    -- manifests the top card of their library — it enters as a face-down
    -- 2/2 with no abilities (copied_script {} + an unexpiring set_pt 2/2;
    -- register skips manifested cards so printed keywords stay off).
    -- turn_manifest_up flips a creature card face up for its mana cost.
    -- The card's identity is not visually hidden from the table (client
    -- approximation).
    select coalesce(controller_player_id, owner_id), owner_id
    into v_prev_controller, v_target_owner_id
    from public.game_cards
    where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield';
    if found then
      update public.game_cards gc
      set zone = 'exile', controller_player_id = gc.owner_id, is_tapped = false,
          damage_marked = 0, dealt_deathtouch_damage = false, plus_one_counters = 0,
          zone_position = (select coalesce(max(zone_position), -1) + 1
                           from public.game_cards x
                           where x.session_id = p_session_id and x.owner_id = gc.owner_id and x.zone = 'exile')
      where gc.id = p_target_card_id;

      select gc.id into v_top_card
      from public.game_cards gc
      where gc.session_id = p_session_id and gc.owner_id = v_prev_controller and gc.zone = 'library'
      order by gc.zone_position asc, gc.id asc
      limit 1;
      if v_top_card is not null then
        select turn_number into v_turn
        from public.game_turn_state where session_id = p_session_id;
        update public.game_cards gc
        set zone = 'battlefield', controller_player_id = v_prev_controller, is_tapped = false,
            entered_battlefield_turn_number = coalesce(v_turn, 0),
            counters = coalesce(gc.counters, '{}'::jsonb) || jsonb_build_object('manifested', 1),
            copied_script = '{}'::jsonb,
            zone_position = (select coalesce(max(zone_position), -1) + 1
                             from public.game_cards x
                             where x.session_id = p_session_id and x.owner_id = gc.owner_id
                               and x.zone = 'battlefield')
        where gc.id = v_top_card;
        insert into public.game_continuous_effects (
          session_id, source_card_id, affected_card_id, effect_type, payload, source_zone_required)
        values (p_session_id, v_top_card, v_top_card, 'set_pt',
          jsonb_build_object('power', 2, 'toughness', 2), 'battlefield');
      end if;
    end if;

  elsif p_kind = 'goad' then
    -- Goad (mig 249, Vengeful Ancestor): "until your next turn, that creature
    -- attacks each combat if able and attacks a player other than you if
    -- able." A 'goaded' row carrying the goader, expiring before the goader's
    -- next turn (current turn + players - 1). Enforced: declare_attacker
    -- rejects attacking the goader while another opponent exists; the
    -- must-attack-each-combat half is NOT forced (approximation).
    if exists (select 1 from public.game_cards where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield') then
      select turn_number into v_turn
      from public.game_turn_state where session_id = p_session_id;
      select count(*) into v_goad_players
      from public.game_session_players where session_id = p_session_id;
      insert into public.game_continuous_effects (
        session_id, source_card_id, affected_card_id, effect_type, payload, expires_at_turn_number)
      values (
        p_session_id,
        coalesce(nullif(p_params ->> 'acting_source', '')::uuid, p_target_card_id),
        p_target_card_id, 'goaded',
        jsonb_build_object('goaded_by', p_params ->> 'acting_controller'),
        coalesce(v_turn, 0) + greatest(1, coalesce(v_goad_players, 2) - 1));
    end if;

  elsif p_kind = 'gain_control' then
    v_acting_controller := nullif(p_params ->> 'acting_controller', '')::uuid;
    if v_acting_controller is null then
      raise exception 'gain_control requires an acting controller';
    end if;
    v_duration := lower(coalesce(p_params ->> 'duration', 'permanent'));
    if v_duration not in ('permanent', 'end_of_turn', 'while_source') then
      raise exception 'Unsupported gain_control duration: %', v_duration;
    end if;
    -- Donate (Harmless Offering, mig 353): "target OPPONENT gains control" — hand
    -- the permanent to an opponent of the caster (1v1: the only one) instead of
    -- the caster gaining it.
    if lower(coalesce(p_params ->> 'to', '')) = 'opponent' then
      select sp.player_id into v_acting_controller
      from public.game_session_players sp
      where sp.session_id = p_session_id and sp.player_id is distinct from v_acting_controller
      order by sp.seat_number limit 1;
      if v_acting_controller is null then
        raise exception 'No opponent to donate to';
      end if;
    end if;
    select controller_player_id into v_prev_controller
    from public.game_cards
    where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield';
    if found then
      update public.game_cards
      set controller_player_id = v_acting_controller,
          is_tapped = case when coalesce((p_params ->> 'untap')::boolean, false) then false else is_tapped end
      where id = p_target_card_id;
      if coalesce((p_params ->> 'haste')::boolean, false) then
        insert into public.game_continuous_effects (
          session_id, source_card_id, affected_card_id, effect_type, payload,
          source_zone_required, expires_at_phase, expires_at_step
        )
        values (
          p_session_id, p_target_card_id, p_target_card_id, 'haste',
          jsonb_build_object('until_end_of_turn', true),
          'battlefield', 'ending', 'cleanup'
        );
      end if;
      if v_duration = 'end_of_turn' then
        insert into public.game_continuous_effects (
          session_id, source_card_id, affected_card_id, effect_type, payload,
          source_zone_required, expires_at_phase, expires_at_step
        )
        values (
          p_session_id, p_target_card_id, p_target_card_id, 'control',
          jsonb_build_object('original_controller', v_prev_controller),
          'battlefield', 'ending', 'cleanup'
        );
      elsif v_duration = 'while_source' then
        -- "For as long as ~ remains on the battlefield, gain control of that
        -- permanent" (mig 246, Opportunistic Dragon): an UNexpiring control
        -- row sourced by the STEALING permanent; fire_zone_change_triggers
        -- reverts when it leaves. lose_abilities blanks the stolen
        -- permanent's script (a copied_script stub that also blocks
        -- attacking via the cant_attack_unless gate; blocking is NOT
        -- restricted — approximation).
        insert into public.game_continuous_effects (
          session_id, source_card_id, affected_card_id, effect_type, payload)
        values (
          p_session_id,
          coalesce(nullif(p_params ->> 'acting_source', '')::uuid, p_target_card_id),
          p_target_card_id, 'control',
          jsonb_build_object(
            'original_controller', v_prev_controller,
            'while_source', true,
            'lose_abilities', coalesce((p_params ->> 'lose_abilities')::boolean, false)));
        if coalesce((p_params ->> 'lose_abilities')::boolean, false) then
          update public.game_cards
          set copied_script = '{"schema_version":2,"cant_attack_unless":{"count":"artifacts_you_control","at_least":99}}'::jsonb
          where id = p_target_card_id and session_id = p_session_id;
        end if;
      end if;
    end if;

  else
    raise exception 'Unsupported creature effect kind: %', p_kind;
  end if;
end;
$$;
grant execute on function public.apply_creature_effect(uuid, text, uuid, jsonb) to authenticated;
