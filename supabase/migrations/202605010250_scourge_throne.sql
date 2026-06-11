-- 202605010250_scourge_throne — Scourge of the Throne (dethrone + an
-- additional combat phase).
--   • fire_attack_triggers stamps the defender on attack triggers
--     (event_player_id).
--   • if_attacking_most_life: inner untargeted effects run only when that
--     defender has the most life or is tied for it; once_per_turn gates via
--     a turn stamp (approximation: stamped on the first QUALIFYING attack).
--   • untap_all_attackers + extra_combat actions; game_turn_state.
--     extra_combats queues phases and advance_step loops end_of_combat back
--     to beginning_of_combat, consuming one per loop.
-- Generated from supabase/functions_src (advance_step, fire_attack_triggers, apply_trigger_effects, apply_triggered_ability_effects) — those files are
-- the canonical current definitions; edit them, not past migrations.

-- Pending extra combat phases for the current turn.
alter table public.game_turn_state
  add column if not exists extra_combats integer not null default 0;

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

  return v_current_state;
end;
$$;
grant execute on function public.advance_step(uuid) to authenticated;

-- supabase/functions_src/fire_attack_triggers.sql
-- CANONICAL current definition (seeded from 00_baseline.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

CREATE OR REPLACE FUNCTION "public"."fire_attack_triggers"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_attacker_controller uuid;
begin
  -- The defender rides as event context (mig 250: dethrone's "attacks the
  -- player with the most life").
  perform public.fire_card_triggers(
    NEW.session_id,
    NEW.attacker_card_id,
    array['attacks', 'declares_attack', 'attack'],
    jsonb_build_object('event_player_id', NEW.defending_player_id)
  );

  -- Watcher broadcast (mig 227): "whenever a creature you control attacks"
  -- (Atarka, World Render). The attacking creature is the event subject, so a
  -- reflexive "it gains double strike" lands on it.
  select coalesce(controller_player_id, owner_id) into v_attacker_controller
  from public.game_cards
  where id = NEW.attacker_card_id and session_id = NEW.session_id;

  perform public.fire_watcher_triggers(
    NEW.session_id, NEW.attacker_card_id, v_attacker_controller, 'creature_attacks'
  );

  return null;
end;
$$;

create or replace function public.apply_trigger_effects(
  p_session_id uuid,
  p_stack_item_id uuid,
  p_start_index integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.game_stack_items;
  v_effects jsonb;
  v_target uuid;
  v_targets jsonb;
  v_tid uuid;
  v_controller uuid;
  v_count integer;
  v_i integer;
  v_effect jsonb;
  v_type text;
  v_amount integer;
  v_options jsonb;
  v_decision_id uuid;
  v_filter text;
  v_looked uuid[];
  v_name text;
  v_len integer;
  v_decider uuid;
  v_who text;
  v_queue jsonb;
  v_target_controller_player uuid;
  v_died_set uuid[];
begin
  select * into v_item from public.game_stack_items where id = p_stack_item_id;
  if not found then
    return null;
  end if;

  v_effects := coalesce(v_item.payload -> 'effects', '[]'::jsonb);
  v_target := nullif(v_item.payload ->> 'target_card_id', '')::uuid;
  v_targets := v_item.payload -> 'target_card_ids';
  v_controller := nullif(v_item.payload ->> 'controller_player_id', '')::uuid;
  -- Beast Within: capture the targets controller while it is still on the
  -- battlefield, before any effect (the destroy) moves it to the graveyard.
  v_target_controller_player := (select controller_player_id from public.game_cards
    where id = v_target and session_id = p_session_id and zone = 'battlefield');
  v_count := jsonb_array_length(v_effects);
  v_i := greatest(0, coalesce(p_start_index, 0));

  while v_i < v_count loop
    v_effect := v_effects -> v_i;
    v_type := lower(coalesce(v_effect ->> 'type', ''));
    -- "Its controller creates a token": route the create_token to the captured
    -- target controller instead of the caster.
    if v_type = 'create_token'
       and lower(coalesce(v_effect ->> 'recipient', '')) = 'target_controller'
       and v_target_controller_player is not null then
      v_effect := v_effect || jsonb_build_object('recipient_player_id', v_target_controller_player::text);
    end if;

    -- Dynamic token count from an edict tally (Syphon Flesh): count =
    -- {count:'sacrificed_this_way'} reads `sacrificed_count` accumulated on this
    -- stack item by submit_decision across the each-opponent sacrifice chain.
    if v_type = 'create_token'
       and jsonb_typeof(v_effect -> 'count') = 'object'
       and (v_effect -> 'count' ->> 'count') = 'sacrificed_this_way' then
      v_effect := v_effect || jsonb_build_object(
        'count', coalesce((v_item.payload ->> 'sacrificed_count')::integer, 0));
    end if;
    -- Zero sacrificed → create no tokens (the resolver floors count at 1).
    if v_type = 'create_token' and coalesce(v_effect ->> 'count', '') = '0' then
      v_i := v_i + 1; continue;
    end if;

    -- recipient:'triggering_controller' (mig 249, Vengeful Ancestor: "a
    -- goaded creature attacks → it deals 1 damage to ITS controller"): route
    -- the life loss to the event subject's controller.
    if v_type in ('lose_life', 'deal_damage')
       and lower(coalesce(v_effect ->> 'recipient', '')) = 'triggering_controller'
       and nullif(v_item.payload ->> 'triggering_card_id', '') is not null then
      v_effect := v_effect || jsonb_build_object('recipient_player_id',
        (select coalesce(gc.controller_player_id, gc.owner_id)::text
         from public.game_cards gc
         where gc.id = (v_item.payload ->> 'triggering_card_id')::uuid
           and gc.session_id = p_session_id));
    end if;

    if v_type = 'choose_one' then
      -- A modal trigger ("When X dies, choose one — …"). Park a choose_mode
      -- decision carrying the modes; submit_decision (trigger_modal branch)
      -- applies the chosen mode's untargeted actions, then resumes. Each mode is
      -- {label, actions:[…]} — same shape modal spells use.
      v_options := coalesce(v_effect -> 'modes', '[]'::jsonb);
      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'choose_mode',
        coalesce(v_effect ->> 'prompt', 'Choose one'),
        v_options,
        coalesce((v_effect ->> 'choose')::integer, 1),
        -- "If you control a commander as you cast this spell, you may choose
        -- both" (Will of the Temur, mig 239): the commander check raises the
        -- ceiling to every mode; the minimum stays at `choose`.
        case when coalesce((v_effect ->> 'may_choose_both_if_commander')::boolean, false)
              and public.resolve_count_amount(p_session_id, v_controller,
                    '{"count":"commanders_you_control"}'::jsonb) >= 1
             then jsonb_array_length(v_options)
             else coalesce((v_effect ->> 'choose')::integer, 1) end,
        jsonb_build_object('trigger_modal', true))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'divide_damage' then
      -- "Deal N damage divided as you choose among target …" from a TRIGGER
      -- (Dragonlord Atarka ETB). Park a divide_damage decision listing the legal
      -- targets; submit_decision validates the allocations (sum = N) and applies.
      v_options := public.divide_damage_options(p_session_id, v_controller, v_effect -> 'target_filter');
      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'divide_damage',
        'Divide ' || coalesce((v_effect ->> 'amount')::integer, 1) || ' damage',
        v_options, 1, jsonb_array_length(v_options),
        jsonb_build_object(
          'amount', coalesce((v_effect ->> 'amount')::integer, 1),
          'max_targets', nullif(v_effect ->> 'max_targets', '')::integer))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type in ('scry', 'surveil') then
      v_amount := coalesce((v_effect ->> 'amount')::integer, 1);
      select coalesce(
               jsonb_agg(jsonb_build_object('game_card_id', top.id, 'name', c.name, 'library_position', top.zone_position)
                 order by top.zone_position asc, top.id asc),
               '[]'::jsonb)
        into v_options
      from (
        select id, card_id, zone_position from public.game_cards
        where session_id = p_session_id and owner_id = v_controller and zone = 'library'
        order by zone_position asc, id asc limit v_amount
      ) top
      join public.cards c on c.id = top.card_id;

      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices)
      values (p_session_id, v_controller, p_stack_item_id, v_type, initcap(v_type) || ' ' || v_amount, v_options, 0, jsonb_array_length(v_options))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'search_library' then
      v_filter := v_effect -> 'filter' ->> 'type_line';
      v_name := v_effect -> 'filter' ->> 'name';
      -- type_line_any (mig 241, Farseek): OR over several type words
      -- ("a Plains, Island, Swamp, or Mountain card").
      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', lib.id, 'name', c.name) order by c.name, lib.id), '[]'::jsonb)
        into v_options
      from public.game_cards lib join public.cards c on c.id = lib.card_id
      where lib.session_id = p_session_id and lib.owner_id = v_controller and lib.zone = 'library'
        and (v_filter is null or c.type_line ilike '%' || v_filter || '%')
        and (jsonb_typeof(v_effect -> 'filter' -> 'type_line_any') is distinct from 'array'
             or exists (
               select 1 from jsonb_array_elements_text(v_effect -> 'filter' -> 'type_line_any') ta(t)
               where c.type_line ilike '%' || ta.t || '%'))
        and (v_name is null or c.name ilike '%' || v_name || '%');

      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'search_library',
        'Search your library'
          || case when v_filter is not null then ' for a ' || v_filter else '' end
          || case when v_name is not null then ' named ' || v_name else '' end,
        v_options, 0, coalesce((v_effect ->> 'count')::integer, 1),
        jsonb_build_object(
          'to', coalesce(v_effect ->> 'to', v_effect ->> 'destination', 'hand'),
          'tapped', coalesce((v_effect ->> 'tapped')::boolean, false),
          'reveal', coalesce((v_effect ->> 'reveal')::boolean, false)))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'discard' then
      v_who := lower(coalesce(v_effect ->> 'who', 'you'));
      if v_who = 'opponent' then
        select sp.player_id into v_decider
        from public.game_session_players sp
        where sp.session_id = p_session_id and sp.player_id is distinct from v_controller
        order by sp.seat_number limit 1;
      else
        v_decider := v_controller;
      end if;
      if v_decider is null then v_i := v_i + 1; continue; end if;

      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', h.id, 'name', c.name) order by h.zone_position, h.id), '[]'::jsonb)
        into v_options
      from public.game_cards h join public.cards c on c.id = h.card_id
      where h.session_id = p_session_id and h.owner_id = v_decider and h.zone = 'hand';

      v_len := jsonb_array_length(v_options);
      if v_len = 0 then v_i := v_i + 1; continue; end if;
      v_amount := least(coalesce((v_effect ->> 'count')::integer, 1), v_len);

      if coalesce((v_effect ->> 'random')::boolean, false) then
        with picked as (
          select id from public.game_cards
          where session_id = p_session_id and owner_id = v_decider and zone = 'hand'
          order by random() limit v_amount
        ),
        numbered as (select id, (row_number() over ()) - 1 as rn from picked),
        base as (
          select coalesce(max(zone_position), -1) as m from public.game_cards
          where session_id = p_session_id and owner_id = v_decider and zone = 'graveyard'
        )
        update public.game_cards g
        set zone = 'graveyard', zone_position = base.m + 1 + numbered.rn, is_tapped = false, damage_marked = 0
        from numbered, base
        where g.id = numbered.id;

        v_i := v_i + 1;
        continue;
      end if;

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_decider, p_stack_item_id, 'choose_cards', 'Discard ' || v_amount, v_options, v_amount, v_amount, jsonb_build_object('to', 'graveyard'))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'may' then
      -- Optional condition gate (Liliana's Devotee: "if a creature died this turn,
      -- you may …"): if the count condition fails, the may isn't offered at all.
      if v_effect ? 'condition'
         and public.resolve_dynamic_amount(p_session_id, v_item.source_card_id, v_controller, v_effect -> 'condition')
             < coalesce((v_effect -> 'condition' ->> 'at_least')::integer, 1) then
        v_i := v_i + 1; continue;
      end if;
      -- Carry an optional mana cost ("you may pay {1}{B}") into the decision params;
      -- paid at confirm time before the inner effects run.
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'confirm', coalesce(v_effect ->> 'prompt', 'You may'), '[]'::jsonb, 0, 0,
        jsonb_build_object('effects', coalesce(v_effect -> 'effects', '[]'::jsonb), 'cost', v_effect ->> 'cost'))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'choose_player' then
      v_filter := lower(coalesce(v_effect ->> 'filter', 'any'));
      select coalesce(
               jsonb_agg(jsonb_build_object('player_id', sp.player_id, 'username', p.username) order by sp.seat_number),
               '[]'::jsonb)
        into v_options
      from public.game_session_players sp
      left join public.profiles p on p.id = sp.player_id
      where sp.session_id = p_session_id
        and (v_filter <> 'opponent' or sp.player_id is distinct from v_controller);

      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'choose_player', 'Choose a player', v_options, 1, 1,
        jsonb_build_object('effects', coalesce(v_effect -> 'effects', '[]'::jsonb)))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'choose_creature_type' then
      -- A curated creature-type list, or the effect's own `options` words
      -- (mig 245, Frontier Siege: "choose Khans or Dragons"). Either way the
      -- chosen word is baked into the source's copied_script wherever the
      -- script holds the '"$chosen"' placeholder (submit_decision).
      if jsonb_typeof(v_effect -> 'options') = 'array' and jsonb_array_length(v_effect -> 'options') > 0 then
        select jsonb_agg(jsonb_build_object('type', value))
          into v_options
        from jsonb_array_elements_text(v_effect -> 'options');
      else
        v_options := '[{"type":"Zombie"},{"type":"Human"},{"type":"Elf"},{"type":"Goblin"},{"type":"Soldier"},{"type":"Wizard"},{"type":"Vampire"},{"type":"Spirit"},{"type":"Beast"},{"type":"Dragon"},{"type":"Merfolk"},{"type":"Knight"},{"type":"Cleric"},{"type":"Warrior"},{"type":"Angel"},{"type":"Demon"},{"type":"Elemental"},{"type":"Snake"},{"type":"Insect"}]'::jsonb;
      end if;
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'choose_creature_type',
        coalesce(v_effect ->> 'prompt', 'Choose a creature type'), v_options, 1, 1,
        jsonb_build_object('effects', coalesce(v_effect -> 'effects', '[]'::jsonb)))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'sacrifice' then
      v_who := lower(coalesce(v_effect ->> 'who', 'you'));
      v_filter := v_effect -> 'filter' ->> 'type_line';

      if v_who = 'each_player' then
        -- Every player including the caster, in seat order (Necrotic Hex).
        select coalesce(jsonb_agg(to_jsonb(sp.player_id::text) order by sp.seat_number), '[]'::jsonb)
          into v_queue
        from public.game_session_players sp
        where sp.session_id = p_session_id;
      elsif v_who = 'each_opponent' then
        select coalesce(jsonb_agg(to_jsonb(sp.player_id::text) order by sp.seat_number), '[]'::jsonb)
          into v_queue
        from public.game_session_players sp
        where sp.session_id = p_session_id and sp.player_id is distinct from v_controller;
      elsif v_who = 'opponent' then
        select coalesce(jsonb_agg(to_jsonb(one.player_id::text) order by one.seat_number), '[]'::jsonb)
          into v_queue
        from (
          select player_id, seat_number from public.game_session_players
          where session_id = p_session_id and player_id is distinct from v_controller
          order by seat_number limit 1
        ) one;
      else
        v_queue := jsonb_build_array(v_controller::text);
      end if;

      v_decision_id := public.park_edict_sacrifice(
        p_session_id, p_stack_item_id, coalesce((v_effect ->> 'count')::integer, 1), v_filter, v_queue
      );
      if v_decision_id is null then v_i := v_i + 1; continue; end if;

      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'look_top' then
      -- "Look at the top N cards of your library. You may put a matching card
      -- onto the battlefield. Put the rest on the bottom in a random order."
      -- (Ureni of the Unwritten, mig 223.) The looked-at set is the top N; the
      -- pickable options are the cards in it that match the filter.
      v_filter := v_effect -> 'filter' ->> 'type_line';
      select coalesce(array_agg(t.id order by t.zone_position asc, t.id asc), array[]::uuid[])
        into v_looked
      from (
        select id, zone_position from public.game_cards
        where session_id = p_session_id and owner_id = v_controller and zone = 'library'
        order by zone_position asc, id asc
        limit coalesce((v_effect ->> 'count')::integer, 1)
      ) t;

      if cardinality(v_looked) = 0 then v_i := v_i + 1; continue; end if;

      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gc.id, 'name', c.name) order by c.name, gc.id), '[]'::jsonb)
        into v_options
      from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.id = any(v_looked)
        and (v_filter is null or c.type_line ilike '%' || v_filter || '%')
        and (not coalesce((v_effect -> 'filter' ->> 'creature')::boolean, false)
             or c.type_line ilike '%creature%');

      -- No matching card to put down: the whole looked-at set still goes to the
      -- bottom in a random order. No decision is parked.
      if jsonb_array_length(v_options) = 0 then
        perform public.bottom_cards_random(p_session_id, v_controller, v_looked);
        v_i := v_i + 1; continue;
      end if;

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'look_top',
        case when coalesce(v_effect ->> 'to', 'battlefield') = 'exile'
             then 'Exile a card face down; the rest go to the bottom'
             else 'You may put a card onto the battlefield; the rest go to the bottom' end,
        v_options,
        -- min_picks (mig 248, hideaway): "exile ONE face down" is mandatory.
        least(coalesce((v_effect ->> 'min_picks')::integer, 0), jsonb_array_length(v_options)), 1,
        jsonb_build_object('to', coalesce(v_effect ->> 'to', 'battlefield'),
                           'looked_at', to_jsonb(v_looked)))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'return_from_graveyard' then
      v_filter := v_effect -> 'filter' ->> 'type_line';
      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gy.id, 'name', c.name) order by c.name, gy.id), '[]'::jsonb)
        into v_options
      from public.game_cards gy join public.cards c on c.id = gy.card_id
      where gy.session_id = p_session_id and gy.owner_id = v_controller and gy.zone = 'graveyard'
        and (case when v_filter is not null then c.type_line ilike '%' || v_filter || '%'
                  else c.type_line ilike '%creature%' end);

      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'return_from_graveyard',
        'Return up to ' || coalesce((v_effect ->> 'count'), '1') || ' from your graveyard',
        v_options, 0, coalesce((v_effect ->> 'count')::integer, 1),
        -- tapped (mig 218, Victimize): battlefield returns enter tapped.
        jsonb_build_object('to', coalesce(v_effect ->> 'to', 'hand'),
                           'tapped', coalesce((v_effect ->> 'tapped')::boolean, false)))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'choose_color' then
      -- Heraldic Banner (mig 209): "As this enters the battlefield, choose a
      -- color." Parks a five-colour pick; submit_decision registers the
      -- colour-filtered anthem described by `anthem` ({power,toughness,scope})
      -- with the chosen colour baked into its payload (source = this card,
      -- battlefield-gated, NOT script-flagged so rebuilds keep it).
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'choose_color',
        'Choose a color',
        '[{"value":"white"},{"value":"blue"},{"value":"black"},{"value":"red"},{"value":"green"}]'::jsonb,
        1, 1,
        jsonb_build_object('anthem', v_effect -> 'anthem'))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'mass_destroy_reanimate_one' then
      -- Necromantic Selection (mig 208): "Destroy all creatures, then return a
      -- creature card put into a graveyard this way to the battlefield under
      -- your control." Snapshot the about-to-die set (indestructible survives,
      -- mirroring destroy_all_creatures), destroy, then park a single pick over
      -- the cards that actually landed in a graveyard (tokens cease and drop
      -- out). submit_decision's reanimate_destroyed branch finishes the return.
      select coalesce(array_agg(gc.id), array[]::uuid[]) into v_died_set
      from public.game_cards gc
      join public.cards c on c.id = gc.card_id
      where gc.session_id = p_session_id and gc.zone = 'battlefield'
        and c.type_line ilike '%creature%'
        and not public.card_has_indestructible(p_session_id, gc.id);

      perform public.destroy_all_creatures(p_session_id, v_controller, null, 'all');

      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gc.id, 'name', c.name) order by c.name, gc.id), '[]'::jsonb)
        into v_options
      from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.session_id = p_session_id and gc.zone = 'graveyard' and gc.id = any(v_died_set);

      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices)
      values (p_session_id, v_controller, p_stack_item_id, 'reanimate_destroyed',
        'Return a destroyed creature to the battlefield under your control', v_options, 0, 1)
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'proliferate' then
      -- Options: any battlefield permanent (any owner) with a +1/+1 OR a bag
      -- counter, PLUS any player with a bag counter. The id field is uniform
      -- ('game_card_id' carries a card id or a player id — disjoint uuids), so
      -- the multi-select picker needs no change; submit_decision disambiguates.
      select coalesce(jsonb_agg(opt order by sort_name, ent_id), '[]'::jsonb)
        into v_options
      from (
        select gc.id as ent_id, c.name as sort_name,
               jsonb_build_object('game_card_id', gc.id, 'name', c.name, 'kind', 'permanent') as opt
        from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.session_id = p_session_id and gc.zone = 'battlefield'
          and (gc.plus_one_counters > 0 or gc.counters <> '{}'::jsonb)
        union all
        select sp.player_id, coalesce(p.username, 'Player'),
               jsonb_build_object('game_card_id', sp.player_id,
                                  'name', coalesce(p.username, 'Player') || ' (player)',
                                  'kind', 'player')
        from public.game_session_players sp
        left join public.profiles p on p.id = sp.player_id
        where sp.session_id = p_session_id and sp.counters <> '{}'::jsonb
      ) q;

      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices)
      values (p_session_id, v_controller, p_stack_item_id, 'proliferate', 'Proliferate — choose any number', v_options, 0, jsonb_array_length(v_options))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'copy_permanent' then
      -- Token copy (mig 239). Two shapes:
      --   • target:'triggering_creature' — copy the event subject directly, no
      --     pick (Reflections of Littjara: the cast spell's card becomes a
      --     battlefield token copy).
      --   • otherwise park a copy_permanent decision over battlefield
      --     permanents matching target_filter (Will of the Temur: "create a
      --     token that's a copy of target permanent").
      -- `except` ({power,toughness,keywords}) rides in params and becomes a
      -- set_pt override + keyword grants on the copy; added TYPES are not
      -- modelled.
      if (v_effect ->> 'target') = 'triggering_creature' then
        if nullif(v_item.payload ->> 'triggering_card_id', '')::uuid is not null then
          perform public.create_copy_token(
            p_session_id, v_controller,
            nullif(v_item.payload ->> 'triggering_card_id', '')::uuid,
            v_effect -> 'except');
        end if;
      else
        select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gc.id, 'name', c.name) order by c.name, gc.id), '[]'::jsonb)
          into v_options
        from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.session_id = p_session_id and gc.zone = 'battlefield'
          and (coalesce(v_effect -> 'target_filter' ->> 'type_line', '') = ''
               or c.type_line ilike '%' || (v_effect -> 'target_filter' ->> 'type_line') || '%')
          and (case lower(coalesce(v_effect -> 'target_filter' ->> 'controller', 'any'))
                 when 'you' then coalesce(gc.controller_player_id, gc.owner_id) = v_controller
                 when 'opponent' then coalesce(gc.controller_player_id, gc.owner_id) is distinct from v_controller
                 else true end);
        if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;
        insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
        values (p_session_id, v_controller, p_stack_item_id, 'copy_permanent',
          'Choose a permanent to copy', v_options, 1, 1,
          jsonb_build_object('except', v_effect -> 'except'))
        returning id into v_decision_id;
        update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
        return v_decision_id;
      end if;

    elsif v_type = 'become_copy' then
      -- An existing card becomes a copy (mig 240). Options are either the
      -- triggering creature (Sarkhan, Soul Aflame: "whenever a Dragon you
      -- control enters, you may have Sarkhan become a copy of it until end of
      -- turn") or battlefield creatures matching target_filter (Deceptive
      -- Frostkite: "you may have this enter as a copy of a creature you
      -- control with power 4 or greater"). The pick IS the "may": optional
      -- parks with min 0 and an empty submit declines. `except`/
      -- until_end_of_turn/fire_etb ride in params for submit_decision.
      if (v_effect ->> 'target') = 'triggering_creature' then
        select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gc.id, 'name', c.name)), '[]'::jsonb)
          into v_options
        from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.id = nullif(v_item.payload ->> 'triggering_card_id', '')::uuid
          and gc.session_id = p_session_id and gc.zone = 'battlefield'
          and gc.id is distinct from v_item.source_card_id;
      else
        select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gc.id, 'name', c.name) order by c.name, gc.id), '[]'::jsonb)
          into v_options
        from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.session_id = p_session_id and gc.zone = 'battlefield'
          and gc.id is distinct from v_item.source_card_id
          and c.type_line ilike '%creature%'
          and (coalesce(v_effect -> 'target_filter' ->> 'type_line', '') = ''
               or c.type_line ilike '%' || (v_effect -> 'target_filter' ->> 'type_line') || '%')
          and (case lower(coalesce(v_effect -> 'target_filter' ->> 'controller', 'you'))
                 when 'you' then coalesce(gc.controller_player_id, gc.owner_id) = v_controller
                 when 'opponent' then coalesce(gc.controller_player_id, gc.owner_id) is distinct from v_controller
                 else true end)
          and ((v_effect -> 'target_filter' ->> 'min_power') is null
               or coalesce(public.card_effective_power(p_session_id, gc.id), -1)
                  >= (v_effect -> 'target_filter' ->> 'min_power')::integer);
      end if;
      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'become_copy',
        'Become a copy of a creature?', v_options,
        case when coalesce((v_effect ->> 'optional')::boolean, false) then 0 else 1 end, 1,
        jsonb_build_object(
          'except', v_effect -> 'except',
          'until_end_of_turn', coalesce((v_effect ->> 'until_end_of_turn')::boolean, false),
          'fire_etb', coalesce((v_effect ->> 'fire_etb')::boolean, false)))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'exile_until_nonland' then
      -- Breaching Dragonstorm (mig 245): exile from the top of your library
      -- until a nonland is exiled (the lands STAY exiled, per the card). The
      -- nonland parks a pick when its mana value is within the free window:
      -- choosing it puts a PERMANENT card onto the battlefield ("cast it
      -- without paying its mana cost", approximated as a direct entry —
      -- instants/sorceries go to hand instead), declining puts it into your
      -- hand. Above the window it goes straight to hand.
      v_tid := null;
      loop
        select gc.id, c.type_line, c.mana_cost into v_tid, v_filter, v_name
        from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.session_id = p_session_id and gc.owner_id = v_controller and gc.zone = 'library'
        order by gc.zone_position asc, gc.id asc limit 1;
        exit when v_tid is null;
        update public.game_cards gc
        set zone = 'exile', controller_player_id = gc.owner_id, is_tapped = false,
            zone_position = (select coalesce(max(zone_position), -1) + 1
                             from public.game_cards x
                             where x.session_id = p_session_id and x.owner_id = gc.owner_id and x.zone = 'exile')
        where gc.id = v_tid;
        exit when v_filter not ilike '%land%';
        v_tid := null;
      end loop;
      if v_tid is null then v_i := v_i + 1; continue; end if;
      if public.mana_value(v_name) > coalesce((v_effect ->> 'free_cast_max_mana_value')::integer, 8) then
        -- Too big for the free window: straight to hand.
        update public.game_cards gc
        set zone = 'hand',
            zone_position = (select coalesce(max(zone_position), -1) + 1
                             from public.game_cards x
                             where x.session_id = p_session_id and x.owner_id = gc.owner_id and x.zone = 'hand')
        where gc.id = v_tid;
        v_i := v_i + 1; continue;
      end if;
      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gc.id, 'name', c.name)), '[]'::jsonb)
        into v_options
      from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.id = v_tid;
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'cast_exiled_free',
        'Cast it without paying its mana cost? (Declining puts it into your hand)',
        v_options, 0, 1, '{}'::jsonb)
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'if_attacking_most_life' then
      -- Dethrone / Scourge of the Throne (mig 250): run the inner untargeted
      -- effects only when the attack's defender (event_player_id, stamped by
      -- fire_attack_triggers) has the most life or is tied for it.
      -- once_per_turn gates via a turn stamp on the source's counter bag
      -- (approximation: stamped on the first QUALIFYING attack).
      if nullif(v_item.payload ->> 'event_player_id', '') is not null
         and (select sp.life_total from public.game_session_players sp
              where sp.session_id = p_session_id
                and sp.player_id = (v_item.payload ->> 'event_player_id')::uuid)
             >= (select max(sp.life_total) from public.game_session_players sp
                 where sp.session_id = p_session_id)
      then
        if coalesce((v_effect ->> 'once_per_turn')::boolean, false) then
          select turn_number into v_amount from public.game_turn_state where session_id = p_session_id;
          if (select gc.counters ->> 'dethrone_extra_turn' from public.game_cards gc
              where gc.id = v_item.source_card_id) = v_amount::text then
            v_i := v_i + 1; continue;
          end if;
          update public.game_cards
          set counters = coalesce(counters, '{}'::jsonb) || jsonb_build_object('dethrone_extra_turn', v_amount::text)
          where id = v_item.source_card_id and session_id = p_session_id;
        end if;
        perform public.apply_triggered_ability_effects(
          p_session_id, v_controller, v_item.source_card_id, coalesce(v_effect -> 'effects', '[]'::jsonb));
      end if;

    elsif v_type = 'territorial_attack' then
      -- Territorial Hellkite (mig 249): "choose an opponent at random that
      -- this creature didn't attack during your last combat. This creature
      -- attacks that player this combat if able. If you can't choose an
      -- opponent this way, tap this creature." The pick pins the defender
      -- (declare_attacker rejects others); declining to attack at all is not
      -- forced (approximation).
      select sp.player_id into v_decider
      from public.game_session_players sp
      where sp.session_id = p_session_id
        and sp.player_id is distinct from v_controller
        and sp.player_id::text is distinct from (
          select gc.counters ->> 'last_attacked'
          from public.game_cards gc where gc.id = v_item.source_card_id)
      order by random() limit 1;
      if v_decider is null then
        update public.game_cards set is_tapped = true
        where id = v_item.source_card_id and session_id = p_session_id;
      else
        update public.game_cards
        set counters = coalesce(counters, '{}'::jsonb) || jsonb_build_object('must_attack', v_decider::text)
        where id = v_item.source_card_id and session_id = p_session_id;
      end if;

    elsif v_type = 'put_from_command_zone' then
      -- "You may put a commander you own from the command zone onto the
      -- battlefield. It gains haste. Return it to the command zone at the
      -- beginning of the next end step." (Hellkite Courser, mig 248.)
      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gc.id, 'name', c.name) order by c.name, gc.id), '[]'::jsonb)
        into v_options
      from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.session_id = p_session_id and gc.zone = 'command'
        and gc.owner_id = v_controller and gc.is_commander = true;
      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'command_zone_pick',
        'You may put a commander onto the battlefield until the next end step',
        v_options, 0, 1, '{}'::jsonb)
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'play_hideaway' then
      -- Mosswort Bridge (mig 248): play the card this source hid with
      -- hideaway. A PERMANENT card enters the battlefield free under the
      -- activator (instants/sorceries are not supported — the card stays
      -- exiled). The power-10 gate is the ability's `condition`.
      v_tid := nullif((select gc.counters ->> 'hideaway_card'
                       from public.game_cards gc where gc.id = v_item.source_card_id), '')::uuid;
      if v_tid is not null and exists (
        select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.id = v_tid and gc.session_id = p_session_id and gc.zone = 'exile'
          and (c.type_line ilike '%creature%' or c.type_line ilike '%artifact%'
               or c.type_line ilike '%enchantment%' or c.type_line ilike '%land%'
               or c.type_line ilike '%planeswalker%' or c.type_line ilike '%battle%')
      ) then
        select turn_number into v_amount from public.game_turn_state where session_id = p_session_id;
        update public.game_cards gc
        set zone = 'battlefield', controller_player_id = v_controller, is_tapped = false,
            entered_battlefield_turn_number = coalesce(v_amount, 0),
            zone_position = (select coalesce(max(zone_position), -1) + 1
                             from public.game_cards x
                             where x.session_id = p_session_id and x.owner_id = gc.owner_id
                               and x.zone = 'battlefield')
        where gc.id = v_tid;
        perform public.register_card_continuous_effects(p_session_id, v_tid);
        update public.game_cards
        set counters = counters - 'hideaway_card'
        where id = v_item.source_card_id and session_id = p_session_id;
      end if;

    elsif v_type = 'put_from_hand' then
      -- "You may put a permanent card with mana value less than or equal to
      -- that damage from your hand onto the battlefield" (Broodcaller
      -- Scourge, mig 247). The cap rides the trigger payload (event_amount).
      v_amount := case when (v_effect -> 'filter' ->> 'max_mana_value') = 'event_amount'
                       then nullif(v_item.payload ->> 'event_amount', '')::integer
                       else nullif(v_effect -> 'filter' ->> 'max_mana_value', '')::integer end;
      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gc.id, 'name', c.name) order by c.name, gc.id), '[]'::jsonb)
        into v_options
      from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.session_id = p_session_id and gc.owner_id = v_controller and gc.zone = 'hand'
        and (not coalesce((v_effect -> 'filter' ->> 'permanent')::boolean, true)
             or c.type_line ilike '%creature%' or c.type_line ilike '%artifact%'
             or c.type_line ilike '%enchantment%' or c.type_line ilike '%land%'
             or c.type_line ilike '%planeswalker%' or c.type_line ilike '%battle%')
        and (v_amount is null or public.mana_value(c.mana_cost) <= v_amount);
      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'put_from_hand_pick',
        'You may put a card from your hand onto the battlefield',
        v_options, 0, greatest(1, coalesce((v_effect ->> 'count')::integer, 1)), '{}'::jsonb)
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'destroy_up_to' then
      -- "Destroy target artifact that opponent controls" as a parked pick
      -- (Parapet Thrasher mode, mig 247). "That opponent" is approximated as
      -- any matching opponent permanent. Picking nothing declines.
      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gc.id, 'name', c.name) order by c.name, gc.id), '[]'::jsonb)
        into v_options
      from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.session_id = p_session_id and gc.zone = 'battlefield'
        and (case lower(coalesce(v_effect -> 'target_filter' ->> 'controller', 'opponent'))
               when 'opponent' then coalesce(gc.controller_player_id, gc.owner_id) is distinct from v_controller
               when 'you' then coalesce(gc.controller_player_id, gc.owner_id) = v_controller
               else true end)
        and (coalesce(v_effect -> 'target_filter' ->> 'type_line', '') = ''
             or c.type_line ilike '%' || (v_effect -> 'target_filter' ->> 'type_line') || '%');
      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'destroy_pick',
        'Destroy up to ' || coalesce(v_effect ->> 'count', '1'),
        v_options, 0, greatest(1, coalesce((v_effect ->> 'count')::integer, 1)), '{}'::jsonb)
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'pay_x_mana_damage' then
      -- "You may pay any amount of {R}. When you do, it deals that much
      -- damage to any target." (Leyline Tyrant dies trigger, mig 244.) Parks
      -- the legal targets + the colour; submit_decision validates the amount
      -- against the payer's pool, deducts it, and applies the damage. Amount 0
      -- (or no pick) declines.
      v_options := public.divide_damage_options(p_session_id, v_controller, v_effect -> 'target_filter');
      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'pay_x_mana_damage',
        'Pay any amount of {' || upper(coalesce(v_effect ->> 'color', 'R')) || '}: that much damage to a target',
        v_options, 0, 1,
        jsonb_build_object('color', upper(coalesce(v_effect ->> 'color', 'R'))))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'bounce_up_to' then
      -- "Return up to one target nonland permanent an opponent controls with
      -- mana value less than or equal to that spell's mana value to its
      -- owner's hand" (Hammerhead Tyrant, mig 244). The MV ceiling is the
      -- TRIGGERING cast card's mana value when target_filter.max_mana_value =
      -- 'triggering_spell'. Picking nothing declines ("up to one").
      v_amount := null;
      if (v_effect -> 'target_filter' ->> 'max_mana_value') = 'triggering_spell' then
        select public.mana_value(c.mana_cost) into v_amount
        from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.id = nullif(v_item.payload ->> 'triggering_card_id', '')::uuid
          and gc.session_id = p_session_id;
      end if;
      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gc.id, 'name', c.name) order by c.name, gc.id), '[]'::jsonb)
        into v_options
      from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.session_id = p_session_id and gc.zone = 'battlefield'
        and (case lower(coalesce(v_effect -> 'target_filter' ->> 'controller', 'opponent'))
               when 'opponent' then coalesce(gc.controller_player_id, gc.owner_id) is distinct from v_controller
               when 'you' then coalesce(gc.controller_player_id, gc.owner_id) = v_controller
               else true end)
        and (not coalesce((v_effect -> 'target_filter' ->> 'nonland')::boolean, false)
             or c.type_line not ilike '%land%')
        and (v_amount is null or public.mana_value(c.mana_cost) <= v_amount);
      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'bounce_pick',
        'Return up to ' || coalesce(v_effect ->> 'count', '1') || ' to its owner''s hand',
        v_options, 0, greatest(1, coalesce((v_effect ->> 'count')::integer, 1)), '{}'::jsonb)
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'pump_all' then
      -- Mass until-EOT pump from the program (mig 243, Become the Avalanche).
      -- Previously pump_all only ran inside choose_creature_type's apply path;
      -- the helper now resolves count-based power/toughness itself.
      perform public.apply_mass_pump_until_eot(
        p_session_id, v_item.source_card_id, v_controller, v_effect);

    elsif v_type = 'prevent_damage' then
      perform public.add_damage_prevention(
        p_session_id,
        v_controller,
        case when v_effect ? 'amount' then (v_effect ->> 'amount')::integer else null end,
        coalesce((v_effect ->> 'combat_only')::boolean, false),
        v_item.source_card_id
      );

    elsif (v_effect ->> 'target') = 'triggering_creature' then
      -- Reflexive watcher (mig 227): the EVENT SUBJECT (the entering/attacking
      -- creature) receives the effect, no target pick. "Whenever a Dragon you
      -- control attacks, IT gains double strike" (Atarka); "whenever a creature
      -- with flying enters, IT gains haste" (Dragon Tempest). The triggering
      -- card id rode in via enqueue_triggered_ability.
      if nullif(v_item.payload ->> 'triggering_card_id', '')::uuid is not null then
        perform public.apply_creature_effect(
          p_session_id, v_type,
          nullif(v_item.payload ->> 'triggering_card_id', '')::uuid, v_effect);
      end if;

    else
      if jsonb_typeof(v_targets) = 'array' and jsonb_array_length(v_targets) > 0
         and public.trigger_effect_target_type(v_effect) is not null then
        for v_tid in select (value)::uuid from jsonb_array_elements_text(v_targets)
        loop
          perform public.apply_targeted_triggered_ability_effects(
            p_session_id, v_controller, v_item.source_card_id, jsonb_build_array(v_effect), v_tid
          );
        end loop;
      else
        -- fighter:'triggering_creature' (mig 245, Frontier Siege Dragons
        -- mode): the EVENT SUBJECT fights the picked target, not the watcher.
        perform public.apply_targeted_triggered_ability_effects(
          p_session_id, v_controller,
          case when (v_effect ->> 'fighter') = 'triggering_creature'
               then coalesce(nullif(v_item.payload ->> 'triggering_card_id', '')::uuid, v_item.source_card_id)
               else v_item.source_card_id end,
          jsonb_build_array(v_effect), v_target
        );
      end if;
    end if;

    v_i := v_i + 1;
  end loop;

  return null;
