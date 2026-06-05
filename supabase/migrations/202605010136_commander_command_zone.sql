-- Commander (EDH), slice 1 — the IN-GAME command zone mechanics.
--
-- Adds the command zone and the core commander rules that don't depend on deck
-- legality (deferred): a commander lives in the command zone, is cast from there at
-- sorcery speed paying COMMANDER TAX (+{2} generic per prior cast from the command
-- zone, CR 903.8), and is RETURNED to the command zone instead of going to the
-- graveyard (CR 903.9, the death case; the modern owner-choice + the library/hand/
-- exile cases are later refinements — this slice auto-returns on death). Commander
-- games start at 40 life (set_commander_format). Commander DAMAGE and deck legality
-- are separate later slices.
--
-- Reproduced fn: put_in_graveyard (baseline lift + commander redirect). New: the
-- 'command' zone value, is_commander/command_zone_casts on game_cards, format on
-- game_sessions, cast_commander + set_commander_format RPCs.
-- (IDE T-SQL false-positives on $$ bodies — ignore.)

-- ---------------------------------------------------------------------------
-- 1. The command zone + commander markers.
-- ---------------------------------------------------------------------------
alter table public.game_cards
  drop constraint if exists game_cards_zone_check;
alter table public.game_cards
  add constraint game_cards_zone_check
  check (zone = any (array[
    'library', 'hand', 'stack', 'battlefield', 'graveyard', 'exile', 'command'
  ]));

alter table public.game_cards
  add column if not exists is_commander boolean not null default false;
alter table public.game_cards
  add column if not exists command_zone_casts integer not null default 0;

comment on column public.game_cards.is_commander is
  'True for a player''s commander. Drives command-zone casting (tax) and the return-to-command-zone replacement on death.';
comment on column public.game_cards.command_zone_casts is
  'How many times this commander has been cast FROM the command zone. Commander tax = 2 * this (CR 903.8).';

-- ---------------------------------------------------------------------------
-- 2. Game format (standard | commander). Commander games are 40 life.
-- ---------------------------------------------------------------------------
alter table public.game_sessions
  add column if not exists format text not null default 'standard';
alter table public.game_sessions
  drop constraint if exists game_sessions_format_check;
alter table public.game_sessions
  add constraint game_sessions_format_check
  check (format = any (array['standard', 'commander']));

