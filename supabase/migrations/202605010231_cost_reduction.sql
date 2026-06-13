-- 202605010231_cost_reduction — generic-mana cost reduction.
--   • reduced_mana_cost(session, caster, card, cost): reduces the generic portion
--     of a printed cost by all reductions that apply to the caster — the card's
--     own `cost_reduction` script prop (Draconic Lore self-reduction) plus
--     `cost_reduction` continuous effects the caster controls (Dragonlord's
--     Servant / Sarkhan: "Dragon spells you cast cost {1} less").
--   • register_card_continuous_effects accepts the static `cost_reduction` type.
--   • cast_card_from_hand (permanents) and cast_spell_effect (instant/sorcery)
--     pay the reduced cost. Spells auto-pay generic, so no client change there;
--     the permanent path reduces the required generic (client cost display TBD).
-- Generated from supabase/functions_src (reduced_mana_cost,
-- register_card_continuous_effects, cast_card_from_hand, cast_spell_effect).

-- cost_reduction joins the allowed continuous-effect types (latest list mig 230).
alter table public.game_continuous_effects
  drop constraint if exists game_continuous_effects_effect_type_check;
alter table public.game_continuous_effects
  add constraint game_continuous_effects_effect_type_check
  check (effect_type = any (array[
    'mana_does_not_empty', 'additional_land_plays', 'haste', 'vigilance',
    'indestructible', 'trample', 'first_strike', 'double_strike', 'flying',
    'reach', 'deathtouch', 'pump', 'control', 'set_pt', 'protection', 'switch_pt',
    'infect', 'wither', 'toxic', 'cast_from_graveyard', 'menace',
    'intimidate', 'hexproof', 'curse_attacked', 'play_from_exile', 'cost_reduction'
  ]));

create or replace function public.reduced_mana_cost(
  p_session_id uuid,
  p_caster uuid,
  p_card_id uuid,
  p_cost text
) returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cost text := coalesce(p_cost, '');
  v_reduction integer := 0;
  v_self jsonb;
  v_type_line text;
  v_generic text;
  v_new integer;
