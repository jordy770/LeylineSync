-- Triggered abilities (Phase 3, first slice): enters-the-battlefield and
-- beginning-of-upkeep triggers, with auto-resolved effects that need no
-- player-chosen target.
--
-- Design
--   * Events are detected by database triggers (same pattern as the token
--     cease-to-exist trigger): a card entering the battlefield, or the turn
--     state advancing into the upkeep step.
--   * When an event fires, each matching triggered ability is enqueued onto the
--     existing stack as a 'triggered_ability' item. The ability's effects and
--     its controller are baked into the stack payload, so resolution does not
--     depend on the source permanent still existing.
--   * resolve_top_of_stack applies the effects when the trigger resolves, using
--     fixed recipients (controller / each opponent) rather than chosen targets.
--     Targeted triggers (e.g. "destroy target creature") are a later slice.
--
-- Supported effect shapes inside a triggered ability:
--   { "type": "gain_life",   "amount": N }                         -> controller gains N
--   { "type": "lose_life",   "amount": N, "recipient": "each_opponent" | "controller" }
--   { "type": "deal_damage", "amount": N, "recipient": "each_opponent" | "controller" }
--   { "type": "draw",        "amount": N }                         -> controller draws N
--
-- Supported trigger events (script triggered_abilities[].event):
--   enters_the_battlefield | etb | enters
--   beginning_of_upkeep | upkeep

-- 1. Allow the new stack action type.
alter table public.game_stack_items
drop constraint if exists game_stack_items_action_type_check;

alter table public.game_stack_items
add constraint game_stack_items_action_type_check
check (action_type in (
  'deal_damage_player',
  'deal_damage_creature',
  'pump_creature',
  'cast_permanent',
  'counter_spell',
  'triggered_ability'
));

-- 2. Enqueue one triggered ability onto the top of the stack. Internal helper:
-- called from event triggers, so it does not gate on auth.uid().
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
begin
  if p_effects is null or jsonb_typeof(p_effects) <> 'array' or jsonb_array_length(p_effects) = 0 then
    return;
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
      'timing', 'triggered'
    ),
    v_next_position
  );
end;
$$;

-- 3. Scan a card's effective behavior script for triggered abilities matching an
-- event, and enqueue each. Effective script = copied_script override, else the
-- catalog card's script (same precedence the rest of the runtime uses).
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
  v_script jsonb;
  v_ability jsonb;
  v_event text;
begin
  select
    coalesce(game_cards.controller_player_id, game_cards.owner_id),
    coalesce(game_cards.copied_script, cards.script)
  into v_controller, v_script
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id;

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
        coalesce(v_ability ->> 'id', v_event),
        v_ability -> 'effects'
      );
    end if;
  end loop;
end;
$$;

-- 4a. ETB: fire enters-the-battlefield triggers when a card's zone becomes
-- battlefield (on insert, e.g. tokens/spawns, or on update from another zone).
create or replace function public.fire_etb_triggers()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.zone = 'battlefield'
    and (TG_OP = 'INSERT' or OLD.zone is distinct from 'battlefield')
  then
    perform public.fire_card_triggers(
      NEW.session_id,
      NEW.id,
      array['enters_the_battlefield', 'etb', 'enters']
    );
  end if;

  return null;
end;
$$;

-- Name chosen to sort before trg_cease_token_off_battlefield so a token's own
-- ETB trigger is enqueued before any cease-to-exist handling runs.
drop trigger if exists trg_a_fire_etb on public.game_cards;
create trigger trg_a_fire_etb
after insert or update of zone on public.game_cards
for each row
execute function public.fire_etb_triggers();

-- 4b. Upkeep: when the turn advances into the upkeep step, fire beginning-of-
-- upkeep triggers for the active player's battlefield permanents.
create or replace function public.fire_upkeep_triggers()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card uuid;
begin
  if NEW.step = 'upkeep' and OLD.step is distinct from 'upkeep' then
    for v_card in
      select game_cards.id
      from public.game_cards
      where game_cards.session_id = NEW.session_id
        and game_cards.zone = 'battlefield'
        and coalesce(game_cards.controller_player_id, game_cards.owner_id) = NEW.active_player_id
      order by game_cards.zone_position, game_cards.id
    loop
      perform public.fire_card_triggers(
        NEW.session_id,
        v_card,
        array['beginning_of_upkeep', 'upkeep']
      );
    end loop;
  end if;

  return null;
end;
$$;

drop trigger if exists trg_fire_upkeep on public.game_turn_state;
create trigger trg_fire_upkeep
after update of step on public.game_turn_state
for each row
execute function public.fire_upkeep_triggers();

