-- 202605010327_shock_lands
-- Shock lands ("enters tapped UNLESS you pay 2 life"). New enters_tapped option
-- {unless:{pay_life:N}}: cast_card_from_hand puts the land on the battlefield TAPPED
-- and raises a pay_life_untap pending decision; submit_decision pays N life + untaps
-- it if the player confirms and can afford it (MTG 119.4), else it stays tapped.
-- Generated from supabase/functions_src (cast_card_from_hand, submit_decision) — those files are
-- the canonical current definitions; edit them, not past migrations.

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
      'timing', 'sorcery',
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

create or replace function public.submit_decision(
  p_decision_id uuid,
  p_result jsonb
)
returns public.game_pending_decisions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_decision public.game_pending_decisions;
  v_chosen jsonb;
  v_count integer;
  v_option_count integer;
  v_idx integer;
  v_top jsonb;
  v_bottom jsonb;
  v_grave jsonb;
  v_option_ids uuid[];
  v_chosen_ids uuid[];
  v_needs_target boolean;
  v_mode jsonb;
  v_target_card uuid;
  v_dest text;
  v_card uuid;
  v_pos integer;
  v_turn integer;
  v_ctrl uuid;
  v_src_card uuid;
  v_tgt uuid;
  v_chosen_player uuid;
  v_chosen_type text;
  v_effects_rewritten jsonb;
  v_decision_id uuid;
  v_pe jsonb;
  v_old_effects jsonb;
  v_new_effects jsonb;
  v_mode_actions jsonb;
  v_resume integer;
  v_eff_script jsonb;
  v_type_line text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into v_decision from public.game_pending_decisions where id = p_decision_id for update;
  if not found then raise exception 'Decision not found'; end if;
  if v_decision.status <> 'pending' then raise exception 'Decision already %', v_decision.status; end if;
  if v_decision.deciding_player_id <> auth.uid() then raise exception 'Only the deciding player can submit this decision'; end if;

  -- ── Validation ──────────────────────────────────────────────────────────
  if v_decision.decision_type = 'choose_mode' then
    v_chosen := case
      when jsonb_typeof(p_result -> 'chosen') = 'array' then p_result -> 'chosen'
      when p_result -> 'chosen' is not null then jsonb_build_array(p_result -> 'chosen')
      else '[]'::jsonb
    end;
    v_count := jsonb_array_length(v_chosen);
    v_option_count := jsonb_array_length(v_decision.options);
    if v_count < v_decision.min_choices or v_count > v_decision.max_choices then
      raise exception 'Must choose between % and % option(s)', v_decision.min_choices, v_decision.max_choices;
    end if;
    v_needs_target := false;
    for v_idx in select (value)::integer from jsonb_array_elements_text(v_chosen)
    loop
      if v_idx < 0 or v_idx >= v_option_count then raise exception 'Chosen mode index % out of range', v_idx; end if;
      v_mode := v_decision.options -> v_idx;
      if exists (
        select 1 from jsonb_array_elements(coalesce(v_mode -> 'actions', '[]'::jsonb)) a(value)
        where (a.value ->> 'type') in ('deal_damage', 'destroy', 'exile', 'bounce', 'tap', 'untap', 'add_counters', 'pump')
          and ((a.value -> 'target_type') = '"creature"'::jsonb
               or (jsonb_typeof(a.value -> 'target_type') = 'array' and (a.value -> 'target_type') ? 'creature'))
      ) then
        v_needs_target := true;
      end if;
    end loop;
    if v_needs_target then
      v_target_card := nullif(p_result ->> 'target_card_id', '')::uuid;
      if v_target_card is null then raise exception 'This mode requires a creature target'; end if;
      if not exists (
        select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.id = v_target_card and gc.session_id = v_decision.session_id and gc.zone = 'battlefield' and c.type_line ilike '%creature%'
      ) then
        raise exception 'Modal target must be a creature on the battlefield';
      end if;
    end if;

  elsif v_decision.decision_type = 'scry' then
    v_top := case when jsonb_typeof(p_result -> 'top') = 'array' then p_result -> 'top' else '[]'::jsonb end;
    v_bottom := case when jsonb_typeof(p_result -> 'bottom') = 'array' then p_result -> 'bottom' else '[]'::jsonb end;
    select array_agg((value ->> 'game_card_id')::uuid) into v_option_ids from jsonb_array_elements(v_decision.options);
    select array_agg(id) into v_chosen_ids from (select (value)::uuid as id from jsonb_array_elements_text(v_top) union all select (value)::uuid from jsonb_array_elements_text(v_bottom)) q;
    v_chosen_ids := coalesce(v_chosen_ids, array[]::uuid[]);
    if cardinality(v_chosen_ids) <> cardinality(v_option_ids) then raise exception 'Scry must place every revealed card exactly once'; end if;
    if (select count(distinct e) from unnest(v_chosen_ids) e) <> cardinality(v_option_ids) then raise exception 'Scry placed a card more than once'; end if;
    if exists (select 1 from unnest(v_chosen_ids) e where e <> all(v_option_ids)) then raise exception 'Scry placed a card that was not revealed'; end if;

  elsif v_decision.decision_type = 'surveil' then
    v_grave := case when jsonb_typeof(p_result -> 'graveyard') = 'array' then p_result -> 'graveyard' else '[]'::jsonb end;
    v_top := case when jsonb_typeof(p_result -> 'top') = 'array' then p_result -> 'top' else '[]'::jsonb end;
    select array_agg((value ->> 'game_card_id')::uuid) into v_option_ids from jsonb_array_elements(v_decision.options);
    select array_agg(id) into v_chosen_ids from (select (value)::uuid as id from jsonb_array_elements_text(v_grave) union all select (value)::uuid from jsonb_array_elements_text(v_top)) q;
    v_chosen_ids := coalesce(v_chosen_ids, array[]::uuid[]);
    if cardinality(v_chosen_ids) <> cardinality(v_option_ids) then raise exception 'Surveil must place every revealed card exactly once'; end if;
    if (select count(distinct e) from unnest(v_chosen_ids) e) <> cardinality(v_option_ids) then raise exception 'Surveil placed a card more than once'; end if;
    if exists (select 1 from unnest(v_chosen_ids) e where e <> all(v_option_ids)) then raise exception 'Surveil placed a card that was not revealed'; end if;

  elsif v_decision.decision_type in ('search_library', 'choose_cards', 'sacrifice', 'return_from_graveyard', 'reanimate_destroyed', 'look_top', 'proliferate', 'copy_permanent', 'become_copy', 'bounce_pick', 'cast_exiled_free', 'put_from_hand_pick', 'destroy_pick', 'command_zone_pick', 'graveyard_exile_pick', 'fight_pick', 'etali_cast_pick', 'graveyard_to_top_pick') then
    v_top := case when jsonb_typeof(p_result -> 'chosen') = 'array' then p_result -> 'chosen' else '[]'::jsonb end;
    select array_agg((value ->> 'game_card_id')::uuid) into v_option_ids from jsonb_array_elements(v_decision.options);
    select array_agg((value)::uuid) into v_chosen_ids from jsonb_array_elements_text(v_top);
    v_chosen_ids := coalesce(v_chosen_ids, array[]::uuid[]);
    if cardinality(v_chosen_ids) < v_decision.min_choices or cardinality(v_chosen_ids) > v_decision.max_choices then
      raise exception 'Must choose between % and % card(s)', v_decision.min_choices, v_decision.max_choices;
    end if;
    if (select count(distinct e) from unnest(v_chosen_ids) e) <> cardinality(v_chosen_ids) then raise exception 'Chose a card more than once'; end if;
    if exists (select 1 from unnest(v_chosen_ids) e where e <> all(v_option_ids)) then raise exception 'Chose a card that was not offered'; end if;

  elsif v_decision.decision_type = 'choose_player' then
    v_chosen_player := nullif(p_result ->> 'player_id', '')::uuid;
    if v_chosen_player is null then raise exception 'A player must be chosen'; end if;
    if not exists (
      select 1 from jsonb_array_elements(v_decision.options) o where (o ->> 'player_id') = v_chosen_player::text
    ) then
      raise exception 'Chosen player was not offered';
    end if;

  elsif v_decision.decision_type = 'choose_creature_type' then
    v_chosen_type := nullif(p_result ->> 'type', '');
    if v_chosen_type is null then
      raise exception 'A creature type must be chosen';
    end if;

  elsif v_decision.decision_type = 'choose_color' then
    if lower(coalesce(p_result ->> 'color', '')) not in ('white', 'blue', 'black', 'red', 'green') then
      raise exception 'A color must be chosen';
    end if;
  end if;

  update public.game_pending_decisions
  set result = p_result, status = 'resolved', resolved_at = now()
  where id = p_decision_id
  returning * into v_decision;

  -- ── Apply + resume ──────────────────────────────────────────────────────
  if v_decision.decision_type = 'choose_mode' then
    -- A trigger-sourced modal (mig 230, Atsushi): apply the chosen mode's
    -- untargeted actions here and resume the trigger. Modal SPELLS are NOT
    -- trigger_modal — they resolve via resolve_top_of_stack, so this is a no-op
    -- for them.
    if coalesce((v_decision.params ->> 'trigger_modal')::boolean, false) then
      -- Splice the chosen modes' actions into the parked program at
      -- resume_index and resume (mig 239). The actions then run through the
      -- FULL program resolver, so modes may contain parking actions
      -- (copy_permanent, choose_player, …); plain untargeted actions reach the
      -- same untargeted applier as before via the program's fallthrough.
      select payload -> 'effects', coalesce((payload ->> 'resume_index')::integer, 0)
        into v_old_effects, v_resume
      from public.game_stack_items where id = v_decision.source_stack_item_id;
      v_mode_actions := '[]'::jsonb;
      for v_idx in select (value)::integer from jsonb_array_elements_text(v_chosen)
      loop
        v_mode_actions := v_mode_actions || coalesce(v_decision.options -> v_idx -> 'actions', '[]'::jsonb);
      end loop;
      -- effects := effects[0:resume) || mode_actions || effects[resume:]
      select coalesce(jsonb_agg(q.elem order by q.pos), '[]'::jsonb) into v_new_effects
      from (
        select t.elem, t.ord::numeric as pos
        from jsonb_array_elements(coalesce(v_old_effects, '[]'::jsonb)) with ordinality t(elem, ord)
        where t.ord <= v_resume
        union all
        select t.elem, v_resume + t.ord / 1000.0
        from jsonb_array_elements(v_mode_actions) with ordinality t(elem, ord)
        union all
        select t.elem, t.ord::numeric
        from jsonb_array_elements(coalesce(v_old_effects, '[]'::jsonb)) with ordinality t(elem, ord)
        where t.ord > v_resume
      ) q;
      update public.game_stack_items
      set payload = jsonb_set(payload, '{effects}', v_new_effects)
      where id = v_decision.source_stack_item_id;
      perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);
    end if;

  elsif v_decision.decision_type = 'divide_damage' then
    -- Validate + apply a divided-damage allocation (Dragonlord Atarka / Skarrgan).
    -- p_result.allocations = [{game_card_id|player_id, amount}], summing to the
    -- parked amount, each target an offered option, count within max_targets.
    declare
      v_allocs jsonb := case when jsonb_typeof(p_result -> 'allocations') = 'array' then p_result -> 'allocations' else '[]'::jsonb end;
      v_dd_amount integer := coalesce((v_decision.params ->> 'amount')::integer, 0);
      v_dd_max integer := coalesce((v_decision.params ->> 'max_targets')::integer, jsonb_array_length(v_decision.options));
      v_dd_n integer := jsonb_array_length(v_allocs);
    begin
      if v_dd_n < 1 or v_dd_n > v_dd_max then
        raise exception 'Must allocate to between 1 and % target(s)', v_dd_max;
      end if;
      if exists (select 1 from jsonb_array_elements(v_allocs) a where coalesce((a ->> 'amount')::integer, 0) < 1) then
        raise exception 'Each allocation must be at least 1 damage';
      end if;
      if (select coalesce(sum((value ->> 'amount')::integer), 0) from jsonb_array_elements(v_allocs)) <> v_dd_amount then
        raise exception 'Allocations must total % damage', v_dd_amount;
      end if;
      if exists (
        select 1 from jsonb_array_elements(v_allocs) a
        where not exists (
          select 1 from jsonb_array_elements(v_decision.options) o
          where ((a ->> 'game_card_id') is not null and (o ->> 'game_card_id') = (a ->> 'game_card_id'))
             or ((a ->> 'player_id') is not null and (o ->> 'player_id') = (a ->> 'player_id'))
        )
      ) then
        raise exception 'Allocation targets a permanent or player that was not offered';
      end if;
      perform public.apply_damage_allocations(v_decision.session_id, v_allocs);
    end;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'scry' then
    with ordered as (
      select (t.value)::uuid as id, 0 as section, t.ord as ordnum from jsonb_array_elements_text(v_top) with ordinality as t(value, ord)
      union all
      select gc.id, 1, gc.zone_position::bigint from public.game_cards gc
      where gc.session_id = v_decision.session_id and gc.owner_id = v_decision.deciding_player_id and gc.zone = 'library' and gc.id <> all(v_option_ids)
      union all
      select (b.value)::uuid, 2, b.ord from jsonb_array_elements_text(v_bottom) with ordinality as b(value, ord)
    ),
    renum as (select id, (row_number() over (order by section, ordnum) - 1) as np from ordered)
    update public.game_cards g set zone_position = renum.np from renum where g.id = renum.id;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'surveil' then
    with g as (select (value)::uuid as id, ord from jsonb_array_elements_text(v_grave) with ordinality as t(value, ord)),
    base as (select coalesce(max(zone_position), -1) as m from public.game_cards where session_id = v_decision.session_id and owner_id = v_decision.deciding_player_id and zone = 'graveyard')
    update public.game_cards gc set zone = 'graveyard', zone_position = base.m + g.ord, is_tapped = false from g, base where gc.id = g.id;
    with ordered as (
      select (t.value)::uuid as id, 0 as section, t.ord as ordnum from jsonb_array_elements_text(v_top) with ordinality as t(value, ord)
      union all
      select lib.id, 1, lib.zone_position::bigint from public.game_cards lib
      where lib.session_id = v_decision.session_id and lib.owner_id = v_decision.deciding_player_id and lib.zone = 'library' and lib.id <> all(v_option_ids)
    ),
    renum as (select id, (row_number() over (order by section, ordnum) - 1) as np from ordered)
    update public.game_cards g set zone_position = renum.np from renum where g.id = renum.id;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'search_library' then
    v_dest := coalesce(v_decision.params ->> 'to', 'hand');
    -- Shuffle BEFORE placing the picks (mig 288): with a to:'top' destination
    -- the rules order is "shuffle, THEN put it on top" — shuffling after
    -- placement would bury the tutored card again. Other destinations are
    -- order-insensitive (the picks leave the library either way).
    update public.game_cards g set zone_position = s.rn
    from (select id, (row_number() over (order by random(), id) - 1) as rn from public.game_cards
          where session_id = v_decision.session_id and owner_id = v_decision.deciding_player_id and zone = 'library') s
    where g.id = s.id;
    for v_card in select (value)::uuid from jsonb_array_elements_text(v_top)
    loop
      if v_dest = 'battlefield' then
        select coalesce(max(zone_position), -1) + 1 into v_pos from public.game_cards where session_id = v_decision.session_id and owner_id = v_decision.deciding_player_id and zone = 'battlefield';
        select turn_number into v_turn from public.game_turn_state where session_id = v_decision.session_id;
        update public.game_cards set zone = 'battlefield', zone_position = v_pos, controller_player_id = owner_id, is_tapped = coalesce((v_decision.params ->> 'tapped')::boolean, false), damage_marked = 0, entered_battlefield_turn_number = coalesce(v_turn, 0) where id = v_card;
      elsif v_dest = 'top' then
        select coalesce(min(zone_position), 0) - 1 into v_pos from public.game_cards where session_id = v_decision.session_id and owner_id = v_decision.deciding_player_id and zone = 'library';
        update public.game_cards set zone = 'library', zone_position = v_pos where id = v_card;
      elsif v_dest = 'graveyard' then
        select coalesce(max(zone_position), -1) + 1 into v_pos from public.game_cards where session_id = v_decision.session_id and owner_id = v_decision.deciding_player_id and zone = 'graveyard';
        update public.game_cards set zone = 'graveyard', zone_position = v_pos, is_tapped = false, damage_marked = 0 where id = v_card;
      else
        select coalesce(max(zone_position), -1) + 1 into v_pos from public.game_cards where session_id = v_decision.session_id and owner_id = v_decision.deciding_player_id and zone = 'hand';
        update public.game_cards set zone = 'hand', zone_position = v_pos, is_tapped = false where id = v_card;
      end if;
    end loop;
    if coalesce((v_decision.params ->> 'reveal')::boolean, false) then
      update public.game_pending_decisions set result = result || jsonb_build_object('revealed', v_top)
      where id = v_decision.id returning * into v_decision;
    end if;
    perform public.rebuild_scripted_continuous_effects(v_decision.session_id);
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'choose_cards' then
    v_dest := coalesce(v_decision.params ->> 'to', 'graveyard');
    for v_card in select (value)::uuid from jsonb_array_elements_text(v_top)
    loop
      select coalesce(max(zone_position), -1) + 1 into v_pos from public.game_cards where session_id = v_decision.session_id and owner_id = v_decision.deciding_player_id and zone = v_dest;
      update public.game_cards set zone = v_dest, zone_position = v_pos, is_tapped = false, damage_marked = 0 where id = v_card;
    end loop;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'proliferate' then
    update public.game_cards gc
    set plus_one_counters = case when gc.plus_one_counters > 0 then gc.plus_one_counters + 1 else 0 end,
        counters = public.proliferate_bag(gc.counters)
    where gc.session_id = v_decision.session_id and gc.id = any (v_chosen_ids);

    update public.game_session_players sp
    set counters = public.proliferate_bag(sp.counters)
    where sp.session_id = v_decision.session_id and sp.player_id = any (v_chosen_ids) and sp.counters <> '{}'::jsonb;

    perform public.maybe_finish_game_session(v_decision.session_id);
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'sacrifice' then
    for v_card in select (value)::uuid from jsonb_array_elements_text(v_top)
    loop
      perform public.put_in_graveyard(v_decision.session_id, v_card);
    end loop;
    perform public.rebuild_scripted_continuous_effects(v_decision.session_id);

    -- Tally sacrifices for a later edict create_token (Syphon Flesh). Accumulates
    -- across the each-opponent chain on the spell's own stack item.
    update public.game_stack_items
    set payload = payload || jsonb_build_object('sacrificed_count',
      coalesce((payload ->> 'sacrificed_count')::integer, 0) + jsonb_array_length(v_top))
    where id = v_decision.source_stack_item_id;

    v_decision_id := public.park_edict_sacrifice(
      v_decision.session_id, v_decision.source_stack_item_id,
      coalesce((v_decision.params ->> 'count')::integer, 1),
      v_decision.params ->> 'filter',
      coalesce(v_decision.params -> 'edict_queue', '[]'::jsonb)
    );
    if v_decision_id is null then
      perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);
    end if;

  elsif v_decision.decision_type = 'return_from_graveyard' then
    v_dest := coalesce(v_decision.params ->> 'to', 'hand');
    for v_card in select (value)::uuid from jsonb_array_elements_text(v_top)
    loop
      if v_dest = 'battlefield' then
        select coalesce(max(zone_position), -1) + 1 into v_pos from public.game_cards where session_id = v_decision.session_id and owner_id = v_decision.deciding_player_id and zone = 'battlefield';
        select turn_number into v_turn from public.game_turn_state where session_id = v_decision.session_id;
        -- params.tapped (mig 218, Victimize): "return the chosen cards to the battlefield tapped".
        -- params.control 'decider' (mig 270, Beacon of Unrest): the card enters
        -- under the DECIDER's control regardless of owner.
        update public.game_cards set zone = 'battlefield', zone_position = v_pos,
          controller_player_id = case when (v_decision.params ->> 'control') = 'decider'
                                      then v_decision.deciding_player_id else owner_id end,
          is_tapped = coalesce((v_decision.params ->> 'tapped')::boolean, false), damage_marked = 0, plus_one_counters = 0, entered_battlefield_turn_number = coalesce(v_turn, 0) where id = v_card;
        -- params.haste (mig 270, Grave Upheaval: "it gains haste") — a plain
        -- unexpiring row (NOT script-flagged, so re-registers keep it).
        if coalesce((v_decision.params ->> 'haste')::boolean, false) then
          insert into public.game_continuous_effects (
            session_id, source_card_id, affected_card_id, effect_type, payload, source_zone_required
          ) values (v_decision.session_id, v_card, v_card, 'haste', '{}'::jsonb, 'battlefield');
        end if;
      else
        select coalesce(max(zone_position), -1) + 1 into v_pos from public.game_cards where session_id = v_decision.session_id and owner_id = v_decision.deciding_player_id and zone = 'hand';
        update public.game_cards set zone = 'hand', zone_position = v_pos, is_tapped = false where id = v_card;
      end if;
    end loop;
    perform public.rebuild_scripted_continuous_effects(v_decision.session_id);
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'etali_cast_pick' then
    -- Etali (mig 262): every chosen exiled permanent enters the battlefield
    -- under the DECIDER's control (free-cast approximation); the rest stay
    -- exiled.
    select turn_number into v_turn from public.game_turn_state where session_id = v_decision.session_id;
    for v_card in select (value)::uuid from jsonb_array_elements_text(v_top)
    loop
      update public.game_cards gc
      set zone = 'battlefield', controller_player_id = v_decision.deciding_player_id,
          is_tapped = false, damage_marked = 0, plus_one_counters = 0,
          entered_battlefield_turn_number = coalesce(v_turn, 0),
          zone_position = (select coalesce(max(zone_position), -1) + 1
                           from public.game_cards x
                           where x.session_id = v_decision.session_id
                             and x.owner_id = gc.owner_id and x.zone = 'battlefield')
      where gc.id = v_card and gc.session_id = v_decision.session_id and gc.zone = 'exile';
      perform public.register_card_continuous_effects(v_decision.session_id, v_card);
    end loop;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'fight_pick' then
    -- Savage Stomp / Wayta (mig 261): the parked fighter fights the chosen
    -- creature (both deal power damage; apply_fight handles the sweep).
    for v_card in select (value)::uuid from jsonb_array_elements_text(v_top)
    loop
      perform public.apply_fight(
        v_decision.session_id,
        (v_decision.params ->> 'fighter_id')::uuid,
        v_card);
    end loop;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'graveyard_to_top_pick' then
    -- Noxious Revival (mig 275): the chosen graveyard card goes to the TOP of
    -- its owner's library (top = lowest zone_position).
    for v_card in select (value)::uuid from jsonb_array_elements_text(v_top)
    loop
      select coalesce(min(zone_position), 0) - 1 into v_pos
      from public.game_cards
      where session_id = v_decision.session_id
        and owner_id = (select owner_id from public.game_cards where id = v_card)
        and zone = 'library';
      update public.game_cards
      set zone = 'library', zone_position = v_pos, is_tapped = false, damage_marked = 0
      where id = v_card and session_id = v_decision.session_id and zone = 'graveyard';
    end loop;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'graveyard_exile_pick' then
    -- Deathgorge Scavenger (mig 259): exile the chosen graveyard card (0 or
    -- 1); a creature card gains the decider life, a noncreature card gives
    -- the SOURCE permanent +1/+1 until end of turn (if still fielded).
    for v_card in select (value)::uuid from jsonb_array_elements_text(v_top)
    loop
      select c.type_line into v_type_line
      from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.id = v_card and gc.session_id = v_decision.session_id;
      select coalesce(max(zone_position), -1) + 1 into v_pos
      from public.game_cards
      where session_id = v_decision.session_id
        and owner_id = (select owner_id from public.game_cards where id = v_card)
        and zone = 'exile';
      update public.game_cards
      set zone = 'exile', zone_position = v_pos, is_tapped = false, damage_marked = 0
      where id = v_card and session_id = v_decision.session_id and zone = 'graveyard';

      if v_type_line ilike '%creature%' then
        update public.game_session_players
        set life_total = life_total + coalesce((v_decision.params ->> 'gain_if_creature')::integer, 2)
        where session_id = v_decision.session_id and player_id = v_decision.deciding_player_id;
      else
        select source_card_id into v_src_card
        from public.game_stack_items where id = v_decision.source_stack_item_id;
        if exists (
          select 1 from public.game_cards
          where id = v_src_card and session_id = v_decision.session_id and zone = 'battlefield'
        ) then
          perform public.create_pt_pump(
            v_decision.session_id, v_src_card,
            coalesce((v_decision.params ->> 'pump_if_noncreature')::integer, 1),
            coalesce((v_decision.params ->> 'pump_if_noncreature')::integer, 1));
        end if;
      end if;
    end loop;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'look_top' then
    -- Ureni (mig 223): the chosen card (0 or 1) goes to the battlefield under
    -- the deciding player's control (fires ETB); every OTHER looked-at card goes
    -- to the bottom of the library in a random order. to:'exile' (mig 248,
    -- hideaway): the pick is exiled and remembered on the SOURCE permanent's
    -- counter bag (hideaway_card) for a later play_hideaway.
    v_dest := coalesce(v_decision.params ->> 'to', 'battlefield');
    for v_card in select (value)::uuid from jsonb_array_elements_text(v_top)
    loop
      if v_dest = 'hand' then
        -- "Put N into your hand" (mig 302, Dig Through Time); the rest bottom.
        select coalesce(max(zone_position), -1) + 1 into v_pos
        from public.game_cards where session_id = v_decision.session_id and owner_id = v_decision.deciding_player_id and zone = 'hand';
        update public.game_cards
        set zone = 'hand', zone_position = v_pos, controller_player_id = owner_id,
            is_tapped = false, damage_marked = 0
        where id = v_card;
      elsif v_dest = 'exile' then
        select coalesce(max(zone_position), -1) + 1 into v_pos
        from public.game_cards where session_id = v_decision.session_id and owner_id = v_decision.deciding_player_id and zone = 'exile';
        update public.game_cards
        set zone = 'exile', zone_position = v_pos, controller_player_id = owner_id,
            is_tapped = false, damage_marked = 0
        where id = v_card;
        select source_card_id into v_src_card from public.game_stack_items where id = v_decision.source_stack_item_id;
        if v_src_card is not null then
          update public.game_cards
          set counters = coalesce(counters, '{}'::jsonb) || jsonb_build_object('hideaway_card', v_card::text)
          where id = v_src_card and session_id = v_decision.session_id;
        end if;
      else
        select coalesce(max(zone_position), -1) + 1 into v_pos
        from public.game_cards where session_id = v_decision.session_id and owner_id = v_decision.deciding_player_id and zone = 'battlefield';
        select turn_number into v_turn from public.game_turn_state where session_id = v_decision.session_id;
        update public.game_cards
        set zone = 'battlefield', zone_position = v_pos, controller_player_id = owner_id,
            is_tapped = false, damage_marked = 0, plus_one_counters = 0,
            entered_battlefield_turn_number = coalesce(v_turn, 0)
        where id = v_card;
      end if;
    end loop;
    perform public.bottom_cards_random(
      v_decision.session_id, v_decision.deciding_player_id,
      (select coalesce(array_agg((e)::uuid), array[]::uuid[])
       from jsonb_array_elements_text(v_decision.params -> 'looked_at') e
       where (e)::uuid <> all(coalesce(v_chosen_ids, array[]::uuid[]))));
    perform public.rebuild_scripted_continuous_effects(v_decision.session_id);
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'reanimate_destroyed' then
    -- Necromantic Selection (mig 208): the chosen destroyed creature returns to
    -- the battlefield under the DECIDING player's control (unlike
    -- return_from_graveyard, which returns to its owner's control). The card
    -- stays owned by its owner; only control changes. ("…black Zombie in
    -- addition to its other colors and types" is not modelled — no type layer.)
    for v_card in select (value)::uuid from jsonb_array_elements_text(v_top)
    loop
      select coalesce(max(zone_position), -1) + 1 into v_pos
      from public.game_cards gc2
      where gc2.session_id = v_decision.session_id
        and gc2.owner_id = (select owner_id from public.game_cards where id = v_card)
        and gc2.zone = 'battlefield';
      select turn_number into v_turn from public.game_turn_state where session_id = v_decision.session_id;
      update public.game_cards
      set zone = 'battlefield', zone_position = v_pos,
          controller_player_id = v_decision.deciding_player_id,
          is_tapped = false, damage_marked = 0, plus_one_counters = 0,
          entered_battlefield_turn_number = coalesce(v_turn, 0)
      where id = v_card;
    end loop;
    perform public.rebuild_scripted_continuous_effects(v_decision.session_id);
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'pay_life_untap' then
    -- Shock land (Overgrown Tomb, …): the land is already on the battlefield tapped.
    -- If the player chose to pay AND can afford it (MTG 119.4: only if life >= cost),
    -- deduct the life and untap it; otherwise it stays tapped.
    if coalesce((v_decision.result ->> 'confirmed')::boolean, false)
       and (select life_total from public.game_session_players
            where session_id = v_decision.session_id and player_id = v_decision.deciding_player_id)
           >= coalesce((v_decision.params ->> 'life')::integer, 2)
    then
      update public.game_session_players
      set life_total = life_total - coalesce((v_decision.params ->> 'life')::integer, 2)
      where session_id = v_decision.session_id and player_id = v_decision.deciding_player_id;
      update public.game_cards
      set is_tapped = false
      where id = nullif(v_decision.params ->> 'card_id', '')::uuid and session_id = v_decision.session_id;
    end if;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'confirm' then
    if coalesce((v_decision.result ->> 'confirmed')::boolean, false) then
      -- Optional "you may pay {cost}" — pay it before applying the effects (raises
      -- if the deciding player can't pay, so the client should only offer it when
      -- affordable). The deciding player is the one who chose to pay.
      if nullif(v_decision.params ->> 'cost', '') is not null then
        perform public.pay_mana_cost(
          v_decision.session_id, v_decision.deciding_player_id, v_decision.params ->> 'cost', null);
      end if;
      select nullif(payload ->> 'controller_player_id', '')::uuid, source_card_id, nullif(payload ->> 'target_card_id', '')::uuid
        into v_ctrl, v_src_card, v_tgt
      from public.game_stack_items where id = v_decision.source_stack_item_id;
      perform public.apply_targeted_triggered_ability_effects(
        v_decision.session_id, coalesce(v_ctrl, v_decision.deciding_player_id), v_src_card,
        coalesce(v_decision.params -> 'effects', '[]'::jsonb), v_tgt
      );
    end if;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'copy_permanent' then
    -- Token copy (mig 239, Will of the Temur): create a token that's a copy of
    -- the picked permanent, with the parked `except` overrides (set_pt +
    -- keyword grants), then resume the program.
    foreach v_card in array v_chosen_ids
    loop
      perform public.create_copy_token(
        v_decision.session_id, v_decision.deciding_player_id, v_card,
        v_decision.params -> 'except');
    end loop;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'cast_exiled_free' then
    -- Breaching Dragonstorm (mig 245). Chosen: a PERMANENT card enters the
    -- battlefield under the decider's control (free-cast approximation;
    -- instants/sorceries go to hand instead). Declined: the card goes to its
    -- owner's hand.
    select (o.value ->> 'game_card_id')::uuid into v_card
    from jsonb_array_elements(v_decision.options) o limit 1;
    if cardinality(v_chosen_ids) > 0 and exists (
      select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.id = v_card and gc.session_id = v_decision.session_id
        and (c.type_line ilike '%creature%' or c.type_line ilike '%artifact%'
             or c.type_line ilike '%enchantment%' or c.type_line ilike '%land%'
             or c.type_line ilike '%planeswalker%' or c.type_line ilike '%battle%')
    ) then
      select turn_number into v_turn
      from public.game_turn_state where session_id = v_decision.session_id;
      update public.game_cards gc
      set zone = 'battlefield', controller_player_id = v_decision.deciding_player_id,
          is_tapped = false, entered_battlefield_turn_number = coalesce(v_turn, 0),
          zone_position = (select coalesce(max(zone_position), -1) + 1
                           from public.game_cards x
                           where x.session_id = v_decision.session_id
                             and x.owner_id = gc.owner_id and x.zone = 'battlefield')
      where gc.id = v_card;
      perform public.register_card_continuous_effects(v_decision.session_id, v_card);
    else
      update public.game_cards gc
      set zone = 'hand',
          zone_position = (select coalesce(max(zone_position), -1) + 1
                           from public.game_cards x
                           where x.session_id = v_decision.session_id
                             and x.owner_id = gc.owner_id and x.zone = 'hand')
      where gc.id = v_card;
    end if;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'vote' then
    -- Council's dilemma (mig 252, Selvala's Stampede). Record the vote on
    -- the stack payload; park the next voter, or — when the queue is empty —
    -- tally and apply: wild reveals from the CASTER's library until that
    -- many creature cards entered under them (other revealed cards bottom in
    -- a random order), free rides the payload for the following
    -- put_from_hand action.
    declare
      v_vote text := lower(coalesce(p_result ->> 'value', ''));
      v_vq jsonb := coalesce(v_decision.params -> 'queue', '[]'::jsonb);
      v_stk public.game_stack_items;
      v_wild integer;
      v_free integer;
      v_caster uuid;
      v_found integer := 0;
      v_scanned integer := 0;
      v_lib_size integer;
      v_rest uuid[] := array[]::uuid[];
      v_scan_id uuid;
      v_scan_creature boolean;
    begin
      if v_vote not in ('wild', 'free') then
        raise exception 'Vote must be wild or free';
      end if;
      update public.game_stack_items
      set payload = jsonb_set(payload, '{votes}', coalesce(payload -> 'votes', '[]'::jsonb) || to_jsonb(v_vote))
      where id = v_decision.source_stack_item_id
      returning * into v_stk;

      if jsonb_array_length(v_vq) > 0 then
        insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
        values (v_decision.session_id, (v_vq ->> 0)::uuid, v_decision.source_stack_item_id, 'vote',
          'Vote wild or free',
          '[{"value":"wild"},{"value":"free"}]'::jsonb, 1, 1,
          jsonb_build_object('queue',
            (select coalesce(jsonb_agg(t.value), '[]'::jsonb)
             from jsonb_array_elements(v_vq) with ordinality t(value, ord)
             where t.ord > 1)));
      else
        select count(*) into v_wild
        from jsonb_array_elements_text(coalesce(v_stk.payload -> 'votes', '[]'::jsonb)) v(val)
        where v.val = 'wild';
        select count(*) into v_free
        from jsonb_array_elements_text(coalesce(v_stk.payload -> 'votes', '[]'::jsonb)) v(val)
        where v.val = 'free';
        v_caster := coalesce(nullif(v_stk.payload ->> 'controller_player_id', '')::uuid, v_stk.controller_player_id);

        select count(*) into v_lib_size
        from public.game_cards
        where session_id = v_decision.session_id and owner_id = v_caster and zone = 'library';
        select turn_number into v_turn
        from public.game_turn_state where session_id = v_decision.session_id;

        while v_found < v_wild and v_scanned < v_lib_size loop
          select gc.id, (c.type_line ilike '%creature%')
          into v_scan_id, v_scan_creature
          from public.game_cards gc join public.cards c on c.id = gc.card_id
          where gc.session_id = v_decision.session_id and gc.owner_id = v_caster and gc.zone = 'library'
            and gc.id <> all(v_rest)
          order by gc.zone_position asc, gc.id asc limit 1;
          exit when v_scan_id is null;
          v_scanned := v_scanned + 1;
          if v_scan_creature then
            update public.game_cards gc
            set zone = 'battlefield', controller_player_id = v_caster, is_tapped = false,
                entered_battlefield_turn_number = coalesce(v_turn, 0),
                zone_position = (select coalesce(max(zone_position), -1) + 1
                                 from public.game_cards x
                                 where x.session_id = v_decision.session_id
                                   and x.owner_id = gc.owner_id and x.zone = 'battlefield')
            where gc.id = v_scan_id;
            perform public.register_card_continuous_effects(v_decision.session_id, v_scan_id);
            v_found := v_found + 1;
          else
            v_rest := v_rest || v_scan_id;
          end if;
        end loop;
        if cardinality(v_rest) > 0 then
          perform public.bottom_cards_random(v_decision.session_id, v_caster, v_rest);
        end if;

        update public.game_stack_items
        set payload = payload || jsonb_build_object('free_votes', v_free)
        where id = v_decision.source_stack_item_id;
        perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);
      end if;
    end;

  elsif v_decision.decision_type = 'command_zone_pick' then
    -- Hellkite Courser (mig 248): the picked commander enters the battlefield
    -- with haste (until end of turn) and a return_to_command marker the end
    -- step processes. Empty = declined.
    select turn_number into v_turn
    from public.game_turn_state where session_id = v_decision.session_id;
    foreach v_card in array v_chosen_ids
    loop
      update public.game_cards gc
      set zone = 'battlefield', controller_player_id = gc.owner_id,
          is_tapped = false, entered_battlefield_turn_number = coalesce(v_turn, 0),
          counters = coalesce(gc.counters, '{}'::jsonb) || jsonb_build_object('return_to_command', 1),
          zone_position = (select coalesce(max(zone_position), -1) + 1
                           from public.game_cards x
                           where x.session_id = v_decision.session_id
                             and x.owner_id = gc.owner_id and x.zone = 'battlefield')
      where gc.id = v_card;
      perform public.register_card_continuous_effects(v_decision.session_id, v_card);
      insert into public.game_continuous_effects (
        session_id, source_card_id, affected_card_id, effect_type, payload,
        source_zone_required, expires_at_phase, expires_at_step)
      values (v_decision.session_id, v_card, v_card, 'haste',
        jsonb_build_object('until_end_of_turn', true), 'battlefield', 'ending', 'cleanup');
    end loop;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'put_from_hand_pick' then
    -- Broodcaller Scourge (mig 247): each picked hand card enters the
    -- battlefield under the decider's control. Empty = declined.
    select turn_number into v_turn
    from public.game_turn_state where session_id = v_decision.session_id;
    foreach v_card in array v_chosen_ids
    loop
      update public.game_cards gc
      set zone = 'battlefield', controller_player_id = v_decision.deciding_player_id,
          is_tapped = false, entered_battlefield_turn_number = coalesce(v_turn, 0),
          zone_position = (select coalesce(max(zone_position), -1) + 1
                           from public.game_cards x
                           where x.session_id = v_decision.session_id
                             and x.owner_id = gc.owner_id and x.zone = 'battlefield')
      where gc.id = v_card;
      perform public.register_card_continuous_effects(v_decision.session_id, v_card);
    end loop;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'destroy_pick' then
    -- Parapet Thrasher mode (mig 247): destroy each picked permanent.
    foreach v_card in array v_chosen_ids
    loop
      perform public.put_in_graveyard(v_decision.session_id, v_card);
    end loop;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'bounce_pick' then
    -- Hammerhead Tyrant (mig 244): bounce each picked permanent to its
    -- OWNER's hand (the bounce primitive resets controller/taps properly).
    foreach v_card in array v_chosen_ids
    loop
      perform public.apply_creature_effect(v_decision.session_id, 'bounce', v_card, '{}'::jsonb);
    end loop;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'pay_x_mana_damage' then
    -- Leyline Tyrant (mig 244): amount 0 / no pick declines. Validated here
    -- in the apply section (divide_damage precedent) — an exception rolls the
    -- whole transaction back.
    declare
      v_px_amount integer := greatest(0, coalesce((p_result ->> 'amount')::integer, 0));
      v_px_color text := upper(coalesce(v_decision.params ->> 'color', 'R'));
      v_px_pool integer;
    begin
      if v_px_amount > 0 then
        if not exists (
          select 1 from jsonb_array_elements(v_decision.options) o
          where ((p_result ->> 'game_card_id') is not null and (o ->> 'game_card_id') = (p_result ->> 'game_card_id'))
             or ((p_result ->> 'player_id') is not null and (o ->> 'player_id') = (p_result ->> 'player_id'))
        ) then
          raise exception 'A target from the offered list is required';
        end if;
        select coalesce((mana_pool ->> v_px_color)::integer, 0) into v_px_pool
        from public.game_players
        where session_id = v_decision.session_id and player_id = v_decision.deciding_player_id;
        if coalesce(v_px_pool, 0) < v_px_amount then
          raise exception 'Not enough {%} mana: have %', v_px_color, coalesce(v_px_pool, 0);
        end if;
        update public.game_players
        set mana_pool = jsonb_set(mana_pool, array[v_px_color], to_jsonb(v_px_pool - v_px_amount))
        where session_id = v_decision.session_id and player_id = v_decision.deciding_player_id;
        perform public.apply_damage_allocations(v_decision.session_id,
          jsonb_build_array(
            case when (p_result ->> 'game_card_id') is not null
                 then jsonb_build_object('game_card_id', p_result ->> 'game_card_id', 'amount', v_px_amount)
                 else jsonb_build_object('player_id', p_result ->> 'player_id', 'amount', v_px_amount) end));
      end if;
    end;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'become_copy' then
    -- Become-copy pick (mig 240): an empty submit declines the "may"; a pick
    -- turns the SOURCE card into a copy of it (until end of turn for Sarkhan).
    if cardinality(v_chosen_ids) > 0 then
      select source_card_id into v_src_card from public.game_stack_items where id = v_decision.source_stack_item_id;
      perform public.become_copy(
        v_decision.session_id, v_src_card, v_chosen_ids[1],
        v_decision.params -> 'except',
        coalesce((v_decision.params ->> 'until_end_of_turn')::boolean, false),
        coalesce((v_decision.params ->> 'fire_etb')::boolean, false));
    end if;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'choose_player' then
    v_chosen_player := nullif(v_decision.result ->> 'player_id', '')::uuid;
    select source_card_id into v_src_card from public.game_stack_items where id = v_decision.source_stack_item_id;
    select coalesce(jsonb_agg(e.value || jsonb_build_object('recipient', 'controller')), '[]'::jsonb)
      into v_effects_rewritten
    from jsonb_array_elements(coalesce(v_decision.params -> 'effects', '[]'::jsonb)) e;
    perform public.apply_triggered_ability_effects(v_decision.session_id, v_chosen_player, v_src_card, v_effects_rewritten);
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'choose_color' then
    -- Heraldic Banner (mig 209): register the colour-filtered anthem with the
    -- chosen colour. Source = the deciding card; battlefield-gated so it goes
    -- inert when the source leaves; NOT script-flagged so rebuilds keep it.
    select source_card_id into v_src_card from public.game_stack_items where id = v_decision.source_stack_item_id;
    if v_decision.params -> 'anthem' is not null and v_src_card is not null then
      insert into public.game_continuous_effects (
        session_id, source_card_id, affected_player_id, effect_type, payload, source_zone_required)
      values (
        v_decision.session_id, v_src_card,
        case when lower(coalesce(v_decision.params -> 'anthem' ->> 'scope', 'controller')) = 'all'
             then null else v_decision.deciding_player_id end,
        'pump',
        jsonb_build_object(
          'power', coalesce((v_decision.params -> 'anthem' ->> 'power')::integer, 0),
          'toughness', coalesce((v_decision.params -> 'anthem' ->> 'toughness')::integer, 0),
          'color', lower(v_decision.result ->> 'color')),
        'battlefield');
    end if;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'choose_creature_type' then
    v_chosen_type := nullif(v_decision.result ->> 'type', '');
    select source_card_id into v_src_card from public.game_stack_items where id = v_decision.source_stack_item_id;
    -- Persist the chosen type into the source card's own script when it uses
    -- the '$chosen' placeholder (mig 239, Reflections of Littjara: its
    -- spell_cast watcher's type filter becomes the chosen type). The baked
    -- script lands in copied_script, which effective_script prefers and which
    -- survives rebuilds. The chosen type comes from the curated options list,
    -- so the text substitution is safe.
    if v_src_card is not null then
      v_eff_script := public.effective_script(v_decision.session_id, v_src_card);
      if v_eff_script is not null and v_eff_script::text like '%"$chosen"%' then
        update public.game_cards
        set copied_script = replace(v_eff_script::text, '"$chosen"', to_jsonb(v_chosen_type)::text)::jsonb
        where id = v_src_card and session_id = v_decision.session_id;
      end if;
    end if;
    -- Inject the chosen type into any count-based amount's type_line (Distant Melody)
    -- and into a pump_all's creature_type (Crippling Fear: "creatures that aren't the
    -- chosen type get -3/-3 until end of turn").
    select coalesce(jsonb_agg(
      case
        when jsonb_typeof(e.value -> 'amount') = 'object' and (e.value -> 'amount') ? 'count'
          then jsonb_set(e.value, '{amount,type_line}', to_jsonb(v_chosen_type))
        when lower(coalesce(e.value ->> 'type', '')) = 'pump_all'
          then jsonb_set(e.value, '{creature_type}', to_jsonb(v_chosen_type))
        else e.value end
    ), '[]'::jsonb)
      into v_effects_rewritten
    from jsonb_array_elements(coalesce(v_decision.params -> 'effects', '[]'::jsonb)) e;
    -- pump_all effects insert a temporary until-EOT mass pump (helper); the rest
    -- resolve through the normal pipeline.
    for v_pe in select value from jsonb_array_elements(v_effects_rewritten) where lower(coalesce(value ->> 'type', '')) = 'pump_all'
    loop
      perform public.apply_mass_pump_until_eot(v_decision.session_id, v_src_card, v_decision.deciding_player_id, v_pe);
    end loop;
    select coalesce(jsonb_agg(value), '[]'::jsonb) into v_effects_rewritten
    from jsonb_array_elements(v_effects_rewritten) where lower(coalesce(value ->> 'type', '')) <> 'pump_all';
    if jsonb_array_length(v_effects_rewritten) > 0 then
      perform public.apply_triggered_ability_effects(v_decision.session_id, v_decision.deciding_player_id, v_src_card, v_effects_rewritten);
    end if;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);
  end if;

  return v_decision;
end;
$$;
grant execute on function public.submit_decision(uuid, jsonb) to authenticated;
