-- Intimidate + hexproof enforcement.
--   Intimidate ("can't be blocked except by artifact creatures and/or creatures
--     that share a colour with it") — a per-blocker legality check in declare_blocker,
--     next to the flying/protection gates, reusing game_card_color_set.
--   Hexproof ("can't be the target of spells or abilities your opponents control")
--     — a targeting gate in put_action_on_stack, next to the protection check: an
--     opponent can't target a hexproof permanent.
-- Both: a new continuous-effect type (CHECK + register's 3 lists) + an accessor
-- (mig 184 pattern). (IDE T-SQL false-positives on $$ bodies — ignore.)

alter table public.game_continuous_effects
  drop constraint if exists game_continuous_effects_effect_type_check;
alter table public.game_continuous_effects
  add constraint game_continuous_effects_effect_type_check
  check (effect_type = any (array[
    'mana_does_not_empty', 'additional_land_plays', 'haste', 'vigilance',
    'indestructible', 'trample', 'first_strike', 'double_strike', 'flying',
    'reach', 'deathtouch', 'pump', 'control', 'set_pt', 'protection', 'switch_pt',
    'infect', 'wither', 'toxic', 'cast_from_graveyard', 'menace',
    'intimidate', 'hexproof'
  ]));

create or replace function public.card_has_intimidate(p_session_id uuid, p_game_card_id uuid)
returns boolean language sql security definer set search_path = public as $$
  select exists (
    select 1
    from public.game_continuous_effects effects
    left join public.game_cards source_card on source_card.id = effects.source_card_id
    left join public.game_cards tc on tc.id = p_game_card_id
    left join public.cards tcard on tcard.id = tc.card_id
    where effects.session_id = p_session_id
      and effects.effect_type = 'intimidate'
      and (
        effects.affected_card_id = p_game_card_id
        or (
          effects.affected_card_id is null
          and (effects.affected_player_id is null
               or effects.affected_player_id = coalesce(tc.controller_player_id, tc.owner_id))
          and (effects.payload ->> 'creature_type' is null
               or tcard.type_line ilike '%' || (effects.payload ->> 'creature_type') || '%')
        )
      )
      and (effects.source_zone_required is null or source_card.zone = effects.source_zone_required)
  );
$$;
grant execute on function public.card_has_intimidate(uuid, uuid) to authenticated, service_role;

create or replace function public.card_has_hexproof(p_session_id uuid, p_game_card_id uuid)
returns boolean language sql security definer set search_path = public as $$
  select exists (
    select 1
    from public.game_continuous_effects effects
    left join public.game_cards source_card on source_card.id = effects.source_card_id
    left join public.game_cards tc on tc.id = p_game_card_id
    left join public.cards tcard on tcard.id = tc.card_id
    where effects.session_id = p_session_id
      and effects.effect_type = 'hexproof'
      and (
        effects.affected_card_id = p_game_card_id
        or (
          effects.affected_card_id is null
          and (effects.affected_player_id is null
               or effects.affected_player_id = coalesce(tc.controller_player_id, tc.owner_id))
          and (effects.payload ->> 'creature_type' is null
               or tcard.type_line ilike '%' || (effects.payload ->> 'creature_type') || '%')
        )
      )
      and (effects.source_zone_required is null or source_card.zone = effects.source_zone_required)
  );
$$;
grant execute on function public.card_has_hexproof(uuid, uuid) to authenticated, service_role;

-- register_card_continuous_effects reproduced from mig 194 (latest) + intimidate/hexproof.
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
      'hexproof'
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

-- declare_blocker reproduced from mig 133 + an intimidate legality gate.
create or replace function public.declare_blocker(
  p_session_id uuid, p_blocker_card_id uuid, p_attacker_card_id uuid
) returns public.game_combat_assignments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_assignment public.game_combat_assignments;
  v_blocker_type_line text;
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
    raise exception 'Cannot declare blockers in a finished game session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if v_turn_state.step <> 'declare_blockers' then
    raise exception 'Blockers can only be declared during Declare Blockers Step';
  end if;

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can declare blockers';
  end if;

  select *
  into v_assignment
  from public.game_combat_assignments
  where session_id = p_session_id
    and turn_number = v_turn_state.turn_number
    and attacker_card_id = p_attacker_card_id
  for update;

  if not found then
    raise exception 'Attacker assignment not found';
  end if;

  if v_assignment.defending_player_id <> auth.uid() then
    raise exception 'Only the defending player can block this attacker';
  end if;

  perform 1
  from public.game_combat_blockers
  where session_id = p_session_id
    and turn_number = v_turn_state.turn_number
    and blocker_card_id = p_blocker_card_id;

  if found then
    raise exception 'This blocker is already assigned';
  end if;

  select cards.type_line
  into v_blocker_type_line
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_blocker_card_id
    and game_cards.session_id = p_session_id
    and coalesce(game_cards.controller_player_id, game_cards.owner_id) = auth.uid()
    and game_cards.zone = 'battlefield'
    and game_cards.is_tapped = false;

  if not found then
    raise exception 'Blocker card not found, not on battlefield, not controlled by defending player, or already tapped';
  end if;

  if coalesce(v_blocker_type_line, '') not ilike '%creature%' then
    raise exception 'Only creatures can be declared as blockers';
  end if;

  -- Flying legality: only flying or reach creatures can block a flying attacker.
  if public.card_has_flying(p_session_id, p_attacker_card_id) then
    if not (
      public.card_has_flying(p_session_id, p_blocker_card_id) or
      public.card_has_reach(p_session_id, p_blocker_card_id)
    ) then
      raise exception 'Only creatures with flying or reach can block a flying creature';
    end if;
  end if;

  -- Protection: an attacker with protection from the blocker's colour can't be
  -- blocked by it.
  if public.card_has_protection_from_any(
       p_session_id, p_attacker_card_id,
       public.game_card_color_set(p_session_id, p_blocker_card_id)
     ) then
    raise exception 'Attacker has protection from this blocker''s colour and cannot be blocked by it';
  end if;

  -- Intimidate: only artifact creatures and/or creatures sharing a colour with the
  -- attacker can block it.
  if public.card_has_intimidate(p_session_id, p_attacker_card_id) then
    if not (
      exists (
        select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.id = p_blocker_card_id and gc.session_id = p_session_id and c.type_line ilike '%artifact%'
      )
      or public.game_card_color_set(p_session_id, p_blocker_card_id)
         && public.game_card_color_set(p_session_id, p_attacker_card_id)
    ) then
      raise exception 'An intimidating creature can only be blocked by artifact creatures or creatures that share a colour with it';
    end if;
  end if;

  insert into public.game_combat_blockers (
    assignment_id,
    session_id,
    turn_number,
    attacker_card_id,
    blocker_card_id,
    blocking_player_id
  )
  values (
    v_assignment.id,
    p_session_id,
    v_turn_state.turn_number,
    p_attacker_card_id,
    p_blocker_card_id,
    auth.uid()
  );

  update public.game_combat_assignments
  set blocker_card_id = coalesce(blocker_card_id, p_blocker_card_id)
  where id = v_assignment.id
  returning * into v_assignment;

  return v_assignment;
end;
$$;

grant execute on function public.declare_blocker(uuid, uuid, uuid) to anon, authenticated, service_role;

-- put_action_on_stack reproduced from mig 131 + a hexproof targeting gate.
create or replace function public.put_action_on_stack(
  p_session_id uuid,
  p_action_type text,
  p_payload jsonb,
  p_source_card_id uuid default null
)
returns public.game_stack_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_action_timing text;
  v_target_controller text;
  v_source_type_line text;
  v_source_zone text;
  v_source_mana_cost text;
  v_generic_payment jsonb;
  v_x_value integer;
  v_pending_stack_count integer;
  v_next_graveyard_position integer;
  v_next_position integer;
  v_builder_fn text;
  v_built_payload jsonb;
  v_stack_item public.game_stack_items;
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
    raise exception 'Cannot put actions on the stack in a finished game session';
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
    raise exception 'Only the priority player can put actions on the stack';
  end if;

  select builder_fn
  into v_builder_fn
  from public.stack_action_handlers
  where action_type = p_action_type;

  if v_builder_fn is null then
    raise exception 'Unsupported stack action type: %', p_action_type;
  end if;

  if p_source_card_id is not null then
    select cards.type_line, cards.mana_cost, game_cards.zone
    into v_source_type_line, v_source_mana_cost, v_source_zone
    from public.game_cards
    join public.cards
      on cards.id = game_cards.card_id
    where game_cards.id = p_source_card_id
      and game_cards.session_id = p_session_id
      and game_cards.owner_id = auth.uid();

    if not found then
      raise exception 'Source card not found or not owned by current user';
    end if;
  end if;

  v_action_timing := lower(nullif(p_payload ->> 'timing', ''));

  if v_action_timing is null then
    if v_source_type_line ilike '%instant%' then
      v_action_timing := 'instant';
    elsif v_source_type_line ilike '%sorcery%' then
      v_action_timing := 'sorcery';
    else
      raise exception 'Action timing is required for non-Instant and non-Sorcery sources';
    end if;
  end if;

  if v_action_timing not in ('instant', 'sorcery') then
    raise exception 'Unsupported action timing: %', v_action_timing;
  end if;

  if p_action_type = 'counter_spell' and v_action_timing <> 'instant' then
    raise exception 'Counterspell actions must use instant timing';
  end if;

  if v_action_timing = 'sorcery' then
    if v_turn_state.active_player_id <> auth.uid() then
      raise exception 'Sorcery actions can only be used by the active player';
    end if;

    if v_turn_state.step not in ('precombat_main', 'postcombat_main') then
      raise exception 'Sorcery actions can only be used during a main phase';
    end if;

    select count(*)
    into v_pending_stack_count
    from public.game_stack_items
    where session_id = p_session_id
      and status = 'pending';

    if v_pending_stack_count > 0 then
      raise exception 'Sorcery actions can only be used while the stack is empty';
    end if;
  end if;

  v_generic_payment := p_payload -> 'generic_payment';
  v_x_value := coalesce((p_payload ->> 'x_value')::integer, 0);
  v_target_controller := coalesce(lower(nullif(p_payload ->> 'target_controller', '')), 'any');

  execute format('select public.%I($1, $2, $3, $4, $5)', v_builder_fn)
    into v_built_payload
    using p_session_id, auth.uid(), p_payload, v_action_timing, v_target_controller;

  -- Protection (CR 702.16e): a creature with protection from any of the source's
  -- colours can't be targeted. The target rode through the builder as target_card_id.
  if v_built_payload ? 'target_card_id'
     and public.card_has_protection_from_any(
           p_session_id,
           nullif(v_built_payload ->> 'target_card_id', '')::uuid,
           public.card_color_set(v_source_mana_cost))
  then
    raise exception 'Target has protection from this spell''s colour';
  end if;

  -- Hexproof: a permanent can't be targeted by a spell/ability an OPPONENT controls
  -- (the actor here is auth.uid(); you can still target your own hexproof permanents).
  if v_built_payload ? 'target_card_id'
     and public.card_has_hexproof(p_session_id, nullif(v_built_payload ->> 'target_card_id', '')::uuid)
     and (select coalesce(gc.controller_player_id, gc.owner_id)
          from public.game_cards gc
          where gc.id = nullif(v_built_payload ->> 'target_card_id', '')::uuid
            and gc.session_id = p_session_id) is distinct from auth.uid()
  then
    raise exception 'Target has hexproof and can''t be targeted by an opponent';
  end if;

  if p_source_card_id is not null and v_source_zone = 'hand' then
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_source_mana_cost, v_generic_payment, v_x_value);
  end if;

  select coalesce(max(position), -1) + 1
  into v_next_position
  from public.game_stack_items
  where session_id = p_session_id;

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
    p_source_card_id,
    p_action_type,
    v_built_payload,
    v_next_position
  )
  returning * into v_stack_item;

  if p_source_card_id is not null
    and v_source_zone = 'hand'
    and (
      v_source_type_line ilike '%instant%'
      or v_source_type_line ilike '%sorcery%'
    )
  then
    select coalesce(max(zone_position), -1) + 1
    into v_next_graveyard_position
    from public.game_cards
    where session_id = p_session_id
      and owner_id = auth.uid()
      and zone = 'graveyard';

    update public.game_cards
    set
      zone = 'graveyard',
      zone_position = v_next_graveyard_position,
      is_tapped = false,
      damage_marked = 0
    where id = p_source_card_id;
  end if;

  return v_stack_item;
end;
$$;

grant execute on function public.put_action_on_stack(uuid, text, jsonb, uuid) to authenticated;
