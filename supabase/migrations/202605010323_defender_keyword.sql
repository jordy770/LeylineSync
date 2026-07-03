-- 202605010323_defender_keyword
-- Defender keyword: a creature with defender can't attack.
--  • card_has_defender — new accessor (mig 200 keyword-family form, effect_type 'defender').
--  • register_card_continuous_effects — 'defender' added to the continuous_effects whitelist
--    + its source-default list, and to the printed-keyword whitelist (cards.keywords from the
--    Scryfall import). So defender registers whether scripted as a continuous_effect or a keyword.
--  • declare_attacker — gate that rejects a defender creature right after the summoning-sickness check.
-- Generated from supabase/functions_src (card_has_defender, register_card_continuous_effects, declare_attacker) — those files are
-- the canonical current definitions; edit them, not past migrations.

-- Non-function DDL: allow the new 'defender' effect_type on game_continuous_effects
-- (extends the mig 303 constraint).
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
    'cant_attack', 'cant_block', 'defender'
  ]));

create or replace function public.card_has_defender(p_session_id uuid, p_game_card_id uuid)
returns boolean language sql security definer set search_path = public as $$
  select exists (
    select 1
    from public.game_continuous_effects effects
    left join public.game_cards source_card on source_card.id = effects.source_card_id
    left join public.game_cards tc on tc.id = p_game_card_id
    left join public.cards tcard on tcard.id = tc.card_id
    where effects.session_id = p_session_id
      and effects.effect_type = 'defender'
      and public.is_session_player(p_session_id, auth.uid())
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
grant execute on function public.card_has_defender(uuid, uuid) to authenticated, service_role;

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

create or replace function public.declare_attacker(
  p_session_id uuid,
  p_attacker_card_id uuid,
  p_defending_player_id uuid,
  p_defending_planeswalker_id uuid default null,
  p_exert boolean default false
) returns public.game_combat_assignments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_attacker record;
  v_pw record;
  v_defending_player uuid := p_defending_player_id;
  v_assignment public.game_combat_assignments;
  v_curse record;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  -- Attacking a planeswalker: the defending player is its controller.
  if p_defending_planeswalker_id is not null then
    select coalesce(gc.controller_player_id, gc.owner_id) as controller, c.type_line
    into v_pw
    from public.game_cards gc
    join public.cards c on c.id = gc.card_id
    where gc.id = p_defending_planeswalker_id
      and gc.session_id = p_session_id
      and gc.zone = 'battlefield';
    if not found or coalesce(v_pw.type_line, '') not ilike '%planeswalker%' then
      raise exception 'Defending planeswalker not found on the battlefield';
    end if;
    v_defending_player := v_pw.controller;
  end if;

  if not public.is_session_player(p_session_id, v_defending_player) then
    raise exception 'Defending player is not a player in this session';
  end if;

  if v_defending_player = auth.uid() then
    raise exception 'A player cannot attack themselves';
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
    raise exception 'Cannot declare attackers in a finished game session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if v_turn_state.active_player_id <> auth.uid() then
    raise exception 'Only the active player can declare attackers';
  end if;

  if v_turn_state.step <> 'declare_attackers' then
    raise exception 'Attackers can only be declared during Declare Attackers Step';
  end if;

  select
    game_cards.id,
    game_cards.is_tapped,
    game_cards.entered_battlefield_turn_number,
    cards.type_line
  into v_attacker
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_attacker_card_id
    and game_cards.session_id = p_session_id
    and coalesce(game_cards.controller_player_id, game_cards.owner_id) = auth.uid()
    and game_cards.zone = 'battlefield'
  for update of game_cards;

  if not found then
    raise exception 'Attacker card not found, not on battlefield, or not controlled by active player';
  end if;

  if coalesce(v_attacker.type_line, '') not ilike '%creature%'
     -- Animated lands (mig 277, Obuun): an active 'animated' row makes a
     -- noncreature permanent attack-capable.
     and not exists (
       select 1 from public.game_continuous_effects ce
       where ce.session_id = p_session_id and ce.effect_type = 'animated'
         and ce.affected_card_id = p_attacker_card_id
     )
  then
    raise exception 'Only creatures can be declared as attackers';
  end if;

  if v_attacker.is_tapped then
    raise exception 'Tapped creatures cannot be declared as attackers';
  end if;

  if coalesce(v_attacker.entered_battlefield_turn_number, v_turn_state.turn_number) >= v_turn_state.turn_number
    and not public.card_has_haste(p_session_id, p_attacker_card_id)
  then
    raise exception 'Creature has summoning sickness';
  end if;

  -- Defender (mig 323): a creature with defender (printed or granted) can't attack.
  if public.card_has_defender(p_session_id, p_attacker_card_id) then
    raise exception 'A creature with defender cannot attack';
  end if;

  -- Attack taxes (mig 275, Ghostly Prison / Windborn Muse / Norn's Annex):
  -- 'attack_tax' rows protecting the DEFENDER are auto-paid per attacker —
  -- payload {mana:N} deducts N generic from the attacker's pool (greedy,
  -- colourless first; raises when short), payload {life:N} pays life.
  declare
    v_tax record;
    v_tax_pool jsonb;
    v_tax_due integer;
    v_tax_col text;
    v_tax_have integer;
  begin
    for v_tax in
      select ce.payload
      from public.game_continuous_effects ce
      join public.game_cards src on src.id = ce.source_card_id and src.session_id = ce.session_id
      where ce.session_id = p_session_id
        and ce.effect_type = 'attack_tax'
        and ce.affected_player_id = v_defending_player
        and src.zone = 'battlefield'
    loop
      if coalesce((v_tax.payload ->> 'life')::integer, 0) > 0 then
        update public.game_session_players
        set life_total = life_total - (v_tax.payload ->> 'life')::integer
        where session_id = p_session_id and player_id = auth.uid();
      end if;
      v_tax_due := coalesce((v_tax.payload ->> 'mana')::integer, 0);
      if v_tax_due > 0 then
        select coalesce(mana_pool, '{}'::jsonb) into v_tax_pool
        from public.game_players
        where session_id = p_session_id and player_id = auth.uid()
        for update;
        foreach v_tax_col in array array['C','W','U','B','R','G'] loop
          exit when v_tax_due <= 0;
          v_tax_have := coalesce((v_tax_pool ->> v_tax_col)::integer, 0);
          if v_tax_have > 0 then
            v_tax_pool := v_tax_pool || jsonb_build_object(v_tax_col, v_tax_have - least(v_tax_have, v_tax_due));
            v_tax_due := v_tax_due - least(v_tax_have, v_tax_due);
          end if;
        end loop;
        if v_tax_due > 0 then
          raise exception 'Cannot pay the attack tax (% generic per attacker)', (v_tax.payload ->> 'mana');
        end if;
        update public.game_players
        set mana_pool = v_tax_pool
        where session_id = p_session_id and player_id = auth.uid();
      end if;
    end loop;
  end;

  -- Attack restriction (Gadrak: "can't attack unless you control four or more
  -- artifacts"). A top-level script prop {count, at_least}; the count is read
  -- for the attacking player (auth.uid()).
  declare
    v_restrict jsonb := public.effective_script(p_session_id, p_attacker_card_id) -> 'cant_attack_unless';
  begin
    if v_restrict is not null
       and public.resolve_count_amount(p_session_id, auth.uid(), v_restrict)
           < coalesce((v_restrict ->> 'at_least')::integer, 1)
    then
      raise exception 'This creature cannot attack: an attack condition is not met';
    end if;
  end;

  -- Pacify (mig 303, Observed Stasis): a 'cant_attack' continuous effect on the
  -- creature (e.g. from an Aura that "can't attack or block") forbids attacking.
  if exists (
    select 1 from public.game_continuous_effects ce
    join public.game_cards src on src.id = ce.source_card_id and src.session_id = ce.session_id
    where ce.session_id = p_session_id and ce.effect_type = 'cant_attack'
      and ce.affected_card_id = p_attacker_card_id and src.zone = 'battlefield'
  ) then
    raise exception 'This creature cannot attack';
  end if;

  -- Goad (mig 249): a goaded creature can't attack the player who goaded it
  -- while another opponent is available ("attacks a player other than you if
  -- able"). With only one opponent, attacking the goader is legal.
  if exists (
    select 1 from public.game_continuous_effects ce
    where ce.session_id = p_session_id and ce.effect_type = 'goaded'
      and ce.affected_card_id = p_attacker_card_id
      and nullif(ce.payload ->> 'goaded_by', '')::uuid = v_defending_player
  ) and exists (
    select 1 from public.game_session_players sp
    where sp.session_id = p_session_id
      and sp.player_id not in (auth.uid(), v_defending_player)
  ) then
    raise exception 'This creature is goaded: it must attack a player other than its goader';
  end if;

  -- Territorial Hellkite (mig 249): a must_attack marker pins THIS combat's
  -- defender to the randomly chosen opponent.
  if (select gc.counters ->> 'must_attack' from public.game_cards gc where gc.id = p_attacker_card_id)
       is not null
     and (select gc.counters ->> 'must_attack' from public.game_cards gc where gc.id = p_attacker_card_id)
       is distinct from v_defending_player::text then
    raise exception 'This creature must attack the randomly chosen player this combat';
  end if;

  -- Assignment BEFORE the tap (mig 283): becomes_tapped watchers with the
  -- not_attacking filter ("if it isn't being declared as an attacker",
  -- Rhoda / Verity Circle) check for this row at tap-trigger time.
  insert into public.game_combat_assignments (
    session_id,
    turn_number,
    attacker_card_id,
    attacking_player_id,
    defending_player_id,
    defending_planeswalker_id
  )
  values (
    p_session_id,
    v_turn_state.turn_number,
    p_attacker_card_id,
    auth.uid(),
    v_defending_player,
    p_defending_planeswalker_id
  )
  returning * into v_assignment;

  update public.game_cards
  set is_tapped = true
  where id = p_attacker_card_id
    and not public.card_has_vigilance(p_session_id, p_attacker_card_id);

  -- Remember the defender + consume the pin (mig 249, Territorial Hellkite's
  -- "an opponent that this creature didn't attack during your last combat").
  -- Only stamped for creatures whose script uses territorial_attack, so the
  -- counter bag stays clean for everything else.
  if (select gc.counters ? 'must_attack' from public.game_cards gc where gc.id = p_attacker_card_id)
     or public.effective_script(p_session_id, p_attacker_card_id)::text like '%territorial_attack%' then
    update public.game_cards
    set counters = (coalesce(counters, '{}'::jsonb) - 'must_attack')
          || jsonb_build_object('last_attacked', v_defending_player::text)
    where id = p_attacker_card_id and session_id = p_session_id;
  end if;

  -- Exert (mig 236, Glorybringer): "You may exert this creature as it attacks.
  -- When you do, <effects>." Exerting marks it (so it skips its next untap, see
  -- advance_step) and enqueues the exert effects (a targeted attack trigger).
  if p_exert then
    declare
      v_exert jsonb := public.effective_script(p_session_id, p_attacker_card_id) -> 'exert';
    begin
      if v_exert is not null and jsonb_typeof(v_exert) = 'array' then
        update public.game_cards
        set counters = public.adjust_counter_bag(coalesce(counters, '{}'::jsonb), 'exerted', 1)
        where id = p_attacker_card_id and session_id = p_session_id;
        perform public.enqueue_triggered_ability(
          p_session_id, auth.uid(), p_attacker_card_id, 'Exert', v_exert);
      end if;
    end;
  end if;

  -- Curse of Disturbance: when the defending player is attacked, each curse
  -- enchanting them makes its controller create a 2/2 black Zombie — and "each
  -- opponent attacking that player does the same" (the attacking player too).
  for v_curse in
    select ce.source_card_id, coalesce(gc.controller_player_id, gc.owner_id) as curse_controller
    from public.game_continuous_effects ce
    join public.game_cards gc on gc.id = ce.source_card_id
      and gc.session_id = p_session_id and gc.zone = 'battlefield'
    where ce.session_id = p_session_id
      and ce.effect_type = 'curse_attacked'
      and ce.affected_player_id = v_defending_player
  loop
    perform public.enqueue_triggered_ability(
      p_session_id, v_curse.curse_controller, v_curse.source_card_id,
      'Curse of Disturbance', jsonb_build_array(jsonb_build_object('type', 'create_token', 'token', 'Zombie Token')));
    if auth.uid() is distinct from v_curse.curse_controller then
      perform public.enqueue_triggered_ability(
        p_session_id, auth.uid(), v_curse.source_card_id,
        'Curse of Disturbance', jsonb_build_array(jsonb_build_object('type', 'create_token', 'token', 'Zombie Token')));
    end if;
  end loop;

  return v_assignment;
end;
$$;
grant execute on function public.declare_attacker(uuid, uuid, uuid, uuid, boolean) to authenticated;
grant execute on function public.declare_attacker(uuid, uuid, uuid, uuid, boolean) to service_role;
