-- Phase 3: broaden the set of detectable trigger events.
--
-- All of these reuse fire_card_triggers (migration 077) — they only add new
-- detectors that call it with new event names, so targeting / target_controller
-- (migrations 080–081) work for them automatically.
--
--   leaves_the_battlefield  — permanent moves battlefield -> any other zone
--   beginning_of_draw_step  — active player's permanents at the draw step
--   beginning_of_end_step   — active player's permanents at the end step
--   blocks                  — creature declared as a blocker
--   becomes_targeted        — creature targeted by a spell/ability on the stack

-- 1. Zone-change detector: keep ETB + dies, add leaves_the_battlefield.
--    dies and leaves_the_battlefield both fire when a creature goes to the
--    graveyard (as in real MTG).
create or replace function public.fire_zone_change_triggers()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Enters the battlefield.
  if NEW.zone = 'battlefield'
    and (TG_OP = 'INSERT' or OLD.zone is distinct from 'battlefield')
  then
    perform public.fire_card_triggers(
      NEW.session_id,
      NEW.id,
      array['enters_the_battlefield', 'etb', 'enters']
    );
  end if;

  -- Dies (moves from the battlefield to the graveyard).
  if TG_OP = 'UPDATE'
    and OLD.zone = 'battlefield'
    and NEW.zone = 'graveyard'
  then
    perform public.fire_card_triggers(
      NEW.session_id,
      NEW.id,
      array['dies', 'death']
    );
  end if;

  -- Leaves the battlefield (to any other zone, including graveyard/hand/exile).
  if TG_OP = 'UPDATE'
    and OLD.zone = 'battlefield'
    and NEW.zone is distinct from 'battlefield'
  then
    perform public.fire_card_triggers(
      NEW.session_id,
      NEW.id,
      array['leaves_the_battlefield', 'ltb', 'leaves']
    );
  end if;

  return null;
end;
$$;

-- 2. Turn-step detector: replaces fire_upkeep_triggers with a generic step
--    handler covering upkeep, draw, and end steps. Fires for the active player's
--    battlefield permanents when the step is newly entered.
create or replace function public.fire_turn_step_triggers()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card uuid;
  v_events text[];
begin
  if NEW.step is not distinct from OLD.step then
    return null;
  end if;

  v_events := case NEW.step
    when 'upkeep' then array['beginning_of_upkeep', 'upkeep']
    when 'draw' then array['beginning_of_draw_step', 'draw_step']
    when 'end' then array['beginning_of_end_step', 'end_step', 'beginning_of_end']
    else null
  end;

  if v_events is null then
    return null;
  end if;

  for v_card in
    select game_cards.id
    from public.game_cards
    where game_cards.session_id = NEW.session_id
      and game_cards.zone = 'battlefield'
      and coalesce(game_cards.controller_player_id, game_cards.owner_id) = NEW.active_player_id
    order by game_cards.zone_position, game_cards.id
  loop
    perform public.fire_card_triggers(NEW.session_id, v_card, v_events);
  end loop;

  return null;
end;
$$;

drop trigger if exists trg_fire_upkeep on public.game_turn_state;
drop trigger if exists trg_fire_turn_step on public.game_turn_state;
create trigger trg_fire_turn_step
after update of step on public.game_turn_state
for each row
execute function public.fire_turn_step_triggers();

drop function if exists public.fire_upkeep_triggers();

-- 3. Blocks: fire when a creature is declared as a blocker. Each block is a row
--    in game_combat_blockers (migration 049), so trigger on insert there.
create or replace function public.fire_block_triggers()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.fire_card_triggers(
    NEW.session_id,
    NEW.blocker_card_id,
    array['blocks', 'declares_block', 'block']
  );

  return null;
end;
$$;

drop trigger if exists trg_fire_block on public.game_combat_blockers;
create trigger trg_fire_block
after insert on public.game_combat_blockers
for each row
execute function public.fire_block_triggers();

