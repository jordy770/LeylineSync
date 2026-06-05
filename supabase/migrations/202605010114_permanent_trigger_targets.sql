-- Phase 3, slice 3 — trigger-side targeting reach: NON-CREATURE PERMANENT targets
-- for triggered abilities. "When this enters/dies, destroy/exile/bounce/tap/untap
-- target artifact/enchantment/land/planeswalker/permanent." The trigger analogue
-- of mig 113's spell-side permanent_effect.
--
-- The announcement-time trigger-target machinery is baked around a single CREATURE
-- (enqueue sets target_type='creature'; the picker validates via
-- creature_target_controller_ok; the fizzle guard checks session_has_targetable_
-- creature; the require-detection gates on behavior_target_type_is_creature_only).
-- This migration generalises that path to "a target whose type the effect allows",
-- keyed off the effect's target_type, while leaving the creature path byte-identical
-- (a creature-only target_type still resolves to 'creature' everywhere).
--
-- apply_creature_effect's removal kinds already operate on any permanent (mig 113),
-- so the APPLY step needs only its gate widened from "requires a creature" to
-- "requires any target". deal_damage / add_counters / grant_keyword / fight /
-- gain_control stay CREATURE-only (creature-semantic); only destroy/exile/bounce/
-- tap/untap gain non-creature permanent targeting. MULTI-target triggers (an array
-- of targets) remain a separate follow-up.
--
-- Reproduces enqueue_triggered_ability + choose_triggered_ability_creature_target +
-- trigger_effects_target_controller (baseline), handle_triggered_ability (mig 104),
-- and apply_targeted_triggered_ability_effects (mig 106) with surgical changes.
-- (IDE T-SQL false-positives on $$ bodies — ignore.)

-- ---------------------------------------------------------------------------
-- Helper: is every element of target_type a permanent type? (creature counts —
-- creatures are permanents — but the creature-only case is handled first in
-- trigger_effect_target_type, so this only fires for non-creature permanents.)
-- ---------------------------------------------------------------------------
create or replace function public.behavior_target_type_is_permanent_only(p_target_type jsonb)
returns boolean language sql immutable as $$
  select case
    when p_target_type is null then false
    else (
      jsonb_array_length(
        case when jsonb_typeof(p_target_type) = 'array' then p_target_type
             else jsonb_build_array(trim(both '"' from p_target_type::text)) end
      ) > 0
      and not exists (
        select 1
        from jsonb_array_elements_text(
          case when jsonb_typeof(p_target_type) = 'array' then p_target_type
               else jsonb_build_array(trim(both '"' from p_target_type::text)) end
        ) as t(value)
        where lower(t.value) not in
          ('artifact', 'enchantment', 'land', 'planeswalker', 'battle', 'permanent', 'creature')
      )
    )
  end;
$$;

grant all on function public.behavior_target_type_is_permanent_only(jsonb) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The target_type a trigger effect needs a pick for, or null if it targets nothing.
-- Creature-target kinds with a creature-only target_type → "creature" (unchanged).
-- Removal kinds with a non-creature permanent target_type → that target_type (new).
-- ---------------------------------------------------------------------------
create or replace function public.trigger_effect_target_type(p_effect jsonb)
returns jsonb language sql immutable as $$
  select case
    when lower(coalesce(p_effect ->> 'type', '')) in
         ('deal_damage', 'destroy', 'exile', 'bounce', 'tap', 'untap',
          'add_counters', 'grant_keyword', 'fight', 'gain_control')
         and public.behavior_target_type_is_creature_only(p_effect -> 'target_type')
      then '"creature"'::jsonb
    when lower(coalesce(p_effect ->> 'type', '')) in ('destroy', 'exile', 'bounce', 'tap', 'untap')
         and public.behavior_target_type_is_permanent_only(p_effect -> 'target_type')
      then p_effect -> 'target_type'
    else null
  end;
$$;

grant all on function public.trigger_effect_target_type(jsonb) to anon, authenticated, service_role;

create or replace function public.trigger_effects_target_type(p_effects jsonb)
returns jsonb language sql immutable as $$
  select public.trigger_effect_target_type(effects.effect)
  from jsonb_array_elements(coalesce(p_effects, '[]'::jsonb)) as effects(effect)
  where public.trigger_effect_target_type(effects.effect) is not null
  limit 1;
$$;

