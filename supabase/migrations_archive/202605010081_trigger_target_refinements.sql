-- Phase 3: refine targeted-creature triggers and spells.
--
-- Two fixes layered on migrations 079 (spell effects) + 080 (targeted ETB):
--
--   1. "Any target" damage triggers are no longer dropped. A triggered effect
--      only counts as a chosen creature target when its target_type is *exactly*
--      "creature" (creature-only). "deal damage to any target" (target_type
--      includes player/any) now falls through to the auto-resolved each_opponent
--      path instead of requiring — and, when no creature exists, silently
--      discarding — the trigger.
--
--   2. Controller restriction ("an opponent controls" / "you control"). Targeted
--      creature effects may carry "target_controller": opponent|you (default any).
--      Enforced in enqueue (existence check), choose_triggered_ability_creature_target,
--      resolve_top_of_stack's fizzle guard, and put_action_on_stack (spell casts).

-- ─── Target-type / controller helpers ────────────────────────────────────────

-- A creature-only target_type: the single string "creature", or an array whose
-- every element is "creature". "any" / arrays containing player/any do not match.
create or replace function public.behavior_target_type_is_creature_only(
  p_target_type jsonb
)
returns boolean
language sql
immutable
as $$
  select
    case
      when p_target_type is null then false
      when jsonb_typeof(p_target_type) = 'string' then
        lower(trim(both '"' from p_target_type::text)) = 'creature'
      when jsonb_typeof(p_target_type) = 'array' then
        jsonb_array_length(p_target_type) > 0
        and not exists (
          select 1
          from jsonb_array_elements_text(p_target_type) as t(value)
          where lower(t.value) <> 'creature'
        )
      else false
    end;
$$;

-- Normalise an effect's target_controller to 'any' | 'opponent' | 'you'.
create or replace function public.behavior_target_controller(
  p_effect jsonb
)
returns text
language sql
immutable
as $$
  select case lower(coalesce(p_effect ->> 'target_controller', ''))
    when 'opponent' then 'opponent'
    when 'you' then 'you'
    when 'self' then 'you'
    when 'controller' then 'you'
    else 'any'
  end;
$$;

-- Redefine: a trigger effect requires a chosen creature target only when it is a
-- creature-targeting effect type AND its target_type is creature-only.
create or replace function public.trigger_effect_requires_creature_target(
  p_effect jsonb
)
returns boolean
language sql
immutable
as $$
  select
    lower(coalesce(p_effect ->> 'type', '')) in (
      'deal_damage',
      'destroy',
      'bounce',
      'tap',
      'untap',
      'add_counters'
    )
    and public.behavior_target_type_is_creature_only(p_effect -> 'target_type');
$$;

-- The target_controller for a trigger = controller of its first creature-target
-- effect (the engine resolves one shared creature target per trigger).
create or replace function public.trigger_effects_target_controller(
  p_effects jsonb
)
returns text
language sql
immutable
as $$
  select public.behavior_target_controller(effects.effect)
  from jsonb_array_elements(coalesce(p_effects, '[]'::jsonb)) as effects(effect)
  where public.trigger_effect_requires_creature_target(effects.effect)
  limit 1;
$$;

-- Does the session contain at least one battlefield creature this controller may
-- legally target, given the controller restriction?
create or replace function public.session_has_targetable_creature(
  p_session_id uuid,
  p_controller_id uuid,
  p_target_controller text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.game_cards gc
    join public.cards c on c.id = gc.card_id
    where gc.session_id = p_session_id
      and gc.zone = 'battlefield'
      and c.type_line ilike '%creature%'
      and (
        coalesce(p_target_controller, 'any') = 'any'
        or (p_target_controller = 'opponent' and gc.controller_player_id is distinct from p_controller_id)
        or (p_target_controller = 'you' and gc.controller_player_id = p_controller_id)
      )
  );
$$;

