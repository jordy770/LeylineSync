-- 202605010330_game_log
-- Shared, openable game log. Nothing wrote to game_action_log before (its read
-- policy + the judge feed already existed). Rather than thread log calls through
-- every engine function, a single AFTER trigger on game_stack_items records the
-- two most informative events: a spell going on the stack ("casts X") and a
-- spell/ability resolving ("X resolves" / "X's ability resolves"). Additive and
-- low-risk — it never changes the cast/resolve flow. Also publishes the table
-- for realtime so the log updates live. (IDE T-SQL false-positives on $$.)

create or replace function public.log_stack_item_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_desc text;
begin
  -- actor_player_id is NOT NULL; skip the rare item with no controller.
  if NEW.controller_player_id is null then
    return NEW;
  end if;

  if TG_OP = 'INSERT' then
    -- A spell hitting the stack. Triggers are logged on RESOLUTION instead, to
    -- keep the feed clean (a trigger that fires + resolves = one line).
    if NEW.action_type not in ('cast_permanent', 'cast_commander', 'spell_effect') then
      return NEW;
    end if;
    select coalesce(c.name, nullif(NEW.payload ->> 'label', ''), 'a spell')
    into v_name
    from public.game_cards gc
    left join public.cards c on c.id = gc.card_id
    where gc.id = NEW.source_card_id;
    v_desc := 'casts ' || coalesce(v_name, 'a spell');

  elsif TG_OP = 'UPDATE'
        and NEW.status = 'resolved'
        and coalesce(OLD.status, '') is distinct from 'resolved' then
    select coalesce(c.name, nullif(NEW.payload ->> 'label', ''), 'an ability')
    into v_name
    from public.game_cards gc
    left join public.cards c on c.id = gc.card_id
    where gc.id = NEW.source_card_id;
    if NEW.action_type = 'triggered_ability' then
      v_desc := coalesce(v_name, 'An ability') || '''s ability resolves';
    else
      v_desc := coalesce(v_name, 'A spell') || ' resolves';
    end if;

  else
    return NEW;
  end if;

  insert into public.game_action_log (
    id, session_id, actor_player_id, action_type, description, before_state, after_state, created_at
  )
  values (
    gen_random_uuid(), NEW.session_id, NEW.controller_player_id, NEW.action_type, v_desc,
    '{}'::jsonb, '{}'::jsonb, now()
  );

  return NEW;
end;
$$;

drop trigger if exists trg_log_stack_item on public.game_stack_items;
create trigger trg_log_stack_item
after insert or update on public.game_stack_items
for each row execute function public.log_stack_item_event();

-- Publish for realtime so the log panel updates live (guarded — no-op if present).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'game_action_log'
  ) then
    alter publication supabase_realtime add table public.game_action_log;
  end if;
end;
$$;
