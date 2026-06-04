-- 1. Tabel en RLS aanmaken
create table if not exists public.game_action_log (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions(id) on delete cascade,
  actor_player_id uuid not null,
  target_player_id uuid,
  action_type text not null,
  description text,
  before_state jsonb not null default '{}'::jsonb,
  after_state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  undone_by uuid
);

alter table public.game_action_log enable row level security;

drop policy if exists "Session players can read action log" on public.game_action_log;
create policy "Session players can read action log"
on public.game_action_log
for select
using (public.is_session_player(session_id, auth.uid()));

create index if not exists game_action_log_session_created_idx
on public.game_action_log (session_id, created_at desc);

-- 2. Logging functie
create or replace function public.dev_log_action(
  p_session_id uuid,
  p_target_player_id uuid,
  p_action_type text,
  p_description text,
  p_before_state jsonb,
  p_after_state jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_log_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  insert into public.game_action_log (
    session_id,
    actor_player_id,
    target_player_id,
    action_type,
    description,
    before_state,
    after_state
  )
  values (
    p_session_id,
    auth.uid(),
    p_target_player_id,
    p_action_type,
    p_description,
    coalesce(p_before_state, '{}'::jsonb),
    coalesce(p_after_state, '{}'::jsonb)
  )
  returning id into v_log_id;

  return v_log_id;
end;
$$;

-- 3. Game Acties
create or replace function public.dev_draw_card(
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
  v_before_card jsonb;
  v_after_card jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if not public.is_session_player(p_session_id, p_player_id) then
    raise exception 'Target player is not a player in this session';
  end if;

  select status into v_session_status from public.game_sessions where id = p_session_id;
  if not found then raise exception 'Game session not found'; end if;
  if v_session_status = 'finished' then raise exception 'Cannot draw cards in a finished game session'; end if;

  select coalesce(max(zone_position), -1) + 1
  into v_next_hand_position
  from public.game_cards
  where session_id = p_session_id and owner_id = p_player_id and zone = 'hand';

  select id, to_jsonb(game_cards.*)
  into v_card_id, v_before_card
  from public.game_cards
  where session_id = p_session_id and owner_id = p_player_id and zone = 'library'
  order by zone_position asc, id asc
  limit 1
  for update skip locked;

  if v_card_id is null then raise exception 'Library is empty'; end if;

  update public.game_cards
  set
    zone = 'hand',
    zone_position = v_next_hand_position,
    is_tapped = false,
    damage_marked = 0
  where id = v_card_id
  returning to_jsonb(game_cards.*) into v_after_card;

  perform public.dev_log_action(
    p_session_id,
    p_player_id,
    'draw_card',
    'Draw card',
    jsonb_build_object('card', v_before_card),
    jsonb_build_object('card', v_after_card)
  );

  return v_card_id;
end;
$$;

create or replace function public.dev_undo_last_draw(
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
  v_next_library_position integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not public.is_session_player(p_session_id, auth.uid()) then raise exception 'Current user is not a player in this session'; end if;

  select status into v_session_status from public.game_sessions where id = p_session_id;
  if v_session_status = 'finished' then raise exception 'Cannot undo draws in a finished game session'; end if;

  select coalesce(min(zone_position), 0) - 1
  into v_next_library_position
  from public.game_cards
  where session_id = p_session_id and owner_id = p_player_id and zone = 'library';

  select id into v_card_id
  from public.game_cards
  where session_id = p_session_id and owner_id = p_player_id and zone = 'hand'
  order by zone_position desc, id desc
  limit 1
  for update skip locked;

  if v_card_id is null then raise exception 'Hand is empty'; end if;

  update public.game_cards
  set zone = 'library', zone_position = v_next_library_position, is_tapped = false, damage_marked = 0
  where id = v_card_id;

  return v_card_id;
end;
$$;

create or replace function public.dev_move_card_to_zone(
  p_session_id uuid,
  p_game_card_id uuid,
  p_zone text
)
returns public.game_cards
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card public.game_cards;
  v_before_card jsonb;
  v_after_card jsonb;
  v_next_zone_position integer;
  v_turn_number integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not public.is_session_player(p_session_id, auth.uid()) then raise exception 'Current user is not a player in this session'; end if;
  if p_zone not in ('library', 'hand', 'stack', 'battlefield', 'graveyard', 'exile') then raise exception 'Invalid zone: %', p_zone; end if;

  -- CORRECTIE: Record en JSON apart ophalen
  select * into v_card
  from public.game_cards
  where id = p_game_card_id and session_id = p_session_id
  for update;

  if not found then raise exception 'Card not found in this session'; end if;
  v_before_card := to_jsonb(v_card);

  select coalesce(max(zone_position), -1) + 1
  into v_next_zone_position
  from public.game_cards
  where session_id = p_session_id and owner_id = v_card.owner_id and zone = p_zone;

  select turn_number into v_turn_number from public.game_turn_state where session_id = p_session_id;

  update public.game_cards
  set
    zone = p_zone,
    zone_position = v_next_zone_position,
    is_tapped = false,
    damage_marked = 0,
    entered_battlefield_turn_number = case
      when p_zone = 'battlefield' then coalesce(v_turn_number, entered_battlefield_turn_number)
      else null
    end
  where id = p_game_card_id
  returning * into v_card;

  v_after_card := to_jsonb(v_card);

  perform public.rebuild_scripted_continuous_effects(p_session_id);

  perform public.dev_log_action(
    p_session_id,
    v_card.owner_id,
    'move_card_to_zone',
    'Move card to ' || p_zone,
    jsonb_build_object('card', v_before_card),
    jsonb_build_object('card', v_after_card)
  );

  return v_card;
end;
$$;

create or replace function public.dev_set_card_tapped(
  p_session_id uuid,
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
  v_before_card jsonb;
  v_after_card jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select * into v_card 
  from public.game_cards 
  where id = p_game_card_id and session_id = p_session_id 
  for update;
  
  if not found then raise exception 'Card not found in this session'; end if;
  v_before_card := to_jsonb(v_card);

  update public.game_cards
  set is_tapped = p_is_tapped
  where id = p_game_card_id and session_id = p_session_id
  returning * into v_card;

  v_after_card := to_jsonb(v_card);

  perform public.dev_log_action(
    p_session_id,
    v_card.owner_id,
    'set_card_tapped',
    case when p_is_tapped then 'Tap card' else 'Untap card' end,
    jsonb_build_object('card', v_before_card),
    jsonb_build_object('card', v_after_card)
  );

  return v_card;
end;
$$;

create or replace function public.dev_set_card_damage(
  p_session_id uuid,
  p_game_card_id uuid,
  p_damage_marked integer
)
returns public.game_cards
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card public.game_cards;
  v_before_card jsonb;
  v_after_card jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_damage_marked < 0 then raise exception 'Damage cannot be negative'; end if;

  select * into v_card 
  from public.game_cards 
  where id = p_game_card_id and session_id = p_session_id 
  for update;

  if not found then raise exception 'Card not found in this session'; end if;
  v_before_card := to_jsonb(v_card);

  update public.game_cards
  set damage_marked = p_damage_marked
  where id = p_game_card_id and session_id = p_session_id
  returning * into v_card;

  v_after_card := to_jsonb(v_card);

  perform public.dev_log_action(
    p_session_id,
    v_card.owner_id,
    'set_card_damage',
    'Set card damage',
    jsonb_build_object('card', v_before_card),
    jsonb_build_object('card', v_after_card)
  );

  return v_card;
end;
$$;

create or replace function public.dev_shuffle_library(
  p_session_id uuid,
  p_player_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_before_cards jsonb;
  v_after_cards jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'zone_position', zone_position) order by zone_position, id), '[]'::jsonb)
  into v_before_cards
  from public.game_cards
  where session_id = p_session_id and owner_id = p_player_id and zone = 'library';

  with shuffled as (
    select id, row_number() over (order by random(), id) - 1 as next_position
    from public.game_cards
    where session_id = p_session_id and owner_id = p_player_id and zone = 'library'
  )
  update public.game_cards
  set zone_position = shuffled.next_position
  from shuffled where game_cards.id = shuffled.id;

  get diagnostics v_count = row_count;

  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'zone_position', zone_position) order by zone_position, id), '[]'::jsonb)
  into v_after_cards
  from public.game_cards
  where session_id = p_session_id and owner_id = p_player_id and zone = 'library';

  perform public.dev_log_action(
    p_session_id, p_player_id, 'shuffle_library', 'Shuffle library',
    jsonb_build_object('cards', v_before_cards),
    jsonb_build_object('cards', v_after_cards)
  );

  return v_count;
