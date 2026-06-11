-- 202605010251_reality_shift_manifest — Reality Shift (manifest).
--   • exile_and_manifest (targeted creature effect): exile the target; its
--     CONTROLLER manifests the top card of their library — it enters as a
--     blank 2/2 (manifested marker + copied_script {} + an unexpiring set_pt
--     row). register_card_continuous_effects skips manifested cards so the
--     printed keywords stay off across rebuilds.
--   • turn_manifest_up(session, card, generic): flips a manifested CREATURE
--     card face up for its printed mana cost — clears the marker/blank
--     script/2/2 row and re-registers the real effects. Not a zone change,
--     so no ETB fires (rules-correct).
-- Approximation: the manifested card's identity is not visually hidden from
-- the table (client concern).
-- Generated from supabase/functions_src (apply_creature_effect, trigger_effect_target_type, register_card_continuous_effects, turn_manifest_up) — those files are
-- the canonical current definitions; edit them, not past migrations.

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
      'first_strike', 'double_strike', 'deathtouch', 'indestructible'
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

create or replace function public.trigger_effect_target_type(p_effect jsonb)
returns jsonb language sql immutable as $$
  select case
    when lower(coalesce(p_effect ->> 'type', '')) in
         ('deal_damage', 'destroy', 'exile', 'bounce', 'tap', 'untap',
          'add_counters', 'grant_keyword', 'fight', 'gain_control', 'set_pt', 'pump', 'goad',
          'exile_and_manifest')
         and public.behavior_target_type_is_creature_only(p_effect -> 'target_type')
      then '"creature"'::jsonb
    when lower(coalesce(p_effect ->> 'type', '')) in
         ('destroy', 'exile', 'bounce', 'tap', 'untap', 'shuffle_into_library', 'gain_control')
         and public.behavior_target_type_is_permanent_only(p_effect -> 'target_type')
      then p_effect -> 'target_type'
    else null
  end;
$$;
grant all on function public.trigger_effect_target_type(jsonb) to anon, authenticated, service_role;

