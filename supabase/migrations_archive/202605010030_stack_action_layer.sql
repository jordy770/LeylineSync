create table if not exists public.game_stack_items (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions(id) on delete cascade,
  controller_player_id uuid not null,
  source_card_id uuid references public.game_cards(id) on delete set null,
  action_type text not null,
  payload jsonb not null default '{}'::jsonb,
  position integer not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint game_stack_items_status_check
    check (status in ('pending', 'resolved', 'cancelled')),
  constraint game_stack_items_action_type_check
    check (action_type in ('deal_damage_player'))
);

create index if not exists game_stack_items_session_pending_idx
on public.game_stack_items (session_id, status, position desc);

alter table public.game_stack_items enable row level security;

drop policy if exists "Session players can read stack items"
on public.game_stack_items;

create policy "Session players can read stack items"
on public.game_stack_items
for select
to authenticated
using (public.is_session_player(session_id, auth.uid()));

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
    coalesce(nullif(profiles.username, ''), left(stack_items.controller_player_id::text, 8)) as controller_username,
    stack_items.source_card_id,
    source_card.name as source_card_name,
    stack_items.action_type,
    stack_items.payload,
    stack_items.position,
    stack_items.status,
    stack_items.created_at,
    stack_items.resolved_at
  from public.game_stack_items stack_items
  left join public.profiles
    on profiles.id = stack_items.controller_player_id
  left join public.game_cards source_instance
    on source_instance.id = stack_items.source_card_id
  left join public.cards source_card
    on source_card.id = source_instance.card_id
  where stack_items.session_id = p_session_id
    and public.is_session_player(p_session_id, auth.uid())
  order by
    case stack_items.status when 'pending' then 0 else 1 end,
    stack_items.position desc,
    stack_items.created_at desc;
$$;

create or replace function public.put_action_on_stack(
  p_session_id uuid,
  p_action_type text,
  p_payload jsonb,
  p_source_card_id uuid default null
)
returns public.game_stack_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_target_player_id uuid;
  v_amount integer;
  v_next_position integer;
  v_stack_item public.game_stack_items;
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
    raise exception 'Cannot put actions on the stack in a finished game session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can put actions on the stack';
  end if;

  if p_action_type <> 'deal_damage_player' then
    raise exception 'Unsupported stack action type: %', p_action_type;
  end if;

  v_target_player_id := nullif(p_payload ->> 'target_player_id', '')::uuid;
  v_amount := coalesce((p_payload ->> 'amount')::integer, 0);

  if v_target_player_id is null then
    raise exception 'target_player_id is required';
  end if;

  if v_amount <= 0 then
    raise exception 'amount must be positive';
  end if;

  if not public.is_session_player(p_session_id, v_target_player_id) then
    raise exception 'Target player is not a player in this session';
  end if;

  if p_source_card_id is not null then
    perform 1
    from public.game_cards
    where id = p_source_card_id
      and session_id = p_session_id
      and owner_id = auth.uid();

    if not found then
      raise exception 'Source card not found or not owned by current user';
    end if;
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
    auth.uid(),
    p_source_card_id,
    p_action_type,
    jsonb_build_object(
      'target_player_id', v_target_player_id,
      'amount', v_amount
    ),
    v_next_position
  )
  returning * into v_stack_item;

  update public.game_turn_state
  set
    priority_player_id = active_player_id,
    priority_cycle_started_by = null,
    priority_pass_count = 0
  where session_id = p_session_id;

  return v_stack_item;
end;
$$;

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
  v_target_player_id uuid;
  v_amount integer;
  v_finish_state jsonb;
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
  else
    raise exception 'Unsupported stack action type: %', v_stack_item.action_type;
  end if;

  update public.game_stack_items
  set
    status = 'resolved',
    resolved_at = now()
  where id = v_stack_item.id;

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

create or replace function public.pass_priority(
  p_session_id uuid
)
returns public.game_turn_state
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_state public.game_turn_state;
  v_session_status text;
  v_current_priority_player_id uuid;
  v_next_priority_player_id uuid;
  v_player_count integer;
  v_pending_stack_count integer;
  v_next_pass_count integer;
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
    raise exception 'Cannot pass priority in a finished game session';
  end if;

  select *
  into v_current_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  v_current_priority_player_id := coalesce(
    v_current_state.priority_player_id,
    v_current_state.active_player_id
  );

  if v_current_priority_player_id <> auth.uid() then
    raise exception 'Only the priority player can pass priority';
  end if;

  select count(*)
  into v_player_count
  from public.game_session_players
  where session_id = p_session_id;

  if v_player_count <= 1 then
    select count(*)
    into v_pending_stack_count
    from public.game_stack_items
    where session_id = p_session_id
      and status = 'pending';

    if v_pending_stack_count > 0 then
      perform public.resolve_top_of_stack(p_session_id);

      select *
      into v_current_state
      from public.game_turn_state
      where session_id = p_session_id;

      return v_current_state;
    end if;

    return public.advance_step(p_session_id);
  end if;

  v_next_pass_count := coalesce(v_current_state.priority_pass_count, 0) + 1;

  if v_next_pass_count >= v_player_count then
    select count(*)
    into v_pending_stack_count
    from public.game_stack_items
    where session_id = p_session_id
      and status = 'pending';

    if v_pending_stack_count > 0 then
      perform public.resolve_top_of_stack(p_session_id);

      select *
      into v_current_state
      from public.game_turn_state
      where session_id = p_session_id;

      return v_current_state;
    end if;

    return public.advance_step(p_session_id);
  end if;

  select next_player.player_id
  into v_next_priority_player_id
  from public.game_session_players current_player
  join public.game_session_players next_player
    on next_player.session_id = current_player.session_id
   and next_player.seat_number > current_player.seat_number
  where current_player.session_id = p_session_id
    and current_player.player_id = v_current_priority_player_id
  order by next_player.seat_number
  limit 1;

  if v_next_priority_player_id is null then
    select player_id
    into v_next_priority_player_id
    from public.game_session_players
    where session_id = p_session_id
    order by seat_number
    limit 1;
  end if;

  if v_next_priority_player_id is null then
    raise exception 'No players found for game session';
  end if;

  update public.game_turn_state
  set
    priority_player_id = v_next_priority_player_id,
    priority_cycle_started_by = coalesce(
      priority_cycle_started_by,
      v_current_priority_player_id
    ),
    priority_pass_count = v_next_pass_count
  where session_id = p_session_id
  returning * into v_current_state;

  return v_current_state;
end;
$$;

grant select on public.game_stack_items to authenticated;
grant execute on function public.get_stack_items(uuid) to authenticated;
grant execute on function public.put_action_on_stack(uuid, text, jsonb, uuid) to authenticated;
grant execute on function public.resolve_top_of_stack(uuid) to authenticated;
grant execute on function public.pass_priority(uuid) to authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'game_stack_items'
  ) then
    alter publication supabase_realtime add table public.game_stack_items;
  end if;
end;
$$;
