-- 202605010262_dino_finale
-- Veloci-Ramp-Tor finale (3 cards — deck COMPLETE): Etali Primal Storm,
-- Regal Behemoth, Bronzebeak Foragers.
--   • MONARCH subsystem (Regal Behemoth): game_turn_state.monarch_player_id
--     (column added below); 'become_monarch' triggered effect; combat damage
--     to the monarch crowns the attacker (resolve_combat_damage, both
--     player-damage sites); the monarch draws at THEIR end step
--     (advance_step, best-effort on empty library); script flag
--     monarch_land_bonus → +1 mana when the monarch taps a land, on BOTH
--     paths (activate_mana_ability for scripted lands, add_mana_from_card —
--     canonical reseeded from mig 151's 7-arg version — for basic lands).
--     Approximation: the bonus is the same colour as produced, once per
--     activation, no colour pick.
--   • exile_tops_cast + etali_cast_pick (Etali): exile each player's library
--     top on attack; free-cast pick over the exiled PERMANENTS enters them
--     under Etali's controller (instants/sorceries and declined cards stay
--     exiled — free-cast approximation).
--   • exile_until_leaves (Bronzebeak Foragers): targeted ETB exile tied to
--     the source; fire_zone_change_triggers returns the exiled cards when the
--     source leaves. Approximations: ONE target in 1v1 ('for each opponent'),
--     and the {X}{W} put-to-graveyard/gain-life ability is NOT modelled.

-- The crown.
alter table public.game_turn_state
  add column if not exists monarch_player_id uuid;

-- exiled_until_leaves joins the allowed continuous-effect types (latest list mig 259).
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
    'exiled_until_leaves'
  ]));
-- Generated from supabase/functions_src (apply_triggered_ability_effects, activate_mana_ability, add_mana_from_card, advance_step, resolve_combat_damage, apply_trigger_effects, submit_decision, apply_creature_effect, trigger_effect_target_type, fire_zone_change_triggers) — those files are
-- the canonical current definitions; edit them, not past migrations.

