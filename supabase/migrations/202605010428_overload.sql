-- 202605010428_overload
-- Overload (Cyclonic Rift, Vandalblast): cast_spell_effect gains a p_overload
-- boolean (default false, new last param). When true, the script's `overload`
-- mana cost replaces the printed cost and the engine runs the script's
-- `overload_effect` actions (mass, untargeted — "change 'target' to 'each'")
-- instead of the client-supplied program, mirroring the flashback_effect
-- precedent. bounce_all additionally learns scope 'opponent' (only permanents
-- the controller does not control) for Cyclonic Rift's one-sided mass bounce.
-- Generated from supabase/functions_src (cast_spell_effect, apply_triggered_ability_effects) — those files are
-- the canonical current definitions; edit them, not past migrations.

-- A new trailing default param changes the function's identity arguments, so
-- `create or replace` below would ADD a second overload rather than replace the
-- old one. Drop the old 7-arg signature first (same pattern as mig 418 when
-- p_free was added).
drop function if exists public.cast_spell_effect(uuid, jsonb, uuid, integer, uuid, boolean, boolean);

create or replace function public.cast_spell_effect(
  p_session_id uuid,
  p_actions jsonb,
  p_source_card_id uuid default null,
  p_x_value integer default null,
  p_target_card_id uuid default null,
  -- Adventure (mig 295): casting the adventure HALF of a card. On resolution the
  -- source goes to exile (not the graveyard) with a non-expiring play_from_exile
  -- permission, so the creature face can be cast from exile later.
  p_adventure boolean default false,
  -- Free cast (mig 418, cascade / generalized nested-cast): skip the payment block
  -- entirely — no mana, no flashback cost — while still moving the source and firing
  -- watchers. The caller has already decided the cast is free.
  p_free boolean default false,
  -- Overload (mig 428, Cyclonic Rift / Vandalblast): cast for the script's
  -- `overload` mana cost instead of the printed cost; the engine runs the
  -- script's `overload_effect` actions (mass, untargeted — "change 'target' to
  -- 'each'") instead of the client-supplied program, mirroring flashback_effect.
  p_overload boolean default false
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
  v_source_is_commander boolean := false;
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
  -- A free (engine-authorized) cast happens during resolution — cascade nested-casts
  -- a found spell off-turn, when the caster does not hold priority. Bypass the gate,
  -- consistent with the payment/permission/timing bypasses below.
  if not p_free and coalesce(v_turn.priority_player_id, v_turn.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can cast';
  end if;

  if p_source_card_id is not null then
    select cards.type_line, cards.mana_cost, game_cards.zone, cards.script,
           coalesce(game_cards.is_commander, false)
      into v_source_type_line, v_source_mana_cost, v_source_zone, v_source_script,
           v_source_is_commander
    from public.game_cards
    join public.cards on cards.id = game_cards.card_id
    where game_cards.id = p_source_card_id
      and game_cards.session_id = p_session_id
      and game_cards.owner_id = auth.uid();
    if not found then
      raise exception 'Source card not found or not owned by current user';
    end if;
  end if;

  -- An EXILE source (mig 230 impulse, mig 295 adventure) requires a
  -- play_from_exile permission listing this card. Mirrors cast_card_from_hand;
  -- the card pays its printed cost (below) and goes to the graveyard on cast.
  -- A free cast (p_free — cascade / generalized nested-cast) is engine-authorized
  -- and self-authorizing: it needs no play_from_exile permission row, mirroring the
  -- p_free guards on the priority, payment, and sorcery-timing gates.
  if not p_free and p_source_card_id is not null and v_source_zone = 'exile' then
    if not exists (
      select 1 from public.game_continuous_effects ce
      where ce.session_id = p_session_id
        and ce.effect_type = 'play_from_exile'
        and ce.affected_player_id = auth.uid()
        and (ce.payload -> 'card_ids') ? p_source_card_id::text
    ) then
      raise exception 'You do not have permission to play that card from exile';
    end if;
  end if;

  -- Overload is script-gated: the card must carry both the alternative cost and
  -- the engine-selected mass program, and — like the flashback/adventure
  -- alternative-cost mechanics — it is only available while actually casting the
  -- card from hand (or exile, e.g. an impulse cast), never from the graveyard.
  if p_overload then
    if p_source_card_id is null
       or nullif(v_source_script ->> 'overload', '') is null
       or jsonb_typeof(v_source_script -> 'overload_effect' -> 'actions') <> 'array'
       or jsonb_array_length(v_source_script -> 'overload_effect' -> 'actions') < 1 then
      raise exception 'This card has no overload cost';
    end if;
    if v_source_zone not in ('hand', 'exile') then
      raise exception 'Overload can only be used when casting from hand or exile';
    end if;
  end if;

  -- Timing: instants any time the caster has priority; sorceries main-phase only,
  -- empty stack, active player. A sourceless cast (tests) defaults to instant.
  if v_source_type_line ilike '%sorcery%' then
    v_timing := 'sorcery';
  else
    v_timing := 'instant';
  end if;

  -- A free (engine-authorized) cast bypasses sorcery timing: a cascade / nested cast
  -- of a found sorcery happens during resolution, off-turn and with a non-empty stack.
  if not p_free and v_timing = 'sorcery' then
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

  -- The spell program. An OVERLOAD cast uses the script's `overload_effect`
  -- actions; a FLASHBACK (graveyard) cast uses the script's
  -- `flashback_effect` actions when present, REPLACING the normal effect (the
  -- "Increasing …" cards do more / different on flashback). The engine selects by
  -- cast mode / zone — it does not trust the client's actions for either.
  if p_overload then
    v_program := v_source_script -> 'overload_effect' -> 'actions';
  elsif v_source_zone = 'graveyard'
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
  if not p_free and p_source_card_id is not null and v_source_zone in ('hand', 'exile') then
    -- Adventure half (mig 388): the spell being cast is the ADVENTURE, which
    -- has its OWN mana cost (Stomp is {1}{R}, not Bonecrusher's {2}{R}). The
    -- printed cost was charged before — unnoticed only because Murderous
    -- Rider's two costs happen to match.
    if p_adventure then
      v_source_mana_cost := coalesce(v_source_script -> 'adventure' ->> 'cost', v_source_mana_cost);
      v_source_type_line := nullif(split_part(coalesce(v_source_type_line, ''), ' // ', 2), '');
    end if;
    -- Overload (mig 428): the alternative cost REPLACES the printed cost
    -- (guarded non-null above). Cost reduction below still applies — reductions
    -- apply after an alternative cost is chosen.
    if p_overload then
      v_source_mana_cost := v_source_script ->> 'overload';
    end if;
    if v_source_mana_cost is not null and btrim(v_source_mana_cost) <> '' then
      -- Cost reduction (mig 231, Draconic Lore: "costs {2} less if you control a
      -- Dragon"). Generic mana is auto-paid here (null generic payment), so the
      -- reduced cost is consumed with no client change. An exile cast (impulse)
      -- pays the printed cost too — impulse is not a free cast.
      perform public.pay_mana_cost(
        p_session_id, auth.uid(),
        public.reduced_mana_cost(p_session_id, auth.uid(), p_source_card_id, v_source_mana_cost),
        null, coalesce(p_x_value, 0),
        p_pay_context := jsonb_build_object('kind', 'cast', 'type_line', coalesce(v_source_type_line, ''),
          'is_commander', v_source_is_commander));
    end if;
  elsif not p_free and p_source_card_id is not null and v_source_zone = 'graveyard' then
    v_flashback_cost := v_source_script ->> 'flashback';
    -- GRANTED flashback (mig 392, Snapcaster Mage): a turn-stamped counter on
    -- the graveyard card ("gains flashback until end of turn"); the flashback
    -- cost is the card's own mana cost.
    if v_flashback_cost is null then
      if (select (counters ->> 'flashback_until_turn')::integer
          from public.game_cards
          where id = p_source_card_id and session_id = p_session_id) = v_turn.turn_number then
        v_flashback_cost := coalesce(v_source_mana_cost, '');
      end if;
    end if;
    if v_flashback_cost is null then
      raise exception 'This card cannot be cast from your graveyard';
    end if;
    v_is_flashback := true;
    if btrim(v_flashback_cost) <> '' then
      perform public.pay_mana_cost(p_session_id, auth.uid(), v_flashback_cost, null, coalesce(p_x_value, 0),
        p_pay_context := jsonb_build_object('kind', 'cast', 'type_line', coalesce(v_source_type_line, ''),
          'is_commander', v_source_is_commander));
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
      -- An overloaded spell is untargeted ("each"): never stamp a stray target.
      || (case when p_target_card_id is not null and not p_overload
               then jsonb_build_object('target_card_id', p_target_card_id) else '{}'::jsonb end),
    v_next_position,
    'pending'
  )
  returning * into v_stack;

  -- "Whenever you/an opponent cast a spell" (mig 234, Taurean Mauler): broadcast
  -- the cast to spell_cast watchers. The caster is the source's controller.
  if p_source_card_id is not null then
    perform public.fire_watcher_triggers(p_session_id, p_source_card_id, auth.uid(), 'spell_cast',
      case when p_adventure then jsonb_build_object('adventure_face', true) else null end);

    -- Cascade (mig 423): covers instants/sorceries, and gives recursion when a
    -- cascaded spell itself has cascade.
    perform public.enqueue_cast_triggers(p_session_id, p_source_card_id, auth.uid());

    -- "Whenever you cast a spell from exile" (mig 307, Urianger Augurelt).
    if v_source_zone = 'exile' then
      perform public.fire_watcher_triggers(p_session_id, p_source_card_id, auth.uid(), 'cast_from_exile',
        case when p_adventure then jsonb_build_object('adventure_face', true) else null end);
    end if;
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

  -- Non-permanent spell leaves its cast zone on cast: a hand OR exile cast goes
  -- to the graveyard; a flashback cast (from the graveyard) is exiled instead.
  elsif v_is_flashback then
    select coalesce(max(zone_position), -1) + 1 into v_next_exile
    from public.game_cards
    where session_id = p_session_id and owner_id = auth.uid() and zone = 'exile';

    update public.game_cards
    set zone = 'exile', zone_position = v_next_exile, controller_player_id = owner_id,
        is_tapped = false, damage_marked = 0
    where id = p_source_card_id;

  elsif p_source_card_id is not null
    and v_source_zone in ('hand', 'exile')
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
grant execute on function public.cast_spell_effect(uuid, jsonb, uuid, integer, uuid, boolean, boolean, boolean) to authenticated;

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
  v_lore integer;
  v_saga jsonb;
  v_chapter jsonb;
  v_saga_max integer;
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
            perform public.fire_lifegain_triggers(p_session_id, v_rid, v_eff_amount);
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
      -- recipient mirrors the mill branch below: controller (default) /
      -- each_player / each_opponent. Previously ignored — every draw landed on
      -- the controller (bug-2684: Cut a Deal drew for the CASTER instead of
      -- each opponent).
      if v_recipient = 'controller' or v_recipient = '' then
        v_recipients := array[p_controller_id];
      elsif v_recipient in ('each_player', 'all_players') then
        select array_agg(player_id) into v_recipients
        from public.game_session_players where session_id = p_session_id;
      elsif v_recipient = 'active_player' then
        -- The TURN player draws (mig 396, Kami of the Crescent Moon on the
        -- broadcast each-draw-step event: "each player draws an additional
        -- card" = whoever's draw step is happening).
        select array[active_player_id] into v_recipients
        from public.game_turn_state where session_id = p_session_id;
      else
        select array_agg(player_id) into v_recipients
        from public.game_session_players
        where session_id = p_session_id and player_id is distinct from p_controller_id;
      end if;
      foreach v_rid in array coalesce(v_recipients, array[]::uuid[]) loop
        if v_rid is null then continue; end if;
        -- "draw a card" (no amount key) defaults to 1; an explicit amount draws
        -- exactly that many — incl. a dynamic count that resolves to 0 ("draw a
        -- card for each X" with X=0 draws nothing). 1..0 runs zero iterations.
        for v_draw_i in 1..(case when v_effect ? 'amount' then v_eff_amount else 1 end) loop
          select coalesce(max(zone_position), -1) + 1 into v_next_hand_position
          from public.game_cards
          where session_id = p_session_id and owner_id = v_rid and zone = 'hand';
          select id into v_lib_card
          from public.game_cards
          where session_id = p_session_id and owner_id = v_rid and zone = 'library'
          order by zone_position asc, id asc limit 1 for update skip locked;
          exit when v_lib_card is null;
          update public.game_cards
          set zone = 'hand', zone_position = v_next_hand_position, is_tapped = false
          where id = v_lib_card;
          -- card_drawn watcher (mig 401): every card drawn by the effect
          -- broadcasts with its 1-based per-turn index.
          perform public.fire_watcher_triggers(
            p_session_id, v_lib_card, v_rid, 'card_drawn',
            jsonb_build_object('draw_number', public.note_card_drawn(p_session_id, v_rid)));
        end loop;
      end loop;

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
      elsif (v_effect ->> 'count') = 'X' then
        -- "create X tokens" (mig 300, Champions from Beyond): X was stamped on
        -- the source permanent's counter bag at cast (cast_card_from_hand).
        select coalesce((counters ->> 'x')::integer, 0) into v_token_count
        from public.game_cards where id = p_source_card_id and session_id = p_session_id;
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
          -- set_pt (mig 260, Quartzwood Crasher: "an X/X token where X is the
          -- damage dealt"): an unexpiring set_pt row pins the token's base P/T
          -- (the manifest 2/2 pattern). 'event_amount' was already rewritten to
          -- a number by apply_trigger_effects; ignore anything non-numeric.
          if jsonb_typeof(v_effect -> 'set_pt') = 'number' then
            insert into public.game_continuous_effects (
              session_id, source_card_id, affected_card_id, effect_type, payload, source_zone_required
            ) values (
              p_session_id, v_new_token_id, v_new_token_id, 'set_pt',
              jsonb_build_object('power', (v_effect ->> 'set_pt')::integer,
                                 'toughness', (v_effect ->> 'set_pt')::integer),
              'battlefield'
            );
          end if;
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
            -- exclude_type (mig 268, Whipflare: "each NONARTIFACT creature").
            and (nullif(v_effect -> 'filter' ->> 'exclude_type', '') is null
                 or c.type_line not ilike '%' || (v_effect -> 'filter' ->> 'exclude_type') || '%')
            -- filter.controller (mig 395, Thundermaw Hellkite: "each creature
            -- with flying your OPPONENTS control"): 'you' / 'opponent',
            -- relative to the effect's controller. Absent = any controller.
            and (nullif(v_effect -> 'filter' ->> 'controller', '') is null
                 or (lower(v_effect -> 'filter' ->> 'controller') = 'you'
                     and coalesce(gc.controller_player_id, gc.owner_id) = p_controller_id)
                 or (lower(v_effect -> 'filter' ->> 'controller') = 'opponent'
                     and coalesce(gc.controller_player_id, gc.owner_id) is distinct from p_controller_id))
        loop
          perform public.apply_damage_to_creature(
            p_session_id, v_dmg_target, v_eff_amount, p_source_card_id, false, false, false);
          -- tap_damaged (mig 395, Thundermaw: "…Tap those creatures.")
          if coalesce((v_effect ->> 'tap_damaged')::boolean, false) then
            update public.game_cards set is_tapped = true
            where id = v_dmg_target and session_id = p_session_id;
          end if;
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
        if nullif(v_effect ->> 'min_power', '') is not null then
          -- 'Destroy all creatures with power greater than …' (mig 281,
          -- Fell the Mighty — the target-relative bound is approximated as a
          -- fixed threshold). Indestructible survives.
          for v_dmg_target in
            select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
            where gc.session_id = p_session_id and gc.zone = 'battlefield'
              and c.type_line ilike '%creature%'
              and coalesce(public.card_effective_power(p_session_id, gc.id), 0)
                  >= (v_effect ->> 'min_power')::integer
              and not public.card_has_indestructible(p_session_id, gc.id)
          loop
            perform public.put_in_graveyard(p_session_id, v_dmg_target);
          end loop;
        elsif jsonb_typeof(v_effect -> 'types') = 'array' then
          -- "Destroy all artifacts, creatures, and enchantments" (mig 268,
          -- Nevinyrral's Disk). Any-type match; indestructible survives.
          -- mig 395: the types branch honors `scope` like the creature branch
          -- (Ruinous Ultimatum: 'destroy all nonland permanents your OPPONENTS
          -- control' — scope 'opponent'); default 'all' keeps Disk behavior.
          for v_dmg_target in
            select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
            where gc.session_id = p_session_id and gc.zone = 'battlefield'
              and exists (select 1 from jsonb_array_elements_text(v_effect -> 'types') t
                          where c.type_line ilike '%' || t.value || '%')
              and (lower(coalesce(v_effect ->> 'scope', 'all')) = 'all'
                   or (lower(v_effect ->> 'scope') = 'you'
                       and coalesce(gc.controller_player_id, gc.owner_id) = p_controller_id)
                   or (lower(v_effect ->> 'scope') = 'opponent'
                       and coalesce(gc.controller_player_id, gc.owner_id) is distinct from p_controller_id))
              and not public.card_has_indestructible(p_session_id, gc.id)
          loop
            perform public.put_in_graveyard(p_session_id, v_dmg_target);
          end loop;
        elsif nullif(v_effect ->> 'exclude_type', '') is not null then
          -- "Destroy all non-<type> creatures" (mig 256, Wakening Sun's
          -- Avatar). Indestructible survives, mirroring destroy_all_creatures.
          for v_dmg_target in
            select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
            where gc.session_id = p_session_id and gc.zone = 'battlefield'
              and c.type_line ilike '%creature%'
              and c.type_line not ilike '%' || (v_effect ->> 'exclude_type') || '%'
              and not public.card_has_indestructible(p_session_id, gc.id)
          loop
            perform public.put_in_graveyard(p_session_id, v_dmg_target);
          end loop;
        else
          perform public.destroy_all_creatures(
            p_session_id, p_controller_id,
            nullif(v_effect ->> 'creature_type', ''),
            lower(coalesce(v_effect ->> 'scope', 'all')));
        end if;
      end if;

    elsif v_eff_type = 'return_all_from_graveyard' then
      if p_controller_id is not null then
        -- from:'all_graveyards' (mig 214, Grimoire of the Dead) sweeps EVERY
        -- graveyard and puts the cards under the controller's control.
        perform public.return_all_from_graveyard(
          p_session_id, p_controller_id,
          nullif(v_effect ->> 'creature_type', ''),
          lower(coalesce(v_effect ->> 'to', 'battlefield')),
          lower(coalesce(v_effect ->> 'from', '')) = 'all_graveyards',
          -- types + under:'owner' (mig 269, Open the Vaults).
          v_effect -> 'types',
          lower(coalesce(v_effect ->> 'under', '')) = 'owner');
      end if;

    elsif v_eff_type = 'gain_control_all' then
      -- Hellkite Tyrant (mig 269): "gain control of all artifacts that player
      -- controls" on connecting. Permanent steal of every matching opposing
      -- permanent (1v1: the damaged player IS the only opponent).
      if p_controller_id is not null then
        update public.game_cards gc
        set controller_player_id = p_controller_id
        from public.cards c
        where c.id = gc.card_id and gc.session_id = p_session_id and gc.zone = 'battlefield'
          and coalesce(gc.controller_player_id, gc.owner_id) is distinct from p_controller_id
          and c.type_line ilike '%' || coalesce(v_effect ->> 'type_line', '') || '%';
        perform public.rebuild_scripted_continuous_effects(p_session_id);
      end if;

    elsif v_eff_type = 'bounce_all' then
      -- Coastal Breach (mig 269): "return each nonland permanent to its
      -- owner's hand." Tokens cease via the usual cleanup trigger.
      -- scope 'opponent' (mig 428, Cyclonic Rift overload): only permanents the
      -- controller does NOT control; default 'all' keeps Coastal Breach behavior.
      update public.game_cards gc
      set zone = 'hand', is_tapped = false, damage_marked = 0, plus_one_counters = 0,
          attached_to = null, controller_player_id = gc.owner_id,
          zone_position = (select coalesce(max(x.zone_position), -1) + 1
                           from public.game_cards x
                           where x.session_id = p_session_id
                             and x.owner_id = gc.owner_id and x.zone = 'hand')
      from public.cards c
      where c.id = gc.card_id and gc.session_id = p_session_id and gc.zone = 'battlefield'
        and (not coalesce((v_effect ->> 'nonland')::boolean, true)
             or c.type_line not ilike '%land%')
        and (lower(coalesce(v_effect ->> 'scope', 'all')) <> 'opponent'
             or coalesce(gc.controller_player_id, gc.owner_id) is distinct from p_controller_id);

    elsif v_eff_type = 'destroy_all_creatures_token' then
      -- Phyrexian Rebirth (mig 269): "destroy all creatures, then create an
      -- X/X Horror where X is the number destroyed." Indestructible survives
      -- and does not count.
      if p_controller_id is not null then
        v_token_count := 0;
        for v_dmg_target in
          select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
          where gc.session_id = p_session_id and gc.zone = 'battlefield'
            and c.type_line ilike '%creature%'
            and not public.card_has_indestructible(p_session_id, gc.id)
        loop
          perform public.put_in_graveyard(p_session_id, v_dmg_target);
          v_token_count := v_token_count + 1;
        end loop;
        if v_token_count > 0 then
          -- gain_per_destroyed (mig 272, Fumigate: 1 life per victim) replaces
          -- the X/X token payoff when token is absent.
          if (v_effect ->> 'gain_per_destroyed') is not null then
            update public.game_session_players
            set life_total = life_total + v_token_count * (v_effect ->> 'gain_per_destroyed')::integer
            where session_id = p_session_id and player_id = p_controller_id;
            perform public.fire_lifegain_triggers(p_session_id, p_controller_id,
              v_token_count * (v_effect ->> 'gain_per_destroyed')::integer);
          else
            perform public.apply_triggered_ability_effects(
              p_session_id, p_controller_id, p_source_card_id,
              jsonb_build_array(jsonb_build_object(
                'type', 'create_token',
                'token', coalesce(v_effect ->> 'token', 'Horror Token'),
                'count', 1, 'set_pt', v_token_count)));
          end if;
        end if;
      end if;

    elsif v_eff_type = 'destroy_all_mv' then
      -- Culling Ritual (mig 272): "destroy each nonland permanent with mana
      -- value 2 or less. Add {B} or {G} for each permanent destroyed."
      -- Approximation: the ritual mana is a single fixed colour
      -- (mana_per_destroyed). Indestructible survives.
      if p_controller_id is not null then
        v_token_count := 0;
        for v_dmg_target in
          select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
          where gc.session_id = p_session_id and gc.zone = 'battlefield'
            and c.type_line not ilike '%land%'
            and public.mana_value(c.mana_cost) <= coalesce((v_effect ->> 'max_mana_value')::integer, 2)
            and not public.card_has_indestructible(p_session_id, gc.id)
        loop
          perform public.put_in_graveyard(p_session_id, v_dmg_target);
          v_token_count := v_token_count + 1;
        end loop;
        if v_token_count > 0 and upper(coalesce(v_effect ->> 'mana_per_destroyed', '')) in ('W','U','B','R','G','C') then
          perform public.apply_triggered_ability_effects(
            p_session_id, p_controller_id, p_source_card_id,
            jsonb_build_array(jsonb_build_object(
              'type', 'add_mana', 'color', upper(v_effect ->> 'mana_per_destroyed'),
              'amount', v_token_count)));
        end if;
      end if;

    elsif v_eff_type = 'exile_all' then
      -- Merciless Eviction (mig 275): "exile all <type>" — exile skips
      -- destruction triggers and ignores indestructible.
      if jsonb_typeof(v_effect -> 'types') = 'array' then
        update public.game_cards gc
        set zone = 'exile',
            attached_to = null,
            zone_position = (select coalesce(max(x.zone_position), -1) + 1
                             from public.game_cards x
                             where x.session_id = p_session_id
                               and x.owner_id = gc.owner_id and x.zone = 'exile')
        from public.cards c
        where c.id = gc.card_id and gc.session_id = p_session_id and gc.zone = 'battlefield'
          and exists (select 1 from jsonb_array_elements_text(v_effect -> 'types') t
                      where c.type_line ilike '%' || t.value || '%');
      end if;

    elsif v_eff_type = 'add_poison' then
      -- "…gets N poison counters" (mig 272, Caress of Phyrexia). Recipient
      -- 'each_opponent' (default) or 'controller'.
      if p_controller_id is not null then
        if lower(coalesce(v_effect ->> 'recipient', 'each_opponent')) = 'controller' then
          perform public.add_player_poison(p_session_id, p_controller_id,
            greatest(1, coalesce((v_effect ->> 'amount')::integer, 1)));
        else
          perform public.add_player_poison(p_session_id, sp.player_id,
            greatest(1, coalesce((v_effect ->> 'amount')::integer, 1)))
          from public.game_session_players sp
          where sp.session_id = p_session_id and sp.player_id is distinct from p_controller_id;
        end if;
        perform public.maybe_finish_game_session(p_session_id);
      end if;

    elsif v_eff_type = 'exile_graveyard' then
      -- Bojuka Bog (mig 272): "exile target player's graveyard."
      -- Approximation: the opponent's graveyard (1v1: the only choice that
      -- matters).
      update public.game_cards gc
      set zone = 'exile',
          zone_position = (select coalesce(max(x.zone_position), -1) + 1
                           from public.game_cards x
                           where x.session_id = p_session_id
                             and x.owner_id = gc.owner_id and x.zone = 'exile')
      where gc.session_id = p_session_id and gc.zone = 'graveyard'
        and gc.owner_id is distinct from p_controller_id;

    elsif v_eff_type = 'ixhel_corrupted_exile' then
      -- Ixhel (mig 272): "each opponent who has three or more poison counters
      -- exiles the top card of their library; you may play those cards."
      -- The permission reuses the impulse play_from_exile row, so the window
      -- is until the end of YOUR next turn (approximation — the real card's
      -- window is unlimited); any-colour spending is not modelled.
      if p_controller_id is not null then
        select turn_number into v_turn_number
        from public.game_turn_state where session_id = p_session_id;
        v_exiled := array[]::uuid[];
        for v_dmg_target in
          select gc.id
          from public.game_session_players sp
          join lateral (
            select id from public.game_cards
            where session_id = p_session_id and owner_id = sp.player_id and zone = 'library'
            order by zone_position asc, id asc limit 1
          ) gc on true
          where sp.session_id = p_session_id
            and sp.player_id is distinct from p_controller_id
            and coalesce((sp.counters ->> 'poison')::integer, 0) >= 3
        loop
          update public.game_cards gc
          set zone = 'exile',
              zone_position = (select coalesce(max(x.zone_position), -1) + 1
                               from public.game_cards x
                               where x.session_id = p_session_id
                                 and x.owner_id = gc.owner_id and x.zone = 'exile')
          where gc.id = v_dmg_target;
          v_exiled := v_exiled || v_dmg_target;
        end loop;
        if array_length(v_exiled, 1) > 0 then
          insert into public.game_continuous_effects (
            session_id, source_card_id, affected_player_id, effect_type, payload
          ) values (
            p_session_id, p_source_card_id, p_controller_id, 'play_from_exile',
            jsonb_build_object('card_ids', to_jsonb(v_exiled),
                               'created_turn', coalesce(v_turn_number, 0))
          );
        end if;
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
            -- "each OTHER creature you control" (mig 256, Bellowing Aegisaur).
            and (not coalesce((v_effect ->> 'exclude_source')::boolean, false)
                 or gc.id is distinct from p_source_card_id)
            -- Optional type filter (mig 299, Ardbert: "each LEGENDARY creature").
            and (nullif(v_effect ->> 'type_line', '') is null
                 or c.type_line ilike '%' || (v_effect ->> 'type_line') || '%')
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
            and (nullif(v_effect ->> 'type_line', '') is null
                 or c.type_line ilike '%' || (v_effect ->> 'type_line') || '%')
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
        -- card_type (mig 258, Zacama: "untap all lands you control") widens the
        -- default creature scope to any type-line match.
        update public.game_cards gc
        set is_tapped = (v_eff_type = 'tap_all')
        from public.cards c
        where c.id = gc.card_id and gc.session_id = p_session_id and gc.zone = 'battlefield'
          and c.type_line ilike '%' || coalesce(v_effect ->> 'card_type', 'creature') || '%'
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
        'indestructible', 'first_strike', 'double_strike', 'menace', 'lifelink',
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

    elsif v_eff_type = 'tap_self' then
      -- Tap the source permanent (Immersturm Predator: "Tap it" after its
      -- sacrifice ability). The AFTER-UPDATE is_tapped trigger (fire_tap_triggers)
      -- fires the becomes_tapped event from here just like a mana/attack tap.
      if p_source_card_id is not null then
        update public.game_cards
        set is_tapped = true
        where id = p_source_card_id and session_id = p_session_id and zone = 'battlefield';
      end if;

    elsif v_eff_type = 'donate_self' then
      -- Xantcha (mig 361): "enters under the control of an opponent of your choice"
      -- — hand the source to an opponent of its current controller (1v1: the only
      -- one). APPROX: "of your choice" is the first opponent in seat order.
      if p_source_card_id is not null then
        update public.game_cards
        set controller_player_id = (
          select sp.player_id from public.game_session_players sp
          where sp.session_id = p_session_id and sp.player_id is distinct from p_controller_id
          order by sp.seat_number limit 1)
        where id = p_source_card_id and session_id = p_session_id and zone = 'battlefield'
          and exists (select 1 from public.game_session_players sp
                      where sp.session_id = p_session_id and sp.player_id is distinct from p_controller_id);
        perform public.rebuild_scripted_continuous_effects(p_session_id);
      end if;

    elsif v_eff_type = 'copy_self' then
      -- Create `count` token copies of the SOURCE under the controller, with the
      -- given `except` overrides (Saw in Half, mig 356: two half-size copies of
      -- the creature as it dies). Works from the graveyard (copy reads card_id).
      if p_source_card_id is not null and p_controller_id is not null then
        perform public.create_copy_token(p_session_id, p_controller_id, p_source_card_id, v_effect -> 'except')
        from generate_series(1, greatest(1, coalesce((v_effect ->> 'count')::integer, 1)));
      end if;

    elsif v_eff_type = 'return_self_to_battlefield' then
      -- Return the SOURCE card from the graveyard to the battlefield under its
      -- owner's control (Feign Death / Supernatural Stamina / Not Dead After All,
      -- mig 345, via a granted dies-trigger). Optionally tapped / with a +1/+1
      -- counter. Only acts on a card currently in a graveyard.
      if p_source_card_id is not null then
        update public.game_cards gc
        set zone = 'battlefield',
            zone_position = (select coalesce(max(x.zone_position), -1) + 1 from public.game_cards x
                             where x.session_id = p_session_id and x.owner_id = gc.owner_id and x.zone = 'battlefield'),
            controller_player_id = gc.owner_id,
            is_tapped = coalesce((v_effect ->> 'tapped')::boolean, false),
            damage_marked = 0,
            plus_one_counters = coalesce((v_effect ->> 'plus_one_counters')::integer, 0),
            entered_battlefield_turn_number = (select turn_number from public.game_turn_state where session_id = p_session_id)
        where gc.id = p_source_card_id and gc.session_id = p_session_id and gc.zone = 'graveyard';
        perform public.rebuild_scripted_continuous_effects(p_session_id);
        perform public.recheck_counter_state(p_session_id);
      end if;

    elsif v_eff_type = 'set_pt' then
      -- Untargeted set base P/T → the source (Nogi: "becomes 5/5 until EOT").
      if p_source_card_id is not null then
        perform public.apply_creature_effect(p_session_id, 'set_pt', p_source_card_id, v_effect);
      end if;

    elsif v_eff_type = 'sacrifice_source' then
      -- 'Sacrifice this enchantment' as a trigger rider (mig 281, Promise of
      -- Bunrei: one payout, then the source goes to the graveyard).
      if p_source_card_id is not null then
        perform public.put_in_graveyard(p_session_id, p_source_card_id);
      end if;

    elsif v_eff_type = 'shuffle_self_into_library' then
      -- Omen back-faces (mig 289, Flush Out / Dynamic Soar): 'then shuffle
      -- this card into its owner's library.' The source moves from wherever
      -- it is (hand, for omen casts) into the library, then the owner's
      -- whole library is re-randomized.
      if p_source_card_id is not null then
        update public.game_cards
        set zone = 'library', is_tapped = false, damage_marked = 0, plus_one_counters = 0
        where id = p_source_card_id and session_id = p_session_id;
        update public.game_cards g set zone_position = s.rn
        from (select gc.id, (row_number() over (order by random(), gc.id) - 1) as rn
              from public.game_cards gc
              where gc.session_id = p_session_id and gc.zone = 'library'
                and gc.owner_id = (select owner_id from public.game_cards where id = p_source_card_id)) s
        where g.id = s.id;
      end if;

    elsif v_eff_type = 'become_monarch' then
      -- "You become the monarch" (mig 262, Regal Behemoth). The crown lives
      -- on game_turn_state; combat damage steals it (resolve_combat_damage)
      -- and the monarch draws at their end step (advance_step).
      if p_controller_id is not null then
        update public.game_turn_state
        set monarch_player_id = p_controller_id
        where session_id = p_session_id;
      end if;

    elsif v_eff_type = 'pump' then
      -- Untargeted self-pump (mig 258, Rampaging Brontodon: "whenever this
      -- attacks, it gets +1/+1 for each land you control"). Dynamic counts
      -- ({count:'lands_you_control'}) resolve against the ability's controller.
      if p_source_card_id is not null then
        perform public.apply_creature_effect(
          p_session_id, 'pump', p_source_card_id,
          v_effect || jsonb_build_object('acting_controller', p_controller_id));
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

    elsif v_eff_type = 'advance_saga' then
      -- Saga (mig 305): add a lore counter, fire the chapter whose number now
      -- matches, and sacrifice once the final (highest) chapter is reached.
      -- Driven by enters_the_battlefield (lore 1) + draw_step (lore +1) triggers.
      if p_source_card_id is not null then
        update public.game_cards
        set counters = coalesce(counters, '{}'::jsonb)
              || jsonb_build_object('lore', coalesce((counters ->> 'lore')::integer, 0) + 1)
        where id = p_source_card_id and session_id = p_session_id
        returning (counters ->> 'lore')::integer into v_lore;

        v_saga := public.effective_script(p_session_id, p_source_card_id) -> 'saga_chapters';
        if jsonb_typeof(v_saga) = 'array' then
          -- Apply every chapter entry whose `chapter` list contains the new lore.
          for v_chapter in select * from jsonb_array_elements(v_saga)
          loop
            if exists (select 1 from jsonb_array_elements_text(v_chapter -> 'chapter') ch
                       where ch.value::integer = v_lore) then
              perform public.apply_triggered_ability_effects(
                p_session_id, p_controller_id, p_source_card_id,
                coalesce(v_chapter -> 'effects', '[]'::jsonb));
            end if;
          end loop;

          -- Final chapter = the highest number across all entries → sacrifice.
          select max(n) into v_saga_max
          from jsonb_array_elements(v_saga) e,
               jsonb_array_elements_text(e -> 'chapter') ch,
               lateral (select ch.value::integer as n) t;
          if v_lore >= coalesce(v_saga_max, 0) then
            perform public.put_in_graveyard(p_session_id, p_source_card_id);
          end if;
        end if;
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
