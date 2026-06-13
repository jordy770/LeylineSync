-- Two small filter extensions:
--   CHECKLANDS — enters_tapped `{ unless: { control_type: ["Forest","Island"] } }`:
--     a land enters untapped if you already control a battlefield permanent of
--     a listed type (Rootbound Crag, Hinterland Harbor, Sulfur Falls, Temple of
--     the Dragon Queen). Added to cast_card_from_hand's enters_tapped eval.
--   WATCHER min_power — a creature_entered/etc. filter `{ min_power: N }` fires
--     only when the entering creature's effective power is >= N (Elemental
--     Bond, Temur Ascendancy). Added to fire_watcher_triggers' filter chain.

create or replace function public.cast_card_from_hand(
  p_session_id uuid,
  p_game_card_id uuid,
  p_generic_payment jsonb default null,
  p_target_card_id uuid default null,
  p_kicked boolean default false,
  p_sacrifice_ids uuid[] default null
) returns public.game_cards
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_card public.game_cards;
  v_card_type_line text;
  v_card_mana_cost text;
  v_is_aura boolean;
  v_pending_stack_count integer := 0;
  v_land_play_limit integer := 1;
  v_next_battlefield_position integer;
  v_next_stack_position integer;
  v_perm_id uuid;
  v_perm_once boolean;
  v_perm_source uuid;
  v_alt_cost jsonb;
  v_use_alt boolean := false;
  v_sac_needed integer := 0;
  v_sac_id uuid;
  v_enters_tapped jsonb;
  v_land_tapped boolean := false;
  v_unless jsonb;
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
    raise exception 'Cannot cast cards in a finished game session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can cast cards';
  end if;

  -- Source is normally the hand; a cast_from_graveyard permission also unlocks the
  -- graveyard (validated against the card's type below).
  select game_cards.*
  into v_card
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id
    and game_cards.owner_id = auth.uid()
    and game_cards.zone in ('hand', 'graveyard')
  for update of game_cards;

  if not found then
    raise exception 'Card not found in hand or not owned by current user';
  end if;

  select cards.type_line, cards.mana_cost
  into v_card_type_line, v_card_mana_cost
  from public.cards
  where cards.id = v_card.card_id;

  -- A graveyard source requires an active permission whose type filter matches.
  -- A permission may be ONCE-PER-TURN (mig 207, Gisa and Geralf "Once during
  -- each of your turns, you may cast a Zombie creature spell from your
  -- graveyard"): payload.once_per_turn:true, with the usage turn stamped in the
  -- SOURCE permanent's counter bag ('gy_cast_turn' — survives rebuilds, like the
  -- planeswalker loyalty_turn marker). Unrestricted permissions are preferred
  -- so a once-row isn't consumed needlessly.
  if v_card.zone = 'graveyard' then
    -- SELF-granted alternative graveyard cast (mig 213, Scourge of Nel Toth:
    -- "You may cast this creature from your graveyard by paying {B}{B} and
    -- sacrificing two creatures rather than paying its mana cost"). A card
    -- whose own script carries `graveyard_cast_cost` needs no permission row;
    -- the alternative cost replaces the printed one (paid below).
    v_alt_cost := public.effective_script(p_session_id, p_game_card_id) -> 'graveyard_cast_cost';
    if v_alt_cost is not null and jsonb_typeof(v_alt_cost) = 'object' then
      v_use_alt := true;
    end if;
  end if;

  if v_card.zone = 'graveyard' and not v_use_alt then
    select ce.id,
           coalesce((ce.payload ->> 'once_per_turn')::boolean, false),
           ce.source_card_id
    into v_perm_id, v_perm_once, v_perm_source
    from public.game_continuous_effects ce
    left join public.game_cards sc on sc.id = ce.source_card_id
    where ce.session_id = p_session_id
      and ce.effect_type = 'cast_from_graveyard'
      and ce.affected_player_id = auth.uid()
      and (
        coalesce(ce.payload ->> 'type_line', '') = ''
        or coalesce(v_card_type_line, '') ilike '%' || (ce.payload ->> 'type_line') || '%'
      )
      -- Card-specific permission (mig 215, Havengul Lich): only that card.
      and (
        ce.payload ->> 'card_id' is null
        or (ce.payload ->> 'card_id')::uuid = p_game_card_id
      )
      and (
        coalesce((ce.payload ->> 'once_per_turn')::boolean, false) is false
        or coalesce((sc.counters ->> 'gy_cast_turn')::integer, -1)
           is distinct from v_turn_state.turn_number
      )
    order by coalesce((ce.payload ->> 'once_per_turn')::boolean, false), ce.id
    limit 1;

    if v_perm_id is null then
      raise exception 'You do not have permission to cast that card from your graveyard';
    end if;

    if v_perm_once and v_perm_source is not null then
      update public.game_cards
      set counters = coalesce(counters, '{}'::jsonb)
            || jsonb_build_object('gy_cast_turn', v_turn_state.turn_number)
      where id = v_perm_source and session_id = p_session_id;
    end if;
  end if;

  -- Turn-stamped graveyard-cast tracker (mig 206, Laboratory Drudge) — counts
  -- permission casts AND alternative-cost self casts.
  if v_card.zone = 'graveyard' then
    perform public.note_graveyard_cast(p_session_id, auth.uid());
  end if;

  if coalesce(v_card_type_line, '') ilike '%instant%'
    or coalesce(v_card_type_line, '') ilike '%sorcery%'
  then
    raise exception 'Use this spell action to cast instant and sorcery cards';
  end if;

  if v_turn_state.active_player_id <> auth.uid() then
    raise exception 'Cards can only be played by the active player in this first implementation';
  end if;

  if v_turn_state.step not in ('precombat_main', 'postcombat_main') then
    raise exception 'Cards can only be played during a main phase';
  end if;

  select count(*)
  into v_pending_stack_count
  from public.game_stack_items
  where session_id = p_session_id
    and status = 'pending';

  if v_pending_stack_count > 0 then
    raise exception 'Cards can only be played while the stack is empty';
  end if;

  if coalesce(v_card_type_line, '') ilike '%land%' then
    v_land_play_limit := public.get_land_play_limit(p_session_id, auth.uid());

    if coalesce(v_turn_state.lands_played_this_turn, 0) >= v_land_play_limit then
      raise exception 'You have already used all land plays this turn';
    end if;

    update public.game_turn_state
    set lands_played_this_turn = lands_played_this_turn + 1
    where session_id = p_session_id;

    -- "This land enters tapped" (mig 217). Top-level script `enters_tapped`:
    --   true                                            — always tapped
    --   { "unless": { "count": <source>, "type_line"?, "at_least": N } }
    --     — untapped when the count condition holds (Sunken Hollow:
    --       basic_lands_you_control >= 2)
    --   { "unless": { "hand_has_type": ["Island","Swamp"] } }
    --     — untapped when your hand has a matching card (Choked Estuary's
    --       reveal, auto-applied — the reveal choice itself isn't modelled).
    v_enters_tapped := public.effective_script(p_session_id, p_game_card_id) -> 'enters_tapped';
    if v_enters_tapped is not null then
      if jsonb_typeof(v_enters_tapped) = 'boolean' then
        v_land_tapped := (v_enters_tapped)::text = 'true';
      elsif jsonb_typeof(v_enters_tapped) = 'object' then
        v_land_tapped := true;
        v_unless := v_enters_tapped -> 'unless';
        if v_unless ? 'count' then
          if public.resolve_count_amount(p_session_id, auth.uid(), v_unless)
             >= coalesce((v_unless ->> 'at_least')::integer, 1) then
            v_land_tapped := false;
          end if;
        elsif v_unless ? 'hand_has_type' then
          if exists (
            select 1
            from public.game_cards gc
            join public.cards c on c.id = gc.card_id
            cross join lateral jsonb_array_elements_text(v_unless -> 'hand_has_type') as want(t)
            where gc.session_id = p_session_id and gc.owner_id = auth.uid()
              and gc.zone = 'hand' and gc.id <> p_game_card_id
              and c.type_line ilike '%' || want.t || '%'
          ) then
            v_land_tapped := false;
          end if;
        elsif v_unless ? 'control_type' then
          -- Checklands (mig 225): "enters tapped unless you control a Forest or
          -- an Island." Untapped when you control a battlefield permanent whose
          -- type line matches any of the listed types.
          if exists (
            select 1
            from public.game_cards gc
            join public.cards c on c.id = gc.card_id
            cross join lateral jsonb_array_elements_text(v_unless -> 'control_type') as want(t)
            where gc.session_id = p_session_id
              and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
              and gc.zone = 'battlefield' and gc.id <> p_game_card_id
              and c.type_line ilike '%' || want.t || '%'
          ) then
            v_land_tapped := false;
          end if;
        end if;
      end if;
    end if;

    select coalesce(max(zone_position), -1) + 1
    into v_next_battlefield_position
    from public.game_cards
    where session_id = p_session_id
      and owner_id = auth.uid()
      and zone = 'battlefield';

    update public.game_cards
    set
      zone = 'battlefield',
      zone_position = v_next_battlefield_position,
      entered_battlefield_turn_number = v_turn_state.turn_number,
      controller_player_id = coalesce(controller_player_id, owner_id),
      is_tapped = v_land_tapped,
      damage_marked = 0
    where id = p_game_card_id
    returning * into v_card;

    perform public.rebuild_scripted_continuous_effects(p_session_id);

    return v_card;
  end if;

  -- Aura: validate the enchant target (a legal creature without protection from the
  -- Aura's colour) at announce; it rides in the cast_permanent payload to resolution.
  v_is_aura := coalesce(v_card_type_line, '') ilike '%aura%';
  if v_is_aura then
    if p_target_card_id is null then
      raise exception 'An Aura must target a creature to enchant';
    end if;
    if not public.creature_target_controller_ok(p_session_id, p_target_card_id, auth.uid(), 'any') then
      raise exception 'An Aura can only enchant a creature on the battlefield';
    end if;
    if public.card_has_protection_from_any(
         p_session_id, p_target_card_id, public.card_color_set(v_card_mana_cost)
       ) then
      raise exception 'Target creature has protection from this Aura''s colour and can''t be enchanted by it';
    end if;
  end if;

  if v_use_alt then
    -- Alternative graveyard cast cost (mig 213, Scourge of Nel Toth): pay the
    -- alternative mana RATHER THAN the printed cost, then sacrifice N creatures
    -- — the caster's chosen set (p_sacrifice_ids) when provided, else the
    -- engine auto-picks (zone order; client refinement). Sacrifices route
    -- through put_in_graveyard so dies triggers fire.
    if nullif(v_alt_cost ->> 'mana', '') is not null then
      perform public.pay_mana_cost(p_session_id, auth.uid(), v_alt_cost ->> 'mana', p_generic_payment);
    end if;
    v_sac_needed := greatest(0, coalesce((v_alt_cost ->> 'sacrifice_creatures')::integer, 0));
    if v_sac_needed > 0 then
      if p_sacrifice_ids is not null then
        if cardinality(p_sacrifice_ids) <> v_sac_needed then
          raise exception 'This cast requires sacrificing exactly % creature(s)', v_sac_needed;
        end if;
        if (select count(*) from public.game_cards gc join public.cards c on c.id = gc.card_id
            where gc.id = any(p_sacrifice_ids) and gc.session_id = p_session_id
              and gc.zone = 'battlefield'
              and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
              and c.type_line ilike '%creature%') <> v_sac_needed
        then
          raise exception 'You can only sacrifice creatures you control';
        end if;
        foreach v_sac_id in array p_sacrifice_ids loop
          perform public.put_in_graveyard(p_session_id, v_sac_id);
        end loop;
      else
        if (select count(*) from public.game_cards gc join public.cards c on c.id = gc.card_id
            where gc.session_id = p_session_id and gc.zone = 'battlefield'
              and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
              and c.type_line ilike '%creature%') < v_sac_needed
        then
          raise exception 'You need % creature(s) to sacrifice for this cast', v_sac_needed;
        end if;
        for v_sac_id in
          select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
          where gc.session_id = p_session_id and gc.zone = 'battlefield'
            and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
            and c.type_line ilike '%creature%'
          order by gc.zone_position, gc.id
          limit v_sac_needed
        loop
          perform public.put_in_graveyard(p_session_id, v_sac_id);
        end loop;
      end if;
    end if;
  else
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_card_mana_cost, p_generic_payment);
  end if;

  -- Kicker (mig 211, Josu Vess): an OPTIONAL additional cost from the script's
  -- top-level `kicker` mana string. Paying it stamps 'kicked' in the card's
  -- counter bag (survives the stack→battlefield move and rebuilds); an ETB
  -- conditional reads it via { "counters": "kicked", "of": "self" }. Casting
  -- kicked without a kicker cost on the card is an error.
  if p_kicked then
    if nullif(public.effective_script(p_session_id, p_game_card_id) ->> 'kicker', '') is null then
      raise exception 'This card has no kicker cost';
    end if;
    perform public.pay_mana_cost(
      p_session_id, auth.uid(),
      public.effective_script(p_session_id, p_game_card_id) ->> 'kicker', null);
    update public.game_cards
    set counters = coalesce(counters, '{}'::jsonb) || jsonb_build_object('kicked', 1)
    where id = p_game_card_id and session_id = p_session_id;
  end if;

  select coalesce(max(position), -1) + 1
  into v_next_stack_position
  from public.game_stack_items
  where session_id = p_session_id;

  update public.game_cards
  set
    zone = 'stack',
    zone_position = v_next_stack_position,
    is_tapped = false,
    damage_marked = 0
  where id = p_game_card_id
  returning * into v_card;

  insert into public.game_stack_items (
    session_id,
    controller_player_id,
    source_card_id,
    action_type,
    payload,
    position
  )
  values (
    p_session_id,
    auth.uid(),
    p_game_card_id,
    'cast_permanent',
    jsonb_build_object(
      'timing', 'sorcery',
      'card_id', v_card.card_id,
      'type_line', v_card_type_line
    ) || case when v_is_aura
            then jsonb_build_object('target_card_id', p_target_card_id)
            else '{}'::jsonb end,
    v_next_stack_position
  );

  update public.game_turn_state
  set
    priority_player_id = active_player_id,
    priority_cycle_started_by = null,
    priority_pass_count = 0
  where session_id = p_session_id;

  return v_card;
end;
$$;
grant execute on function public.cast_card_from_hand(uuid, uuid, jsonb, uuid, boolean, uuid[]) to authenticated;

create or replace function public.fire_watcher_triggers(
  p_session_id uuid,
  p_changed_card_id uuid,
  p_changed_controller uuid,
  p_event text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changed_type text;
  v_changed_is_token boolean;
  v_watcher record;
  v_ability jsonb;
  v_filter jsonb;
  v_f_type text;
  v_f_controller text;
  v_exclude_self boolean;
  v_ctrl_ok boolean;
begin
  select cards.type_line, coalesce(cards.is_token, false)
  into v_changed_type, v_changed_is_token
  from public.game_cards gc
  join public.cards on cards.id = gc.card_id
  where gc.id = p_changed_card_id and gc.session_id = p_session_id;

  for v_watcher in
    select gc.id, coalesce(gc.controller_player_id, gc.owner_id) as controller, c.name as card_name
    from public.game_cards gc
    join public.cards c on c.id = gc.card_id
    where gc.session_id = p_session_id
      and (gc.zone = 'battlefield' or gc.id = p_changed_card_id)
    order by gc.controller_player_id, gc.id
  loop
    for v_ability in
      select * from jsonb_array_elements(
        coalesce(public.effective_script(p_session_id, v_watcher.id) -> 'triggered_abilities', '[]'::jsonb))
    loop
      if lower(coalesce(v_ability ->> 'event', '')) <> p_event then
        continue;
      end if;

      v_filter := v_ability -> 'filter';
      v_f_type := v_filter ->> 'type_line';
      v_f_controller := lower(coalesce(v_filter ->> 'controller', 'you'));
      v_exclude_self := coalesce((v_filter ->> 'exclude_self')::boolean, false);

      -- "another …": skip when the changed card IS the watcher.
      if v_exclude_self and v_watcher.id = p_changed_card_id then
        continue;
      end if;

      -- "nontoken …": skip when the changed creature is a token.
      if coalesce((v_filter ->> 'nontoken')::boolean, false) and v_changed_is_token then
        continue;
      end if;

      -- Type filter: default "creature"; else substring-match the subtype.
      if v_changed_type not ilike '%' || coalesce(v_f_type, 'creature') || '%' then
        continue;
      end if;

      -- Power filter (mig 225): "a creature with power N or greater enters"
      -- (Elemental Bond, Temur Ascendancy). Reads the changed card's effective
      -- power; non-creatures (no P/T) never qualify.
      if v_filter ? 'min_power'
         and coalesce(public.card_effective_power(p_session_id, p_changed_card_id), -1)
             < (v_filter ->> 'min_power')::integer then
        continue;
      end if;

      -- Controller filter, relative to the WATCHER's controller.
      v_ctrl_ok := case v_f_controller
        when 'you' then p_changed_controller = v_watcher.controller
        when 'opponent' then p_changed_controller is distinct from v_watcher.controller
        else true
      end;
      if not v_ctrl_ok then
        continue;
      end if;

      perform public.enqueue_triggered_ability(
        p_session_id, v_watcher.controller, v_watcher.id,
        coalesce(v_watcher.card_name, p_event), v_ability -> 'effects'
      );
    end loop;
  end loop;
end;
$$;
grant execute on function public.fire_watcher_triggers(uuid, uuid, uuid, text) to authenticated;
grant execute on function public.fire_watcher_triggers(uuid, uuid, uuid, text) to service_role;
