-- supabase/functions_src/cast_spell_effect.sql
-- CANONICAL current definition (seeded from 202605010177_flashback_alternate_effect.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

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
  p_overload boolean default false,
  -- Buyback (mig 430, Disturbed Burial): pay the script's `buyback` cost as an
  -- ADDITIONAL cost; finalize_stack_resolution returns the card to its owner's
  -- hand as the spell resolves (the payload carries the stamp).
  p_buyback boolean default false,
  -- Delve (mig 431, Dig Through Time): graveyard cards the caster exiles while
  -- casting — each pays for {1} of the generic cost. Script-gated (`delve`).
  p_delve_card_ids uuid[] default null,
  -- Convoke (mig 432, Hour of Reckoning / Triplicate Spirits): untapped
  -- creatures the caster taps while casting — each pays a matching coloured
  -- pip or {1} generic (apply_convoke). Script-gated (`convoke`).
  p_convoke_card_ids uuid[] default null,
  -- Spectacle (mig 433, Light Up the Stage): cast for the script's `spectacle`
  -- cost instead of the printed cost — only while an opponent has lost life
  -- this turn (game_session_players.life_lost_this_turn).
  p_spectacle boolean default false
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
  v_delve_count integer := coalesce(array_length(p_delve_card_ids, 1), 0);
  v_convoke_count integer := coalesce(array_length(p_convoke_card_ids, 1), 0);
  v_pay_cost text;
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

  -- Buyback (mig 430): script-gated additional cost; like overload it is only
  -- available on an actual hand/exile cast (a flashback cast exiles the card
  -- on resolution, which contradicts the buyback return).
  if p_buyback then
    if p_source_card_id is null or nullif(v_source_script ->> 'buyback', '') is null then
      raise exception 'This card has no buyback cost';
    end if;
    if v_source_zone not in ('hand', 'exile') then
      raise exception 'Buyback can only be used when casting from hand or exile';
    end if;
  end if;

  -- Delve (mig 431): script-gated; the chosen cards must be distinct cards in
  -- the CASTER's graveyard. The generic-cap check happens at payment time
  -- (against the reduced cost); the cards move to exile there too.
  if v_delve_count > 0 then
    if p_source_card_id is null
       or not coalesce((v_source_script ->> 'delve')::boolean, false) then
      raise exception 'This card does not have delve';
    end if;
    if v_source_zone not in ('hand', 'exile') then
      raise exception 'Delve can only be used when casting from hand or exile';
    end if;
    if (select count(distinct u) from unnest(p_delve_card_ids) u) <> v_delve_count
       or (select count(*) from public.game_cards gc
           where gc.id = any(p_delve_card_ids)
             and gc.session_id = p_session_id
             and gc.owner_id = auth.uid()
             and gc.zone = 'graveyard') <> v_delve_count then
      raise exception 'Delve cards must be distinct cards in your graveyard';
    end if;
  end if;

  -- Convoke (mig 432): script-gated; creature validation, tapping, and the
  -- pip-by-pip cost rewrite live in apply_convoke (at payment time).
  if v_convoke_count > 0 then
    if p_source_card_id is null
       or not coalesce((v_source_script ->> 'convoke')::boolean, false) then
      raise exception 'This card does not have convoke';
    end if;
    if v_source_zone not in ('hand', 'exile') then
      raise exception 'Convoke can only be used when casting from hand or exile';
    end if;
  end if;

  -- Spectacle (mig 433): script-gated alternative cost with a game-state
  -- condition — an opponent must have lost life this turn.
  if p_spectacle then
    if p_source_card_id is null or nullif(v_source_script ->> 'spectacle', '') is null then
      raise exception 'This card has no spectacle cost';
    end if;
    if v_source_zone not in ('hand', 'exile') then
      raise exception 'Spectacle can only be used when casting from hand or exile';
    end if;
    if not exists (
      select 1 from public.game_session_players sp
      where sp.session_id = p_session_id
        and sp.player_id is distinct from auth.uid()
        and coalesce(sp.life_lost_this_turn, 0) > 0
    ) then
      raise exception 'Spectacle requires an opponent to have lost life this turn';
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
    -- Spectacle (mig 433): same replacement, condition guarded above.
    if p_spectacle then
      v_source_mana_cost := v_source_script ->> 'spectacle';
    end if;
    if v_source_mana_cost is not null and btrim(v_source_mana_cost) <> '' then
      -- Cost reduction (mig 231, Draconic Lore: "costs {2} less if you control a
      -- Dragon"). Generic mana is auto-paid here (null generic payment), so the
      -- reduced cost is consumed with no client change. An exile cast (impulse)
      -- pays the printed cost too — impulse is not a free cast.
      v_pay_cost := public.reduced_mana_cost(p_session_id, auth.uid(), p_source_card_id, v_source_mana_cost);
      -- Delve (mig 431): each exiled card pays {1} of the remaining generic —
      -- capped at that generic (CR 702.66a: one card per generic mana).
      if v_delve_count > 0 then
        if v_delve_count > coalesce(substring(v_pay_cost from '\{(\d+)\}')::integer, 0) then
          raise exception 'Cannot delve more cards than the generic part of the cost';
        end if;
        v_pay_cost := public.reduce_generic_cost(v_pay_cost, v_delve_count);
      end if;
      -- Convoke (mig 432): validates + taps the creatures and rewrites the cost.
      if v_convoke_count > 0 then
        v_pay_cost := public.apply_convoke(p_session_id, auth.uid(), v_pay_cost, p_convoke_card_ids);
      end if;
      if btrim(v_pay_cost) <> '' then
        perform public.pay_mana_cost(
          p_session_id, auth.uid(), v_pay_cost,
          null, coalesce(p_x_value, 0),
          p_pay_context := jsonb_build_object('kind', 'cast', 'type_line', coalesce(v_source_type_line, ''),
            'is_commander', v_source_is_commander));
      end if;
      -- The delved cards leave the graveyard for exile as part of the cast.
      if v_delve_count > 0 then
        update public.game_cards gc
        set zone = 'exile',
            zone_position = (select coalesce(max(x.zone_position), -1) + 1
                             from public.game_cards x
                             where x.session_id = p_session_id
                               and x.owner_id = gc.owner_id and x.zone = 'exile')
        where gc.id = any(p_delve_card_ids) and gc.session_id = p_session_id;
      end if;
    end if;
    -- Buyback (mig 430): the additional cost is paid ON TOP of the printed
    -- cost (kicker precedent — a second pay_mana_cost call).
    if p_buyback then
      perform public.pay_mana_cost(
        p_session_id, auth.uid(), v_source_script ->> 'buyback', null,
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
               then jsonb_build_object('target_card_id', p_target_card_id) else '{}'::jsonb end)
      -- Buyback stamp (mig 430) — read by finalize_stack_resolution.
      || (case when p_buyback then jsonb_build_object('buyback', true) else '{}'::jsonb end),
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
grant execute on function public.cast_spell_effect(uuid, jsonb, uuid, integer, uuid, boolean, boolean, boolean, boolean, uuid[], uuid[], boolean) to authenticated;