end;
$$;

create or replace function public.dev_put_card_on_top(
  p_session_id uuid,
  p_game_card_id uuid
)
returns public.game_cards
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card public.game_cards;
  v_before_card jsonb;
  v_after_card jsonb;
  v_next_position integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  -- CORRECTIE: Record en JSON apart
  select * into v_card from public.game_cards 
  where id = p_game_card_id and session_id = p_session_id for update;
  if not found then raise exception 'Card not found in this session'; end if;
  v_before_card := to_jsonb(v_card);

  select coalesce(min(zone_position), 0) - 1
  into v_next_position
  from public.game_cards
  where session_id = p_session_id and owner_id = v_card.owner_id and zone = 'library';

  update public.game_cards
  set
    zone = 'library',
    zone_position = v_next_position,
    is_tapped = false,
    damage_marked = 0,
    entered_battlefield_turn_number = null
  where id = p_game_card_id
  returning * into v_card;

  v_after_card := to_jsonb(v_card);
  perform public.rebuild_scripted_continuous_effects(p_session_id);
  perform public.dev_log_action(p_session_id, v_card.owner_id, 'put_card_on_top', 'Put card on top', jsonb_build_object('card', v_before_card), jsonb_build_object('card', v_after_card));

  return v_card;
end;
$$;

