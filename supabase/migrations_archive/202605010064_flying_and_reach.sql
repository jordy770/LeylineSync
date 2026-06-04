-- Extend effect_type constraint to include flying and reach.
alter table public.game_continuous_effects
drop constraint if exists game_continuous_effects_effect_type_check;

alter table public.game_continuous_effects
add constraint game_continuous_effects_effect_type_check
check (
  effect_type in (
    'mana_does_not_empty',
    'additional_land_plays',
    'haste',
    'vigilance',
    'indestructible',
    'trample',
    'first_strike',
    'double_strike',
    'flying',
    'reach'
  )
);

-- Helper: does a game card have an active flying effect?
create or replace function public.card_has_flying(
  p_session_id uuid,
  p_game_card_id uuid
)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.game_continuous_effects effects
    left join public.game_cards source_card
      on source_card.id = effects.source_card_id
    where effects.session_id = p_session_id
      and effects.effect_type = 'flying'
      and public.is_session_player(p_session_id, auth.uid())
      and (
        effects.affected_card_id = p_game_card_id
        or effects.affected_card_id is null
      )
      and (
        effects.source_zone_required is null
        or source_card.zone = effects.source_zone_required
      )
  );
$$;

-- Helper: does a game card have an active reach effect?
create or replace function public.card_has_reach(
  p_session_id uuid,
  p_game_card_id uuid
)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.game_continuous_effects effects
    left join public.game_cards source_card
      on source_card.id = effects.source_card_id
    where effects.session_id = p_session_id
      and effects.effect_type = 'reach'
      and public.is_session_player(p_session_id, auth.uid())
      and (
        effects.affected_card_id = p_game_card_id
        or effects.affected_card_id is null
      )
      and (
        effects.source_zone_required is null
        or source_card.zone = effects.source_zone_required
      )
  );
$$;

-- declare_blocker: adds flying/reach legality check.
-- A non-flying, non-reach creature cannot block a flying attacker.
create or replace function public.declare_blocker(
  p_session_id uuid,
  p_blocker_card_id uuid,
  p_attacker_card_id uuid
)
returns public.game_combat_assignments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_assignment public.game_combat_assignments;
  v_blocker_type_line text;
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
    raise exception 'Cannot declare blockers in a finished game session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if v_turn_state.step <> 'declare_blockers' then
    raise exception 'Blockers can only be declared during Declare Blockers Step';
  end if;

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can declare blockers';
  end if;

  select *
  into v_assignment
  from public.game_combat_assignments
  where session_id = p_session_id
    and turn_number = v_turn_state.turn_number
    and attacker_card_id = p_attacker_card_id
  for update;

  if not found then
    raise exception 'Attacker assignment not found';
  end if;

  if v_assignment.defending_player_id <> auth.uid() then
    raise exception 'Only the defending player can block this attacker';
  end if;

  perform 1
  from public.game_combat_blockers
  where session_id = p_session_id
    and turn_number = v_turn_state.turn_number
    and blocker_card_id = p_blocker_card_id;

  if found then
    raise exception 'This blocker is already assigned';
  end if;

  select cards.type_line
  into v_blocker_type_line
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_blocker_card_id
    and game_cards.session_id = p_session_id
    and coalesce(game_cards.controller_player_id, game_cards.owner_id) = auth.uid()
    and game_cards.zone = 'battlefield'
    and game_cards.is_tapped = false;

  if not found then
    raise exception 'Blocker card not found, not on battlefield, not controlled by defending player, or already tapped';
  end if;

  if coalesce(v_blocker_type_line, '') not ilike '%creature%' then
    raise exception 'Only creatures can be declared as blockers';
  end if;

  -- Flying legality: only flying or reach creatures can block a flying attacker.
  if public.card_has_flying(p_session_id, p_attacker_card_id) then
    if not (
      public.card_has_flying(p_session_id, p_blocker_card_id) or
      public.card_has_reach(p_session_id, p_blocker_card_id)
    ) then
      raise exception 'Only creatures with flying or reach can block a flying creature';
    end if;
  end if;

  insert into public.game_combat_blockers (
    assignment_id,
    session_id,
    turn_number,
    attacker_card_id,
    blocker_card_id,
    blocking_player_id
  )
  values (
    v_assignment.id,
    p_session_id,
    v_turn_state.turn_number,
    p_attacker_card_id,
    p_blocker_card_id,
    auth.uid()
  );

  update public.game_combat_assignments
  set blocker_card_id = coalesce(blocker_card_id, p_blocker_card_id)
  where id = v_assignment.id
  returning * into v_assignment;

  return v_assignment;
