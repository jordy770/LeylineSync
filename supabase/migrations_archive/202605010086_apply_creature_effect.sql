-- Phase 0 (rules-engine cleanup): centralize the targeted-creature effect switch.
--
-- The creature-mutation logic (deal_damage / destroy / exile / bounce / tap /
-- untap / add_counters / pump) was duplicated byte-for-byte in two places:
--   * apply_targeted_triggered_ability_effects -- the targeted-trigger resolver,
--     keyed on the effect's "type" (deal_damage, destroy, exile, ...)
--   * resolve_top_of_stack -- the spell resolver, keyed on action_type
--     (deal_damage_creature, destroy_creature, exile_creature, ...)
-- Adding a creature-targeting effect therefore meant editing the same switch in
-- both functions (the documented "mirror destroy everywhere" tax).
--
-- This migration extracts a single primitive, public.apply_creature_effect(
-- session, kind, target_card_id, params), that owns every creature mutation, and
-- routes both callers through it. The spell side now needs no per-effect branch
-- at all: every creature action_type is "<kind>_creature", so one branch strips
-- the suffix and delegates. Adding a new creature effect is now: implement it
-- once here, plus the declarations/validation (constraint, requires-target list,
-- put_action_on_stack, client map) -- no more duplicated mutation logic.
--
-- Behavior-preserving: each branch below is the exact mutation the two functions
-- performed before. destroy still routes through put_in_graveyard (migration
-- 084); deal_damage still re-runs state-based actions.
--
-- (IDE SQL diagnostics flag the $$ bodies via a T-SQL parser -- false positives
-- on PostgreSQL.)

-- The single creature-effect primitive. p_params carries amount (deal_damage,
-- add_counters) or power/toughness (pump). No-ops harmlessly when the target is
-- gone (fizzle) -- the existence is re-checked per mutation against zone =
-- 'battlefield', exactly as before.
create or replace function public.apply_creature_effect(
  p_session_id uuid,
  p_kind text,
  p_target_card_id uuid,
  p_params jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount integer := coalesce((p_params ->> 'amount')::integer, 0);
  v_target_owner_id uuid;
  v_next_position integer;
begin
  if p_target_card_id is null then
    return;
  end if;

  if p_kind = 'deal_damage' then
    if v_amount > 0 then
      update public.game_cards
      set damage_marked = damage_marked + v_amount
      where id = p_target_card_id
        and session_id = p_session_id
        and zone = 'battlefield';

      perform public.move_lethal_damaged_creatures_to_graveyard(p_session_id);
    end if;

  elsif p_kind = 'destroy' then
    perform public.put_in_graveyard(p_session_id, p_target_card_id);

  elsif p_kind = 'exile' then
    select owner_id
    into v_target_owner_id
    from public.game_cards
    where id = p_target_card_id
      and session_id = p_session_id
      and zone = 'battlefield';

    if found then
      select coalesce(max(zone_position), -1) + 1
      into v_next_position
      from public.game_cards
      where session_id = p_session_id
        and owner_id = v_target_owner_id
        and zone = 'exile';

      update public.game_cards
      set
        zone = 'exile',
        zone_position = v_next_position,
        controller_player_id = owner_id,
        is_tapped = false,
        damage_marked = 0,
        dealt_deathtouch_damage = false,
        plus_one_counters = 0
      where id = p_target_card_id;
    end if;

  elsif p_kind = 'bounce' then
    select owner_id
    into v_target_owner_id
    from public.game_cards
    where id = p_target_card_id
      and session_id = p_session_id
      and zone = 'battlefield';

    if found then
      select coalesce(max(zone_position), -1) + 1
      into v_next_position
      from public.game_cards
      where session_id = p_session_id
        and owner_id = v_target_owner_id
        and zone = 'hand';

      update public.game_cards
      set
        zone = 'hand',
        zone_position = v_next_position,
        controller_player_id = owner_id,
        is_tapped = false,
        damage_marked = 0,
        dealt_deathtouch_damage = false,
        plus_one_counters = 0
      where id = p_target_card_id;
    end if;

  elsif p_kind in ('tap', 'untap') then
    update public.game_cards
    set is_tapped = (p_kind = 'tap')
    where id = p_target_card_id
      and session_id = p_session_id
      and zone = 'battlefield';

  elsif p_kind = 'add_counters' then
    if v_amount > 0 then
      update public.game_cards
      set plus_one_counters = greatest(0, plus_one_counters + v_amount)
      where id = p_target_card_id
        and session_id = p_session_id
        and zone = 'battlefield';
    end if;

  elsif p_kind = 'pump' then
    if exists (
      select 1 from public.game_cards
      where id = p_target_card_id
        and session_id = p_session_id
        and zone = 'battlefield'
    ) then
      perform public.create_pt_pump(
        p_session_id,
        p_target_card_id,
        coalesce((p_params ->> 'power')::integer, 0),
        coalesce((p_params ->> 'toughness')::integer, 0)
      );
    end if;

  else
    raise exception 'Unsupported creature effect kind: %', p_kind;
  end if;
end;
$$;

grant execute on function public.apply_creature_effect(uuid, text, uuid, jsonb) to authenticated;

-- 1. apply_targeted_triggered_ability_effects: non-creature effects still defer
-- to apply_triggered_ability_effects; creature effects now delegate to the
-- shared primitive (the inline exile/bounce/destroy/tap/damage/counter blocks
-- are gone).
create or replace function public.apply_targeted_triggered_ability_effects(
  p_session_id uuid,
  p_controller_id uuid,
  p_source_card_id uuid,
  p_effects jsonb,
  p_target_card_id uuid
)
returns void
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
    if not public.trigger_effect_requires_creature_target(v_effect) then
      perform public.apply_triggered_ability_effects(
        p_session_id,
        p_controller_id,
        p_source_card_id,
        jsonb_build_array(v_effect)
      );
      continue;
    end if;

    -- Targeted trigger effects fizzle harmlessly if the target is gone; the
    -- primitive re-checks the target is on the battlefield per mutation.
    v_eff_type := lower(coalesce(v_effect ->> 'type', ''));

    perform public.apply_creature_effect(
      p_session_id,
      v_eff_type,
      p_target_card_id,
      jsonb_build_object('amount', coalesce((v_effect ->> 'amount')::integer, 0))
    );
  end loop;
end;
$$;

-- 2. resolve_top_of_stack: collapse the eight per-creature-action branches into
-- one. Every creature action_type is "<kind>_creature", so we strip the suffix
-- and hand the payload (amount / power / toughness) to apply_creature_effect.
-- All non-creature branches (player damage, draw, counter, cast, triggered) are
-- reproduced verbatim from migration 084.
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
  v_amount integer;
  v_next_battlefield_position integer;
  v_next_graveyard_position integer;
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
  elsif v_stack_item.action_type in (
    'deal_damage_creature',
    'pump_creature',
    'destroy_creature',
    'exile_creature',
    'bounce_creature',
    'tap_creature',
    'untap_creature',
    'add_counters_creature'
  ) then
    -- Every creature action_type is "<kind>_creature"; the payload already
    -- carries amount / power / toughness for the primitive.
    perform public.apply_creature_effect(
      p_session_id,
      regexp_replace(v_stack_item.action_type, '_creature$', ''),
      nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid,
      v_stack_item.payload
    );
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

grant execute on function public.apply_targeted_triggered_ability_effects(uuid, uuid, uuid, jsonb, uuid) to authenticated;
grant execute on function public.resolve_top_of_stack(uuid) to authenticated;
