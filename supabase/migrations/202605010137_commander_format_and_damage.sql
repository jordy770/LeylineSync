-- Commander (EDH), slice 2 — format-aware game start + COMMANDER DAMAGE.
--
-- (1) Late-joiner life fix: create_game_session takes a format and starts the host
--     at the right life (40 for commander); join_game_session reads the session's
--     format so EVERY joiner gets the correct starting life. (set_commander_format,
--     mig 136, still works for flipping an existing game.)
-- (2) Commander damage (CR 903.10a): combat damage a player takes from a single
--     commander is tracked cumulatively; at 21 from one commander, that player loses.
--     Tracked at the one seam all player combat damage flows through —
--     apply_damage_to_player(..., is_combat => true) — so unblocked + trample
--     commander damage both count. Reaching 21 sets the player's life to 0, which the
--     end-of-combat maybe_finish_game_session turns into a loss/win.
--
-- Reproduced fns: create_game_session (baseline lift + format), join_game_session
-- (baseline lift + format life), apply_damage_to_player (mig 125 lift + commander
-- tracking). (IDE T-SQL false-positives on $$ bodies — ignore.)

-- ---------------------------------------------------------------------------
-- 1a. create_game_session(p_format) — drop the 0-arg form so the 1-arg (defaulted)
-- replaces it and existing no-arg callers still resolve. Host life follows format.
-- ---------------------------------------------------------------------------
drop function if exists public.create_game_session();

create or replace function public.create_game_session(p_format text default 'standard')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
  v_format text := lower(coalesce(p_format, 'standard'));
  v_life integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if v_format not in ('standard', 'commander') then
    raise exception 'Unsupported format: %', v_format;
  end if;

  v_life := case when v_format = 'commander' then 40 else 20 end;

  insert into public.game_sessions (created_by, format)
  values (auth.uid(), v_format)
  returning id into v_session_id;

  insert into public.game_session_players (session_id, player_id, seat_number, life_total)
  values (v_session_id, auth.uid(), 1, v_life);

  insert into public.game_turn_state (session_id, active_player_id, turn_number, phase, step)
  values (v_session_id, auth.uid(), 1, 'beginning', 'untap')
  on conflict (session_id) do nothing;

  return v_session_id;
end;
$$;

grant execute on function public.create_game_session(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 1b. join_game_session — a joiner's starting life follows the session's format.
-- ---------------------------------------------------------------------------
create or replace function public.join_game_session(p_session_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_format text;
  v_seat_number integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select status, format
  into v_status, v_format
  from public.game_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Game session not found';
  end if;

  if v_status <> 'open' then
    raise exception 'Game session is not open';
  end if;

  select seat_number
  into v_seat_number
  from public.game_session_players
  where session_id = p_session_id
    and player_id = auth.uid();

  if found then
    return v_seat_number;
  end if;

  select coalesce(max(seat_number), 0) + 1
  into v_seat_number
  from public.game_session_players
  where session_id = p_session_id;

  insert into public.game_session_players (session_id, player_id, seat_number, life_total)
  values (
    p_session_id,
    auth.uid(),
    v_seat_number,
    case when coalesce(v_format, 'standard') = 'commander' then 40 else 20 end
  );

  return v_seat_number;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Commander damage tracking.
-- ---------------------------------------------------------------------------
create table if not exists public.game_commander_damage (
  session_id uuid not null references public.game_sessions(id) on delete cascade,
  defender_player_id uuid not null,
  source_card_id uuid not null,                 -- the commander dealing the damage
  damage integer not null default 0,
  primary key (session_id, defender_player_id, source_card_id)
);

alter table public.game_commander_damage enable row level security;

-- Server-managed: only SECURITY DEFINER functions write; session players may read.
drop policy if exists "session players read commander damage" on public.game_commander_damage;
create policy "session players read commander damage"
  on public.game_commander_damage
  for select
  using (public.is_session_player(session_id, auth.uid()));

grant select on public.game_commander_damage to authenticated;
grant select on public.game_commander_damage to service_role;

-- apply_damage_to_player (mig 125 lift) — accumulate commander combat damage and
-- make 21-from-one-commander lethal. Only the trailing commander block is new.
create or replace function public.apply_damage_to_player(
  p_session_id uuid,
  p_player_id uuid,
  p_amount integer,
  p_source_card_id uuid default null,
  p_is_combat boolean default false
) returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_remaining integer := greatest(0, coalesce(p_amount, 0));
  v_turn integer;
  v_shield record;
  v_prevent integer;
  v_cmd_total integer;
begin
  if v_remaining <= 0 then
    return 0;
  end if;

  select turn_number into v_turn
  from public.game_turn_state where session_id = p_session_id;

  for v_shield in
    select * from public.game_damage_prevention
    where session_id = p_session_id
      and affected_player_id = p_player_id
      and (combat_only = false or p_is_combat = true)
      and (expires_turn is null or expires_turn >= coalesce(v_turn, 0))
    order by created_at asc, id asc
    for update
  loop
    exit when v_remaining <= 0;

    if v_shield.amount is null then
      -- Prevent-all shield: stops everything and persists for the turn.
      v_remaining := 0;
    else
      v_prevent := least(v_remaining, v_shield.amount);
      v_remaining := v_remaining - v_prevent;
      if v_shield.amount - v_prevent <= 0 then
        delete from public.game_damage_prevention where id = v_shield.id;
      else
        update public.game_damage_prevention
        set amount = amount - v_prevent
        where id = v_shield.id;
      end if;
    end if;
  end loop;

  if v_remaining > 0 then
    update public.game_session_players
    set life_total = greatest(0, life_total - v_remaining)
    where session_id = p_session_id
      and player_id = p_player_id;
  end if;

  -- Commander damage: combat damage from a commander accumulates per (defender,
  -- commander); 21 cumulative from one commander loses the game for that player.
  if p_is_combat
    and v_remaining > 0
    and p_source_card_id is not null
    and exists (
      select 1 from public.game_cards
      where id = p_source_card_id
        and session_id = p_session_id
        and is_commander = true
    )
  then
    insert into public.game_commander_damage (session_id, defender_player_id, source_card_id, damage)
    values (p_session_id, p_player_id, p_source_card_id, v_remaining)
    on conflict (session_id, defender_player_id, source_card_id)
    do update set damage = public.game_commander_damage.damage + excluded.damage
    returning damage into v_cmd_total;

    if v_cmd_total >= 21 then
      update public.game_session_players
      set life_total = 0
      where session_id = p_session_id
        and player_id = p_player_id;
    end if;
  end if;

  return v_remaining;
end;
$$;

grant execute on function public.apply_damage_to_player(uuid, uuid, integer, uuid, boolean) to authenticated;
grant execute on function public.apply_damage_to_player(uuid, uuid, integer, uuid, boolean) to service_role;