-- Is a specific card a legal creature target for this controller + restriction?
create or replace function public.creature_target_controller_ok(
  p_session_id uuid,
  p_target_card_id uuid,
  p_controller_id uuid,
  p_target_controller text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.game_cards gc
    join public.cards c on c.id = gc.card_id
    where gc.id = p_target_card_id
      and gc.session_id = p_session_id
      and gc.zone = 'battlefield'
      and c.type_line ilike '%creature%'
      and (
        coalesce(p_target_controller, 'any') = 'any'
        or (p_target_controller = 'opponent' and gc.controller_player_id is distinct from p_controller_id)
        or (p_target_controller = 'you' and gc.controller_player_id = p_controller_id)
      )
  );
$$;

-- ─── enqueue_triggered_ability: store + honour target_controller ──────────────

create or replace function public.enqueue_triggered_ability(
  p_session_id uuid,
  p_controller_id uuid,
  p_source_card_id uuid,
  p_label text,
  p_effects jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next_position integer;
  v_requires_creature_target boolean;
  v_target_controller text;
begin
  if p_effects is null or jsonb_typeof(p_effects) <> 'array' or jsonb_array_length(p_effects) = 0 then
    return;
  end if;

  v_requires_creature_target := public.trigger_effects_require_creature_target(p_effects);

  if v_requires_creature_target then
    v_target_controller := coalesce(public.trigger_effects_target_controller(p_effects), 'any');

    if not public.session_has_targetable_creature(p_session_id, p_controller_id, v_target_controller) then
      return;
    end if;
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
    p_controller_id,
    p_source_card_id,
    'triggered_ability',
    jsonb_build_object(
      'label', p_label,
      'controller_player_id', p_controller_id,
      'effects', p_effects,
      'target_required', v_requires_creature_target,
      'target_type', case when v_requires_creature_target then 'creature' else null end,
      'target_controller', case when v_requires_creature_target then v_target_controller else null end,
      'timing', 'triggered'
    ),
    v_next_position
  );
end;
$$;

-- ─── choose_triggered_ability_creature_target: controller-aware validation ────

create or replace function public.choose_triggered_ability_creature_target(
  p_session_id uuid,
  p_stack_item_id uuid,
  p_target_card_id uuid
)
returns public.game_stack_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stack_item public.game_stack_items;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select *
  into v_stack_item
  from public.game_stack_items
  where id = p_stack_item_id
    and session_id = p_session_id
    and status = 'pending'
  for update;

  if not found then
    raise exception 'Triggered ability stack item not found';
  end if;

  if v_stack_item.action_type <> 'triggered_ability'
    or coalesce((v_stack_item.payload ->> 'target_required')::boolean, false) is not true
  then
    raise exception 'Stack item does not require a trigger target';
  end if;

  if v_stack_item.controller_player_id <> auth.uid() then
    raise exception 'Only the trigger controller can choose its target';
  end if;

  if not public.creature_target_controller_ok(
    p_session_id,
    p_target_card_id,
    v_stack_item.controller_player_id,
    coalesce(v_stack_item.payload ->> 'target_controller', 'any')
  ) then
    raise exception 'Target is not a legal creature for this ability';
  end if;

  update public.game_stack_items
  set payload = payload || jsonb_build_object(
    'target_card_id', p_target_card_id,
    'target_chosen', true
  )
  where id = v_stack_item.id
  returning * into v_stack_item;

  return v_stack_item;
end;
$$;

