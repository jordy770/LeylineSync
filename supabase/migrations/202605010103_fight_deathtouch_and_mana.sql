-- fight follow-ups: (1) deathtouch interaction, (2) generic-mana cost parity.
--
-- (1) DEATHTOUCH. CR 702.2: any nonzero damage from a deathtouch source is
-- lethal. move_lethal_damaged_creatures_to_graveyard already destroys a creature
-- with dealt_deathtouch_damage=true and any marked damage; combat sets that flag
-- via card_has_deathtouch. Until now apply_creature_effect's deal_damage only
-- marked damage_marked, so fight (and any future damage source) ignored the
-- dealer's deathtouch. We extend deal_damage to honour an optional 'deathtouch'
-- param, and apply_fight captures BOTH dealers' deathtouch UP FRONT (alongside
-- the powers — fight is simultaneous) and passes it per hit.
--
-- (2) GENERIC-MANA PARITY. put_action_on_stack accepts a generic_payment jsonb
-- (the player's choice of which mana pays the {N} generic part) and forwards it
-- to pay_mana_cost; cast_fight passed null, so a fight spell with generic mana in
-- its cost couldn't be paid with a chosen split. cast_fight now takes
-- p_generic_payment and forwards it, matching every other creature-spell cast.
-- (No fight-specific UI here — surfacing a generic-mana picker is an app-wide
-- feature shared by all these casts; the client wrapper just forwards null today,
-- exactly like the others.)
--
-- (IDE T-SQL false-positives on $$ bodies — ignore.)

-- 1) apply_creature_effect: deal_damage honours an optional 'deathtouch' param.
-- Reproduced from mig 099; the ONLY change is the deal_damage UPDATE also OR-ing
-- dealt_deathtouch_damage when the dealer had deathtouch (mirrors combat).
create or replace function public.apply_creature_effect(
  p_session_id uuid,
  p_kind text,
  p_target_card_id uuid,
  p_params jsonb default '{}'::jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount integer := coalesce((p_params ->> 'amount')::integer, 0);
  v_target_owner_id uuid;
  v_next_position integer;
  v_keyword text;
begin
  if p_target_card_id is null then
    return;
  end if;

  if p_kind = 'deal_damage' then
    if v_amount > 0 then
      update public.game_cards
      set damage_marked = damage_marked + v_amount,
          dealt_deathtouch_damage = dealt_deathtouch_damage
            or coalesce((p_params ->> 'deathtouch')::boolean, false)
      where id = p_target_card_id
        and session_id = p_session_id
        and zone = 'battlefield';

      perform public.move_lethal_damaged_creatures_to_graveyard(p_session_id);
    end if;

  elsif p_kind = 'destroy' then
    perform public.put_in_graveyard(p_session_id, p_target_card_id);

  elsif p_kind = 'exile' then
    select owner_id
    into v_target_owner_id
    from public.game_cards
    where id = p_target_card_id
      and session_id = p_session_id
      and zone = 'battlefield';

    if found then
      select coalesce(max(zone_position), -1) + 1
      into v_next_position
      from public.game_cards
      where session_id = p_session_id
        and owner_id = v_target_owner_id
        and zone = 'exile';

      update public.game_cards
      set
        zone = 'exile',
        zone_position = v_next_position,
        controller_player_id = owner_id,
        is_tapped = false,
        damage_marked = 0,
        dealt_deathtouch_damage = false,
        plus_one_counters = 0
      where id = p_target_card_id;
    end if;

  elsif p_kind = 'bounce' then
    select owner_id
    into v_target_owner_id
    from public.game_cards
    where id = p_target_card_id
      and session_id = p_session_id
      and zone = 'battlefield';

    if found then
      select coalesce(max(zone_position), -1) + 1
      into v_next_position
      from public.game_cards
      where session_id = p_session_id
        and owner_id = v_target_owner_id
        and zone = 'hand';

      update public.game_cards
      set
        zone = 'hand',
        zone_position = v_next_position,
        controller_player_id = owner_id,
        is_tapped = false,
        damage_marked = 0,
        dealt_deathtouch_damage = false,
        plus_one_counters = 0
      where id = p_target_card_id;
    end if;

  elsif p_kind in ('tap', 'untap') then
    update public.game_cards
    set is_tapped = (p_kind = 'tap')
    where id = p_target_card_id
      and session_id = p_session_id
      and zone = 'battlefield';

  elsif p_kind = 'add_counters' then
    if v_amount > 0 then
      update public.game_cards
      set plus_one_counters = greatest(0, plus_one_counters + v_amount)
      where id = p_target_card_id
        and session_id = p_session_id
        and zone = 'battlefield';
    end if;

  elsif p_kind = 'pump' then
    if exists (
      select 1 from public.game_cards
      where id = p_target_card_id
        and session_id = p_session_id
        and zone = 'battlefield'
    ) then
      perform public.create_pt_pump(
        p_session_id,
        p_target_card_id,
        coalesce((p_params ->> 'power')::integer, 0),
        coalesce((p_params ->> 'toughness')::integer, 0)
      );
    end if;

  elsif p_kind = 'grant_keyword' then
    v_keyword := lower(coalesce(p_params ->> 'keyword', ''));

    if v_keyword not in (
      'flying', 'reach', 'trample', 'vigilance', 'haste',
      'first_strike', 'double_strike', 'deathtouch', 'indestructible'
    ) then
      raise exception 'Unsupported keyword grant: %', v_keyword;
    end if;

    if exists (
      select 1 from public.game_cards
      where id = p_target_card_id
        and session_id = p_session_id
        and zone = 'battlefield'
    ) then
      insert into public.game_continuous_effects (
        session_id,
        source_card_id,
        affected_card_id,
        effect_type,
        payload,
        source_zone_required,
        expires_at_phase,
        expires_at_step
      )
      values (
        p_session_id,
        p_target_card_id,
        p_target_card_id,
        v_keyword,
        jsonb_build_object('until_end_of_turn', true),
        'battlefield',
        'ending',
        'cleanup'
      );
    end if;

  else
    raise exception 'Unsupported creature effect kind: %', p_kind;
  end if;
end;
$$;

grant execute on function public.apply_creature_effect(uuid, text, uuid, jsonb) to authenticated;

-- 2) apply_fight: capture both deathtouch flags up front (like the powers, since
-- fight is simultaneous) and pass them so each hit is lethal if its dealer had
-- deathtouch. Reproduced from mig 102 (self-fight guard kept).
create or replace function public.apply_fight(
  p_session_id uuid,
  p_fighter_card_id uuid,
  p_fought_card_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_power_fighter integer;
  v_power_fought integer;
  v_dt_fighter boolean;
  v_dt_fought boolean;
begin
  if p_fighter_card_id is null or p_fought_card_id is null then
    return;
  end if;

  -- A creature can't fight itself (CR: fight needs two creatures). Fizzle.
  if p_fighter_card_id = p_fought_card_id then
    return;
  end if;

  -- Both must still be creatures on the battlefield; otherwise neither fights.
  if not exists (
    select 1 from public.game_cards
    where id = p_fighter_card_id and session_id = p_session_id and zone = 'battlefield'
  ) or not exists (
    select 1 from public.game_cards
    where id = p_fought_card_id and session_id = p_session_id and zone = 'battlefield'
  ) then
    return;
  end if;

  -- Capture both powers AND both deathtouch states before any damage, so a
  -- creature that dies still deals its (deathtouch) hit.
  v_power_fighter := greatest(coalesce(public.card_effective_power(p_session_id, p_fighter_card_id), 0), 0);
  v_power_fought  := greatest(coalesce(public.card_effective_power(p_session_id, p_fought_card_id), 0), 0);
  v_dt_fighter := public.card_has_deathtouch(p_session_id, p_fighter_card_id);
  v_dt_fought  := public.card_has_deathtouch(p_session_id, p_fought_card_id);

  -- Each deals its power to the other (apply_creature_effect re-runs lethal SBAs;
  -- a deathtouch dealer makes any nonzero hit lethal; amount 0 is a no-op).
  perform public.apply_creature_effect(
    p_session_id, 'deal_damage', p_fought_card_id,
    jsonb_build_object('amount', v_power_fighter, 'deathtouch', v_dt_fighter)
  );
  perform public.apply_creature_effect(
    p_session_id, 'deal_damage', p_fighter_card_id,
    jsonb_build_object('amount', v_power_fought, 'deathtouch', v_dt_fought)
  );
end;
$$;

grant execute on function public.apply_fight(uuid, uuid, uuid) to authenticated;

-- 3) cast_fight: accept and forward a generic-mana payment, matching
-- put_action_on_stack. The arg list changes (5 -> 6), so drop the old signature
-- first (create-or-replace can't add a parameter). Reproduced from mig 101.
drop function if exists public.cast_fight(uuid, uuid, uuid, uuid, text);

create or replace function public.cast_fight(
  p_session_id uuid,
  p_fighter_card_id uuid,
  p_fought_card_id uuid,
  p_source_card_id uuid default null,
  p_fought_controller text default 'any',
  p_generic_payment jsonb default null
)
returns public.game_stack_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn public.game_turn_state;
  v_session_status text;
  v_source_type_line text;
  v_source_zone text;
  v_source_mana_cost text;
  v_timing text;
  v_pending integer;
  v_next_position integer;
  v_next_graveyard integer;
  v_stack public.game_stack_items;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if p_fighter_card_id is null or p_fought_card_id is null then
    raise exception 'Fight requires two creature targets';
  end if;

  if p_fighter_card_id = p_fought_card_id then
    raise exception 'A creature cannot fight itself';
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

  if p_source_card_id is not null then
    select cards.type_line, cards.mana_cost, game_cards.zone
      into v_source_type_line, v_source_mana_cost, v_source_zone
    from public.game_cards
    join public.cards on cards.id = game_cards.card_id
    where game_cards.id = p_source_card_id
      and game_cards.session_id = p_session_id
      and game_cards.owner_id = auth.uid();
    if not found then
      raise exception 'Source card not found or not owned by current user';
    end if;
  end if;

  -- Timing: sorceries main-phase only; a sourceless cast (tests) defaults to instant.
  if v_source_type_line ilike '%sorcery%' then
    v_timing := 'sorcery';
  else
    v_timing := 'instant';
  end if;

  if v_timing = 'sorcery' then
    if v_turn.active_player_id <> auth.uid() then
      raise exception 'Sorcery actions can only be used by the active player';
    end if;
    if v_turn.step not in ('precombat_main', 'postcombat_main') then
      raise exception 'Sorcery actions can only be used during a main phase';
    end if;
    select count(*) into v_pending
    from public.game_stack_items
    where session_id = p_session_id and status = 'pending';
    if v_pending > 0 then
      raise exception 'Sorcery actions can only be used while the stack is empty';
    end if;
  end if;

  -- The fighter is a creature you control; the fought creature is any creature on
  -- the battlefield. (Targeting is rechecked at resolution via apply_fight.)
  if not public.creature_target_controller_ok(p_session_id, p_fighter_card_id, auth.uid(), 'you') then
    raise exception 'The fighting creature must be a creature you control';
  end if;
  if not public.creature_target_controller_ok(
       p_session_id, p_fought_card_id, auth.uid(),
       coalesce(lower(nullif(p_fought_controller, '')), 'any')
     ) then
    raise exception 'The fought target is not a legal creature for this spell';
  end if;

  if p_source_card_id is not null and v_source_zone = 'hand' then
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_source_mana_cost, p_generic_payment);
  end if;

  select coalesce(max(position), 0) + 1 into v_next_position
  from public.game_stack_items where session_id = p_session_id;

  insert into public.game_stack_items (
    session_id, controller_player_id, source_card_id, action_type, payload, position, status
  )
  values (
    p_session_id,
    auth.uid(),
    p_source_card_id,
    'fight_creatures',
    jsonb_build_object(
      'target_card_id', p_fighter_card_id,
      'target_card_id_2', p_fought_card_id,
      'timing', v_timing
    ),
    v_next_position,
    'pending'
  )
  returning * into v_stack;

  -- Non-permanent spell: move the card from hand to the graveyard on cast.
  if p_source_card_id is not null
    and v_source_zone = 'hand'
    and (v_source_type_line ilike '%instant%' or v_source_type_line ilike '%sorcery%')
  then
    select coalesce(max(zone_position), -1) + 1 into v_next_graveyard
    from public.game_cards
    where session_id = p_session_id and owner_id = auth.uid() and zone = 'graveyard';

    update public.game_cards
    set zone = 'graveyard', zone_position = v_next_graveyard, is_tapped = false, damage_marked = 0
    where id = p_source_card_id;
  end if;

  return v_stack;
end;
$$;

grant execute on function public.cast_fight(uuid, uuid, uuid, uuid, text, jsonb) to authenticated;
