-- enqueue_cast_triggers
-- Cascade & generalized nested-cast, Task 5: adds enqueue_cast_triggers, which
-- reads a just-cast card's script.cascade and enqueues N cascade triggered
-- abilities, and wires it into every cast path (cast_card_from_hand for
-- permanents, cast_spell_effect for instants/sorceries, cast_card_free's
-- permanent branch for free-cast recursion) so a cascade card actually fires.
-- Generated from supabase/functions_src (enqueue_cast_triggers, cast_card_from_hand, cast_spell_effect, cast_card_free) — those files are
-- the canonical current definitions; edit them, not past migrations.

create or replace function public.enqueue_cast_triggers(
  p_session_id uuid, p_card_id uuid, p_controller uuid
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_script jsonb; v_mana_cost text; v_mv integer; v_count integer; v_i integer;
begin
  select public.effective_script(p_session_id, p_card_id), c.mana_cost
    into v_script, v_mana_cost
  from public.game_cards gc join public.cards c on c.id = gc.card_id
  where gc.id = p_card_id and gc.session_id = p_session_id;

  if v_script -> 'cascade' is null then return; end if;

  v_mv := public.mana_value(v_mana_cost);
  v_count := case
    when jsonb_typeof(v_script -> 'cascade') = 'object'
      then coalesce((v_script -> 'cascade' ->> 'count')::integer, 1)
    else 1 end;

  for v_i in 1 .. greatest(1, v_count) loop
    perform public.enqueue_triggered_ability(
      p_session_id, p_controller, p_card_id, 'Cascade',
      jsonb_build_array(jsonb_build_object('type', 'cascade', 'cast_mana_value', v_mv)));
  end loop;
end;
$$;
grant execute on function public.enqueue_cast_triggers(uuid, uuid, uuid) to authenticated;

create or replace function public.cast_card_from_hand(
  p_session_id uuid,
  p_game_card_id uuid,
  p_generic_payment jsonb default null,
  p_target_card_id uuid default null,
  p_kicked boolean default false,
  p_sacrifice_ids uuid[] default null,
  -- The chosen X for an {X} permanent (mig 300). Stamped on the card's counter
  -- bag so its ETB can read it (create_token count:'X' → counters.x).
  p_x_value integer default null
) returns public.game_cards
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_card public.game_cards;
  v_cast_zone text;
  v_card_type_line text;
  v_card_mana_cost text;
  v_is_aura boolean;
  v_pending_stack_count integer := 0;
  v_has_flash boolean := false;
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
  v_pay_life_untap integer := 0;
  v_unless jsonb;
  v_lib_perm jsonb;
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
    and game_cards.zone in ('hand', 'graveyard', 'exile', 'library')
  for update of game_cards;

  -- Original cast zone (v_card is later overwritten by the stack-move RETURNING).
  v_cast_zone := v_card.zone;

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

  -- An EXILE source requires a play_from_exile permission (mig 230, Atsushi
  -- impulse) whose payload.card_ids includes this card. The permission is left
  -- in place (advance_step expires it at the end of the player's next turn); the
  -- card simply leaves exile when it resolves onto the battlefield.
  if v_card.zone = 'exile' then
    if not exists (
      select 1 from public.game_continuous_effects ce
      where ce.session_id = p_session_id
        and ce.effect_type = 'play_from_exile'
        and ce.affected_player_id = auth.uid()
        and (ce.payload -> 'card_ids') ? p_game_card_id::text
    ) then
      raise exception 'You do not have permission to play that card from exile';
    end if;
  end if;

  -- A LIBRARY source must be the TOP card of the owner's library, unlocked by
  -- a cast_from_library_top permission (mig 244, Thundermane Dragon) whose
  -- payload filter matches ({creature, min_power} read against the card).
  -- payload.grant_haste gives the cast card haste until end of turn ("if you
  -- cast a creature spell this way, it gains haste").
  if v_card.zone = 'library' then
    if exists (
      select 1 from public.game_cards lib
      where lib.session_id = p_session_id and lib.owner_id = auth.uid() and lib.zone = 'library'
        and (lib.zone_position < v_card.zone_position
             or (lib.zone_position = v_card.zone_position and lib.id < v_card.id))
    ) then
      raise exception 'Only the top card of your library can be cast this way';
    end if;
    select ce.payload into v_lib_perm
    from public.game_continuous_effects ce
    left join public.game_cards sc on sc.id = ce.source_card_id
    where ce.session_id = p_session_id
      and ce.effect_type = 'cast_from_library_top'
      and ce.affected_player_id = auth.uid()
      and (ce.source_zone_required is null or sc.zone = ce.source_zone_required)
      and (not coalesce((ce.payload ->> 'creature')::boolean, false)
           or coalesce(v_card_type_line, '') ilike '%creature%')
      and ((ce.payload ->> 'min_power') is null
           or coalesce(public.card_effective_power(p_session_id, p_game_card_id), -1)
              >= (ce.payload ->> 'min_power')::integer)
    limit 1;
    if v_lib_perm is null then
      raise exception 'You do not have permission to cast that card from your library';
    end if;
    if coalesce((v_lib_perm ->> 'grant_haste')::boolean, false) then
      insert into public.game_continuous_effects (
        session_id, source_card_id, affected_card_id, effect_type, payload,
        source_zone_required, expires_at_phase, expires_at_step)
      values (p_session_id, p_game_card_id, p_game_card_id, 'haste',
        jsonb_build_object('until_end_of_turn', true), 'battlefield', 'ending', 'cleanup');
    end if;
  end if;

  -- Only the FRONT face decides how a card leaves the hand: an Adventure
  -- creature ("Creature — X // Instant — Adventure") is cast as a creature
  -- here; its instant half goes through cast_spell_effect(p_adventure). A true
  -- split/instant front face ("Instant // Sorcery") is still rejected.
  if split_part(coalesce(v_card_type_line, ''), ' // ', 1) ilike '%instant%'
    or split_part(coalesce(v_card_type_line, ''), ' // ', 1) ilike '%sorcery%'
  then
    raise exception 'Use this spell action to cast instant and sorcery cards';
  end if;

  -- Flash (mig 398): a nonland card with printed/script flash — or covered by a
  -- 'flash_permission' static (Shimmer Myr's "artifact spells as though they
  -- had flash") — may be cast whenever its controller holds priority, so it
  -- skips the sorcery-speed gate below. Lands never bypass (they aren't cast).
  v_has_flash := coalesce(v_card_type_line, '') not ilike '%land%'
    and public.card_has_flash(p_session_id, p_game_card_id, auth.uid());

  if not v_has_flash then
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
        -- Each condition is independent so a card may OR several (Temple of the
        -- Dragon Queen: enters tapped unless you revealed a Dragon from hand OR
        -- you control a Dragon). Any satisfied condition untaps it.
        if v_unless ? 'count' then
          if public.resolve_count_amount(p_session_id, auth.uid(), v_unless)
             >= coalesce((v_unless ->> 'at_least')::integer, 1) then
            v_land_tapped := false;
          end if;
        end if;
        if v_unless ? 'hand_has_type' then
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
        end if;
        if v_unless ? 'control_type' then
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
        if v_unless ? 'pay_life' then
          -- Shock lands (Overgrown Tomb, …): "enters tapped UNLESS you pay N life."
          -- It's the player's CHOICE, so it enters tapped now and a pay_life_untap
          -- decision (raised after it's on the battlefield) lets them pay to untap it.
          v_land_tapped := true;
          v_pay_life_untap := coalesce((v_unless ->> 'pay_life')::integer, 2);
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

    -- Shock land: it's on the battlefield (tapped) — now offer the "pay N life to
    -- untap it" choice as a pending decision (resolved via submit_decision).
    if v_pay_life_untap > 0 then
      insert into public.game_pending_decisions (
        session_id, deciding_player_id, source_stack_item_id, decision_type, prompt,
        options, min_choices, max_choices, params
      ) values (
        p_session_id, auth.uid(), null, 'pay_life_untap',
        'Pay ' || v_pay_life_untap || ' life so this land enters untapped?',
        '[]'::jsonb, 0, 0,
        jsonb_build_object('card_id', p_game_card_id, 'life', v_pay_life_untap)
      );
    end if;

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
      perform public.pay_mana_cost(p_session_id, auth.uid(), v_alt_cost ->> 'mana', p_generic_payment,
        p_pay_context := jsonb_build_object('kind', 'cast', 'type_line', coalesce(v_card_type_line, ''),
          'is_commander', coalesce(v_card.is_commander, false)));
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
    -- Cost reduction (mig 231): reduce the generic portion before paying (e.g.
    -- "Dragon spells you cast cost {1} less" — Dragonlord's Servant).
    perform public.pay_mana_cost(
      p_session_id, auth.uid(),
      public.reduced_mana_cost(p_session_id, auth.uid(), p_game_card_id, v_card_mana_cost),
      p_generic_payment,
      p_pay_context := jsonb_build_object('kind', 'cast', 'type_line', coalesce(v_card_type_line, ''),
        'is_commander', coalesce(v_card.is_commander, false)));
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
      public.effective_script(p_session_id, p_game_card_id) ->> 'kicker', null,
      p_pay_context := jsonb_build_object('kind', 'cast', 'type_line', coalesce(v_card_type_line, ''),
        'is_commander', coalesce(v_card.is_commander, false)));
    update public.game_cards
    set counters = coalesce(counters, '{}'::jsonb) || jsonb_build_object('kicked', 1)
    where id = p_game_card_id and session_id = p_session_id;
  end if;

  -- {X} permanent (mig 300, Champions from Beyond): stamp the chosen X in the
  -- counter bag so it survives the stack→battlefield move and its ETB can read
  -- it (create_token count:'X' → counters.x).
  if p_x_value is not null then
    update public.game_cards
    set counters = coalesce(counters, '{}'::jsonb) || jsonb_build_object('x', p_x_value)
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
      'timing', case when v_has_flash then 'instant' else 'sorcery' end,
      'card_id', v_card.card_id,
      'type_line', v_card_type_line
    ) || case when v_is_aura
            then jsonb_build_object('target_card_id', p_target_card_id)
            else '{}'::jsonb end,
    v_next_stack_position
  );

  -- "Whenever you/an opponent cast a spell" (mig 234, Taurean Mauler): a permanent
  -- spell is a spell too. (Lands return earlier, so they don't reach here.)
  perform public.fire_watcher_triggers(p_session_id, p_game_card_id, auth.uid(), 'spell_cast');

  -- Cascade (mig 423): a just-cast permanent may itself carry a cascade marker.
  perform public.enqueue_cast_triggers(p_session_id, p_game_card_id, auth.uid());

  -- "Whenever you cast a spell from exile" (mig 307, Urianger Augurelt): the
  -- source's ORIGINAL cast zone (v_card.zone is now 'stack' after the move).
  if v_cast_zone = 'exile' then
    perform public.fire_watcher_triggers(p_session_id, p_game_card_id, auth.uid(), 'cast_from_exile');
  end if;

  update public.game_turn_state
  set
    priority_player_id = active_player_id,
    priority_cycle_started_by = null,
    priority_pass_count = 0
  where session_id = p_session_id;

  return v_card;
end;
$$;
grant execute on function public.cast_card_from_hand(uuid, uuid, jsonb, uuid, boolean, uuid[], integer) to authenticated;

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
  p_free boolean default false
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
  if coalesce(v_turn.priority_player_id, v_turn.active_player_id) <> auth.uid() then
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
  -- A free cast (mig 419, cascade / generalized nested-cast) is engine-authorized
  -- and self-authorizing: it needs no play_from_exile permission row, mirroring
  -- the p_free guard on the payment block below.
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
  if not p_free and p_source_card_id is not null and v_source_zone in ('hand', 'exile') then
    -- Adventure half (mig 388): the spell being cast is the ADVENTURE, which
    -- has its OWN mana cost (Stomp is {1}{R}, not Bonecrusher's {2}{R}). The
    -- printed cost was charged before — unnoticed only because Murderous
    -- Rider's two costs happen to match.
    if p_adventure then
      v_source_mana_cost := coalesce(v_source_script -> 'adventure' ->> 'cost', v_source_mana_cost);
      v_source_type_line := nullif(split_part(coalesce(v_source_type_line, ''), ' // ', 2), '');
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
      || (case when p_target_card_id is not null
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
grant execute on function public.cast_spell_effect(uuid, jsonb, uuid, integer, uuid, boolean, boolean) to authenticated;

create or replace function public.cast_card_free(
  p_session_id uuid, p_game_card_id uuid, p_controller uuid
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_type_line text;
  v_card_id uuid;
  v_script jsonb;
  v_actions jsonb;
  v_next_position integer;
  v_is_permanent boolean;
  v_spec jsonb;
  v_stack_item_id uuid;
begin
  select gc.card_id, c.type_line, public.effective_script(p_session_id, p_game_card_id)
    into v_card_id, v_type_line, v_script
  from public.game_cards gc join public.cards c on c.id = gc.card_id
  where gc.id = p_game_card_id and gc.session_id = p_session_id;

  v_is_permanent := v_type_line ilike any (array[
    '%creature%','%artifact%','%enchantment%','%planeswalker%','%battle%','%land%']);

  if v_is_permanent then
    -- Real cast: push a cast_permanent stack item from exile (mirrors
    -- cast_card_from_hand:480-515, minus payment). Resolves with true ETBs.
    select coalesce(max(position), -1) + 1 into v_next_position
    from public.game_stack_items where session_id = p_session_id;

    update public.game_cards
    set zone = 'stack', zone_position = v_next_position, is_tapped = false, damage_marked = 0
    where id = p_game_card_id and session_id = p_session_id;

    insert into public.game_stack_items (
      session_id, controller_player_id, source_card_id, action_type, payload, position)
    values (
      p_session_id, p_controller, p_game_card_id, 'cast_permanent',
      jsonb_build_object('timing', 'sorcery', 'card_id', v_card_id, 'type_line', v_type_line, 'free', true),
      v_next_position);

    perform public.enqueue_cast_triggers(p_session_id, p_game_card_id, p_controller); -- enabled in Task 5
    return null;
  end if;

  -- Instant / sorcery.
  v_actions := v_script -> 'spell_effect' -> 'actions';
  if v_actions is null or jsonb_typeof(v_actions) <> 'array' then
    -- Unsupported shape → caller bottoms it (fallback). Signal with a sentinel.
    return '00000000-0000-0000-0000-000000000000'::uuid;
  end if;

  -- Does the spell need a cast-time target? If so, park it in the triggered-ability
  -- target shape and let choose_triggered_ability_(creature_)target set the target
  -- (guards relaxed to accept 'spell_effect'); apply_trigger_effects resolves the
  -- effects against the chosen target when the item resolves.
  v_spec := public.spell_free_cast_target_spec(v_actions);
  if coalesce((v_spec ->> 'required')::boolean, false) then
    select coalesce(max(position), -1) + 1 into v_next_position
    from public.game_stack_items where session_id = p_session_id;
    insert into public.game_stack_items (
      session_id, controller_player_id, source_card_id, action_type, payload, position, status)
    values (
      p_session_id, p_controller, p_game_card_id, 'spell_effect',
      jsonb_build_object(
        'effects', v_actions, 'controller_player_id', p_controller, 'timing', 'instant',
        'free_cast', true, 'target_required', true,
        'target_type', v_spec -> 'target_type',
        'target_controller', v_spec ->> 'target_controller',
        'target_count', (v_spec ->> 'target_count')::integer),
      v_next_position, 'pending')
    returning id into v_stack_item_id;
    -- The instant/sorcery leaves exile for the graveyard on cast (mirrors
    -- cast_spell_effect's cast-time zone move). Only instants/sorceries reach the
    -- spell branch here — targeted permanents (Auras) are caught by v_is_permanent
    -- above and go through the cast_permanent push; their targeting is a later gap.
    if v_type_line ilike '%instant%' or v_type_line ilike '%sorcery%' then
      update public.game_cards
      set zone = 'graveyard',
          zone_position = (select coalesce(max(zone_position), -1) + 1 from public.game_cards x
                           where x.session_id = p_session_id and x.owner_id = game_cards.owner_id and x.zone = 'graveyard')
      where id = p_game_card_id and session_id = p_session_id;
    end if;
    return v_stack_item_id;
  end if;

  perform public.cast_spell_effect(p_session_id, v_actions, p_game_card_id, 0, null, false, true);
  return null;
end;
$$;
grant execute on function public.cast_card_free(uuid, uuid, uuid) to authenticated;