-- ─── put_action_on_stack: enforce target_controller on creature-target casts ──
-- Reproduces migration 079's body; adds a controller check to the creature-
-- targeting branches and records target_controller in the payload.

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
  v_target_player_id uuid;
  v_target_card_id uuid;
  v_target_stack_item public.game_stack_items;
  v_target_stack_label text;
  v_amount integer;
  v_pump_power integer;
  v_pump_toughness integer;
  v_action_timing text;
  v_target_controller text;
  v_source_type_line text;
  v_source_zone text;
  v_source_mana_cost text;
  v_generic_payment jsonb;
  v_pending_stack_count integer;
  v_next_graveyard_position integer;
  v_next_position integer;
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

  if p_action_type not in (
    'deal_damage_player',
    'deal_damage_creature',
    'pump_creature',
    'counter_spell',
    'draw_cards',
    'destroy_creature',
    'bounce_creature',
    'tap_creature',
    'untap_creature',
    'add_counters_creature'
  ) then
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
  v_target_controller := coalesce(lower(nullif(p_payload ->> 'target_controller', '')), 'any');

  if p_action_type = 'deal_damage_player' then
    v_target_player_id := nullif(p_payload ->> 'target_player_id', '')::uuid;
    v_amount := coalesce((p_payload ->> 'amount')::integer, 0);

    if v_target_player_id is null then
      raise exception 'target_player_id is required';
    end if;

    if v_amount <= 0 then
      raise exception 'amount must be positive';
    end if;

    if not public.is_session_player(p_session_id, v_target_player_id) then
      raise exception 'Target player is not a player in this session';
    end if;
  elsif p_action_type = 'deal_damage_creature' then
    v_target_card_id := nullif(p_payload ->> 'target_card_id', '')::uuid;
    v_amount := coalesce((p_payload ->> 'amount')::integer, 0);

    if v_target_card_id is null then
      raise exception 'target_card_id is required';
    end if;

    if v_amount <= 0 then
      raise exception 'amount must be positive';
    end if;

    if not public.creature_target_controller_ok(p_session_id, v_target_card_id, auth.uid(), v_target_controller) then
      raise exception 'Target is not a legal creature for this spell';
    end if;
  elsif p_action_type = 'pump_creature' then
    v_target_card_id := nullif(p_payload ->> 'target_card_id', '')::uuid;
    v_pump_power := coalesce((p_payload ->> 'power')::integer, 0);
    v_pump_toughness := coalesce((p_payload ->> 'toughness')::integer, 0);

    if v_target_card_id is null then
      raise exception 'target_card_id is required';
    end if;

    if not public.creature_target_controller_ok(p_session_id, v_target_card_id, auth.uid(), v_target_controller) then
      raise exception 'Target is not a legal creature for this spell';
    end if;
  elsif p_action_type in ('destroy_creature', 'bounce_creature', 'tap_creature', 'untap_creature', 'add_counters_creature') then
    -- These all target a creature on the battlefield; identical validation.
    v_target_card_id := nullif(p_payload ->> 'target_card_id', '')::uuid;
    v_amount := coalesce((p_payload ->> 'amount')::integer, 0);

    if v_target_card_id is null then
      raise exception 'target_card_id is required';
    end if;

    if p_action_type = 'add_counters_creature' and v_amount <= 0 then
      raise exception 'amount must be positive';
    end if;

    if not public.creature_target_controller_ok(p_session_id, v_target_card_id, auth.uid(), v_target_controller) then
      raise exception 'Target is not a legal creature for this spell';
    end if;
  elsif p_action_type = 'draw_cards' then
    v_amount := coalesce((p_payload ->> 'amount')::integer, 0);

    if v_amount <= 0 then
      raise exception 'amount must be positive';
    end if;
  elsif p_action_type = 'counter_spell' then
    select *
    into v_target_stack_item
    from public.game_stack_items
    where id = nullif(p_payload ->> 'target_stack_item_id', '')::uuid
      and session_id = p_session_id
      and status = 'pending'
    for update;

    if not found then
      raise exception 'Target stack item not found or no longer pending';
    end if;

    select coalesce(source_card.name, v_target_stack_item.action_type)
    into v_target_stack_label
    from public.game_stack_items target_stack
    left join public.game_cards source_instance
      on source_instance.id = target_stack.source_card_id
    left join public.cards source_card
      on source_card.id = source_instance.card_id
    where target_stack.id = v_target_stack_item.id;
  end if;

  if p_source_card_id is not null and v_source_zone = 'hand' then
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_source_mana_cost, v_generic_payment);
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
    case
      when p_action_type = 'deal_damage_player' then
        jsonb_build_object(
          'target_player_id', v_target_player_id,
          'amount', v_amount,
          'timing', v_action_timing
        )
      when p_action_type = 'deal_damage_creature' then
        jsonb_build_object(
          'target_card_id', v_target_card_id,
          'amount', v_amount,
          'target_controller', v_target_controller,
          'timing', v_action_timing
        )
      when p_action_type = 'pump_creature' then
        jsonb_build_object(
          'target_card_id', v_target_card_id,
          'power', v_pump_power,
          'toughness', v_pump_toughness,
          'target_controller', v_target_controller,
          'timing', v_action_timing
        )
      when p_action_type in ('destroy_creature', 'bounce_creature', 'tap_creature', 'untap_creature') then
        jsonb_build_object(
          'target_card_id', v_target_card_id,
          'target_controller', v_target_controller,
          'timing', v_action_timing
        )
      when p_action_type = 'add_counters_creature' then
        jsonb_build_object(
          'target_card_id', v_target_card_id,
          'amount', v_amount,
          'target_controller', v_target_controller,
          'timing', v_action_timing
        )
      when p_action_type = 'draw_cards' then
        jsonb_build_object(
          'amount', v_amount,
          'timing', v_action_timing
        )
      else
        jsonb_build_object(
          'target_stack_item_id', v_target_stack_item.id,
          'target_stack_label', coalesce(v_target_stack_label, v_target_stack_item.action_type),
          'timing', v_action_timing
        )
    end,
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