grant all on function public.trigger_effects_target_type(jsonb) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The non-creature analogue of session_has_targetable_creature (fizzle guard).
-- ---------------------------------------------------------------------------
create or replace function public.session_has_targetable_permanent(
  p_session_id uuid, p_controller_id uuid, p_target_controller text, p_target_type jsonb
) returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.game_cards gc
    join public.cards c on c.id = gc.card_id
    where gc.session_id = p_session_id
      and gc.zone = 'battlefield'
      and public.card_type_line_matches_target(c.type_line, p_target_type)
      and (
        coalesce(p_target_controller, 'any') = 'any'
        or (p_target_controller = 'opponent' and gc.controller_player_id is distinct from p_controller_id)
        or (p_target_controller = 'you' and gc.controller_player_id = p_controller_id)
      )
  );
$$;

grant all on function public.session_has_targetable_permanent(uuid, uuid, text, jsonb) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- trigger_effects_target_controller — generalised to the same "any target" gate
-- (creature-only effects still match, so behaviour is preserved for them).
-- ---------------------------------------------------------------------------
create or replace function public.trigger_effects_target_controller(p_effects jsonb)
returns text language sql immutable as $$
  select public.behavior_target_controller(effects.effect)
  from jsonb_array_elements(coalesce(p_effects, '[]'::jsonb)) as effects(effect)
  where public.trigger_effect_target_type(effects.effect) is not null
  limit 1;
$$;