create or replace function public.dev_put_card_on_bottom(
  p_session_id uuid,
  p_game_card_id uuid
)
returns public.game_cards
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card public.game_cards;
  v_before_card jsonb;
  v_after_card jsonb;
  v_next_position integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  -- CORRECTIE: Record en JSON apart
  select * into v_card from public.game_cards 
  where id = p_game_card_id and session_id = p_session_id for update;
  if not found then raise exception 'Card not found in this session'; end if;
  v_before_card := to_jsonb(v_card);

  select coalesce(max(zone_position), -1) + 1
  into v_next_position
  from public.game_cards
  where session_id = p_session_id and owner_id = v_card.owner_id and zone = 'library';

  update public.game_cards
  set
    zone = 'library',
    zone_position = v_next_position,
    is_tapped = false,
    damage_marked = 0,
    entered_battlefield_turn_number = null
  where id = p_game_card_id
  returning * into v_card;

  v_after_card := to_jsonb(v_card);
  perform public.rebuild_scripted_continuous_effects(p_session_id);
  perform public.dev_log_action(p_session_id, v_card.owner_id, 'put_card_on_bottom', 'Put card on bottom', jsonb_build_object('card', v_before_card), jsonb_build_object('card', v_after_card));

  return v_card;
end;
$$;

-- 4. Undo Functie
create or replace function public.dev_undo_action(
  p_action_id uuid
)
returns public.game_action_log
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action public.game_action_log;
  v_card jsonb;
  v_card_id uuid;
  v_library_card jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select * into v_action from public.game_action_log where id = p_action_id for update;
  if not found then raise exception 'Action not found'; end if;
  if v_action.undone_at is not null then raise exception 'Action is already undone'; end if;

  if v_action.action_type in ('draw_card', 'move_card_to_zone', 'set_card_tapped', 'set_card_damage', 'put_card_on_top', 'put_card_on_bottom') then
    v_card := v_action.before_state -> 'card';
    v_card_id := (v_card ->> 'id')::uuid;

    update public.game_cards
    set
      zone = v_card ->> 'zone',
      zone_position = (v_card ->> 'zone_position')::integer,
      is_tapped = coalesce((v_card ->> 'is_tapped')::boolean, false),
      damage_marked = coalesce((v_card ->> 'damage_marked')::integer, 0),
      controller_player_id = nullif(v_card ->> 'controller_player_id', '')::uuid,
      entered_battlefield_turn_number = nullif(v_card ->> 'entered_battlefield_turn_number', '')::integer
    where id = v_card_id and session_id = v_action.session_id;

    perform public.rebuild_scripted_continuous_effects(v_action.session_id);
  elsif v_action.action_type = 'shuffle_library' then
    for v_library_card in select value from jsonb_array_elements(v_action.before_state -> 'cards') loop
      update public.game_cards set zone_position = (v_library_card ->> 'zone_position')::integer
      where id = (v_library_card ->> 'id')::uuid and session_id = v_action.session_id and zone = 'library';
    end loop;
  elsif v_action.action_type = 'untap_all' then
    for v_library_card in select value from jsonb_array_elements(v_action.before_state -> 'cards') loop
      update public.game_cards
      set is_tapped = coalesce((v_library_card ->> 'is_tapped')::boolean, false)
      where id = (v_library_card ->> 'id')::uuid and session_id = v_action.session_id;
    end loop;
  elsif v_action.action_type = 'clear_mana_pool' then
    update public.game_players
    set mana_pool = v_action.before_state -> 'mana_pool'
    where session_id = v_action.session_id and player_id = v_action.target_player_id;
  else
    raise exception 'Undo not supported for: %', v_action.action_type;
  end if;

  update public.game_action_log set undone_at = now(), undone_by = auth.uid()
  where id = p_action_id returning * into v_action;

  return v_action;