-- 5. resolve_top_of_stack: add the 'triggered_ability' branch. Reproduces the
-- creature-targeting version (migration 071) with the new branch appended.
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
  v_amount integer;
  v_next_battlefield_position integer;
  v_next_graveyard_position integer;
  v_finish_state jsonb;
  -- triggered_ability locals
  v_controller uuid;
  v_effect jsonb;
  v_eff_type text;
  v_eff_amount integer;
  v_recipient text;
  v_recipients uuid[];
  v_rid uuid;
  v_draw_i integer;
  v_lib_card uuid;
  v_next_hand_position integer;
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

    -- Spell fizzles harmlessly if the target left the battlefield.
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
    v_controller := nullif(v_stack_item.payload ->> 'controller_player_id', '')::uuid;

    for v_effect in
      select * from jsonb_array_elements(coalesce(v_stack_item.payload -> 'effects', '[]'::jsonb))
    loop
      v_eff_type := lower(coalesce(v_effect ->> 'type', ''));
      v_eff_amount := coalesce((v_effect ->> 'amount')::integer, 0);
      v_recipient := lower(coalesce(v_effect ->> 'recipient', ''));

      if v_eff_type = 'gain_life' then
        if v_eff_amount > 0 and v_controller is not null then
          update public.game_session_players
          set life_total = life_total + v_eff_amount
          where session_id = p_session_id
            and player_id = v_controller;
        end if;
      elsif v_eff_type in ('lose_life', 'deal_damage') then
        if v_eff_amount > 0 then
          -- Default recipient: each opponent (a drain/ping). 'controller' = self.
          if v_recipient = 'controller' then
            v_recipients := array[v_controller];
          else
            select array_agg(player_id)
            into v_recipients
            from public.game_session_players
            where session_id = p_session_id
              and player_id is distinct from v_controller;
          end if;

          foreach v_rid in array coalesce(v_recipients, array[]::uuid[])
          loop
            update public.game_session_players
            set life_total = greatest(0, life_total - v_eff_amount)
            where session_id = p_session_id
              and player_id = v_rid;
          end loop;
        end if;
      elsif v_eff_type = 'draw' then
        if v_controller is not null then
          for v_draw_i in 1..greatest(1, v_eff_amount) loop
            select coalesce(max(zone_position), -1) + 1
            into v_next_hand_position
            from public.game_cards
            where session_id = p_session_id
              and owner_id = v_controller
              and zone = 'hand';

            select id
            into v_lib_card
            from public.game_cards
            where session_id = p_session_id
              and owner_id = v_controller
              and zone = 'library'
            order by zone_position asc, id asc
            limit 1
            for update skip locked;

            exit when v_lib_card is null;  -- library empty: stop (loss SBA is out of scope here)

            update public.game_cards
            set zone = 'hand', zone_position = v_next_hand_position, is_tapped = false
            where id = v_lib_card;
          end loop;
        end if;
      end if;
      -- Unknown effect types are ignored (forward-compatible).
    end loop;
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

-- 6. Seed test cards exercising the two events.
insert into public.cards (id, name, type_line, mana_cost, power_toughness, oracle_text, script)
select gen_random_uuid(), v.name, v.type_line, v.mana_cost, v.power_toughness, v.oracle_text, v.script::jsonb
from (values
  (
    'Welcome Drain Test',
    'Creature - Spirit',
    '{1}{B}',
    '2/2',
    'When Welcome Drain Test enters the battlefield, each opponent loses 2 life and you gain 2 life.',
    '{"schema_version":2,"triggered_abilities":[{"event":"enters_the_battlefield","effects":[{"type":"lose_life","amount":2,"recipient":"each_opponent"},{"type":"gain_life","amount":2}]}]}'
  ),
  (
    'Upkeep Scholar Test',
    'Creature - Human Wizard',
    '{2}{U}',
    '1/3',
    'At the beginning of your upkeep, you gain 1 life.',
    '{"schema_version":2,"triggered_abilities":[{"event":"beginning_of_upkeep","effects":[{"type":"gain_life","amount":1}]}]}'
  )
) as v(name, type_line, mana_cost, power_toughness, oracle_text, script)
where not exists (
  select 1 from public.cards where lower(name) = lower(v.name)
);

grant execute on function public.enqueue_triggered_ability(uuid, uuid, uuid, text, jsonb) to authenticated;
grant execute on function public.fire_card_triggers(uuid, uuid, text[]) to authenticated;
grant execute on function public.resolve_top_of_stack(uuid) to authenticated;