end;
$$;

-- register_card_continuous_effects: adds flying and reach to the script
-- allowlist, the default 'affected' mapping, and the keyword mapping.
create or replace function public.register_card_continuous_effects(
  p_session_id uuid,
  p_source_card_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source_card public.game_cards;
  v_script jsonb;
  v_keywords jsonb;
  v_keyword text;
  v_keyword_effect_type text;
  v_effect jsonb;
  v_effect_type text;
  v_affected text;
  v_affected_player_id uuid;
  v_affected_card_id uuid;
  v_source_zone_required text;
  v_payload jsonb;
  v_registered_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select game_cards.*
  into v_source_card
  from public.game_cards
  where game_cards.id = p_source_card_id
    and game_cards.session_id = p_session_id;

  if not found then
    raise exception 'Source card not found';
  end if;

  delete from public.game_continuous_effects
  where session_id = p_session_id
    and source_card_id = p_source_card_id
    and payload ->> 'registered_from_card_script' = 'true';

  if v_source_card.zone <> 'battlefield' or v_source_card.static_effects_suppressed then
    return 0;
  end if;

  select
    coalesce(v_source_card.copied_script, cards.script),
    coalesce(cards.keywords, '[]'::jsonb)
  into v_script, v_keywords
  from public.cards
  where cards.id = v_source_card.card_id;

  for v_effect in
    select value
    from jsonb_array_elements(coalesce(v_script -> 'continuous_effects', '[]'::jsonb))
  loop
    v_effect_type := coalesce(v_effect ->> 'effect_type', v_effect ->> 'type');

    if v_effect_type not in (
      'mana_does_not_empty',
      'additional_land_plays',
      'haste',
      'vigilance',
      'indestructible',
      'trample',
      'first_strike',
      'double_strike',
      'flying',
      'reach'
    ) then
      raise exception 'Unsupported continuous effect type: %', v_effect_type;
    end if;

    v_affected := coalesce(
      v_effect ->> 'affected',
      case
        when v_effect_type in (
          'haste',
          'vigilance',
          'indestructible',
          'trample',
          'first_strike',
          'double_strike',
          'flying',
          'reach'
        ) then 'source'
        else 'controller'
      end
    );
    v_affected_player_id := null;
    v_affected_card_id := null;

    if v_affected in ('all', 'all_players') then
      v_affected_player_id := null;
    elsif v_affected in ('controller', 'self') then
      v_affected_player_id := coalesce(v_source_card.controller_player_id, v_source_card.owner_id);
    elsif v_affected in ('source', 'this') then
      v_affected_card_id := p_source_card_id;
    else
      raise exception 'Unsupported continuous effect affected value: %', v_affected;
    end if;

    v_source_zone_required := coalesce(v_effect ->> 'source_zone_required', 'battlefield');

    if v_source_zone_required not in ('library', 'hand', 'stack', 'battlefield', 'graveyard', 'exile') then
      raise exception 'Unsupported source zone requirement: %', v_source_zone_required;
    end if;

    if v_effect_type = 'additional_land_plays' then
      v_payload := jsonb_build_object(
        'amount',
        coalesce((v_effect ->> 'amount')::integer, 1)
      );
    elsif v_effect_type = 'mana_does_not_empty' then
      v_payload := jsonb_build_object(
        'colors',
        coalesce(v_effect -> 'colors', '[]'::jsonb)
      );
    else
      v_payload := '{}'::jsonb;
    end if;

    v_payload := coalesce(v_effect -> 'payload', v_payload)
      || jsonb_build_object('registered_from_card_script', true);

    insert into public.game_continuous_effects (
      session_id,
      source_card_id,
      affected_player_id,
      affected_card_id,
      effect_type,
      payload,
      source_zone_required,
      expires_at_turn_number,
      expires_at_phase,
      expires_at_step
    )
    values (
      p_session_id,
      p_source_card_id,
      v_affected_player_id,
      v_affected_card_id,
      v_effect_type,
      v_payload,
      v_source_zone_required,
      nullif(v_effect ->> 'expires_at_turn_number', '')::integer,
      nullif(v_effect ->> 'expires_at_phase', ''),
      nullif(v_effect ->> 'expires_at_step', '')
    );

    v_registered_count := v_registered_count + 1;
  end loop;

  for v_keyword in
    select lower(replace(replace(keyword, ' ', '_'), '-', '_'))
    from jsonb_array_elements_text(v_keywords) as keyword
  loop
    v_keyword_effect_type := case v_keyword
      when 'haste'         then 'haste'
      when 'vigilance'     then 'vigilance'
      when 'indestructible' then 'indestructible'
      when 'trample'       then 'trample'
      when 'first_strike'  then 'first_strike'
      when 'double_strike' then 'double_strike'
      when 'flying'        then 'flying'
      when 'reach'         then 'reach'
      else null
    end;

    if v_keyword_effect_type is null then
      continue;
    end if;

    insert into public.game_continuous_effects (
      session_id,
      source_card_id,
      affected_card_id,
      effect_type,
      payload,
      source_zone_required
    )
    values (
      p_session_id,
      p_source_card_id,
      p_source_card_id,
      v_keyword_effect_type,
      jsonb_build_object('registered_from_card_script', true, 'registered_from_keywords', true),
      'battlefield'
    );

    v_registered_count := v_registered_count + 1;
  end loop;

  return v_registered_count;
end;
$$;

-- Update Serra Angel's script to include flying explicitly,
-- so it works without the full Scryfall keyword import.
with scripted_cards(name, script) as (
  values
    (
      'Serra Angel',
      $json${
        "continuous_effects": [
          { "type": "vigilance", "affected": "source", "source_zone_required": "battlefield" },
          { "type": "flying",    "affected": "source", "source_zone_required": "battlefield" }
        ]
      }$json$::jsonb
    )
)
update public.cards
set script = scripted_cards.script
from scripted_cards
where lower(public.cards.name) = lower(scripted_cards.name);

-- Seed test cards for flying and reach.
insert into public.cards (id, name, type_line, mana_cost, power_toughness, script)
select
  gen_random_uuid(),
  'Air Elemental Test',
  'Creature - Elemental',
  '{2}{U}{U}',
  '4/4',
  $json${
    "continuous_effects": [
      { "type": "flying", "affected": "source", "source_zone_required": "battlefield" }
    ]
  }$json$::jsonb
where not exists (
  select 1 from public.cards where lower(name) = 'air elemental test'
);

insert into public.cards (id, name, type_line, mana_cost, power_toughness, script)
select
  gen_random_uuid(),
  'Silhana Ledgewalker Test',
  'Creature - Elf Rogue',
  '{1}{G}',
  '1/1',
  $json${
    "continuous_effects": [
      { "type": "reach", "affected": "source", "source_zone_required": "battlefield" }
    ]
  }$json$::jsonb
where not exists (
  select 1 from public.cards where lower(name) = 'silhana ledgewalker test'
);

grant execute on function public.card_has_flying(uuid, uuid) to authenticated;
grant execute on function public.card_has_reach(uuid, uuid) to authenticated;
grant execute on function public.declare_blocker(uuid, uuid, uuid) to authenticated;
grant execute on function public.register_card_continuous_effects(uuid, uuid) to authenticated;