-- ─── resolve_top_of_stack: controller-aware trigger fizzle guard ──────────────
-- Reproduces migration 080's body; the only change is the triggered_ability
-- "requires a target" guard, which now uses session_has_targetable_creature so a
-- trigger fizzles cleanly when no *legal* (controller-restricted) creature remains.

create or replace function public.resolve_top_of_stack(
  p_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_stack_item public.game_stack_items;
  v_target_stack_item public.game_stack_items;
  v_target_player_id uuid;
  v_target_card_id uuid;
  v_target_owner_id uuid;
  v_amount integer;
  v_next_battlefield_position integer;
  v_next_graveyard_position integer;
  v_next_hand_position integer;
  v_finish_state jsonb;
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
    raise exception 'Cannot resolve stack in a finished game session';
  end if;

  select *
  into v_stack_item
  from public.game_stack_items
  where session_id = p_session_id
    and status = 'pending'
  order by position desc
  limit 1
  for update;

  if not found then
    raise exception 'Stack is empty';
  end if;

  if v_stack_item.action_type = 'deal_damage_player' then
    v_target_player_id := nullif(v_stack_item.payload ->> 'target_player_id', '')::uuid;
    v_amount := coalesce((v_stack_item.payload ->> 'amount')::integer, 0);

    if v_target_player_id is null or v_amount <= 0 then
      raise exception 'Invalid deal_damage_player payload';
    end if;

    update public.game_session_players
    set life_total = greatest(0, life_total - v_amount)
    where session_id = p_session_id
      and player_id = v_target_player_id;

    if not found then
      raise exception 'Target player not found';
    end if;
  elsif v_stack_item.action_type = 'deal_damage_creature' then
    v_target_card_id := nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid;
    v_amount := coalesce((v_stack_item.payload ->> 'amount')::integer, 0);

    if v_target_card_id is not null and v_amount > 0 then
      update public.game_cards
      set damage_marked = damage_marked + v_amount
      where id = v_target_card_id
        and session_id = p_session_id
        and zone = 'battlefield';

      perform public.move_lethal_damaged_creatures_to_graveyard(p_session_id);
    end if;
  elsif v_stack_item.action_type = 'pump_creature' then
    v_target_card_id := nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid;

    if v_target_card_id is not null
      and exists (
        select 1 from public.game_cards
        where id = v_target_card_id
          and session_id = p_session_id
          and zone = 'battlefield'
      )
    then
      perform public.create_pt_pump(
        p_session_id,
        v_target_card_id,
        coalesce((v_stack_item.payload ->> 'power')::integer, 0),
        coalesce((v_stack_item.payload ->> 'toughness')::integer, 0)
      );
    end if;
  elsif v_stack_item.action_type = 'destroy_creature' then
    v_target_card_id := nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid;

    select owner_id
    into v_target_owner_id
    from public.game_cards
    where id = v_target_card_id
      and session_id = p_session_id
      and zone = 'battlefield';

    if found then
      select coalesce(max(zone_position), -1) + 1
      into v_next_graveyard_position
      from public.game_cards
      where session_id = p_session_id
        and owner_id = v_target_owner_id
        and zone = 'graveyard';

      update public.game_cards
      set
        zone = 'graveyard',
        zone_position = v_next_graveyard_position,
        controller_player_id = owner_id,
        is_tapped = false,
        damage_marked = 0,
        dealt_deathtouch_damage = false,
        plus_one_counters = 0
      where id = v_target_card_id;
    end if;
  elsif v_stack_item.action_type = 'bounce_creature' then
    v_target_card_id := nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid;

    select owner_id
    into v_target_owner_id
    from public.game_cards
    where id = v_target_card_id
      and session_id = p_session_id
      and zone = 'battlefield';

    if found then
      select coalesce(max(zone_position), -1) + 1
      into v_next_hand_position
      from public.game_cards
      where session_id = p_session_id
        and owner_id = v_target_owner_id
        and zone = 'hand';

      update public.game_cards
      set
        zone = 'hand',
        zone_position = v_next_hand_position,
        controller_player_id = owner_id,
        is_tapped = false,
        damage_marked = 0,
        dealt_deathtouch_damage = false,
        plus_one_counters = 0
      where id = v_target_card_id;
    end if;
  elsif v_stack_item.action_type in ('tap_creature', 'untap_creature') then
    v_target_card_id := nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid;

    update public.game_cards
    set is_tapped = (v_stack_item.action_type = 'tap_creature')
    where id = v_target_card_id
      and session_id = p_session_id
      and zone = 'battlefield';
  elsif v_stack_item.action_type = 'add_counters_creature' then
    v_target_card_id := nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid;
    v_amount := coalesce((v_stack_item.payload ->> 'amount')::integer, 0);

    if v_target_card_id is not null and v_amount > 0 then
      update public.game_cards
      set plus_one_counters = greatest(0, plus_one_counters + v_amount)
      where id = v_target_card_id
        and session_id = p_session_id
        and zone = 'battlefield';
    end if;
  elsif v_stack_item.action_type = 'draw_cards' then
    perform public.apply_triggered_ability_effects(
      p_session_id,
      v_stack_item.controller_player_id,
      null,
      jsonb_build_array(
        jsonb_build_object('type', 'draw', 'amount', coalesce((v_stack_item.payload ->> 'amount')::integer, 1))
      )
    );
  elsif v_stack_item.action_type = 'counter_spell' then
    select *
    into v_target_stack_item
    from public.game_stack_items
    where id = nullif(v_stack_item.payload ->> 'target_stack_item_id', '')::uuid
      and session_id = p_session_id
      and status = 'pending'
    for update;

    if found then
      if v_target_stack_item.id = v_stack_item.id then
        raise exception 'A stack item cannot counter itself';
      end if;

      if v_target_stack_item.action_type = 'cast_permanent'
        and v_target_stack_item.source_card_id is not null
      then
        select coalesce(max(zone_position), -1) + 1
        into v_next_graveyard_position
        from public.game_cards
        where session_id = p_session_id
          and owner_id = v_target_stack_item.controller_player_id
          and zone = 'graveyard';

        update public.game_cards
        set
          zone = 'graveyard',
          zone_position = v_next_graveyard_position,
          is_tapped = false,
          damage_marked = 0
        where id = v_target_stack_item.source_card_id
          and session_id = p_session_id
          and owner_id = v_target_stack_item.controller_player_id
          and zone = 'stack';
      end if;

      update public.game_stack_items
      set
        status = 'cancelled',
        resolved_at = now()
      where id = v_target_stack_item.id;
    end if;
  elsif v_stack_item.action_type = 'cast_permanent' then
    if v_stack_item.source_card_id is null then
      raise exception 'Permanent spell has no source card';
    end if;

    select coalesce(max(zone_position), -1) + 1
    into v_next_battlefield_position
    from public.game_cards
    where session_id = p_session_id
      and owner_id = v_stack_item.controller_player_id
      and zone = 'battlefield';

    update public.game_cards
    set
      zone = 'battlefield',
      zone_position = v_next_battlefield_position,
      controller_player_id = coalesce(controller_player_id, owner_id),
      is_tapped = false,
      damage_marked = 0
    where id = v_stack_item.source_card_id
      and session_id = p_session_id
      and owner_id = v_stack_item.controller_player_id
      and zone = 'stack';

    if not found then
      raise exception 'Permanent spell source card not found on stack';
    end if;
  elsif v_stack_item.action_type = 'triggered_ability' then
    if coalesce((v_stack_item.payload ->> 'target_required')::boolean, false)
      and nullif(v_stack_item.payload ->> 'target_card_id', '') is null
    then
      if public.session_has_targetable_creature(
        p_session_id,
        nullif(v_stack_item.payload ->> 'controller_player_id', '')::uuid,
        coalesce(v_stack_item.payload ->> 'target_controller', 'any')
      ) then
        raise exception 'Triggered ability requires a target';
      end if;
    end if;

    perform public.apply_targeted_triggered_ability_effects(
      p_session_id,
      nullif(v_stack_item.payload ->> 'controller_player_id', '')::uuid,
      v_stack_item.source_card_id,
      coalesce(v_stack_item.payload -> 'effects', '[]'::jsonb),
      nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid
    );
  else
    raise exception 'Unsupported stack action type: %', v_stack_item.action_type;
  end if;

  update public.game_stack_items
  set
    status = 'resolved',
    resolved_at = now()
  where id = v_stack_item.id;

  perform public.rebuild_scripted_continuous_effects(p_session_id);

  update public.game_turn_state
  set
    priority_player_id = active_player_id,
    priority_cycle_started_by = null,
    priority_pass_count = 0
  where session_id = p_session_id;

  v_finish_state := public.maybe_finish_game_session(p_session_id);

  return jsonb_build_object(
    'resolved_stack_item_id',
    v_stack_item.id,
    'action_type',
    v_stack_item.action_type,
    'finished',
    coalesce((v_finish_state ->> 'finished')::boolean, false),
    'winner_player_id',
    v_finish_state ->> 'winner_player_id'
  );
end;
$$;

-- Correct the seeded Chupacabra test so its ETB targets only opponent creatures,
-- regardless of whether migration 080's seed already ran.
update public.cards
set script = '{"schema_version":2,"triggered_abilities":[{"event":"enters_the_battlefield","effects":[{"type":"destroy","target_type":"creature","target_controller":"opponent"}]}]}'::jsonb
where name = 'Ravenous Chupacabra Test';

grant execute on function public.behavior_target_type_is_creature_only(jsonb) to authenticated;
grant execute on function public.behavior_target_controller(jsonb) to authenticated;
grant execute on function public.trigger_effect_requires_creature_target(jsonb) to authenticated;
grant execute on function public.trigger_effects_target_controller(jsonb) to authenticated;
grant execute on function public.session_has_targetable_creature(uuid, uuid, text) to authenticated;
grant execute on function public.creature_target_controller_ok(uuid, uuid, uuid, text) to authenticated;
grant execute on function public.enqueue_triggered_ability(uuid, uuid, uuid, text, jsonb) to authenticated;
grant execute on function public.choose_triggered_ability_creature_target(uuid, uuid, uuid) to authenticated;
grant execute on function public.put_action_on_stack(uuid, text, jsonb, uuid) to authenticated;
grant execute on function public.resolve_top_of_stack(uuid) to authenticated;
