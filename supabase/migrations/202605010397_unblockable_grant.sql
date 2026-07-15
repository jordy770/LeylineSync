-- 202605010397_unblockable_grant
-- TODO: describe the change.
-- Generated from supabase/functions_src (card_has_unblockable, apply_creature_effect, declare_blocker) — those files are
-- the canonical current definitions; edit them, not past migrations.

-- 'unblockable' joins the continuous-effect CHECK list (rebuilt from the
-- mig 357 definition + the new value — bug-283 rule: never from the baseline).
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
    'unblockable'
  ]));

create or replace function public.card_has_unblockable(p_session_id uuid, p_game_card_id uuid)
returns boolean language sql security definer set search_path = public as $$
  select exists (
    select 1
    from public.game_continuous_effects effects
    left join public.game_cards source_card on source_card.id = effects.source_card_id
    left join public.game_cards tc on tc.id = p_game_card_id
    left join public.cards tcard on tcard.id = tc.card_id
    where effects.session_id = p_session_id
      and effects.effect_type = 'unblockable'
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
grant execute on function public.card_has_unblockable(uuid, uuid) to authenticated, service_role;

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
  v_amount integer;
  v_pump_power integer;
  v_pump_tough integer;
  v_target_owner_id uuid;
  v_next_position integer;
  v_keyword text;
  v_acting_controller uuid;
  v_duration text;
  v_prev_controller uuid;
  v_counter_type text;
  v_all boolean;
  v_top_card uuid;
  v_top_type text;
  v_turn integer;
  v_goad_players integer;
begin
  if p_target_card_id is null then
    return;
  end if;

  -- Amount may be a number, "X" (→0), or { counters, of } resolved against game state.
  -- of:"you" → the acting controller; of:"target" → this target permanent.
  v_amount := public.resolve_dynamic_amount(
    p_session_id, null,
    nullif(p_params ->> 'acting_controller', '')::uuid,
    p_params -> 'amount',
    p_target_card_id);

  if p_kind = 'deal_damage' then
    if v_amount > 0 then
      perform public.apply_damage_to_creature(
        p_session_id, p_target_card_id, v_amount, null, false,
        coalesce((p_params ->> 'deathtouch')::boolean, false)
      );
    end if;

  elsif p_kind = 'destroy' then
    perform public.put_in_graveyard(p_session_id, p_target_card_id);

  elsif p_kind = 'exile' then
    select owner_id into v_target_owner_id
    from public.game_cards
    where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield';
    if found then
      select coalesce(max(zone_position), -1) + 1 into v_next_position
      from public.game_cards
      where session_id = p_session_id and owner_id = v_target_owner_id and zone = 'exile';
      update public.game_cards
      set zone = 'exile', zone_position = v_next_position, controller_player_id = owner_id,
          is_tapped = false, damage_marked = 0, dealt_deathtouch_damage = false, plus_one_counters = 0
      where id = p_target_card_id;
    end if;

  elsif p_kind = 'animate' then
    -- Land animation (mig 277, Obuun / Embodiment of Insight / Waker of the
    -- Wilds): "target land becomes an X/X Elemental creature … It's still a
    -- land." An 'animated' row marks creature-ness for the combat gates
    -- (declare_attacker / declare_blocker); set_pt pins the P/T; keywords
    -- ride along. permanent:true (Waker) skips the end-of-turn expiry.
    if exists (select 1 from public.game_cards where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield') then
      v_pump_power := public.resolve_dynamic_amount(
        p_session_id, nullif(p_params ->> 'acting_source', '')::uuid,
        nullif(p_params ->> 'acting_controller', '')::uuid,
        p_params -> 'power', p_target_card_id);
      v_pump_tough := public.resolve_dynamic_amount(
        p_session_id, nullif(p_params ->> 'acting_source', '')::uuid,
        nullif(p_params ->> 'acting_controller', '')::uuid,
        p_params -> 'toughness', p_target_card_id);
      insert into public.game_continuous_effects (
        session_id, source_card_id, affected_card_id, effect_type, payload,
        source_zone_required, expires_at_phase, expires_at_step
      )
      select p_session_id, p_target_card_id, p_target_card_id, e.kind, e.payload,
             'battlefield',
             case when coalesce((p_params ->> 'permanent')::boolean, false) then null else 'ending' end,
             case when coalesce((p_params ->> 'permanent')::boolean, false) then null else 'cleanup' end
      from (
        select 'set_pt'::text as kind,
               jsonb_build_object('power', v_pump_power, 'toughness', v_pump_tough,
                                  'until_end_of_turn', not coalesce((p_params ->> 'permanent')::boolean, false)) as payload
        union all
        select 'animated', '{}'::jsonb
        union all
        select lower(k.value), '{}'::jsonb
        from jsonb_array_elements_text(coalesce(p_params -> 'keywords', '[]'::jsonb)) k
        where lower(k.value) in ('trample', 'haste', 'flying', 'vigilance', 'first_strike',
                                 'double_strike', 'reach', 'deathtouch', 'menace',
                                 'indestructible', 'hexproof')
      ) e;
    end if;

  elsif p_kind = 'exile_until_leaves' then
    -- Bronzebeak Foragers (mig 262): exile the target until the ACTING SOURCE
    -- leaves the battlefield (fire_zone_change_triggers returns it). Without
    -- a known source this falls back to a plain exile.
    select owner_id into v_target_owner_id
    from public.game_cards
    where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield';
    if found then
      select coalesce(max(zone_position), -1) + 1 into v_next_position
      from public.game_cards
      where session_id = p_session_id and owner_id = v_target_owner_id and zone = 'exile';
      update public.game_cards
      set zone = 'exile', zone_position = v_next_position, controller_player_id = owner_id,
          is_tapped = false, damage_marked = 0, dealt_deathtouch_damage = false, plus_one_counters = 0
      where id = p_target_card_id;
      if nullif(p_params ->> 'acting_source', '') is not null then
        insert into public.game_continuous_effects (
          session_id, source_card_id, affected_card_id, effect_type, payload, source_zone_required
        ) values (
          p_session_id, (p_params ->> 'acting_source')::uuid, p_target_card_id,
          'exiled_until_leaves', '{}'::jsonb, 'battlefield'
        );
      end if;
    end if;

  elsif p_kind = 'bounce' then
    select owner_id into v_target_owner_id
    from public.game_cards
    where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield';
    if found then
      select coalesce(max(zone_position), -1) + 1 into v_next_position
      from public.game_cards
      where session_id = p_session_id and owner_id = v_target_owner_id and zone = 'hand';
      update public.game_cards
      set zone = 'hand', zone_position = v_next_position, controller_player_id = owner_id,
          is_tapped = false, damage_marked = 0, dealt_deathtouch_damage = false, plus_one_counters = 0
      where id = p_target_card_id;
    end if;

  elsif p_kind = 'blink' then
    -- Flicker (Conjurer's Closet, mig 351): exile the target, then return it to
    -- the battlefield under the acting controller — re-entering re-fires its ETB.
    -- A token ceases on exile and cannot return.
    if exists (select 1 from public.game_cards
               where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield'
                 and not coalesce(is_token, false)) then
      update public.game_cards set zone = 'exile', controller_player_id = owner_id,
        is_tapped = false, damage_marked = 0, plus_one_counters = 0
      where id = p_target_card_id and session_id = p_session_id;
      update public.game_cards gc set zone = 'battlefield',
        zone_position = (select coalesce(max(x.zone_position), -1) + 1 from public.game_cards x
                         where x.session_id = p_session_id and x.owner_id = gc.owner_id and x.zone = 'battlefield'),
        controller_player_id = coalesce(nullif(p_params ->> 'acting_controller', '')::uuid, gc.owner_id),
        is_tapped = false,
        entered_battlefield_turn_number = (select turn_number from public.game_turn_state where session_id = p_session_id)
      where gc.id = p_target_card_id and gc.session_id = p_session_id;
      perform public.rebuild_scripted_continuous_effects(p_session_id);
    end if;

  elsif p_kind = 'saw_in_half' then
    -- Saw in Half (mig 356): "Destroy target creature. If it dies, its controller
    -- creates two tokens that are copies of it with half its power/toughness,
    -- rounded up." Grant a dies-trigger (copy_self ×2 with the half P/T baked from
    -- the creature's CURRENT effective P/T) then destroy it, so the copies appear
    -- only on an actual death.
    if exists (select 1 from public.game_cards where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield') then
      insert into public.game_continuous_effects (
        session_id, source_card_id, affected_card_id, effect_type, payload, source_zone_required
      ) values (
        p_session_id, p_target_card_id, p_target_card_id, 'granted_dies_effect',
        jsonb_build_object('effects', jsonb_build_array(jsonb_build_object(
          'type', 'copy_self', 'count', 2,
          'except', jsonb_build_object(
            'power', ceil(coalesce(public.card_effective_power(p_session_id, p_target_card_id), 0) / 2.0)::integer,
            'toughness', ceil(coalesce(public.card_effective_toughness(p_session_id, p_target_card_id), 0) / 2.0)::integer)))),
        'battlefield');
      perform public.put_in_graveyard(p_session_id, p_target_card_id);
    end if;

  elsif p_kind = 'shuffle_into_library' then
    -- Chaos Warp (mig 242): the OWNER shuffles the target into their library
    -- (modelled as inserting at a random position), then reveals the top card
    -- of that library; a permanent card goes onto the battlefield under the
    -- owner's control. Tokens shuffled in simply cease (the cease trigger).
    select owner_id into v_target_owner_id
    from public.game_cards
    where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield';
    if found then
      select floor(random() * (count(*) + 1))::integer into v_next_position
      from public.game_cards
      where session_id = p_session_id and owner_id = v_target_owner_id and zone = 'library';
      update public.game_cards
      set zone_position = zone_position + 1
      where session_id = p_session_id and owner_id = v_target_owner_id and zone = 'library'
        and zone_position >= v_next_position;
      update public.game_cards
      set zone = 'library', zone_position = v_next_position, controller_player_id = owner_id,
          is_tapped = false, damage_marked = 0, dealt_deathtouch_damage = false, plus_one_counters = 0
      where id = p_target_card_id;

      if coalesce((p_params ->> 'then_reveal_top_to_battlefield')::boolean, false) then
        select gc.id, c.type_line into v_top_card, v_top_type
        from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.session_id = p_session_id and gc.owner_id = v_target_owner_id and gc.zone = 'library'
        order by gc.zone_position asc, gc.id asc
        limit 1;
        if v_top_card is not null and (
             v_top_type ilike '%creature%' or v_top_type ilike '%artifact%'
             or v_top_type ilike '%enchantment%' or v_top_type ilike '%land%'
             or v_top_type ilike '%planeswalker%' or v_top_type ilike '%battle%') then
          select turn_number into v_turn
          from public.game_turn_state where session_id = p_session_id;
          update public.game_cards gc
          set zone = 'battlefield', controller_player_id = gc.owner_id, is_tapped = false,
              entered_battlefield_turn_number = coalesce(v_turn, 0),
              zone_position = (select coalesce(max(zone_position), -1) + 1
                               from public.game_cards x
                               where x.session_id = p_session_id and x.owner_id = gc.owner_id
                                 and x.zone = 'battlefield')
          where gc.id = v_top_card;
          perform public.register_card_continuous_effects(p_session_id, v_top_card);
        end if;
      end if;
    end if;

  elsif p_kind in ('tap', 'untap') then
    update public.game_cards
    set is_tapped = (p_kind = 'tap')
    where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield';

  elsif p_kind = 'add_counters' then
    v_counter_type := p_params ->> 'counter_type';
    v_all := coalesce((p_params ->> 'all')::boolean, false);
    if v_amount <> 0 or v_all then
      -- Doubling Season etc: the recipient's controller's replacement multiplies
      -- counters PUT ON it. Removal (negative) / `all` are not doubled.
      if v_amount > 0 then
        v_amount := v_amount * public.counter_factor(
          p_session_id,
          (select controller_player_id from public.game_cards
           where id = p_target_card_id and session_id = p_session_id));
      end if;
      if public.is_plus_one_counter(v_counter_type) then
        update public.game_cards
        set plus_one_counters = case when v_all then 0 else greatest(0, plus_one_counters + v_amount) end
        where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield';
      else
        update public.game_cards
        set counters = case when v_all then counters - lower(v_counter_type)
                            else public.adjust_counter_bag(counters, lower(v_counter_type), v_amount) end
        where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield';
      end if;
      -- Any counter change can annihilate (+1/+1 vs −1/−1) or drop toughness to lethal.
      perform public.recheck_counter_state(p_session_id);
    end if;

  elsif p_kind = 'pump' then
    if exists (select 1 from public.game_cards where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield') then
      -- power/toughness may be a fixed number OR a { count, … } object; negate per
      -- value (Liliana −2: -X/-X where X = Zombies you control). Count is relative to
      -- the acting controller.
      v_pump_power := public.resolve_dynamic_amount(
        p_session_id, p_target_card_id,
        nullif(p_params ->> 'acting_controller', '')::uuid,
        p_params -> 'power', p_target_card_id);
      if coalesce((p_params -> 'power' ->> 'negate')::boolean, false) then
        v_pump_power := -v_pump_power;
      end if;
      v_pump_tough := public.resolve_dynamic_amount(
        p_session_id, p_target_card_id,
        nullif(p_params ->> 'acting_controller', '')::uuid,
        p_params -> 'toughness', p_target_card_id);
      if coalesce((p_params -> 'toughness' ->> 'negate')::boolean, false) then
        v_pump_tough := -v_pump_tough;
      end if;
      perform public.create_pt_pump(p_session_id, p_target_card_id, v_pump_power, v_pump_tough);
      -- A debuff dropping toughness to ≤ 0 is lethal.
      if v_pump_tough < 0 then
        perform public.move_lethal_damaged_creatures_to_graveyard(p_session_id);
      end if;
    end if;

  elsif p_kind = 'set_pt' then
    if exists (select 1 from public.game_cards where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield') then
      insert into public.game_continuous_effects (
        session_id, source_card_id, affected_card_id, effect_type, payload,
        source_zone_required, expires_at_phase, expires_at_step
      )
      values (
        p_session_id, p_target_card_id, p_target_card_id, 'set_pt',
        jsonb_build_object(
          'power', coalesce((p_params ->> 'power')::integer, 0),
          'toughness', coalesce((p_params ->> 'toughness')::integer, 0),
          'until_end_of_turn', true
        ),
        'battlefield', 'ending', 'cleanup'
      );
    end if;

  elsif p_kind = 'grant_keyword' then
    v_keyword := lower(coalesce(p_params ->> 'keyword', ''));
    if v_keyword not in (
      'flying', 'reach', 'trample', 'vigilance', 'haste',
      'first_strike', 'double_strike', 'deathtouch', 'indestructible',
      -- mig 285 (found by the deck smoke test): the schema and CHECK list
      -- accepted these long before this resolver did — Rattlechains' hexproof
      -- grant had been erroring at runtime since mig 280.
      'hexproof', 'menace', 'lifelink',
      -- mig 397: "can't be blocked this turn" (Rogue's Passage, Hraesvelgr);
      -- declare_blocker enforces it via card_has_unblockable.
      'unblockable'
    ) then
      raise exception 'Unsupported keyword grant: %', v_keyword;
    end if;
    if exists (select 1 from public.game_cards where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield') then
      insert into public.game_continuous_effects (
        session_id, source_card_id, affected_card_id, effect_type, payload,
        source_zone_required, expires_at_phase, expires_at_step
      )
      values (
        p_session_id, p_target_card_id, p_target_card_id, v_keyword,
        jsonb_build_object('until_end_of_turn', true),
        'battlefield', 'ending', 'cleanup'
      );
    end if;

  elsif p_kind = 'grant_dies_effect' then
    -- Clavileño (mig 344): grant the target creature a "when this dies, <effects>"
    -- ability, stored as a granted_dies_effect continuous effect ON the creature
    -- (source = the creature, so it is swept when the creature leaves and SURVIVES
    -- the granter leaving). put_in_graveyard fires payload.effects on its death.
    if exists (select 1 from public.game_cards where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield') then
      insert into public.game_continuous_effects (
        session_id, source_card_id, affected_card_id, effect_type, payload, source_zone_required
      ) values (
        p_session_id, p_target_card_id, p_target_card_id, 'granted_dies_effect',
        jsonb_build_object('effects', coalesce(p_params -> 'effects', '[]'::jsonb)),
        'battlefield'
      );
    end if;

  elsif p_kind = 'ignition' then
    -- Chandra's Ignition (mig 257): target creature deals damage equal to its
    -- power to each other creature and each opponent of the caster.
    v_amount := greatest(0, coalesce(public.card_effective_power(p_session_id, p_target_card_id), 0));
    if v_amount > 0 and exists (
      select 1 from public.game_cards
      where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield'
    ) then
      for v_top_card in
        select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.session_id = p_session_id and gc.zone = 'battlefield'
          and c.type_line ilike '%creature%' and gc.id <> p_target_card_id
      loop
        perform public.apply_damage_to_creature(
          p_session_id, v_top_card, v_amount, p_target_card_id, false, false, false);
      end loop;
      v_acting_controller := nullif(p_params ->> 'acting_controller', '')::uuid;
      update public.game_session_players
      set life_total = greatest(0, life_total - v_amount)
      where session_id = p_session_id and player_id is distinct from v_acting_controller;
      perform public.move_lethal_damaged_creatures_to_graveyard(p_session_id);
      perform public.maybe_finish_game_session(p_session_id);
    end if;

  elsif p_kind = 'exile_and_manifest' then
    -- Reality Shift (mig 251): exile target creature; its CONTROLLER
    -- manifests the top card of their library — it enters as a face-down
    -- 2/2 with no abilities (copied_script {} + an unexpiring set_pt 2/2;
    -- register skips manifested cards so printed keywords stay off).
    -- turn_manifest_up flips a creature card face up for its mana cost.
    -- The card's identity is not visually hidden from the table (client
    -- approximation).
    select coalesce(controller_player_id, owner_id), owner_id
    into v_prev_controller, v_target_owner_id
    from public.game_cards
    where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield';
    if found then
      update public.game_cards gc
      set zone = 'exile', controller_player_id = gc.owner_id, is_tapped = false,
          damage_marked = 0, dealt_deathtouch_damage = false, plus_one_counters = 0,
          zone_position = (select coalesce(max(zone_position), -1) + 1
                           from public.game_cards x
                           where x.session_id = p_session_id and x.owner_id = gc.owner_id and x.zone = 'exile')
      where gc.id = p_target_card_id;

      select gc.id into v_top_card
      from public.game_cards gc
      where gc.session_id = p_session_id and gc.owner_id = v_prev_controller and gc.zone = 'library'
      order by gc.zone_position asc, gc.id asc
      limit 1;
      if v_top_card is not null then
        select turn_number into v_turn
        from public.game_turn_state where session_id = p_session_id;
        update public.game_cards gc
        set zone = 'battlefield', controller_player_id = v_prev_controller, is_tapped = false,
            entered_battlefield_turn_number = coalesce(v_turn, 0),
            counters = coalesce(gc.counters, '{}'::jsonb) || jsonb_build_object('manifested', 1),
            copied_script = '{}'::jsonb,
            zone_position = (select coalesce(max(zone_position), -1) + 1
                             from public.game_cards x
                             where x.session_id = p_session_id and x.owner_id = gc.owner_id
                               and x.zone = 'battlefield')
        where gc.id = v_top_card;
        insert into public.game_continuous_effects (
          session_id, source_card_id, affected_card_id, effect_type, payload, source_zone_required)
        values (p_session_id, v_top_card, v_top_card, 'set_pt',
          jsonb_build_object('power', 2, 'toughness', 2), 'battlefield');
      end if;
    end if;

  elsif p_kind = 'goad' then
    -- Goad (mig 249, Vengeful Ancestor): "until your next turn, that creature
    -- attacks each combat if able and attacks a player other than you if
    -- able." A 'goaded' row carrying the goader, expiring before the goader's
    -- next turn (current turn + players - 1). Enforced: declare_attacker
    -- rejects attacking the goader while another opponent exists; the
    -- must-attack-each-combat half is NOT forced (approximation).
    if exists (select 1 from public.game_cards where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield') then
      select turn_number into v_turn
      from public.game_turn_state where session_id = p_session_id;
      select count(*) into v_goad_players
      from public.game_session_players where session_id = p_session_id;
      insert into public.game_continuous_effects (
        session_id, source_card_id, affected_card_id, effect_type, payload, expires_at_turn_number)
      values (
        p_session_id,
        coalesce(nullif(p_params ->> 'acting_source', '')::uuid, p_target_card_id),
        p_target_card_id, 'goaded',
        jsonb_build_object('goaded_by', p_params ->> 'acting_controller'),
        coalesce(v_turn, 0) + greatest(1, coalesce(v_goad_players, 2) - 1));
    end if;

  elsif p_kind = 'gain_control' then
    v_acting_controller := nullif(p_params ->> 'acting_controller', '')::uuid;
    if v_acting_controller is null then
      raise exception 'gain_control requires an acting controller';
    end if;
    v_duration := lower(coalesce(p_params ->> 'duration', 'permanent'));
    if v_duration not in ('permanent', 'end_of_turn', 'while_source') then
      raise exception 'Unsupported gain_control duration: %', v_duration;
    end if;
    -- Donate (Harmless Offering, mig 353): "target OPPONENT gains control" — hand
    -- the permanent to an opponent of the caster (1v1: the only one) instead of
    -- the caster gaining it.
    if lower(coalesce(p_params ->> 'to', '')) = 'opponent' then
      select sp.player_id into v_acting_controller
      from public.game_session_players sp
      where sp.session_id = p_session_id and sp.player_id is distinct from v_acting_controller
      order by sp.seat_number limit 1;
      if v_acting_controller is null then
        raise exception 'No opponent to donate to';
      end if;
    end if;
    select controller_player_id into v_prev_controller
    from public.game_cards
    where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield';
    if found then
      update public.game_cards
      set controller_player_id = v_acting_controller,
          is_tapped = case when coalesce((p_params ->> 'untap')::boolean, false) then false else is_tapped end
      where id = p_target_card_id;
      if coalesce((p_params ->> 'haste')::boolean, false) then
        insert into public.game_continuous_effects (
          session_id, source_card_id, affected_card_id, effect_type, payload,
          source_zone_required, expires_at_phase, expires_at_step
        )
        values (
          p_session_id, p_target_card_id, p_target_card_id, 'haste',
          jsonb_build_object('until_end_of_turn', true),
          'battlefield', 'ending', 'cleanup'
        );
      end if;
      if v_duration = 'end_of_turn' then
        insert into public.game_continuous_effects (
          session_id, source_card_id, affected_card_id, effect_type, payload,
          source_zone_required, expires_at_phase, expires_at_step
        )
        values (
          p_session_id, p_target_card_id, p_target_card_id, 'control',
          jsonb_build_object('original_controller', v_prev_controller),
          'battlefield', 'ending', 'cleanup'
        );
      elsif v_duration = 'while_source' then
        -- "For as long as ~ remains on the battlefield, gain control of that
        -- permanent" (mig 246, Opportunistic Dragon): an UNexpiring control
        -- row sourced by the STEALING permanent; fire_zone_change_triggers
        -- reverts when it leaves. lose_abilities blanks the stolen
        -- permanent's script (a copied_script stub that also blocks
        -- attacking via the cant_attack_unless gate; blocking is NOT
        -- restricted — approximation).
        insert into public.game_continuous_effects (
          session_id, source_card_id, affected_card_id, effect_type, payload)
        values (
          p_session_id,
          coalesce(nullif(p_params ->> 'acting_source', '')::uuid, p_target_card_id),
          p_target_card_id, 'control',
          jsonb_build_object(
            'original_controller', v_prev_controller,
            'while_source', true,
            'lose_abilities', coalesce((p_params ->> 'lose_abilities')::boolean, false)));
        if coalesce((p_params ->> 'lose_abilities')::boolean, false) then
          update public.game_cards
          set copied_script = '{"schema_version":2,"cant_attack_unless":{"count":"artifacts_you_control","at_least":99}}'::jsonb
          where id = p_target_card_id and session_id = p_session_id;
        end if;
      end if;
    end if;

  else
    raise exception 'Unsupported creature effect kind: %', p_kind;
  end if;
end;
$$;
grant execute on function public.apply_creature_effect(uuid, text, uuid, jsonb) to authenticated;

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

  -- "Can't be blocked this turn" (mig 397, Rogue's Passage): an until-EOT
  -- 'unblockable' grant on the attacker forbids every block.
  if public.card_has_unblockable(p_session_id, p_attacker_card_id) then
    raise exception 'This creature can''t be blocked this turn';
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
