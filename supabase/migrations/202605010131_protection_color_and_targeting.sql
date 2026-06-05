-- F3 — Protection (DEBT), slice 1: colour model + the "can't be Targeted" (T) gate.
--
-- The engine has no colour column on `cards`. A card's colour identity is derived
-- on demand from its `mana_cost` (the W/U/B/R/G symbols) via the immutable helper
-- card_color_set(text) — no schema change. Protection itself is a continuous effect
-- (effect_type 'protection') carrying its colour in payload.from, registered from a
-- card script's continuous_effects exactly like the keyword effects (e.g. flying).
--
-- This slice wires the T gate only: a creature with protection from a spell/ability
-- source's colour can't be chosen as its target. The D (damage) and B (block) gates
-- land in later slices. Reproduced functions are lifted from their CURRENT defs
-- (put_action_on_stack mig 109, register_card_continuous_effects + the keyword
-- accessors baseline, choose_triggered_ability_creature_target mig 114) — never the
-- stale baseline-only forms (see bug-281/283).

-- ---------------------------------------------------------------------------
-- 1. Colour set derived from a mana cost. Each colour symbol (incl. hybrid {2/W},
-- {W/U} and Phyrexian {U/P}) contributes its colour; generic/colourless/{X}/{S}
-- contribute none. Immutable: depends only on the text. Vocabulary = full colour
-- words so it lines up with a protection effect's payload.from.
-- ---------------------------------------------------------------------------
create or replace function public.card_color_set(p_mana_cost text)
returns text[]
language sql
immutable
set search_path = public
as $$
  select coalesce(array_remove(array[
    case when upper(coalesce(p_mana_cost, '')) like '%W%' then 'white' end,
    case when upper(coalesce(p_mana_cost, '')) like '%U%' then 'blue'  end,
    case when upper(coalesce(p_mana_cost, '')) like '%B%' then 'black' end,
    case when upper(coalesce(p_mana_cost, '')) like '%R%' then 'red'   end,
    case when upper(coalesce(p_mana_cost, '')) like '%G%' then 'green' end
  ], null), array[]::text[]);
$$;

-- ---------------------------------------------------------------------------
-- 2. Allow the new 'protection' effect_type. CURRENT list = baseline + 'control'
-- (mig 106) + 'set_pt' (mig 128); append 'protection' (bug-283: never drop the
-- earlier additions by rebuilding from the stale baseline list).
-- ---------------------------------------------------------------------------
alter table public.game_continuous_effects
  drop constraint if exists game_continuous_effects_effect_type_check;
alter table public.game_continuous_effects
  add constraint game_continuous_effects_effect_type_check
  check (effect_type = any (array[
    'mana_does_not_empty', 'additional_land_plays', 'haste', 'vigilance',
    'indestructible', 'trample', 'first_strike', 'double_strike', 'flying',
    'reach', 'deathtouch', 'pump', 'control', 'set_pt', 'protection'
  ]));

-- ---------------------------------------------------------------------------
-- 3. Accessors. card_has_protection_from_color mirrors the keyword accessors
-- (card_has_flying et al.): a 'protection' effect affecting the card (or all)
-- whose source is in its required zone, matched on payload.from. The _from_any
-- wrapper folds over a colour set so callers can pass a spell's whole colour set.
-- ---------------------------------------------------------------------------
create or replace function public.card_has_protection_from_color(
  p_session_id uuid, p_game_card_id uuid, p_color text
) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.game_continuous_effects effects
    left join public.game_cards source_card
      on source_card.id = effects.source_card_id
    where effects.session_id = p_session_id
      and effects.effect_type = 'protection'
      and public.is_session_player(p_session_id, auth.uid())
      and (
        effects.affected_card_id = p_game_card_id
        or effects.affected_card_id is null
      )
      and lower(effects.payload ->> 'from') = lower(p_color)
      and (
        effects.source_zone_required is null
        or source_card.zone = effects.source_zone_required
      )
  );
$$;

create or replace function public.card_has_protection_from_any(
  p_session_id uuid, p_game_card_id uuid, p_colors text[]
) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from unnest(coalesce(p_colors, array[]::text[])) as color
    where p_game_card_id is not null
      and public.card_has_protection_from_color(p_session_id, p_game_card_id, color)
  );
$$;

