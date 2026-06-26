-- 202605010338_fear
-- Fear keyword (Cover of Darkness: chosen creature type "can't be blocked except
-- by artifact and/or black creatures"). New card_has_fear accessor (cloned from
-- card_has_intimidate); 'fear' added to the continuous-effect whitelist + keyword
-- map in register_card_continuous_effects; declare_blocker rejects a non-artifact
-- non-black blocker against a fear attacker. Registration of the chosen-type fear
-- anthem rides the choose_creature_type rebuild from mig 337.
-- Generated from supabase/functions_src (card_has_fear, register_card_continuous_effects, declare_blocker) — those files are
-- the canonical current definitions; edit them, not past migrations.

-- Non-function DDL: allow the new 'fear' effect_type on game_continuous_effects
-- (extends the mig 323 constraint).
alter table public.game_continuous_effects
  drop constraint if exists game_continuous_effects_effect_type_check;
alter table public.game_continuous_effects
  add constraint game_continuous_effects_effect_type_check
  check (effect_type = any (array[
    'mana_does_not_empty', 'additional_land_plays', 'haste', 'vigilance',
    'indestructible', 'trample', 'first_strike', 'double_strike', 'flying',
    'reach', 'deathtouch', 'pump', 'control', 'set_pt', 'protection', 'switch_pt',
    'infect', 'wither', 'toxic', 'cast_from_graveyard', 'menace',
    'intimidate', 'hexproof', 'curse_attacked', 'play_from_exile', 'cost_reduction',
    'cast_from_library_top', 'goaded', 'creatures_enter_tapped', 'damage_cap',
    'exiled_until_leaves', 'attack_tax', 'animated', 'lifelink',
    'cant_attack', 'cant_block', 'defender', 'fear'
  ]));

create or replace function public.card_has_fear(p_session_id uuid, p_game_card_id uuid)
returns boolean language sql security definer set search_path = public as $$
  select exists (
    select 1
    from public.game_continuous_effects effects
    left join public.game_cards source_card on source_card.id = effects.source_card_id
    left join public.game_cards tc on tc.id = p_game_card_id
    left join public.cards tcard on tcard.id = tc.card_id
    where effects.session_id = p_session_id
      and effects.effect_type = 'fear'
      and (
        effects.affected_card_id = p_game_card_id
        or (
          effects.affected_card_id is null
          and (effects.affected_player_id is null
               or effects.affected_player_id = coalesce(tc.controller_player_id, tc.owner_id))
          and (effects.payload ->> 'creature_type' is null
               or tcard.type_line ilike '%' || (effects.payload ->> 'creature_type') || '%')
          and (not coalesce((effects.payload ->> 'exclude_source')::boolean, false)
               or p_game_card_id is distinct from effects.source_card_id)
          and (not coalesce((effects.payload ->> 'token_only')::boolean, false)
               or coalesce(tcard.is_token, false))
        )
      )
      and (effects.source_zone_required is null or source_card.zone = effects.source_zone_required)
  );
$$;
grant execute on function public.card_has_fear(uuid, uuid) to authenticated, service_role;