create or replace function public.apply_triggered_ability_effects(
  p_session_id uuid,
  p_controller_id uuid,
  p_source_card_id uuid,
  p_effects jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_effect jsonb;
  v_eff_type text;
  v_eff_amount integer;
  v_recipient text;
  v_recipients uuid[];
  v_rid uuid;
  v_draw_i integer;
  v_lib_card uuid;
  v_next_hand_position integer;
  v_next_graveyard_position integer;
  v_token_card_id uuid;
  v_token_count integer;
  v_turn_number integer;
  v_next_pos integer;
  v_new_token_id uuid;
  v_i integer;
  v_target_controller text;
  v_counter_type text;
  v_all boolean;
  v_milled_type text;
  v_milled_type_hit boolean;
  v_token_recipient uuid;
  v_dmg_target uuid;
  v_exiled uuid[];
  v_mon integer;
  v_hand integer;
begin
  for v_effect in
    select * from jsonb_array_elements(coalesce(p_effects, '[]'::jsonb))
  loop
    v_eff_type := lower(coalesce(v_effect ->> 'type', ''));
    v_eff_amount := public.resolve_dynamic_amount(
      p_session_id, p_source_card_id, p_controller_id, v_effect -> 'amount');
    v_recipient := lower(coalesce(v_effect ->> 'recipient', ''));

    if v_eff_type = 'untap_all_attackers' then
      -- "Untap all attacking creatures" (mig 250, Scourge of the Throne).
      update public.game_cards gc
      set is_tapped = false
      from public.game_combat_assignments ca
      where ca.session_id = p_session_id and ca.attacker_card_id = gc.id
        and gc.session_id = p_session_id and gc.zone = 'battlefield';

    elsif v_eff_type = 'extra_combat' then
      -- "After this phase, there is an additional combat phase" (mig 250):
      -- advance_step loops end_of_combat back to beginning_of_combat once per
      -- pending extra combat.
      update public.game_turn_state
      set extra_combats = coalesce(extra_combats, 0) + 1
      where session_id = p_session_id;

    elsif v_eff_type = 'add_mana' then
      -- Mana from a resolved trigger (mig 245, Frontier Siege Khans mode:
      -- "At the beginning of each of your main phases, add {G}{G}"). Fixed
      -- colours only; goes to the trigger's controller.
      if p_controller_id is not null and v_eff_amount > 0
         and upper(coalesce(v_effect ->> 'color', '')) in ('W', 'U', 'B', 'R', 'G', 'C') then
        insert into public.game_players (session_id, player_id, mana_pool)
        values (p_session_id, p_controller_id, jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0))
        on conflict (session_id, player_id) do nothing;
        update public.game_players
        set mana_pool = jsonb_set(
              coalesce(mana_pool, jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0)),
              array[upper(v_effect ->> 'color')],
              to_jsonb(coalesce((mana_pool ->> upper(v_effect ->> 'color'))::integer, 0) + v_eff_amount))
        where session_id = p_session_id and player_id = p_controller_id;
      end if;

    elsif v_eff_type = 'gain_life' then
      if v_eff_amount > 0 then
        if v_recipient in ('each_player', 'all_players') then
          select array_agg(player_id) into v_recipients
          from public.game_session_players where session_id = p_session_id;
        elsif v_recipient = 'each_opponent' then
          select array_agg(player_id) into v_recipients
          from public.game_session_players
          where session_id = p_session_id and player_id is distinct from p_controller_id;
        else
          v_recipients := array[p_controller_id];
        end if;
        foreach v_rid in array coalesce(v_recipients, array[]::uuid[]) loop
          if v_rid is not null then
            update public.game_session_players
            set life_total = life_total + v_eff_amount
            where session_id = p_session_id and player_id = v_rid;
          end if;
        end loop;
      end if;

    elsif v_eff_type in ('lose_life', 'deal_damage') then
      if v_eff_amount > 0 then
        if nullif(v_effect ->> 'recipient_player_id', '') is not null then
          -- A specific player, injected at enqueue time (Thunderbreak Regent:
          -- "deals 3 damage to THAT player" — the one who targeted your Dragon).
          v_recipients := array[(v_effect ->> 'recipient_player_id')::uuid];
        elsif v_recipient = 'controller' then
          v_recipients := array[p_controller_id];
        elsif v_recipient in ('each_player', 'all_players') then
          select array_agg(player_id) into v_recipients
          from public.game_session_players where session_id = p_session_id;
        else
          select array_agg(player_id) into v_recipients
          from public.game_session_players
          where session_id = p_session_id and player_id is distinct from p_controller_id;
        end if;
        foreach v_rid in array coalesce(v_recipients, array[]::uuid[]) loop
          update public.game_session_players
          set life_total = greatest(0, life_total - v_eff_amount)
          where session_id = p_session_id and player_id = v_rid;
        end loop;
      end if;

    elsif v_eff_type = 'add_player_counters' then
      v_counter_type := lower(coalesce(v_effect ->> 'counter_type', 'poison'));
      v_all := coalesce((v_effect ->> 'all')::boolean, false);
      if v_eff_amount <> 0 or v_all then
        if v_recipient = 'controller' then
          v_recipients := array[p_controller_id];
        elsif v_recipient in ('each_player', 'all_players') then
          select array_agg(player_id) into v_recipients
          from public.game_session_players where session_id = p_session_id;
        else
          select array_agg(player_id) into v_recipients
          from public.game_session_players
          where session_id = p_session_id and player_id is distinct from p_controller_id;
        end if;
        foreach v_rid in array coalesce(v_recipients, array[]::uuid[]) loop
          if v_rid is not null then
            update public.game_session_players
            set counters = case when v_all then counters - v_counter_type
                                else public.adjust_counter_bag(counters, v_counter_type, v_eff_amount) end
            where session_id = p_session_id and player_id = v_rid;
          end if;
        end loop;
        perform public.maybe_finish_game_session(p_session_id);
      end if;

    elsif v_eff_type = 'draw' then
      if p_controller_id is not null then
        for v_draw_i in 1..greatest(1, v_eff_amount) loop
          select coalesce(max(zone_position), -1) + 1 into v_next_hand_position
          from public.game_cards
          where session_id = p_session_id and owner_id = p_controller_id and zone = 'hand';
          select id into v_lib_card
          from public.game_cards
          where session_id = p_session_id and owner_id = p_controller_id and zone = 'library'
          order by zone_position asc, id asc limit 1 for update skip locked;
          exit when v_lib_card is null;
          update public.game_cards
          set zone = 'hand', zone_position = v_next_hand_position, is_tapped = false
          where id = v_lib_card;
        end loop;
      end if;

    elsif v_eff_type = 'mill' then
      if v_eff_amount > 0 then
        v_milled_type := v_effect ->> 'if_milled_type';
        v_milled_type_hit := false;
        if v_recipient = 'controller' or v_recipient = '' then
          v_recipients := array[p_controller_id];
        elsif v_recipient in ('each_player', 'all_players') then
          select array_agg(player_id) into v_recipients
          from public.game_session_players where session_id = p_session_id;
        else
          select array_agg(player_id) into v_recipients
          from public.game_session_players
          where session_id = p_session_id and player_id is distinct from p_controller_id;
        end if;
        foreach v_rid in array coalesce(v_recipients, array[]::uuid[]) loop
          if v_rid is not null then
            for v_draw_i in 1..v_eff_amount loop
              select coalesce(max(zone_position), -1) + 1 into v_next_graveyard_position
              from public.game_cards
              where session_id = p_session_id and owner_id = v_rid and zone = 'graveyard';
              select id into v_lib_card
              from public.game_cards
              where session_id = p_session_id and owner_id = v_rid and zone = 'library'
              order by zone_position asc, id asc limit 1 for update skip locked;
              exit when v_lib_card is null;
              if v_milled_type is not null and exists (
                select 1 from public.game_cards g join public.cards c on c.id = g.card_id
                where g.id = v_lib_card and c.type_line ilike '%' || v_milled_type || '%'
              ) then
                v_milled_type_hit := true;
              end if;
              update public.game_cards
              set zone = 'graveyard', zone_position = v_next_graveyard_position, is_tapped = false
              where id = v_lib_card;
            end loop;
          end if;
        end loop;
        if v_milled_type is not null and v_milled_type_hit then
          perform public.apply_triggered_ability_effects(
            p_session_id, p_controller_id, p_source_card_id, coalesce(v_effect -> 'then', '[]'::jsonb));
        end if;
      end if;

    elsif v_eff_type = 'create_token' then
      -- A dynamic count object ({count:{count:'...'}}) resolves via the amount
      -- engine and is NOT floored at 1 — zero matches makes zero tokens (Gadrak
      -- with no nontoken deaths). A literal/absent count keeps the floor-at-1.
      if jsonb_typeof(v_effect -> 'count') = 'object' then
        v_token_count := public.resolve_dynamic_amount(
          p_session_id, p_source_card_id, p_controller_id, v_effect -> 'count');
      else
        v_token_count := greatest(1, coalesce((v_effect ->> 'count')::integer, 1));
      end if;
      v_token_recipient := coalesce(nullif(v_effect ->> 'recipient_player_id', '')::uuid, p_controller_id);
      select id into v_token_card_id
      from public.cards
      where lower(name) = lower(coalesce(v_effect ->> 'token', '')) and is_token = true
      limit 1;
      if found and v_token_recipient is not null then
        select turn_number into v_turn_number
        from public.game_turn_state where session_id = p_session_id;
        for v_i in 1..least(v_token_count, 20) loop
          select coalesce(max(zone_position), -1) + 1 into v_next_pos
          from public.game_cards
          where session_id = p_session_id and owner_id = v_token_recipient and zone = 'battlefield';
          insert into public.game_cards (
            session_id, card_id, owner_id, controller_player_id,
            zone, zone_position, is_tapped, damage_marked,
            position_x, position_y, entered_battlefield_turn_number
          )
          values (
            p_session_id, v_token_card_id, v_token_recipient, v_token_recipient,
            'battlefield', v_next_pos, coalesce((v_effect ->> 'tapped')::boolean, false), 0, 0, 0, coalesce(v_turn_number, 0)
          )
          returning id into v_new_token_id;
          -- set_pt (mig 260, Quartzwood Crasher: "an X/X token where X is the
          -- damage dealt"): an unexpiring set_pt row pins the token's base P/T
          -- (the manifest 2/2 pattern). 'event_amount' was already rewritten to
          -- a number by apply_trigger_effects; ignore anything non-numeric.
          if jsonb_typeof(v_effect -> 'set_pt') = 'number' then
            insert into public.game_continuous_effects (
              session_id, source_card_id, affected_card_id, effect_type, payload, source_zone_required
            ) values (
              p_session_id, v_new_token_id, v_new_token_id, 'set_pt',
              jsonb_build_object('power', (v_effect ->> 'set_pt')::integer,
                                 'toughness', (v_effect ->> 'set_pt')::integer),
              'battlefield'
            );
          end if;
          perform public.register_card_continuous_effects(p_session_id, v_new_token_id);
        end loop;
      end if;

    elsif v_eff_type = 'deal_damage_all' then
      -- Mass damage (mig 224): N damage to every creature matching the filter,
      -- optionally to planeswalkers too. filter.with_keyword/without_keyword
      -- gate on flying (Harbinger); filter.exclude_source skips this card
      -- ("each OTHER creature"). One lethal sweep at the end (per-hit sweep off).
      if v_eff_amount > 0 then
        for v_dmg_target in
          select gc.id
          from public.game_cards gc join public.cards c on c.id = gc.card_id
          where gc.session_id = p_session_id and gc.zone = 'battlefield'
            and c.type_line ilike '%creature%'
            and (not coalesce((v_effect -> 'filter' ->> 'exclude_source')::boolean, false)
                 or gc.id is distinct from p_source_card_id)
            and ((v_effect -> 'filter' ->> 'without_keyword') is distinct from 'flying'
                 or not public.card_has_flying(p_session_id, gc.id))
            and ((v_effect -> 'filter' ->> 'with_keyword') is distinct from 'flying'
                 or public.card_has_flying(p_session_id, gc.id))
        loop
          perform public.apply_damage_to_creature(
            p_session_id, v_dmg_target, v_eff_amount, p_source_card_id, false, false, false);
        end loop;

        if lower(coalesce(v_effect ->> 'targets', 'creatures')) = 'creatures_planeswalkers' then
          for v_dmg_target in
            select gc.id
            from public.game_cards gc join public.cards c on c.id = gc.card_id
            where gc.session_id = p_session_id and gc.zone = 'battlefield'
              and c.type_line ilike '%planeswalker%'
          loop
            perform public.apply_damage_to_planeswalker(p_session_id, v_dmg_target, v_eff_amount);
          end loop;
        end if;

        perform public.move_lethal_damaged_creatures_to_graveyard(p_session_id);
        perform public.move_zero_loyalty_planeswalkers_to_graveyard(p_session_id);
      end if;

    elsif v_eff_type = 'amass' then
      if p_controller_id is not null and v_eff_amount > 0 then
        perform public.amass(p_session_id, p_controller_id, v_eff_amount);
      end if;

    elsif v_eff_type = 'destroy_all' then
      if p_controller_id is not null then
        if nullif(v_effect ->> 'exclude_type', '') is not null then
          -- "Destroy all non-<type> creatures" (mig 256, Wakening Sun's
          -- Avatar). Indestructible survives, mirroring destroy_all_creatures.
          for v_dmg_target in
            select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
            where gc.session_id = p_session_id and gc.zone = 'battlefield'
              and c.type_line ilike '%creature%'
              and c.type_line not ilike '%' || (v_effect ->> 'exclude_type') || '%'
              and not public.card_has_indestructible(p_session_id, gc.id)
          loop
            perform public.put_in_graveyard(p_session_id, v_dmg_target);
          end loop;
        else
          perform public.destroy_all_creatures(
            p_session_id, p_controller_id,
            nullif(v_effect ->> 'creature_type', ''),
            lower(coalesce(v_effect ->> 'scope', 'all')));
        end if;
      end if;

    elsif v_eff_type = 'return_all_from_graveyard' then
      if p_controller_id is not null then
        -- from:'all_graveyards' (mig 214, Grimoire of the Dead) sweeps EVERY
        -- graveyard and puts the cards under the controller's control.
        perform public.return_all_from_graveyard(
          p_session_id, p_controller_id,
          nullif(v_effect ->> 'creature_type', ''),
          lower(coalesce(v_effect ->> 'to', 'battlefield')),
          lower(coalesce(v_effect ->> 'from', '')) = 'all_graveyards');
      end if;

    elsif v_eff_type = 'add_counters' then
      v_counter_type := v_effect ->> 'counter_type';
      v_all := coalesce((v_effect ->> 'all')::boolean, false);
      if p_source_card_id is not null and (v_eff_amount <> 0 or v_all) then
        if v_eff_amount > 0 then
          v_eff_amount := v_eff_amount * public.counter_factor(
            p_session_id,
            (select controller_player_id from public.game_cards
             where id = p_source_card_id and session_id = p_session_id));
        end if;
        if public.is_plus_one_counter(v_counter_type) then
          update public.game_cards
          set plus_one_counters = case when v_all then 0 else greatest(0, plus_one_counters + v_eff_amount) end
          where id = p_source_card_id and session_id = p_session_id and zone = 'battlefield';
        else
          update public.game_cards
          set counters = case when v_all then counters - lower(v_counter_type)
                              else public.adjust_counter_bag(counters, lower(v_counter_type), v_eff_amount) end
          where id = p_source_card_id and session_id = p_session_id and zone = 'battlefield';
        end if;
        perform public.recheck_counter_state(p_session_id);
      end if;

    elsif v_eff_type = 'add_counters_all' then
      v_counter_type := v_effect ->> 'counter_type';
      v_all := coalesce((v_effect ->> 'all')::boolean, false);
      if (v_eff_amount <> 0 or v_all) and p_controller_id is not null then
        v_target_controller := public.behavior_target_controller(v_effect || jsonb_build_object(
          'target_controller', coalesce(v_effect ->> 'target_controller', 'you')
        ));
        if public.is_plus_one_counter(v_counter_type) then
          update public.game_cards gc
          set plus_one_counters = case when v_all then 0
            else greatest(0, gc.plus_one_counters
              + case when v_eff_amount > 0
                     then v_eff_amount * public.counter_factor(p_session_id, gc.controller_player_id)
                     else v_eff_amount end) end
          from public.cards c
          where c.id = gc.card_id and gc.session_id = p_session_id and gc.zone = 'battlefield'
            and c.type_line ilike '%creature%'
            -- "each OTHER creature you control" (mig 256, Bellowing Aegisaur).
            and (not coalesce((v_effect ->> 'exclude_source')::boolean, false)
                 or gc.id is distinct from p_source_card_id)
            and (
              v_target_controller = 'any'
              or (v_target_controller = 'you' and gc.controller_player_id = p_controller_id)
              or (v_target_controller = 'opponent' and gc.controller_player_id is distinct from p_controller_id)
            );
        else
          update public.game_cards gc
          set counters = case when v_all then gc.counters - lower(v_counter_type)
            else public.adjust_counter_bag(gc.counters, lower(v_counter_type),
              case when v_eff_amount > 0
                   then v_eff_amount * public.counter_factor(p_session_id, gc.controller_player_id)
                   else v_eff_amount end) end
          from public.cards c
          where c.id = gc.card_id and gc.session_id = p_session_id and gc.zone = 'battlefield'
            and c.type_line ilike '%creature%'
            and (
              v_target_controller = 'any'
              or (v_target_controller = 'you' and gc.controller_player_id = p_controller_id)
              or (v_target_controller = 'opponent' and gc.controller_player_id is distinct from p_controller_id)
            );
        end if;
        perform public.recheck_counter_state(p_session_id);
      end if;

    elsif v_eff_type in ('tap_all', 'untap_all') then
      if p_controller_id is not null then
        v_target_controller := public.behavior_target_controller(v_effect || jsonb_build_object(
          'target_controller', coalesce(v_effect ->> 'target_controller', 'you')
        ));
        -- card_type (mig 258, Zacama: "untap all lands you control") widens the
        -- default creature scope to any type-line match.
        update public.game_cards gc
        set is_tapped = (v_eff_type = 'tap_all')
        from public.cards c
        where c.id = gc.card_id and gc.session_id = p_session_id and gc.zone = 'battlefield'
          and c.type_line ilike '%' || coalesce(v_effect ->> 'card_type', 'creature') || '%'
          and (
            v_target_controller = 'any'
            or (v_target_controller = 'you' and gc.controller_player_id = p_controller_id)
            or (v_target_controller = 'opponent' and gc.controller_player_id is distinct from p_controller_id)
          );
      end if;

    elsif v_eff_type = 'grant_cast_from_graveyard' then
      if p_controller_id is not null then
        -- card_id (mig 215, Havengul Lich): the permission covers ONE specific
        -- graveyard card instead of a type filter.
        insert into public.game_continuous_effects (
          session_id, source_card_id, affected_player_id, effect_type, payload,
          expires_at_phase, expires_at_step
        )
        values (
          p_session_id, p_source_card_id, p_controller_id, 'cast_from_graveyard',
          jsonb_strip_nulls(jsonb_build_object(
            'type_line', coalesce(v_effect ->> 'type_line', ''),
            'card_id', v_effect ->> 'card_id')),
          'ending', 'cleanup'
        );
      end if;

    elsif v_eff_type = 'monstrosity' then
      -- "Monstrosity N" (Stormbreath Dragon): if this permanent isn't monstrous,
      -- put N +1/+1 counters on it and it becomes monstrous (a once-marker in the
      -- counter bag), then apply its `on_monstrous` effects ("when this becomes
      -- monstrous, …"). A no-op when already monstrous.
      select coalesce((counters ->> 'monstrous')::integer, 0) into v_mon
      from public.game_cards where id = p_source_card_id and session_id = p_session_id;
      if coalesce(v_mon, 0) = 0 then
        update public.game_cards
        set plus_one_counters = coalesce(plus_one_counters, 0)
              + greatest(1, coalesce((v_effect ->> 'amount')::integer, 1)),
            counters = public.adjust_counter_bag(coalesce(counters, '{}'::jsonb), 'monstrous', 1)
        where id = p_source_card_id and session_id = p_session_id;
        if jsonb_typeof(v_effect -> 'on_monstrous') = 'array' then
          perform public.apply_triggered_ability_effects(
            p_session_id, p_controller_id, p_source_card_id, v_effect -> 'on_monstrous');
        end if;
      end if;

    elsif v_eff_type = 'damage_each_opponent_by_hand' then
      -- "deals damage to each opponent equal to the number of cards in that
      -- player's hand" (Stormbreath). Per-opponent, so it can't reuse the single
      -- v_eff_amount lose_life path.
      for v_rid in
        select player_id from public.game_session_players
        where session_id = p_session_id and player_id is distinct from p_controller_id
      loop
        select count(*)::integer into v_hand
        from public.game_cards
        where session_id = p_session_id and owner_id = v_rid and zone = 'hand';
        update public.game_session_players
        set life_total = greatest(0, life_total - coalesce(v_hand, 0))
        where session_id = p_session_id and player_id = v_rid;
      end loop;
      perform public.maybe_finish_game_session(p_session_id);

    elsif v_eff_type = 'impulse' then
      -- "Exile the top N cards of your library. Until the end of your next turn,
      -- you may play those cards." (Atsushi.) Move the cards to exile and write a
      -- card-specific play_from_exile permission for the controller; the cast path
      -- (cast_card_from_hand) honours it, and advance_step expires it at the end
      -- step of the controller's NEXT turn (created_turn < current turn).
      if p_controller_id is not null then
        select turn_number into v_turn_number
        from public.game_turn_state where session_id = p_session_id;
        select coalesce(max(zone_position), -1) into v_next_pos
        from public.game_cards
        where session_id = p_session_id and owner_id = p_controller_id and zone = 'exile';
        with top as (
          select id, row_number() over (order by zone_position asc, id asc) as rn
          from public.game_cards
          where session_id = p_session_id and owner_id = p_controller_id and zone = 'library'
          order by zone_position asc, id asc
          limit greatest(1, coalesce((v_effect ->> 'count')::integer, 1))
        )
        update public.game_cards gc
        set zone = 'exile', zone_position = v_next_pos + top.rn,
            controller_player_id = gc.owner_id, is_tapped = false, damage_marked = 0
        from top where gc.id = top.id;
        select array_agg(id) into v_exiled
        from public.game_cards
        where session_id = p_session_id and owner_id = p_controller_id and zone = 'exile'
          and zone_position > v_next_pos;
        if v_exiled is not null and array_length(v_exiled, 1) > 0 then
          insert into public.game_continuous_effects (
            session_id, source_card_id, affected_player_id, effect_type, payload
          ) values (
            p_session_id, p_source_card_id, p_controller_id, 'play_from_exile',
            jsonb_build_object(
              'card_ids', to_jsonb(v_exiled),
              'created_turn', coalesce(v_turn_number, 0))
          );
        end if;
      end if;

    elsif v_eff_type = 'grant_keyword_all' then
      -- Mass keyword until end of turn (mig 202). scope 'controller' => only
      -- that player's permanents (affected_player_id set); 'all' (default) =>
      -- everyone's. creature_type filters by subtype (omit for all). Only the
      -- grantable combat keywords (the mig 200 accessor set) are accepted.
      if lower(coalesce(v_effect ->> 'keyword', '')) in (
        'flying', 'reach', 'deathtouch', 'trample', 'vigilance', 'haste',
        'indestructible', 'first_strike', 'double_strike', 'menace',
        'intimidate', 'hexproof'
      ) then
        insert into public.game_continuous_effects (
          session_id, source_card_id, affected_player_id, effect_type, payload,
          expires_at_phase, expires_at_step
        ) values (
          p_session_id, p_source_card_id,
          case when lower(coalesce(v_effect ->> 'scope', 'all')) = 'controller'
               then p_controller_id else null end,
          lower(v_effect ->> 'keyword'),
          jsonb_strip_nulls(jsonb_build_object(
            'creature_type', v_effect ->> 'creature_type',
            'includes_player',
            case when coalesce((v_effect ->> 'includes_player')::boolean, false)
                 then true else null end
          )),
          'ending', 'cleanup'
        );
      end if;

    elsif v_eff_type = 'return_self_to_hand' then
      -- "Return this permanent to its owner's hand" (Encroaching/Breaching
      -- Dragonstorm, when a Dragon you control enters).
      if p_source_card_id is not null then
        update public.game_cards gc
        set zone = 'hand',
            zone_position = (select coalesce(max(zone_position), -1) + 1 from public.game_cards
                             where session_id = p_session_id and owner_id = gc.owner_id and zone = 'hand'),
            controller_player_id = gc.owner_id, is_tapped = false, damage_marked = 0, plus_one_counters = 0
        where gc.id = p_source_card_id and gc.session_id = p_session_id and gc.zone = 'battlefield';
        perform public.rebuild_scripted_continuous_effects(p_session_id);
      end if;

    elsif v_eff_type = 'grant_keyword' then
      -- Untargeted single grant → the source permanent (Skarrgan's Riot haste
      -- mode). apply_creature_effect writes the keyword continuous effect.
      if p_source_card_id is not null then
        perform public.apply_creature_effect(p_session_id, 'grant_keyword', p_source_card_id, v_effect);
      end if;

    elsif v_eff_type = 'set_pt' then
      -- Untargeted set base P/T → the source (Nogi: "becomes 5/5 until EOT").
      if p_source_card_id is not null then
        perform public.apply_creature_effect(p_session_id, 'set_pt', p_source_card_id, v_effect);
      end if;

    elsif v_eff_type = 'become_monarch' then
      -- "You become the monarch" (mig 262, Regal Behemoth). The crown lives
      -- on game_turn_state; combat damage steals it (resolve_combat_damage)
      -- and the monarch draws at their end step (advance_step).
      if p_controller_id is not null then
        update public.game_turn_state
        set monarch_player_id = p_controller_id
        where session_id = p_session_id;
      end if;

    elsif v_eff_type = 'pump' then
      -- Untargeted self-pump (mig 258, Rampaging Brontodon: "whenever this
      -- attacks, it gets +1/+1 for each land you control"). Dynamic counts
      -- ({count:'lands_you_control'}) resolve against the ability's controller.
      if p_source_card_id is not null then
        perform public.apply_creature_effect(
          p_session_id, 'pump', p_source_card_id,
          v_effect || jsonb_build_object('acting_controller', p_controller_id));
      end if;

    elsif v_eff_type = 'conditional' then
      -- "If <condition>, <effects>." A count-based gate: resolve the condition's
      -- count ({count, type_line?}) and, when it meets `at_least`, recursively
      -- apply the inner effects through this same resolver. Inner effects are the
      -- non-decision vocabulary (lose_life/gain_life/draw/create_token/…).
      if public.resolve_dynamic_amount(
           p_session_id, p_source_card_id, p_controller_id, v_effect -> 'condition')
         >= coalesce((v_effect -> 'condition' ->> 'at_least')::integer, 1)
      then
        perform public.apply_triggered_ability_effects(
          p_session_id, p_controller_id, p_source_card_id,
          coalesce(v_effect -> 'effects', '[]'::jsonb));
      end if;

    elsif v_eff_type = 'curse_attack_zombie' then
      -- "Enchant player." Register the curse on the recipient player (the chosen
      -- enchanted player after choose_player), sourced from the curse card;
      -- declare_attacker reads it when that player is attacked. Only while the
      -- curse stays on the battlefield (source_zone_required).
      if p_controller_id is not null and p_source_card_id is not null then
        insert into public.game_continuous_effects (
          session_id, source_card_id, affected_player_id, effect_type, payload, source_zone_required)
        values (p_session_id, p_source_card_id, p_controller_id, 'curse_attacked', '{}'::jsonb, 'battlefield');
      end if;
    end if;
    -- Unknown effect types are ignored (forward-compatible).
  end loop;
end;
$$;
grant execute on function public.apply_triggered_ability_effects(uuid, uuid, uuid, jsonb) to authenticated;

create or replace function public.activate_mana_ability(
  p_session_id uuid,
  p_source_card_id uuid,
  p_ability_index integer default 0,
  p_generic_payment jsonb default null,
  -- The colour chosen for an "any colour" producer (Treasure, mig 226).
  p_chosen_color text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_zone text;
  v_script jsonb;
  v_ability jsonb;
  v_cost jsonb;
  v_effect jsonb;
  v_has_tap boolean := false;
  v_has_sac boolean := false;
  v_mana_cost text := null;
  v_life_cost integer := 0;
  v_player_life integer;
  v_color text;
  v_amount integer;
  v_pool jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select game_cards.zone
  into v_zone
  from public.game_cards
  where game_cards.id = p_source_card_id
    and game_cards.session_id = p_session_id
    and game_cards.owner_id = auth.uid();
  if not found then
    raise exception 'Source card not found or not owned by current user';
  end if;
  if v_zone <> 'battlefield' then
    raise exception 'Mana ability source must be on the battlefield';
  end if;

  v_script := public.effective_script(p_session_id, p_source_card_id);
  v_ability := v_script -> 'activated_abilities' -> p_ability_index;
  if v_ability is null then
    raise exception 'Activated ability not found at index %', p_ability_index;
  end if;
  if not coalesce((v_ability ->> 'is_mana_ability')::boolean, false) then
    raise exception 'Not a mana ability';
  end if;

  -- Parse costs (tap_self / mana / pay_life).
  for v_cost in select * from jsonb_array_elements(coalesce(v_ability -> 'costs', '[]'::jsonb))
  loop
    case v_cost ->> 'type'
      when 'tap_self' then v_has_tap := true;
      when 'sacrifice_self' then v_has_sac := true;
      when 'mana' then v_mana_cost := v_cost ->> 'amount';
      when 'pay_life' then v_life_cost := greatest(0, coalesce((v_cost ->> 'amount')::integer, 0));
      else raise exception 'Unsupported mana-ability cost: %', v_cost ->> 'type';
    end case;
  end loop;

  if v_has_tap and exists (
    select 1 from public.game_cards where id = p_source_card_id and is_tapped = true
  ) then
    raise exception 'Source is already tapped';
  end if;

  -- Life cost (CR 119.4): the player must have at least that much life to pay it.
  if v_life_cost > 0 then
    select life_total into v_player_life
    from public.game_session_players
    where session_id = p_session_id and player_id = auth.uid();
    if coalesce(v_player_life, 0) < v_life_cost then
      raise exception 'Not enough life to pay % life (have %)', v_life_cost, coalesce(v_player_life, 0);
    end if;
  end if;

  -- Pay the activation mana cost (the {1}) BEFORE producing.
  if v_mana_cost is not null and btrim(v_mana_cost) <> '' then
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_mana_cost, p_generic_payment);
  end if;

  -- Pay the life cost.
  if v_life_cost > 0 then
    update public.game_session_players
    set life_total = life_total - v_life_cost
    where session_id = p_session_id and player_id = auth.uid();
  end if;

  if v_has_tap then
    update public.game_cards
    set is_tapped = true
    where id = p_source_card_id and session_id = p_session_id;
  end if;

  -- Ensure a pool row exists, then add every add_mana effect's mana.
  insert into public.game_players (session_id, player_id, mana_pool)
  values (p_session_id, auth.uid(), jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0))
  on conflict (session_id, player_id) do nothing;

  select coalesce(mana_pool, jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0))
  into v_pool
  from public.game_players
  where session_id = p_session_id and player_id = auth.uid()
  for update;

  for v_effect in select * from jsonb_array_elements(coalesce(v_ability -> 'effects', '[]'::jsonb))
  loop
    if lower(coalesce(v_effect ->> 'type', '')) = 'add_mana' then
      v_color := upper(coalesce(v_effect ->> 'color', 'C'));
      -- "Any colour" (Treasure, mig 226): the caller picks the colour.
      if v_color = 'ANY' then
        v_color := upper(coalesce(p_chosen_color, ''));
        if v_color not in ('W', 'U', 'B', 'R', 'G', 'C') then
          raise exception 'Choose a colour for this mana ability';
        end if;
      elsif v_color not in ('W', 'U', 'B', 'R', 'G', 'C') then
        raise exception 'A multi-mana ability must produce fixed colours (got %)', v_color;
      end if;
      v_amount := greatest(1, coalesce((v_effect ->> 'amount')::integer, 1));
      v_pool := v_pool || jsonb_build_object(v_color, coalesce((v_pool ->> v_color)::integer, 0) + v_amount);
    end if;
  end loop;

  -- Monarch land bonus (mig 262, Regal Behemoth: "whenever you tap a land for
  -- mana while you're the monarch, add an additional one mana of any color").
  -- Approximations: the bonus is one mana of the colour this ability just
  -- produced (no separate colour pick), once per activation.
  if v_color is not null
     and v_has_tap
     and exists (select 1 from public.game_turn_state ts
                 where ts.session_id = p_session_id and ts.monarch_player_id = auth.uid())
     and exists (select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
                 where gc.id = p_source_card_id and gc.session_id = p_session_id
                   and c.type_line ilike '%land%')
     and exists (select 1 from public.game_cards gc
                 where gc.session_id = p_session_id and gc.zone = 'battlefield'
                   and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
                   and coalesce((public.effective_script(p_session_id, gc.id) ->> 'monarch_land_bonus')::boolean, false))
  then
    v_pool := v_pool || jsonb_build_object(v_color, coalesce((v_pool ->> v_color)::integer, 0) + 1);
  end if;

  update public.game_players
  set mana_pool = v_pool
  where session_id = p_session_id and player_id = auth.uid();

  -- Sacrifice cost (mig 226, Treasure): the source goes to the graveyard after
  -- producing — a token then ceases to exist via the usual cleanup trigger.
  if v_has_sac then
    perform public.put_in_graveyard(p_session_id, p_source_card_id);
  end if;

  return v_pool;
end;
$$;
grant execute on function public.activate_mana_ability(uuid, uuid, integer, jsonb, text) to authenticated;

create or replace function public.add_mana_from_card(
  p_game_card_id uuid,
  p_session_id uuid,
  p_player_id uuid,
  p_color text,
  p_amount integer,
  p_should_tap_card boolean default true,
  p_commander_identity boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_current_pool jsonb;
  v_new_pool jsonb;
  v_current_amount integer;
  v_commander_card_id uuid;
  v_identity text[];
  v_color_name text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_color not in ('W', 'U', 'B', 'R', 'G', 'C') then
    raise exception 'Invalid mana color: %', p_color;
  end if;

  if p_amount <= 0 then
    raise exception 'Mana amount must be positive';
  end if;

  if p_player_id <> auth.uid() then
    raise exception 'Cannot update another player mana pool';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  -- Commander-identity guard: the produced colour must be in the player's
  -- commander's colour identity. Colourless only when the commander has no colour.
  if p_commander_identity then
    select card_id into v_commander_card_id
    from public.game_cards
    where session_id = p_session_id and owner_id = p_player_id and is_commander = true
    limit 1;

    v_identity := coalesce(public.card_color_identity(v_commander_card_id), array[]::text[]);
    v_color_name := case p_color
      when 'W' then 'white' when 'U' then 'blue' when 'B' then 'black'
      when 'R' then 'red' when 'G' then 'green' else null end;

    if v_color_name is not null then
      if not (v_color_name = any (v_identity)) then
        raise exception 'Mana colour % is not in your commander''s colour identity', p_color;
      end if;
    elsif p_color = 'C' and array_length(v_identity, 1) is not null then
      raise exception 'This source produces a colour in your commander''s identity, not colourless';
    end if;
  end if;

  select status
  into v_session_status
  from public.game_sessions
  where id = p_session_id;

  if not found then
    raise exception 'Game session not found';
  end if;

  if v_session_status = 'finished' then
    raise exception 'Cannot add mana in a finished game session';
  end if;

  if p_should_tap_card then
    update public.game_cards
    set is_tapped = true
    where id = p_game_card_id
      and session_id = p_session_id
      and owner_id = auth.uid()
      and zone = 'battlefield'
      and is_tapped = false;

    if not found then
      raise exception 'Card not found, not on battlefield, not owned by current user, or already tapped';
    end if;
  else
    perform 1
    from public.game_cards
    where id = p_game_card_id
      and session_id = p_session_id
      and owner_id = auth.uid()
      and zone = 'battlefield';

    if not found then
      raise exception 'Card not found, not on battlefield, or not owned by current user';
    end if;
  end if;

  insert into public.game_players (session_id, player_id, mana_pool)
  values (
    p_session_id,
    p_player_id,
    jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0)
  )
  on conflict (session_id, player_id) do nothing;

  select coalesce(
    mana_pool,
    jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0)
  )
  into v_current_pool
  from public.game_players
  where session_id = p_session_id
    and player_id = p_player_id
  for update;

  v_current_amount := coalesce((v_current_pool ->> p_color)::integer, 0);
  v_new_pool := v_current_pool || jsonb_build_object(p_color, v_current_amount + p_amount);

  -- Monarch land bonus (mig 262, Regal Behemoth) — mirrored from
  -- activate_mana_ability for the basic-land tap path: tapping a LAND for
  -- mana while you're the monarch adds one extra mana of the same colour
  -- (approximation: no separate colour pick).
  if p_should_tap_card
     and exists (select 1 from public.game_turn_state ts
                 where ts.session_id = p_session_id and ts.monarch_player_id = auth.uid())
     and exists (select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
                 where gc.id = p_game_card_id and gc.session_id = p_session_id
                   and c.type_line ilike '%land%')
     and exists (select 1 from public.game_cards gc
                 where gc.session_id = p_session_id and gc.zone = 'battlefield'
                   and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
                   and coalesce((public.effective_script(p_session_id, gc.id) ->> 'monarch_land_bonus')::boolean, false))
  then
    v_new_pool := v_new_pool || jsonb_build_object(p_color, coalesce((v_new_pool ->> p_color)::integer, 0) + 1);
  end if;

  update public.game_players
  set mana_pool = v_new_pool
  where session_id = p_session_id
    and player_id = p_player_id;

  return v_new_pool;
end;
$$;

grant all on function public.add_mana_from_card(uuid, uuid, uuid, text, integer, boolean, boolean) to anon, authenticated, service_role;

create or replace function public.advance_step(p_session_id uuid)
returns public.game_turn_state
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_state public.game_turn_state;
  v_session_status text;
  v_required_player_id uuid;
  v_next_active_player_id uuid;
  v_next_priority_player_id uuid;
  v_next_phase text;
  v_next_step text;
  v_next_turn_number integer;
  v_next_lands_played_this_turn integer;
  v_drawn_card_id uuid;
  v_next_hand_position integer;
  v_revert uuid;
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
    raise exception 'Cannot advance a finished game session';
  end if;

  select *
  into v_current_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  v_required_player_id := coalesce(v_current_state.priority_player_id, v_current_state.active_player_id);

  if v_required_player_id <> auth.uid() then
    raise exception 'Only the priority player can advance the step';
  end if;

  perform public.clear_mana_pool_for_step(
    p_session_id,
    v_current_state.phase,
    v_current_state.step
  );

  perform public.expire_continuous_effects_for_step(
    p_session_id,
    v_current_state.turn_number,
    v_current_state.phase,
    v_current_state.step
  );

  -- Impulse play windows (mig 230, Atsushi: "until the end of your next turn").
  -- A play_from_exile permission survives the turn it was created in and expires
  -- when its owner leaves the end step of a LATER turn (their next turn).
  if v_current_state.step = 'end' then
    delete from public.game_continuous_effects ce
    where ce.session_id = p_session_id
      and ce.effect_type = 'play_from_exile'
      and ce.affected_player_id = v_current_state.active_player_id
      and coalesce((ce.payload ->> 'created_turn')::integer, 0) < v_current_state.turn_number;

    -- Territorial Hellkite (mig 249): an unconsumed must_attack pin lapses
    -- when the combat is over (end step).
    update public.game_cards
    set counters = counters - 'must_attack'
    where session_id = p_session_id and counters ? 'must_attack';

    -- Hellkite Courser (mig 248): "return it to the command zone at the
    -- beginning of the next end step" — processed when the end step is left.
    for v_revert in
      select gc.id from public.game_cards gc
      where gc.session_id = p_session_id and gc.zone = 'battlefield'
        and gc.counters ? 'return_to_command'
    loop
      update public.game_cards gc
      set zone = 'command', is_tapped = false, damage_marked = 0,
          controller_player_id = gc.owner_id,
          counters = gc.counters - 'return_to_command',
          zone_position = (select coalesce(max(zone_position), -1) + 1
                           from public.game_cards x
                           where x.session_id = p_session_id and x.owner_id = gc.owner_id
                             and x.zone = 'command')
      where gc.id = v_revert;
    end loop;

    -- Become-copy "until end of turn" (mig 240, Sarkhan, Soul Aflame): revert
    -- when the end step is left. Every effect row the copy sources is dropped
    -- (incl. the except-keyword grants), card_id flips back to the original,
    -- and the re-register restores the original's script effects.
    for v_revert in
      select gc.id from public.game_cards gc
      where gc.session_id = p_session_id and gc.zone = 'battlefield'
        and gc.copy_revert_at_turn is not null
        and gc.copy_revert_at_turn <= v_current_state.turn_number
    loop
      delete from public.game_continuous_effects
      where session_id = p_session_id and source_card_id = v_revert;
      update public.game_cards
      set card_id = copy_original_card_id,
          copied_script = null,
          copy_original_card_id = null,
          copy_revert_at_turn = null
      where id = v_revert;
      perform public.register_card_continuous_effects(p_session_id, v_revert);
    end loop;
  end if;

  v_next_active_player_id := v_current_state.active_player_id;
  v_next_priority_player_id := v_current_state.active_player_id;
  v_next_turn_number := v_current_state.turn_number;
  v_next_lands_played_this_turn := coalesce(v_current_state.lands_played_this_turn, 0);
  v_next_phase := v_current_state.phase;
  v_next_step := v_current_state.step;

  case v_current_state.step
    when 'untap' then
      delete from public.game_combat_assignments
      where session_id = p_session_id;

      -- Exert (mig 236, Glorybringer): an exerted creature "won't untap during
      -- your next untap step." Skip untapping it this once, then clear the marker
      -- so it untaps normally next time.
      update public.game_cards
      set is_tapped = false
      where session_id = p_session_id
        and owner_id = v_current_state.active_player_id
        and zone = 'battlefield'
        and is_tapped = true
        and coalesce((counters ->> 'exerted')::integer, 0) = 0;

      update public.game_cards
      set counters = counters - 'exerted'
      where session_id = p_session_id
        and owner_id = v_current_state.active_player_id
        and zone = 'battlefield'
        and counters ? 'exerted';

      v_next_phase := 'beginning';
      v_next_step := 'upkeep';
    when 'upkeep' then
      v_next_phase := 'beginning';
      v_next_step := 'draw';
    when 'draw' then
      if coalesce(v_current_state.skip_next_draw, false) then
        -- CR 103.8a (mig 221): in a TWO-player game the starting player skips
        -- the draw step of their first turn. start_game_session sets the flag;
        -- consume it instead of drawing.
        update public.game_turn_state
        set skip_next_draw = false
        where session_id = p_session_id;
      else
        select coalesce(max(zone_position), -1) + 1
        into v_next_hand_position
        from public.game_cards
        where session_id = p_session_id
          and owner_id = v_current_state.active_player_id
          and zone = 'hand';

        select id
        into v_drawn_card_id
        from public.game_cards
        where session_id = p_session_id
          and owner_id = v_current_state.active_player_id
          and zone = 'library'
        order by zone_position asc, id asc
        limit 1
        for update skip locked;

        if v_drawn_card_id is null then
          raise exception 'Library is empty';
        end if;

        update public.game_cards
        set
          zone = 'hand',
          zone_position = v_next_hand_position,
          is_tapped = false,
          damage_marked = 0
        where id = v_drawn_card_id;
      end if;

      v_next_phase := 'main_1';
      v_next_step := 'precombat_main';
    when 'precombat_main' then
      v_next_phase := 'combat';
      v_next_step := 'beginning_of_combat';
    when 'beginning_of_combat' then
      v_next_phase := 'combat';
      v_next_step := 'declare_attackers';
    when 'declare_attackers' then
      v_next_phase := 'combat';
      v_next_step := 'declare_blockers';

      select defending_player_id
      into v_next_priority_player_id
      from public.game_combat_assignments
      where session_id = p_session_id
        and turn_number = v_current_state.turn_number
        and blocker_card_id is null
      order by created_at
      limit 1;

      v_next_priority_player_id := coalesce(v_next_priority_player_id, v_current_state.active_player_id);
    when 'declare_blockers' then
      -- Menace: a blocked attacker with menace must have two or more blockers.
      -- Checked here (block declaration is finished) — a lone blocker is illegal.
      -- Blockers live one-row-per-blocker in game_combat_blockers.
      if exists (
        select 1
        from public.game_combat_blockers cb
        where cb.session_id = p_session_id
          and cb.turn_number = v_current_state.turn_number
          and public.card_has_menace(p_session_id, cb.attacker_card_id)
        group by cb.attacker_card_id
        having count(*) = 1
      ) then
        raise exception 'A creature with menace must be blocked by two or more creatures';
      end if;

      v_next_priority_player_id := v_current_state.active_player_id;
      v_next_phase := 'combat';
      v_next_step := 'combat_damage';
    when 'combat_damage' then
      v_next_phase := 'combat';
      v_next_step := 'end_of_combat';
    when 'end_of_combat' then
      delete from public.game_combat_assignments
      where session_id = p_session_id;

      -- Extra combat phase (mig 250, Scourge of the Throne): consume one
      -- pending extra combat and loop back instead of moving to main 2.
      if coalesce(v_current_state.extra_combats, 0) > 0 then
        update public.game_turn_state
        set extra_combats = extra_combats - 1
        where session_id = p_session_id;
        v_next_phase := 'combat';
        v_next_step := 'beginning_of_combat';
      else
        v_next_phase := 'main_2';
        v_next_step := 'postcombat_main';
      end if;
    when 'postcombat_main' then
      v_next_phase := 'ending';
      v_next_step := 'end';
      -- Monarch draw (mig 262, Regal Behemoth): "at the beginning of the
      -- monarch's end step, that player draws a card." Best-effort: an empty
      -- library skips the draw instead of erroring.
      if v_current_state.monarch_player_id = v_current_state.active_player_id then
        select id into v_drawn_card_id
        from public.game_cards
        where session_id = p_session_id
          and owner_id = v_current_state.active_player_id and zone = 'library'
        order by zone_position asc, id asc
        limit 1;
        if v_drawn_card_id is not null then
          select coalesce(max(zone_position), -1) + 1 into v_next_hand_position
          from public.game_cards
          where session_id = p_session_id
            and owner_id = v_current_state.active_player_id and zone = 'hand';
          update public.game_cards
          set zone = 'hand', zone_position = v_next_hand_position, is_tapped = false
          where id = v_drawn_card_id;
        end if;
      end if;
    when 'end' then
      v_next_phase := 'ending';
      v_next_step := 'cleanup';
    when 'cleanup' then
      delete from public.game_combat_assignments
      where session_id = p_session_id;

      update public.game_cards
      set damage_marked = 0
      where session_id = p_session_id
        and damage_marked <> 0;

      -- Hand the turn to the next LIVING player by seat order (skip eliminated).
      select next_player.player_id
      into v_next_active_player_id
      from public.game_session_players current_player
      join public.game_session_players next_player
        on next_player.session_id = current_player.session_id
       and next_player.seat_number > current_player.seat_number
       and next_player.life_total > 0
      where current_player.session_id = p_session_id
        and current_player.player_id = v_current_state.active_player_id
      order by next_player.seat_number
      limit 1;

      if v_next_active_player_id is null then
        select player_id
        into v_next_active_player_id
        from public.game_session_players
        where session_id = p_session_id
          and life_total > 0
        order by seat_number
        limit 1;
      end if;

      if v_next_active_player_id is null then
        raise exception 'No players found for game session';
      end if;

      v_next_priority_player_id := v_next_active_player_id;
      v_next_turn_number := v_current_state.turn_number + 1;
      v_next_lands_played_this_turn := 0;
      v_next_phase := 'beginning';
      v_next_step := 'untap';
    else
      raise exception 'Unsupported turn step: %', v_current_state.step;
  end case;

  update public.game_turn_state
  set
    active_player_id = v_next_active_player_id,
    priority_player_id = v_next_priority_player_id,
    priority_cycle_started_by = null,
    priority_pass_count = 0,
    lands_played_this_turn = v_next_lands_played_this_turn,
    turn_number = v_next_turn_number,
    phase = v_next_phase,
    step = v_next_step
  where session_id = p_session_id
  returning * into v_current_state;

  return v_current_state;
end;
$$;
grant execute on function public.advance_step(uuid) to authenticated;

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
  -- Dragon combat damage per damaged PLAYER (mig 247, Broodcaller Scourge /
  -- Parapet Thrasher): {player_id: total}. Attackers all belong to the
  -- active player, so the watcher controller is implicit.
  v_dragon_player_damage jsonb := '{}'::jsonb;
  v_dragon_key text;
  v_dragon_watcher uuid;
  -- Same tally for Dinosaurs (mig 256, Curious Altisaur).
  v_dino_player_damage jsonb := '{}'::jsonb;
  -- Same tally for TRAMPLE creatures (mig 260, Quartzwood Crasher).
  v_trample_player_damage jsonb := '{}'::jsonb;
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
      combat.defending_planeswalker_id,
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
        if v_assignment.defending_planeswalker_id is not null then
          -- Attacking a planeswalker: combat damage removes loyalty (no poison/toxic).
          perform public.apply_damage_to_planeswalker(
            p_session_id, v_assignment.defending_planeswalker_id, v_attacker_damage);
        else
          -- Unblocked: infect deals power as poison (no life); else normal damage.
          if v_attacker_has_infect then
            perform public.add_player_poison(p_session_id, v_assignment.defending_player_id, v_attacker_damage);
          else
            v_total_player_damage := v_total_player_damage + public.apply_damage_to_player(
              p_session_id, v_assignment.defending_player_id, v_attacker_damage,
              v_assignment.attacker_card_id, true
            );
            -- Dragon tally (mig 247).
            if exists (select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
                       where gc.id = v_assignment.attacker_card_id and c.type_line ilike '%dragon%') then
              v_dragon_player_damage := jsonb_set(v_dragon_player_damage,
                array[v_assignment.defending_player_id::text],
                to_jsonb(coalesce((v_dragon_player_damage ->> v_assignment.defending_player_id::text)::integer, 0)
                         + v_attacker_damage));
            end if;
            -- Dinosaur tally (mig 256).
            if exists (select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
                       where gc.id = v_assignment.attacker_card_id and c.type_line ilike '%dinosaur%') then
              v_dino_player_damage := jsonb_set(v_dino_player_damage,
                array[v_assignment.defending_player_id::text],
                to_jsonb(coalesce((v_dino_player_damage ->> v_assignment.defending_player_id::text)::integer, 0)
                         + v_attacker_damage));
            end if;
            -- Trample tally (mig 260, Quartzwood Crasher): damage dealt to a
            -- player by a creature WITH trample (unblocked included).
            if public.card_has_trample(p_session_id, v_assignment.attacker_card_id) then
              v_trample_player_damage := jsonb_set(v_trample_player_damage,
                array[v_assignment.defending_player_id::text],
                to_jsonb(coalesce((v_trample_player_damage ->> v_assignment.defending_player_id::text)::integer, 0)
                         + v_attacker_damage));
            end if;
            -- Per-attacker event (mig 261, Scion of Calamity: "whenever THIS
            -- creature deals combat damage to a player").
            perform public.fire_card_triggers(
              p_session_id, v_assignment.attacker_card_id,
              array['dealt_combat_damage_to_player'],
              jsonb_build_object('event_amount', v_attacker_damage,
                                 'event_player_id', v_assignment.defending_player_id));
            -- Monarch steal (mig 262): combat damage to the monarch crowns
            -- the attacking player.
            update public.game_turn_state
            set monarch_player_id = v_turn_state.active_player_id
            where session_id = p_session_id
              and monarch_player_id = v_assignment.defending_player_id;
          end if;
          -- Toxic N: poison in addition to dealing combat damage to the player.
          if v_attacker_toxic > 0 then
            perform public.add_player_poison(p_session_id, v_assignment.defending_player_id, v_attacker_toxic);
          end if;
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
          if v_assignment.defending_planeswalker_id is not null then
            -- Trample over from attacking a planeswalker → excess loyalty damage.
            perform public.apply_damage_to_planeswalker(
              p_session_id, v_assignment.defending_planeswalker_id, v_trample_amount);
          else
            -- Trample over to the player: infect → poison, else normal; toxic adds N.
            if v_attacker_has_infect then
              perform public.add_player_poison(p_session_id, v_assignment.defending_player_id, v_trample_amount);
            else
              v_total_player_damage := v_total_player_damage + public.apply_damage_to_player(
                p_session_id, v_assignment.defending_player_id, v_trample_amount,
                v_assignment.attacker_card_id, true
              );
              -- Dragon tally (mig 247).
              if exists (select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
                         where gc.id = v_assignment.attacker_card_id and c.type_line ilike '%dragon%') then
                v_dragon_player_damage := jsonb_set(v_dragon_player_damage,
                  array[v_assignment.defending_player_id::text],
                  to_jsonb(coalesce((v_dragon_player_damage ->> v_assignment.defending_player_id::text)::integer, 0)
                           + v_trample_amount));
              end if;
              -- Dinosaur tally (mig 256).
              if exists (select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
                         where gc.id = v_assignment.attacker_card_id and c.type_line ilike '%dinosaur%') then
                v_dino_player_damage := jsonb_set(v_dino_player_damage,
                  array[v_assignment.defending_player_id::text],
                  to_jsonb(coalesce((v_dino_player_damage ->> v_assignment.defending_player_id::text)::integer, 0)
                           + v_trample_amount));
              end if;
              -- Trample tally (mig 260): spillover is by definition trample damage.
              v_trample_player_damage := jsonb_set(v_trample_player_damage,
                array[v_assignment.defending_player_id::text],
                to_jsonb(coalesce((v_trample_player_damage ->> v_assignment.defending_player_id::text)::integer, 0)
                         + v_trample_amount));
              -- Per-attacker event (mig 261, Scion of Calamity).
              perform public.fire_card_triggers(
                p_session_id, v_assignment.attacker_card_id,
                array['dealt_combat_damage_to_player'],
                jsonb_build_object('event_amount', v_trample_amount,
                                   'event_player_id', v_assignment.defending_player_id));
              -- Monarch steal (mig 262).
              update public.game_turn_state
              set monarch_player_id = v_turn_state.active_player_id
              where session_id = p_session_id
                and monarch_player_id = v_assignment.defending_player_id;
            end if;
            if v_attacker_toxic > 0 then
              perform public.add_player_poison(p_session_id, v_assignment.defending_player_id, v_attacker_toxic);
            end if;
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
  -- A planeswalker reduced to 0 loyalty by combat damage dies.
  perform public.move_zero_loyalty_planeswalkers_to_graveyard(p_session_id);

  -- −1/−1 combat damage (wither/infect): run annihilation (CR 122.3) once at end.
  if v_minus_dealt then
    perform public.recheck_counter_state(p_session_id);
  end if;

  update public.game_cards
  set dealt_deathtouch_damage = false
  where session_id = p_session_id
    and dealt_deathtouch_damage = true;

  -- "Whenever one or more Dragons you control deal combat damage to a player"
  -- (mig 247, Broodcaller Scourge / Parapet Thrasher): one trigger per damaged
  -- player for each of the ACTIVE player's battlefield permanents whose script
  -- listens, carrying the total Dragon damage + the damaged player.
  for v_dragon_key in select jsonb_object_keys(v_dragon_player_damage)
  loop
    for v_dragon_watcher in
      select gc.id from public.game_cards gc
      where gc.session_id = p_session_id and gc.zone = 'battlefield'
        and coalesce(gc.controller_player_id, gc.owner_id) = v_turn_state.active_player_id
      order by gc.zone_position, gc.id
    loop
      perform public.fire_card_triggers(
        p_session_id, v_dragon_watcher, array['dragons_combat_damage'],
        jsonb_build_object(
          'event_amount', (v_dragon_player_damage ->> v_dragon_key)::integer,
          'event_player_id', v_dragon_key));
    end loop;
  end loop;

  -- Same broadcast for Dinosaurs (mig 256, Curious Altisaur). Batched per
  -- damaged player — "whenever a Dinosaur deals combat damage" fires once per
  -- player however many Dinosaurs connected (approximation).
  for v_dragon_key in select jsonb_object_keys(v_dino_player_damage)
  loop
    for v_dragon_watcher in
      select gc.id from public.game_cards gc
      where gc.session_id = p_session_id and gc.zone = 'battlefield'
        and coalesce(gc.controller_player_id, gc.owner_id) = v_turn_state.active_player_id
      order by gc.zone_position, gc.id
    loop
      perform public.fire_card_triggers(
        p_session_id, v_dragon_watcher, array['dinos_combat_damage'],
        jsonb_build_object(
          'event_amount', (v_dino_player_damage ->> v_dragon_key)::integer,
          'event_player_id', v_dragon_key));
    end loop;
  end loop;

  -- Same broadcast for trample damage (mig 260, Quartzwood Crasher:
  -- "whenever one or more creatures you control with trample deal combat
  -- damage to a player"). Batched per damaged player.
  for v_dragon_key in select jsonb_object_keys(v_trample_player_damage)
  loop
    for v_dragon_watcher in
      select gc.id from public.game_cards gc
      where gc.session_id = p_session_id and gc.zone = 'battlefield'
        and coalesce(gc.controller_player_id, gc.owner_id) = v_turn_state.active_player_id
      order by gc.zone_position, gc.id
    loop
      perform public.fire_card_triggers(
        p_session_id, v_dragon_watcher, array['trample_combat_damage'],
        jsonb_build_object(
          'event_amount', (v_trample_player_damage ->> v_dragon_key)::integer,
          'event_player_id', v_dragon_key));
    end loop;
  end loop;

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

create or replace function public.apply_trigger_effects(
  p_session_id uuid,
  p_stack_item_id uuid,
  p_start_index integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.game_stack_items;
  v_effects jsonb;
  v_target uuid;
  v_targets jsonb;
  v_tid uuid;
  v_controller uuid;
  v_count integer;
  v_i integer;
  v_effect jsonb;
  v_type text;
  v_amount integer;
  v_options jsonb;
  v_decision_id uuid;
  v_filter text;
  v_looked uuid[];
  v_name text;
  v_len integer;
  v_decider uuid;
  v_who text;
  v_queue jsonb;
  v_target_controller_player uuid;
  v_died_set uuid[];
  v_top_id uuid;
  v_top_type text;
  v_pos integer;
  v_turn integer;
begin
  select * into v_item from public.game_stack_items where id = p_stack_item_id;
  if not found then
    return null;
  end if;

  v_effects := coalesce(v_item.payload -> 'effects', '[]'::jsonb);
  v_target := nullif(v_item.payload ->> 'target_card_id', '')::uuid;
  v_targets := v_item.payload -> 'target_card_ids';
  v_controller := nullif(v_item.payload ->> 'controller_player_id', '')::uuid;
  -- Beast Within: capture the targets controller while it is still on the
  -- battlefield, before any effect (the destroy) moves it to the graveyard.
  v_target_controller_player := (select controller_player_id from public.game_cards
    where id = v_target and session_id = p_session_id and zone = 'battlefield');
  v_count := jsonb_array_length(v_effects);
  v_i := greatest(0, coalesce(p_start_index, 0));

  while v_i < v_count loop
    v_effect := v_effects -> v_i;
    v_type := lower(coalesce(v_effect ->> 'type', ''));
    -- "Its controller creates a token": route the create_token to the captured
    -- target controller instead of the caster.
    if v_type = 'create_token'
       and lower(coalesce(v_effect ->> 'recipient', '')) = 'target_controller'
       and v_target_controller_player is not null then
      v_effect := v_effect || jsonb_build_object('recipient_player_id', v_target_controller_player::text);
    end if;

    -- Dynamic token count from an edict tally (Syphon Flesh): count =
    -- {count:'sacrificed_this_way'} reads `sacrificed_count` accumulated on this
    -- stack item by submit_decision across the each-opponent sacrifice chain.
    if v_type = 'create_token'
       and jsonb_typeof(v_effect -> 'count') = 'object'
       and (v_effect -> 'count' ->> 'count') = 'sacrificed_this_way' then
      v_effect := v_effect || jsonb_build_object(
        'count', coalesce((v_item.payload ->> 'sacrificed_count')::integer, 0));
    end if;
    -- Zero sacrificed → create no tokens (the resolver floors count at 1).
    if v_type = 'create_token' and coalesce(v_effect ->> 'count', '') = '0' then
      v_i := v_i + 1; continue;
    end if;

    -- event_amount substitutions (mig 260, Wrathful Raptors / Quartzwood
    -- Crasher): the damage event's magnitude rides the trigger payload.
    -- amount:'event_amount' becomes the concrete number; create_token
    -- set_pt:'event_amount' likewise (zero damage → no token at all).
    if (v_effect ->> 'amount') = 'event_amount' then
      v_effect := v_effect || jsonb_build_object('amount',
        coalesce(nullif(v_item.payload ->> 'event_amount', '')::integer, 0));
    end if;
    if v_type = 'create_token' and (v_effect ->> 'set_pt') = 'event_amount' then
      if coalesce(nullif(v_item.payload ->> 'event_amount', '')::integer, 0) <= 0 then
        v_i := v_i + 1; continue;
      end if;
      v_effect := v_effect || jsonb_build_object('set_pt',
        (v_item.payload ->> 'event_amount')::integer);
    end if;

    -- amount {toughness_of:'triggering_creature'} (mig 256, Verdant Sun's
    -- Avatar: "you gain life equal to that creature's toughness").
    if jsonb_typeof(v_effect -> 'amount') = 'object'
       and (v_effect -> 'amount' ->> 'toughness_of') = 'triggering_creature'
       and nullif(v_item.payload ->> 'triggering_card_id', '') is not null then
      v_effect := v_effect || jsonb_build_object('amount',
        greatest(0, coalesce(public.card_effective_toughness(p_session_id,
          (v_item.payload ->> 'triggering_card_id')::uuid), 0)));
    end if;

    -- recipient:'triggering_controller' (mig 249, Vengeful Ancestor: "a
    -- goaded creature attacks → it deals 1 damage to ITS controller"): route
    -- the life loss to the event subject's controller.
    if v_type in ('lose_life', 'deal_damage')
       and lower(coalesce(v_effect ->> 'recipient', '')) = 'triggering_controller'
       and nullif(v_item.payload ->> 'triggering_card_id', '') is not null then
      v_effect := v_effect || jsonb_build_object('recipient_player_id',
        (select coalesce(gc.controller_player_id, gc.owner_id)::text
         from public.game_cards gc
         where gc.id = (v_item.payload ->> 'triggering_card_id')::uuid
           and gc.session_id = p_session_id));
    end if;

    if v_type = 'choose_one' then
      -- A modal trigger ("When X dies, choose one — …"). Park a choose_mode
      -- decision carrying the modes; submit_decision (trigger_modal branch)
      -- applies the chosen mode's untargeted actions, then resumes. Each mode is
      -- {label, actions:[…]} — same shape modal spells use.
      v_options := coalesce(v_effect -> 'modes', '[]'::jsonb);
      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'choose_mode',
        coalesce(v_effect ->> 'prompt', 'Choose one'),
        v_options,
        coalesce((v_effect ->> 'choose')::integer, 1),
        -- "If you control a commander as you cast this spell, you may choose
        -- both" (Will of the Temur, mig 239): the commander check raises the
        -- ceiling to every mode; the minimum stays at `choose`.
        case when coalesce((v_effect ->> 'may_choose_both_if_commander')::boolean, false)
              and public.resolve_count_amount(p_session_id, v_controller,
                    '{"count":"commanders_you_control"}'::jsonb) >= 1
             then jsonb_array_length(v_options)
             else coalesce((v_effect ->> 'choose')::integer, 1) end,
        jsonb_build_object('trigger_modal', true))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'divide_damage' then
      -- "Deal N damage divided as you choose among target …" from a TRIGGER
      -- (Dragonlord Atarka ETB). Park a divide_damage decision listing the legal
      -- targets; submit_decision validates the allocations (sum = N) and applies.
      v_options := public.divide_damage_options(p_session_id, v_controller, v_effect -> 'target_filter');
      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'divide_damage',
        'Divide ' || coalesce((v_effect ->> 'amount')::integer, 1) || ' damage',
        v_options, 1, jsonb_array_length(v_options),
        jsonb_build_object(
          'amount', coalesce((v_effect ->> 'amount')::integer, 1),
          'max_targets', nullif(v_effect ->> 'max_targets', '')::integer))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type in ('scry', 'surveil') then
      v_amount := coalesce((v_effect ->> 'amount')::integer, 1);
      select coalesce(
               jsonb_agg(jsonb_build_object('game_card_id', top.id, 'name', c.name, 'library_position', top.zone_position)
                 order by top.zone_position asc, top.id asc),
               '[]'::jsonb)
        into v_options
      from (
        select id, card_id, zone_position from public.game_cards
        where session_id = p_session_id and owner_id = v_controller and zone = 'library'
        order by zone_position asc, id asc limit v_amount
      ) top
      join public.cards c on c.id = top.card_id;

      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices)
      values (p_session_id, v_controller, p_stack_item_id, v_type, initcap(v_type) || ' ' || v_amount, v_options, 0, jsonb_array_length(v_options))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'search_library' then
      v_filter := v_effect -> 'filter' ->> 'type_line';
      v_name := v_effect -> 'filter' ->> 'name';
      -- type_line_any (mig 241, Farseek): OR over several type words
      -- ("a Plains, Island, Swamp, or Mountain card").
      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', lib.id, 'name', c.name) order by c.name, lib.id), '[]'::jsonb)
        into v_options
      from public.game_cards lib join public.cards c on c.id = lib.card_id
      where lib.session_id = p_session_id and lib.owner_id = v_controller and lib.zone = 'library'
        and (v_filter is null or c.type_line ilike '%' || v_filter || '%')
        and (jsonb_typeof(v_effect -> 'filter' -> 'type_line_any') is distinct from 'array'
             or exists (
               select 1 from jsonb_array_elements_text(v_effect -> 'filter' -> 'type_line_any') ta(t)
               where c.type_line ilike '%' || ta.t || '%'))
        and (v_name is null or c.name ilike '%' || v_name || '%');

      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'search_library',
        'Search your library'
          || case when v_filter is not null then ' for a ' || v_filter else '' end
          || case when v_name is not null then ' named ' || v_name else '' end,
        v_options, 0, coalesce((v_effect ->> 'count')::integer, 1),
        jsonb_build_object(
          'to', coalesce(v_effect ->> 'to', v_effect ->> 'destination', 'hand'),
          'tapped', coalesce((v_effect ->> 'tapped')::boolean, false),
          'reveal', coalesce((v_effect ->> 'reveal')::boolean, false)))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'discard' then
      v_who := lower(coalesce(v_effect ->> 'who', 'you'));
      if v_who = 'opponent' then
        select sp.player_id into v_decider
        from public.game_session_players sp
        where sp.session_id = p_session_id and sp.player_id is distinct from v_controller
        order by sp.seat_number limit 1;
      else
        v_decider := v_controller;
      end if;
      if v_decider is null then v_i := v_i + 1; continue; end if;

      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', h.id, 'name', c.name) order by h.zone_position, h.id), '[]'::jsonb)
        into v_options
      from public.game_cards h join public.cards c on c.id = h.card_id
      where h.session_id = p_session_id and h.owner_id = v_decider and h.zone = 'hand';

      v_len := jsonb_array_length(v_options);
      if v_len = 0 then v_i := v_i + 1; continue; end if;
      v_amount := least(coalesce((v_effect ->> 'count')::integer, 1), v_len);

      if coalesce((v_effect ->> 'random')::boolean, false) then
        with picked as (
          select id from public.game_cards
          where session_id = p_session_id and owner_id = v_decider and zone = 'hand'
          order by random() limit v_amount
        ),
        numbered as (select id, (row_number() over ()) - 1 as rn from picked),
        base as (
          select coalesce(max(zone_position), -1) as m from public.game_cards
          where session_id = p_session_id and owner_id = v_decider and zone = 'graveyard'
        )
        update public.game_cards g
        set zone = 'graveyard', zone_position = base.m + 1 + numbered.rn, is_tapped = false, damage_marked = 0
        from numbered, base
        where g.id = numbered.id;

        v_i := v_i + 1;
        continue;
      end if;

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_decider, p_stack_item_id, 'choose_cards', 'Discard ' || v_amount, v_options, v_amount, v_amount, jsonb_build_object('to', 'graveyard'))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'may' then
      -- Optional condition gate (Liliana's Devotee: "if a creature died this turn,
      -- you may …"): if the count condition fails, the may isn't offered at all.
      if v_effect ? 'condition'
         and public.resolve_dynamic_amount(p_session_id, v_item.source_card_id, v_controller, v_effect -> 'condition')
             < coalesce((v_effect -> 'condition' ->> 'at_least')::integer, 1) then
        v_i := v_i + 1; continue;
      end if;
      -- Carry an optional mana cost ("you may pay {1}{B}") into the decision params;
      -- paid at confirm time before the inner effects run.
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'confirm', coalesce(v_effect ->> 'prompt', 'You may'), '[]'::jsonb, 0, 0,
        jsonb_build_object('effects', coalesce(v_effect -> 'effects', '[]'::jsonb), 'cost', v_effect ->> 'cost'))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'choose_player' then
      v_filter := lower(coalesce(v_effect ->> 'filter', 'any'));
      select coalesce(
               jsonb_agg(jsonb_build_object('player_id', sp.player_id, 'username', p.username) order by sp.seat_number),
               '[]'::jsonb)
        into v_options
      from public.game_session_players sp
      left join public.profiles p on p.id = sp.player_id
      where sp.session_id = p_session_id
        and (v_filter <> 'opponent' or sp.player_id is distinct from v_controller);

      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'choose_player', 'Choose a player', v_options, 1, 1,
        jsonb_build_object('effects', coalesce(v_effect -> 'effects', '[]'::jsonb)))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'choose_creature_type' then
      -- A curated creature-type list, or the effect's own `options` words
      -- (mig 245, Frontier Siege: "choose Khans or Dragons"). Either way the
      -- chosen word is baked into the source's copied_script wherever the
      -- script holds the '"$chosen"' placeholder (submit_decision).
      if jsonb_typeof(v_effect -> 'options') = 'array' and jsonb_array_length(v_effect -> 'options') > 0 then
        select jsonb_agg(jsonb_build_object('type', value))
          into v_options
        from jsonb_array_elements_text(v_effect -> 'options');
      else
        v_options := '[{"type":"Zombie"},{"type":"Human"},{"type":"Elf"},{"type":"Goblin"},{"type":"Soldier"},{"type":"Wizard"},{"type":"Vampire"},{"type":"Spirit"},{"type":"Beast"},{"type":"Dragon"},{"type":"Merfolk"},{"type":"Knight"},{"type":"Cleric"},{"type":"Warrior"},{"type":"Angel"},{"type":"Demon"},{"type":"Elemental"},{"type":"Snake"},{"type":"Insect"}]'::jsonb;
      end if;
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'choose_creature_type',
        coalesce(v_effect ->> 'prompt', 'Choose a creature type'), v_options, 1, 1,
        jsonb_build_object('effects', coalesce(v_effect -> 'effects', '[]'::jsonb)))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'sacrifice' then
      v_who := lower(coalesce(v_effect ->> 'who', 'you'));
      v_filter := v_effect -> 'filter' ->> 'type_line';

      if v_who = 'each_player' then
        -- Every player including the caster, in seat order (Necrotic Hex).
        select coalesce(jsonb_agg(to_jsonb(sp.player_id::text) order by sp.seat_number), '[]'::jsonb)
          into v_queue
        from public.game_session_players sp
        where sp.session_id = p_session_id;
      elsif v_who = 'each_opponent' then
        select coalesce(jsonb_agg(to_jsonb(sp.player_id::text) order by sp.seat_number), '[]'::jsonb)
          into v_queue
        from public.game_session_players sp
        where sp.session_id = p_session_id and sp.player_id is distinct from v_controller;
      elsif v_who = 'opponent' then
        select coalesce(jsonb_agg(to_jsonb(one.player_id::text) order by one.seat_number), '[]'::jsonb)
          into v_queue
        from (
          select player_id, seat_number from public.game_session_players
          where session_id = p_session_id and player_id is distinct from v_controller
          order by seat_number limit 1
        ) one;
      else
        v_queue := jsonb_build_array(v_controller::text);
      end if;

      v_decision_id := public.park_edict_sacrifice(
        p_session_id, p_stack_item_id, coalesce((v_effect ->> 'count')::integer, 1), v_filter, v_queue
      );
      if v_decision_id is null then v_i := v_i + 1; continue; end if;

      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'look_top' then
      -- "Look at the top N cards of your library. You may put a matching card
      -- onto the battlefield. Put the rest on the bottom in a random order."
      -- (Ureni of the Unwritten, mig 223.) The looked-at set is the top N; the
      -- pickable options are the cards in it that match the filter.
      v_filter := v_effect -> 'filter' ->> 'type_line';
      select coalesce(array_agg(t.id order by t.zone_position asc, t.id asc), array[]::uuid[])
        into v_looked
      from (
        select id, zone_position from public.game_cards
        where session_id = p_session_id and owner_id = v_controller and zone = 'library'
        order by zone_position asc, id asc
        limit coalesce((v_effect ->> 'count')::integer, 1)
      ) t;

      if cardinality(v_looked) = 0 then v_i := v_i + 1; continue; end if;

      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gc.id, 'name', c.name) order by c.name, gc.id), '[]'::jsonb)
        into v_options
      from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.id = any(v_looked)
        and (v_filter is null or c.type_line ilike '%' || v_filter || '%')
        and (not coalesce((v_effect -> 'filter' ->> 'creature')::boolean, false)
             or c.type_line ilike '%creature%');

      -- No matching card to put down: the whole looked-at set still goes to the
      -- bottom in a random order. No decision is parked.
      if jsonb_array_length(v_options) = 0 then
        perform public.bottom_cards_random(p_session_id, v_controller, v_looked);
        v_i := v_i + 1; continue;
      end if;

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'look_top',
        case when coalesce(v_effect ->> 'to', 'battlefield') = 'exile'
             then 'Exile a card face down; the rest go to the bottom'
             else 'You may put a card onto the battlefield; the rest go to the bottom' end,
        v_options,
        -- min_picks (mig 248, hideaway): "exile ONE face down" is mandatory.
        least(coalesce((v_effect ->> 'min_picks')::integer, 0), jsonb_array_length(v_options)), 1,
        jsonb_build_object('to', coalesce(v_effect ->> 'to', 'battlefield'),
                           'looked_at', to_jsonb(v_looked)))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'return_from_graveyard' then
      v_filter := v_effect -> 'filter' ->> 'type_line';
      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gy.id, 'name', c.name) order by c.name, gy.id), '[]'::jsonb)
        into v_options
      from public.game_cards gy join public.cards c on c.id = gy.card_id
      where gy.session_id = p_session_id and gy.owner_id = v_controller and gy.zone = 'graveyard'
        and (case when v_filter is not null then c.type_line ilike '%' || v_filter || '%'
                  else c.type_line ilike '%creature%' end);

      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'return_from_graveyard',
        'Return up to ' || coalesce((v_effect ->> 'count'), '1') || ' from your graveyard',
        v_options, 0, coalesce((v_effect ->> 'count')::integer, 1),
        -- tapped (mig 218, Victimize): battlefield returns enter tapped.
        jsonb_build_object('to', coalesce(v_effect ->> 'to', 'hand'),
                           'tapped', coalesce((v_effect ->> 'tapped')::boolean, false)))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'choose_color' then
      -- Heraldic Banner (mig 209): "As this enters the battlefield, choose a
      -- color." Parks a five-colour pick; submit_decision registers the
      -- colour-filtered anthem described by `anthem` ({power,toughness,scope})
      -- with the chosen colour baked into its payload (source = this card,
      -- battlefield-gated, NOT script-flagged so rebuilds keep it).
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'choose_color',
        'Choose a color',
        '[{"value":"white"},{"value":"blue"},{"value":"black"},{"value":"red"},{"value":"green"}]'::jsonb,
        1, 1,
        jsonb_build_object('anthem', v_effect -> 'anthem'))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'mass_destroy_reanimate_one' then
      -- Necromantic Selection (mig 208): "Destroy all creatures, then return a
      -- creature card put into a graveyard this way to the battlefield under
      -- your control." Snapshot the about-to-die set (indestructible survives,
      -- mirroring destroy_all_creatures), destroy, then park a single pick over
      -- the cards that actually landed in a graveyard (tokens cease and drop
      -- out). submit_decision's reanimate_destroyed branch finishes the return.
      select coalesce(array_agg(gc.id), array[]::uuid[]) into v_died_set
      from public.game_cards gc
      join public.cards c on c.id = gc.card_id
      where gc.session_id = p_session_id and gc.zone = 'battlefield'
        and c.type_line ilike '%creature%'
        and not public.card_has_indestructible(p_session_id, gc.id);

      perform public.destroy_all_creatures(p_session_id, v_controller, null, 'all');

      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gc.id, 'name', c.name) order by c.name, gc.id), '[]'::jsonb)
        into v_options
      from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.session_id = p_session_id and gc.zone = 'graveyard' and gc.id = any(v_died_set);

      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices)
      values (p_session_id, v_controller, p_stack_item_id, 'reanimate_destroyed',
        'Return a destroyed creature to the battlefield under your control', v_options, 0, 1)
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'proliferate' then
      -- Options: any battlefield permanent (any owner) with a +1/+1 OR a bag
      -- counter, PLUS any player with a bag counter. The id field is uniform
      -- ('game_card_id' carries a card id or a player id — disjoint uuids), so
      -- the multi-select picker needs no change; submit_decision disambiguates.
      select coalesce(jsonb_agg(opt order by sort_name, ent_id), '[]'::jsonb)
        into v_options
      from (
        select gc.id as ent_id, c.name as sort_name,
               jsonb_build_object('game_card_id', gc.id, 'name', c.name, 'kind', 'permanent') as opt
        from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.session_id = p_session_id and gc.zone = 'battlefield'
          and (gc.plus_one_counters > 0 or gc.counters <> '{}'::jsonb)
        union all
        select sp.player_id, coalesce(p.username, 'Player'),
               jsonb_build_object('game_card_id', sp.player_id,
                                  'name', coalesce(p.username, 'Player') || ' (player)',
                                  'kind', 'player')
        from public.game_session_players sp
        left join public.profiles p on p.id = sp.player_id
        where sp.session_id = p_session_id and sp.counters <> '{}'::jsonb
      ) q;

      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices)
      values (p_session_id, v_controller, p_stack_item_id, 'proliferate', 'Proliferate — choose any number', v_options, 0, jsonb_array_length(v_options))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'copy_permanent' then
      -- Token copy (mig 239). Two shapes:
      --   • target:'triggering_creature' — copy the event subject directly, no
      --     pick (Reflections of Littjara: the cast spell's card becomes a
      --     battlefield token copy).
      --   • otherwise park a copy_permanent decision over battlefield
      --     permanents matching target_filter (Will of the Temur: "create a
      --     token that's a copy of target permanent").
      -- `except` ({power,toughness,keywords}) rides in params and becomes a
      -- set_pt override + keyword grants on the copy; added TYPES are not
      -- modelled.
      if (v_effect ->> 'target') = 'triggering_creature' then
        if nullif(v_item.payload ->> 'triggering_card_id', '')::uuid is not null then
          perform public.create_copy_token(
            p_session_id, v_controller,
            nullif(v_item.payload ->> 'triggering_card_id', '')::uuid,
            v_effect -> 'except');
        end if;
      else
        select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gc.id, 'name', c.name) order by c.name, gc.id), '[]'::jsonb)
          into v_options
        from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.session_id = p_session_id and gc.zone = 'battlefield'
          and (coalesce(v_effect -> 'target_filter' ->> 'type_line', '') = ''
               or c.type_line ilike '%' || (v_effect -> 'target_filter' ->> 'type_line') || '%')
          and (case lower(coalesce(v_effect -> 'target_filter' ->> 'controller', 'any'))
                 when 'you' then coalesce(gc.controller_player_id, gc.owner_id) = v_controller
                 when 'opponent' then coalesce(gc.controller_player_id, gc.owner_id) is distinct from v_controller
                 else true end);
        if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;
        insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
        values (p_session_id, v_controller, p_stack_item_id, 'copy_permanent',
          'Choose a permanent to copy', v_options, 1, 1,
          jsonb_build_object('except', v_effect -> 'except'))
        returning id into v_decision_id;
        update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
        return v_decision_id;
      end if;

    elsif v_type = 'become_copy' then
      -- An existing card becomes a copy (mig 240). Options are either the
      -- triggering creature (Sarkhan, Soul Aflame: "whenever a Dragon you
      -- control enters, you may have Sarkhan become a copy of it until end of
      -- turn") or battlefield creatures matching target_filter (Deceptive
      -- Frostkite: "you may have this enter as a copy of a creature you
      -- control with power 4 or greater"). The pick IS the "may": optional
      -- parks with min 0 and an empty submit declines. `except`/
      -- until_end_of_turn/fire_etb ride in params for submit_decision.
      if (v_effect ->> 'target') = 'triggering_creature' then
        select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gc.id, 'name', c.name)), '[]'::jsonb)
          into v_options
        from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.id = nullif(v_item.payload ->> 'triggering_card_id', '')::uuid
          and gc.session_id = p_session_id and gc.zone = 'battlefield'
          and gc.id is distinct from v_item.source_card_id;
      else
        select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gc.id, 'name', c.name) order by c.name, gc.id), '[]'::jsonb)
          into v_options
        from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.session_id = p_session_id and gc.zone = 'battlefield'
          and gc.id is distinct from v_item.source_card_id
          and c.type_line ilike '%creature%'
          and (coalesce(v_effect -> 'target_filter' ->> 'type_line', '') = ''
               or c.type_line ilike '%' || (v_effect -> 'target_filter' ->> 'type_line') || '%')
          and (case lower(coalesce(v_effect -> 'target_filter' ->> 'controller', 'you'))
                 when 'you' then coalesce(gc.controller_player_id, gc.owner_id) = v_controller
                 when 'opponent' then coalesce(gc.controller_player_id, gc.owner_id) is distinct from v_controller
                 else true end)
          and ((v_effect -> 'target_filter' ->> 'min_power') is null
               or coalesce(public.card_effective_power(p_session_id, gc.id), -1)
                  >= (v_effect -> 'target_filter' ->> 'min_power')::integer);
      end if;
      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'become_copy',
        'Become a copy of a creature?', v_options,
        case when coalesce((v_effect ->> 'optional')::boolean, false) then 0 else 1 end, 1,
        jsonb_build_object(
          'except', v_effect -> 'except',
          'until_end_of_turn', coalesce((v_effect ->> 'until_end_of_turn')::boolean, false),
          'fire_etb', coalesce((v_effect ->> 'fire_etb')::boolean, false)))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'discover' then
      -- Discover X (mig 253, Pantlaza, Sun-Favored): exile cards from the top
      -- until a NONLAND with mana value <= X; cast it without paying its cost
      -- (the cast_exiled_free pick — a permanent enters the battlefield;
      -- declining puts it into your hand) and put the rest on the bottom in a
      -- random order. X may be the triggering creature's mana value.
      if jsonb_typeof(v_effect -> 'amount') = 'object'
         and (v_effect -> 'amount' ->> 'mana_value_of') = 'triggering_creature' then
        select public.mana_value(c.mana_cost) into v_amount
        from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.id = nullif(v_item.payload ->> 'triggering_card_id', '')::uuid
          and gc.session_id = p_session_id;
      else
        v_amount := coalesce((v_effect ->> 'amount')::integer, 0);
      end if;
      v_looked := array[]::uuid[];
      v_tid := null;
      v_len := (select count(*) from public.game_cards
                where session_id = p_session_id and owner_id = v_controller and zone = 'library');
      while coalesce(array_length(v_looked, 1), 0) + (case when v_tid is null then 0 else 1 end) < v_len loop
        select gc.id, c.type_line, c.mana_cost into v_tid, v_filter, v_name
        from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.session_id = p_session_id and gc.owner_id = v_controller and gc.zone = 'library'
          and gc.id <> all(v_looked)
        order by gc.zone_position asc, gc.id asc limit 1;
        exit when v_tid is null;
        if v_filter not ilike '%land%' and public.mana_value(v_name) <= coalesce(v_amount, 0) then
          update public.game_cards gc
          set zone = 'exile', controller_player_id = gc.owner_id, is_tapped = false,
              zone_position = (select coalesce(max(zone_position), -1) + 1
                               from public.game_cards x
                               where x.session_id = p_session_id and x.owner_id = gc.owner_id and x.zone = 'exile')
          where gc.id = v_tid;
          exit;
        end if;
        v_looked := v_looked || v_tid;
        v_tid := null;
      end loop;
      if coalesce(array_length(v_looked, 1), 0) > 0 then
        perform public.bottom_cards_random(p_session_id, v_controller, v_looked);
      end if;
      if v_tid is null then v_i := v_i + 1; continue; end if;
      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gc.id, 'name', c.name)), '[]'::jsonb)
        into v_options
      from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.id = v_tid;
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'cast_exiled_free',
        'Discover: cast it without paying its mana cost? (Declining puts it into your hand)',
        v_options, 0, 1, '{}'::jsonb)
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'exile_until_nonland' then
      -- Breaching Dragonstorm (mig 245): exile from the top of your library
      -- until a nonland is exiled (the lands STAY exiled, per the card). The
      -- nonland parks a pick when its mana value is within the free window:
      -- choosing it puts a PERMANENT card onto the battlefield ("cast it
      -- without paying its mana cost", approximated as a direct entry —
      -- instants/sorceries go to hand instead), declining puts it into your
      -- hand. Above the window it goes straight to hand.
      v_tid := null;
      loop
        select gc.id, c.type_line, c.mana_cost into v_tid, v_filter, v_name
        from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.session_id = p_session_id and gc.owner_id = v_controller and gc.zone = 'library'
        order by gc.zone_position asc, gc.id asc limit 1;
        exit when v_tid is null;
        update public.game_cards gc
        set zone = 'exile', controller_player_id = gc.owner_id, is_tapped = false,
            zone_position = (select coalesce(max(zone_position), -1) + 1
                             from public.game_cards x
                             where x.session_id = p_session_id and x.owner_id = gc.owner_id and x.zone = 'exile')
        where gc.id = v_tid;
        exit when v_filter not ilike '%land%';
        v_tid := null;
      end loop;
      if v_tid is null then v_i := v_i + 1; continue; end if;
      if public.mana_value(v_name) > coalesce((v_effect ->> 'free_cast_max_mana_value')::integer, 8) then
        -- Too big for the free window: straight to hand.
        update public.game_cards gc
        set zone = 'hand',
            zone_position = (select coalesce(max(zone_position), -1) + 1
                             from public.game_cards x
                             where x.session_id = p_session_id and x.owner_id = gc.owner_id and x.zone = 'hand')
        where gc.id = v_tid;
        v_i := v_i + 1; continue;
      end if;
      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gc.id, 'name', c.name)), '[]'::jsonb)
        into v_options
      from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.id = v_tid;
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'cast_exiled_free',
        'Cast it without paying its mana cost? (Declining puts it into your hand)',
        v_options, 0, 1, '{}'::jsonb)
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'if_attacking_most_life' then
      -- Dethrone / Scourge of the Throne (mig 250): run the inner untargeted
      -- effects only when the attack's defender (event_player_id, stamped by
      -- fire_attack_triggers) has the most life or is tied for it.
      -- once_per_turn gates via a turn stamp on the source's counter bag
      -- (approximation: stamped on the first QUALIFYING attack).
      if nullif(v_item.payload ->> 'event_player_id', '') is not null
         and (select sp.life_total from public.game_session_players sp
              where sp.session_id = p_session_id
                and sp.player_id = (v_item.payload ->> 'event_player_id')::uuid)
             >= (select max(sp.life_total) from public.game_session_players sp
                 where sp.session_id = p_session_id)
      then
        if coalesce((v_effect ->> 'once_per_turn')::boolean, false) then
          select turn_number into v_amount from public.game_turn_state where session_id = p_session_id;
          if (select gc.counters ->> 'dethrone_extra_turn' from public.game_cards gc
              where gc.id = v_item.source_card_id) = v_amount::text then
            v_i := v_i + 1; continue;
          end if;
          update public.game_cards
          set counters = coalesce(counters, '{}'::jsonb) || jsonb_build_object('dethrone_extra_turn', v_amount::text)
          where id = v_item.source_card_id and session_id = p_session_id;
        end if;
        perform public.apply_triggered_ability_effects(
          p_session_id, v_controller, v_item.source_card_id, coalesce(v_effect -> 'effects', '[]'::jsonb));
      end if;

    elsif v_type = 'territorial_attack' then
      -- Territorial Hellkite (mig 249): "choose an opponent at random that
      -- this creature didn't attack during your last combat. This creature
      -- attacks that player this combat if able. If you can't choose an
      -- opponent this way, tap this creature." The pick pins the defender
      -- (declare_attacker rejects others); declining to attack at all is not
      -- forced (approximation).
      select sp.player_id into v_decider
      from public.game_session_players sp
      where sp.session_id = p_session_id
        and sp.player_id is distinct from v_controller
        and sp.player_id::text is distinct from (
          select gc.counters ->> 'last_attacked'
          from public.game_cards gc where gc.id = v_item.source_card_id)
      order by random() limit 1;
      if v_decider is null then
        update public.game_cards set is_tapped = true
        where id = v_item.source_card_id and session_id = p_session_id;
      else
        update public.game_cards
        set counters = coalesce(counters, '{}'::jsonb) || jsonb_build_object('must_attack', v_decider::text)
        where id = v_item.source_card_id and session_id = p_session_id;
      end if;

    elsif v_type = 'put_from_command_zone' then
      -- "You may put a commander you own from the command zone onto the
      -- battlefield. It gains haste. Return it to the command zone at the
      -- beginning of the next end step." (Hellkite Courser, mig 248.)
      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gc.id, 'name', c.name) order by c.name, gc.id), '[]'::jsonb)
        into v_options
      from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.session_id = p_session_id and gc.zone = 'command'
        and gc.owner_id = v_controller and gc.is_commander = true;
      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'command_zone_pick',
        'You may put a commander onto the battlefield until the next end step',
        v_options, 0, 1, '{}'::jsonb)
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'play_hideaway' then
      -- Mosswort Bridge (mig 248): play the card this source hid with
      -- hideaway. A PERMANENT card enters the battlefield free under the
      -- activator (instants/sorceries are not supported — the card stays
      -- exiled). The power-10 gate is the ability's `condition`.
      v_tid := nullif((select gc.counters ->> 'hideaway_card'
                       from public.game_cards gc where gc.id = v_item.source_card_id), '')::uuid;
      if v_tid is not null and exists (
        select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.id = v_tid and gc.session_id = p_session_id and gc.zone = 'exile'
          and (c.type_line ilike '%creature%' or c.type_line ilike '%artifact%'
               or c.type_line ilike '%enchantment%' or c.type_line ilike '%land%'
               or c.type_line ilike '%planeswalker%' or c.type_line ilike '%battle%')
      ) then
        select turn_number into v_amount from public.game_turn_state where session_id = p_session_id;
        update public.game_cards gc
        set zone = 'battlefield', controller_player_id = v_controller, is_tapped = false,
            entered_battlefield_turn_number = coalesce(v_amount, 0),
            zone_position = (select coalesce(max(zone_position), -1) + 1
                             from public.game_cards x
                             where x.session_id = p_session_id and x.owner_id = gc.owner_id
                               and x.zone = 'battlefield')
        where gc.id = v_tid;
        perform public.register_card_continuous_effects(p_session_id, v_tid);
        update public.game_cards
        set counters = counters - 'hideaway_card'
        where id = v_item.source_card_id and session_id = p_session_id;
      end if;

    elsif v_type = 'put_from_hand' then
      -- "You may put a permanent card with mana value less than or equal to
      -- that damage from your hand onto the battlefield" (Broodcaller
      -- Scourge, mig 247). The cap rides the trigger payload (event_amount).
      v_amount := case when (v_effect -> 'filter' ->> 'max_mana_value') = 'event_amount'
                       then nullif(v_item.payload ->> 'event_amount', '')::integer
                       else nullif(v_effect -> 'filter' ->> 'max_mana_value', '')::integer end;
      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gc.id, 'name', c.name) order by c.name, gc.id), '[]'::jsonb)
        into v_options
      from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.session_id = p_session_id and gc.owner_id = v_controller and gc.zone = 'hand'
        and (not coalesce((v_effect -> 'filter' ->> 'permanent')::boolean, true)
             or c.type_line ilike '%creature%' or c.type_line ilike '%artifact%'
             or c.type_line ilike '%enchantment%' or c.type_line ilike '%land%'
             or c.type_line ilike '%planeswalker%' or c.type_line ilike '%battle%')
        and (v_amount is null or public.mana_value(c.mana_cost) <= v_amount);
      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;
      -- count may be a number, or a payload key holding the number (mig 252,
      -- Selvala's Stampede: 'free_votes' tallied by the vote chain).
      v_len := case
        when coalesce(v_effect ->> 'count', '') ~ '^[0-9]+$' then (v_effect ->> 'count')::integer
        when nullif(v_effect ->> 'count', '') is not null
          then coalesce(nullif(v_item.payload ->> (v_effect ->> 'count'), '')::integer, 0)
        else 1 end;
      if v_len <= 0 then v_i := v_i + 1; continue; end if;
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'put_from_hand_pick',
        'You may put up to ' || v_len || ' card(s) from your hand onto the battlefield',
        v_options, 0, v_len, '{}'::jsonb)
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'destroy_up_to' then
      -- "Destroy target artifact that opponent controls" as a parked pick
      -- (Parapet Thrasher mode, mig 247). "That opponent" is approximated as
      -- any matching opponent permanent. Picking nothing declines.
      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gc.id, 'name', c.name) order by c.name, gc.id), '[]'::jsonb)
        into v_options
      from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.session_id = p_session_id and gc.zone = 'battlefield'
        and (case lower(coalesce(v_effect -> 'target_filter' ->> 'controller', 'opponent'))
               when 'opponent' then coalesce(gc.controller_player_id, gc.owner_id) is distinct from v_controller
               when 'you' then coalesce(gc.controller_player_id, gc.owner_id) = v_controller
               else true end)
        -- types array (mig 261, Scion of Calamity: "artifact or enchantment")
        -- OR the single type_line; both empty = any type.
        and (case
               when jsonb_typeof(v_effect -> 'target_filter' -> 'types') = 'array' then
                 exists (select 1 from jsonb_array_elements_text(v_effect -> 'target_filter' -> 'types') t
                         where c.type_line ilike '%' || t.value || '%')
               when coalesce(v_effect -> 'target_filter' ->> 'type_line', '') <> '' then
                 c.type_line ilike '%' || (v_effect -> 'target_filter' ->> 'type_line') || '%'
               else true
             end);
      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'destroy_pick',
        'Destroy up to ' || coalesce(v_effect ->> 'count', '1'),
        v_options, 0, greatest(1, coalesce((v_effect ->> 'count')::integer, 1)), '{}'::jsonb)
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'exile_tops_cast' then
      -- Etali, Primal Storm (mig 262): "exile the top card of each player's
      -- library, then you may cast any number of spells from among those
      -- cards without paying their mana costs." Approximations: the free
      -- cast is a direct battlefield entry, so only PERMANENT cards are
      -- offered; instants/sorceries (and declined cards) stay exiled.
      v_looked := array[]::uuid[];
      for v_decider in
        select sp.player_id from public.game_session_players sp
        where sp.session_id = p_session_id order by sp.seat_number, sp.player_id
      loop
        select gc.id into v_top_id from public.game_cards gc
        where gc.session_id = p_session_id and gc.owner_id = v_decider and gc.zone = 'library'
        order by gc.zone_position asc, gc.id asc
        limit 1;
        if v_top_id is not null then
          select coalesce(max(zone_position), -1) + 1 into v_pos
          from public.game_cards
          where session_id = p_session_id and owner_id = v_decider and zone = 'exile';
          update public.game_cards
          set zone = 'exile', zone_position = v_pos
          where id = v_top_id;
          v_looked := v_looked || v_top_id;
        end if;
      end loop;

      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gc.id, 'name', c.name) order by c.name, gc.id), '[]'::jsonb)
        into v_options
      from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.id = any(v_looked)
        and (c.type_line ilike '%creature%' or c.type_line ilike '%artifact%'
             or c.type_line ilike '%enchantment%' or c.type_line ilike '%land%'
             or c.type_line ilike '%planeswalker%' or c.type_line ilike '%battle%');

      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'etali_cast_pick',
        'Cast any number of the exiled cards for free',
        v_options, 0, jsonb_array_length(v_options), '{}'::jsonb)
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'fight_pick' then
      -- Two-creature fight where the FIRST creature is the program's target
      -- (mig 261, Savage Stomp: "+1/+1 counter on target creature you control,
      -- then it fights target creature you don't control"; Wayta's activated
      -- fight). Parks the SECOND pick; submit_decision runs apply_fight.
      if v_target is null then v_i := v_i + 1; continue; end if;
      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gc.id, 'name', c.name) order by c.name, gc.id), '[]'::jsonb)
        into v_options
      from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.session_id = p_session_id and gc.zone = 'battlefield'
        and gc.id <> v_target
        and c.type_line ilike '%creature%'
        and (case lower(coalesce(v_effect -> 'target_filter' ->> 'controller', 'opponent'))
               when 'opponent' then coalesce(gc.controller_player_id, gc.owner_id) is distinct from v_controller
               when 'you' then coalesce(gc.controller_player_id, gc.owner_id) = v_controller
               else true end);
      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'fight_pick',
        'Choose the creature to fight',
        v_options, 1, 1, jsonb_build_object('fighter_id', v_target::text))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'vote_wild_free' then
      -- Council's dilemma (mig 252, Selvala's Stampede): starting with the
      -- caster, each player votes wild or free. Each submit parks the next
      -- voter's decision; the LAST submit tallies and applies (wild: reveal
      -- from the caster's library top until that many creature cards enter
      -- under the caster, the rest bottomed in a random order — approximating
      -- the shuffle; free: the count rides the stack payload for a following
      -- put_from_hand action).
      select coalesce(jsonb_agg(to_jsonb(sp.player_id::text)
               order by (sp.player_id = v_controller) desc, sp.seat_number), '[]'::jsonb)
        into v_queue
      from public.game_session_players sp
      where sp.session_id = p_session_id;
      if jsonb_array_length(v_queue) = 0 then v_i := v_i + 1; continue; end if;
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, (v_queue ->> 0)::uuid, p_stack_item_id, 'vote',
        'Vote wild or free',
        '[{"value":"wild"},{"value":"free"}]'::jsonb, 1, 1,
        jsonb_build_object('queue',
          (select coalesce(jsonb_agg(t.value), '[]'::jsonb)
           from jsonb_array_elements(v_queue) with ordinality t(value, ord)
           where t.ord > 1)))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'pay_x_mana_damage' then
      -- "You may pay any amount of {R}. When you do, it deals that much
      -- damage to any target." (Leyline Tyrant dies trigger, mig 244.) Parks
      -- the legal targets + the colour; submit_decision validates the amount
      -- against the payer's pool, deducts it, and applies the damage. Amount 0
      -- (or no pick) declines.
      v_options := public.divide_damage_options(p_session_id, v_controller, v_effect -> 'target_filter');
      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'pay_x_mana_damage',
        'Pay any amount of {' || upper(coalesce(v_effect ->> 'color', 'R')) || '}: that much damage to a target',
        v_options, 0, 1,
        jsonb_build_object('color', upper(coalesce(v_effect ->> 'color', 'R'))))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'bounce_up_to' then
      -- "Return up to one target nonland permanent an opponent controls with
      -- mana value less than or equal to that spell's mana value to its
      -- owner's hand" (Hammerhead Tyrant, mig 244). The MV ceiling is the
      -- TRIGGERING cast card's mana value when target_filter.max_mana_value =
      -- 'triggering_spell'. Picking nothing declines ("up to one").
      v_amount := null;
      if (v_effect -> 'target_filter' ->> 'max_mana_value') = 'triggering_spell' then
        select public.mana_value(c.mana_cost) into v_amount
        from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.id = nullif(v_item.payload ->> 'triggering_card_id', '')::uuid
          and gc.session_id = p_session_id;
      end if;
      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gc.id, 'name', c.name) order by c.name, gc.id), '[]'::jsonb)
        into v_options
      from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.session_id = p_session_id and gc.zone = 'battlefield'
        and (case lower(coalesce(v_effect -> 'target_filter' ->> 'controller', 'opponent'))
               when 'opponent' then coalesce(gc.controller_player_id, gc.owner_id) is distinct from v_controller
               when 'you' then coalesce(gc.controller_player_id, gc.owner_id) = v_controller
               else true end)
        and (not coalesce((v_effect -> 'target_filter' ->> 'nonland')::boolean, false)
             or c.type_line not ilike '%land%')
        and (v_amount is null or public.mana_value(c.mana_cost) <= v_amount);
      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'bounce_pick',
        'Return up to ' || coalesce(v_effect ->> 'count', '1') || ' to its owner''s hand',
        v_options, 0, greatest(1, coalesce((v_effect ->> 'count')::integer, 1)), '{}'::jsonb)
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'pump_all' then
      -- Mass until-EOT pump from the program (mig 243, Become the Avalanche).
      -- Previously pump_all only ran inside choose_creature_type's apply path;
      -- the helper now resolves count-based power/toughness itself.
      perform public.apply_mass_pump_until_eot(
        p_session_id, v_item.source_card_id, v_controller, v_effect);

    elsif v_type = 'reveal_top_cast_shared' then
      -- Descendants' Path (mig 259): "reveal the top card of your library. If
      -- it's a creature card that shares a creature type with a creature you
      -- control, you may cast it without paying its mana cost. If you don't
      -- cast it, put it on the bottom of your library." Approximations: the
      -- free cast is a direct battlefield entry, and it is NOT optional —
      -- a sharing card is always cast. Subtype words are the type-line tokens
      -- after the dash; both '-' and the em-dash are handled.
      select gc.id, c.type_line into v_top_id, v_top_type
      from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.session_id = p_session_id and gc.owner_id = v_controller and gc.zone = 'library'
      order by gc.zone_position asc, gc.id asc
      limit 1;
      if v_top_id is not null then
        if v_top_type ilike '%creature%' and exists (
          select 1
          from public.game_cards bc
          join public.cards bcc on bcc.id = bc.card_id
          where bc.session_id = p_session_id and bc.zone = 'battlefield'
            and coalesce(bc.controller_player_id, bc.owner_id) = v_controller
            and bcc.type_line ilike '%creature%'
            and exists (
              select 1
              from unnest(string_to_array(trim(split_part(translate(v_top_type, '—–-', '|||'), '|', 2)), ' ')) tw
              join unnest(string_to_array(trim(split_part(translate(bcc.type_line, '—–-', '|||'), '|', 2)), ' ')) bw
                on lower(tw) = lower(bw) and trim(tw) <> ''
            )
        ) then
          select coalesce(max(zone_position), -1) + 1 into v_pos
          from public.game_cards
          where session_id = p_session_id and owner_id = v_controller and zone = 'battlefield';
          select turn_number into v_turn from public.game_turn_state where session_id = p_session_id;
          update public.game_cards
          set zone = 'battlefield', zone_position = v_pos, controller_player_id = owner_id,
              is_tapped = false, damage_marked = 0, plus_one_counters = 0,
              entered_battlefield_turn_number = coalesce(v_turn, 0)
          where id = v_top_id;
          perform public.rebuild_scripted_continuous_effects(p_session_id);
        else
          perform public.bottom_cards_random(p_session_id, v_controller, array[v_top_id]);
        end if;
      end if;

    elsif v_type = 'exile_from_any_graveyard' then
      -- Deathgorge Scavenger (mig 259): "you may exile target card from a
      -- graveyard. If a creature card is exiled this way, you gain 2 life. If
      -- a noncreature card is exiled this way, this creature gets +1/+1 until
      -- end of turn." Parks an optional (min 0) pick over EVERY graveyard;
      -- submit_decision exiles and applies the conditional rider.
      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gy.id, 'name', c.name) order by c.name, gy.id), '[]'::jsonb)
        into v_options
      from public.game_cards gy join public.cards c on c.id = gy.card_id
      where gy.session_id = p_session_id and gy.zone = 'graveyard';

      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'graveyard_exile_pick',
        'Exile up to 1 card from a graveyard',
        v_options, 0, 1,
        jsonb_build_object(
          'gain_if_creature', coalesce((v_effect ->> 'gain_if_creature')::integer, 2),
          'pump_if_noncreature', coalesce((v_effect ->> 'pump_if_noncreature')::integer, 1)))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'prevent_damage' then
      perform public.add_damage_prevention(
        p_session_id,
        v_controller,
        case when v_effect ? 'amount' then (v_effect ->> 'amount')::integer else null end,
        coalesce((v_effect ->> 'combat_only')::boolean, false),
        v_item.source_card_id
      );

    elsif (v_effect ->> 'target') = 'triggering_creature' then
      -- Reflexive watcher (mig 227): the EVENT SUBJECT (the entering/attacking
      -- creature) receives the effect, no target pick. "Whenever a Dragon you
      -- control attacks, IT gains double strike" (Atarka); "whenever a creature
      -- with flying enters, IT gains haste" (Dragon Tempest). The triggering
      -- card id rode in via enqueue_triggered_ability.
      if nullif(v_item.payload ->> 'triggering_card_id', '')::uuid is not null then
        perform public.apply_creature_effect(
          p_session_id, v_type,
          nullif(v_item.payload ->> 'triggering_card_id', '')::uuid, v_effect);
      end if;

    else
      if jsonb_typeof(v_targets) = 'array' and jsonb_array_length(v_targets) > 0
         and public.trigger_effect_target_type(v_effect) is not null then
        for v_tid in select (value)::uuid from jsonb_array_elements_text(v_targets)
        loop
          perform public.apply_targeted_triggered_ability_effects(
            p_session_id, v_controller, v_item.source_card_id, jsonb_build_array(v_effect), v_tid
          );
        end loop;
      else
        -- fighter:'triggering_creature' (mig 245, Frontier Siege Dragons
        -- mode): the EVENT SUBJECT fights the picked target, not the watcher.
        perform public.apply_targeted_triggered_ability_effects(
          p_session_id, v_controller,
          case when (v_effect ->> 'fighter') = 'triggering_creature'
               then coalesce(nullif(v_item.payload ->> 'triggering_card_id', '')::uuid, v_item.source_card_id)
               else v_item.source_card_id end,
          jsonb_build_array(v_effect), v_target
        );
      end if;
    end if;

    v_i := v_i + 1;
  end loop;

  return null;
