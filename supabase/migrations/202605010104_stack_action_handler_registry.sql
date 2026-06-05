-- Refactor: data-driven stack-action dispatch (behavior-preserving).
--
-- WHY: every prior migration that added a stack action type (087-103) had to
-- re-paste the entire ~210-line resolve_top_of_stack just to add ONE branch to
-- its action_type if/elsif chain. That reproduction tax is superlinear (each new
-- action = another full copy to mentally diff). This migration removes it: the
-- per-action logic moves into handler functions of a UNIFORM signature, and
-- resolve_top_of_stack becomes a thin dispatcher driven by a lookup table. After
-- this, adding an action type = INSERT one row + create one handler fn; the
-- dispatcher is never reproduced again.
--
-- HANDLER CONTRACT  handle_*(p_session_id uuid, p_stack_item game_stack_items) -> jsonb
--   * return non-null jsonb  -> the resolver returns it DIRECTLY (an
--                               awaiting_decision result; the item is NOT finalized).
--   * return null            -> the resolver calls finalize_stack_resolution.
--   This captures both branch shapes the old chain had: side-effect-then-finalize
--   (return null) and park-for-decision (return the awaiting jsonb). Each handler
--   body below is a VERBATIM lift of its old if/elsif branch — no logic change.
--
-- The handlers are SECURITY DEFINER / search_path=public (matching apply_fight,
-- apply_creature_effect, etc.) and reached only via the dispatcher's EXECUTE,
-- which runs as the function owner — so they need no grant to authenticated, and
-- we REVOKE the Postgres-default PUBLIC execute so they are NOT exposed as raw
-- PostgREST RPCs (handle_cast_permanent etc. must not be callable directly).
-- None of the lifted branch bodies reference auth.uid() (the single auth check
-- stays in the dispatcher), so the definer nesting is behavior-neutral; functions
-- that DO read auth.uid() deeper (card_has_deathtouch via apply_fight,
-- apply_trigger_effects) keep working because auth.uid() reads a session GUC that
-- definer nesting does not change.
--
-- (IDE T-SQL false-positives on $$ bodies — ignore.)

-- ---------------------------------------------------------------------------
-- Registry table: action_type -> unqualified handler function name in public.
-- ---------------------------------------------------------------------------
create table if not exists public.stack_action_handlers (
  action_type text primary key,
  handler_fn  text not null,
  description text
);

revoke all on table public.stack_action_handlers from public;

-- ---------------------------------------------------------------------------
-- Handlers (one verbatim lift per old branch).
-- ---------------------------------------------------------------------------

