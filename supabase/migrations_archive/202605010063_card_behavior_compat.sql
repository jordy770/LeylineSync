create or replace function public.get_card_behavior_schema_version(
  p_script jsonb
)
returns integer
language sql
immutable
set search_path = public
as $$
  select case
    when coalesce((p_script ->> 'schema_version')::integer, 1) = 2 then 2
    when coalesce(p_script ? 'spell_effect', false)
      or coalesce(p_script ? 'activated_abilities', false)
      or coalesce(p_script ? 'triggered_abilities', false)
      then 2
    else 1
  end;
$$;

create or replace function public.get_card_behavior_continuous_effects(
  p_script jsonb
)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select coalesce(p_script -> 'continuous_effects', '[]'::jsonb);
$$;

create or replace function public.card_behavior_has_continuous_effects(
  p_script jsonb
)
returns boolean
language sql
immutable
set search_path = public
as $$
  select jsonb_array_length(public.get_card_behavior_continuous_effects(p_script)) > 0;
$$;

create or replace function public.get_card_behavior_mana_abilities(
  p_script jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  v_version integer;
  v_actions jsonb;
  v_has_manual_tap boolean;
begin
  v_version := public.get_card_behavior_schema_version(p_script);

  if v_version = 2 then
    return coalesce(
      (
        select jsonb_agg(ability)
        from jsonb_array_elements(coalesce(p_script -> 'activated_abilities', '[]'::jsonb)) as ability
        where coalesce((ability ->> 'is_mana_ability')::boolean, false)
      ),
      '[]'::jsonb
    );
  end if;

  v_has_manual_tap := coalesce(p_script -> 'triggers', '[]'::jsonb) ? 'manual_tap';

  if not v_has_manual_tap then
    return '[]'::jsonb;
  end if;

  v_actions := coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'costs',
          jsonb_build_array(jsonb_build_object('type', 'tap_self')),
          'effects',
          jsonb_build_array(action),
          'is_mana_ability',
          true,
          'source_zone_required',
          'battlefield'
        )
      )
      from jsonb_array_elements(coalesce(p_script -> 'actions', '[]'::jsonb)) as action
      where action ->> 'type' = 'add_mana'
        and action ? 'color'
        and action ? 'amount'
    ),
    '[]'::jsonb
  );

  return v_actions;
end;
$$;

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
    from jsonb_array_elements(public.get_card_behavior_continuous_effects(v_script))
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
      'double_strike'
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
          'double_strike'
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
      when 'haste' then 'haste'
      when 'vigilance' then 'vigilance'
      when 'indestructible' then 'indestructible'
      when 'trample' then 'trample'
      when 'first_strike' then 'first_strike'
      when 'double_strike' then 'double_strike'
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

create or replace function public.rebuild_scripted_continuous_effects(
  p_session_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card record;
  v_registered_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  delete from public.game_continuous_effects
  where session_id = p_session_id
    and payload ->> 'registered_from_card_script' = 'true';

  for v_card in
    select game_cards.id
    from public.game_cards
    left join public.cards
      on cards.id = game_cards.card_id
    where game_cards.session_id = p_session_id
      and game_cards.zone = 'battlefield'
      and game_cards.static_effects_suppressed = false
      and (
        public.card_behavior_has_continuous_effects(coalesce(game_cards.copied_script, '{}'::jsonb))
        or public.card_behavior_has_continuous_effects(coalesce(cards.script, '{}'::jsonb))
        or jsonb_array_length(coalesce(cards.keywords, '[]'::jsonb)) > 0
      )
  loop
    v_registered_count := v_registered_count
      + public.register_card_continuous_effects(p_session_id, v_card.id);
  end loop;

  return v_registered_count;
end;
$$;

grant execute on function public.get_card_behavior_schema_version(jsonb) to authenticated;
grant execute on function public.get_card_behavior_continuous_effects(jsonb) to authenticated;
grant execute on function public.card_behavior_has_continuous_effects(jsonb) to authenticated;
grant execute on function public.get_card_behavior_mana_abilities(jsonb) to authenticated;
grant execute on function public.register_card_continuous_effects(uuid, uuid) to authenticated;
grant execute on function public.rebuild_scripted_continuous_effects(uuid) to authenticated;
