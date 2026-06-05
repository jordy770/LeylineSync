-- Phase 4 / F1 — APNAP ordering of SIMULTANEOUS triggered abilities (CR 603.3b).
--
-- Triggers fire via per-row DB triggers and were enqueued at max(position)+1 in
-- arbitrary row-processing order — so when one event fires triggers controlled by
-- several players (a sweeper killing creatures across the table, "each player…"),
-- they resolved in a non-deterministic, rules-incorrect order. This makes that
-- ordering APNAP-correct: the active player's simultaneous triggers go on the
-- stack first (resolve LAST), then each other player's in turn order.
--
-- THREE SEAMS (priority_pass_count reset on cast is a separate F1b slice):
--  1. enqueue_triggered_ability stamps an `apnap_rank` on the payload = the
--     controller's distance from the active player in seat order (0 = active).
--  2. NEW order_pending_triggers(session): a SETTLE step that renumbers the
--     not-yet-ordered triggered_ability batch (enqueued consecutively, so a
--     contiguous position band) so rank 0 sits lowest (resolves last) and the
--     highest rank sits highest (resolves first); marks them apnap_ordered.
--     Idempotent; a later event's fresh triggers settle as their own batch.
--  3. resolve_top_of_stack calls the settle BEFORE selecting the top item, so the
--     resolution order is APNAP regardless of the arbitrary enqueue order.
--
-- positions carry only a non-unique index, so renumbering within a band is safe.
-- NOTE: both functions are reproduced from their CURRENT definitions — enqueue
-- from mig 116 (multi-target reach), resolve_top_of_stack from mig 104 (the
-- registry dispatcher) — NOT the stale baseline. (IDE T-SQL false-positives on $$.)

-- ---------------------------------------------------------------------------
-- 1. enqueue_triggered_ability — stamp apnap_rank. Verbatim from mig 116 except
-- the rank declares/computation + the new payload key.
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
  v_active_player_id uuid;
  v_player_count integer;
  v_controller_seat integer;
  v_active_seat integer;
  v_apnap_rank integer := 0;
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

    if not v_has_target then
      return;
    end if;
  end if;

  -- APNAP rank: how far the controller sits from the active player in seat order.
  -- 0 = active player (its triggers resolve last). Falls back to 0 if unknown.
  select active_player_id into v_active_player_id
  from public.game_turn_state where session_id = p_session_id;

  select count(*) into v_player_count
  from public.game_session_players where session_id = p_session_id;

  select seat_number into v_controller_seat
  from public.game_session_players
  where session_id = p_session_id and player_id = p_controller_id;

  select seat_number into v_active_seat
  from public.game_session_players
  where session_id = p_session_id and player_id = v_active_player_id;

  if coalesce(v_player_count, 0) > 0 and v_controller_seat is not null and v_active_seat is not null then
    v_apnap_rank := ((v_controller_seat - v_active_seat) % v_player_count + v_player_count) % v_player_count;
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
      'target_count', case when v_requires_target then public.trigger_effects_target_count(p_effects) else null end,
      'target_controller', case when v_requires_target then v_target_controller else null end,
      'timing', 'triggered',
      'apnap_rank', v_apnap_rank
    ),
    v_next_position
  );
end;
$$;

grant execute on function public.enqueue_triggered_ability(uuid, uuid, uuid, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. order_pending_triggers — settle the simultaneous-trigger batch into APNAP
-- order. The batch = pending triggered_ability items not yet apnap_ordered; they
-- were enqueued consecutively so they occupy a contiguous band [base, base+K-1].
-- Renumber within that band by (apnap_rank asc, then enqueue order) so rank 0
-- (active) is lowest = resolves last.
-- ---------------------------------------------------------------------------
create or replace function public.order_pending_triggers(p_session_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_base integer;
begin
  select min(position) into v_base
  from public.game_stack_items
  where session_id = p_session_id
    and status = 'pending'
    and action_type = 'triggered_ability'
    and coalesce((payload ->> 'apnap_ordered')::boolean, false) = false;

  if v_base is null then
    return;
  end if;

  with batch as (
    select id,
           row_number() over (
             order by coalesce((payload ->> 'apnap_rank')::integer, 0) asc, position asc, id asc
           ) - 1 as idx
    from public.game_stack_items
    where session_id = p_session_id
      and status = 'pending'
      and action_type = 'triggered_ability'
      and coalesce((payload ->> 'apnap_ordered')::boolean, false) = false
  )
  update public.game_stack_items s
  set position = v_base + batch.idx,
      payload = s.payload || jsonb_build_object('apnap_ordered', true)
  from batch
  where s.id = batch.id;
end;
$$;

revoke all on function public.order_pending_triggers(uuid) from public;
grant execute on function public.order_pending_triggers(uuid) to authenticated;
grant execute on function public.order_pending_triggers(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3. resolve_top_of_stack — settle APNAP order before picking the top. Verbatim
-- from mig 104 (the registry dispatcher) except the single perform call after the
-- session-status check.
-- ---------------------------------------------------------------------------
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
  v_handler_fn text;
  v_result jsonb;
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

  -- APNAP: settle the order of any simultaneous triggers before resolving.
  perform public.order_pending_triggers(p_session_id);

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

  select handler_fn
  into v_handler_fn
  from public.stack_action_handlers
  where action_type = v_stack_item.action_type;

  if v_handler_fn is null then
    raise exception 'Unsupported stack action type: %', v_stack_item.action_type;
  end if;

  -- %I quotes the (table-controlled, public-schema) handler name; the session id
  -- and the whole stack-item row are passed as bound parameters.
  execute format('select public.%I($1, $2)', v_handler_fn)
    into v_result
    using p_session_id, v_stack_item;

  -- A non-null result is an awaiting_decision payload: return it directly,
  -- leaving the item parked. A null result means the side effect is done and the
  -- item should be finalized.
  if v_result is not null then
    return v_result;
  end if;

  return public.finalize_stack_resolution(p_session_id, v_stack_item.id);
end;
$$;

grant execute on function public.resolve_top_of_stack(uuid) to authenticated;
