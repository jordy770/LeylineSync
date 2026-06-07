-- Commander-identity mana ("Add one mana of any color in your commander's color
-- identity" — Command Tower, Arcane Signet, Chromatic Lantern).
--
-- Such a source produces a CHOSEN colour, restricted to the player's commander's
-- colour identity. The client computes the identity and offers a colour picker; this
-- adds a server-side guard so a `commander`-identity source can only produce a colour
-- the commander actually has. add_mana_from_card gains `p_commander_identity`
-- (default false → unchanged for fixed-colour sources): when true, the produced
-- colour must be in card_color_identity(the player's commander). Colourless is
-- allowed only when the commander has NO coloured identity (so the source isn't dead
-- in a colourless / non-Commander game).
--
-- Reproduced verbatim from the baseline + the new param/guard; the 6-arg signature is
-- dropped so the existing 6-named-arg client call resolves to the new default.
-- (IDE T-SQL false-positives on $$ bodies — ignore.)

drop function if exists public.add_mana_from_card(uuid, uuid, uuid, text, integer, boolean);

create or replace function public.add_mana_from_card(
  p_game_card_id uuid,
  p_session_id uuid,
  p_player_id uuid,
  p_color text,
  p_amount integer,
  p_should_tap_card boolean default true,
  p_commander_identity boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_current_pool jsonb;
  v_new_pool jsonb;
  v_current_amount integer;
  v_commander_card_id uuid;
  v_identity text[];
  v_color_name text;
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

  -- Commander-identity guard: the produced colour must be in the player's
  -- commander's colour identity. Colourless only when the commander has no colour.
  if p_commander_identity then
    select card_id into v_commander_card_id
    from public.game_cards
    where session_id = p_session_id and owner_id = p_player_id and is_commander = true
    limit 1;

    v_identity := coalesce(public.card_color_identity(v_commander_card_id), array[]::text[]);
    v_color_name := case p_color
      when 'W' then 'white' when 'U' then 'blue' when 'B' then 'black'
      when 'R' then 'red' when 'G' then 'green' else null end;

    if v_color_name is not null then
      if not (v_color_name = any (v_identity)) then
        raise exception 'Mana colour % is not in your commander''s colour identity', p_color;
      end if;
    elsif p_color = 'C' and array_length(v_identity, 1) is not null then
      raise exception 'This source produces a colour in your commander''s identity, not colourless';
    end if;
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

grant all on function public.add_mana_from_card(uuid, uuid, uuid, text, integer, boolean, boolean) to anon, authenticated, service_role;