end;
$$;
grant execute on function public.apply_trigger_effects(uuid, uuid, integer) to authenticated;

create or replace function public.apply_triggered_ability_effects(
  p_session_id uuid,
  p_controller_id uuid,
  p_source_card_id uuid,
  p_effects jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_effect jsonb;
  v_eff_type text;
  v_eff_amount integer;
  v_recipient text;
  v_recipients uuid[];
  v_rid uuid;
  v_draw_i integer;
  v_lib_card uuid;
  v_next_hand_position integer;
  v_next_graveyard_position integer;
  v_token_card_id uuid;
  v_token_count integer;
  v_turn_number integer;
  v_next_pos integer;
  v_new_token_id uuid;
  v_i integer;
  v_target_controller text;
  v_counter_type text;
  v_all boolean;
  v_milled_type text;
  v_milled_type_hit boolean;
  v_token_recipient uuid;
  v_dmg_target uuid;
  v_exiled uuid[];
  v_mon integer;
  v_hand integer;
begin
  for v_effect in
    select * from jsonb_array_elements(coalesce(p_effects, '[]'::jsonb))
  loop
    v_eff_type := lower(coalesce(v_effect ->> 'type', ''));
    v_eff_amount := public.resolve_dynamic_amount(
      p_session_id, p_source_card_id, p_controller_id, v_effect -> 'amount');
    v_recipient := lower(coalesce(v_effect ->> 'recipient', ''));

    if v_eff_type = 'untap_all_attackers' then
      -- "Untap all attacking creatures" (mig 250, Scourge of the Throne).
      update public.game_cards gc
      set is_tapped = false
      from public.game_combat_assignments ca
      where ca.session_id = p_session_id and ca.attacker_card_id = gc.id
        and gc.session_id = p_session_id and gc.zone = 'battlefield';

    elsif v_eff_type = 'extra_combat' then
      -- "After this phase, there is an additional combat phase" (mig 250):
      -- advance_step loops end_of_combat back to beginning_of_combat once per
      -- pending extra combat.
      update public.game_turn_state
      set extra_combats = coalesce(extra_combats, 0) + 1
      where session_id = p_session_id;

    elsif v_eff_type = 'add_mana' then
      -- Mana from a resolved trigger (mig 245, Frontier Siege Khans mode:
      -- "At the beginning of each of your main phases, add {G}{G}"). Fixed
      -- colours only; goes to the trigger's controller.
      if p_controller_id is not null and v_eff_amount > 0
         and upper(coalesce(v_effect ->> 'color', '')) in ('W', 'U', 'B', 'R', 'G', 'C') then
        insert into public.game_players (session_id, player_id, mana_pool)
        values (p_session_id, p_controller_id, jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0))
        on conflict (session_id, player_id) do nothing;
        update public.game_players
        set mana_pool = jsonb_set(
              coalesce(mana_pool, jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0)),
              array[upper(v_effect ->> 'color')],
              to_jsonb(coalesce((mana_pool ->> upper(v_effect ->> 'color'))::integer, 0) + v_eff_amount))
        where session_id = p_session_id and player_id = p_controller_id;
      end if;

    elsif v_eff_type = 'gain_life' then
      if v_eff_amount > 0 then
        if v_recipient in ('each_player', 'all_players') then
          select array_agg(player_id) into v_recipients
          from public.game_session_players where session_id = p_session_id;
        elsif v_recipient = 'each_opponent' then
          select array_agg(player_id) into v_recipients
          from public.game_session_players
          where session_id = p_session_id and player_id is distinct from p_controller_id;
        else
          v_recipients := array[p_controller_id];
        end if;
        foreach v_rid in array coalesce(v_recipients, array[]::uuid[]) loop
          if v_rid is not null then
            update public.game_session_players
            set life_total = life_total + v_eff_amount
            where session_id = p_session_id and player_id = v_rid;
          end if;
        end loop;
      end if;

    elsif v_eff_type in ('lose_life', 'deal_damage') then
      if v_eff_amount > 0 then
        if nullif(v_effect ->> 'recipient_player_id', '') is not null then
          -- A specific player, injected at enqueue time (Thunderbreak Regent:
          -- "deals 3 damage to THAT player" — the one who targeted your Dragon).
          v_recipients := array[(v_effect ->> 'recipient_player_id')::uuid];
        elsif v_recipient = 'controller' then
          v_recipients := array[p_controller_id];
        elsif v_recipient in ('each_player', 'all_players') then
          select array_agg(player_id) into v_recipients
          from public.game_session_players where session_id = p_session_id;
        else
          select array_agg(player_id) into v_recipients
          from public.game_session_players
          where session_id = p_session_id and player_id is distinct from p_controller_id;
        end if;
        foreach v_rid in array coalesce(v_recipients, array[]::uuid[]) loop
          update public.game_session_players
          set life_total = greatest(0, life_total - v_eff_amount)
          where session_id = p_session_id and player_id = v_rid;
        end loop;
      end if;

    elsif v_eff_type = 'add_player_counters' then
      v_counter_type := lower(coalesce(v_effect ->> 'counter_type', 'poison'));
      v_all := coalesce((v_effect ->> 'all')::boolean, false);
      if v_eff_amount <> 0 or v_all then
        if v_recipient = 'controller' then
          v_recipients := array[p_controller_id];
        elsif v_recipient in ('each_player', 'all_players') then
          select array_agg(player_id) into v_recipients
          from public.game_session_players where session_id = p_session_id;
        else
          select array_agg(player_id) into v_recipients
          from public.game_session_players
          where session_id = p_session_id and player_id is distinct from p_controller_id;
        end if;
        foreach v_rid in array coalesce(v_recipients, array[]::uuid[]) loop
          if v_rid is not null then
            update public.game_session_players
            set counters = case when v_all then counters - v_counter_type
                                else public.adjust_counter_bag(counters, v_counter_type, v_eff_amount) end
            where session_id = p_session_id and player_id = v_rid;
          end if;
        end loop;
        perform public.maybe_finish_game_session(p_session_id);
      end if;

    elsif v_eff_type = 'draw' then
      if p_controller_id is not null then
        for v_draw_i in 1..greatest(1, v_eff_amount) loop
          select coalesce(max(zone_position), -1) + 1 into v_next_hand_position
          from public.game_cards
          where session_id = p_session_id and owner_id = p_controller_id and zone = 'hand';
          select id into v_lib_card
          from public.game_cards
          where session_id = p_session_id and owner_id = p_controller_id and zone = 'library'
          order by zone_position asc, id asc limit 1 for update skip locked;
          exit when v_lib_card is null;
          update public.game_cards
          set zone = 'hand', zone_position = v_next_hand_position, is_tapped = false
          where id = v_lib_card;
        end loop;
      end if;

    elsif v_eff_type = 'mill' then
      if v_eff_amount > 0 then
        v_milled_type := v_effect ->> 'if_milled_type';
        v_milled_type_hit := false;
        if v_recipient = 'controller' or v_recipient = '' then
          v_recipients := array[p_controller_id];
        elsif v_recipient in ('each_player', 'all_players') then
          select array_agg(player_id) into v_recipients
          from public.game_session_players where session_id = p_session_id;
        else
          select array_agg(player_id) into v_recipients
          from public.game_session_players
          where session_id = p_session_id and player_id is distinct from p_controller_id;
        end if;
        foreach v_rid in array coalesce(v_recipients, array[]::uuid[]) loop
          if v_rid is not null then
            for v_draw_i in 1..v_eff_amount loop
              select coalesce(max(zone_position), -1) + 1 into v_next_graveyard_position
              from public.game_cards
              where session_id = p_session_id and owner_id = v_rid and zone = 'graveyard';
              select id into v_lib_card
              from public.game_cards
              where session_id = p_session_id and owner_id = v_rid and zone = 'library'
              order by zone_position asc, id asc limit 1 for update skip locked;
              exit when v_lib_card is null;
              if v_milled_type is not null and exists (
                select 1 from public.game_cards g join public.cards c on c.id = g.card_id
                where g.id = v_lib_card and c.type_line ilike '%' || v_milled_type || '%'
              ) then
                v_milled_type_hit := true;
              end if;
              update public.game_cards
              set zone = 'graveyard', zone_position = v_next_graveyard_position, is_tapped = false
              where id = v_lib_card;
            end loop;
          end if;
        end loop;
        if v_milled_type is not null and v_milled_type_hit then
          perform public.apply_triggered_ability_effects(
            p_session_id, p_controller_id, p_source_card_id, coalesce(v_effect -> 'then', '[]'::jsonb));
        end if;
      end if;

    elsif v_eff_type = 'create_token' then
      -- A dynamic count object ({count:{count:'...'}}) resolves via the amount
      -- engine and is NOT floored at 1 — zero matches makes zero tokens (Gadrak
      -- with no nontoken deaths). A literal/absent count keeps the floor-at-1.
      if jsonb_typeof(v_effect -> 'count') = 'object' then
        v_token_count := public.resolve_dynamic_amount(
          p_session_id, p_source_card_id, p_controller_id, v_effect -> 'count');
      else
        v_token_count := greatest(1, coalesce((v_effect ->> 'count')::integer, 1));
      end if;
      v_token_recipient := coalesce(nullif(v_effect ->> 'recipient_player_id', '')::uuid, p_controller_id);
      select id into v_token_card_id
      from public.cards
      where lower(name) = lower(coalesce(v_effect ->> 'token', '')) and is_token = true
      limit 1;
      if found and v_token_recipient is not null then
        select turn_number into v_turn_number
        from public.game_turn_state where session_id = p_session_id;
        for v_i in 1..least(v_token_count, 20) loop
          select coalesce(max(zone_position), -1) + 1 into v_next_pos
          from public.game_cards
          where session_id = p_session_id and owner_id = v_token_recipient and zone = 'battlefield';
          insert into public.game_cards (
            session_id, card_id, owner_id, controller_player_id,
            zone, zone_position, is_tapped, damage_marked,
            position_x, position_y, entered_battlefield_turn_number
          )
          values (
            p_session_id, v_token_card_id, v_token_recipient, v_token_recipient,
            'battlefield', v_next_pos, coalesce((v_effect ->> 'tapped')::boolean, false), 0, 0, 0, coalesce(v_turn_number, 0)
          )
          returning id into v_new_token_id;
          perform public.register_card_continuous_effects(p_session_id, v_new_token_id);
        end loop;
      end if;

    elsif v_eff_type = 'deal_damage_all' then
      -- Mass damage (mig 224): N damage to every creature matching the filter,
      -- optionally to planeswalkers too. filter.with_keyword/without_keyword
      -- gate on flying (Harbinger); filter.exclude_source skips this card
      -- ("each OTHER creature"). One lethal sweep at the end (per-hit sweep off).
      if v_eff_amount > 0 then
        for v_dmg_target in
          select gc.id
          from public.game_cards gc join public.cards c on c.id = gc.card_id
          where gc.session_id = p_session_id and gc.zone = 'battlefield'
            and c.type_line ilike '%creature%'
            and (not coalesce((v_effect -> 'filter' ->> 'exclude_source')::boolean, false)
                 or gc.id is distinct from p_source_card_id)
            and ((v_effect -> 'filter' ->> 'without_keyword') is distinct from 'flying'
                 or not public.card_has_flying(p_session_id, gc.id))
            and ((v_effect -> 'filter' ->> 'with_keyword') is distinct from 'flying'
                 or public.card_has_flying(p_session_id, gc.id))
        loop
          perform public.apply_damage_to_creature(
            p_session_id, v_dmg_target, v_eff_amount, p_source_card_id, false, false, false);
        end loop;

        if lower(coalesce(v_effect ->> 'targets', 'creatures')) = 'creatures_planeswalkers' then
          for v_dmg_target in
            select gc.id
            from public.game_cards gc join public.cards c on c.id = gc.card_id
            where gc.session_id = p_session_id and gc.zone = 'battlefield'
              and c.type_line ilike '%planeswalker%'
          loop
            perform public.apply_damage_to_planeswalker(p_session_id, v_dmg_target, v_eff_amount);
          end loop;
        end if;

        perform public.move_lethal_damaged_creatures_to_graveyard(p_session_id);
        perform public.move_zero_loyalty_planeswalkers_to_graveyard(p_session_id);
      end if;

    elsif v_eff_type = 'amass' then
      if p_controller_id is not null and v_eff_amount > 0 then
        perform public.amass(p_session_id, p_controller_id, v_eff_amount);
      end if;

    elsif v_eff_type = 'destroy_all' then
      if p_controller_id is not null then
        perform public.destroy_all_creatures(
          p_session_id, p_controller_id,
          nullif(v_effect ->> 'creature_type', ''),
          lower(coalesce(v_effect ->> 'scope', 'all')));
      end if;

    elsif v_eff_type = 'return_all_from_graveyard' then
      if p_controller_id is not null then
        -- from:'all_graveyards' (mig 214, Grimoire of the Dead) sweeps EVERY
        -- graveyard and puts the cards under the controller's control.
        perform public.return_all_from_graveyard(
          p_session_id, p_controller_id,
          nullif(v_effect ->> 'creature_type', ''),
          lower(coalesce(v_effect ->> 'to', 'battlefield')),
          lower(coalesce(v_effect ->> 'from', '')) = 'all_graveyards');
      end if;

    elsif v_eff_type = 'add_counters' then
      v_counter_type := v_effect ->> 'counter_type';
      v_all := coalesce((v_effect ->> 'all')::boolean, false);
      if p_source_card_id is not null and (v_eff_amount <> 0 or v_all) then
        if v_eff_amount > 0 then
          v_eff_amount := v_eff_amount * public.counter_factor(
            p_session_id,
            (select controller_player_id from public.game_cards
             where id = p_source_card_id and session_id = p_session_id));
        end if;
        if public.is_plus_one_counter(v_counter_type) then
          update public.game_cards
          set plus_one_counters = case when v_all then 0 else greatest(0, plus_one_counters + v_eff_amount) end
          where id = p_source_card_id and session_id = p_session_id and zone = 'battlefield';
        else
          update public.game_cards
          set counters = case when v_all then counters - lower(v_counter_type)
                              else public.adjust_counter_bag(counters, lower(v_counter_type), v_eff_amount) end
          where id = p_source_card_id and session_id = p_session_id and zone = 'battlefield';
        end if;
        perform public.recheck_counter_state(p_session_id);
      end if;

    elsif v_eff_type = 'add_counters_all' then
      v_counter_type := v_effect ->> 'counter_type';
      v_all := coalesce((v_effect ->> 'all')::boolean, false);
      if (v_eff_amount <> 0 or v_all) and p_controller_id is not null then
        v_target_controller := public.behavior_target_controller(v_effect || jsonb_build_object(
          'target_controller', coalesce(v_effect ->> 'target_controller', 'you')
        ));
        if public.is_plus_one_counter(v_counter_type) then
          update public.game_cards gc
          set plus_one_counters = case when v_all then 0
            else greatest(0, gc.plus_one_counters
              + case when v_eff_amount > 0
                     then v_eff_amount * public.counter_factor(p_session_id, gc.controller_player_id)
                     else v_eff_amount end) end
          from public.cards c
          where c.id = gc.card_id and gc.session_id = p_session_id and gc.zone = 'battlefield'
            and c.type_line ilike '%creature%'
            and (
              v_target_controller = 'any'
              or (v_target_controller = 'you' and gc.controller_player_id = p_controller_id)
              or (v_target_controller = 'opponent' and gc.controller_player_id is distinct from p_controller_id)
            );
        else
          update public.game_cards gc
          set counters = case when v_all then gc.counters - lower(v_counter_type)
            else public.adjust_counter_bag(gc.counters, lower(v_counter_type),
              case when v_eff_amount > 0
                   then v_eff_amount * public.counter_factor(p_session_id, gc.controller_player_id)
                   else v_eff_amount end) end
          from public.cards c
          where c.id = gc.card_id and gc.session_id = p_session_id and gc.zone = 'battlefield'
            and c.type_line ilike '%creature%'
            and (
              v_target_controller = 'any'
              or (v_target_controller = 'you' and gc.controller_player_id = p_controller_id)
              or (v_target_controller = 'opponent' and gc.controller_player_id is distinct from p_controller_id)
            );
        end if;
        perform public.recheck_counter_state(p_session_id);
      end if;

    elsif v_eff_type in ('tap_all', 'untap_all') then
      if p_controller_id is not null then
        v_target_controller := public.behavior_target_controller(v_effect || jsonb_build_object(
          'target_controller', coalesce(v_effect ->> 'target_controller', 'you')
        ));
        update public.game_cards gc
        set is_tapped = (v_eff_type = 'tap_all')
        from public.cards c
        where c.id = gc.card_id and gc.session_id = p_session_id and gc.zone = 'battlefield'
          and c.type_line ilike '%creature%'
          and (
            v_target_controller = 'any'
            or (v_target_controller = 'you' and gc.controller_player_id = p_controller_id)
            or (v_target_controller = 'opponent' and gc.controller_player_id is distinct from p_controller_id)
          );
      end if;

    elsif v_eff_type = 'grant_cast_from_graveyard' then
      if p_controller_id is not null then
        -- card_id (mig 215, Havengul Lich): the permission covers ONE specific
        -- graveyard card instead of a type filter.
        insert into public.game_continuous_effects (
          session_id, source_card_id, affected_player_id, effect_type, payload,
          expires_at_phase, expires_at_step
        )
        values (
          p_session_id, p_source_card_id, p_controller_id, 'cast_from_graveyard',
          jsonb_strip_nulls(jsonb_build_object(
            'type_line', coalesce(v_effect ->> 'type_line', ''),
            'card_id', v_effect ->> 'card_id')),
          'ending', 'cleanup'
        );
      end if;

    elsif v_eff_type = 'monstrosity' then
      -- "Monstrosity N" (Stormbreath Dragon): if this permanent isn't monstrous,
      -- put N +1/+1 counters on it and it becomes monstrous (a once-marker in the
      -- counter bag), then apply its `on_monstrous` effects ("when this becomes
      -- monstrous, …"). A no-op when already monstrous.
      select coalesce((counters ->> 'monstrous')::integer, 0) into v_mon
      from public.game_cards where id = p_source_card_id and session_id = p_session_id;
      if coalesce(v_mon, 0) = 0 then
        update public.game_cards
        set plus_one_counters = coalesce(plus_one_counters, 0)
              + greatest(1, coalesce((v_effect ->> 'amount')::integer, 1)),
            counters = public.adjust_counter_bag(coalesce(counters, '{}'::jsonb), 'monstrous', 1)
        where id = p_source_card_id and session_id = p_session_id;
        if jsonb_typeof(v_effect -> 'on_monstrous') = 'array' then
          perform public.apply_triggered_ability_effects(
            p_session_id, p_controller_id, p_source_card_id, v_effect -> 'on_monstrous');
        end if;
      end if;

    elsif v_eff_type = 'damage_each_opponent_by_hand' then
      -- "deals damage to each opponent equal to the number of cards in that
      -- player's hand" (Stormbreath). Per-opponent, so it can't reuse the single
      -- v_eff_amount lose_life path.
      for v_rid in
        select player_id from public.game_session_players
        where session_id = p_session_id and player_id is distinct from p_controller_id
      loop
        select count(*)::integer into v_hand
        from public.game_cards
        where session_id = p_session_id and owner_id = v_rid and zone = 'hand';
        update public.game_session_players
        set life_total = greatest(0, life_total - coalesce(v_hand, 0))
        where session_id = p_session_id and player_id = v_rid;
      end loop;
      perform public.maybe_finish_game_session(p_session_id);

    elsif v_eff_type = 'impulse' then
      -- "Exile the top N cards of your library. Until the end of your next turn,
      -- you may play those cards." (Atsushi.) Move the cards to exile and write a
      -- card-specific play_from_exile permission for the controller; the cast path
      -- (cast_card_from_hand) honours it, and advance_step expires it at the end
      -- step of the controller's NEXT turn (created_turn < current turn).
      if p_controller_id is not null then
        select turn_number into v_turn_number
        from public.game_turn_state where session_id = p_session_id;
        select coalesce(max(zone_position), -1) into v_next_pos
        from public.game_cards
        where session_id = p_session_id and owner_id = p_controller_id and zone = 'exile';
        with top as (
          select id, row_number() over (order by zone_position asc, id asc) as rn
          from public.game_cards
          where session_id = p_session_id and owner_id = p_controller_id and zone = 'library'
          order by zone_position asc, id asc
          limit greatest(1, coalesce((v_effect ->> 'count')::integer, 1))
        )
        update public.game_cards gc
        set zone = 'exile', zone_position = v_next_pos + top.rn,
            controller_player_id = gc.owner_id, is_tapped = false, damage_marked = 0
        from top where gc.id = top.id;
        select array_agg(id) into v_exiled
        from public.game_cards
        where session_id = p_session_id and owner_id = p_controller_id and zone = 'exile'
          and zone_position > v_next_pos;
        if v_exiled is not null and array_length(v_exiled, 1) > 0 then
          insert into public.game_continuous_effects (
            session_id, source_card_id, affected_player_id, effect_type, payload
          ) values (
            p_session_id, p_source_card_id, p_controller_id, 'play_from_exile',
            jsonb_build_object(
              'card_ids', to_jsonb(v_exiled),
              'created_turn', coalesce(v_turn_number, 0))
          );
        end if;
      end if;

    elsif v_eff_type = 'grant_keyword_all' then
      -- Mass keyword until end of turn (mig 202). scope 'controller' => only
      -- that player's permanents (affected_player_id set); 'all' (default) =>
      -- everyone's. creature_type filters by subtype (omit for all). Only the
      -- grantable combat keywords (the mig 200 accessor set) are accepted.
      if lower(coalesce(v_effect ->> 'keyword', '')) in (
        'flying', 'reach', 'deathtouch', 'trample', 'vigilance', 'haste',
        'indestructible', 'first_strike', 'double_strike', 'menace',
        'intimidate', 'hexproof'
      ) then
        insert into public.game_continuous_effects (
          session_id, source_card_id, affected_player_id, effect_type, payload,
          expires_at_phase, expires_at_step
        ) values (
          p_session_id, p_source_card_id,
          case when lower(coalesce(v_effect ->> 'scope', 'all')) = 'controller'
               then p_controller_id else null end,
          lower(v_effect ->> 'keyword'),
          jsonb_strip_nulls(jsonb_build_object(
            'creature_type', v_effect ->> 'creature_type',
            'includes_player',
            case when coalesce((v_effect ->> 'includes_player')::boolean, false)
                 then true else null end
          )),
          'ending', 'cleanup'
        );
      end if;

    elsif v_eff_type = 'return_self_to_hand' then
      -- "Return this permanent to its owner's hand" (Encroaching/Breaching
      -- Dragonstorm, when a Dragon you control enters).
      if p_source_card_id is not null then
        update public.game_cards gc
        set zone = 'hand',
            zone_position = (select coalesce(max(zone_position), -1) + 1 from public.game_cards
                             where session_id = p_session_id and owner_id = gc.owner_id and zone = 'hand'),
            controller_player_id = gc.owner_id, is_tapped = false, damage_marked = 0, plus_one_counters = 0
        where gc.id = p_source_card_id and gc.session_id = p_session_id and gc.zone = 'battlefield';
        perform public.rebuild_scripted_continuous_effects(p_session_id);
      end if;

    elsif v_eff_type = 'grant_keyword' then
      -- Untargeted single grant → the source permanent (Skarrgan's Riot haste
      -- mode). apply_creature_effect writes the keyword continuous effect.
      if p_source_card_id is not null then
        perform public.apply_creature_effect(p_session_id, 'grant_keyword', p_source_card_id, v_effect);
      end if;

    elsif v_eff_type = 'set_pt' then
      -- Untargeted set base P/T → the source (Nogi: "becomes 5/5 until EOT").
      if p_source_card_id is not null then
        perform public.apply_creature_effect(p_session_id, 'set_pt', p_source_card_id, v_effect);
      end if;

    elsif v_eff_type = 'conditional' then
      -- "If <condition>, <effects>." A count-based gate: resolve the condition's
      -- count ({count, type_line?}) and, when it meets `at_least`, recursively
      -- apply the inner effects through this same resolver. Inner effects are the
      -- non-decision vocabulary (lose_life/gain_life/draw/create_token/…).
      if public.resolve_dynamic_amount(
           p_session_id, p_source_card_id, p_controller_id, v_effect -> 'condition')
         >= coalesce((v_effect -> 'condition' ->> 'at_least')::integer, 1)
      then
        perform public.apply_triggered_ability_effects(
          p_session_id, p_controller_id, p_source_card_id,
          coalesce(v_effect -> 'effects', '[]'::jsonb));
      end if;

    elsif v_eff_type = 'curse_attack_zombie' then
      -- "Enchant player." Register the curse on the recipient player (the chosen
      -- enchanted player after choose_player), sourced from the curse card;
      -- declare_attacker reads it when that player is attacked. Only while the
      -- curse stays on the battlefield (source_zone_required).
      if p_controller_id is not null and p_source_card_id is not null then
        insert into public.game_continuous_effects (
          session_id, source_card_id, affected_player_id, effect_type, payload, source_zone_required)
        values (p_session_id, p_source_card_id, p_controller_id, 'curse_attacked', '{}'::jsonb, 'battlefield');
      end if;
    end if;
    -- Unknown effect types are ignored (forward-compatible).
  end loop;
end;
$$;
grant execute on function public.apply_triggered_ability_effects(uuid, uuid, uuid, jsonb) to authenticated;
