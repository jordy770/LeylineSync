-- 202605010368_commander_anthem
-- Dancer's Chakrams: "Other commanders you control get +2/+2 and have lifelink."
-- That clause is an ability GRANTED to the equipped creature, so it is active
-- only while a creature is equipped. Implementation:
--   • register_card_continuous_effects: skip a commander_only effect when the
--     Equipment is unattached (no creature equipped → no granted ability).
--   • card_layered_power/toughness + card_has_lifelink: a `commander_only`
--     payload predicate limits the anthem to commanders the source's controller
--     controls, excluding the equipped creature itself (the "other").
-- The script registers these as affected:'controller' pump + lifelink rows with
-- payload.commander_only=true (see docs/commander-decks/card-scripts.json).
-- Generated from supabase/functions_src (register_card_continuous_effects, card_layered_power, card_layered_toughness, card_has_lifelink) — those files are
-- the canonical current definitions; edit them, not past migrations.

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
      'cant_block'
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

create or replace function public.card_layered_power(p_session_id uuid, p_game_card_id uuid)
returns integer
language sql security definer set search_path = public
as $$
  select
    coalesce(
      (select (e.payload ->> 'power')::integer
       from public.game_continuous_effects e
       left join public.game_cards sc on sc.id = e.source_card_id
       where e.session_id = p_session_id
         and e.effect_type = 'set_pt'
         and e.affected_card_id = p_game_card_id
         and (e.source_zone_required is null or sc.zone = e.source_zone_required)
       order by e.created_at desc, e.id desc
       limit 1),
      public.card_cda_value(p_session_id, p_game_card_id, 'power'),
      cards.power,
      case
        when cards.power_toughness ~ '^[0-9]+/[0-9]+$'
          then split_part(cards.power_toughness, '/', 1)::integer
        else 0
      end,
      0
    )
    + coalesce(game_cards.plus_one_counters, 0)
    - coalesce((game_cards.counters ->> 'minus_one_one')::integer, 0)
    + coalesce((
        select sum(coalesce((effects.payload ->> 'power')::integer, 0))
        from public.game_continuous_effects effects
        left join public.game_cards source_card
          on source_card.id = effects.source_card_id
        where effects.session_id = p_session_id
          and effects.effect_type = 'pump'
          and effects.affected_card_id = p_game_card_id
          and (effects.source_zone_required is null or source_card.zone = effects.source_zone_required)
      ), 0)
    + coalesce((
        select sum(coalesce((effects.payload ->> 'power')::integer, 0))
        from public.game_continuous_effects effects
        left join public.game_cards source_card
          on source_card.id = effects.source_card_id
        where effects.session_id = p_session_id
          and effects.effect_type = 'pump'
          and effects.affected_card_id is null
          and (effects.affected_player_id is null
               or effects.affected_player_id = coalesce(game_cards.controller_player_id, game_cards.owner_id))
          and (effects.source_zone_required is null or source_card.zone = effects.source_zone_required)
          and cards.type_line ilike '%creature%'
          and (effects.payload ->> 'creature_type' is null
               or case when coalesce((effects.payload ->> 'exclude_type')::boolean, false)
                    then cards.type_line not ilike '%' || (effects.payload ->> 'creature_type') || '%'
                    else cards.type_line ilike '%' || (effects.payload ->> 'creature_type') || '%'
                  end)
          and (coalesce((effects.payload ->> 'exclude_source')::boolean, false) = false
               or game_cards.id <> effects.source_card_id)
          -- Commander-only anthem (Dancer's Chakrams: "other commanders you
          -- control get +2/+2"). Limits the pump to commanders the source's
          -- controller controls, excluding the equipped creature ("other").
          and (effects.payload ->> 'commander_only' is null
               or (game_cards.is_commander
                   and game_cards.id is distinct from source_card.attached_to))
          -- Colour-filtered anthem (mig 209, Heraldic Banner): only creatures
          -- of the payload colour get the pump.
          -- Conditional anthem (mig 269, Jor Kadeen metalcraft: '+3/+0 as long
          -- as you control three or more artifacts'). Read-time gate against
          -- the SOURCE's controller.
          and (effects.payload ->> 'condition_count' is null
               or public.resolve_count_amount(p_session_id,
                    coalesce(source_card.controller_player_id, source_card.owner_id),
                    jsonb_build_object('count', effects.payload ->> 'condition_count'),
                    effects.source_card_id)
                  >= coalesce((effects.payload ->> 'condition_at_least')::integer, 1))
          -- Conditional anthem on the source controller's library top card colour
          -- (Vampire Nocturnus, mig 342: "as long as the top card is black").
          and (effects.payload ->> 'condition_top_card_color' is null
               or public.library_top_is_color(p_session_id,
                    coalesce(source_card.controller_player_id, source_card.owner_id),
                    effects.payload ->> 'condition_top_card_color'))
          and (effects.payload ->> 'color' is null
               or public.card_color_set(cards.mana_cost) @> array[lower(effects.payload ->> 'color')])
      ), 0)

    + coalesce((
        -- Dynamic pump (mig 267, Cranial Plating / Bonehoard): payload
        -- power_count names a count resolved against the SOURCE's controller
        -- at read time (artifacts_you_control, creature_cards_all_graveyards).
        select sum(public.resolve_count_amount(
                 p_session_id,
                 coalesce(source_card.controller_player_id, source_card.owner_id),
                 jsonb_build_object('count', effects.payload ->> 'power_count'),
                 effects.source_card_id))
        from public.game_continuous_effects effects
        left join public.game_cards source_card
          on source_card.id = effects.source_card_id
        where effects.session_id = p_session_id
          and effects.effect_type = 'pump'
          and effects.affected_card_id = p_game_card_id
          and effects.payload ? 'power_count'
          and (effects.source_zone_required is null or source_card.zone = effects.source_zone_required)
      ), 0)
  from public.game_cards
  join public.cards on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id;
$$;
grant execute on function public.card_layered_power(uuid, uuid) to authenticated;
grant execute on function public.card_layered_power(uuid, uuid) to service_role;

create or replace function public.card_layered_toughness(p_session_id uuid, p_game_card_id uuid)
returns integer
language sql security definer set search_path = public
as $$
  select
    coalesce(
      (select (e.payload ->> 'toughness')::integer
       from public.game_continuous_effects e
       left join public.game_cards sc on sc.id = e.source_card_id
       where e.session_id = p_session_id
         and e.effect_type = 'set_pt'
         and e.affected_card_id = p_game_card_id
         and (e.source_zone_required is null or sc.zone = e.source_zone_required)
       order by e.created_at desc, e.id desc
       limit 1),
      public.card_cda_value(p_session_id, p_game_card_id, 'toughness'),
      cards.toughness,
      case
        when cards.power_toughness ~ '^[0-9]+/[0-9]+$'
          then split_part(cards.power_toughness, '/', 2)::integer
        else 0
      end,
      0
    )
    + coalesce(game_cards.plus_one_counters, 0)
    - coalesce((game_cards.counters ->> 'minus_one_one')::integer, 0)
    + coalesce((
        select sum(coalesce((effects.payload ->> 'toughness')::integer, 0))
        from public.game_continuous_effects effects
        left join public.game_cards source_card
          on source_card.id = effects.source_card_id
        where effects.session_id = p_session_id
          and effects.effect_type = 'pump'
          and effects.affected_card_id = p_game_card_id
          and (effects.source_zone_required is null or source_card.zone = effects.source_zone_required)
      ), 0)
    + coalesce((
        select sum(coalesce((effects.payload ->> 'toughness')::integer, 0))
        from public.game_continuous_effects effects
        left join public.game_cards source_card
          on source_card.id = effects.source_card_id
        where effects.session_id = p_session_id
          and effects.effect_type = 'pump'
          and effects.affected_card_id is null
          and (effects.affected_player_id is null
               or effects.affected_player_id = coalesce(game_cards.controller_player_id, game_cards.owner_id))
          and (effects.source_zone_required is null or source_card.zone = effects.source_zone_required)
          and cards.type_line ilike '%creature%'
          and (effects.payload ->> 'creature_type' is null
               or case when coalesce((effects.payload ->> 'exclude_type')::boolean, false)
                    then cards.type_line not ilike '%' || (effects.payload ->> 'creature_type') || '%'
                    else cards.type_line ilike '%' || (effects.payload ->> 'creature_type') || '%'
                  end)
          and (coalesce((effects.payload ->> 'exclude_source')::boolean, false) = false
               or game_cards.id <> effects.source_card_id)
          -- Commander-only anthem (Dancer's Chakrams: "other commanders you
          -- control get +2/+2"). Limits the pump to commanders the source's
          -- controller controls, excluding the equipped creature ("other").
          and (effects.payload ->> 'commander_only' is null
               or (game_cards.is_commander
                   and game_cards.id is distinct from source_card.attached_to))
          -- Colour-filtered anthem (mig 209, Heraldic Banner): only creatures
          -- of the payload colour get the pump.
          -- Conditional anthem (mig 269, Jor Kadeen metalcraft: '+3/+0 as long
          -- as you control three or more artifacts'). Read-time gate against
          -- the SOURCE's controller.
          and (effects.payload ->> 'condition_count' is null
               or public.resolve_count_amount(p_session_id,
                    coalesce(source_card.controller_player_id, source_card.owner_id),
                    jsonb_build_object('count', effects.payload ->> 'condition_count'),
                    effects.source_card_id)
                  >= coalesce((effects.payload ->> 'condition_at_least')::integer, 1))
          -- Conditional anthem on the source controller's library top card colour
          -- (Vampire Nocturnus, mig 342: "as long as the top card is black").
          and (effects.payload ->> 'condition_top_card_color' is null
               or public.library_top_is_color(p_session_id,
                    coalesce(source_card.controller_player_id, source_card.owner_id),
                    effects.payload ->> 'condition_top_card_color'))
          and (effects.payload ->> 'color' is null
               or public.card_color_set(cards.mana_cost) @> array[lower(effects.payload ->> 'color')])
      ), 0)

    + coalesce((
        -- Dynamic pump (mig 267, Cranial Plating / Bonehoard): payload
        -- toughness_count names a count resolved against the SOURCE's controller
        -- at read time (artifacts_you_control, creature_cards_all_graveyards).
        select sum(public.resolve_count_amount(
                 p_session_id,
                 coalesce(source_card.controller_player_id, source_card.owner_id),
                 jsonb_build_object('count', effects.payload ->> 'toughness_count'),
                 effects.source_card_id))
        from public.game_continuous_effects effects
        left join public.game_cards source_card
          on source_card.id = effects.source_card_id
        where effects.session_id = p_session_id
          and effects.effect_type = 'pump'
          and effects.affected_card_id = p_game_card_id
          and effects.payload ? 'toughness_count'
          and (effects.source_zone_required is null or source_card.zone = effects.source_zone_required)
      ), 0)
  from public.game_cards
  join public.cards on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id;
$$;
grant execute on function public.card_layered_toughness(uuid, uuid) to authenticated;
grant execute on function public.card_layered_toughness(uuid, uuid) to service_role;

create or replace function public.card_has_lifelink(p_session_id uuid, p_game_card_id uuid)
returns boolean language sql security definer set search_path = public as $$
  select exists (
    select 1
    from public.game_continuous_effects effects
    left join public.game_cards source_card on source_card.id = effects.source_card_id
    left join public.game_cards tc on tc.id = p_game_card_id
    left join public.cards tcard on tcard.id = tc.card_id
    where effects.session_id = p_session_id
      and effects.effect_type = 'lifelink'
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
          -- Commander-only anthem (Dancer's Chakrams: "other commanders you
          -- control ... have lifelink"); excludes the equipped creature ("other").
          and (effects.payload ->> 'commander_only' is null
               or (tc.is_commander
                   and tc.id is distinct from source_card.attached_to))
        )
      )
      and (effects.source_zone_required is null or source_card.zone = effects.source_zone_required)
  );
$$;
grant execute on function public.card_has_lifelink(uuid, uuid) to authenticated;
grant execute on function public.card_has_lifelink(uuid, uuid) to service_role;
