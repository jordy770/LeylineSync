-- Token creation.
--
-- Tokens are catalog `cards` rows flagged is_token. A token game_cards instance
-- behaves like any other permanent in combat/display, with one extra rule: a
-- token that leaves the battlefield ceases to exist (state-based action). A
-- trigger enforces that by deleting the instance (and its continuous effects)
-- whenever its zone changes away from the battlefield.

alter table public.cards
  add column if not exists is_token boolean not null default false;

comment on column public.cards.is_token is
  'True for token catalog rows. Instances of these cease to exist when they leave the battlefield.';

-- Seed a common set of token catalog rows. mana_cost stays null (tokens are not
-- cast). Keyworded tokens carry a script so register_card_continuous_effects
-- wires the keyword when the token enters the battlefield.
insert into public.cards (id, name, type_line, mana_cost, power_toughness, is_token, script)
select gen_random_uuid(), v.name, v.type_line, null, v.power_toughness, true, v.script::jsonb
from (values
  ('Soldier Token',   'Token Creature - Soldier',   '1/1', '{}'),
  ('Saproling Token', 'Token Creature - Saproling', '1/1', '{}'),
  ('Zombie Token',    'Token Creature - Zombie',    '2/2', '{}'),
  ('Goblin Token',    'Token Creature - Goblin',    '1/1', '{}'),
  ('Beast Token',     'Token Creature - Beast',     '3/3', '{}'),
  ('Spirit Token',    'Token Creature - Spirit',    '1/1',
    '{"continuous_effects":[{"type":"flying","affected":"source","source_zone_required":"battlefield"}]}')
) as v(name, type_line, power_toughness, script)
where not exists (
  select 1 from public.cards where lower(name) = lower(v.name)
);

-- Create one or more tokens on a player's battlefield.
create or replace function public.create_token(
  p_session_id uuid,
  p_player_id uuid,
  p_token_card_id uuid,
  p_count integer default 1
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_token boolean;
  v_turn_number integer;
  v_next_pos integer;
  v_new_id uuid;
  v_created integer := 0;
  i integer;
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

  if p_count < 1 or p_count > 20 then
    raise exception 'Token count must be between 1 and 20';
  end if;

  select is_token
  into v_is_token
  from public.cards
  where id = p_token_card_id;

  if not found then
    raise exception 'Token card not found';
  end if;

  if not coalesce(v_is_token, false) then
    raise exception 'Card is not a token';
  end if;

  select turn_number
  into v_turn_number
  from public.game_turn_state
  where session_id = p_session_id;

  for i in 1..p_count loop
    select coalesce(max(zone_position), -1) + 1
    into v_next_pos
    from public.game_cards
    where session_id = p_session_id
      and owner_id = p_player_id
      and zone = 'battlefield';

    insert into public.game_cards (
      session_id,
      card_id,
      owner_id,
      controller_player_id,
      zone,
      zone_position,
      is_tapped,
      damage_marked,
      position_x,
      position_y,
      entered_battlefield_turn_number
    )
    values (
      p_session_id,
      p_token_card_id,
      p_player_id,
      p_player_id,
      'battlefield',
      v_next_pos,
      false,
      0,
      0,
      0,
      coalesce(v_turn_number, 0)
    )
    returning id into v_new_id;

    perform public.register_card_continuous_effects(p_session_id, v_new_id);

    v_created := v_created + 1;
  end loop;

  return v_created;
end;
$$;

-- A token that leaves the battlefield ceases to exist. Delete the instance and
-- its registered continuous effects when its zone changes away from battlefield.
create or replace function public.cease_token_if_off_battlefield()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.zone is distinct from 'battlefield'
    and exists (select 1 from public.cards where id = NEW.card_id and is_token = true)
  then
    delete from public.game_continuous_effects
    where session_id = NEW.session_id
      and source_card_id = NEW.id;

    delete from public.game_cards
    where id = NEW.id;
  end if;

  return null;
end;
$$;

drop trigger if exists trg_cease_token_off_battlefield on public.game_cards;
create trigger trg_cease_token_off_battlefield
after update of zone on public.game_cards
for each row
execute function public.cease_token_if_off_battlefield();

grant execute on function public.create_token(uuid, uuid, uuid, integer) to authenticated;