create or replace function public.register_card_continuous_effects(
  p_session_id uuid, p_source_card_id uuid
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source_card public.game_cards;
  v_script jsonb;
  v_keywords jsonb;
  v_keyword text;
  v_keyword_effect_type text;
  v_effect jsonb;
  v_effect_type text;
  v_affected text;
  v_affected_player_id uuid;
  v_affected_card_id uuid;
  v_source_zone_required text;
  v_payload jsonb;
  v_registered_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select game_cards.*
  into v_source_card
  from public.game_cards
  where game_cards.id = p_source_card_id
    and game_cards.session_id = p_session_id;

  if not found then
    raise exception 'Source card not found';
  end if;

  delete from public.game_continuous_effects
  where session_id = p_session_id
    and source_card_id = p_source_card_id
    and payload ->> 'registered_from_card_script' = 'true';

  if v_source_card.zone <> 'battlefield' or v_source_card.static_effects_suppressed then
    return 0;
  end if;

  -- A manifested (face-down) card has no abilities and no printed keywords
  -- (mig 251, Reality Shift); its 2/2 set_pt row is not script-flagged, so
  -- the delete above leaves it alone.
  if coalesce(v_source_card.counters, '{}'::jsonb) ? 'manifested' then
    return 0;
  end if;

  v_script := public.effective_script(p_session_id, p_source_card_id);

  select coalesce(cards.keywords, '[]'::jsonb)
  into v_keywords
  from public.cards
  where cards.id = v_source_card.card_id;

  for v_effect in
    select value
    from jsonb_array_elements(coalesce(v_script -> 'continuous_effects', '[]'::jsonb))
  loop
    v_effect_type := coalesce(v_effect ->> 'effect_type', v_effect ->> 'type');

    if v_effect_type not in (
      'mana_does_not_empty',
      'additional_land_plays',
      'haste',
      'vigilance',
      'indestructible',
      'trample',
      'first_strike',
      'double_strike',
      'flying',
      'reach',
      'deathtouch',
      'protection',
      'pump',
      'infect',
      'wither',
      'toxic',
      'menace',
      'intimidate',
      'hexproof',
      -- STATIC cast-from-graveyard permission (mig 207, Gisa and Geralf): a
      -- script-registered row, swept by rebuild when the source leaves — unlike
      -- the until-EOT grant_cast_from_graveyard effect rows (mig 173).
      'cast_from_graveyard',
      -- STATIC cost reduction (mig 231, Dragonlord's Servant / Sarkhan): payload
      -- {type_line, amount}; reduced_mana_cost sums these for the caster. Defaults
      -- to affected:'controller' (not a source-keyword), so affected_player_id is
      -- the controller.
      'cost_reduction',
      -- STATIC cast-from-the-top-of-your-library permission (mig 244,
      -- Thundermane Dragon): payload {creature, min_power, grant_haste};
      -- cast_card_from_hand's library gate consumes it.
      'cast_from_library_top'
    ) then
      raise exception 'Unsupported continuous effect type: %', v_effect_type;
    end if;

    v_affected := coalesce(
      v_effect ->> 'affected',
      case
        when v_effect_type in (
          'haste',
          'vigilance',
          'indestructible',
          'trample',
          'first_strike',
          'double_strike',
          'flying',
          'reach',
          'deathtouch',
          'protection',
          'infect',
          'wither',
          'toxic',
          'menace',
          'intimidate',
          'hexproof'
        ) then 'source'
        else 'controller'
      end
    );
    v_affected_player_id := null;
    v_affected_card_id := null;

    if v_affected in ('all', 'all_players') then
      v_affected_player_id := null;
    elsif v_affected in ('controller', 'self') then
      v_affected_player_id := coalesce(v_source_card.controller_player_id, v_source_card.owner_id);
    elsif v_affected in ('source', 'this') then
      v_affected_card_id := p_source_card_id;
    elsif v_affected in ('attached', 'host', 'enchanted', 'equipped') then
      -- Aura/Equipment: the effect lands on the host. Unattached → grants nothing.
      v_affected_card_id := v_source_card.attached_to;
      if v_affected_card_id is null then
        continue;
      end if;
    else
      raise exception 'Unsupported continuous effect affected value: %', v_affected;
    end if;

    v_source_zone_required := coalesce(v_effect ->> 'source_zone_required', 'battlefield');

    if v_source_zone_required not in ('library', 'hand', 'stack', 'battlefield', 'graveyard', 'exile') then
      raise exception 'Unsupported source zone requirement: %', v_source_zone_required;
    end if;

    if v_effect_type = 'additional_land_plays' then
      v_payload := jsonb_build_object(
        'amount',
        coalesce((v_effect ->> 'amount')::integer, 1)
      );
    elsif v_effect_type = 'mana_does_not_empty' then
      v_payload := jsonb_build_object(
        'colors',
        coalesce(v_effect -> 'colors', '[]'::jsonb)
      );
    elsif v_effect_type = 'protection' then
      v_payload := jsonb_build_object(
        'from',
        lower(coalesce(v_effect ->> 'from', v_effect ->> 'color'))
      );
    elsif v_effect_type = 'toxic' then
      v_payload := jsonb_build_object(
        'amount',
        greatest(1, coalesce((v_effect ->> 'amount')::integer, 1))
      );
    else
      v_payload := '{}'::jsonb;
    end if;

    v_payload := coalesce(v_effect -> 'payload', v_payload)
      || jsonb_build_object('registered_from_card_script', true);

    insert into public.game_continuous_effects (
      session_id,
      source_card_id,
      affected_player_id,
      affected_card_id,
      effect_type,
      payload,
      source_zone_required,
      expires_at_turn_number,
      expires_at_phase,
      expires_at_step
    )
    values (
      p_session_id,
      p_source_card_id,
      v_affected_player_id,
      v_affected_card_id,
      v_effect_type,
      v_payload,
      v_source_zone_required,
      nullif(v_effect ->> 'expires_at_turn_number', '')::integer,
      nullif(v_effect ->> 'expires_at_phase', ''),
      nullif(v_effect ->> 'expires_at_step', '')
    );

    v_registered_count := v_registered_count + 1;
  end loop;

  for v_keyword in
    select lower(replace(replace(keyword, ' ', '_'), '-', '_'))
    from jsonb_array_elements_text(v_keywords) as keyword
  loop
    v_keyword_effect_type := case v_keyword
      when 'haste'         then 'haste'
      when 'vigilance'     then 'vigilance'
      when 'indestructible' then 'indestructible'
      when 'trample'       then 'trample'
      when 'first_strike'  then 'first_strike'
      when 'double_strike' then 'double_strike'
      when 'flying'        then 'flying'
      when 'reach'         then 'reach'
      when 'deathtouch'    then 'deathtouch'
      when 'infect'        then 'infect'
      when 'wither'        then 'wither'
      when 'menace'        then 'menace'
      when 'intimidate'    then 'intimidate'
      when 'hexproof'      then 'hexproof'
      else null
    end;

    if v_keyword_effect_type is null then
      continue;
    end if;

    insert into public.game_continuous_effects (
      session_id,
      source_card_id,
      affected_card_id,
      effect_type,
      payload,
      source_zone_required
    )
    values (
      p_session_id,
      p_source_card_id,
      p_source_card_id,
      v_keyword_effect_type,
      jsonb_build_object('registered_from_card_script', true, 'registered_from_keywords', true),
      'battlefield'
    );

    v_registered_count := v_registered_count + 1;
  end loop;

  return v_registered_count;
end;
$$;
grant execute on function public.register_card_continuous_effects(uuid, uuid) to authenticated, service_role;

create or replace function public.turn_manifest_up(
  p_session_id uuid,
  p_game_card_id uuid,
  p_generic_payment jsonb default null
) returns public.game_cards
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card public.game_cards;
  v_type text;
  v_cost text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select gc.* into v_card
  from public.game_cards gc
  where gc.id = p_game_card_id and gc.session_id = p_session_id
    and gc.zone = 'battlefield'
    and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
  for update;
  if not found then
    raise exception 'Card not found on your battlefield';
  end if;
  if not (coalesce(v_card.counters, '{}'::jsonb) ? 'manifested') then
    raise exception 'That card is not manifested';
  end if;

  select c.type_line, c.mana_cost into v_type, v_cost
  from public.cards c where c.id = v_card.card_id;
  if coalesce(v_type, '') not ilike '%creature%' then
    raise exception 'Only a creature card can be turned face up';
  end if;

  if v_cost is not null and btrim(v_cost) <> '' then
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_cost, p_generic_payment);
  end if;

  delete from public.game_continuous_effects
  where session_id = p_session_id and source_card_id = p_game_card_id;

  update public.game_cards
  set counters = counters - 'manifested',
      copied_script = null
  where id = p_game_card_id and session_id = p_session_id
  returning * into v_card;

  perform public.register_card_continuous_effects(p_session_id, p_game_card_id);

  return v_card;
end;
$$;
grant execute on function public.turn_manifest_up(uuid, uuid, jsonb) to authenticated;
