-- Phase 0 (rules-engine cleanup): centralize the "effective script" accessor.
--
-- Until now, every function that needed a game card's behavior script inlined
-- the same expression: coalesce(game_cards.copied_script, cards.script) joined
-- against public.cards. That duplication lived in ~3 live functions
-- (register_card_continuous_effects, activate_ability, fire_card_triggers) and
-- meant the rule "which script is in effect for this permanent" was encoded in
-- several places at once.
--
-- This migration introduces a single accessor, public.effective_script(session,
-- game_card), and routes those three callers through it. Behavior is unchanged:
-- the accessor returns exactly coalesce(copied_script, cards.script) today. It
-- is the one place that face-selection logic for double-faced cards (active
-- front/back face -> face-specific script) will later live, so DFC support
-- becomes a change to this function rather than to every consumer.
--
-- (The IDE's SQL diagnostics use a T-SQL parser and flag the $$ function bodies
-- below as errors; those are false positives on PostgreSQL.)

-- The accessor. STABLE + SECURITY DEFINER mirrors the existing definer functions
-- that call it (they run as the function owner; this keeps the read consistent
-- regardless of caller). Returns null when the card does not exist in the
-- session, matching the previous inline "select into" semantics.
create or replace function public.effective_script(
  p_session_id uuid,
  p_game_card_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_script jsonb;
begin
  select coalesce(game_cards.copied_script, cards.script)
  into v_script
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id;

  return v_script;
end;
$$;

grant execute on function public.effective_script(uuid, uuid) to authenticated;

-- 1. register_card_continuous_effects (latest: migration 067) -- reproduced
-- verbatim except the script fetch now uses the accessor. Keywords are still
-- read from public.cards (they are base-card data, not part of the script).
create or replace function public.register_card_continuous_effects(
  p_session_id uuid,
  p_source_card_id uuid
)
returns integer
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
      'deathtouch'
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
          'deathtouch'
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

-- 2. activate_ability (latest: migration 072) -- reproduced verbatim except the
-- script fetch. The ownership/zone check is preserved exactly; the join to
-- public.cards existed only to read the script, which now comes from the accessor.
create or replace function public.activate_ability(
  p_session_id uuid,
  p_source_card_id uuid,
  p_ability_index integer default 0,
  p_target_player_id uuid default null,
  p_target_card_id uuid default null,
  p_generic_payment jsonb default null
)
returns public.game_stack_items
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
  v_has_tap boolean := false;
  v_mana_cost text := null;
  v_amount integer;
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

  if v_zone <> 'battlefield' then
    raise exception 'Ability source must be on the battlefield';
  end if;

  v_script := public.effective_script(p_session_id, p_source_card_id);

  v_ability := v_script -> 'activated_abilities' -> p_ability_index;

  if v_ability is null then
    raise exception 'Activated ability not found at index %', p_ability_index;
  end if;

  if coalesce((v_ability ->> 'is_mana_ability')::boolean, false) then
    raise exception 'Use the mana ability flow for mana abilities';
  end if;

  -- Parse costs
  for v_cost in select * from jsonb_array_elements(coalesce(v_ability -> 'costs', '[]'::jsonb))
  loop
    case v_cost ->> 'type'
      when 'tap_self' then v_has_tap := true;
      when 'mana' then v_mana_cost := v_cost ->> 'amount';
      else raise exception 'Unsupported ability cost: %', v_cost ->> 'type';
    end case;
  end loop;

  -- Tap cost requires the source to be untapped
  if v_has_tap and exists (
    select 1 from public.game_cards where id = p_source_card_id and is_tapped = true
  ) then
    raise exception 'Source is already tapped';
  end if;

  -- Pay mana cost (raises if the player cannot pay)
  if v_mana_cost is not null then
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_mana_cost, p_generic_payment);
  end if;

  -- Pay the tap cost
  if v_has_tap then
    update public.game_cards
    set is_tapped = true
    where id = p_source_card_id and session_id = p_session_id;
  end if;

  -- Apply the (single) effect by putting it on the stack
  v_effect := v_ability -> 'effects' -> 0;

  if v_effect is null then
    raise exception 'Activated ability has no effect';
  end if;

  if v_effect ->> 'type' = 'deal_damage' then
    v_amount := coalesce((v_effect ->> 'amount')::integer, 0);
    if v_amount <= 0 then
      raise exception 'Invalid damage amount';
    end if;

    if p_target_card_id is not null then
      v_stack := public.put_action_on_stack(
        p_session_id,
        'deal_damage_creature',
        jsonb_build_object('target_card_id', p_target_card_id, 'amount', v_amount, 'timing', 'instant'),
        p_source_card_id
      );
    elsif p_target_player_id is not null then
      v_stack := public.put_action_on_stack(
        p_session_id,
        'deal_damage_player',
        jsonb_build_object('target_player_id', p_target_player_id, 'amount', v_amount, 'timing', 'instant'),
        p_source_card_id
      );
    else
      raise exception 'A target is required for this ability';
    end if;
  else
    raise exception 'Unsupported ability effect: %', v_effect ->> 'type';
  end if;

  return v_stack;
end;
$$;

grant execute on function public.activate_ability(uuid, uuid, integer, uuid, uuid, jsonb) to authenticated;

-- 3. fire_card_triggers (latest: migration 077) -- reproduced verbatim except
-- the script fetch. Controller + card name are still read from the joined row;
-- the script now comes from the accessor.
create or replace function public.fire_card_triggers(
  p_session_id uuid,
  p_game_card_id uuid,
  p_events text[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_controller uuid;
  v_card_name text;
  v_script jsonb;
  v_ability jsonb;
  v_event text;
begin
  select
    coalesce(game_cards.controller_player_id, game_cards.owner_id),
    cards.name
  into v_controller, v_card_name
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id;

  v_script := public.effective_script(p_session_id, p_game_card_id);

  if v_script is null or not (v_script ? 'triggered_abilities') then
    return;
  end if;

  for v_ability in
    select * from jsonb_array_elements(v_script -> 'triggered_abilities')
  loop
    v_event := lower(coalesce(v_ability ->> 'event', ''));

    if v_event = any (p_events) then
      perform public.enqueue_triggered_ability(
        p_session_id,
        v_controller,
        p_game_card_id,
        coalesce(v_card_name, v_ability ->> 'id', v_event),
        v_ability -> 'effects'
      );
    end if;
  end loop;
end;
$$;