-- 4. Becomes targeted: fire when a creature-targeting action is put on the stack
--    (deal_damage_creature / pump_creature / destroy/bounce/tap/untap/add_counters
--    _creature). These carry the target game_card id in payload.target_card_id.
--    The enqueued trigger lands above the targeting item (max(position)+1), so it
--    resolves first — the correct "becomes the target" ordering.
--
--    Only INSERT is handled, so triggered-ability targets (chosen post-insert via
--    an UPDATE) do not fire this; that keeps the detector loop-free (the enqueued
--    triggered_ability row is inserted without a target_card_id).
create or replace function public.fire_target_triggers()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_card_id uuid;
begin
  if NEW.action_type not in (
    'deal_damage_creature',
    'pump_creature',
    'destroy_creature',
    'bounce_creature',
    'tap_creature',
    'untap_creature',
    'add_counters_creature'
  ) then
    return null;
  end if;

  v_target_card_id := nullif(NEW.payload ->> 'target_card_id', '')::uuid;

  if v_target_card_id is not null then
    perform public.fire_card_triggers(
      NEW.session_id,
      v_target_card_id,
      array['becomes_targeted', 'targeted', 'becomes_target']
    );
  end if;

  return null;
end;
$$;

drop trigger if exists trg_fire_target on public.game_stack_items;
create trigger trg_fire_target
after insert on public.game_stack_items
for each row
execute function public.fire_target_triggers();

-- 5. Seed test cards for the new events.
insert into public.cards (id, name, type_line, mana_cost, power_toughness, oracle_text, script)
select gen_random_uuid(), v.name, v.type_line, v.mana_cost, v.power_toughness, v.oracle_text, v.script::jsonb
from (values
  (
    'Farewell Token Test',
    'Creature - Spirit',
    '{2}{W}',
    '2/2',
    'When Farewell Token Test leaves the battlefield, you gain 3 life.',
    '{"schema_version":2,"triggered_abilities":[{"event":"leaves_the_battlefield","effects":[{"type":"gain_life","amount":3}]}]}'
  ),
  (
    'Dawn Tithe Test',
    'Creature - Cleric',
    '{1}{W}',
    '1/2',
    'At the beginning of your end step, you gain 1 life.',
    '{"schema_version":2,"triggered_abilities":[{"event":"beginning_of_end_step","effects":[{"type":"gain_life","amount":1}]}]}'
  ),
  (
    'Morning Insight Test',
    'Creature - Wizard',
    '{2}{U}',
    '1/3',
    'At the beginning of your draw step, draw a card.',
    '{"schema_version":2,"triggered_abilities":[{"event":"beginning_of_draw_step","effects":[{"type":"draw","amount":1}]}]}'
  ),
  (
    'Vengeful Wall Test',
    'Creature - Wall',
    '{1}{R}',
    '0/4',
    'Whenever Vengeful Wall Test blocks, it deals 1 damage to each opponent.',
    '{"schema_version":2,"triggered_abilities":[{"event":"blocks","effects":[{"type":"deal_damage","amount":1,"recipient":"each_opponent"}]}]}'
  ),
  (
    'Spiteful Sentry Test',
    'Creature - Elemental',
    '{1}{B}',
    '2/2',
    'Whenever Spiteful Sentry Test becomes the target of a spell or ability, you draw a card.',
    '{"schema_version":2,"triggered_abilities":[{"event":"becomes_targeted","effects":[{"type":"draw","amount":1}]}]}'
  )
) as v(name, type_line, mana_cost, power_toughness, oracle_text, script)
where not exists (
  select 1 from public.cards where lower(name) = lower(v.name)
);

grant execute on function public.fire_zone_change_triggers() to authenticated;
grant execute on function public.fire_turn_step_triggers() to authenticated;
grant execute on function public.fire_block_triggers() to authenticated;
grant execute on function public.fire_target_triggers() to authenticated;
