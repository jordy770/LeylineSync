-- Triggered abilities (Phase 3, second slice): dies and attacks events.
--
--   * dies    — a permanent moves from the battlefield to the graveyard.
--   * attacks — a creature is declared as an attacker (a row is inserted into
--               game_combat_assignments).
--
-- Both reuse the migration 076 machinery: fire_card_triggers scans the source's
-- effective script for matching events and enqueues each as a self-contained
-- 'triggered_ability' stack item, resolved by resolve_top_of_stack.
--
-- Two robustness details:
--   * game_stack_items.source_card_id is ON DELETE SET NULL, so a token's dies
--     trigger survives the token's cease-to-exist deletion (effects live in the
--     payload). We bake the source card's name into the payload 'label' and let
--     get_stack_items fall back to it, so the trigger still displays a name.
--   * The zone-change trigger sorts before trg_cease_token_off_battlefield, so a
--     token's own dies trigger is enqueued before the token is removed.

-- 1. fire_card_triggers: also capture the source card's name and pass it as the
-- enqueued ability's label (used for display when the source later disappears).
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
  v_card_name text;
  v_script jsonb;
  v_ability jsonb;
  v_event text;
begin
  select
    coalesce(game_cards.controller_player_id, game_cards.owner_id),
    cards.name,
    coalesce(game_cards.copied_script, cards.script)
  into v_controller, v_card_name, v_script
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
        coalesce(v_card_name, v_ability ->> 'id', v_event),
        v_ability -> 'effects'
      );
    end if;
  end loop;
end;
$$;

-- 2. Zone-change triggers: ETB (entering battlefield) and dies (battlefield ->
-- graveyard). Replaces the migration 076 ETB-only function/trigger.
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

  return null;
end;
$$;

drop trigger if exists trg_a_fire_etb on public.game_cards;
drop trigger if exists trg_a_fire_zone_change on public.game_cards;
create trigger trg_a_fire_zone_change
after insert or update of zone on public.game_cards
for each row
execute function public.fire_zone_change_triggers();

drop function if exists public.fire_etb_triggers();

-- 3. Attacks: fire when a creature is declared as an attacker.
create or replace function public.fire_attack_triggers()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.fire_card_triggers(
    NEW.session_id,
    NEW.attacker_card_id,
    array['attacks', 'declares_attack', 'attack']
  );

  return null;
end;
$$;

drop trigger if exists trg_fire_attack on public.game_combat_assignments;
create trigger trg_fire_attack
after insert on public.game_combat_assignments
for each row
execute function public.fire_attack_triggers();

-- 4. get_stack_items: fall back to the payload 'label' when the source card row
-- is gone (e.g. a token whose dies trigger is on the stack after it ceased).
-- Extends the migration 033 version (keeps target_player_id/target_username).
create or replace function public.get_stack_items(
  p_session_id uuid
)
returns table (
  id uuid,
  session_id uuid,
  controller_player_id uuid,
  controller_username text,
  source_card_id uuid,
  source_card_name text,
  target_player_id uuid,
  target_username text,
  action_type text,
  payload jsonb,
  "position" integer,
  status text,
  created_at timestamptz,
  resolved_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    stack_items.id,
    stack_items.session_id,
    stack_items.controller_player_id,
    coalesce(nullif(controller_profiles.username, ''), 'Unknown player') as controller_username,
    stack_items.source_card_id,
    coalesce(source_card.name, nullif(stack_items.payload ->> 'label', '')) as source_card_name,
    nullif(stack_items.payload ->> 'target_player_id', '')::uuid as target_player_id,
    coalesce(nullif(target_profiles.username, ''), 'Unknown player') as target_username,
    stack_items.action_type,
    stack_items.payload,
    stack_items.position,
    stack_items.status,
    stack_items.created_at,
    stack_items.resolved_at
  from public.game_stack_items stack_items
  left join public.profiles controller_profiles
    on controller_profiles.id = stack_items.controller_player_id
  left join public.game_cards source_instance
    on source_instance.id = stack_items.source_card_id
  left join public.cards source_card
    on source_card.id = source_instance.card_id
  left join public.profiles target_profiles
    on target_profiles.id = nullif(stack_items.payload ->> 'target_player_id', '')::uuid
  where stack_items.session_id = p_session_id
    and public.is_session_player(p_session_id, auth.uid())
  order by
    case stack_items.status when 'pending' then 0 else 1 end,
    stack_items.position desc,
    stack_items.created_at desc;
$$;

-- 5. Seed test cards for the two new events.
insert into public.cards (id, name, type_line, mana_cost, power_toughness, oracle_text, script)
select gen_random_uuid(), v.name, v.type_line, v.mana_cost, v.power_toughness, v.oracle_text, v.script::jsonb
from (values
  (
    'Parting Gift Test',
    'Creature - Spirit',
    '{1}{W}',
    '2/2',
    'When Parting Gift Test dies, you gain 2 life.',
    '{"schema_version":2,"triggered_abilities":[{"event":"dies","effects":[{"type":"gain_life","amount":2}]}]}'
  ),
  (
    'Raiding Berserker Test',
    'Creature - Human Berserker',
    '{1}{R}',
    '2/2',
    'Whenever Raiding Berserker Test attacks, it deals 1 damage to each opponent.',
    '{"schema_version":2,"triggered_abilities":[{"event":"attacks","effects":[{"type":"deal_damage","amount":1,"recipient":"each_opponent"}]}]}'
  )
) as v(name, type_line, mana_cost, power_toughness, oracle_text, script)
where not exists (
  select 1 from public.cards where lower(name) = lower(v.name)
);

grant execute on function public.fire_card_triggers(uuid, uuid, text[]) to authenticated;
grant execute on function public.fire_zone_change_triggers() to authenticated;
grant execute on function public.fire_attack_triggers() to authenticated;
grant execute on function public.get_stack_items(uuid) to authenticated;