-- deal_damage_player: damage a player's life total.
create or replace function public.handle_deal_damage_player(
  p_session_id uuid,
  p_stack_item public.game_stack_items
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_player_id uuid;
  v_amount integer;
begin
  v_target_player_id := nullif(p_stack_item.payload ->> 'target_player_id', '')::uuid;
  v_amount := coalesce((p_stack_item.payload ->> 'amount')::integer, 0);

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

  return null;
end;
$$;

-- The collapsed creature-effect group (deal_damage_creature, pump_creature,
-- destroy_creature, exile_creature, bounce_creature, tap_creature,
-- untap_creature, add_counters_creature, grant_keyword_creature). Registered for
-- all nine action types; strips the _creature suffix to the apply_creature_effect
-- kind, exactly as the old chain did.
create or replace function public.handle_creature_effect(
  p_session_id uuid,
  p_stack_item public.game_stack_items
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.apply_creature_effect(
    p_session_id,
    regexp_replace(p_stack_item.action_type, '_creature$', ''),
    nullif(p_stack_item.payload ->> 'target_card_id', '')::uuid,
    p_stack_item.payload
  );
  return null;
end;
$$;

-- fight_creatures: the source/first creature fights the second.
create or replace function public.handle_fight_creatures(
  p_session_id uuid,
  p_stack_item public.game_stack_items
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.apply_fight(
    p_session_id,
    nullif(p_stack_item.payload ->> 'target_card_id', '')::uuid,
    nullif(p_stack_item.payload ->> 'target_card_id_2', '')::uuid
  );
  return null;
end;
$$;

-- draw_cards: draw N for the controller (via the shared trigger applier).
create or replace function public.handle_draw_cards(
  p_session_id uuid,
  p_stack_item public.game_stack_items
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.apply_triggered_ability_effects(
    p_session_id,
    p_stack_item.controller_player_id,
    null,
    jsonb_build_array(
      jsonb_build_object('type', 'draw', 'amount', coalesce((p_stack_item.payload ->> 'amount')::integer, 1))
    )
  );
  return null;
end;
$$;

-- scry / surveil: park a pending decision over the top N library cards. Returns
-- null when the library is empty (resolver finalizes, as the old code did).
create or replace function public.handle_scry_surveil(
  p_session_id uuid,
  p_stack_item public.game_stack_items
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount integer;
  v_scry_options jsonb;
  v_decision_id uuid;
begin
  v_amount := coalesce((p_stack_item.payload ->> 'amount')::integer, 1);

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'game_card_id', top.id,
               'name', c.name,
               'library_position', top.zone_position
             )
             order by top.zone_position asc, top.id asc
           ),
           '[]'::jsonb
         )
    into v_scry_options
  from (
    select id, card_id, zone_position
    from public.game_cards
    where session_id = p_session_id
      and owner_id = p_stack_item.controller_player_id
      and zone = 'library'
    order by zone_position asc, id asc
    limit v_amount
  ) top
  join public.cards c on c.id = top.card_id;

  if jsonb_array_length(v_scry_options) = 0 then
    return null; -- nothing to look at; resolver finalizes
  end if;

  insert into public.game_pending_decisions (
    session_id, deciding_player_id, source_stack_item_id, decision_type,
    prompt, options, min_choices, max_choices
  )
  values (
    p_session_id,
    p_stack_item.controller_player_id,
    p_stack_item.id,
    p_stack_item.action_type,
    initcap(p_stack_item.action_type) || ' ' || v_amount,
    v_scry_options,
    0,
    jsonb_array_length(v_scry_options)
  )
  returning id into v_decision_id;

  update public.game_stack_items
  set status = 'awaiting_decision'
  where id = p_stack_item.id;

  return jsonb_build_object(
    'awaiting_decision', true,
    'decision_id', v_decision_id,
    'decision_type', p_stack_item.action_type,
    'stack_item_id', p_stack_item.id
  );
end;
$$;

-- spell_effect: run the effect program; may park a decision.
create or replace function public.handle_spell_effect(
  p_session_id uuid,
  p_stack_item public.game_stack_items
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_decision_id uuid;
begin
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

-- modal_spell: apply the chosen modes.
create or replace function public.handle_modal_spell(
  p_session_id uuid,
  p_stack_item public.game_stack_items
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.apply_modal_spell(p_session_id, p_stack_item.id);
  return null;
end;
$$;

-- counter_spell: cancel the targeted pending stack item (and send a permanent
-- spell's source card to its owner's graveyard).
create or replace function public.handle_counter_spell(
  p_session_id uuid,
  p_stack_item public.game_stack_items
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_stack_item public.game_stack_items;
  v_next_graveyard_position integer;
begin
  select *
  into v_target_stack_item
  from public.game_stack_items
  where id = nullif(p_stack_item.payload ->> 'target_stack_item_id', '')::uuid
    and session_id = p_session_id
    and status = 'pending'
  for update;

  if found then
    if v_target_stack_item.id = p_stack_item.id then
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

  return null;
end;
$$;

-- cast_permanent: move the source card from the stack onto the battlefield.
create or replace function public.handle_cast_permanent(
  p_session_id uuid,
  p_stack_item public.game_stack_items
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next_battlefield_position integer;
begin
  if p_stack_item.source_card_id is null then
    raise exception 'Permanent spell has no source card';
  end if;

  select coalesce(max(zone_position), -1) + 1
  into v_next_battlefield_position
  from public.game_cards
  where session_id = p_session_id
    and owner_id = p_stack_item.controller_player_id
    and zone = 'battlefield';

  update public.game_cards
  set
    zone = 'battlefield',
    zone_position = v_next_battlefield_position,
    controller_player_id = coalesce(controller_player_id, owner_id),
    is_tapped = false,
    damage_marked = 0
  where id = p_stack_item.source_card_id
    and session_id = p_session_id
    and owner_id = p_stack_item.controller_player_id
    and zone = 'stack';

  if not found then
    raise exception 'Permanent spell source card not found on stack';
  end if;

  return null;
end;
$$;

-- triggered_ability: fizzle if a required target is now absent, else run the
-- effect program (which may park a decision, e.g. a creature-target picker).
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
begin
  if coalesce((p_stack_item.payload ->> 'target_required')::boolean, false)
    and nullif(p_stack_item.payload ->> 'target_card_id', '') is null
  then
    if public.session_has_targetable_creature(
      p_session_id,
      nullif(p_stack_item.payload ->> 'controller_player_id', '')::uuid,
      coalesce(p_stack_item.payload ->> 'target_controller', 'any')
    ) then
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

-- Keep the internal handlers off the PostgREST surface (Postgres grants EXECUTE
-- to PUBLIC by default on function creation). The dispatcher reaches them via
-- EXECUTE as the function owner, so no authenticated grant is needed.
revoke all on function public.handle_deal_damage_player(uuid, public.game_stack_items) from public;
revoke all on function public.handle_creature_effect(uuid, public.game_stack_items) from public;
revoke all on function public.handle_fight_creatures(uuid, public.game_stack_items) from public;
revoke all on function public.handle_draw_cards(uuid, public.game_stack_items) from public;
revoke all on function public.handle_scry_surveil(uuid, public.game_stack_items) from public;
revoke all on function public.handle_spell_effect(uuid, public.game_stack_items) from public;
revoke all on function public.handle_modal_spell(uuid, public.game_stack_items) from public;
revoke all on function public.handle_counter_spell(uuid, public.game_stack_items) from public;
revoke all on function public.handle_cast_permanent(uuid, public.game_stack_items) from public;
revoke all on function public.handle_triggered_ability(uuid, public.game_stack_items) from public;

-- ---------------------------------------------------------------------------
-- Seed the registry (idempotent). Mirrors the old if/elsif chain exactly.
-- ---------------------------------------------------------------------------
insert into public.stack_action_handlers (action_type, handler_fn, description) values
  ('deal_damage_player',   'handle_deal_damage_player', 'Damage a player''s life total'),
  ('deal_damage_creature', 'handle_creature_effect',    'Mark damage on a creature (apply_creature_effect)'),
  ('pump_creature',        'handle_creature_effect',    'Pump a creature until end of turn'),
  ('destroy_creature',     'handle_creature_effect',    'Destroy a creature'),
  ('exile_creature',       'handle_creature_effect',    'Exile a creature'),
  ('bounce_creature',      'handle_creature_effect',    'Return a creature to hand'),
  ('tap_creature',         'handle_creature_effect',    'Tap a creature'),
  ('untap_creature',       'handle_creature_effect',    'Untap a creature'),
  ('add_counters_creature','handle_creature_effect',    'Add +1/+1 (or other) counters to a creature'),
  ('grant_keyword_creature','handle_creature_effect',   'Grant a keyword to a creature until end of turn'),
  ('fight_creatures',      'handle_fight_creatures',    'Two creatures fight (apply_fight)'),
  ('draw_cards',           'handle_draw_cards',         'Draw cards for the controller'),
  ('scry',                 'handle_scry_surveil',       'Scry N (park a decision)'),
  ('surveil',              'handle_scry_surveil',       'Surveil N (park a decision)'),
  ('spell_effect',         'handle_spell_effect',       'Run a spell effect program'),
  ('modal_spell',          'handle_modal_spell',        'Apply chosen modes of a modal spell'),
  ('counter_spell',        'handle_counter_spell',      'Counter a targeted pending stack item'),
  ('cast_permanent',       'handle_cast_permanent',     'Resolve a permanent spell onto the battlefield'),
  ('triggered_ability',    'handle_triggered_ability',  'Resolve a triggered ability (may target/park)')
on conflict (action_type) do update
  set handler_fn = excluded.handler_fn,
      description = excluded.description;

-- ---------------------------------------------------------------------------
-- The dispatcher. Auth/session/lock/top-item selection are unchanged; the old
-- ~190-line if/elsif chain becomes a table lookup + dynamic call.
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
