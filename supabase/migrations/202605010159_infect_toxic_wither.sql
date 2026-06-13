-- Infect / toxic / wither combat (roadmap Counters #7).
--
-- These keywords change WHAT combat damage becomes — the poison and −1/−1 counter
-- destinations already exist (mig 154 / 157), so this is mostly wiring the combat
-- resolver into them:
--   * infect  — damage to PLAYERS becomes poison counters (no life loss); damage to
--               CREATURES becomes −1/−1 counters (not marked damage).
--   * wither  — damage to CREATURES becomes −1/−1 counters (players take normal damage).
--   * toxic N — in ADDITION to normal combat damage to a player, that player gets N
--               poison counters (does not change creature damage).
--
-- A creature with infect AND toxic poisons a player for power + N. Wither and infect
-- share the −1/−1-to-creature path (`apply_damage_to_creature` gains an as_minus flag
-- so the prevention/shield logic stays DRY). Combat's end-of-step move_lethal already
-- destroys creatures at ≤0 effective toughness (704.5f, counting −1/−1), so wither
-- kills need no extra sweep; a final recheck handles +1/+1 vs −1/−1 annihilation.
--
-- Authoring: continuous_effects entries `{type:'infect'|'wither'}` and
-- `{type:'toxic', amount:N}` (also infect/wither via the card keywords array). The
-- poison loss (≥10) rides the existing maybe_finish_game_session call at combat end.
--
-- KNOWN GAP (deferred, rare): a deathtouch source with wither/infect does NOT destroy
-- via deathtouch — the counter path marks no damage, and 704.5g needs damage_marked>0.
-- Toxic from the keywords array ("Toxic 2") isn't parsed (no amount) — use the
-- continuous_effects form. Reproduced from CURRENT (grep-first): apply_damage_to_creature
-- (148), register_card_continuous_effects (134), resolve_combat_damage (148).
-- (IDE T-SQL false-positives on $$ bodies — ignore.)

-- Allow the new effect_types on the table CHECK. CURRENT list = mig 146 (never
-- rebuild from the stale baseline — bug-283); append infect/wither/toxic.
alter table public.game_continuous_effects
  drop constraint if exists game_continuous_effects_effect_type_check;
alter table public.game_continuous_effects
  add constraint game_continuous_effects_effect_type_check
  check (effect_type = any (array[
    'mana_does_not_empty', 'additional_land_plays', 'haste', 'vigilance',
    'indestructible', 'trample', 'first_strike', 'double_strike', 'flying',
    'reach', 'deathtouch', 'pump', 'control', 'set_pt', 'protection', 'switch_pt',
    'infect', 'wither', 'toxic'
  ]));

-- ===========================================================================
-- Keyword readers — mirror card_has_trample (effect rows on game_continuous_effects).
-- ===========================================================================
create or replace function public.card_has_infect(p_session_id uuid, p_game_card_id uuid)
returns boolean
language sql security definer set search_path = public
as $$
  select exists (
    select 1
    from public.game_continuous_effects effects
    left join public.game_cards source_card on source_card.id = effects.source_card_id
    where effects.session_id = p_session_id
      and effects.effect_type = 'infect'
      and public.is_session_player(p_session_id, auth.uid())
      and (effects.affected_card_id = p_game_card_id or effects.affected_card_id is null)
      and (effects.source_zone_required is null or source_card.zone = effects.source_zone_required)
  );
$$;
grant execute on function public.card_has_infect(uuid, uuid) to authenticated;
grant execute on function public.card_has_infect(uuid, uuid) to service_role;

create or replace function public.card_has_wither(p_session_id uuid, p_game_card_id uuid)
returns boolean
language sql security definer set search_path = public
as $$
  select exists (
    select 1
    from public.game_continuous_effects effects
    left join public.game_cards source_card on source_card.id = effects.source_card_id
    where effects.session_id = p_session_id
      and effects.effect_type = 'wither'
      and public.is_session_player(p_session_id, auth.uid())
      and (effects.affected_card_id = p_game_card_id or effects.affected_card_id is null)
      and (effects.source_zone_required is null or source_card.zone = effects.source_zone_required)
  );
$$;
grant execute on function public.card_has_wither(uuid, uuid) to authenticated;
grant execute on function public.card_has_wither(uuid, uuid) to service_role;

create or replace function public.card_toxic_amount(p_session_id uuid, p_game_card_id uuid)
returns integer
language sql security definer set search_path = public
as $$
  select coalesce(sum(coalesce((effects.payload ->> 'amount')::integer, 0)), 0)::integer
  from public.game_continuous_effects effects
  left join public.game_cards source_card on source_card.id = effects.source_card_id
  where effects.session_id = p_session_id
    and effects.effect_type = 'toxic'
    and public.is_session_player(p_session_id, auth.uid())
    and (effects.affected_card_id = p_game_card_id or effects.affected_card_id is null)
    and (effects.source_zone_required is null or source_card.zone = effects.source_zone_required);
$$;
grant execute on function public.card_toxic_amount(uuid, uuid) to authenticated;
grant execute on function public.card_toxic_amount(uuid, uuid) to service_role;

-- ===========================================================================
-- add_player_poison — combat poison destination (loss check rides combat-end
-- maybe_finish_game_session, which already loses a player at poison ≥ 10, mig 154).
-- ===========================================================================
create or replace function public.add_player_poison(p_session_id uuid, p_player_id uuid, p_amount integer)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_player_id is null or coalesce(p_amount, 0) <= 0 then
    return;
  end if;
  update public.game_session_players
  set counters = public.adjust_counter_bag(counters, 'poison', p_amount)
  where session_id = p_session_id and player_id = p_player_id;
end;
$$;
grant execute on function public.add_player_poison(uuid, uuid, integer) to authenticated;
grant execute on function public.add_player_poison(uuid, uuid, integer) to service_role;

-- ===========================================================================
-- apply_damage_to_creature (CURRENT = mig 148) + p_as_minus_counters: when true the
-- post-shield remaining lands as −1/−1 bag counters instead of marked damage (wither /
-- infect). Drop the 7-arg first; the 6-arg targeted caller resolves to the new 8-arg.
-- ===========================================================================
drop function if exists public.apply_damage_to_creature(uuid, uuid, integer, uuid, boolean, boolean, boolean);

create or replace function public.apply_damage_to_creature(
  p_session_id uuid,
  p_card_id uuid,
  p_amount integer,
  p_source_card_id uuid default null,
  p_is_combat boolean default false,
  p_deathtouch boolean default false,
  p_run_sweep boolean default true,
  p_as_minus_counters boolean default false
) returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_remaining integer := greatest(0, coalesce(p_amount, 0));
  v_turn integer;
  v_shield record;
  v_prevent integer;
begin
  if v_remaining <= 0 then
    return 0;
  end if;

  select turn_number into v_turn
  from public.game_turn_state where session_id = p_session_id;

  for v_shield in
    select * from public.game_damage_prevention
    where session_id = p_session_id
      and affected_card_id = p_card_id
      and (combat_only = false or p_is_combat = true)
      and (expires_turn is null or expires_turn >= coalesce(v_turn, 0))
    order by created_at asc, id asc
    for update
  loop
    exit when v_remaining <= 0;

    if v_shield.amount is null then
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
    if p_as_minus_counters then
      -- wither / infect: damage becomes −1/−1 counters (still "damage" for the
      -- toughness SBA; deathtouch-via-counters is a known deferred gap).
      update public.game_cards
      set counters = public.adjust_counter_bag(counters, 'minus_one_one', v_remaining)
      where id = p_card_id
        and session_id = p_session_id
        and zone = 'battlefield';
    else
      update public.game_cards
      set damage_marked = damage_marked + v_remaining,
          dealt_deathtouch_damage = dealt_deathtouch_damage or coalesce(p_deathtouch, false)
      where id = p_card_id
        and session_id = p_session_id
        and zone = 'battlefield';
    end if;

    -- Combat defers the lethal sweep to its single end-of-step pass (simultaneity).
    if p_run_sweep then
      if p_as_minus_counters then
        perform public.recheck_counter_state(p_session_id);
      else
        perform public.move_lethal_damaged_creatures_to_graveyard(p_session_id);
      end if;
    end if;
  end if;

  return v_remaining;
end;
$$;

revoke all on function public.apply_damage_to_creature(uuid, uuid, integer, uuid, boolean, boolean, boolean, boolean) from public;
grant execute on function public.apply_damage_to_creature(uuid, uuid, integer, uuid, boolean, boolean, boolean, boolean) to authenticated;
grant execute on function public.apply_damage_to_creature(uuid, uuid, integer, uuid, boolean, boolean, boolean, boolean) to service_role;

-- ===========================================================================
-- register_card_continuous_effects (CURRENT = mig 134) — add infect / wither / toxic
-- to the whitelist, the 'source' default-affected list, the keyword map (infect/
-- wither), and a toxic payload (amount). Everything else verbatim.
-- ===========================================================================
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
      'toxic'
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
          'toxic'
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

-- ===========================================================================
-- resolve_combat_damage (CURRENT = mig 148) — route the 4 damage sites by keyword:
-- infect → poison (player) / −1/−1 (creature); wither → −1/−1 (creature); toxic → +N
-- poison whenever the attacker deals combat damage to a player. A final
-- recheck_counter_state runs annihilation if any −1/−1 combat damage landed.
-- Everything else verbatim from mig 148.
-- ===========================================================================
create or replace function public.resolve_combat_damage(
  p_session_id uuid,
  p_assignments jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_required_player_id uuid;
  v_assignment record;
  v_blocker record;
  v_attacker_damage integer;
  v_remaining_attacker_damage integer;
  v_blocker_damage integer;
  v_assigned_damage integer;
  v_has_blockers boolean;
  v_is_first_strike_stage boolean := false;
  v_attacker_has_first_strike boolean;
  v_attacker_has_double_strike boolean;
  v_attacker_has_deathtouch boolean;
  v_attacker_deals_damage boolean;
  v_attacker_has_infect boolean;
  v_attacker_has_wither boolean;
  v_attacker_toxic integer;
  v_blocker_has_first_strike boolean;
  v_blocker_has_double_strike boolean;
  v_blocker_has_deathtouch boolean;
  v_blocker_deals_damage boolean;
  v_blocker_has_infect boolean;
  v_blocker_has_wither boolean;
  v_lethal_per_blocker integer;
  v_total_player_damage integer := 0;
  v_total_creature_damage integer := 0;
  v_destroyed_count integer := 0;
  v_resolved_count integer := 0;
  v_minus_dealt boolean := false;
  v_finish_state jsonb;
  v_chosen jsonb;
  v_trample_amount integer;
  v_va_key text;
  v_va_chosen jsonb;
  v_va_assignment_id uuid;
  v_va_power integer;
  v_va_deathtouch boolean;
  v_va_trample boolean;
  v_va_blocker record;
  v_va_lethal integer;
  v_va_amt integer;
  v_va_sum integer;
  v_va_trample_amt integer;
  v_va_satisfied boolean;
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
    raise exception 'Cannot resolve combat damage in a finished game session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if v_turn_state.step <> 'combat_damage' then
    raise exception 'Combat damage can only be resolved during Combat Damage Step';
  end if;

  v_required_player_id := coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id);

  if v_required_player_id <> auth.uid() then
    raise exception 'Only the priority player can resolve combat damage';
  end if;

  -- ── Validation pre-pass (unchanged from mig 122/132).
  if p_assignments is not null and p_assignments <> 'null'::jsonb then
    for v_va_key in select jsonb_object_keys(p_assignments)
    loop
      select combat.id,
             public.card_effective_power(p_session_id, combat.attacker_card_id),
             public.card_has_deathtouch(p_session_id, combat.attacker_card_id),
             public.card_has_trample(p_session_id, combat.attacker_card_id)
      into v_va_assignment_id, v_va_power, v_va_deathtouch, v_va_trample
      from public.game_combat_assignments combat
      where combat.session_id = p_session_id
        and combat.turn_number = v_turn_state.turn_number
        and combat.attacker_card_id = v_va_key::uuid
        and combat.damage_resolved = false;

      if not found then
        continue;
      end if;

      v_va_chosen := p_assignments -> v_va_key;
      v_va_trample_amt := coalesce((v_va_chosen ->> 'trample')::integer, 0);
      if v_va_trample_amt < 0 then
        raise exception 'Combat damage assignment cannot be negative';
      end if;
      if v_va_trample_amt > 0 and not coalesce(v_va_trample, false) then
        raise exception 'Cannot assign trample damage: attacker has no trample';
      end if;

      v_va_sum := v_va_trample_amt;
      v_va_satisfied := true;

      for v_va_blocker in
        select blockers.blocker_card_id,
               public.card_effective_toughness(p_session_id, blockers.blocker_card_id) as toughness
        from public.game_combat_blockers blockers
        join public.game_cards blocker_instance
          on blocker_instance.id = blockers.blocker_card_id
         and blocker_instance.zone = 'battlefield'
        where blockers.assignment_id = v_va_assignment_id
        order by blockers.damage_assignment_order, blockers.created_at, blockers.id
      loop
        v_va_amt := coalesce((
          select (b ->> 'amount')::integer
          from jsonb_array_elements(coalesce(v_va_chosen -> 'blockers', '[]'::jsonb)) b
          where b ->> 'blocker_card_id' = v_va_blocker.blocker_card_id::text
          limit 1
        ), 0);

        if v_va_amt < 0 then
          raise exception 'Combat damage assignment cannot be negative';
        end if;

        if not v_va_satisfied and v_va_amt > 0 then
          raise exception 'Must assign lethal damage to earlier blockers before later ones';
        end if;

        v_va_lethal := case when coalesce(v_va_deathtouch, false) then 1
                            else greatest(1, v_va_blocker.toughness) end;
        if v_va_amt < v_va_lethal then
          v_va_satisfied := false;
        end if;

        v_va_sum := v_va_sum + v_va_amt;
      end loop;

      if v_va_trample_amt > 0 and not v_va_satisfied then
        raise exception 'Cannot assign trample damage before all blockers have lethal damage';
      end if;

      if v_va_sum > greatest(0, coalesce(v_va_power, 0)) then
        raise exception 'Assigned combat damage % exceeds attacker power %', v_va_sum, v_va_power;
      end if;
    end loop;
  end if;

  select exists (
    select 1
    from public.game_combat_assignments combat
    left join public.game_cards attacker_instance
      on attacker_instance.id = combat.attacker_card_id
     and attacker_instance.zone = 'battlefield'
    left join public.game_combat_blockers blockers
      on blockers.assignment_id = combat.id
    left join public.game_cards blocker_instance
      on blocker_instance.id = blockers.blocker_card_id
     and blocker_instance.zone = 'battlefield'
    where combat.session_id = p_session_id
      and combat.turn_number = v_turn_state.turn_number
      and combat.damage_resolved = false
      and combat.first_strike_damage_resolved = false
      and (
        public.card_has_first_strike(p_session_id, attacker_instance.id)
        or public.card_has_double_strike(p_session_id, attacker_instance.id)
        or public.card_has_first_strike(p_session_id, blocker_instance.id)
        or public.card_has_double_strike(p_session_id, blocker_instance.id)
      )
  )
  into v_is_first_strike_stage;

  for v_assignment in
    select
      combat.id,
      combat.attacker_card_id,
      combat.defending_player_id,
      attacker_instance.id is not null as attacker_on_battlefield,
      public.card_effective_power(p_session_id, combat.attacker_card_id) as attacker_power
    from public.game_combat_assignments combat
    left join public.game_cards attacker_instance
      on attacker_instance.id = combat.attacker_card_id
     and attacker_instance.zone = 'battlefield'
    where combat.session_id = p_session_id
      and combat.turn_number = v_turn_state.turn_number
      and combat.damage_resolved = false
      and (
        v_is_first_strike_stage = false
        or combat.first_strike_damage_resolved = false
      )
    order by combat.created_at
    for update of combat
  loop
    if not v_assignment.attacker_on_battlefield then
      if not v_is_first_strike_stage then
        update public.game_combat_assignments
        set damage_resolved = true
        where id = v_assignment.id;
      end if;

      continue;
    end if;

    v_attacker_damage := greatest(0, v_assignment.attacker_power);
    v_remaining_attacker_damage := v_attacker_damage;
    v_attacker_has_first_strike := public.card_has_first_strike(p_session_id, v_assignment.attacker_card_id);
    v_attacker_has_double_strike := public.card_has_double_strike(p_session_id, v_assignment.attacker_card_id);
    v_attacker_has_deathtouch := public.card_has_deathtouch(p_session_id, v_assignment.attacker_card_id);
    v_attacker_has_infect := public.card_has_infect(p_session_id, v_assignment.attacker_card_id);
    v_attacker_has_wither := public.card_has_wither(p_session_id, v_assignment.attacker_card_id);
    v_attacker_toxic := public.card_toxic_amount(p_session_id, v_assignment.attacker_card_id);

    v_chosen := case
      when p_assignments is not null and p_assignments <> 'null'::jsonb
        then p_assignments -> v_assignment.attacker_card_id::text
      else null
    end;

    if v_is_first_strike_stage then
      v_attacker_deals_damage := v_attacker_has_first_strike or v_attacker_has_double_strike;
    else
      v_attacker_deals_damage := (not v_attacker_has_first_strike) or v_attacker_has_double_strike;
    end if;

    select exists (
      select 1
      from public.game_combat_blockers blockers
      where blockers.assignment_id = v_assignment.id
    )
    into v_has_blockers;

    if not v_has_blockers then
      if v_attacker_deals_damage and v_attacker_damage > 0 then
        -- Unblocked: infect deals power as poison (no life); else normal damage.
        if v_attacker_has_infect then
          perform public.add_player_poison(p_session_id, v_assignment.defending_player_id, v_attacker_damage);
        else
          v_total_player_damage := v_total_player_damage + public.apply_damage_to_player(
            p_session_id, v_assignment.defending_player_id, v_attacker_damage,
            v_assignment.attacker_card_id, true
          );
        end if;
        -- Toxic N: poison in addition to dealing combat damage to the player.
        if v_attacker_toxic > 0 then
          perform public.add_player_poison(p_session_id, v_assignment.defending_player_id, v_attacker_toxic);
        end if;
      end if;
    else
      for v_blocker in
        select
          blockers.blocker_card_id,
          public.card_effective_power(p_session_id, blockers.blocker_card_id) as blocker_power,
          public.card_effective_toughness(p_session_id, blockers.blocker_card_id) as blocker_toughness
        from public.game_combat_blockers blockers
        join public.game_cards blocker_instance
          on blocker_instance.id = blockers.blocker_card_id
         and blocker_instance.zone = 'battlefield'
        where blockers.assignment_id = v_assignment.id
        order by blockers.damage_assignment_order, blockers.created_at, blockers.id
      loop
        v_blocker_damage := greatest(0, v_blocker.blocker_power);
        v_blocker_has_first_strike := public.card_has_first_strike(p_session_id, v_blocker.blocker_card_id);
        v_blocker_has_double_strike := public.card_has_double_strike(p_session_id, v_blocker.blocker_card_id);
        v_blocker_has_deathtouch := public.card_has_deathtouch(p_session_id, v_blocker.blocker_card_id);
        v_blocker_has_infect := public.card_has_infect(p_session_id, v_blocker.blocker_card_id);
        v_blocker_has_wither := public.card_has_wither(p_session_id, v_blocker.blocker_card_id);

        if v_is_first_strike_stage then
          v_blocker_deals_damage := v_blocker_has_first_strike or v_blocker_has_double_strike;
        else
          v_blocker_deals_damage := (not v_blocker_has_first_strike) or v_blocker_has_double_strike;
        end if;

        if v_attacker_deals_damage and v_remaining_attacker_damage > 0 then
          if v_chosen is not null then
            v_assigned_damage := least(
              v_remaining_attacker_damage,
              greatest(0, coalesce((
                select (b ->> 'amount')::integer
                from jsonb_array_elements(coalesce(v_chosen -> 'blockers', '[]'::jsonb)) b
                where b ->> 'blocker_card_id' = v_blocker.blocker_card_id::text
                limit 1
              ), 0))
            );
          else
            if v_attacker_has_deathtouch then
              v_lethal_per_blocker := 1;
            else
              v_lethal_per_blocker := greatest(1, v_blocker.blocker_toughness);
            end if;

            v_assigned_damage := least(v_remaining_attacker_damage, v_lethal_per_blocker);
          end if;

          if v_assigned_damage > 0 then
            -- Protection gate (colour): damage still ASSIGNED, only DEALT if no
            -- protection. The dealt portion routes through the shield resolver,
            -- as −1/−1 counters when the attacker has wither/infect.
            if not public.card_has_protection_from_any(
                 p_session_id, v_blocker.blocker_card_id,
                 public.game_card_color_set(p_session_id, v_assignment.attacker_card_id)
               ) then
              v_total_creature_damage := v_total_creature_damage + public.apply_damage_to_creature(
                p_session_id, v_blocker.blocker_card_id, v_assigned_damage,
                v_assignment.attacker_card_id, true, v_attacker_has_deathtouch, false,
                v_attacker_has_infect or v_attacker_has_wither
              );
              if v_attacker_has_infect or v_attacker_has_wither then
                v_minus_dealt := true;
              end if;
            end if;

            v_remaining_attacker_damage := v_remaining_attacker_damage - v_assigned_damage;
          end if;
        end if;

        if v_blocker_deals_damage and v_blocker_damage > 0 then
          if not public.card_has_protection_from_any(
               p_session_id, v_assignment.attacker_card_id,
               public.game_card_color_set(p_session_id, v_blocker.blocker_card_id)
             ) then
            v_total_creature_damage := v_total_creature_damage + public.apply_damage_to_creature(
              p_session_id, v_assignment.attacker_card_id, v_blocker_damage,
              v_blocker.blocker_card_id, true, v_blocker_has_deathtouch, false,
              v_blocker_has_infect or v_blocker_has_wither
            );
            if v_blocker_has_infect or v_blocker_has_wither then
              v_minus_dealt := true;
            end if;
          end if;
        end if;
      end loop;

      if v_attacker_deals_damage
        and v_remaining_attacker_damage > 0
        and public.card_has_trample(p_session_id, v_assignment.attacker_card_id)
      then
        if v_chosen is not null then
          v_trample_amount := least(
            v_remaining_attacker_damage,
            greatest(0, coalesce((v_chosen ->> 'trample')::integer, 0))
          );
        else
          v_trample_amount := v_remaining_attacker_damage;
        end if;

        if v_trample_amount > 0 then
          -- Trample over to the player: infect → poison, else normal; toxic adds N.
          if v_attacker_has_infect then
            perform public.add_player_poison(p_session_id, v_assignment.defending_player_id, v_trample_amount);
          else
            v_total_player_damage := v_total_player_damage + public.apply_damage_to_player(
              p_session_id, v_assignment.defending_player_id, v_trample_amount,
              v_assignment.attacker_card_id, true
            );
          end if;
          if v_attacker_toxic > 0 then
            perform public.add_player_poison(p_session_id, v_assignment.defending_player_id, v_attacker_toxic);
          end if;
        end if;
      end if;
    end if;

    if v_is_first_strike_stage then
      update public.game_combat_assignments
      set first_strike_damage_resolved = true
      where id = v_assignment.id;
    else
      update public.game_combat_assignments
      set damage_resolved = true
      where id = v_assignment.id;
    end if;

    v_resolved_count := v_resolved_count + 1;
  end loop;

  if v_is_first_strike_stage then
    update public.game_combat_assignments
    set first_strike_damage_resolved = true
    where session_id = p_session_id
      and turn_number = v_turn_state.turn_number
      and damage_resolved = false
      and first_strike_damage_resolved = false;
  else
    update public.game_combat_assignments
    set damage_resolved = true
    where session_id = p_session_id
      and turn_number = v_turn_state.turn_number
      and damage_resolved = false;
  end if;

  v_destroyed_count := public.move_lethal_damaged_creatures_to_graveyard(p_session_id);

  -- −1/−1 combat damage (wither/infect): run annihilation (CR 122.3) once at end.
  if v_minus_dealt then
    perform public.recheck_counter_state(p_session_id);
  end if;

  update public.game_cards
  set dealt_deathtouch_damage = false
  where session_id = p_session_id
    and dealt_deathtouch_damage = true;

  v_finish_state := public.maybe_finish_game_session(p_session_id);

  return jsonb_build_object(
    'assignments_resolved',
    v_resolved_count,
    'damage_stage',
    case when v_is_first_strike_stage then 'first_strike' else 'regular' end,
    'total_damage',
    v_total_player_damage,
    'total_player_damage',
    v_total_player_damage,
    'total_creature_damage',
    v_total_creature_damage,
    'creatures_destroyed',
    v_destroyed_count,
    'finished',
    coalesce((v_finish_state ->> 'finished')::boolean, false),
    'winner_player_id',
    v_finish_state ->> 'winner_player_id'
  );
end;
$$;

grant execute on function public.resolve_combat_damage(uuid, jsonb) to anon;
grant execute on function public.resolve_combat_damage(uuid, jsonb) to authenticated;
grant execute on function public.resolve_combat_damage(uuid, jsonb) to service_role;