end;
$$;
grant execute on function public.apply_trigger_effects(uuid, uuid, integer) to authenticated;

create or replace function public.submit_decision(
  p_decision_id uuid,
  p_result jsonb
)
returns public.game_pending_decisions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_decision public.game_pending_decisions;
  v_chosen jsonb;
  v_count integer;
  v_option_count integer;
  v_idx integer;
  v_top jsonb;
  v_bottom jsonb;
  v_grave jsonb;
  v_option_ids uuid[];
  v_chosen_ids uuid[];
  v_needs_target boolean;
  v_mode jsonb;
  v_target_card uuid;
  v_dest text;
  v_card uuid;
  v_pos integer;
  v_turn integer;
  v_ctrl uuid;
  v_src_card uuid;
  v_tgt uuid;
  v_chosen_player uuid;
  v_chosen_type text;
  v_effects_rewritten jsonb;
  v_decision_id uuid;
  v_pe jsonb;
  v_old_effects jsonb;
  v_new_effects jsonb;
  v_mode_actions jsonb;
  v_resume integer;
  v_eff_script jsonb;
  v_type_line text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into v_decision from public.game_pending_decisions where id = p_decision_id for update;
  if not found then raise exception 'Decision not found'; end if;
  if v_decision.status <> 'pending' then raise exception 'Decision already %', v_decision.status; end if;
  if v_decision.deciding_player_id <> auth.uid() then raise exception 'Only the deciding player can submit this decision'; end if;

  -- ── Validation ──────────────────────────────────────────────────────────
  if v_decision.decision_type = 'choose_mode' then
    v_chosen := case
      when jsonb_typeof(p_result -> 'chosen') = 'array' then p_result -> 'chosen'
      when p_result -> 'chosen' is not null then jsonb_build_array(p_result -> 'chosen')
      else '[]'::jsonb
    end;
    v_count := jsonb_array_length(v_chosen);
    v_option_count := jsonb_array_length(v_decision.options);
    if v_count < v_decision.min_choices or v_count > v_decision.max_choices then
      raise exception 'Must choose between % and % option(s)', v_decision.min_choices, v_decision.max_choices;
    end if;
    v_needs_target := false;
    for v_idx in select (value)::integer from jsonb_array_elements_text(v_chosen)
    loop
      if v_idx < 0 or v_idx >= v_option_count then raise exception 'Chosen mode index % out of range', v_idx; end if;
      v_mode := v_decision.options -> v_idx;
      if exists (
        select 1 from jsonb_array_elements(coalesce(v_mode -> 'actions', '[]'::jsonb)) a(value)
        where (a.value ->> 'type') in ('deal_damage', 'destroy', 'exile', 'bounce', 'tap', 'untap', 'add_counters', 'pump')
          and ((a.value -> 'target_type') = '"creature"'::jsonb
               or (jsonb_typeof(a.value -> 'target_type') = 'array' and (a.value -> 'target_type') ? 'creature'))
      ) then
        v_needs_target := true;
      end if;
    end loop;
    if v_needs_target then
      v_target_card := nullif(p_result ->> 'target_card_id', '')::uuid;
      if v_target_card is null then raise exception 'This mode requires a creature target'; end if;
      if not exists (
        select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.id = v_target_card and gc.session_id = v_decision.session_id and gc.zone = 'battlefield' and c.type_line ilike '%creature%'
      ) then
        raise exception 'Modal target must be a creature on the battlefield';
      end if;
    end if;

  elsif v_decision.decision_type = 'scry' then
    v_top := case when jsonb_typeof(p_result -> 'top') = 'array' then p_result -> 'top' else '[]'::jsonb end;
    v_bottom := case when jsonb_typeof(p_result -> 'bottom') = 'array' then p_result -> 'bottom' else '[]'::jsonb end;
    select array_agg((value ->> 'game_card_id')::uuid) into v_option_ids from jsonb_array_elements(v_decision.options);
    select array_agg(id) into v_chosen_ids from (select (value)::uuid as id from jsonb_array_elements_text(v_top) union all select (value)::uuid from jsonb_array_elements_text(v_bottom)) q;
    v_chosen_ids := coalesce(v_chosen_ids, array[]::uuid[]);
    if cardinality(v_chosen_ids) <> cardinality(v_option_ids) then raise exception 'Scry must place every revealed card exactly once'; end if;
    if (select count(distinct e) from unnest(v_chosen_ids) e) <> cardinality(v_option_ids) then raise exception 'Scry placed a card more than once'; end if;
    if exists (select 1 from unnest(v_chosen_ids) e where e <> all(v_option_ids)) then raise exception 'Scry placed a card that was not revealed'; end if;

  elsif v_decision.decision_type = 'surveil' then
    v_grave := case when jsonb_typeof(p_result -> 'graveyard') = 'array' then p_result -> 'graveyard' else '[]'::jsonb end;
    v_top := case when jsonb_typeof(p_result -> 'top') = 'array' then p_result -> 'top' else '[]'::jsonb end;
    select array_agg((value ->> 'game_card_id')::uuid) into v_option_ids from jsonb_array_elements(v_decision.options);
    select array_agg(id) into v_chosen_ids from (select (value)::uuid as id from jsonb_array_elements_text(v_grave) union all select (value)::uuid from jsonb_array_elements_text(v_top)) q;
    v_chosen_ids := coalesce(v_chosen_ids, array[]::uuid[]);
    if cardinality(v_chosen_ids) <> cardinality(v_option_ids) then raise exception 'Surveil must place every revealed card exactly once'; end if;
    if (select count(distinct e) from unnest(v_chosen_ids) e) <> cardinality(v_option_ids) then raise exception 'Surveil placed a card more than once'; end if;
    if exists (select 1 from unnest(v_chosen_ids) e where e <> all(v_option_ids)) then raise exception 'Surveil placed a card that was not revealed'; end if;

  elsif v_decision.decision_type in ('search_library', 'choose_cards', 'sacrifice', 'return_from_graveyard', 'reanimate_destroyed', 'look_top', 'proliferate', 'copy_permanent', 'become_copy', 'bounce_pick', 'cast_exiled_free', 'put_from_hand_pick', 'destroy_pick', 'command_zone_pick', 'graveyard_exile_pick', 'fight_pick', 'etali_cast_pick') then
    v_top := case when jsonb_typeof(p_result -> 'chosen') = 'array' then p_result -> 'chosen' else '[]'::jsonb end;
    select array_agg((value ->> 'game_card_id')::uuid) into v_option_ids from jsonb_array_elements(v_decision.options);
    select array_agg((value)::uuid) into v_chosen_ids from jsonb_array_elements_text(v_top);
    v_chosen_ids := coalesce(v_chosen_ids, array[]::uuid[]);
    if cardinality(v_chosen_ids) < v_decision.min_choices or cardinality(v_chosen_ids) > v_decision.max_choices then
      raise exception 'Must choose between % and % card(s)', v_decision.min_choices, v_decision.max_choices;
    end if;
    if (select count(distinct e) from unnest(v_chosen_ids) e) <> cardinality(v_chosen_ids) then raise exception 'Chose a card more than once'; end if;
    if exists (select 1 from unnest(v_chosen_ids) e where e <> all(v_option_ids)) then raise exception 'Chose a card that was not offered'; end if;

  elsif v_decision.decision_type = 'choose_player' then
    v_chosen_player := nullif(p_result ->> 'player_id', '')::uuid;
    if v_chosen_player is null then raise exception 'A player must be chosen'; end if;
    if not exists (
      select 1 from jsonb_array_elements(v_decision.options) o where (o ->> 'player_id') = v_chosen_player::text
    ) then
      raise exception 'Chosen player was not offered';
    end if;

  elsif v_decision.decision_type = 'choose_creature_type' then
    v_chosen_type := nullif(p_result ->> 'type', '');
    if v_chosen_type is null then
      raise exception 'A creature type must be chosen';
    end if;

  elsif v_decision.decision_type = 'choose_color' then
    if lower(coalesce(p_result ->> 'color', '')) not in ('white', 'blue', 'black', 'red', 'green') then
      raise exception 'A color must be chosen';
    end if;
  end if;

  update public.game_pending_decisions
  set result = p_result, status = 'resolved', resolved_at = now()
  where id = p_decision_id
  returning * into v_decision;

  -- ── Apply + resume ──────────────────────────────────────────────────────
  if v_decision.decision_type = 'choose_mode' then
    -- A trigger-sourced modal (mig 230, Atsushi): apply the chosen mode's
    -- untargeted actions here and resume the trigger. Modal SPELLS are NOT
    -- trigger_modal — they resolve via resolve_top_of_stack, so this is a no-op
    -- for them.
    if coalesce((v_decision.params ->> 'trigger_modal')::boolean, false) then
      -- Splice the chosen modes' actions into the parked program at
      -- resume_index and resume (mig 239). The actions then run through the
      -- FULL program resolver, so modes may contain parking actions
      -- (copy_permanent, choose_player, …); plain untargeted actions reach the
      -- same untargeted applier as before via the program's fallthrough.
      select payload -> 'effects', coalesce((payload ->> 'resume_index')::integer, 0)
        into v_old_effects, v_resume
      from public.game_stack_items where id = v_decision.source_stack_item_id;
      v_mode_actions := '[]'::jsonb;
      for v_idx in select (value)::integer from jsonb_array_elements_text(v_chosen)
      loop
        v_mode_actions := v_mode_actions || coalesce(v_decision.options -> v_idx -> 'actions', '[]'::jsonb);
      end loop;
      -- effects := effects[0:resume) || mode_actions || effects[resume:]
      select coalesce(jsonb_agg(q.elem order by q.pos), '[]'::jsonb) into v_new_effects
      from (
        select t.elem, t.ord::numeric as pos
        from jsonb_array_elements(coalesce(v_old_effects, '[]'::jsonb)) with ordinality t(elem, ord)
        where t.ord <= v_resume
        union all
        select t.elem, v_resume + t.ord / 1000.0
        from jsonb_array_elements(v_mode_actions) with ordinality t(elem, ord)
        union all
        select t.elem, t.ord::numeric
        from jsonb_array_elements(coalesce(v_old_effects, '[]'::jsonb)) with ordinality t(elem, ord)
        where t.ord > v_resume
      ) q;
      update public.game_stack_items
      set payload = jsonb_set(payload, '{effects}', v_new_effects)
      where id = v_decision.source_stack_item_id;
      perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);
    end if;

  elsif v_decision.decision_type = 'divide_damage' then
    -- Validate + apply a divided-damage allocation (Dragonlord Atarka / Skarrgan).
    -- p_result.allocations = [{game_card_id|player_id, amount}], summing to the
    -- parked amount, each target an offered option, count within max_targets.
    declare
      v_allocs jsonb := case when jsonb_typeof(p_result -> 'allocations') = 'array' then p_result -> 'allocations' else '[]'::jsonb end;
      v_dd_amount integer := coalesce((v_decision.params ->> 'amount')::integer, 0);
      v_dd_max integer := coalesce((v_decision.params ->> 'max_targets')::integer, jsonb_array_length(v_decision.options));
      v_dd_n integer := jsonb_array_length(v_allocs);
    begin
      if v_dd_n < 1 or v_dd_n > v_dd_max then
        raise exception 'Must allocate to between 1 and % target(s)', v_dd_max;
      end if;
      if exists (select 1 from jsonb_array_elements(v_allocs) a where coalesce((a ->> 'amount')::integer, 0) < 1) then
        raise exception 'Each allocation must be at least 1 damage';
      end if;
      if (select coalesce(sum((value ->> 'amount')::integer), 0) from jsonb_array_elements(v_allocs)) <> v_dd_amount then
        raise exception 'Allocations must total % damage', v_dd_amount;
      end if;
      if exists (
        select 1 from jsonb_array_elements(v_allocs) a
        where not exists (
          select 1 from jsonb_array_elements(v_decision.options) o
          where ((a ->> 'game_card_id') is not null and (o ->> 'game_card_id') = (a ->> 'game_card_id'))
             or ((a ->> 'player_id') is not null and (o ->> 'player_id') = (a ->> 'player_id'))
        )
      ) then
        raise exception 'Allocation targets a permanent or player that was not offered';
      end if;
      perform public.apply_damage_allocations(v_decision.session_id, v_allocs);
    end;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'scry' then
    with ordered as (
      select (t.value)::uuid as id, 0 as section, t.ord as ordnum from jsonb_array_elements_text(v_top) with ordinality as t(value, ord)
      union all
      select gc.id, 1, gc.zone_position::bigint from public.game_cards gc
      where gc.session_id = v_decision.session_id and gc.owner_id = v_decision.deciding_player_id and gc.zone = 'library' and gc.id <> all(v_option_ids)
      union all
      select (b.value)::uuid, 2, b.ord from jsonb_array_elements_text(v_bottom) with ordinality as b(value, ord)
    ),
    renum as (select id, (row_number() over (order by section, ordnum) - 1) as np from ordered)
    update public.game_cards g set zone_position = renum.np from renum where g.id = renum.id;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'surveil' then
    with g as (select (value)::uuid as id, ord from jsonb_array_elements_text(v_grave) with ordinality as t(value, ord)),
    base as (select coalesce(max(zone_position), -1) as m from public.game_cards where session_id = v_decision.session_id and owner_id = v_decision.deciding_player_id and zone = 'graveyard')
    update public.game_cards gc set zone = 'graveyard', zone_position = base.m + g.ord, is_tapped = false from g, base where gc.id = g.id;
    with ordered as (
      select (t.value)::uuid as id, 0 as section, t.ord as ordnum from jsonb_array_elements_text(v_top) with ordinality as t(value, ord)
      union all
      select lib.id, 1, lib.zone_position::bigint from public.game_cards lib
      where lib.session_id = v_decision.session_id and lib.owner_id = v_decision.deciding_player_id and lib.zone = 'library' and lib.id <> all(v_option_ids)
    ),
    renum as (select id, (row_number() over (order by section, ordnum) - 1) as np from ordered)
    update public.game_cards g set zone_position = renum.np from renum where g.id = renum.id;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'search_library' then
    v_dest := coalesce(v_decision.params ->> 'to', 'hand');
    for v_card in select (value)::uuid from jsonb_array_elements_text(v_top)
    loop
      if v_dest = 'battlefield' then
        select coalesce(max(zone_position), -1) + 1 into v_pos from public.game_cards where session_id = v_decision.session_id and owner_id = v_decision.deciding_player_id and zone = 'battlefield';
        select turn_number into v_turn from public.game_turn_state where session_id = v_decision.session_id;
        update public.game_cards set zone = 'battlefield', zone_position = v_pos, controller_player_id = owner_id, is_tapped = coalesce((v_decision.params ->> 'tapped')::boolean, false), damage_marked = 0, entered_battlefield_turn_number = coalesce(v_turn, 0) where id = v_card;
      elsif v_dest = 'top' then
        select coalesce(min(zone_position), 0) - 1 into v_pos from public.game_cards where session_id = v_decision.session_id and owner_id = v_decision.deciding_player_id and zone = 'library';
        update public.game_cards set zone = 'library', zone_position = v_pos where id = v_card;
      elsif v_dest = 'graveyard' then
        select coalesce(max(zone_position), -1) + 1 into v_pos from public.game_cards where session_id = v_decision.session_id and owner_id = v_decision.deciding_player_id and zone = 'graveyard';
        update public.game_cards set zone = 'graveyard', zone_position = v_pos, is_tapped = false, damage_marked = 0 where id = v_card;
      else
        select coalesce(max(zone_position), -1) + 1 into v_pos from public.game_cards where session_id = v_decision.session_id and owner_id = v_decision.deciding_player_id and zone = 'hand';
        update public.game_cards set zone = 'hand', zone_position = v_pos, is_tapped = false where id = v_card;
      end if;
    end loop;
    update public.game_cards g set zone_position = s.rn
    from (select id, (row_number() over (order by random(), id) - 1) as rn from public.game_cards
          where session_id = v_decision.session_id and owner_id = v_decision.deciding_player_id and zone = 'library') s
    where g.id = s.id;
    if coalesce((v_decision.params ->> 'reveal')::boolean, false) then
      update public.game_pending_decisions set result = result || jsonb_build_object('revealed', v_top)
      where id = v_decision.id returning * into v_decision;
    end if;
    perform public.rebuild_scripted_continuous_effects(v_decision.session_id);
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'choose_cards' then
    v_dest := coalesce(v_decision.params ->> 'to', 'graveyard');
    for v_card in select (value)::uuid from jsonb_array_elements_text(v_top)
    loop
      select coalesce(max(zone_position), -1) + 1 into v_pos from public.game_cards where session_id = v_decision.session_id and owner_id = v_decision.deciding_player_id and zone = v_dest;
      update public.game_cards set zone = v_dest, zone_position = v_pos, is_tapped = false, damage_marked = 0 where id = v_card;
    end loop;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'proliferate' then
    update public.game_cards gc
    set plus_one_counters = case when gc.plus_one_counters > 0 then gc.plus_one_counters + 1 else 0 end,
        counters = public.proliferate_bag(gc.counters)
    where gc.session_id = v_decision.session_id and gc.id = any (v_chosen_ids);

    update public.game_session_players sp
    set counters = public.proliferate_bag(sp.counters)
    where sp.session_id = v_decision.session_id and sp.player_id = any (v_chosen_ids) and sp.counters <> '{}'::jsonb;

    perform public.maybe_finish_game_session(v_decision.session_id);
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'sacrifice' then
    for v_card in select (value)::uuid from jsonb_array_elements_text(v_top)
    loop
      perform public.put_in_graveyard(v_decision.session_id, v_card);
    end loop;
    perform public.rebuild_scripted_continuous_effects(v_decision.session_id);

    -- Tally sacrifices for a later edict create_token (Syphon Flesh). Accumulates
    -- across the each-opponent chain on the spell's own stack item.
    update public.game_stack_items
    set payload = payload || jsonb_build_object('sacrificed_count',
      coalesce((payload ->> 'sacrificed_count')::integer, 0) + jsonb_array_length(v_top))
    where id = v_decision.source_stack_item_id;

    v_decision_id := public.park_edict_sacrifice(
      v_decision.session_id, v_decision.source_stack_item_id,
      coalesce((v_decision.params ->> 'count')::integer, 1),
      v_decision.params ->> 'filter',
      coalesce(v_decision.params -> 'edict_queue', '[]'::jsonb)
    );
    if v_decision_id is null then
      perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);
    end if;

  elsif v_decision.decision_type = 'return_from_graveyard' then
    v_dest := coalesce(v_decision.params ->> 'to', 'hand');
    for v_card in select (value)::uuid from jsonb_array_elements_text(v_top)
    loop
      if v_dest = 'battlefield' then
        select coalesce(max(zone_position), -1) + 1 into v_pos from public.game_cards where session_id = v_decision.session_id and owner_id = v_decision.deciding_player_id and zone = 'battlefield';
        select turn_number into v_turn from public.game_turn_state where session_id = v_decision.session_id;
        -- params.tapped (mig 218, Victimize): "return the chosen cards to the battlefield tapped".
        update public.game_cards set zone = 'battlefield', zone_position = v_pos, controller_player_id = owner_id, is_tapped = coalesce((v_decision.params ->> 'tapped')::boolean, false), damage_marked = 0, plus_one_counters = 0, entered_battlefield_turn_number = coalesce(v_turn, 0) where id = v_card;
      else
        select coalesce(max(zone_position), -1) + 1 into v_pos from public.game_cards where session_id = v_decision.session_id and owner_id = v_decision.deciding_player_id and zone = 'hand';
        update public.game_cards set zone = 'hand', zone_position = v_pos, is_tapped = false where id = v_card;
      end if;
    end loop;
    perform public.rebuild_scripted_continuous_effects(v_decision.session_id);
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'etali_cast_pick' then
    -- Etali (mig 262): every chosen exiled permanent enters the battlefield
    -- under the DECIDER's control (free-cast approximation); the rest stay
    -- exiled.
    select turn_number into v_turn from public.game_turn_state where session_id = v_decision.session_id;
    for v_card in select (value)::uuid from jsonb_array_elements_text(v_top)
    loop
      update public.game_cards gc
      set zone = 'battlefield', controller_player_id = v_decision.deciding_player_id,
          is_tapped = false, damage_marked = 0, plus_one_counters = 0,
          entered_battlefield_turn_number = coalesce(v_turn, 0),
          zone_position = (select coalesce(max(zone_position), -1) + 1
                           from public.game_cards x
                           where x.session_id = v_decision.session_id
                             and x.owner_id = gc.owner_id and x.zone = 'battlefield')
      where gc.id = v_card and gc.session_id = v_decision.session_id and gc.zone = 'exile';
      perform public.register_card_continuous_effects(v_decision.session_id, v_card);
    end loop;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'fight_pick' then
    -- Savage Stomp / Wayta (mig 261): the parked fighter fights the chosen
    -- creature (both deal power damage; apply_fight handles the sweep).
    for v_card in select (value)::uuid from jsonb_array_elements_text(v_top)
    loop
      perform public.apply_fight(
        v_decision.session_id,
        (v_decision.params ->> 'fighter_id')::uuid,
        v_card);
    end loop;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'graveyard_exile_pick' then
    -- Deathgorge Scavenger (mig 259): exile the chosen graveyard card (0 or
    -- 1); a creature card gains the decider life, a noncreature card gives
    -- the SOURCE permanent +1/+1 until end of turn (if still fielded).
    for v_card in select (value)::uuid from jsonb_array_elements_text(v_top)
    loop
      select c.type_line into v_type_line
      from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.id = v_card and gc.session_id = v_decision.session_id;
      select coalesce(max(zone_position), -1) + 1 into v_pos
      from public.game_cards
      where session_id = v_decision.session_id
        and owner_id = (select owner_id from public.game_cards where id = v_card)
        and zone = 'exile';
      update public.game_cards
      set zone = 'exile', zone_position = v_pos, is_tapped = false, damage_marked = 0
      where id = v_card and session_id = v_decision.session_id and zone = 'graveyard';

      if v_type_line ilike '%creature%' then
        update public.game_session_players
        set life_total = life_total + coalesce((v_decision.params ->> 'gain_if_creature')::integer, 2)
        where session_id = v_decision.session_id and player_id = v_decision.deciding_player_id;
      else
        select source_card_id into v_src_card
        from public.game_stack_items where id = v_decision.source_stack_item_id;
        if exists (
          select 1 from public.game_cards
          where id = v_src_card and session_id = v_decision.session_id and zone = 'battlefield'
        ) then
          perform public.create_pt_pump(
            v_decision.session_id, v_src_card,
            coalesce((v_decision.params ->> 'pump_if_noncreature')::integer, 1),
            coalesce((v_decision.params ->> 'pump_if_noncreature')::integer, 1));
        end if;
      end if;
    end loop;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'look_top' then
    -- Ureni (mig 223): the chosen card (0 or 1) goes to the battlefield under
    -- the deciding player's control (fires ETB); every OTHER looked-at card goes
    -- to the bottom of the library in a random order. to:'exile' (mig 248,
    -- hideaway): the pick is exiled and remembered on the SOURCE permanent's
    -- counter bag (hideaway_card) for a later play_hideaway.
    v_dest := coalesce(v_decision.params ->> 'to', 'battlefield');
    for v_card in select (value)::uuid from jsonb_array_elements_text(v_top)
    loop
      if v_dest = 'exile' then
        select coalesce(max(zone_position), -1) + 1 into v_pos
        from public.game_cards where session_id = v_decision.session_id and owner_id = v_decision.deciding_player_id and zone = 'exile';
        update public.game_cards
        set zone = 'exile', zone_position = v_pos, controller_player_id = owner_id,
            is_tapped = false, damage_marked = 0
        where id = v_card;
        select source_card_id into v_src_card from public.game_stack_items where id = v_decision.source_stack_item_id;
        if v_src_card is not null then
          update public.game_cards
          set counters = coalesce(counters, '{}'::jsonb) || jsonb_build_object('hideaway_card', v_card::text)
          where id = v_src_card and session_id = v_decision.session_id;
        end if;
      else
        select coalesce(max(zone_position), -1) + 1 into v_pos
        from public.game_cards where session_id = v_decision.session_id and owner_id = v_decision.deciding_player_id and zone = 'battlefield';
        select turn_number into v_turn from public.game_turn_state where session_id = v_decision.session_id;
        update public.game_cards
        set zone = 'battlefield', zone_position = v_pos, controller_player_id = owner_id,
            is_tapped = false, damage_marked = 0, plus_one_counters = 0,
            entered_battlefield_turn_number = coalesce(v_turn, 0)
        where id = v_card;
      end if;
    end loop;
    perform public.bottom_cards_random(
      v_decision.session_id, v_decision.deciding_player_id,
      (select coalesce(array_agg((e)::uuid), array[]::uuid[])
       from jsonb_array_elements_text(v_decision.params -> 'looked_at') e
       where (e)::uuid <> all(coalesce(v_chosen_ids, array[]::uuid[]))));
    perform public.rebuild_scripted_continuous_effects(v_decision.session_id);
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'reanimate_destroyed' then
    -- Necromantic Selection (mig 208): the chosen destroyed creature returns to
    -- the battlefield under the DECIDING player's control (unlike
    -- return_from_graveyard, which returns to its owner's control). The card
    -- stays owned by its owner; only control changes. ("…black Zombie in
    -- addition to its other colors and types" is not modelled — no type layer.)
    for v_card in select (value)::uuid from jsonb_array_elements_text(v_top)
    loop
      select coalesce(max(zone_position), -1) + 1 into v_pos
      from public.game_cards gc2
      where gc2.session_id = v_decision.session_id
        and gc2.owner_id = (select owner_id from public.game_cards where id = v_card)
        and gc2.zone = 'battlefield';
      select turn_number into v_turn from public.game_turn_state where session_id = v_decision.session_id;
      update public.game_cards
      set zone = 'battlefield', zone_position = v_pos,
          controller_player_id = v_decision.deciding_player_id,
          is_tapped = false, damage_marked = 0, plus_one_counters = 0,
          entered_battlefield_turn_number = coalesce(v_turn, 0)
      where id = v_card;
    end loop;
    perform public.rebuild_scripted_continuous_effects(v_decision.session_id);
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'confirm' then
    if coalesce((v_decision.result ->> 'confirmed')::boolean, false) then
      -- Optional "you may pay {cost}" — pay it before applying the effects (raises
      -- if the deciding player can't pay, so the client should only offer it when
      -- affordable). The deciding player is the one who chose to pay.
      if nullif(v_decision.params ->> 'cost', '') is not null then
        perform public.pay_mana_cost(
          v_decision.session_id, v_decision.deciding_player_id, v_decision.params ->> 'cost', null);
      end if;
      select nullif(payload ->> 'controller_player_id', '')::uuid, source_card_id, nullif(payload ->> 'target_card_id', '')::uuid
        into v_ctrl, v_src_card, v_tgt
      from public.game_stack_items where id = v_decision.source_stack_item_id;
      perform public.apply_targeted_triggered_ability_effects(
        v_decision.session_id, coalesce(v_ctrl, v_decision.deciding_player_id), v_src_card,
        coalesce(v_decision.params -> 'effects', '[]'::jsonb), v_tgt
      );
    end if;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'copy_permanent' then
    -- Token copy (mig 239, Will of the Temur): create a token that's a copy of
    -- the picked permanent, with the parked `except` overrides (set_pt +
    -- keyword grants), then resume the program.
    foreach v_card in array v_chosen_ids
    loop
      perform public.create_copy_token(
        v_decision.session_id, v_decision.deciding_player_id, v_card,
        v_decision.params -> 'except');
    end loop;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'cast_exiled_free' then
    -- Breaching Dragonstorm (mig 245). Chosen: a PERMANENT card enters the
    -- battlefield under the decider's control (free-cast approximation;
    -- instants/sorceries go to hand instead). Declined: the card goes to its
    -- owner's hand.
    select (o.value ->> 'game_card_id')::uuid into v_card
    from jsonb_array_elements(v_decision.options) o limit 1;
    if cardinality(v_chosen_ids) > 0 and exists (
      select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.id = v_card and gc.session_id = v_decision.session_id
        and (c.type_line ilike '%creature%' or c.type_line ilike '%artifact%'
             or c.type_line ilike '%enchantment%' or c.type_line ilike '%land%'
             or c.type_line ilike '%planeswalker%' or c.type_line ilike '%battle%')
    ) then
      select turn_number into v_turn
      from public.game_turn_state where session_id = v_decision.session_id;
      update public.game_cards gc
      set zone = 'battlefield', controller_player_id = v_decision.deciding_player_id,
          is_tapped = false, entered_battlefield_turn_number = coalesce(v_turn, 0),
          zone_position = (select coalesce(max(zone_position), -1) + 1
                           from public.game_cards x
                           where x.session_id = v_decision.session_id
                             and x.owner_id = gc.owner_id and x.zone = 'battlefield')
      where gc.id = v_card;
      perform public.register_card_continuous_effects(v_decision.session_id, v_card);
    else
      update public.game_cards gc
      set zone = 'hand',
          zone_position = (select coalesce(max(zone_position), -1) + 1
                           from public.game_cards x
                           where x.session_id = v_decision.session_id
                             and x.owner_id = gc.owner_id and x.zone = 'hand')
      where gc.id = v_card;
    end if;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'vote' then
    -- Council's dilemma (mig 252, Selvala's Stampede). Record the vote on
    -- the stack payload; park the next voter, or — when the queue is empty —
    -- tally and apply: wild reveals from the CASTER's library until that
    -- many creature cards entered under them (other revealed cards bottom in
    -- a random order), free rides the payload for the following
    -- put_from_hand action.
    declare
      v_vote text := lower(coalesce(p_result ->> 'value', ''));
      v_vq jsonb := coalesce(v_decision.params -> 'queue', '[]'::jsonb);
      v_stk public.game_stack_items;
      v_wild integer;
      v_free integer;
      v_caster uuid;
      v_found integer := 0;
      v_scanned integer := 0;
      v_lib_size integer;
      v_rest uuid[] := array[]::uuid[];
      v_scan_id uuid;
      v_scan_creature boolean;
    begin
      if v_vote not in ('wild', 'free') then
        raise exception 'Vote must be wild or free';
      end if;
      update public.game_stack_items
      set payload = jsonb_set(payload, '{votes}', coalesce(payload -> 'votes', '[]'::jsonb) || to_jsonb(v_vote))
      where id = v_decision.source_stack_item_id
      returning * into v_stk;

      if jsonb_array_length(v_vq) > 0 then
        insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
        values (v_decision.session_id, (v_vq ->> 0)::uuid, v_decision.source_stack_item_id, 'vote',
          'Vote wild or free',
          '[{"value":"wild"},{"value":"free"}]'::jsonb, 1, 1,
          jsonb_build_object('queue',
            (select coalesce(jsonb_agg(t.value), '[]'::jsonb)
             from jsonb_array_elements(v_vq) with ordinality t(value, ord)
             where t.ord > 1)));
      else
        select count(*) into v_wild
        from jsonb_array_elements_text(coalesce(v_stk.payload -> 'votes', '[]'::jsonb)) v(val)
        where v.val = 'wild';
        select count(*) into v_free
        from jsonb_array_elements_text(coalesce(v_stk.payload -> 'votes', '[]'::jsonb)) v(val)
        where v.val = 'free';
        v_caster := coalesce(nullif(v_stk.payload ->> 'controller_player_id', '')::uuid, v_stk.controller_player_id);

        select count(*) into v_lib_size
        from public.game_cards
        where session_id = v_decision.session_id and owner_id = v_caster and zone = 'library';
        select turn_number into v_turn
        from public.game_turn_state where session_id = v_decision.session_id;

        while v_found < v_wild and v_scanned < v_lib_size loop
          select gc.id, (c.type_line ilike '%creature%')
          into v_scan_id, v_scan_creature
          from public.game_cards gc join public.cards c on c.id = gc.card_id
          where gc.session_id = v_decision.session_id and gc.owner_id = v_caster and gc.zone = 'library'
            and gc.id <> all(v_rest)
          order by gc.zone_position asc, gc.id asc limit 1;
          exit when v_scan_id is null;
          v_scanned := v_scanned + 1;
          if v_scan_creature then
            update public.game_cards gc
            set zone = 'battlefield', controller_player_id = v_caster, is_tapped = false,
                entered_battlefield_turn_number = coalesce(v_turn, 0),
                zone_position = (select coalesce(max(zone_position), -1) + 1
                                 from public.game_cards x
                                 where x.session_id = v_decision.session_id
                                   and x.owner_id = gc.owner_id and x.zone = 'battlefield')
            where gc.id = v_scan_id;
            perform public.register_card_continuous_effects(v_decision.session_id, v_scan_id);
            v_found := v_found + 1;
          else
            v_rest := v_rest || v_scan_id;
          end if;
        end loop;
        if cardinality(v_rest) > 0 then
          perform public.bottom_cards_random(v_decision.session_id, v_caster, v_rest);
        end if;

        update public.game_stack_items
        set payload = payload || jsonb_build_object('free_votes', v_free)
        where id = v_decision.source_stack_item_id;
        perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);
      end if;
    end;

  elsif v_decision.decision_type = 'command_zone_pick' then
    -- Hellkite Courser (mig 248): the picked commander enters the battlefield
    -- with haste (until end of turn) and a return_to_command marker the end
    -- step processes. Empty = declined.
    select turn_number into v_turn
    from public.game_turn_state where session_id = v_decision.session_id;
    foreach v_card in array v_chosen_ids
    loop
      update public.game_cards gc
      set zone = 'battlefield', controller_player_id = gc.owner_id,
          is_tapped = false, entered_battlefield_turn_number = coalesce(v_turn, 0),
          counters = coalesce(gc.counters, '{}'::jsonb) || jsonb_build_object('return_to_command', 1),
          zone_position = (select coalesce(max(zone_position), -1) + 1
                           from public.game_cards x
                           where x.session_id = v_decision.session_id
                             and x.owner_id = gc.owner_id and x.zone = 'battlefield')
      where gc.id = v_card;
      perform public.register_card_continuous_effects(v_decision.session_id, v_card);
      insert into public.game_continuous_effects (
        session_id, source_card_id, affected_card_id, effect_type, payload,
        source_zone_required, expires_at_phase, expires_at_step)
      values (v_decision.session_id, v_card, v_card, 'haste',
        jsonb_build_object('until_end_of_turn', true), 'battlefield', 'ending', 'cleanup');
    end loop;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'put_from_hand_pick' then
    -- Broodcaller Scourge (mig 247): each picked hand card enters the
    -- battlefield under the decider's control. Empty = declined.
    select turn_number into v_turn
    from public.game_turn_state where session_id = v_decision.session_id;
    foreach v_card in array v_chosen_ids
    loop
      update public.game_cards gc
      set zone = 'battlefield', controller_player_id = v_decision.deciding_player_id,
          is_tapped = false, entered_battlefield_turn_number = coalesce(v_turn, 0),
          zone_position = (select coalesce(max(zone_position), -1) + 1
                           from public.game_cards x
                           where x.session_id = v_decision.session_id
                             and x.owner_id = gc.owner_id and x.zone = 'battlefield')
      where gc.id = v_card;
      perform public.register_card_continuous_effects(v_decision.session_id, v_card);
    end loop;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'destroy_pick' then
    -- Parapet Thrasher mode (mig 247): destroy each picked permanent.
    foreach v_card in array v_chosen_ids
    loop
      perform public.put_in_graveyard(v_decision.session_id, v_card);
    end loop;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'bounce_pick' then
    -- Hammerhead Tyrant (mig 244): bounce each picked permanent to its
    -- OWNER's hand (the bounce primitive resets controller/taps properly).
    foreach v_card in array v_chosen_ids
    loop
      perform public.apply_creature_effect(v_decision.session_id, 'bounce', v_card, '{}'::jsonb);
    end loop;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'pay_x_mana_damage' then
    -- Leyline Tyrant (mig 244): amount 0 / no pick declines. Validated here
    -- in the apply section (divide_damage precedent) — an exception rolls the
    -- whole transaction back.
    declare
      v_px_amount integer := greatest(0, coalesce((p_result ->> 'amount')::integer, 0));
      v_px_color text := upper(coalesce(v_decision.params ->> 'color', 'R'));
      v_px_pool integer;
    begin
      if v_px_amount > 0 then
        if not exists (
          select 1 from jsonb_array_elements(v_decision.options) o
          where ((p_result ->> 'game_card_id') is not null and (o ->> 'game_card_id') = (p_result ->> 'game_card_id'))
             or ((p_result ->> 'player_id') is not null and (o ->> 'player_id') = (p_result ->> 'player_id'))
        ) then
          raise exception 'A target from the offered list is required';
        end if;
        select coalesce((mana_pool ->> v_px_color)::integer, 0) into v_px_pool
        from public.game_players
        where session_id = v_decision.session_id and player_id = v_decision.deciding_player_id;
        if coalesce(v_px_pool, 0) < v_px_amount then
          raise exception 'Not enough {%} mana: have %', v_px_color, coalesce(v_px_pool, 0);
        end if;
        update public.game_players
        set mana_pool = jsonb_set(mana_pool, array[v_px_color], to_jsonb(v_px_pool - v_px_amount))
        where session_id = v_decision.session_id and player_id = v_decision.deciding_player_id;
        perform public.apply_damage_allocations(v_decision.session_id,
          jsonb_build_array(
            case when (p_result ->> 'game_card_id') is not null
                 then jsonb_build_object('game_card_id', p_result ->> 'game_card_id', 'amount', v_px_amount)
                 else jsonb_build_object('player_id', p_result ->> 'player_id', 'amount', v_px_amount) end));
      end if;
    end;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'become_copy' then
    -- Become-copy pick (mig 240): an empty submit declines the "may"; a pick
    -- turns the SOURCE card into a copy of it (until end of turn for Sarkhan).
    if cardinality(v_chosen_ids) > 0 then
      select source_card_id into v_src_card from public.game_stack_items where id = v_decision.source_stack_item_id;
      perform public.become_copy(
        v_decision.session_id, v_src_card, v_chosen_ids[1],
        v_decision.params -> 'except',
        coalesce((v_decision.params ->> 'until_end_of_turn')::boolean, false),
        coalesce((v_decision.params ->> 'fire_etb')::boolean, false));
    end if;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'choose_player' then
    v_chosen_player := nullif(v_decision.result ->> 'player_id', '')::uuid;
    select source_card_id into v_src_card from public.game_stack_items where id = v_decision.source_stack_item_id;
    select coalesce(jsonb_agg(e.value || jsonb_build_object('recipient', 'controller')), '[]'::jsonb)
      into v_effects_rewritten
    from jsonb_array_elements(coalesce(v_decision.params -> 'effects', '[]'::jsonb)) e;
    perform public.apply_triggered_ability_effects(v_decision.session_id, v_chosen_player, v_src_card, v_effects_rewritten);
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'choose_color' then
    -- Heraldic Banner (mig 209): register the colour-filtered anthem with the
    -- chosen colour. Source = the deciding card; battlefield-gated so it goes
    -- inert when the source leaves; NOT script-flagged so rebuilds keep it.
    select source_card_id into v_src_card from public.game_stack_items where id = v_decision.source_stack_item_id;
    if v_decision.params -> 'anthem' is not null and v_src_card is not null then
      insert into public.game_continuous_effects (
        session_id, source_card_id, affected_player_id, effect_type, payload, source_zone_required)
      values (
        v_decision.session_id, v_src_card,
        case when lower(coalesce(v_decision.params -> 'anthem' ->> 'scope', 'controller')) = 'all'
             then null else v_decision.deciding_player_id end,
        'pump',
        jsonb_build_object(
          'power', coalesce((v_decision.params -> 'anthem' ->> 'power')::integer, 0),
          'toughness', coalesce((v_decision.params -> 'anthem' ->> 'toughness')::integer, 0),
          'color', lower(v_decision.result ->> 'color')),
        'battlefield');
    end if;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'choose_creature_type' then
    v_chosen_type := nullif(v_decision.result ->> 'type', '');
    select source_card_id into v_src_card from public.game_stack_items where id = v_decision.source_stack_item_id;
    -- Persist the chosen type into the source card's own script when it uses
    -- the '$chosen' placeholder (mig 239, Reflections of Littjara: its
    -- spell_cast watcher's type filter becomes the chosen type). The baked
    -- script lands in copied_script, which effective_script prefers and which
    -- survives rebuilds. The chosen type comes from the curated options list,
    -- so the text substitution is safe.
    if v_src_card is not null then
      v_eff_script := public.effective_script(v_decision.session_id, v_src_card);
      if v_eff_script is not null and v_eff_script::text like '%"$chosen"%' then
        update public.game_cards
        set copied_script = replace(v_eff_script::text, '"$chosen"', to_jsonb(v_chosen_type)::text)::jsonb
        where id = v_src_card and session_id = v_decision.session_id;
      end if;
    end if;
    -- Inject the chosen type into any count-based amount's type_line (Distant Melody)
    -- and into a pump_all's creature_type (Crippling Fear: "creatures that aren't the
    -- chosen type get -3/-3 until end of turn").
    select coalesce(jsonb_agg(
      case
        when jsonb_typeof(e.value -> 'amount') = 'object' and (e.value -> 'amount') ? 'count'
          then jsonb_set(e.value, '{amount,type_line}', to_jsonb(v_chosen_type))
        when lower(coalesce(e.value ->> 'type', '')) = 'pump_all'
          then jsonb_set(e.value, '{creature_type}', to_jsonb(v_chosen_type))
        else e.value end
    ), '[]'::jsonb)
      into v_effects_rewritten
    from jsonb_array_elements(coalesce(v_decision.params -> 'effects', '[]'::jsonb)) e;
    -- pump_all effects insert a temporary until-EOT mass pump (helper); the rest
    -- resolve through the normal pipeline.
    for v_pe in select value from jsonb_array_elements(v_effects_rewritten) where lower(coalesce(value ->> 'type', '')) = 'pump_all'
    loop
      perform public.apply_mass_pump_until_eot(v_decision.session_id, v_src_card, v_decision.deciding_player_id, v_pe);
    end loop;
    select coalesce(jsonb_agg(value), '[]'::jsonb) into v_effects_rewritten
    from jsonb_array_elements(v_effects_rewritten) where lower(coalesce(value ->> 'type', '')) <> 'pump_all';
    if jsonb_array_length(v_effects_rewritten) > 0 then
      perform public.apply_triggered_ability_effects(v_decision.session_id, v_decision.deciding_player_id, v_src_card, v_effects_rewritten);
    end if;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);
  end if;

  return v_decision;
