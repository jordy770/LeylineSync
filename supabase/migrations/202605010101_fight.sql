-- Tier-2 effect: fight (the first MULTI-target effect).
--
-- "Target creature you control fights target creature" — each creature deals
-- damage equal to its power to the other, simultaneously (CR 701.12). Both can
-- die to state-based actions. If either creature has left the battlefield as the
-- spell resolves, neither fights (the spell fizzles for that pair).
--
-- Mechanic reuses the existing primitives — zero new damage/death code:
--   * card_effective_power(session, card) gives printed power + counters + pumps.
--   * apply_creature_effect('deal_damage', target, {amount}) marks damage and
--     re-runs the lethal-damage SBA sweep (same path combat & burn use).
-- apply_fight reads BOTH powers up front (so a creature that dies still deals its
-- damage — fight is simultaneous), then applies both hits.
--
-- Cast path: a dedicated cast_fight RPC (parallels cast_modal_spell / cast_scry /
-- cast_spell_effect — the established pattern for spell shapes that don't fit
-- put_action_on_stack's single-target payload). It pays mana like the other
-- creature-targeting spells. Resolution: a 'fight_creatures' branch in
-- resolve_top_of_stack dispatches to apply_fight.
--
-- Scope: SPELL path (Prey Upon / Pit Fight class). Deferred follow-ups: the
-- in-app two-creature picker UI, form authoring (fight is the first effect needing
-- two target pickers), and a trigger-path fight ("when this enters, it fights
-- target creature"). (IDE T-SQL false-positives on $$ bodies — ignore.)

alter table public.game_stack_items
  drop constraint if exists game_stack_items_action_type_check;
alter table public.game_stack_items
  add constraint game_stack_items_action_type_check
  check (action_type = any (array[
    'deal_damage_player', 'deal_damage_creature', 'pump_creature', 'cast_permanent',
    'counter_spell', 'triggered_ability', 'draw_cards', 'destroy_creature',
    'bounce_creature', 'tap_creature', 'untap_creature', 'add_counters_creature',
    'exile_creature', 'grant_keyword_creature', 'fight_creatures', 'modal_spell',
    'scry', 'surveil', 'spell_effect'
  ]));

-- The fight mechanic. Simultaneous: capture both powers before any damage, so a
-- creature that dies still dealt its hit. Fizzles if either has left the field.
create or replace function public.apply_fight(
  p_session_id uuid,
  p_fighter_card_id uuid,
  p_fought_card_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_power_fighter integer;
  v_power_fought integer;
begin
  if p_fighter_card_id is null or p_fought_card_id is null then
    return;
  end if;

  -- Both must still be creatures on the battlefield; otherwise neither fights.
  if not exists (
    select 1 from public.game_cards
    where id = p_fighter_card_id and session_id = p_session_id and zone = 'battlefield'
  ) or not exists (
    select 1 from public.game_cards
    where id = p_fought_card_id and session_id = p_session_id and zone = 'battlefield'
  ) then
    return;
  end if;

  v_power_fighter := greatest(coalesce(public.card_effective_power(p_session_id, p_fighter_card_id), 0), 0);
  v_power_fought  := greatest(coalesce(public.card_effective_power(p_session_id, p_fought_card_id), 0), 0);

  -- Each deals its power to the other (apply_creature_effect re-runs lethal SBAs;
  -- amount 0 is a harmless no-op).
  perform public.apply_creature_effect(
    p_session_id, 'deal_damage', p_fought_card_id,
    jsonb_build_object('amount', v_power_fighter)
  );
  perform public.apply_creature_effect(
    p_session_id, 'deal_damage', p_fighter_card_id,
    jsonb_build_object('amount', v_power_fought)
  );
end;
$$;

grant execute on function public.apply_fight(uuid, uuid, uuid) to authenticated;

-- Cast a fight spell. Modeled on cast_spell_effect's timing/priority/source-move
-- logic; adds mana payment and validates both creatures (fighter is one you
-- control; the fought creature is any creature on the battlefield; they differ).
create or replace function public.cast_fight(
  p_session_id uuid,
  p_fighter_card_id uuid,
  p_fought_card_id uuid,
  p_source_card_id uuid default null,
  p_fought_controller text default 'any'
)
returns public.game_stack_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn public.game_turn_state;
  v_session_status text;
  v_source_type_line text;
  v_source_zone text;
  v_source_mana_cost text;
  v_timing text;
  v_pending integer;
  v_next_position integer;
  v_next_graveyard integer;
  v_stack public.game_stack_items;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if p_fighter_card_id is null or p_fought_card_id is null then
    raise exception 'Fight requires two creature targets';
  end if;

  if p_fighter_card_id = p_fought_card_id then
    raise exception 'A creature cannot fight itself';
  end if;

  select status into v_session_status
  from public.game_sessions where id = p_session_id for update;
  if not found then
    raise exception 'Game session not found';
  end if;
  if v_session_status = 'finished' then
    raise exception 'Cannot cast in a finished game session';
  end if;

  select * into v_turn
  from public.game_turn_state where session_id = p_session_id for update;
  if not found then
    raise exception 'Turn state not found';
  end if;
  if coalesce(v_turn.priority_player_id, v_turn.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can cast';
  end if;

  if p_source_card_id is not null then
    select cards.type_line, cards.mana_cost, game_cards.zone
      into v_source_type_line, v_source_mana_cost, v_source_zone
    from public.game_cards
    join public.cards on cards.id = game_cards.card_id
    where game_cards.id = p_source_card_id
      and game_cards.session_id = p_session_id
      and game_cards.owner_id = auth.uid();
    if not found then
      raise exception 'Source card not found or not owned by current user';
    end if;
  end if;

  -- Timing: sorceries main-phase only; a sourceless cast (tests) defaults to instant.
  if v_source_type_line ilike '%sorcery%' then
    v_timing := 'sorcery';
  else
    v_timing := 'instant';
  end if;

  if v_timing = 'sorcery' then
    if v_turn.active_player_id <> auth.uid() then
      raise exception 'Sorcery actions can only be used by the active player';
    end if;
    if v_turn.step not in ('precombat_main', 'postcombat_main') then
      raise exception 'Sorcery actions can only be used during a main phase';
    end if;
    select count(*) into v_pending
    from public.game_stack_items
    where session_id = p_session_id and status = 'pending';
    if v_pending > 0 then
      raise exception 'Sorcery actions can only be used while the stack is empty';
    end if;
  end if;

  -- The fighter is a creature you control; the fought creature is any creature on
  -- the battlefield. (Targeting is rechecked at resolution via apply_fight.)
  if not public.creature_target_controller_ok(p_session_id, p_fighter_card_id, auth.uid(), 'you') then
    raise exception 'The fighting creature must be a creature you control';
  end if;
  if not public.creature_target_controller_ok(
       p_session_id, p_fought_card_id, auth.uid(),
       coalesce(lower(nullif(p_fought_controller, '')), 'any')
     ) then
    raise exception 'The fought target is not a legal creature for this spell';
  end if;

  -- Generic-mana cost splitting isn't surfaced by this RPC yet; fight spells with
  -- generic mana in their cost are a follow-up (pass null = auto/colored only).
  if p_source_card_id is not null and v_source_zone = 'hand' then
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_source_mana_cost, null::jsonb);
  end if;

  select coalesce(max(position), 0) + 1 into v_next_position
  from public.game_stack_items where session_id = p_session_id;

  insert into public.game_stack_items (
    session_id, controller_player_id, source_card_id, action_type, payload, position, status
  )
  values (
    p_session_id,
    auth.uid(),
    p_source_card_id,
    'fight_creatures',
    jsonb_build_object(
      'target_card_id', p_fighter_card_id,
      'target_card_id_2', p_fought_card_id,
      'timing', v_timing
    ),
    v_next_position,
    'pending'
  )
  returning * into v_stack;

  -- Non-permanent spell: move the card from hand to the graveyard on cast.
  if p_source_card_id is not null
    and v_source_zone = 'hand'
    and (v_source_type_line ilike '%instant%' or v_source_type_line ilike '%sorcery%')
  then
    select coalesce(max(zone_position), -1) + 1 into v_next_graveyard
    from public.game_cards
    where session_id = p_session_id and owner_id = auth.uid() and zone = 'graveyard';

    update public.game_cards
    set zone = 'graveyard', zone_position = v_next_graveyard, is_tapped = false, damage_marked = 0
    where id = p_source_card_id;
  end if;

  return v_stack;
end;
$$;

grant execute on function public.cast_fight(uuid, uuid, uuid, uuid, text) to authenticated;

-- resolve_top_of_stack: reproduced from mig 100 with a 'fight_creatures' branch.
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
  v_scry_options jsonb;
  v_decision_id uuid;
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
    'add_counters_creature',
    'grant_keyword_creature'
  ) then
    perform public.apply_creature_effect(
      p_session_id,
      regexp_replace(v_stack_item.action_type, '_creature$', ''),
      nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid,
      v_stack_item.payload
    );
  elsif v_stack_item.action_type = 'fight_creatures' then
    perform public.apply_fight(
      p_session_id,
      nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid,
      nullif(v_stack_item.payload ->> 'target_card_id_2', '')::uuid
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
  elsif v_stack_item.action_type in ('scry', 'surveil') then
    v_amount := coalesce((v_stack_item.payload ->> 'amount')::integer, 1);

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
        and owner_id = v_stack_item.controller_player_id
        and zone = 'library'
      order by zone_position asc, id asc
      limit v_amount
    ) top
    join public.cards c on c.id = top.card_id;

    if jsonb_array_length(v_scry_options) = 0 then
      return public.finalize_stack_resolution(p_session_id, v_stack_item.id);
    end if;

    insert into public.game_pending_decisions (
      session_id, deciding_player_id, source_stack_item_id, decision_type,
      prompt, options, min_choices, max_choices
    )
    values (
      p_session_id,
      v_stack_item.controller_player_id,
      v_stack_item.id,
      v_stack_item.action_type,
      initcap(v_stack_item.action_type) || ' ' || v_amount,
      v_scry_options,
      0,
      jsonb_array_length(v_scry_options)
    )
    returning id into v_decision_id;

    update public.game_stack_items
    set status = 'awaiting_decision'
    where id = v_stack_item.id;

    return jsonb_build_object(
      'awaiting_decision', true,
      'decision_id', v_decision_id,
      'decision_type', v_stack_item.action_type,
      'stack_item_id', v_stack_item.id
    );
  elsif v_stack_item.action_type = 'spell_effect' then
    v_decision_id := public.apply_trigger_effects(p_session_id, v_stack_item.id, 0);
    if v_decision_id is not null then
      return jsonb_build_object(
        'awaiting_decision', true,
        'decision_id', v_decision_id,
        'stack_item_id', v_stack_item.id
      );
    end if;
  elsif v_stack_item.action_type = 'modal_spell' then
    perform public.apply_modal_spell(p_session_id, v_stack_item.id);
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

    v_decision_id := public.apply_trigger_effects(p_session_id, v_stack_item.id, 0);
    if v_decision_id is not null then
      return jsonb_build_object(
        'awaiting_decision', true,
        'decision_id', v_decision_id,
        'stack_item_id', v_stack_item.id
      );
    end if;
  else
    raise exception 'Unsupported stack action type: %', v_stack_item.action_type;
  end if;

  return public.finalize_stack_resolution(p_session_id, v_stack_item.id);
end;
$$;

grant execute on function public.resolve_top_of_stack(uuid) to authenticated;
