-- 202605010406_dies_replacement
-- TODO: describe the change.
-- Generated from supabase/functions_src (put_in_graveyard, register_card_continuous_effects) — those files are
-- the canonical current definitions; edit them, not past migrations.

-- 'dies_replacement' joins the continuous-effect CHECK list (rebuilt from the
-- mig 398 definition + the new value — bug-283 rule: never from the baseline).
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
    'cant_attack', 'cant_block', 'defender', 'fear', 'granted_dies_effect', 'granted_ability',
    'unblockable', 'flash_permission', 'dies_replacement'
  ]));

create or replace function public.put_in_graveyard(p_session_id uuid, p_game_card_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_controller_id uuid;
  v_is_creature boolean;
  v_is_token boolean;
  v_turn integer;
  v_next_graveyard_position integer;
  v_had_counters integer;
  v_undying boolean := false;
  v_next_bf_position integer;
  v_rider record;
  v_rider_payloads jsonb := '[]'::jsonb;
  v_repl record;
  v_next_exile_position integer;
begin
  select g.owner_id, coalesce(g.controller_player_id, g.owner_id), (c.type_line ilike '%creature%'),
         -- Token at either level: catalog tokens (cards.is_token) or copy
         -- tokens (game_cards.is_token, mig 239).
         coalesce(c.is_token, false) or coalesce(g.is_token, false), coalesce(g.plus_one_counters, 0)
  into v_owner_id, v_controller_id, v_is_creature, v_is_token, v_had_counters
  from public.game_cards g
  join public.cards c on c.id = g.card_id
  where g.id = p_game_card_id
    and g.session_id = p_session_id
    and g.zone = 'battlefield';

  if not found then
    return false;
  end if;

  -- Death replacement (mig 406, Kalitas, Traitor of Ghet): "Whenever a nontoken
  -- creature an opponent controls would die, exile it instead. If you do, create
  -- a 2/2 black Zombie." A 'dies_replacement' continuous effect on a battlefield
  -- source intercepts the death HERE (put_in_graveyard is THE chokepoint —
  -- combat SBA, destroy, sacrifice and dies all funnel through it, mig 084).
  -- The creature is EXILED, so it never dies: no dies-triggers and no death
  -- tally fire. First applicable replacement wins.
  if v_is_creature then
    for v_repl in
      select ce.source_card_id, ce.payload,
             coalesce(src.controller_player_id, src.owner_id) as repl_controller
      from public.game_continuous_effects ce
      join public.game_cards src on src.id = ce.source_card_id and src.session_id = ce.session_id
      where ce.session_id = p_session_id
        and ce.effect_type = 'dies_replacement'
        and src.zone = 'battlefield'
      order by ce.id
    loop
      -- scope 'opponent' (default): the dying creature's controller must be an
      -- opponent of the replacement's controller. nontoken:true skips tokens.
      continue when lower(coalesce(v_repl.payload ->> 'scope', 'opponent')) = 'opponent'
                    and v_controller_id is not distinct from v_repl.repl_controller;
      continue when coalesce((v_repl.payload ->> 'nontoken')::boolean, true) and v_is_token;

      -- Exile instead of dying. The zone-change trigger fires leaves-the-
      -- battlefield (correct — it did leave), but NOT the dies block (that keys
      -- on NEW.zone = 'graveyard').
      delete from public.game_continuous_effects
      where session_id = p_session_id and effect_type = 'granted_dies_effect'
        and affected_card_id = p_game_card_id;
      select coalesce(max(zone_position), -1) + 1 into v_next_exile_position
      from public.game_cards
      where session_id = p_session_id and owner_id = v_owner_id and zone = 'exile';
      update public.game_cards
      set zone = 'exile', zone_position = v_next_exile_position, controller_player_id = owner_id,
          is_tapped = false, damage_marked = 0, dealt_deathtouch_damage = false, plus_one_counters = 0
      where id = p_game_card_id;

      -- Rider: the replacement's controller creates the token (Kalitas's Zombie).
      if nullif(v_repl.payload ->> 'create_token', '') is not null then
        perform public.apply_triggered_ability_effects(
          p_session_id, v_repl.repl_controller, v_repl.source_card_id,
          jsonb_build_array(jsonb_build_object(
            'type', 'create_token',
            'token', v_repl.payload ->> 'create_token',
            'count', coalesce((v_repl.payload ->> 'token_count')::integer, 1))));
      end if;

      return true;
    end loop;
  end if;

  -- Undying (mig 219, Geralf's Mindcrusher): "When this creature dies, if it
  -- had no +1/+1 counters on it, return it under its owner's control with a
  -- +1/+1 counter." Captured BEFORE the move (the move resets counters).
  if v_is_creature and v_had_counters = 0 then
    v_undying := coalesce(
      (public.effective_script(p_session_id, p_game_card_id) ->> 'undying')::boolean, false);
  end if;

  select coalesce(max(zone_position), -1) + 1
  into v_next_graveyard_position
  from public.game_cards
  where session_id = p_session_id
    and owner_id = v_owner_id
    and zone = 'graveyard';

  -- Granted dies-trigger (Clavileño / Jaxis / Feign Death, migs 344-349): a
  -- creature given "when this dies, <effects>" carries a granted_dies_effect.
  -- CAPTURE the payloads BEFORE the zone move — a TOKEN's cease trigger fires on
  -- that move and would delete the rows (and the token) first. Consume them too.
  if v_is_creature then
    select coalesce(jsonb_agg(payload), '[]'::jsonb) into v_rider_payloads
    from public.game_continuous_effects
    where session_id = p_session_id and effect_type = 'granted_dies_effect'
      and affected_card_id = p_game_card_id;
    delete from public.game_continuous_effects
    where session_id = p_session_id and effect_type = 'granted_dies_effect'
      and affected_card_id = p_game_card_id;
  end if;

  update public.game_cards
  set
    zone = 'graveyard',
    zone_position = v_next_graveyard_position,
    controller_player_id = owner_id,
    is_tapped = false,
    damage_marked = 0,
    dealt_deathtouch_damage = false,
    plus_one_counters = 0
  where id = p_game_card_id;

  -- Fire the captured dies-triggers AFTER the move so a return_self_to_battlefield
  -- effect finds the card in its graveyard. (For tokens the card has already
  -- ceased, but the effects — draw, make a token — are player-level.)
  for v_rider in select value as payload from jsonb_array_elements(v_rider_payloads)
  loop
    perform public.apply_triggered_ability_effects(
      p_session_id, v_controller_id, p_game_card_id,
      coalesce(v_rider.payload -> 'effects', '[]'::jsonb));
  end loop;

  -- Tally "creatures that died under your control this turn" (turn-stamped: the
  -- count belongs to the stored turn, so it reads as 0 once the turn changes).
  if v_is_creature and v_controller_id is not null then
    select turn_number into v_turn from public.game_turn_state where session_id = p_session_id;
    update public.game_session_players
    set turn_creatures_died = case when turn_creatures_died_turn = coalesce(v_turn, 0)
                                   then turn_creatures_died + 1 else 1 end,
        turn_creatures_died_turn = coalesce(v_turn, 0),
        -- Nontoken-only tally (Gadrak): summed game-wide by resolve_count_amount.
        turn_nontoken_creatures_died = case
          when not v_is_token then
            case when turn_nontoken_creatures_died_turn = coalesce(v_turn, 0)
                 then turn_nontoken_creatures_died + 1 else 1 end
          when turn_nontoken_creatures_died_turn = coalesce(v_turn, 0)
            then turn_nontoken_creatures_died else 0 end,
        turn_nontoken_creatures_died_turn = case
          when not v_is_token then coalesce(v_turn, 0)
          else turn_nontoken_creatures_died_turn end
    where session_id = p_session_id and player_id = v_controller_id;
  end if;

  -- Undying return: AFTER the graveyard move (so dies triggers and the death
  -- tally fired normally), bring the card back under its OWNER's control with
  -- one +1/+1 counter. It then has a counter, so dying again stays dead.
  if v_undying then
    select turn_number into v_turn from public.game_turn_state where session_id = p_session_id;
    select coalesce(max(zone_position), -1) + 1
    into v_next_bf_position
    from public.game_cards
    where session_id = p_session_id and owner_id = v_owner_id and zone = 'battlefield';

    update public.game_cards
    set zone = 'battlefield',
        zone_position = v_next_bf_position,
        controller_player_id = owner_id,
        is_tapped = false,
        plus_one_counters = 1,
        entered_battlefield_turn_number = coalesce(v_turn, 0)
    where id = p_game_card_id and session_id = p_session_id;
  end if;

  return true;
end;
$$;

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
      -- Granted ability (mig 357, Blade of Selves / Splinter Twin / Mirage Phalanx):
      -- payload {kind, ability}; effective_script merges it onto the affected card.
      'granted_ability',
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
      'cant_block',
      -- STATIC "you may cast <filter> spells as though they had flash"
      -- (mig 398, Shimmer Myr): payload {type_line}; card_has_flash consumes it
      -- for the caster (affected:'controller').
      'flash_permission',
      -- DEATH REPLACEMENT (mig 406, Kalitas): "a nontoken creature an opponent
      -- controls would die → exile it instead; you create a token." payload
      -- {scope, nontoken, exile, create_token}; put_in_graveyard consumes it.
      'dies_replacement'
    ) then
      raise exception 'Unsupported continuous effect type: %', v_effect_type;
    end if;

    -- commander_only anthem (Dancer's Chakrams): the "other commanders you
    -- control" buff is an ability GRANTED to the equipped creature, so it exists
    -- only while a creature is equipped. Skip it when this Equipment is unattached.
    if coalesce((v_effect -> 'payload' ->> 'commander_only')::boolean, false)
       and v_source_card.attached_to is null then
      continue;
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
      -- Printed lifelink (mig 386): grants and scripts worked since mig 283,
      -- but this loop never mapped the catalog keyword — vanilla lifelink
      -- creatures gained no life.
      when 'lifelink'      then 'lifelink'
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