create or replace function public.register_card_continuous_effects(
  p_session_id uuid, p_source_card_id uuid
) returns integer
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

  -- A manifested (face-down) card has no abilities and no printed keywords
  -- (mig 251, Reality Shift); its 2/2 set_pt row is not script-flagged, so
  -- the delete above leaves it alone.
  if coalesce(v_source_card.counters, '{}'::jsonb) ? 'manifested' then
    return 0;
  end if;

  v_script := public.effective_script(p_session_id, p_source_card_id);

  select coalesce(cards.keywords, '[]'::jsonb)
  into v_keywords
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
      'reach',
      'deathtouch',
      'protection',
      'pump',
      'infect',
      'wither',
      'toxic',
      'menace',
      'lifelink',
      'intimidate',
      'hexproof',
      -- Fear (mig 338, Cover of Darkness): "can't be blocked except by artifact
      -- and/or black creatures"; declare_blocker enforces it via card_has_fear.
      'fear',
      -- Defender (mig 323): "this creature can't attack"; declare_attacker rejects it.
      'defender',
      -- STATIC cast-from-graveyard permission (mig 207, Gisa and Geralf): a
      -- script-registered row, swept by rebuild when the source leaves — unlike
      -- the until-EOT grant_cast_from_graveyard effect rows (mig 173).
      'cast_from_graveyard',
      -- STATIC cost reduction (mig 231, Dragonlord's Servant / Sarkhan): payload
      -- {type_line, amount}; reduced_mana_cost sums these for the caster. Defaults
      -- to affected:'controller' (not a source-keyword), so affected_player_id is
      -- the controller.
      'cost_reduction',
      -- STATIC cast-from-the-top-of-your-library permission (mig 244,
      -- Thundermane Dragon): payload {creature, min_power, grant_haste};
      -- cast_card_from_hand's library gate consumes it.
      'cast_from_library_top',
      -- STATIC "creatures your opponents control enter tapped" (mig 258,
      -- Kinjalli's Sunwing): fire_zone_change_triggers taps creatures entering
      -- under any OTHER player's control while this row's source is fielded.
      'creatures_enter_tapped',
      -- STATIC damage cap (mig 259, Temple Altisaur): payload {type_line, cap};
      -- apply_damage_to_creature caps damage to OTHER matching creatures the
      -- source's controller controls.
      'damage_cap',
      -- STATIC base-P/T override via aura (mig 279, Darksteel Mutation:
      -- 'enchanted creature is 0/1'). affected:'enchanted' lands it on the
      -- host; losing abilities/types is NOT modelled.
      'set_pt',
      -- STATIC attack tax (mig 275, Ghostly Prison / Norn's Annex / Windborn
      -- Muse): payload {mana:N} or {life:N}; declare_attacker auto-pays per
      -- attacker against the protected (controller) player.
      'attack_tax',
      -- PACIFY (mig 303, Observed Stasis): affected:'enchanted' rows that forbid
      -- the host from attacking / blocking; declare_attacker / declare_blocker
      -- reject the action while the source (Aura) stays fielded.
      'cant_attack',
      'cant_block'
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
          'reach',
          'deathtouch',
          'protection',
          'infect',
          'wither',
          'toxic',
          'menace',
          'lifelink',
          'intimidate',
          'hexproof',
          'defender'
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
    elsif v_affected in ('attached', 'host', 'enchanted', 'equipped') then
      -- Aura/Equipment: the effect lands on the host. Unattached → grants nothing.
      v_affected_card_id := v_source_card.attached_to;
      if v_affected_card_id is null then
        continue;
      end if;
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
    elsif v_effect_type = 'protection' then
      v_payload := jsonb_build_object(
        'from',
        lower(coalesce(v_effect ->> 'from', v_effect ->> 'color'))
      );
    elsif v_effect_type = 'toxic' then
      v_payload := jsonb_build_object(
        'amount',
        greatest(1, coalesce((v_effect ->> 'amount')::integer, 1))
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
      when 'deathtouch'    then 'deathtouch'
      when 'infect'        then 'infect'
      when 'wither'        then 'wither'
      when 'menace'        then 'menace'
      when 'intimidate'    then 'intimidate'
      when 'fear'          then 'fear'
      when 'hexproof'      then 'hexproof'
      when 'defender'      then 'defender'
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
grant execute on function public.register_card_continuous_effects(uuid, uuid) to authenticated, service_role;

create or replace function public.declare_blocker(
  p_session_id uuid, p_blocker_card_id uuid, p_attacker_card_id uuid
) returns public.game_combat_assignments
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

  -- Pacify (mig 303, Observed Stasis): a 'cant_block' continuous effect on the
  -- creature (e.g. from an Aura that "can't attack or block") forbids blocking.
  if exists (
    select 1 from public.game_continuous_effects ce
    join public.game_cards src on src.id = ce.source_card_id and src.session_id = ce.session_id
    where ce.session_id = p_session_id and ce.effect_type = 'cant_block'
      and ce.affected_card_id = p_blocker_card_id and src.zone = 'battlefield'
  ) then
    raise exception 'This creature cannot block';
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

  if coalesce(v_blocker_type_line, '') not ilike '%creature%'
     -- Animated lands (mig 277) can block too.
     and not exists (
       select 1 from public.game_continuous_effects ce
       where ce.session_id = p_session_id and ce.effect_type = 'animated'
         and ce.affected_card_id = p_blocker_card_id
     )
  then
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

  -- Protection: an attacker with protection from the blocker's colour can't be
  -- blocked by it.
  if public.card_has_protection_from_any(
       p_session_id, p_attacker_card_id,
       public.game_card_color_set(p_session_id, p_blocker_card_id)
     ) then
    raise exception 'Attacker has protection from this blocker''s colour and cannot be blocked by it';
  end if;

  -- Intimidate: only artifact creatures and/or creatures sharing a colour with the
  -- attacker can block it.
  if public.card_has_intimidate(p_session_id, p_attacker_card_id) then
    if not (
      exists (
        select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.id = p_blocker_card_id and gc.session_id = p_session_id and c.type_line ilike '%artifact%'
      )
      or public.game_card_color_set(p_session_id, p_blocker_card_id)
         && public.game_card_color_set(p_session_id, p_attacker_card_id)
    ) then
      raise exception 'An intimidating creature can only be blocked by artifact creatures or creatures that share a colour with it';
    end if;
  end if;

  -- Fear (mig 338, Cover of Darkness): only artifact and/or black creatures can
  -- block a creature with fear.
  if public.card_has_fear(p_session_id, p_attacker_card_id) then
    if not (
      exists (
        select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.id = p_blocker_card_id and gc.session_id = p_session_id and c.type_line ilike '%artifact%'
      )
      or 'black' = any(public.game_card_color_set(p_session_id, p_blocker_card_id))
    ) then
      raise exception 'A creature with fear can only be blocked by artifact creatures and/or black creatures';
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

  -- "Whenever this creature becomes blocked" (mig 273, Ichorclaw Myr): fired
  -- once per block declaration against the ATTACKER. (Multi-blocker combats
  -- fire once per blocker — approximation; the real event fires once.)
  perform public.fire_card_triggers(
    p_session_id, p_attacker_card_id, array['becomes_blocked']);

  return v_assignment;
end;
$$;
grant execute on function public.declare_blocker(uuid, uuid, uuid) to anon, authenticated, service_role;
