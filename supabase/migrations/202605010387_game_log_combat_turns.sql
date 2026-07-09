-- 202605010387_game_log_combat_turns
-- The shared game log (migs 330/331) only knew casts/resolves, life/poison and
-- +1/+1 counters — no turn or combat context at all, so the log panel and the
-- post-game coach couldn't see WHEN anything happened or how games were won.
-- Adds additive AFTER triggers, same pattern as 330/331 (engine flow untouched):
--   • game_turn_state:            "turn N begins"
--   • game_combat_assignments:    "attacks seat N with X" / "attacks <pw> with X"
--   • game_combat_blockers:       "blocks X with Y"
--   • game_cards:                 "X dies" / "X is exiled" (creatures leaving
--                                 the battlefield)
--   • game_sessions:              "wins the game" when a session finishes
-- (IDE T-SQL false-positives on $$.)

create or replace function public.log_turn_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.turn_number is distinct from OLD.turn_number and NEW.active_player_id is not null then
    insert into public.game_action_log (id, session_id, actor_player_id, action_type, description, before_state, after_state, created_at)
    values (gen_random_uuid(), NEW.session_id, NEW.active_player_id, 'turn',
      'turn ' || NEW.turn_number || ' begins', '{}'::jsonb, '{}'::jsonb, now());
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_log_turn_change on public.game_turn_state;
create trigger trg_log_turn_change
after update on public.game_turn_state
for each row execute function public.log_turn_change();

create or replace function public.log_combat_attack()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attacker text;
  v_target text;
begin
  if NEW.attacking_player_id is null then
    return NEW;
  end if;

  select coalesce(c.name, 'a creature') into v_attacker
  from public.game_cards gc
  left join public.cards c on c.id = gc.card_id
  where gc.id = NEW.attacker_card_id;

  if NEW.defending_planeswalker_id is not null then
    select coalesce(c.name, 'a planeswalker') into v_target
    from public.game_cards gc
    left join public.cards c on c.id = gc.card_id
    where gc.id = NEW.defending_planeswalker_id;
  else
    select 'seat ' || gsp.seat_number into v_target
    from public.game_session_players gsp
    where gsp.session_id = NEW.session_id and gsp.player_id = NEW.defending_player_id;
  end if;

  insert into public.game_action_log (id, session_id, actor_player_id, action_type, description, before_state, after_state, created_at)
  values (gen_random_uuid(), NEW.session_id, NEW.attacking_player_id, 'attack',
    'attacks ' || coalesce(v_target, 'the defender') || ' with ' || coalesce(v_attacker, 'a creature'),
    '{}'::jsonb, '{}'::jsonb, now());
  return NEW;
end;
$$;

drop trigger if exists trg_log_combat_attack on public.game_combat_assignments;
create trigger trg_log_combat_attack
after insert on public.game_combat_assignments
for each row execute function public.log_combat_attack();

create or replace function public.log_combat_block()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attacker text;
  v_blocker text;
begin
  if NEW.blocking_player_id is null then
    return NEW;
  end if;

  select coalesce(c.name, 'a creature') into v_attacker
  from public.game_cards gc
  left join public.cards c on c.id = gc.card_id
  where gc.id = NEW.attacker_card_id;

  select coalesce(c.name, 'a creature') into v_blocker
  from public.game_cards gc
  left join public.cards c on c.id = gc.card_id
  where gc.id = NEW.blocker_card_id;

  insert into public.game_action_log (id, session_id, actor_player_id, action_type, description, before_state, after_state, created_at)
  values (gen_random_uuid(), NEW.session_id, NEW.blocking_player_id, 'block',
    'blocks ' || coalesce(v_attacker, 'an attacker') || ' with ' || coalesce(v_blocker, 'a creature'),
    '{}'::jsonb, '{}'::jsonb, now());
  return NEW;
end;
$$;

drop trigger if exists trg_log_combat_block on public.game_combat_blockers;
create trigger trg_log_combat_block
after insert on public.game_combat_blockers
for each row execute function public.log_combat_block();

create or replace function public.log_card_death()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_type text;
  v_actor uuid;
begin
  if OLD.zone <> 'battlefield' or NEW.zone not in ('graveyard', 'exile') then
    return NEW;
  end if;

  select c.name, c.type_line into v_name, v_type
  from public.cards c
  where c.id = NEW.card_id;

  -- Creatures only: lands/rocks hitting the bin every game is noise; a creature
  -- dying (or being exiled off the battlefield) is a story beat.
  if v_name is null or v_type is null or v_type not ilike '%creature%' then
    return NEW;
  end if;

  v_actor := coalesce(NEW.controller_player_id, NEW.owner_id);
  if v_actor is null then
    return NEW;
  end if;

  insert into public.game_action_log (id, session_id, actor_player_id, action_type, description, before_state, after_state, created_at)
  values (gen_random_uuid(), NEW.session_id, v_actor, 'death',
    v_name || case when NEW.zone = 'exile' then ' is exiled' else ' dies' end,
    '{}'::jsonb, '{}'::jsonb, now());
  return NEW;
end;
$$;

drop trigger if exists trg_log_card_death on public.game_cards;
create trigger trg_log_card_death
after update of zone on public.game_cards
for each row execute function public.log_card_death();

create or replace function public.log_session_finish()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.status = 'finished' and coalesce(OLD.status, '') <> 'finished' and NEW.winner_player_id is not null then
    insert into public.game_action_log (id, session_id, actor_player_id, action_type, description, before_state, after_state, created_at)
    values (gen_random_uuid(), NEW.id, NEW.winner_player_id, 'game_end',
      'wins the game', '{}'::jsonb, '{}'::jsonb, now());
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_log_session_finish on public.game_sessions;
create trigger trg_log_session_finish
after update on public.game_sessions
for each row execute function public.log_session_finish();