create or replace function public.set_commander_format(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  update public.game_sessions
  set format = 'commander'
  where id = p_session_id;

  -- Commander starting life is 40 (CR 903.7).
  update public.game_session_players
  set life_total = 40
  where session_id = p_session_id;
end;
$$;

grant execute on function public.set_commander_format(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. cast_commander — cast the caster's commander from the command zone, paying the
-- printed mana cost plus commander tax. Sorcery speed (your main phase, empty
-- stack), like a permanent cast from hand; resolves to the battlefield through the
-- existing cast_permanent handler. The tax is paid as a separate generic cost so
-- the whole RPC is atomic (insufficient mana for either part rolls back the cast).
-- ---------------------------------------------------------------------------
create or replace function public.cast_commander(
  p_session_id uuid,
  p_game_card_id uuid,
  p_generic_payment jsonb default null
) returns public.game_cards
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn public.game_turn_state;
  v_card public.game_cards;
  v_type_line text;
  v_mana_cost text;
  v_tax integer;
  v_pending integer := 0;
  v_next_stack_position integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select status into v_session_status
  from public.game_sessions where id = p_session_id for update;
  if not found then
    raise exception 'Game session not found';
  end if;
  if v_session_status = 'finished' then
    raise exception 'Cannot cast in a finished game session';
  end if;

  select * into v_turn
  from public.game_turn_state where session_id = p_session_id for update;
  if not found then
    raise exception 'Turn state not found';
  end if;

  if coalesce(v_turn.priority_player_id, v_turn.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can cast';
  end if;
  if v_turn.active_player_id <> auth.uid() then
    raise exception 'A commander can only be cast by the active player';
  end if;
  if v_turn.step not in ('precombat_main', 'postcombat_main') then
    raise exception 'A commander can only be cast during a main phase';
  end if;

  select count(*) into v_pending
  from public.game_stack_items
  where session_id = p_session_id and status = 'pending';
  if v_pending > 0 then
    raise exception 'A commander can only be cast while the stack is empty';
  end if;

  -- The caster's commander, in their command zone.
  select game_cards.* into v_card
  from public.game_cards
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id
    and game_cards.owner_id = auth.uid()
    and game_cards.is_commander = true
    and game_cards.zone = 'command'
  for update of game_cards;
  if not found then
    raise exception 'Commander not found in your command zone';
  end if;

  select cards.type_line, cards.mana_cost
  into v_type_line, v_mana_cost
  from public.cards where cards.id = v_card.card_id;

  v_tax := 2 * v_card.command_zone_casts;

  -- Pay the printed cost, then the tax (extra generic). Two calls keep the math
  -- simple; both run in this RPC's transaction, so either failing rolls back.
  perform public.pay_mana_cost(p_session_id, auth.uid(), v_mana_cost, p_generic_payment);
  if v_tax > 0 then
    perform public.pay_mana_cost(p_session_id, auth.uid(), '{' || v_tax || '}', null);
  end if;

  -- A cast from the command zone bumps the tax for next time (CR 903.8).
  update public.game_cards
  set command_zone_casts = command_zone_casts + 1,
      zone = 'stack',
      zone_position = 0,
      is_tapped = false,
      damage_marked = 0
  where id = p_game_card_id;

  select coalesce(max(position), -1) + 1
  into v_next_stack_position
  from public.game_stack_items
  where session_id = p_session_id;

  insert into public.game_stack_items (
    session_id, controller_player_id, source_card_id, action_type, payload, position
  )
  values (
    p_session_id, auth.uid(), p_game_card_id, 'cast_permanent',
    jsonb_build_object('timing', 'sorcery', 'card_id', v_card.card_id, 'type_line', v_type_line),
    v_next_stack_position
  );

  update public.game_turn_state
  set priority_player_id = active_player_id,
      priority_cycle_started_by = null,
      priority_pass_count = 0
  where session_id = p_session_id;

  select * into v_card from public.game_cards where id = p_game_card_id;
  return v_card;
end;
$$;

grant execute on function public.cast_commander(uuid, uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. put_in_graveyard (baseline lift) — a commander is returned to its owner's
-- command zone instead of the graveyard (CR 903.9, death case; auto for now —
-- owner-choice + the non-death zones are later refinements). Everything else is
-- the verbatim baseline cleanup.
-- ---------------------------------------------------------------------------
create or replace function public.put_in_graveyard(p_session_id uuid, p_game_card_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_is_commander boolean;
  v_next_position integer;
begin
  select owner_id, is_commander
  into v_owner_id, v_is_commander
  from public.game_cards
  where id = p_game_card_id
    and session_id = p_session_id
    and zone = 'battlefield';

  if not found then
    return false;
  end if;

  if v_is_commander then
    -- Return to the command zone (its own ordered zone per owner).
    select coalesce(max(zone_position), -1) + 1
    into v_next_position
    from public.game_cards
    where session_id = p_session_id
      and owner_id = v_owner_id
      and zone = 'command';

    update public.game_cards
    set
      zone = 'command',
      zone_position = v_next_position,
      controller_player_id = owner_id,
      is_tapped = false,
      damage_marked = 0,
      dealt_deathtouch_damage = false,
      plus_one_counters = 0
    where id = p_game_card_id;

    return true;
  end if;

  select coalesce(max(zone_position), -1) + 1
  into v_next_position
  from public.game_cards
  where session_id = p_session_id
    and owner_id = v_owner_id
    and zone = 'graveyard';

  update public.game_cards
  set
    zone = 'graveyard',
    zone_position = v_next_position,
    controller_player_id = owner_id,
    is_tapped = false,
    damage_marked = 0,
    dealt_deathtouch_damage = false,
    plus_one_counters = 0
  where id = p_game_card_id;

  return true;
end;
$$;
