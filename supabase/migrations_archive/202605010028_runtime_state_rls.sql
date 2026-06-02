alter table public.game_cards enable row level security;
alter table public.game_players enable row level security;
alter table public.game_turn_state enable row level security;
alter table public.game_combat_assignments enable row level security;

drop policy if exists "Session players can read game cards" on public.game_cards;
drop policy if exists "Players can read their own game player state" on public.game_players;
drop policy if exists "Session players can read turn state" on public.game_turn_state;
drop policy if exists "Players can read combat assignments in their sessions" on public.game_combat_assignments;

create policy "Session players can read game cards"
on public.game_cards
for select
to authenticated
using (public.is_session_player(session_id, auth.uid()));

create policy "Players can read their own game player state"
on public.game_players
for select
to authenticated
using (
  player_id = auth.uid()
  and public.is_session_player(session_id, auth.uid())
);

create policy "Session players can read turn state"
on public.game_turn_state
for select
to authenticated
using (public.is_session_player(session_id, auth.uid()));

create policy "Players can read combat assignments in their sessions"
on public.game_combat_assignments
for select
to authenticated
using (public.is_session_player(session_id, auth.uid()));

create or replace function public.set_card_tapped(
  p_game_card_id uuid,
  p_is_tapped boolean
)
returns public.game_cards
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card public.game_cards;
  v_session_status text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select *
  into v_card
  from public.game_cards
  where id = p_game_card_id
  for update;

  if not found then
    raise exception 'Game card not found';
  end if;

  if v_card.owner_id <> auth.uid() then
    raise exception 'Only the owner can tap or untap this card';
  end if;

  if not public.is_session_player(v_card.session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select status
  into v_session_status
  from public.game_sessions
  where id = v_card.session_id;

  if not found then
    raise exception 'Game session not found';
  end if;

  if v_session_status = 'finished' then
    raise exception 'Cannot tap or untap cards in a finished game session';
  end if;

  update public.game_cards
  set is_tapped = p_is_tapped
  where id = p_game_card_id
  returning * into v_card;

  return v_card;
end;
$$;

grant select on public.game_cards to authenticated;
grant select on public.game_players to authenticated;
grant select on public.game_turn_state to authenticated;
grant select on public.game_combat_assignments to authenticated;
grant execute on function public.set_card_tapped(uuid, boolean) to authenticated;

create or replace function public.move_card_to_zone(
  p_game_card_id uuid,
  p_zone text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card public.game_cards;
  v_session_status text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_zone not in ('library', 'hand', 'battlefield', 'graveyard', 'exile') then
    raise exception 'Invalid zone: %', p_zone;
  end if;

  select *
  into v_card
  from public.game_cards
  where id = p_game_card_id
  for update;

  if not found then
    raise exception 'Game card not found';
  end if;

  if v_card.owner_id <> auth.uid() then
    raise exception 'Only the owner can move this card';
  end if;

  if not public.is_session_player(v_card.session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select status
  into v_session_status
  from public.game_sessions
  where id = v_card.session_id;

  if not found then
    raise exception 'Game session not found';
  end if;

  if v_session_status = 'finished' then
    raise exception 'Cannot move cards in a finished game session';
  end if;

  update public.game_cards
  set
    zone = p_zone,
    is_tapped = false,
    damage_marked = 0
  where id = p_game_card_id;
end;
$$;

create or replace function public.draw_card(
  p_session_id uuid,
  p_player_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_card_id uuid;
  v_next_hand_position integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_player_id <> auth.uid() then
    raise exception 'Cannot draw for another player';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select status
  into v_session_status
  from public.game_sessions
  where id = p_session_id;

  if not found then
    raise exception 'Game session not found';
  end if;

  if v_session_status = 'finished' then
    raise exception 'Cannot draw cards in a finished game session';
  end if;

  select coalesce(max(zone_position), -1) + 1
  into v_next_hand_position
  from public.game_cards
  where session_id = p_session_id
    and owner_id = auth.uid()
    and zone = 'hand';

  select id
  into v_card_id
  from public.game_cards
  where session_id = p_session_id
    and owner_id = auth.uid()
    and zone = 'library'
  order by zone_position asc, id asc
  limit 1
  for update skip locked;

  if v_card_id is null then
    raise exception 'Library is empty';
  end if;

  update public.game_cards
  set
    zone = 'hand',
    zone_position = v_next_hand_position,
    is_tapped = false,
    damage_marked = 0
  where id = v_card_id;

  return v_card_id;
end;
$$;

create or replace function public.untap_all(
  p_session_id uuid,
  p_player_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_updated_count integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_player_id <> auth.uid() then
    raise exception 'Cannot untap cards for another player';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select status
  into v_session_status
  from public.game_sessions
  where id = p_session_id;

  if not found then
    raise exception 'Game session not found';
  end if;

  if v_session_status = 'finished' then
    raise exception 'Cannot untap cards in a finished game session';
  end if;

  update public.game_cards
  set is_tapped = false
  where session_id = p_session_id
    and owner_id = auth.uid()
    and zone = 'battlefield'
    and is_tapped = true;

  get diagnostics v_updated_count = row_count;

  return v_updated_count;
end;
$$;

create or replace function public.clear_mana_pool(
  p_session_id uuid,
  p_player_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_empty_pool jsonb := jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0);
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_player_id <> auth.uid() then
    raise exception 'Cannot clear another player mana pool';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select status
  into v_session_status
  from public.game_sessions
  where id = p_session_id;

  if not found then
    raise exception 'Game session not found';
  end if;

  if v_session_status = 'finished' then
    raise exception 'Cannot clear mana in a finished game session';
  end if;

  insert into public.game_players (session_id, player_id, mana_pool)
  values (p_session_id, p_player_id, v_empty_pool)
  on conflict (session_id, player_id)
  do update set mana_pool = excluded.mana_pool;

  return v_empty_pool;
end;
$$;

create or replace function public.add_mana_from_card(
  p_game_card_id uuid,
  p_session_id uuid,
  p_player_id uuid,
  p_color text,
  p_amount integer,
  p_should_tap_card boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_current_pool jsonb;
  v_new_pool jsonb;
  v_current_amount integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_color not in ('W', 'U', 'B', 'R', 'G', 'C') then
    raise exception 'Invalid mana color: %', p_color;
  end if;

  if p_amount <= 0 then
    raise exception 'Mana amount must be positive';
  end if;

  if p_player_id <> auth.uid() then
    raise exception 'Cannot update another player mana pool';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select status
  into v_session_status
  from public.game_sessions
  where id = p_session_id;

  if not found then
    raise exception 'Game session not found';
  end if;

  if v_session_status = 'finished' then
    raise exception 'Cannot add mana in a finished game session';
  end if;

  if p_should_tap_card then
    update public.game_cards
    set is_tapped = true
    where id = p_game_card_id
      and session_id = p_session_id
      and owner_id = auth.uid()
      and zone = 'battlefield'
      and is_tapped = false;

    if not found then
      raise exception 'Card not found, not on battlefield, not owned by current user, or already tapped';
    end if;
  else
    perform 1
    from public.game_cards
    where id = p_game_card_id
      and session_id = p_session_id
      and owner_id = auth.uid()
      and zone = 'battlefield';

    if not found then
      raise exception 'Card not found, not on battlefield, or not owned by current user';
    end if;
  end if;

  insert into public.game_players (session_id, player_id, mana_pool)
  values (
    p_session_id,
    p_player_id,
    jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0)
  )
  on conflict (session_id, player_id) do nothing;

  select coalesce(
    mana_pool,
    jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0)
  )
  into v_current_pool
  from public.game_players
  where session_id = p_session_id
    and player_id = p_player_id
  for update;

  v_current_amount := coalesce((v_current_pool ->> p_color)::integer, 0);
  v_new_pool := v_current_pool || jsonb_build_object(p_color, v_current_amount + p_amount);

  update public.game_players
  set mana_pool = v_new_pool
  where session_id = p_session_id
    and player_id = p_player_id;

  return v_new_pool;
end;
$$;

grant execute on function public.move_card_to_zone(uuid, text) to authenticated;
grant execute on function public.draw_card(uuid, uuid) to authenticated;
grant execute on function public.untap_all(uuid, uuid) to authenticated;
grant execute on function public.clear_mana_pool(uuid, uuid) to authenticated;
grant execute on function public.add_mana_from_card(uuid, uuid, uuid, text, integer, boolean) to authenticated;

create or replace function public.initialize_turn_state(
  p_session_id uuid,
  p_active_player_id uuid
)
returns public.game_turn_state
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_active_player_id <> auth.uid() then
    raise exception 'Cannot initialize turn state for another player';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select status
  into v_session_status
  from public.game_sessions
  where id = p_session_id;

  if not found then
    raise exception 'Game session not found';
  end if;

  if v_session_status = 'finished' then
    raise exception 'Cannot initialize turn state for a finished game session';
  end if;

  insert into public.game_turn_state (
    session_id,
    active_player_id,
    priority_player_id,
    turn_number,
    phase,
    step
  )
  values (
    p_session_id,
    p_active_player_id,
    p_active_player_id,
    1,
    'beginning',
    'untap'
  )
  on conflict (session_id) do update
  set session_id = excluded.session_id
  returning * into v_turn_state;

  return v_turn_state;
end;
$$;

grant execute on function public.initialize_turn_state(uuid, uuid) to authenticated;