grant all on function public.trigger_effects_target_controller(jsonb) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- enqueue_triggered_ability (baseline) — drive target_required / target_type off
-- trigger_effects_target_type, and pick the right "has a target" check.
-- ---------------------------------------------------------------------------
create or replace function public.enqueue_triggered_ability(
  p_session_id uuid, p_controller_id uuid, p_source_card_id uuid, p_label text, p_effects jsonb
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_next_position integer;
  v_target_type jsonb;
  v_requires_target boolean;
  v_target_controller text;
  v_has_target boolean;
begin
  if p_effects is null or jsonb_typeof(p_effects) <> 'array' or jsonb_array_length(p_effects) = 0 then
    return;
  end if;

  v_target_type := public.trigger_effects_target_type(p_effects);
  v_requires_target := v_target_type is not null;

  if v_requires_target then
    v_target_controller := coalesce(public.trigger_effects_target_controller(p_effects), 'any');

    if public.behavior_target_type_is_creature_only(v_target_type) then
      v_has_target := public.session_has_targetable_creature(p_session_id, p_controller_id, v_target_controller);
    else
      v_has_target := public.session_has_targetable_permanent(p_session_id, p_controller_id, v_target_controller, v_target_type);
    end if;

    -- No legal target → the ability does nothing (don't enqueue), as before.
    if not v_has_target then
      return;
    end if;
  end if;

  select coalesce(max(position), -1) + 1
  into v_next_position
  from public.game_stack_items
  where session_id = p_session_id;

  insert into public.game_stack_items (
    session_id, controller_player_id, source_card_id, action_type, payload, position
  )
  values (
    p_session_id, p_controller_id, p_source_card_id, 'triggered_ability',
    jsonb_build_object(
      'label', p_label,
      'controller_player_id', p_controller_id,
      'effects', p_effects,
      'target_required', v_requires_target,
      'target_type', case when v_requires_target then v_target_type else null end,
      'target_controller', case when v_requires_target then v_target_controller else null end,
      'timing', 'triggered'
    ),
    v_next_position
  );
end;
$$;

grant execute on function public.enqueue_triggered_ability(uuid, uuid, uuid, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- choose_triggered_ability_creature_target (baseline) — validate the picked target
-- against the stack item's target_type (creature path unchanged; permanent path new).
-- Name/signature kept (the client RPC depends on it).
-- ---------------------------------------------------------------------------
create or replace function public.choose_triggered_ability_creature_target(
  p_session_id uuid, p_stack_item_id uuid, p_target_card_id uuid
) returns public.game_stack_items
language plpgsql security definer set search_path = public
as $$
declare
  v_stack_item public.game_stack_items;
  v_target_type jsonb;
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
  where id = p_stack_item_id and session_id = p_session_id and status = 'pending'
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

  v_target_type := v_stack_item.payload -> 'target_type';

  if v_target_type is null or public.behavior_target_type_is_creature_only(v_target_type) then
    if not public.creature_target_controller_ok(
      p_session_id, p_target_card_id, v_stack_item.controller_player_id,
      coalesce(v_stack_item.payload ->> 'target_controller', 'any')
    ) then
      raise exception 'Target is not a legal creature for this ability';
    end if;
  else
    if not public.permanent_target_controller_ok(
      p_session_id, p_target_card_id, v_stack_item.controller_player_id,
      coalesce(v_stack_item.payload ->> 'target_controller', 'any'), v_target_type
    ) then
      raise exception 'Target is not a legal permanent for this ability';
    end if;
  end if;

  update public.game_stack_items
  set payload = payload || jsonb_build_object('target_card_id', p_target_card_id, 'target_chosen', true)
  where id = v_stack_item.id
  returning * into v_stack_item;

  return v_stack_item;
end;
$$;

grant execute on function public.choose_triggered_ability_creature_target(uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- handle_triggered_ability (mig 104) — fizzle guard uses the right "has a target"
-- check based on the stack item's target_type.
-- ---------------------------------------------------------------------------
create or replace function public.handle_triggered_ability(
  p_session_id uuid,
  p_stack_item public.game_stack_items
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_decision_id uuid;
  v_target_type jsonb;
  v_has_target boolean;
begin
  if coalesce((p_stack_item.payload ->> 'target_required')::boolean, false)
    and nullif(p_stack_item.payload ->> 'target_card_id', '') is null
  then
    v_target_type := p_stack_item.payload -> 'target_type';
    if v_target_type is null or public.behavior_target_type_is_creature_only(v_target_type) then
      v_has_target := public.session_has_targetable_creature(
        p_session_id,
        nullif(p_stack_item.payload ->> 'controller_player_id', '')::uuid,
        coalesce(p_stack_item.payload ->> 'target_controller', 'any')
      );
    else
      v_has_target := public.session_has_targetable_permanent(
        p_session_id,
        nullif(p_stack_item.payload ->> 'controller_player_id', '')::uuid,
        coalesce(p_stack_item.payload ->> 'target_controller', 'any'),
        v_target_type
      );
    end if;

    if v_has_target then
      raise exception 'Triggered ability requires a target';
    end if;
  end if;

  v_decision_id := public.apply_trigger_effects(p_session_id, p_stack_item.id, 0);
  if v_decision_id is not null then
    return jsonb_build_object(
      'awaiting_decision', true,
      'decision_id', v_decision_id,
      'stack_item_id', p_stack_item.id
    );
  end if;
  return null;
end;
$$;

revoke all on function public.handle_triggered_ability(uuid, public.game_stack_items) from public;

-- ---------------------------------------------------------------------------
-- apply_targeted_triggered_ability_effects (mig 106) — gate the targeted branch on
-- "requires ANY target" (creature OR permanent) instead of creature-only, so a
-- removal effect with a permanent target_type dispatches to apply_creature_effect
-- (which works on any permanent) rather than the untargeted applier.
-- ---------------------------------------------------------------------------
create or replace function public.apply_targeted_triggered_ability_effects(
  p_session_id uuid,
  p_controller_id uuid,
  p_source_card_id uuid,
  p_effects jsonb,
  p_target_card_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_effect jsonb;
  v_eff_type text;
begin
  for v_effect in
    select * from jsonb_array_elements(coalesce(p_effects, '[]'::jsonb))
  loop
    if public.trigger_effect_target_type(v_effect) is null then
      perform public.apply_triggered_ability_effects(
        p_session_id, p_controller_id, p_source_card_id, jsonb_build_array(v_effect)
      );
      continue;
    end if;

    -- Targeted trigger effects fizzle harmlessly if the target is gone; the
    -- primitive re-checks the target is on the battlefield per mutation.
    v_eff_type := lower(coalesce(v_effect ->> 'type', ''));

    if v_eff_type = 'fight' then
      perform public.apply_fight(p_session_id, p_source_card_id, p_target_card_id);
    else
      perform public.apply_creature_effect(
        p_session_id, v_eff_type, p_target_card_id,
        v_effect || jsonb_build_object('acting_controller', p_controller_id)
      );
    end if;
  end loop;
end;
$$;

grant execute on function public.apply_targeted_triggered_ability_effects(uuid, uuid, uuid, jsonb, uuid) to authenticated;
