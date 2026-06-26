-- supabase/functions_src/activate_ability.sql
-- CANONICAL current definition (seeded from 202605010202_grant_keyword_all.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

create or replace function public.activate_ability(
  p_session_id uuid,
  p_source_card_id uuid,
  p_ability_index integer default 0,
  p_target_player_id uuid default null,
  p_target_card_id uuid default null,
  p_generic_payment jsonb default null,
  p_x_value integer default null,
  -- Chosen cost payments (mig 284): for pick-able costs (sacrifice_artifacts,
  -- return_land, tap_creatures) the client passes the exact cards to pay
  -- with, in cost order. Null = the engine auto-picks (legacy behaviour).
  p_cost_card_ids uuid[] default null
) returns public.game_stack_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn public.game_turn_state;
  v_zone text;
  v_script jsonb;
  v_ability jsonb;
  v_cost jsonb;
  v_effect jsonb;
  v_eff_type text;
  v_target_controller text;
  v_has_tap boolean := false;
  v_has_sac boolean := false;
  v_has_sac_creature boolean := false;
  v_has_gy_exile boolean := false;
  v_gy_filter text;
  v_tap_creatures_count integer := 0;
  v_tap_creatures_type text;
  v_discard_cost integer := 0;
  v_sac_artifacts_count integer := 0;
  v_sac_artifacts_nontoken boolean := false;
  v_sac_artifact uuid;
  v_return_land_count integer := 0;
  v_cost_pick_i integer := 0;
  v_i integer;
  v_remove_counter_type text;
  v_remove_counter_amount integer := 0;
  v_bag_count integer;
  v_mana_cost text := null;
  v_source_type_line text;
  v_source_is_commander boolean := false;
  v_energy_cost integer := 0;
  v_player_energy integer;
  v_amount integer;
  v_next_position integer;
  v_stack public.game_stack_items;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select *
  into v_turn
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if coalesce(v_turn.priority_player_id, v_turn.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can activate abilities';
  end if;

  select game_cards.zone
  into v_zone
  from public.game_cards
  where game_cards.id = p_source_card_id
    and game_cards.session_id = p_session_id
    and game_cards.owner_id = auth.uid();

  if not found then
    raise exception 'Source card not found or not owned by current user';
  end if;

  -- Restricted-mana pay context (Haven: "activate abilities of Dragon sources";
  -- Relic of Legends: "an ability of a commander").
  select c.type_line, coalesce(gc.is_commander, false)
  into v_source_type_line, v_source_is_commander
  from public.game_cards gc join public.cards c on c.id = gc.card_id
  where gc.id = p_source_card_id and gc.session_id = p_session_id;

  v_script := public.effective_script(p_session_id, p_source_card_id);
  v_ability := v_script -> 'activated_abilities' -> p_ability_index;

  -- Zone gate (mig 289): battlefield by default, but an ability may declare
  -- its own source zone (omen back-faces cast from HAND: Flush Out /
  -- Dynamic Soar; the adventure pattern generally).
  if v_zone <> coalesce(v_ability ->> 'source_zone_required', 'battlefield') then
    raise exception 'Ability source must be in its required zone (%)',
      coalesce(v_ability ->> 'source_zone_required', 'battlefield');
  end if;

  if v_ability is null then
    raise exception 'Activated ability not found at index %', p_ability_index;
  end if;

  if coalesce((v_ability ->> 'is_mana_ability')::boolean, false) then
    raise exception 'Use the mana ability flow for mana abilities';
  end if;

  -- Activation condition (mig 233, Skarrgan Hellkite: "Activate only if this
  -- creature has a +1/+1 counter on it"). A {counters, of, at_least} spec read
  -- via resolve_dynamic_amount before any cost is paid.
  if v_ability -> 'condition' is not null then
    if public.resolve_dynamic_amount(p_session_id, p_source_card_id, auth.uid(), v_ability -> 'condition')
       < coalesce((v_ability -> 'condition' ->> 'at_least')::integer, 1)
    then
      raise exception 'This ability cannot be activated right now';
    end if;
  end if;

  -- Parse costs
  for v_cost in select * from jsonb_array_elements(coalesce(v_ability -> 'costs', '[]'::jsonb))
  loop
    case v_cost ->> 'type'
      when 'tap_self' then v_has_tap := true;
      when 'sacrifice_self' then v_has_sac := true;
      when 'sacrifice_creature' then v_has_sac_creature := true;
      when 'exile_from_graveyard' then
        v_has_gy_exile := true;
        v_gy_filter := lower(coalesce(v_cost ->> 'type_line', 'creature'));
      when 'mana' then v_mana_cost := v_cost ->> 'amount';
      when 'energy' then v_energy_cost := greatest(0, coalesce((v_cost ->> 'amount')::integer, 0));
      -- "Tap five untapped Zombies you control" (mig 212, Gravespawn Sovereign).
      -- The engine auto-picks the N untapped matching creatures (incl. the
      -- source); a client-chosen set is a future refinement.
      when 'tap_creatures' then
        v_tap_creatures_count := greatest(1, coalesce((v_cost ->> 'count')::integer, 1));
        v_tap_creatures_type := lower(coalesce(v_cost ->> 'type_line', 'creature'));
      -- "Discard a card" as a cost (mig 214, Grimoire of the Dead): the chosen
      -- hand card rides p_target_card_id (these abilities' effect is untargeted,
      -- like the exile_from_graveyard cost).
      when 'discard' then v_discard_cost := greatest(1, coalesce((v_cost ->> 'amount')::integer, 1));
      -- "Sacrifice N artifacts" (mig 264, Breya / Thopter Foundry). The engine
      -- auto-picks the N cheapest-MV artifacts you control other than the
      -- source (tokens are MV 0, so they go first — matching real play);
      -- nontoken:true restricts to nontoken artifacts. A client-chosen set is
      -- a future refinement.
      when 'sacrifice_artifacts' then
        v_sac_artifacts_count := greatest(1, coalesce((v_cost ->> 'count')::integer, 1));
        v_sac_artifacts_nontoken := coalesce((v_cost ->> 'nontoken')::boolean, false);
      -- 'Return a land you control to its owner's hand' as a cost (mig 277,
      -- Mina and Denn). Auto-picks: tapped lands first.
      when 'return_land' then
        v_return_land_count := greatest(1, coalesce((v_cost ->> 'count')::integer, 1));
      -- "Remove three study counters from ~" as a cost (mig 214).
      when 'remove_counters' then
        v_remove_counter_type := lower(coalesce(v_cost ->> 'counter_type', 'study'));
        v_remove_counter_amount := greatest(1, coalesce((v_cost ->> 'amount')::integer, 1));
      else raise exception 'Unsupported ability cost: %', v_cost ->> 'type';
    end case;
  end loop;

  -- {X} in the activation cost (mig 242, Kessig Wolf Run): the activator
  -- chooses X (p_x_value); it is paid as that much generic mana and every
  -- literal 'X' power/toughness/amount in the effects becomes the chosen
  -- value before the effects are put on the stack.
  if v_mana_cost is not null and position('{X}' in v_mana_cost) > 0 then
    if coalesce(p_x_value, -1) < 0 then
      raise exception 'This ability requires a chosen X';
    end if;
    v_mana_cost := replace(v_mana_cost, '{X}', '{' || p_x_value::text || '}');
    select jsonb_set(v_ability, '{effects}', coalesce(jsonb_agg(
      e.value
      || case when e.value ->> 'power' = 'X' then jsonb_build_object('power', p_x_value) else '{}'::jsonb end
      || case when e.value ->> 'toughness' = 'X' then jsonb_build_object('toughness', p_x_value) else '{}'::jsonb end
      || case when e.value ->> 'amount' = 'X' then jsonb_build_object('amount', p_x_value) else '{}'::jsonb end
    ), '[]'::jsonb))
    into v_ability
    from jsonb_array_elements(coalesce(v_ability -> 'effects', '[]'::jsonb)) e;
  end if;

  if v_has_tap and exists (
    select 1 from public.game_cards where id = p_source_card_id and is_tapped = true
  ) then
    raise exception 'Source is already tapped';
  end if;

  -- Energy: the activating player must have enough in their pool.
  if v_energy_cost > 0 then
    select coalesce((counters ->> 'energy')::integer, 0)
    into v_player_energy
    from public.game_session_players
    where session_id = p_session_id and player_id = auth.uid();

    if coalesce(v_player_energy, 0) < v_energy_cost then
      raise exception 'Not enough energy: need % (have %)', v_energy_cost, coalesce(v_player_energy, 0);
    end if;
  end if;

  -- Graveyard-exile cost: validate the chosen card BEFORE paying anything (it is
  -- passed as p_target_card_id; the effect of such abilities is untargeted).
  if v_has_gy_exile then
    if p_target_card_id is null then
      raise exception 'Choose a card in a graveyard to exile for this ability';
    end if;
    if not exists (
      select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.id = p_target_card_id and gc.session_id = p_session_id and gc.zone = 'graveyard'
        and (v_gy_filter = '' or c.type_line ilike '%' || v_gy_filter || '%')
    ) then
      raise exception 'That card is not a matching card in a graveyard';
    end if;
  end if;

  -- Sacrifice-a-creature cost: validate the chosen creature you control (passed as
  -- p_target_card_id; the effect is untargeted).
  if v_has_sac_creature then
    if p_target_card_id is null then
      raise exception 'Choose a creature to sacrifice for this ability';
    end if;
    if not exists (
      select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.id = p_target_card_id and gc.session_id = p_session_id and gc.zone = 'battlefield'
        and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
        and c.type_line ilike '%creature%'
    ) then
      raise exception 'You must sacrifice a creature you control';
    end if;
  end if;

  -- Discard cost: the chosen hand card rides p_target_card_id (untargeted-effect
  -- abilities only, like the graveyard-exile cost). Single-card discard only.
  if v_discard_cost > 0 then
    if v_discard_cost > 1 then
      raise exception 'Multi-card discard costs are not supported yet';
    end if;
    if p_target_card_id is null then
      raise exception 'Choose a card in your hand to discard for this ability';
    end if;
    if not exists (
      select 1 from public.game_cards
      where id = p_target_card_id and session_id = p_session_id
        and zone = 'hand' and owner_id = auth.uid()
    ) then
      raise exception 'You must discard a card from your own hand';
    end if;
    update public.game_cards gc
    set zone = 'graveyard', is_tapped = false,
        zone_position = (select coalesce(max(zone_position), -1) + 1
                         from public.game_cards x
                         where x.session_id = p_session_id and x.owner_id = gc.owner_id and x.zone = 'graveyard')
    where gc.id = p_target_card_id and gc.session_id = p_session_id;
    -- The cost consumed the target slot; the effect is untargeted.
    p_target_card_id := null;
  end if;

  -- Remove-counters cost (mig 214): the SOURCE must carry enough bag counters.
  if v_remove_counter_amount > 0 then
    select coalesce((counters ->> v_remove_counter_type)::integer, 0)
    into v_bag_count
    from public.game_cards
    where id = p_source_card_id and session_id = p_session_id;
    if coalesce(v_bag_count, 0) < v_remove_counter_amount then
      raise exception 'Not enough % counters: need % (have %)', v_remove_counter_type, v_remove_counter_amount, coalesce(v_bag_count, 0);
    end if;
    update public.game_cards
    set counters = public.adjust_counter_bag(counters, v_remove_counter_type, -v_remove_counter_amount)
    where id = p_source_card_id and session_id = p_session_id;
  end if;

  -- Tap-creatures cost: validate there are enough untapped matching creatures,
  -- then tap the first N (zone-position order).
  if v_tap_creatures_count > 0 then
    if (select count(*) from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.session_id = p_session_id and gc.zone = 'battlefield' and gc.is_tapped = false
          and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
          and c.type_line ilike '%creature%'
          and c.type_line ilike '%' || v_tap_creatures_type || '%') < v_tap_creatures_count
    then
      raise exception 'You need % untapped % creatures to activate this', v_tap_creatures_count, v_tap_creatures_type;
    end if;
    if p_cost_card_ids is not null then
      -- Chosen payment (mig 284): tap exactly the provided creatures.
      for v_i in 1..v_tap_creatures_count loop
        v_cost_pick_i := v_cost_pick_i + 1;
        v_sac_artifact := p_cost_card_ids[v_cost_pick_i];
        if v_sac_artifact is null or not exists (
          select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
          where gc.id = v_sac_artifact and gc.session_id = p_session_id
            and gc.zone = 'battlefield' and gc.is_tapped = false
            and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
            and c.type_line ilike '%creature%'
            and c.type_line ilike '%' || v_tap_creatures_type || '%'
        ) then
          raise exception 'Chosen cost card is not a legal creature to tap';
        end if;
        update public.game_cards set is_tapped = true where id = v_sac_artifact;
      end loop;
    else
    update public.game_cards
    set is_tapped = true
    where id in (
      select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.session_id = p_session_id and gc.zone = 'battlefield' and gc.is_tapped = false
        and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
        and c.type_line ilike '%creature%'
        and c.type_line ilike '%' || v_tap_creatures_type || '%'
      order by gc.zone_position, gc.id
      limit v_tap_creatures_count
    );
    end if;
  end if;

  if v_mana_cost is not null then
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_mana_cost, p_generic_payment,
      p_pay_context := jsonb_build_object(
        'kind', 'ability',
        'type_line', coalesce(v_source_type_line, ''),
        'is_commander', v_source_is_commander));
  end if;

  if v_energy_cost > 0 then
    update public.game_session_players
    set counters = public.adjust_counter_bag(counters, 'energy', -v_energy_cost)
    where session_id = p_session_id and player_id = auth.uid();
  end if;

  if v_has_tap then
    update public.game_cards
    set is_tapped = true
    where id = p_source_card_id and session_id = p_session_id;
  end if;

  -- Sacrifice the source as a cost (after the other costs are paid).
  if v_has_sac then
    perform public.put_in_graveyard(p_session_id, p_source_card_id);
    perform public.fire_watcher_triggers(p_session_id, p_source_card_id, auth.uid(), 'permanent_sacrificed');
  end if;

  -- Pay the graveyard-exile cost: exile the chosen card (controller := owner).
  if v_has_gy_exile then
    update public.game_cards gc
    set zone = 'exile', controller_player_id = gc.owner_id, is_tapped = false, damage_marked = 0,
        zone_position = (select coalesce(max(zone_position), -1) + 1
                         from public.game_cards x
                         where x.session_id = p_session_id and x.owner_id = gc.owner_id and x.zone = 'exile')
    where gc.id = p_target_card_id and gc.session_id = p_session_id;
  end if;

  -- Pay the sacrifice-a-creature cost.
  if v_has_sac_creature then
    perform public.put_in_graveyard(p_session_id, p_target_card_id);
    perform public.fire_watcher_triggers(p_session_id, p_target_card_id, auth.uid(), 'permanent_sacrificed');
  end if;

  -- Pay the sacrifice-N-artifacts cost (mig 264): cheapest MV first, source
  -- excluded; raise when you control too few matching artifacts.
  if v_sac_artifacts_count > 0 then
    for v_i in 1..v_sac_artifacts_count loop
      if p_cost_card_ids is not null then
        -- Chosen payment (mig 284): consume the next provided card; it must
        -- be a legal artifact payment or the activation fails whole.
        v_cost_pick_i := v_cost_pick_i + 1;
        v_sac_artifact := p_cost_card_ids[v_cost_pick_i];
        if v_sac_artifact is null or not exists (
          select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
          where gc.id = v_sac_artifact and gc.session_id = p_session_id
            and gc.zone = 'battlefield'
            and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
            and gc.id <> p_source_card_id
            and c.type_line ilike '%artifact%'
            and (not v_sac_artifacts_nontoken
                 or (not coalesce(c.is_token, false) and not coalesce(gc.is_token, false)))
        ) then
          raise exception 'Chosen cost card is not a legal artifact to sacrifice';
        end if;
      else
      select gc.id into v_sac_artifact
      from public.game_cards gc
      join public.cards c on c.id = gc.card_id
      where gc.session_id = p_session_id and gc.zone = 'battlefield'
        and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
        and gc.id <> p_source_card_id
        and c.type_line ilike '%artifact%'
        and (not v_sac_artifacts_nontoken
             or (not coalesce(c.is_token, false) and not coalesce(gc.is_token, false)))
      order by public.mana_value(c.mana_cost) asc, gc.zone_position asc, gc.id asc
      limit 1;
      end if;
      if v_sac_artifact is null then
        raise exception 'You must sacrifice % artifact(s) you control', v_sac_artifacts_count;
      end if;
      perform public.put_in_graveyard(p_session_id, v_sac_artifact);
      perform public.fire_watcher_triggers(p_session_id, v_sac_artifact, auth.uid(), 'permanent_sacrificed');
    end loop;
  end if;

  -- Pay the return-a-land cost (mig 277, Mina and Denn): tapped lands first.
  if v_return_land_count > 0 then
    for v_i in 1..v_return_land_count loop
      if p_cost_card_ids is not null then
        v_cost_pick_i := v_cost_pick_i + 1;
        v_sac_artifact := p_cost_card_ids[v_cost_pick_i];
        if v_sac_artifact is null or not exists (
          select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
          where gc.id = v_sac_artifact and gc.session_id = p_session_id
            and gc.zone = 'battlefield'
            and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
            and c.type_line ilike '%land%'
        ) then
          raise exception 'Chosen cost card is not a legal land to return';
        end if;
      else
      select gc.id into v_sac_artifact
      from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.session_id = p_session_id and gc.zone = 'battlefield'
        and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
        and c.type_line ilike '%land%'
      order by gc.is_tapped desc, gc.zone_position asc, gc.id asc
      limit 1;
      end if;
      if v_sac_artifact is null then
        raise exception 'You must return % land(s) you control to pay this cost', v_return_land_count;
      end if;
      update public.game_cards gc
      set zone = 'hand', is_tapped = false, attached_to = null,
          controller_player_id = gc.owner_id,
          zone_position = (select coalesce(max(x.zone_position), -1) + 1
                           from public.game_cards x
                           where x.session_id = p_session_id
                             and x.owner_id = gc.owner_id and x.zone = 'hand')
      where gc.id = v_sac_artifact;
    end loop;
  end if;

  v_effect := v_ability -> 'effects' -> 0;
  if v_effect is null then
    raise exception 'Activated ability has no effect';
  end if;

  -- Non-mana activation broadcast (mig 258, Runic Armasaur: "whenever an
  -- opponent activates an ability of a creature or land that isn't a mana
  -- ability, you may draw a card"). Mana abilities route through
  -- activate_mana_ability and never reach here, so every fire is non-mana.
  -- Approximation: the watcher's type filter defaults to '' for this event
  -- (any permanent type, not just creature-or-land).
  perform public.fire_watcher_triggers(
    p_session_id, p_source_card_id, auth.uid(), 'ability_activated');

  -- A MULTI-effect ability (Vampiric Rites: draw + lose life; Kessig Wolf
  -- Run: targeted pump + trample) resolves its whole program via a
  -- spell_effect stack item. A provided target rides the payload — the
  -- program resolver routes each targeted effect to it.
  if jsonb_array_length(coalesce(v_ability -> 'effects', '[]'::jsonb)) > 1 then
    select coalesce(max(position), 0) + 1 into v_next_position
    from public.game_stack_items where session_id = p_session_id;
    insert into public.game_stack_items (
      session_id, controller_player_id, source_card_id, action_type, payload, position, status
    ) values (
      p_session_id, auth.uid(), p_source_card_id, 'spell_effect',
      jsonb_build_object('effects', v_ability -> 'effects', 'controller_player_id', auth.uid(), 'timing', 'instant')
        || case when p_target_card_id is not null
                then jsonb_build_object('target_card_id', p_target_card_id) else '{}'::jsonb end,
      v_next_position, 'pending'
    )
    returning * into v_stack;
    return v_stack;
  end if;

  v_eff_type := lower(coalesce(v_effect ->> 'type', ''));
  v_target_controller := coalesce(lower(nullif(v_effect ->> 'target_controller', '')), 'any');
  -- Dynamic amount resolved NOW against the source permanent / controller / target.
  v_amount := public.resolve_dynamic_amount(
    p_session_id, p_source_card_id, auth.uid(), v_effect -> 'amount', p_target_card_id);

  if v_eff_type = 'draw' then
    v_stack := public.put_action_on_stack(
      p_session_id, 'draw_cards',
      jsonb_build_object('amount', greatest(1, v_amount), 'timing', 'instant'),
      p_source_card_id
    );

  elsif v_eff_type in ('create_token', 'search_library', 'grant_keyword_all', 'return_all_from_graveyard', 'deal_damage_all', 'monstrosity', 'divide_damage', 'return_from_graveyard', 'play_hideaway', 'choose_one', 'gain_life', 'fight_pick', 'destroy_all', 'proliferate', 'copy_permanent') then
    -- A single create_token / search_library / grant_keyword_all effect
    -- routes through a spell_effect stack item so it reuses the spell-effect
    -- resolver (incl. the `tapped` flag and tutor `filter`). Wayfarer's Bauble.
    -- A provided target rides the payload (mig 261, Wayta's fight_pick: the
    -- activation target is the fighter).
    select coalesce(max(position), 0) + 1 into v_next_position
    from public.game_stack_items where session_id = p_session_id;
    insert into public.game_stack_items (
      session_id, controller_player_id, source_card_id, action_type, payload, position, status
    ) values (
      p_session_id, auth.uid(), p_source_card_id, 'spell_effect',
      jsonb_build_object('effects', jsonb_build_array(v_effect), 'controller_player_id', auth.uid(), 'timing', 'instant')
        || case when p_target_card_id is not null
                then jsonb_build_object('target_card_id', p_target_card_id) else '{}'::jsonb end,
      v_next_position, 'pending'
    )
    returning * into v_stack;

  elsif v_eff_type = 'exile_from_graveyard' then
    -- Withered Wretch: target is a card in ANY graveyard (not consumed as a cost).
    if p_target_card_id is null then
      raise exception 'A target card in a graveyard is required';
    end if;
    if not exists (
      select 1 from public.game_cards
      where id = p_target_card_id and session_id = p_session_id and zone = 'graveyard'
    ) then
      raise exception 'Target must be a card in a graveyard';
    end if;
    -- Direct-insert the stack item (the dispatcher resolves it via the registered
    -- handle_exile_from_graveyard handler). put_action_on_stack's hardcoded action
    -- allowlist doesn't carry this type, so mirror the create_token path above.
    select coalesce(max(position), 0) + 1 into v_next_position
    from public.game_stack_items where session_id = p_session_id;
    insert into public.game_stack_items (
      session_id, controller_player_id, source_card_id, action_type, payload, position, status
    ) values (
      p_session_id, auth.uid(), p_source_card_id, 'exile_from_graveyard',
      jsonb_build_object('target_card_id', p_target_card_id, 'timing', 'instant'),
      v_next_position, 'pending'
    )
    returning * into v_stack;

  elsif v_eff_type = 'grant_cast_from_graveyard' and p_target_card_id is not null then
    -- Havengul Lich (mig 215): "{1}: You may cast target creature card in a
    -- graveyard this turn." The chosen card gets a card-specific until-EOT
    -- cast-from-graveyard permission (the ATAE branch writes the row). The
    -- "gains all activated abilities of that card" rider is NOT modelled.
    -- Engine limitation: the cast path only casts cards you OWN, so targeting
    -- an opponent's graveyard grants a permission that can't be used yet.
    if not exists (
      select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.id = p_target_card_id and gc.session_id = p_session_id and gc.zone = 'graveyard'
        and c.type_line ilike '%creature%'
    ) then
      raise exception 'Target must be a creature card in a graveyard';
    end if;
    select coalesce(max(position), 0) + 1 into v_next_position
    from public.game_stack_items where session_id = p_session_id;
    insert into public.game_stack_items (
      session_id, controller_player_id, source_card_id, action_type, payload, position, status
    ) values (
      p_session_id, auth.uid(), p_source_card_id, 'spell_effect',
      jsonb_build_object(
        'effects', jsonb_build_array(v_effect || jsonb_build_object('card_id', p_target_card_id)),
        'controller_player_id', auth.uid(), 'timing', 'instant'),
      v_next_position, 'pending'
    )
    returning * into v_stack;

  elsif v_eff_type = 'reanimate_from_graveyard' then
    -- Gravespawn Sovereign (mig 212): "Put target creature card from a
    -- graveyard onto the battlefield under your control." Same direct-insert
    -- route as exile_from_graveyard; the registered handler moves the card.
    if p_target_card_id is null then
      raise exception 'A target creature card in a graveyard is required';
    end if;
    if not exists (
      select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.id = p_target_card_id and gc.session_id = p_session_id and gc.zone = 'graveyard'
        and c.type_line ilike '%creature%'
    ) then
      raise exception 'Target must be a creature card in a graveyard';
    end if;
    select coalesce(max(position), 0) + 1 into v_next_position
    from public.game_stack_items where session_id = p_session_id;
    insert into public.game_stack_items (
      session_id, controller_player_id, source_card_id, action_type, payload, position, status
    ) values (
      p_session_id, auth.uid(), p_source_card_id, 'reanimate_from_graveyard',
      jsonb_build_object('target_card_id', p_target_card_id, 'timing', 'instant'),
      v_next_position, 'pending'
    )
    returning * into v_stack;

  elsif v_eff_type = 'deal_damage' then
    if v_amount <= 0 then
      raise exception 'Invalid damage amount';
    end if;
    if p_target_card_id is not null then
      v_stack := public.put_action_on_stack(
        p_session_id, 'deal_damage_creature',
        jsonb_build_object('target_card_id', p_target_card_id, 'amount', v_amount, 'target_controller', v_target_controller, 'timing', 'instant'),
        p_source_card_id
      );
    elsif p_target_player_id is not null then
      v_stack := public.put_action_on_stack(
        p_session_id, 'deal_damage_player',
        jsonb_build_object('target_player_id', p_target_player_id, 'amount', v_amount, 'timing', 'instant'),
        p_source_card_id
      );
    else
      raise exception 'A target is required for this ability';
    end if;

  elsif v_eff_type in ('destroy', 'exile', 'bounce', 'tap', 'untap') then
    if p_target_card_id is null then
      raise exception 'A target is required for this ability';
    end if;
    if public.behavior_target_type_is_creature_only(v_effect -> 'target_type') then
      v_stack := public.put_action_on_stack(
        p_session_id, v_eff_type || '_creature',
        jsonb_build_object('target_card_id', p_target_card_id, 'target_controller', v_target_controller, 'timing', 'instant'),
        p_source_card_id
      );
    else
      -- A non-creature / any-permanent target (Unstable Obelisk) goes through the
      -- type-flexible permanent_effect action; apply_creature_effect's removal
      -- kinds operate on any permanent.
      v_stack := public.put_action_on_stack(
        p_session_id, 'permanent_effect',
        jsonb_build_object('kind', v_eff_type, 'target_card_id', p_target_card_id,
          'target_type', coalesce(v_effect -> 'target_type', '"permanent"'::jsonb),
          'target_controller', v_target_controller, 'timing', 'instant'),
        p_source_card_id
      );
    end if;

  elsif v_eff_type = 'add_counters' then
    if v_amount <= 0 then
      raise exception 'Invalid counter amount';
    end if;
    if p_target_card_id is null then
      -- Untargeted (mig 214, Grimoire of the Dead "put a study counter on ~"):
      -- route through a spell_effect stack item — the trigger resolver's
      -- add_counters defaults to the SOURCE (incl. bag counter_type).
      select coalesce(max(position), 0) + 1 into v_next_position
      from public.game_stack_items where session_id = p_session_id;
      insert into public.game_stack_items (
        session_id, controller_player_id, source_card_id, action_type, payload, position, status
      ) values (
        p_session_id, auth.uid(), p_source_card_id, 'spell_effect',
        jsonb_build_object('effects', jsonb_build_array(v_effect), 'controller_player_id', auth.uid(), 'timing', 'instant'),
        v_next_position, 'pending'
      )
      returning * into v_stack;
    else
      v_stack := public.put_action_on_stack(
        p_session_id, 'add_counters_creature',
        jsonb_build_object('target_card_id', p_target_card_id, 'amount', v_amount, 'target_controller', v_target_controller, 'timing', 'instant'),
        p_source_card_id
      );
    end if;

  elsif v_eff_type = 'pump' then
    if p_target_card_id is null then
      raise exception 'A target is required for this ability';
    end if;
    v_stack := public.put_action_on_stack(
      p_session_id, 'pump_creature',
      jsonb_build_object('target_card_id', p_target_card_id,
        'power', coalesce((v_effect ->> 'power')::integer, 0),
        'toughness', coalesce((v_effect ->> 'toughness')::integer, 0),
        'target_controller', v_target_controller, 'timing', 'instant'),
      p_source_card_id
    );

  elsif v_eff_type = 'grant_keyword' then
    if p_target_card_id is null then
      raise exception 'A target is required for this ability';
    end if;
    v_stack := public.put_action_on_stack(
      p_session_id, 'grant_keyword_creature',
      jsonb_build_object('target_card_id', p_target_card_id, 'keyword', lower(coalesce(v_effect ->> 'keyword', '')),
        'target_controller', v_target_controller, 'timing', 'instant'),
      p_source_card_id
    );

  elsif v_eff_type = 'equip' then
    -- Equip {N} (mig 266, Breya Equipment cluster): attach this Equipment to
    -- target creature you control. register_card_continuous_effects already
    -- lands affected:'equipped' rows on attached_to, so a re-register after
    -- the move grants the Equipment's bonuses to the new host. Sorcery-speed
    -- timing is not enforced (consistent with the engine's loose timing).
    if p_target_card_id is null then
      raise exception 'Equip needs a target creature you control';
    end if;
    if not exists (
      select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.id = p_target_card_id and gc.session_id = p_session_id
        and gc.zone = 'battlefield'
        and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
        and c.type_line ilike '%creature%'
    ) then
      raise exception 'Equip target must be a creature you control';
    end if;
    update public.game_cards
    set attached_to = p_target_card_id
    where id = p_source_card_id and session_id = p_session_id;
    perform public.rebuild_scripted_continuous_effects(p_session_id);
    v_stack := null;

  elsif v_eff_type = 'gain_control' then
    if p_target_card_id is null then
      raise exception 'A target is required for this ability';
    end if;
    v_stack := public.put_action_on_stack(
      p_session_id, 'gain_control_creature',
      jsonb_build_object('target_card_id', p_target_card_id,
        'duration', coalesce(v_effect ->> 'duration', 'permanent'),
        'untap', coalesce((v_effect ->> 'untap')::boolean, false),
        'haste', coalesce((v_effect ->> 'haste')::boolean, false),
        'target_controller', v_target_controller, 'timing', 'instant'),
      p_source_card_id
    );

  else
    raise exception 'Unsupported ability effect: %', v_eff_type;
  end if;

  return v_stack;
end;
$$;
grant execute on function public.activate_ability(uuid, uuid, integer, uuid, uuid, jsonb, integer, uuid[]) to authenticated;
grant execute on function public.activate_ability(uuid, uuid, integer, uuid, uuid, jsonb, integer, uuid[]) to service_role;
