-- 202605010331_game_log_outcomes
-- Extend the shared game log (mig 330) with OUTCOMES — what effects actually did —
-- via additive AFTER triggers on the affected tables, so the engine's effect
-- resolvers stay untouched:
--   • game_session_players: life changes ("life 40 → 33") and poison counters.
--   • game_cards: gaining +1/+1 counters ("X gets +1/+1 (now N)") — covers
--     Eshki-style "whenever you cast a creature, put a +1/+1 counter" payoffs.
-- Both write into game_action_log (read-policied for members; published mig 330).
-- (IDE T-SQL false-positives on $$.)

create or replace function public.log_player_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_poison integer;
  v_new_poison integer;
begin
  if NEW.life_total is distinct from OLD.life_total then
    insert into public.game_action_log (id, session_id, actor_player_id, action_type, description, before_state, after_state, created_at)
    values (gen_random_uuid(), NEW.session_id, NEW.player_id, 'life',
      'life ' || OLD.life_total || ' → ' || NEW.life_total, '{}'::jsonb, '{}'::jsonb, now());
  end if;

  v_old_poison := coalesce((OLD.counters ->> 'poison')::integer, 0);
  v_new_poison := coalesce((NEW.counters ->> 'poison')::integer, 0);
  if v_new_poison <> v_old_poison then
    insert into public.game_action_log (id, session_id, actor_player_id, action_type, description, before_state, after_state, created_at)
    values (gen_random_uuid(), NEW.session_id, NEW.player_id, 'poison',
      'poison ' || v_old_poison || ' → ' || v_new_poison
        || case when v_new_poison >= 10 then ' (lethal)' when v_new_poison >= 3 then ' (corrupted)' else '' end,
      '{}'::jsonb, '{}'::jsonb, now());
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_log_player_change on public.game_session_players;
create trigger trg_log_player_change
after update on public.game_session_players
for each row execute function public.log_player_change();

create or replace function public.log_card_counter_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_actor uuid;
begin
  -- Only log GAINING +1/+1 counters on a battlefield permanent (the common, most
  -- interesting case — add_counters payoffs / proliferate). Losing them (−1/−1,
  -- removal) is quieter and skipped to avoid noise.
  if coalesce(NEW.plus_one_counters, 0) > coalesce(OLD.plus_one_counters, 0)
     and NEW.zone = 'battlefield' then
    v_actor := coalesce(NEW.controller_player_id, NEW.owner_id);
    if v_actor is not null then
      select c.name into v_name from public.cards c where c.id = NEW.card_id;
      insert into public.game_action_log (id, session_id, actor_player_id, action_type, description, before_state, after_state, created_at)
      values (gen_random_uuid(), NEW.session_id, v_actor, 'counter',
        coalesce(v_name, 'A permanent') || ' gets +1/+1 (now ' || NEW.plus_one_counters || ')',
        '{}'::jsonb, '{}'::jsonb, now());
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_log_card_counter on public.game_cards;
create trigger trg_log_card_counter
after update on public.game_cards
for each row execute function public.log_card_counter_change();