grant execute on function public.card_color_set(text) to anon, authenticated, service_role;
grant execute on function public.card_has_protection_from_color(uuid, uuid, text) to anon, authenticated, service_role;
grant execute on function public.card_has_protection_from_any(uuid, uuid, text[]) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. register_card_continuous_effects — recognise a 'protection' continuous
-- effect authored in a card script. Verbatim from baseline except: 'protection'
-- added to the supported-type list, to the affected-default 'source' group, and a
-- payload branch storing {from: <colour>}. (The Scryfall-keyword loop is untouched:
-- bare "Protection" carries no colour, so protection is script-authored only.)
-- ---------------------------------------------------------------------------
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
      'protection'
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
          'protection'
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
    elsif v_effect_type = 'protection' then
      v_payload := jsonb_build_object(
        'from',
        lower(coalesce(v_effect ->> 'from', v_effect ->> 'color'))
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

-- ---------------------------------------------------------------------------
-- 5. put_action_on_stack (mig 109) — T gate for the spell/activated path. Verbatim
-- from mig 109 except the one protection block after the builder runs: the built
-- payload's target_card_id (when present) can't be a creature with protection from
-- any of the source's colours. Checked BEFORE mana is paid, so an illegal target
-- fizzles the announcement without cost. A sourceless/colourless source gates none.
-- ---------------------------------------------------------------------------
create or replace function public.put_action_on_stack(
  p_session_id uuid,
  p_action_type text,
  p_payload jsonb,
  p_source_card_id uuid default null
)
returns public.game_stack_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_action_timing text;
  v_target_controller text;
  v_source_type_line text;
  v_source_zone text;
  v_source_mana_cost text;
  v_generic_payment jsonb;
  v_x_value integer;
  v_pending_stack_count integer;
  v_next_graveyard_position integer;
  v_next_position integer;
  v_builder_fn text;
  v_built_payload jsonb;
  v_stack_item public.game_stack_items;
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
    raise exception 'Cannot put actions on the stack in a finished game session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can put actions on the stack';
  end if;

  select builder_fn
  into v_builder_fn
  from public.stack_action_handlers
  where action_type = p_action_type;

  if v_builder_fn is null then
    raise exception 'Unsupported stack action type: %', p_action_type;
  end if;

  if p_source_card_id is not null then
    select cards.type_line, cards.mana_cost, game_cards.zone
    into v_source_type_line, v_source_mana_cost, v_source_zone
    from public.game_cards
    join public.cards
      on cards.id = game_cards.card_id
    where game_cards.id = p_source_card_id
      and game_cards.session_id = p_session_id
      and game_cards.owner_id = auth.uid();

    if not found then
      raise exception 'Source card not found or not owned by current user';
    end if;
  end if;

  v_action_timing := lower(nullif(p_payload ->> 'timing', ''));

  if v_action_timing is null then
    if v_source_type_line ilike '%instant%' then
      v_action_timing := 'instant';
    elsif v_source_type_line ilike '%sorcery%' then
      v_action_timing := 'sorcery';
    else
      raise exception 'Action timing is required for non-Instant and non-Sorcery sources';
    end if;
  end if;

  if v_action_timing not in ('instant', 'sorcery') then
    raise exception 'Unsupported action timing: %', v_action_timing;
  end if;

  if p_action_type = 'counter_spell' and v_action_timing <> 'instant' then
    raise exception 'Counterspell actions must use instant timing';
  end if;

  if v_action_timing = 'sorcery' then
    if v_turn_state.active_player_id <> auth.uid() then
      raise exception 'Sorcery actions can only be used by the active player';
    end if;

    if v_turn_state.step not in ('precombat_main', 'postcombat_main') then
      raise exception 'Sorcery actions can only be used during a main phase';
    end if;

    select count(*)
    into v_pending_stack_count
    from public.game_stack_items
    where session_id = p_session_id
      and status = 'pending';

    if v_pending_stack_count > 0 then
      raise exception 'Sorcery actions can only be used while the stack is empty';
    end if;
  end if;

  v_generic_payment := p_payload -> 'generic_payment';
  v_x_value := coalesce((p_payload ->> 'x_value')::integer, 0);
  v_target_controller := coalesce(lower(nullif(p_payload ->> 'target_controller', '')), 'any');

  execute format('select public.%I($1, $2, $3, $4, $5)', v_builder_fn)
    into v_built_payload
    using p_session_id, auth.uid(), p_payload, v_action_timing, v_target_controller;

  -- Protection (CR 702.16e): a creature with protection from any of the source's
  -- colours can't be targeted. The target rode through the builder as target_card_id.
  if v_built_payload ? 'target_card_id'
     and public.card_has_protection_from_any(
           p_session_id,
           nullif(v_built_payload ->> 'target_card_id', '')::uuid,
           public.card_color_set(v_source_mana_cost))
  then
    raise exception 'Target has protection from this spell''s colour';
  end if;

  if p_source_card_id is not null and v_source_zone = 'hand' then
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_source_mana_cost, v_generic_payment, v_x_value);
  end if;

  select coalesce(max(position), -1) + 1
  into v_next_position
  from public.game_stack_items
  where session_id = p_session_id;

  insert into public.game_stack_items (
    session_id,
    controller_player_id,
    source_card_id,
    action_type,
    payload,
    position
  )
  values (
    p_session_id,
    auth.uid(),
    p_source_card_id,
    p_action_type,
    v_built_payload,
    v_next_position
  )
  returning * into v_stack_item;

  if p_source_card_id is not null
    and v_source_zone = 'hand'
    and (
      v_source_type_line ilike '%instant%'
      or v_source_type_line ilike '%sorcery%'
    )
  then
    select coalesce(max(zone_position), -1) + 1
    into v_next_graveyard_position
    from public.game_cards
    where session_id = p_session_id
      and owner_id = auth.uid()
      and zone = 'graveyard';

    update public.game_cards
    set
      zone = 'graveyard',
      zone_position = v_next_graveyard_position,
      is_tapped = false,
      damage_marked = 0
    where id = p_source_card_id;
  end if;

  return v_stack_item;
