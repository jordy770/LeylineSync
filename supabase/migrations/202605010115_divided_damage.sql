-- Phase 3, slice 4a — DIVIDED damage: "deal N damage divided as you choose among
-- any number of target creatures and/or players" (Forked Bolt, Hex, Fireball-style
-- division). The caster picks targets AND how much each takes, totalling N.
--
-- Mechanism — ONE new castable action type `divided_damage` carrying an
-- `allocations` array of {target, amount}; plugged into the mig 104/105 dispatch
-- (1 builder + 1 handler + 1 registry row). Targets are locked at cast, as in MTG.
--   * builder validates each allocation's target (creature via creature_target_
--     controller_ok, or a session player), each amount >= 1, distinct targets, and
--     that the allocations sum to `amount`. (Like every other damage builder it
--     trusts the client-supplied total — consistent with the existing model.)
--   * handler loops: creature allocations → apply_creature_effect('deal_damage'),
--     player allocations → life loss (apply_creature_effect already runs lethal SBA).
-- (IDE T-SQL false-positives on $$ bodies — ignore.)

-- ---------------------------------------------------------------------------
-- Builder.
-- ---------------------------------------------------------------------------
create or replace function public.build_stack_payload_divided_damage(
  p_session_id uuid, p_actor uuid, p_payload jsonb, p_timing text, p_target_controller text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_amount integer;
  v_alloc jsonb;
  v_card uuid;
  v_player uuid;
  v_a integer;
  v_sum integer := 0;
  v_n integer := 0;
  v_seen uuid[] := array[]::uuid[];
  v_target uuid;
begin
  v_amount := coalesce((p_payload ->> 'amount')::integer, 0);
  if v_amount <= 0 then
    raise exception 'amount must be positive';
  end if;

  if jsonb_typeof(p_payload -> 'allocations') <> 'array'
     or jsonb_array_length(p_payload -> 'allocations') = 0 then
    raise exception 'allocations must contain at least one target';
  end if;

  for v_alloc in select * from jsonb_array_elements(p_payload -> 'allocations')
  loop
    v_card := nullif(v_alloc ->> 'target_card_id', '')::uuid;
    v_player := nullif(v_alloc ->> 'target_player_id', '')::uuid;
    v_a := coalesce((v_alloc ->> 'amount')::integer, 0);

    if v_a <= 0 then
      raise exception 'each allocation amount must be positive';
    end if;
    if (v_card is null) = (v_player is null) then
      raise exception 'each allocation needs exactly one of target_card_id / target_player_id';
    end if;

    if v_card is not null then
      if not public.creature_target_controller_ok(p_session_id, v_card, p_actor, p_target_controller) then
        raise exception 'Target is not a legal creature for this spell';
      end if;
      v_target := v_card;
    else
      if not public.is_session_player(p_session_id, v_player) then
        raise exception 'Target player is not a player in this session';
      end if;
      v_target := v_player;
    end if;

    if v_target = any(v_seen) then
      raise exception 'A target may not be assigned damage more than once';
    end if;
    v_seen := array_append(v_seen, v_target);

    v_sum := v_sum + v_a;
    v_n := v_n + 1;
  end loop;

  if v_sum <> v_amount then
    raise exception 'allocations must sum to the total damage (% vs %)', v_sum, v_amount;
  end if;

  return jsonb_build_object(
    'amount', v_amount,
    'allocations', p_payload -> 'allocations',
    'target_controller', p_target_controller,
    'timing', p_timing
  );
end;
$$;

revoke all on function public.build_stack_payload_divided_damage(uuid, uuid, jsonb, text, text) from public;

-- ---------------------------------------------------------------------------
-- Handler.
-- ---------------------------------------------------------------------------
create or replace function public.handle_divided_damage(
  p_session_id uuid,
  p_stack_item public.game_stack_items
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alloc jsonb;
  v_card uuid;
  v_player uuid;
  v_a integer;
begin
  for v_alloc in select * from jsonb_array_elements(coalesce(p_stack_item.payload -> 'allocations', '[]'::jsonb))
  loop
    v_card := nullif(v_alloc ->> 'target_card_id', '')::uuid;
    v_player := nullif(v_alloc ->> 'target_player_id', '')::uuid;
    v_a := coalesce((v_alloc ->> 'amount')::integer, 0);
    if v_a <= 0 then
      continue;
    end if;

    if v_card is not null then
      -- Damages the creature; apply_creature_effect runs the lethal-damage SBA.
      perform public.apply_creature_effect(p_session_id, 'deal_damage', v_card, jsonb_build_object('amount', v_a));
    elsif v_player is not null then
      update public.game_session_players
      set life_total = greatest(0, life_total - v_a)
      where session_id = p_session_id and player_id = v_player;
    end if;
  end loop;
  return null;
end;
$$;

revoke all on function public.handle_divided_damage(uuid, public.game_stack_items) from public;

-- ---------------------------------------------------------------------------
-- Allow the new action type (reproduces the mig 113 allow-list + 1).
-- ---------------------------------------------------------------------------
alter table public.game_stack_items
  drop constraint if exists game_stack_items_action_type_check;
alter table public.game_stack_items
  add constraint game_stack_items_action_type_check
  check (action_type = any (array[
    'deal_damage_player', 'deal_damage_creature', 'pump_creature', 'cast_permanent',
    'counter_spell', 'triggered_ability', 'draw_cards', 'destroy_creature',
    'bounce_creature', 'tap_creature', 'untap_creature', 'add_counters_creature',
    'exile_creature', 'grant_keyword_creature', 'gain_control_creature',
    'fight_creatures', 'modal_spell', 'scry', 'surveil', 'spell_effect',
    'multi_creature_effect', 'permanent_effect', 'divided_damage'
  ]));

-- ---------------------------------------------------------------------------
-- Register the action type (idempotent).
-- ---------------------------------------------------------------------------
insert into public.stack_action_handlers (action_type, handler_fn, builder_fn, description) values
  ('divided_damage', 'handle_divided_damage', 'build_stack_payload_divided_damage',
   'Deal a damage amount divided among multiple target creatures/players')
on conflict (action_type) do update
  set handler_fn = excluded.handler_fn,
      builder_fn = excluded.builder_fn,
      description = excluded.description;