end;
$$;
grant execute on function public.submit_decision(uuid, jsonb) to authenticated;

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
      'first_strike', 'double_strike', 'deathtouch', 'indestructible'
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

create or replace function public.trigger_effect_target_type(p_effect jsonb)
returns jsonb language sql immutable as $$
  select case
    when lower(coalesce(p_effect ->> 'type', '')) in
         ('deal_damage', 'destroy', 'exile', 'bounce', 'tap', 'untap',
          'add_counters', 'grant_keyword', 'fight', 'gain_control', 'set_pt', 'pump', 'goad',
          'exile_and_manifest', 'ignition', 'exile_until_leaves')
         and public.behavior_target_type_is_creature_only(p_effect -> 'target_type')
      then '"creature"'::jsonb
    when lower(coalesce(p_effect ->> 'type', '')) in
         ('destroy', 'exile', 'bounce', 'tap', 'untap', 'shuffle_into_library', 'gain_control',
          'exile_until_leaves')
         and public.behavior_target_type_is_permanent_only(p_effect -> 'target_type')
      then p_effect -> 'target_type'
    else null
  end;
$$;
grant all on function public.trigger_effect_target_type(jsonb) to anon, authenticated, service_role;

create or replace function public.fire_zone_change_triggers() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Enters the battlefield.
  if NEW.zone = 'battlefield'
    and (TG_OP = 'INSERT' or OLD.zone is distinct from 'battlefield')
  then
    -- "Creatures your opponents control enter tapped" (mig 258, Kinjalli's
    -- Sunwing): a battlefield source with a creatures_enter_tapped row taps
    -- every creature entering under another player's control. The is_tapped
    -- update re-fires this trigger with zone unchanged, so it skips this block.
    if exists (
      select 1
      from public.game_continuous_effects ce
      join public.game_cards src
        on src.id = ce.source_card_id and src.session_id = ce.session_id
      where ce.session_id = NEW.session_id
        and ce.effect_type = 'creatures_enter_tapped'
        and src.zone = 'battlefield'
        and coalesce(src.controller_player_id, src.owner_id)
            is distinct from coalesce(NEW.controller_player_id, NEW.owner_id)
    ) and exists (
      select 1 from public.cards c
      where c.id = NEW.card_id and c.type_line ilike '%creature%'
    ) then
      update public.game_cards
      set is_tapped = true
      where id = NEW.id and session_id = NEW.session_id and is_tapped = false;
    end if;

    perform public.fire_card_triggers(
      NEW.session_id, NEW.id,
      array['enters_the_battlefield', 'etb', 'enters']
    );
    perform public.fire_watcher_triggers(
      NEW.session_id, NEW.id,
      coalesce(NEW.controller_player_id, NEW.owner_id), 'creature_entered'
    );
    -- Landfall (mig 238, Nesting Dragon): "whenever a land you control enters."
    -- Fired for every entry; the watcher's type filter defaults to 'land' for
    -- this event, so only land entries actually match.
    perform public.fire_watcher_triggers(
      NEW.session_id, NEW.id,
      coalesce(NEW.controller_player_id, NEW.owner_id), 'land_entered'
    );
  end if;

  -- Dies (moves from the battlefield to the graveyard).
  if TG_OP = 'UPDATE'
    and OLD.zone = 'battlefield'
    and NEW.zone = 'graveyard'
  then
    perform public.fire_card_triggers(
      NEW.session_id, NEW.id,
      array['dies', 'death']
    );
    -- OLD.controller = the creature's controller while it was alive.
    perform public.fire_watcher_triggers(
      NEW.session_id, NEW.id,
      coalesce(OLD.controller_player_id, OLD.owner_id), 'creature_died'
    );
  end if;

  -- Leaves the battlefield (to any other zone, including graveyard/hand/exile).
  if TG_OP = 'UPDATE'
    and OLD.zone = 'battlefield'
    and NEW.zone is distinct from 'battlefield'
  then
    -- "For as long as ~ remains on the battlefield" steals (mig 246,
    -- Opportunistic Dragon): the thief leaving reverts control of everything
    -- it stole (and restores a blanked script).
    update public.game_cards gc
    set controller_player_id = nullif(ce.payload ->> 'original_controller', '')::uuid,
        copied_script = case when coalesce((ce.payload ->> 'lose_abilities')::boolean, false)
                             then null else gc.copied_script end
    from public.game_continuous_effects ce
    where ce.session_id = NEW.session_id
      and ce.effect_type = 'control'
      and coalesce((ce.payload ->> 'while_source')::boolean, false)
      and ce.source_card_id = NEW.id
      and ce.affected_card_id = gc.id
      and gc.session_id = NEW.session_id
      and gc.zone = 'battlefield'
      and nullif(ce.payload ->> 'original_controller', '') is not null;
    delete from public.game_continuous_effects ce
    where ce.session_id = NEW.session_id
      and ce.effect_type = 'control'
      and coalesce((ce.payload ->> 'while_source')::boolean, false)
      and ce.source_card_id = NEW.id;

    -- Exile-until-leaves returns (mig 262, Bronzebeak Foragers): everything
    -- this card exiled comes back to the battlefield under its owner.
    update public.game_cards gc
    set zone = 'battlefield', controller_player_id = gc.owner_id, is_tapped = false,
        damage_marked = 0, plus_one_counters = 0,
        entered_battlefield_turn_number = coalesce(
          (select ts.turn_number from public.game_turn_state ts
           where ts.session_id = NEW.session_id), 0),
        zone_position = (select coalesce(max(x.zone_position), -1) + 1
                         from public.game_cards x
                         where x.session_id = NEW.session_id
                           and x.owner_id = gc.owner_id and x.zone = 'battlefield')
    from public.game_continuous_effects ce
    where ce.session_id = NEW.session_id
      and ce.effect_type = 'exiled_until_leaves'
      and ce.source_card_id = NEW.id
      and ce.affected_card_id = gc.id
      and gc.session_id = NEW.session_id
      and gc.zone = 'exile';
    delete from public.game_continuous_effects ce
    where ce.session_id = NEW.session_id
      and ce.effect_type = 'exiled_until_leaves'
      and ce.source_card_id = NEW.id;

    perform public.fire_card_triggers(
      NEW.session_id, NEW.id,
      array['leaves_the_battlefield', 'ltb', 'leaves']
    );
    -- Watcher broadcast (mig 201): "whenever a creature you control leaves the
    -- battlefield" (Vela the Night-Clad). OLD.controller = controller while it
    -- was on the battlefield.
    perform public.fire_watcher_triggers(
      NEW.session_id, NEW.id,
      coalesce(OLD.controller_player_id, OLD.owner_id), 'creature_left'
    );
  end if;

  return null;
end;
$$;