end;
$$;

grant execute on function public.put_action_on_stack(uuid, text, jsonb, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. choose_triggered_ability_creature_target (mig 114) — T gate for the trigger
-- path. Verbatim from mig 114 except the protection block after the controller/
-- permanent legality check: the chosen target can't have protection from any of
-- the TRIGGER SOURCE's colours (derived from that card's mana cost).
-- ---------------------------------------------------------------------------
create or replace function public.choose_triggered_ability_creature_target(
  p_session_id uuid, p_stack_item_id uuid, p_target_card_id uuid
) returns public.game_stack_items
language plpgsql security definer set search_path = public
as $$
declare
  v_stack_item public.game_stack_items;
  v_target_type jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select *
  into v_stack_item
  from public.game_stack_items
  where id = p_stack_item_id and session_id = p_session_id and status = 'pending'
  for update;

  if not found then
    raise exception 'Triggered ability stack item not found';
  end if;

  if v_stack_item.action_type <> 'triggered_ability'
    or coalesce((v_stack_item.payload ->> 'target_required')::boolean, false) is not true
  then
    raise exception 'Stack item does not require a trigger target';
  end if;

  if v_stack_item.controller_player_id <> auth.uid() then
    raise exception 'Only the trigger controller can choose its target';
  end if;

  v_target_type := v_stack_item.payload -> 'target_type';

  if v_target_type is null or public.behavior_target_type_is_creature_only(v_target_type) then
    if not public.creature_target_controller_ok(
      p_session_id, p_target_card_id, v_stack_item.controller_player_id,
      coalesce(v_stack_item.payload ->> 'target_controller', 'any')
    ) then
      raise exception 'Target is not a legal creature for this ability';
    end if;
  else
    if not public.permanent_target_controller_ok(
      p_session_id, p_target_card_id, v_stack_item.controller_player_id,
      coalesce(v_stack_item.payload ->> 'target_controller', 'any'), v_target_type
    ) then
      raise exception 'Target is not a legal permanent for this ability';
    end if;
  end if;

  -- Protection: the chosen target can't have protection from the trigger source's
  -- colour(s). The source card's mana cost gives its colours.
  if public.card_has_protection_from_any(
       p_session_id, p_target_card_id,
       public.card_color_set((
         select c.mana_cost
         from public.game_cards gc
         join public.cards c on c.id = gc.card_id
         where gc.id = v_stack_item.source_card_id
       ))) then
    raise exception 'Target has protection from this ability''s colour';
  end if;

  update public.game_stack_items
  set payload = payload || jsonb_build_object('target_card_id', p_target_card_id, 'target_chosen', true)
  where id = v_stack_item.id
  returning * into v_stack_item;

  return v_stack_item;
end;
$$;

grant execute on function public.choose_triggered_ability_creature_target(uuid, uuid, uuid) to authenticated;