end;
$$;

-- 5. Granteert permissies
grant execute on function public.dev_draw_card(uuid, uuid) to authenticated;
grant execute on function public.dev_undo_last_draw(uuid, uuid) to authenticated;
grant execute on function public.dev_move_card_to_zone(uuid, uuid, text) to authenticated;
grant execute on function public.dev_set_card_tapped(uuid, uuid, boolean) to authenticated;
grant execute on function public.dev_set_card_damage(uuid, uuid, integer) to authenticated;
grant execute on function public.dev_shuffle_library(uuid, uuid) to authenticated;
grant execute on function public.dev_put_card_on_top(uuid, uuid) to authenticated;
grant execute on function public.dev_put_card_on_bottom(uuid, uuid) to authenticated;

create or replace function public.dev_untap_all(
  p_session_id uuid,
  p_player_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_before_cards jsonb;
  v_after_cards jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if not public.is_session_player(p_session_id, p_player_id) then
    raise exception 'Target player is not a player in this session';
  end if;

  select coalesce(jsonb_agg(to_jsonb(game_cards.*) order by zone_position, id), '[]'::jsonb)
  into v_before_cards
  from public.game_cards
  where session_id = p_session_id
    and owner_id = p_player_id
    and zone = 'battlefield'
    and is_tapped = true;

  update public.game_cards
  set is_tapped = false
  where session_id = p_session_id
    and owner_id = p_player_id
    and zone = 'battlefield'
    and is_tapped = true;

  get diagnostics v_count = row_count;

  select coalesce(jsonb_agg(to_jsonb(game_cards.*) order by zone_position, id), '[]'::jsonb)
  into v_after_cards
  from public.game_cards
  where session_id = p_session_id
    and owner_id = p_player_id
    and id in (
      select (value ->> 'id')::uuid
      from jsonb_array_elements(v_before_cards)
    );

  perform public.dev_log_action(
    p_session_id,
    p_player_id,
    'untap_all',
    'Untap all',
    jsonb_build_object('cards', v_before_cards),
    jsonb_build_object('cards', v_after_cards)
  );

  return v_count;
end;
$$;

create or replace function public.dev_clear_mana_pool(
  p_session_id uuid,
  p_player_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empty_pool jsonb := jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0);
  v_before_pool jsonb;
  v_after_pool jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if not public.is_session_player(p_session_id, p_player_id) then
    raise exception 'Target player is not a player in this session';
  end if;

  insert into public.game_players (session_id, player_id, mana_pool)
  values (p_session_id, p_player_id, v_empty_pool)
  on conflict (session_id, player_id) do nothing;

  select coalesce(mana_pool, v_empty_pool)
  into v_before_pool
  from public.game_players
  where session_id = p_session_id
    and player_id = p_player_id
  for update;

  update public.game_players
  set mana_pool = v_empty_pool
  where session_id = p_session_id
    and player_id = p_player_id
  returning mana_pool into v_after_pool;

  perform public.dev_log_action(
    p_session_id,
    p_player_id,
    'clear_mana_pool',
    'Clear mana pool',
    jsonb_build_object('mana_pool', v_before_pool),
    jsonb_build_object('mana_pool', v_after_pool)
  );

  return v_after_pool;
end;
$$;

grant execute on function public.dev_untap_all(uuid, uuid) to authenticated;
grant execute on function public.dev_clear_mana_pool(uuid, uuid) to authenticated;
grant execute on function public.dev_log_action(uuid, uuid, text, text, jsonb, jsonb) to authenticated;
grant execute on function public.dev_undo_action(uuid) to authenticated;