begin
  if btrim(v_cost) = '' or p_caster is null then
    return v_cost;
  end if;

  select c.type_line into v_type_line
  from public.game_cards g join public.cards c on c.id = g.card_id
  where g.id = p_card_id and g.session_id = p_session_id;

  -- Self reduction (the spell's own script).
  v_self := public.effective_script(p_session_id, p_card_id) -> 'cost_reduction';
  if v_self is not null then
    if v_self -> 'if' is not null then
      if public.resolve_count_amount(p_session_id, p_caster, v_self -> 'if')
         >= coalesce((v_self -> 'if' ->> 'at_least')::integer, 1)
      then
        v_reduction := v_reduction + coalesce((v_self ->> 'amount')::integer, 0);
      end if;
    else
      v_reduction := v_reduction + coalesce((v_self ->> 'amount')::integer, 0);
    end if;
  end if;

  -- Static reductions from the caster's battlefield permanents.
  select v_reduction + coalesce(sum(coalesce((ce.payload ->> 'amount')::integer, 0)), 0)
  into v_reduction
  from public.game_continuous_effects ce
  join public.game_cards sc on sc.id = ce.source_card_id and sc.zone = 'battlefield'
  where ce.session_id = p_session_id
    and ce.effect_type = 'cost_reduction'
    and ce.affected_player_id = p_caster
    and (
      coalesce(ce.payload ->> 'type_line', '') = ''
      or coalesce(v_type_line, '') ilike '%' || (ce.payload ->> 'type_line') || '%'
    );

  if v_reduction <= 0 then
    return v_cost;
  end if;

  -- Reduce the single generic token (regexp_replace without 'g' hits the first).
  v_generic := substring(v_cost from '\{(\d+)\}');
  if v_generic is null then
    return v_cost;
  end if;
  v_new := greatest(0, v_generic::integer - v_reduction);
  if v_new = 0 then
    return regexp_replace(v_cost, '\{\d+\}', '');
  else
    return regexp_replace(v_cost, '\{\d+\}', '{' || v_new || '}');
  end if;
end;
$$;
grant execute on function public.reduced_mana_cost(uuid, uuid, uuid, text) to authenticated;
grant execute on function public.reduced_mana_cost(uuid, uuid, uuid, text) to service_role;

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
      'toxic',
      'menace',
      'intimidate',
      'hexproof',
      -- STATIC cast-from-graveyard permission (mig 207, Gisa and Geralf): a
      -- script-registered row, swept by rebuild when the source leaves — unlike
      -- the until-EOT grant_cast_from_graveyard effect rows (mig 173).
      'cast_from_graveyard',
      -- STATIC cost reduction (mig 231, Dragonlord's Servant / Sarkhan): payload
      -- {type_line, amount}; reduced_mana_cost sums these for the caster. Defaults
      -- to affected:'controller' (not a source-keyword), so affected_player_id is
      -- the controller.
      'cost_reduction'
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
          'intimidate',
          'hexproof'
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

create or replace function public.cast_card_from_hand(
  p_session_id uuid,
  p_game_card_id uuid,
  p_generic_payment jsonb default null,
  p_target_card_id uuid default null,
  p_kicked boolean default false,
  p_sacrifice_ids uuid[] default null
) returns public.game_cards
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_card public.game_cards;
  v_card_type_line text;
  v_card_mana_cost text;
  v_is_aura boolean;
  v_pending_stack_count integer := 0;
  v_land_play_limit integer := 1;
  v_next_battlefield_position integer;
  v_next_stack_position integer;
  v_perm_id uuid;
  v_perm_once boolean;
  v_perm_source uuid;
  v_alt_cost jsonb;
  v_use_alt boolean := false;
  v_sac_needed integer := 0;
  v_sac_id uuid;
  v_enters_tapped jsonb;
  v_land_tapped boolean := false;
  v_unless jsonb;
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
    raise exception 'Cannot cast cards in a finished game session';
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
    raise exception 'Only the priority player can cast cards';
  end if;

  -- Source is normally the hand; a cast_from_graveyard permission also unlocks the
  -- graveyard (validated against the card's type below).
  select game_cards.*
  into v_card
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id
    and game_cards.owner_id = auth.uid()
    and game_cards.zone in ('hand', 'graveyard', 'exile')
  for update of game_cards;

  if not found then
    raise exception 'Card not found in hand or not owned by current user';
  end if;

  select cards.type_line, cards.mana_cost
  into v_card_type_line, v_card_mana_cost
  from public.cards
  where cards.id = v_card.card_id;

  -- A graveyard source requires an active permission whose type filter matches.
  -- A permission may be ONCE-PER-TURN (mig 207, Gisa and Geralf "Once during
  -- each of your turns, you may cast a Zombie creature spell from your
  -- graveyard"): payload.once_per_turn:true, with the usage turn stamped in the
  -- SOURCE permanent's counter bag ('gy_cast_turn' — survives rebuilds, like the
  -- planeswalker loyalty_turn marker). Unrestricted permissions are preferred
  -- so a once-row isn't consumed needlessly.
  if v_card.zone = 'graveyard' then
    -- SELF-granted alternative graveyard cast (mig 213, Scourge of Nel Toth:
    -- "You may cast this creature from your graveyard by paying {B}{B} and
    -- sacrificing two creatures rather than paying its mana cost"). A card
    -- whose own script carries `graveyard_cast_cost` needs no permission row;
    -- the alternative cost replaces the printed one (paid below).
    v_alt_cost := public.effective_script(p_session_id, p_game_card_id) -> 'graveyard_cast_cost';
    if v_alt_cost is not null and jsonb_typeof(v_alt_cost) = 'object' then
      v_use_alt := true;
    end if;
  end if;

  if v_card.zone = 'graveyard' and not v_use_alt then
    select ce.id,
           coalesce((ce.payload ->> 'once_per_turn')::boolean, false),
           ce.source_card_id
    into v_perm_id, v_perm_once, v_perm_source
    from public.game_continuous_effects ce
    left join public.game_cards sc on sc.id = ce.source_card_id
    where ce.session_id = p_session_id
      and ce.effect_type = 'cast_from_graveyard'
      and ce.affected_player_id = auth.uid()
      and (
        coalesce(ce.payload ->> 'type_line', '') = ''
        or coalesce(v_card_type_line, '') ilike '%' || (ce.payload ->> 'type_line') || '%'
      )
      -- Card-specific permission (mig 215, Havengul Lich): only that card.
      and (
        ce.payload ->> 'card_id' is null
        or (ce.payload ->> 'card_id')::uuid = p_game_card_id
      )
      and (
        coalesce((ce.payload ->> 'once_per_turn')::boolean, false) is false
        or coalesce((sc.counters ->> 'gy_cast_turn')::integer, -1)
           is distinct from v_turn_state.turn_number
      )
    order by coalesce((ce.payload ->> 'once_per_turn')::boolean, false), ce.id
    limit 1;

    if v_perm_id is null then
      raise exception 'You do not have permission to cast that card from your graveyard';
    end if;

    if v_perm_once and v_perm_source is not null then
      update public.game_cards
      set counters = coalesce(counters, '{}'::jsonb)
            || jsonb_build_object('gy_cast_turn', v_turn_state.turn_number)
      where id = v_perm_source and session_id = p_session_id;
    end if;
  end if;

  -- Turn-stamped graveyard-cast tracker (mig 206, Laboratory Drudge) — counts
  -- permission casts AND alternative-cost self casts.
  if v_card.zone = 'graveyard' then
    perform public.note_graveyard_cast(p_session_id, auth.uid());
  end if;

  -- An EXILE source requires a play_from_exile permission (mig 230, Atsushi
  -- impulse) whose payload.card_ids includes this card. The permission is left
  -- in place (advance_step expires it at the end of the player's next turn); the
  -- card simply leaves exile when it resolves onto the battlefield.
  if v_card.zone = 'exile' then
    if not exists (
      select 1 from public.game_continuous_effects ce
      where ce.session_id = p_session_id
        and ce.effect_type = 'play_from_exile'
        and ce.affected_player_id = auth.uid()
        and (ce.payload -> 'card_ids') ? p_game_card_id::text
    ) then
      raise exception 'You do not have permission to play that card from exile';
    end if;
  end if;

  if coalesce(v_card_type_line, '') ilike '%instant%'
    or coalesce(v_card_type_line, '') ilike '%sorcery%'
  then
    raise exception 'Use this spell action to cast instant and sorcery cards';
  end if;

  if v_turn_state.active_player_id <> auth.uid() then
    raise exception 'Cards can only be played by the active player in this first implementation';
  end if;

  if v_turn_state.step not in ('precombat_main', 'postcombat_main') then
    raise exception 'Cards can only be played during a main phase';
  end if;

  select count(*)
  into v_pending_stack_count
  from public.game_stack_items
  where session_id = p_session_id
    and status = 'pending';

  if v_pending_stack_count > 0 then
    raise exception 'Cards can only be played while the stack is empty';
  end if;

  if coalesce(v_card_type_line, '') ilike '%land%' then
    v_land_play_limit := public.get_land_play_limit(p_session_id, auth.uid());

    if coalesce(v_turn_state.lands_played_this_turn, 0) >= v_land_play_limit then
      raise exception 'You have already used all land plays this turn';
    end if;

    update public.game_turn_state
    set lands_played_this_turn = lands_played_this_turn + 1
    where session_id = p_session_id;

    -- "This land enters tapped" (mig 217). Top-level script `enters_tapped`:
    --   true                                            — always tapped
    --   { "unless": { "count": <source>, "type_line"?, "at_least": N } }
    --     — untapped when the count condition holds (Sunken Hollow:
    --       basic_lands_you_control >= 2)
    --   { "unless": { "hand_has_type": ["Island","Swamp"] } }
    --     — untapped when your hand has a matching card (Choked Estuary's
    --       reveal, auto-applied — the reveal choice itself isn't modelled).
    v_enters_tapped := public.effective_script(p_session_id, p_game_card_id) -> 'enters_tapped';
    if v_enters_tapped is not null then
      if jsonb_typeof(v_enters_tapped) = 'boolean' then
        v_land_tapped := (v_enters_tapped)::text = 'true';
      elsif jsonb_typeof(v_enters_tapped) = 'object' then
        v_land_tapped := true;
        v_unless := v_enters_tapped -> 'unless';
        if v_unless ? 'count' then
          if public.resolve_count_amount(p_session_id, auth.uid(), v_unless)
             >= coalesce((v_unless ->> 'at_least')::integer, 1) then
            v_land_tapped := false;
          end if;
        elsif v_unless ? 'hand_has_type' then
          if exists (
            select 1
            from public.game_cards gc
            join public.cards c on c.id = gc.card_id
            cross join lateral jsonb_array_elements_text(v_unless -> 'hand_has_type') as want(t)
            where gc.session_id = p_session_id and gc.owner_id = auth.uid()
              and gc.zone = 'hand' and gc.id <> p_game_card_id
              and c.type_line ilike '%' || want.t || '%'
          ) then
            v_land_tapped := false;
          end if;
        elsif v_unless ? 'control_type' then
          -- Checklands (mig 225): "enters tapped unless you control a Forest or
          -- an Island." Untapped when you control a battlefield permanent whose
          -- type line matches any of the listed types.
          if exists (
            select 1
            from public.game_cards gc
            join public.cards c on c.id = gc.card_id
            cross join lateral jsonb_array_elements_text(v_unless -> 'control_type') as want(t)
            where gc.session_id = p_session_id
              and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
              and gc.zone = 'battlefield' and gc.id <> p_game_card_id
              and c.type_line ilike '%' || want.t || '%'
          ) then
            v_land_tapped := false;
          end if;
        end if;
      end if;
    end if;

    select coalesce(max(zone_position), -1) + 1
    into v_next_battlefield_position
    from public.game_cards
    where session_id = p_session_id
      and owner_id = auth.uid()
      and zone = 'battlefield';

    update public.game_cards
    set
      zone = 'battlefield',
      zone_position = v_next_battlefield_position,
      entered_battlefield_turn_number = v_turn_state.turn_number,
      controller_player_id = coalesce(controller_player_id, owner_id),
      is_tapped = v_land_tapped,
      damage_marked = 0
    where id = p_game_card_id
    returning * into v_card;

    perform public.rebuild_scripted_continuous_effects(p_session_id);

    return v_card;
  end if;

  -- Aura: validate the enchant target (a legal creature without protection from the
  -- Aura's colour) at announce; it rides in the cast_permanent payload to resolution.
  v_is_aura := coalesce(v_card_type_line, '') ilike '%aura%';
  if v_is_aura then
    if p_target_card_id is null then
      raise exception 'An Aura must target a creature to enchant';
    end if;
    if not public.creature_target_controller_ok(p_session_id, p_target_card_id, auth.uid(), 'any') then
      raise exception 'An Aura can only enchant a creature on the battlefield';
    end if;
    if public.card_has_protection_from_any(
         p_session_id, p_target_card_id, public.card_color_set(v_card_mana_cost)
       ) then
      raise exception 'Target creature has protection from this Aura''s colour and can''t be enchanted by it';
    end if;
  end if;

  if v_use_alt then
    -- Alternative graveyard cast cost (mig 213, Scourge of Nel Toth): pay the
    -- alternative mana RATHER THAN the printed cost, then sacrifice N creatures
    -- — the caster's chosen set (p_sacrifice_ids) when provided, else the
    -- engine auto-picks (zone order; client refinement). Sacrifices route
    -- through put_in_graveyard so dies triggers fire.
    if nullif(v_alt_cost ->> 'mana', '') is not null then
      perform public.pay_mana_cost(p_session_id, auth.uid(), v_alt_cost ->> 'mana', p_generic_payment);
    end if;
    v_sac_needed := greatest(0, coalesce((v_alt_cost ->> 'sacrifice_creatures')::integer, 0));
    if v_sac_needed > 0 then
      if p_sacrifice_ids is not null then
        if cardinality(p_sacrifice_ids) <> v_sac_needed then
          raise exception 'This cast requires sacrificing exactly % creature(s)', v_sac_needed;
        end if;
        if (select count(*) from public.game_cards gc join public.cards c on c.id = gc.card_id
            where gc.id = any(p_sacrifice_ids) and gc.session_id = p_session_id
              and gc.zone = 'battlefield'
              and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
              and c.type_line ilike '%creature%') <> v_sac_needed
        then
          raise exception 'You can only sacrifice creatures you control';
        end if;
        foreach v_sac_id in array p_sacrifice_ids loop
          perform public.put_in_graveyard(p_session_id, v_sac_id);
        end loop;
      else
        if (select count(*) from public.game_cards gc join public.cards c on c.id = gc.card_id
            where gc.session_id = p_session_id and gc.zone = 'battlefield'
              and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
              and c.type_line ilike '%creature%') < v_sac_needed
        then
          raise exception 'You need % creature(s) to sacrifice for this cast', v_sac_needed;
        end if;
        for v_sac_id in
          select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
          where gc.session_id = p_session_id and gc.zone = 'battlefield'
            and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
            and c.type_line ilike '%creature%'
          order by gc.zone_position, gc.id
          limit v_sac_needed
        loop
          perform public.put_in_graveyard(p_session_id, v_sac_id);
        end loop;
      end if;
    end if;
  else
    -- Cost reduction (mig 231): reduce the generic portion before paying (e.g.
    -- "Dragon spells you cast cost {1} less" — Dragonlord's Servant).
    perform public.pay_mana_cost(
      p_session_id, auth.uid(),
      public.reduced_mana_cost(p_session_id, auth.uid(), p_game_card_id, v_card_mana_cost),
      p_generic_payment);
  end if;

  -- Kicker (mig 211, Josu Vess): an OPTIONAL additional cost from the script's
  -- top-level `kicker` mana string. Paying it stamps 'kicked' in the card's
  -- counter bag (survives the stack→battlefield move and rebuilds); an ETB
  -- conditional reads it via { "counters": "kicked", "of": "self" }. Casting
  -- kicked without a kicker cost on the card is an error.
  if p_kicked then
    if nullif(public.effective_script(p_session_id, p_game_card_id) ->> 'kicker', '') is null then
      raise exception 'This card has no kicker cost';
    end if;
    perform public.pay_mana_cost(
      p_session_id, auth.uid(),
      public.effective_script(p_session_id, p_game_card_id) ->> 'kicker', null);
    update public.game_cards
    set counters = coalesce(counters, '{}'::jsonb) || jsonb_build_object('kicked', 1)
    where id = p_game_card_id and session_id = p_session_id;
  end if;

  select coalesce(max(position), -1) + 1
  into v_next_stack_position
  from public.game_stack_items
  where session_id = p_session_id;

  update public.game_cards
  set
    zone = 'stack',
    zone_position = v_next_stack_position,
    is_tapped = false,
    damage_marked = 0
  where id = p_game_card_id
  returning * into v_card;

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
    p_game_card_id,
    'cast_permanent',
    jsonb_build_object(
      'timing', 'sorcery',
      'card_id', v_card.card_id,
      'type_line', v_card_type_line
    ) || case when v_is_aura
            then jsonb_build_object('target_card_id', p_target_card_id)
            else '{}'::jsonb end,
    v_next_stack_position
  );

  update public.game_turn_state
  set
    priority_player_id = active_player_id,
    priority_cycle_started_by = null,
    priority_pass_count = 0
  where session_id = p_session_id;

  return v_card;
end;
$$;
grant execute on function public.cast_card_from_hand(uuid, uuid, jsonb, uuid, boolean, uuid[]) to authenticated;

create or replace function public.cast_spell_effect(
  p_session_id uuid,
  p_actions jsonb,
  p_source_card_id uuid default null,
  p_x_value integer default null,
  p_target_card_id uuid default null
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
  v_source_script jsonb;
  v_flashback_cost text;
  v_flashback_life integer;
  v_is_flashback boolean := false;
  v_program jsonb;
  v_timing text;
  v_pending integer;
  v_next_position integer;
  v_next_graveyard integer;
  v_next_exile integer;
  v_resolved_actions jsonb;
  v_stack public.game_stack_items;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if jsonb_typeof(p_actions) <> 'array' or jsonb_array_length(p_actions) < 1 then
    raise exception 'Spell effect needs at least one action';
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
    select cards.type_line, cards.mana_cost, game_cards.zone, cards.script
      into v_source_type_line, v_source_mana_cost, v_source_zone, v_source_script
    from public.game_cards
    join public.cards on cards.id = game_cards.card_id
    where game_cards.id = p_source_card_id
      and game_cards.session_id = p_session_id
      and game_cards.owner_id = auth.uid();
    if not found then
      raise exception 'Source card not found or not owned by current user';
    end if;
  end if;

  -- Timing: instants any time the caster has priority; sorceries main-phase only,
  -- empty stack, active player. A sourceless cast (tests) defaults to instant.
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

  -- The spell program. A FLASHBACK (graveyard) cast uses the script's
  -- `flashback_effect` actions when present, REPLACING the normal effect (the
  -- "Increasing …" cards do more / different on flashback). The engine selects by
  -- cast zone — it does not trust the client's actions for the flashback effect.
  if v_source_zone = 'graveyard'
     and jsonb_typeof(v_source_script -> 'flashback_effect' -> 'actions') = 'array'
     and jsonb_array_length(v_source_script -> 'flashback_effect' -> 'actions') > 0 then
    v_program := v_source_script -> 'flashback_effect' -> 'actions';
  else
    v_program := p_actions;
  end if;

  -- Resolve any top-level "X" amount/count to the caster-chosen x_value before it
  -- is stored on the stack item (resolution code never sees the "X" token).
  select coalesce(jsonb_agg(
    case
      when (elem ->> 'amount') = 'X' or (elem ->> 'count') = 'X' then
        elem
          || (case when (elem ->> 'amount') = 'X'
                then jsonb_build_object('amount', greatest(coalesce(p_x_value, 0), 0)) else '{}'::jsonb end)
          || (case when (elem ->> 'count') = 'X'
                then jsonb_build_object('count', greatest(coalesce(p_x_value, 0), 0)) else '{}'::jsonb end)
      else elem
    end
    order by ord
  ), '[]'::jsonb)
  into v_resolved_actions
  from jsonb_array_elements(v_program) with ordinality as t(elem, ord);

  -- Pay the cast cost. A hand cast pays the printed mana cost (incl {X}). A graveyard
  -- cast is a FLASHBACK: it requires the card's script to carry a `flashback` cost,
  -- pays that instead, and marks the card for exile (below). No-op when the source is
  -- sourceless or free (the free-cast test fixtures).
  if p_source_card_id is not null and v_source_zone = 'hand' then
    if v_source_mana_cost is not null and btrim(v_source_mana_cost) <> '' then
      -- Cost reduction (mig 231, Draconic Lore: "costs {2} less if you control a
      -- Dragon"). Generic mana is auto-paid here (null generic payment), so the
      -- reduced cost is consumed with no client change.
      perform public.pay_mana_cost(
        p_session_id, auth.uid(),
        public.reduced_mana_cost(p_session_id, auth.uid(), p_source_card_id, v_source_mana_cost),
        null, coalesce(p_x_value, 0));
    end if;
  elsif p_source_card_id is not null and v_source_zone = 'graveyard' then
    v_flashback_cost := v_source_script ->> 'flashback';
    if v_flashback_cost is null then
      raise exception 'This card cannot be cast from your graveyard';
    end if;
    v_is_flashback := true;
    if btrim(v_flashback_cost) <> '' then
      perform public.pay_mana_cost(p_session_id, auth.uid(), v_flashback_cost, null, coalesce(p_x_value, 0));
    end if;
    -- Additional "Pay N life" flashback cost (Deep Analysis). You cannot pay life
    -- you do not have.
    v_flashback_life := coalesce((v_source_script ->> 'flashback_life')::integer, 0);
    if v_flashback_life > 0 then
      if (select life_total from public.game_session_players
          where session_id = p_session_id and player_id = auth.uid()) < v_flashback_life then
        raise exception 'Not enough life to pay the flashback cost (need %)', v_flashback_life;
      end if;
      update public.game_session_players
      set life_total = life_total - v_flashback_life
      where session_id = p_session_id and player_id = auth.uid();
    end if;
    -- Turn-stamped graveyard-cast tracker (mig 206, Laboratory Drudge).
    perform public.note_graveyard_cast(p_session_id, auth.uid());
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
    'spell_effect',
    jsonb_build_object('effects', v_resolved_actions, 'controller_player_id', auth.uid(), 'timing', v_timing)
      || (case when p_target_card_id is not null
               then jsonb_build_object('target_card_id', p_target_card_id) else '{}'::jsonb end),
    v_next_position,
    'pending'
  )
  returning * into v_stack;

  -- Non-permanent spell leaves its cast zone on cast: a hand cast goes to the
  -- graveyard; a flashback cast (from the graveyard) is exiled instead.
  if v_is_flashback then
    select coalesce(max(zone_position), -1) + 1 into v_next_exile
    from public.game_cards
    where session_id = p_session_id and owner_id = auth.uid() and zone = 'exile';

    update public.game_cards
    set zone = 'exile', zone_position = v_next_exile, controller_player_id = owner_id,
        is_tapped = false, damage_marked = 0
    where id = p_source_card_id;

  elsif p_source_card_id is not null
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
grant execute on function public.cast_spell_effect(uuid, jsonb, uuid, integer, uuid) to authenticated;
