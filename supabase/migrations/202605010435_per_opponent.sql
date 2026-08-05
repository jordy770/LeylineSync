-- 202605010435_per_opponent
-- Per-opponent amounts & targets (bucket 3, eerste slice):
-- - times_opponents-rider op effect-amounts (Exsanguinate / Malakir
--   Bloodwitch: "gain life equal to the life lost this way" = basis ×
--   aantal opponents), generiek in apply_triggered_ability_effects.
-- - choose_player parkeert zijn geneste effects nu met PRE-resolved
--   event_amount (Sanguine Bond / Vito: "target opponent loses that much
--   life" — de submit-time apply heeft geen event-payload meer).
-- - Nieuwe count opponents_with_more_lands (Priest of the Blessed Graf).
-- - Nieuwe actie shuffle_graveyards_into_libraries (Struggle // Survive's
--   aftermath-helft, gemodelleerd als flashback + flashback_effect).
-- Generated from supabase/functions_src (apply_triggered_ability_effects, apply_trigger_effects, resolve_count_amount) — those files are
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
  v_lore integer;
  v_saga jsonb;
  v_chapter jsonb;
  v_saga_max integer;
begin
  for v_effect in
    select * from jsonb_array_elements(coalesce(p_effects, '[]'::jsonb))
  loop
    v_eff_type := lower(coalesce(v_effect ->> 'type', ''));
    v_eff_amount := public.resolve_dynamic_amount(
      p_session_id, p_source_card_id, p_controller_id, v_effect -> 'amount');
    v_recipient := lower(coalesce(v_effect ->> 'recipient', ''));

    -- ×-number-of-opponents rider (mig 435, Exsanguinate / Malakir Bloodwitch:
    -- "you gain life equal to the life lost this way" — base amount times the
    -- number of opponents in multiplayer).
    if coalesce((v_effect ->> 'times_opponents')::boolean, false) then
      v_eff_amount := v_eff_amount * (
        select count(*)::integer from public.game_session_players
        where session_id = p_session_id and player_id is distinct from p_controller_id);
    end if;

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
            perform public.fire_lifegain_triggers(p_session_id, v_rid, v_eff_amount);
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
      -- recipient mirrors the mill branch below: controller (default) /
      -- each_player / each_opponent. Previously ignored — every draw landed on
      -- the controller (bug-2684: Cut a Deal drew for the CASTER instead of
      -- each opponent).
      if v_recipient = 'controller' or v_recipient = '' then
        v_recipients := array[p_controller_id];
      elsif v_recipient in ('each_player', 'all_players') then
        select array_agg(player_id) into v_recipients
        from public.game_session_players where session_id = p_session_id;
      elsif v_recipient = 'active_player' then
        -- The TURN player draws (mig 396, Kami of the Crescent Moon on the
        -- broadcast each-draw-step event: "each player draws an additional
        -- card" = whoever's draw step is happening).
        select array[active_player_id] into v_recipients
        from public.game_turn_state where session_id = p_session_id;
      else
        select array_agg(player_id) into v_recipients
        from public.game_session_players
        where session_id = p_session_id and player_id is distinct from p_controller_id;
      end if;
      foreach v_rid in array coalesce(v_recipients, array[]::uuid[]) loop
        if v_rid is null then continue; end if;
        -- "draw a card" (no amount key) defaults to 1; an explicit amount draws
        -- exactly that many — incl. a dynamic count that resolves to 0 ("draw a
        -- card for each X" with X=0 draws nothing). 1..0 runs zero iterations.
        for v_draw_i in 1..(case when v_effect ? 'amount' then v_eff_amount else 1 end) loop
          select coalesce(max(zone_position), -1) + 1 into v_next_hand_position
          from public.game_cards
          where session_id = p_session_id and owner_id = v_rid and zone = 'hand';
          select id into v_lib_card
          from public.game_cards
          where session_id = p_session_id and owner_id = v_rid and zone = 'library'
          order by zone_position asc, id asc limit 1 for update skip locked;
          exit when v_lib_card is null;
          update public.game_cards
          set zone = 'hand', zone_position = v_next_hand_position, is_tapped = false
          where id = v_lib_card;
          -- card_drawn watcher (mig 401): every card drawn by the effect
          -- broadcasts with its 1-based per-turn index.
          perform public.fire_watcher_triggers(
            p_session_id, v_lib_card, v_rid, 'card_drawn',
            jsonb_build_object('draw_number', public.note_card_drawn(p_session_id, v_rid)));
        end loop;
      end loop;

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
      elsif (v_effect ->> 'count') = 'X' then
        -- "create X tokens" (mig 300, Champions from Beyond): X was stamped on
        -- the source permanent's counter bag at cast (cast_card_from_hand).
        select coalesce((counters ->> 'x')::integer, 0) into v_token_count
        from public.game_cards where id = p_source_card_id and session_id = p_session_id;
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
            -- exclude_type (mig 268, Whipflare: "each NONARTIFACT creature").
            and (nullif(v_effect -> 'filter' ->> 'exclude_type', '') is null
                 or c.type_line not ilike '%' || (v_effect -> 'filter' ->> 'exclude_type') || '%')
            -- filter.controller (mig 395, Thundermaw Hellkite: "each creature
            -- with flying your OPPONENTS control"): 'you' / 'opponent',
            -- relative to the effect's controller. Absent = any controller.
            and (nullif(v_effect -> 'filter' ->> 'controller', '') is null
                 or (lower(v_effect -> 'filter' ->> 'controller') = 'you'
                     and coalesce(gc.controller_player_id, gc.owner_id) = p_controller_id)
                 or (lower(v_effect -> 'filter' ->> 'controller') = 'opponent'
                     and coalesce(gc.controller_player_id, gc.owner_id) is distinct from p_controller_id))
        loop
          perform public.apply_damage_to_creature(
            p_session_id, v_dmg_target, v_eff_amount, p_source_card_id, false, false, false);
          -- tap_damaged (mig 395, Thundermaw: "…Tap those creatures.")
          if coalesce((v_effect ->> 'tap_damaged')::boolean, false) then
            update public.game_cards set is_tapped = true
            where id = v_dmg_target and session_id = p_session_id;
          end if;
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

    elsif v_eff_type = 'shuffle_graveyards_into_libraries' then
      -- Survive (mig 435, Struggle // Survive's aftermath half): each player
      -- shuffles their graveyard into their library — move, then reshuffle the
      -- whole library so the returned cards land in random positions.
      for v_rid in
        select player_id from public.game_session_players where session_id = p_session_id
      loop
        update public.game_cards
        set zone = 'library', is_tapped = false, damage_marked = 0
        where session_id = p_session_id and owner_id = v_rid and zone = 'graveyard';
        with shuffled as (
          select id, (row_number() over (order by random())) - 1 as pos
          from public.game_cards
          where session_id = p_session_id and owner_id = v_rid and zone = 'library'
        )
        update public.game_cards g
        set zone_position = shuffled.pos
        from shuffled
        where g.id = shuffled.id;
      end loop;

    elsif v_eff_type = 'destroy_all' then
      if p_controller_id is not null then
        if nullif(v_effect ->> 'min_power', '') is not null then
          -- 'Destroy all creatures with power greater than …' (mig 281,
          -- Fell the Mighty — the target-relative bound is approximated as a
          -- fixed threshold). Indestructible survives.
          for v_dmg_target in
            select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
            where gc.session_id = p_session_id and gc.zone = 'battlefield'
              and c.type_line ilike '%creature%'
              and coalesce(public.card_effective_power(p_session_id, gc.id), 0)
                  >= (v_effect ->> 'min_power')::integer
              and not public.card_has_indestructible(p_session_id, gc.id)
          loop
            perform public.put_in_graveyard(p_session_id, v_dmg_target);
          end loop;
        elsif jsonb_typeof(v_effect -> 'types') = 'array' then
          -- "Destroy all artifacts, creatures, and enchantments" (mig 268,
          -- Nevinyrral's Disk). Any-type match; indestructible survives.
          -- mig 395: the types branch honors `scope` like the creature branch
          -- (Ruinous Ultimatum: 'destroy all nonland permanents your OPPONENTS
          -- control' — scope 'opponent'); default 'all' keeps Disk behavior.
          for v_dmg_target in
            select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
            where gc.session_id = p_session_id and gc.zone = 'battlefield'
              and exists (select 1 from jsonb_array_elements_text(v_effect -> 'types') t
                          where c.type_line ilike '%' || t.value || '%')
              and (lower(coalesce(v_effect ->> 'scope', 'all')) = 'all'
                   or (lower(v_effect ->> 'scope') = 'you'
                       and coalesce(gc.controller_player_id, gc.owner_id) = p_controller_id)
                   or (lower(v_effect ->> 'scope') = 'opponent'
                       and coalesce(gc.controller_player_id, gc.owner_id) is distinct from p_controller_id))
              and not public.card_has_indestructible(p_session_id, gc.id)
          loop
            perform public.put_in_graveyard(p_session_id, v_dmg_target);
          end loop;
        elsif nullif(v_effect ->> 'exclude_type', '') is not null then
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
          lower(coalesce(v_effect ->> 'from', '')) = 'all_graveyards',
          -- types + under:'owner' (mig 269, Open the Vaults).
          v_effect -> 'types',
          lower(coalesce(v_effect ->> 'under', '')) = 'owner');
      end if;

    elsif v_eff_type = 'gain_control_all' then
      -- Hellkite Tyrant (mig 269): "gain control of all artifacts that player
      -- controls" on connecting. Permanent steal of every matching opposing
      -- permanent (1v1: the damaged player IS the only opponent).
      if p_controller_id is not null then
        update public.game_cards gc
        set controller_player_id = p_controller_id
        from public.cards c
        where c.id = gc.card_id and gc.session_id = p_session_id and gc.zone = 'battlefield'
          and coalesce(gc.controller_player_id, gc.owner_id) is distinct from p_controller_id
          and c.type_line ilike '%' || coalesce(v_effect ->> 'type_line', '') || '%';
        perform public.rebuild_scripted_continuous_effects(p_session_id);
      end if;

    elsif v_eff_type = 'bounce_all' then
      -- Coastal Breach (mig 269): "return each nonland permanent to its
      -- owner's hand." Tokens cease via the usual cleanup trigger.
      -- scope 'opponent' (mig 428, Cyclonic Rift overload): only permanents the
      -- controller does NOT control; default 'all' keeps Coastal Breach behavior.
      update public.game_cards gc
      set zone = 'hand', is_tapped = false, damage_marked = 0, plus_one_counters = 0,
          attached_to = null, controller_player_id = gc.owner_id,
          zone_position = (select coalesce(max(x.zone_position), -1) + 1
                           from public.game_cards x
                           where x.session_id = p_session_id
                             and x.owner_id = gc.owner_id and x.zone = 'hand')
      from public.cards c
      where c.id = gc.card_id and gc.session_id = p_session_id and gc.zone = 'battlefield'
        and (not coalesce((v_effect ->> 'nonland')::boolean, true)
             or c.type_line not ilike '%land%')
        and (lower(coalesce(v_effect ->> 'scope', 'all')) <> 'opponent'
             or coalesce(gc.controller_player_id, gc.owner_id) is distinct from p_controller_id);

    elsif v_eff_type = 'destroy_all_creatures_token' then
      -- Phyrexian Rebirth (mig 269): "destroy all creatures, then create an
      -- X/X Horror where X is the number destroyed." Indestructible survives
      -- and does not count.
      if p_controller_id is not null then
        v_token_count := 0;
        for v_dmg_target in
          select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
          where gc.session_id = p_session_id and gc.zone = 'battlefield'
            and c.type_line ilike '%creature%'
            and not public.card_has_indestructible(p_session_id, gc.id)
        loop
          perform public.put_in_graveyard(p_session_id, v_dmg_target);
          v_token_count := v_token_count + 1;
        end loop;
        if v_token_count > 0 then
          -- gain_per_destroyed (mig 272, Fumigate: 1 life per victim) replaces
          -- the X/X token payoff when token is absent.
          if (v_effect ->> 'gain_per_destroyed') is not null then
            update public.game_session_players
            set life_total = life_total + v_token_count * (v_effect ->> 'gain_per_destroyed')::integer
            where session_id = p_session_id and player_id = p_controller_id;
            perform public.fire_lifegain_triggers(p_session_id, p_controller_id,
              v_token_count * (v_effect ->> 'gain_per_destroyed')::integer);
          else
            perform public.apply_triggered_ability_effects(
              p_session_id, p_controller_id, p_source_card_id,
              jsonb_build_array(jsonb_build_object(
                'type', 'create_token',
                'token', coalesce(v_effect ->> 'token', 'Horror Token'),
                'count', 1, 'set_pt', v_token_count)));
          end if;
        end if;
      end if;

    elsif v_eff_type = 'destroy_all_mv' then
      -- Culling Ritual (mig 272): "destroy each nonland permanent with mana
      -- value 2 or less. Add {B} or {G} for each permanent destroyed."
      -- Approximation: the ritual mana is a single fixed colour
      -- (mana_per_destroyed). Indestructible survives.
      if p_controller_id is not null then
        v_token_count := 0;
        for v_dmg_target in
          select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
          where gc.session_id = p_session_id and gc.zone = 'battlefield'
            and c.type_line not ilike '%land%'
            and public.mana_value(c.mana_cost) <= coalesce((v_effect ->> 'max_mana_value')::integer, 2)
            and not public.card_has_indestructible(p_session_id, gc.id)
        loop
          perform public.put_in_graveyard(p_session_id, v_dmg_target);
          v_token_count := v_token_count + 1;
        end loop;
        if v_token_count > 0 and upper(coalesce(v_effect ->> 'mana_per_destroyed', '')) in ('W','U','B','R','G','C') then
          perform public.apply_triggered_ability_effects(
            p_session_id, p_controller_id, p_source_card_id,
            jsonb_build_array(jsonb_build_object(
              'type', 'add_mana', 'color', upper(v_effect ->> 'mana_per_destroyed'),
              'amount', v_token_count)));
        end if;
      end if;

    elsif v_eff_type = 'exile_all' then
      -- Merciless Eviction (mig 275): "exile all <type>" — exile skips
      -- destruction triggers and ignores indestructible.
      if jsonb_typeof(v_effect -> 'types') = 'array' then
        update public.game_cards gc
        set zone = 'exile',
            attached_to = null,
            zone_position = (select coalesce(max(x.zone_position), -1) + 1
                             from public.game_cards x
                             where x.session_id = p_session_id
                               and x.owner_id = gc.owner_id and x.zone = 'exile')
        from public.cards c
        where c.id = gc.card_id and gc.session_id = p_session_id and gc.zone = 'battlefield'
          and exists (select 1 from jsonb_array_elements_text(v_effect -> 'types') t
                      where c.type_line ilike '%' || t.value || '%');
      end if;

    elsif v_eff_type = 'add_poison' then
      -- "…gets N poison counters" (mig 272, Caress of Phyrexia). Recipient
      -- 'each_opponent' (default) or 'controller'.
      if p_controller_id is not null then
        if lower(coalesce(v_effect ->> 'recipient', 'each_opponent')) = 'controller' then
          perform public.add_player_poison(p_session_id, p_controller_id,
            greatest(1, coalesce((v_effect ->> 'amount')::integer, 1)));
        else
          perform public.add_player_poison(p_session_id, sp.player_id,
            greatest(1, coalesce((v_effect ->> 'amount')::integer, 1)))
          from public.game_session_players sp
          where sp.session_id = p_session_id and sp.player_id is distinct from p_controller_id;
        end if;
        perform public.maybe_finish_game_session(p_session_id);
      end if;

    elsif v_eff_type = 'exile_graveyard' then
      -- Bojuka Bog (mig 272): "exile target player's graveyard."
      -- Approximation: the opponent's graveyard (1v1: the only choice that
      -- matters).
      update public.game_cards gc
      set zone = 'exile',
          zone_position = (select coalesce(max(x.zone_position), -1) + 1
                           from public.game_cards x
                           where x.session_id = p_session_id
                             and x.owner_id = gc.owner_id and x.zone = 'exile')
      where gc.session_id = p_session_id and gc.zone = 'graveyard'
        and gc.owner_id is distinct from p_controller_id;

    elsif v_eff_type = 'ixhel_corrupted_exile' then
      -- Ixhel (mig 272): "each opponent who has three or more poison counters
      -- exiles the top card of their library; you may play those cards."
      -- The permission reuses the impulse play_from_exile row, so the window
      -- is until the end of YOUR next turn (approximation — the real card's
      -- window is unlimited); any-colour spending is not modelled.
      if p_controller_id is not null then
        select turn_number into v_turn_number
        from public.game_turn_state where session_id = p_session_id;
        v_exiled := array[]::uuid[];
        for v_dmg_target in
          select gc.id
          from public.game_session_players sp
          join lateral (
            select id from public.game_cards
            where session_id = p_session_id and owner_id = sp.player_id and zone = 'library'
            order by zone_position asc, id asc limit 1
          ) gc on true
          where sp.session_id = p_session_id
            and sp.player_id is distinct from p_controller_id
            and coalesce((sp.counters ->> 'poison')::integer, 0) >= 3
        loop
          update public.game_cards gc
          set zone = 'exile',
              zone_position = (select coalesce(max(x.zone_position), -1) + 1
                               from public.game_cards x
                               where x.session_id = p_session_id
                                 and x.owner_id = gc.owner_id and x.zone = 'exile')
          where gc.id = v_dmg_target;
          v_exiled := v_exiled || v_dmg_target;
        end loop;
        if array_length(v_exiled, 1) > 0 then
          insert into public.game_continuous_effects (
            session_id, source_card_id, affected_player_id, effect_type, payload
          ) values (
            p_session_id, p_source_card_id, p_controller_id, 'play_from_exile',
            jsonb_build_object('card_ids', to_jsonb(v_exiled),
                               'created_turn', coalesce(v_turn_number, 0))
          );
        end if;
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
            -- Optional type filter (mig 299, Ardbert: "each LEGENDARY creature").
            and (nullif(v_effect ->> 'type_line', '') is null
                 or c.type_line ilike '%' || (v_effect ->> 'type_line') || '%')
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
            and (nullif(v_effect ->> 'type_line', '') is null
                 or c.type_line ilike '%' || (v_effect ->> 'type_line') || '%')
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
        'indestructible', 'first_strike', 'double_strike', 'menace', 'lifelink',
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

    elsif v_eff_type = 'tap_self' then
      -- Tap the source permanent (Immersturm Predator: "Tap it" after its
      -- sacrifice ability). The AFTER-UPDATE is_tapped trigger (fire_tap_triggers)
      -- fires the becomes_tapped event from here just like a mana/attack tap.
      if p_source_card_id is not null then
        update public.game_cards
        set is_tapped = true
        where id = p_source_card_id and session_id = p_session_id and zone = 'battlefield';
      end if;

    elsif v_eff_type = 'donate_self' then
      -- Xantcha (mig 361): "enters under the control of an opponent of your choice"
      -- — hand the source to an opponent of its current controller (1v1: the only
      -- one). APPROX: "of your choice" is the first opponent in seat order.
      if p_source_card_id is not null then
        update public.game_cards
        set controller_player_id = (
          select sp.player_id from public.game_session_players sp
          where sp.session_id = p_session_id and sp.player_id is distinct from p_controller_id
          order by sp.seat_number limit 1)
        where id = p_source_card_id and session_id = p_session_id and zone = 'battlefield'
          and exists (select 1 from public.game_session_players sp
                      where sp.session_id = p_session_id and sp.player_id is distinct from p_controller_id);
        perform public.rebuild_scripted_continuous_effects(p_session_id);
      end if;

    elsif v_eff_type = 'copy_self' then
      -- Create `count` token copies of the SOURCE under the controller, with the
      -- given `except` overrides (Saw in Half, mig 356: two half-size copies of
      -- the creature as it dies). Works from the graveyard (copy reads card_id).
      if p_source_card_id is not null and p_controller_id is not null then
        perform public.create_copy_token(p_session_id, p_controller_id, p_source_card_id, v_effect -> 'except')
        from generate_series(1, greatest(1, coalesce((v_effect ->> 'count')::integer, 1)));
      end if;

    elsif v_eff_type = 'return_self_to_battlefield' then
      -- Return the SOURCE card from the graveyard to the battlefield under its
      -- owner's control (Feign Death / Supernatural Stamina / Not Dead After All,
      -- mig 345, via a granted dies-trigger). Optionally tapped / with a +1/+1
      -- counter. Only acts on a card currently in a graveyard.
      if p_source_card_id is not null then
        update public.game_cards gc
        set zone = 'battlefield',
            zone_position = (select coalesce(max(x.zone_position), -1) + 1 from public.game_cards x
                             where x.session_id = p_session_id and x.owner_id = gc.owner_id and x.zone = 'battlefield'),
            controller_player_id = gc.owner_id,
            is_tapped = coalesce((v_effect ->> 'tapped')::boolean, false),
            damage_marked = 0,
            plus_one_counters = coalesce((v_effect ->> 'plus_one_counters')::integer, 0),
            entered_battlefield_turn_number = (select turn_number from public.game_turn_state where session_id = p_session_id)
        where gc.id = p_source_card_id and gc.session_id = p_session_id and gc.zone = 'graveyard';
        perform public.rebuild_scripted_continuous_effects(p_session_id);
        perform public.recheck_counter_state(p_session_id);
      end if;

    elsif v_eff_type = 'set_pt' then
      -- Untargeted set base P/T → the source (Nogi: "becomes 5/5 until EOT").
      if p_source_card_id is not null then
        perform public.apply_creature_effect(p_session_id, 'set_pt', p_source_card_id, v_effect);
      end if;

    elsif v_eff_type = 'sacrifice_source' then
      -- 'Sacrifice this enchantment' as a trigger rider (mig 281, Promise of
      -- Bunrei: one payout, then the source goes to the graveyard).
      if p_source_card_id is not null then
        perform public.put_in_graveyard(p_session_id, p_source_card_id);
      end if;

    elsif v_eff_type = 'shuffle_self_into_library' then
      -- Omen back-faces (mig 289, Flush Out / Dynamic Soar): 'then shuffle
      -- this card into its owner's library.' The source moves from wherever
      -- it is (hand, for omen casts) into the library, then the owner's
      -- whole library is re-randomized.
      if p_source_card_id is not null then
        update public.game_cards
        set zone = 'library', is_tapped = false, damage_marked = 0, plus_one_counters = 0
        where id = p_source_card_id and session_id = p_session_id;
        update public.game_cards g set zone_position = s.rn
        from (select gc.id, (row_number() over (order by random(), gc.id) - 1) as rn
              from public.game_cards gc
              where gc.session_id = p_session_id and gc.zone = 'library'
                and gc.owner_id = (select owner_id from public.game_cards where id = p_source_card_id)) s
        where g.id = s.id;
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

    elsif v_eff_type = 'advance_saga' then
      -- Saga (mig 305): add a lore counter, fire the chapter whose number now
      -- matches, and sacrifice once the final (highest) chapter is reached.
      -- Driven by enters_the_battlefield (lore 1) + draw_step (lore +1) triggers.
      if p_source_card_id is not null then
        update public.game_cards
        set counters = coalesce(counters, '{}'::jsonb)
              || jsonb_build_object('lore', coalesce((counters ->> 'lore')::integer, 0) + 1)
        where id = p_source_card_id and session_id = p_session_id
        returning (counters ->> 'lore')::integer into v_lore;

        v_saga := public.effective_script(p_session_id, p_source_card_id) -> 'saga_chapters';
        if jsonb_typeof(v_saga) = 'array' then
          -- Apply every chapter entry whose `chapter` list contains the new lore.
          for v_chapter in select * from jsonb_array_elements(v_saga)
          loop
            if exists (select 1 from jsonb_array_elements_text(v_chapter -> 'chapter') ch
                       where ch.value::integer = v_lore) then
              perform public.apply_triggered_ability_effects(
                p_session_id, p_controller_id, p_source_card_id,
                coalesce(v_chapter -> 'effects', '[]'::jsonb));
            end if;
          end loop;

          -- Final chapter = the highest number across all entries → sacrifice.
          select max(n) into v_saga_max
          from jsonb_array_elements(v_saga) e,
               jsonb_array_elements_text(e -> 'chapter') ch,
               lateral (select ch.value::integer as n) t;
          if v_lore >= coalesce(v_saga_max, 0) then
            perform public.put_in_graveyard(p_session_id, p_source_card_id);
          end if;
        end if;
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
  v_parked_effects jsonb;
  v_controller uuid;
  v_count integer;
  v_i integer;
  v_copy_n integer;
  v_pe record;
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

    -- amount {power_of:'triggering_creature'} (mig 392, Terror of the Peaks:
    -- "deals damage equal to THAT creature's power"). Same substitution as the
    -- toughness_of block — resolve_dynamic_amount's power_of only knows
    -- source|target, so the concrete number is baked here.
    if jsonb_typeof(v_effect -> 'amount') = 'object'
       and (v_effect -> 'amount' ->> 'power_of') = 'triggering_creature'
       and nullif(v_item.payload ->> 'triggering_card_id', '') is not null then
      v_effect := v_effect || jsonb_build_object('amount',
        greatest(0, coalesce(public.card_effective_power(p_session_id,
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
        -- max picks: choose_up_to (mig 306, Sublime Epiphany's "choose one or
        -- more" → up to every mode); or the commander "choose both" raise (Will
        -- of the Temur, mig 239); otherwise exactly `choose`.
        case when v_effect ? 'choose_up_to'
             then least((v_effect ->> 'choose_up_to')::integer, jsonb_array_length(v_options))
             when coalesce((v_effect ->> 'may_choose_both_if_commander')::boolean, false)
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
        and (v_name is null or c.name ilike '%' || v_name || '%')
        -- max_mana_value (mig 400, Trinket Mage: "an artifact card with mana
        -- value 1 or less"). Options ARE the submit whitelist, so filtering
        -- here enforces the cap end-to-end.
        and (nullif(v_effect -> 'filter' ->> 'max_mana_value', '') is null
             or public.mana_value(c.mana_cost) <= (v_effect -> 'filter' ->> 'max_mana_value')::integer);

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

    elsif v_type = 'hand_to_library_top' then
      -- Brainstorm (mig 392): "put two cards from your hand on top of your
      -- library in any order." Parked as a mandatory pick of `count` hand
      -- cards; submit_decision places them (the LAST chosen card ends on top).
      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', g.id, 'name', c.name) order by g.zone_position, g.id), '[]'::jsonb)
        into v_options
      from public.game_cards g join public.cards c on c.id = g.card_id
      where g.session_id = p_session_id and g.owner_id = v_controller and g.zone = 'hand';

      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices)
      values (p_session_id, v_controller, p_stack_item_id, 'hand_to_library_top',
        'Put ' || least(coalesce((v_effect ->> 'count')::integer, 1), jsonb_array_length(v_options))
          || ' card(s) from your hand on top of your library (the last pick ends on top)',
        v_options,
        least(coalesce((v_effect ->> 'count')::integer, 1), jsonb_array_length(v_options)),
        least(coalesce((v_effect ->> 'count')::integer, 1), jsonb_array_length(v_options)))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'grant_flashback' then
      -- Snapcaster Mage (mig 392): "target instant or sorcery card in your
      -- graveyard gains flashback until end of turn; its flashback cost is its
      -- mana cost." Parked as a pick decision over the eligible graveyard
      -- cards; submit_decision stamps the grant (a turn-stamped counter) on the
      -- chosen card, which cast_spell_effect's graveyard branch honors.
      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', g.id, 'name', c.name) order by c.name, g.id), '[]'::jsonb)
        into v_options
      from public.game_cards g join public.cards c on c.id = g.card_id
      where g.session_id = p_session_id and g.owner_id = v_controller and g.zone = 'graveyard'
        and (c.type_line ilike '%instant%' or c.type_line ilike '%sorcery%')
        and coalesce(btrim(c.mana_cost), '') <> '';

      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices)
      values (p_session_id, v_controller, p_stack_item_id, 'grant_flashback',
        'Choose an instant or sorcery card in your graveyard — it gains flashback (its mana cost) until end of turn',
        v_options, 0, 1)
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'discard' then
      v_who := lower(coalesce(v_effect ->> 'who', 'you'));
      if v_who in ('each_opponent', 'each_player') then
        -- "Each (other) player discards N cards" (mig 298, Syphon Mind). Random
        -- + immediate to avoid parking a decision per player; the chooser
        -- nuance is approximated. A following draw can scale via num_opponents.
        v_amount := greatest(1, coalesce((v_effect ->> 'count')::integer, 1));
        for v_decider in
          select sp.player_id from public.game_session_players sp
          where sp.session_id = p_session_id
            and (v_who = 'each_player' or sp.player_id is distinct from v_controller)
        loop
          -- Per-card discard through discard_card (mig 434) so madness fires.
          for v_tid in
            select id from public.game_cards
            where session_id = p_session_id and owner_id = v_decider and zone = 'hand'
            order by random() limit v_amount
          loop
            perform public.discard_card(p_session_id, v_tid);
          end loop;
        end loop;
        v_i := v_i + 1;
        continue;
      end if;
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
        -- Per-card discard through discard_card (mig 434) so madness fires.
        for v_tid in
          select id from public.game_cards
          where session_id = p_session_id and owner_id = v_decider and zone = 'hand'
          order by random() limit v_amount
        loop
          perform public.discard_card(p_session_id, v_tid);
        end loop;

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
        jsonb_build_object('effects', coalesce(v_effect -> 'effects', '[]'::jsonb), 'cost', v_effect ->> 'cost',
          'program', coalesce((v_effect ->> 'program')::boolean, false),
          -- Preserve the event subject so a program copy_permanent target:'triggering_creature'
          -- still has it after the may (Flameshadow Conjuring, mig 352).
          'triggering_card_id', v_item.payload ->> 'triggering_card_id'))
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

      -- Pre-resolve event_amount in the parked effects (mig 435, Sanguine Bond
      -- / Vito: "target opponent loses THAT MUCH life") — the submit-time apply
      -- runs without the trigger's event payload, so the number must be baked
      -- in now.
      select coalesce(jsonb_agg(
        case when (e.value ->> 'amount') = 'event_amount'
             then e.value || jsonb_build_object('amount',
                    coalesce(nullif(v_item.payload ->> 'event_amount', '')::integer, 0))
             else e.value end
        order by e.ord), '[]'::jsonb)
      into v_parked_effects
      from jsonb_array_elements(coalesce(v_effect -> 'effects', '[]'::jsonb))
        with ordinality as e(value, ord);

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'choose_player', 'Choose a player', v_options, 1, 1,
        jsonb_build_object('effects', v_parked_effects))
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
      -- who:'each_player' (mig 343, Patriarch's Bidding): every player chooses a
      -- type and returns their own graveyard's creatures of it. Queue the players
      -- in seat order; the first decides now, the rest ride params.player_queue
      -- and are raised one-by-one as each decision is submitted.
      v_who := lower(coalesce(v_effect ->> 'who', 'you'));
      if v_who = 'each_player' then
        select coalesce(jsonb_agg(to_jsonb(sp.player_id::text) order by sp.seat_number), '[]'::jsonb)
          into v_queue
        from public.game_session_players sp
        where sp.session_id = p_session_id;
        if jsonb_array_length(v_queue) = 0 then v_i := v_i + 1; continue; end if;
        v_decider := (v_queue ->> 0)::uuid;
        v_queue := v_queue - 0;
      else
        v_decider := v_controller;
        v_queue := '[]'::jsonb;
      end if;
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_decider, p_stack_item_id, 'choose_creature_type',
        coalesce(v_effect ->> 'prompt', 'Choose a creature type'), v_options, 1, 1,
        jsonb_build_object('effects', coalesce(v_effect -> 'effects', '[]'::jsonb),
          'player_queue', v_queue, 'options', v_options))
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
        p_session_id, p_stack_item_id, coalesce((v_effect ->> 'count')::integer, 1), v_filter, v_queue,
        v_effect -> 'filter' -> 'type_line_any'  -- OR-types (mig 417): "artifact or creature"
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
        least(coalesce((v_effect ->> 'min_picks')::integer, 0), jsonb_array_length(v_options)),
        -- picks (mig 302, Dig Through Time): "put TWO into your hand" — defaults
        -- to 1, capped at the number of matching options.
        least(coalesce((v_effect ->> 'picks')::integer, 1), jsonb_array_length(v_options)),
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
      where gy.session_id = p_session_id and gy.zone = 'graveyard'
        -- from:'all_graveyards' (mig 270, Beacon of Unrest / Grave Upheaval):
        -- the pick spans EVERY graveyard, not just yours.
        and (lower(coalesce(v_effect ->> 'from', '')) = 'all_graveyards'
             or gy.owner_id = v_controller)
        -- types array (mig 265, Hanna: "artifact or enchantment card").
        and (case
               when jsonb_typeof(v_effect -> 'filter' -> 'types') = 'array' then
                 exists (select 1 from jsonb_array_elements_text(v_effect -> 'filter' -> 'types') t
                         where c.type_line ilike '%' || t.value || '%')
               when v_filter is not null then c.type_line ilike '%' || v_filter || '%'
               else c.type_line ilike '%creature%'
             end)
        -- "another target …" (mig 265, Myr Retriever dies-trigger: its own
        -- corpse is never offered).
        and (not coalesce((v_effect -> 'filter' ->> 'exclude_self')::boolean, false)
             or gy.id is distinct from v_item.source_card_id)
        -- max_mana_value (mig 276, Sun Titan: "permanent card with mana
        -- value 3 or less"); max_mana_value_of:'source_power' (mig 341, Carmen:
        -- "mana value <= Carmen's power") reads the source's effective power now.
        and (case
               when nullif(v_effect -> 'filter' ->> 'max_mana_value', '') is not null
                 then public.mana_value(c.mana_cost) <= (v_effect -> 'filter' ->> 'max_mana_value')::integer
               when (v_effect -> 'filter' ->> 'max_mana_value_of') = 'source_power'
                 then public.mana_value(c.mana_cost) <= coalesce(public.card_effective_power(p_session_id, v_item.source_card_id), 0)
               else true
             end)
        -- "permanent card" (mig 341, Carmen): exclude instants/sorceries.
        and (not coalesce((v_effect -> 'filter' ->> 'permanent')::boolean, false)
             or (c.type_line not ilike '%instant%' and c.type_line not ilike '%sorcery%'));

      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'return_from_graveyard',
        'Return up to ' || coalesce((v_effect ->> 'count'), '1') || ' from your graveyard',
        v_options, 0, coalesce((v_effect ->> 'count')::integer, 1),
        -- tapped (mig 218, Victimize): battlefield returns enter tapped.
        jsonb_build_object('to', coalesce(v_effect ->> 'to', 'hand'),
                           'tapped', coalesce((v_effect ->> 'tapped')::boolean, false),
                           -- control:'decider' + haste (mig 270, Beacon of
                           -- Unrest / Grave Upheaval reanimation riders).
                           'control', coalesce(v_effect ->> 'control', ''),
                           'haste', coalesce((v_effect ->> 'haste')::boolean, false),
                           -- lose_life_mana_value (mig 346, Reanimate).
                           'lose_life_mana_value', coalesce((v_effect -> 'filter' ->> 'lose_life_mana_value')::boolean,
                                                            (v_effect ->> 'lose_life_mana_value')::boolean, false)))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'exile_graveyard_until_leaves' then
      -- Trove Warden (mig 405): "exile target permanent card with mana value 3
      -- or less from YOUR graveyard until this leaves." Parks a pick over the
      -- controller's graveyard (permanent cards, max_mana_value filter); submit
      -- exiles the chosen card AND anchors it via exiled_until_leaves (source =
      -- this permanent), so fire_zone_change_triggers returns it to the
      -- battlefield when the source dies.
      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gy.id, 'name', c.name) order by c.name, gy.id), '[]'::jsonb)
        into v_options
      from public.game_cards gy join public.cards c on c.id = gy.card_id
      where gy.session_id = p_session_id and gy.zone = 'graveyard' and gy.owner_id = v_controller
        and (nullif(v_effect -> 'filter' ->> 'type_line', '') is null
             or c.type_line ilike '%' || (v_effect -> 'filter' ->> 'type_line') || '%')
        -- "permanent card" (default true here): exclude instants/sorceries.
        and (not coalesce((v_effect -> 'filter' ->> 'permanent')::boolean, true)
             or (c.type_line not ilike '%instant%' and c.type_line not ilike '%sorcery%'))
        and (nullif(v_effect -> 'filter' ->> 'max_mana_value', '') is null
             or public.mana_value(c.mana_cost) <= (v_effect -> 'filter' ->> 'max_mana_value')::integer);

      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'graveyard_exile_until_leaves_pick',
        'Exile a permanent card from your graveyard until this leaves',
        v_options, 1, 1, '{}'::jsonb)
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

    elsif v_type = 'choose_land_type' then
      -- Multiversal Passage (mig 407): "As this enters, choose a basic land
      -- type. This land is the chosen type." Parks a five-type pick; submit
      -- registers a granted_type (so effective_type_line includes it) and bakes
      -- the matching {T}: add <color> mana ability into the land's copied_script.
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'choose_land_type',
        'Choose a basic land type',
        '[{"value":"Plains"},{"value":"Island"},{"value":"Swamp"},{"value":"Mountain"},{"value":"Forest"}]'::jsonb,
        1, 1, '{}'::jsonb)
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
          -- count: a fixed number, or 'coin_flip' (Mirror March, mig 354: flip a
          -- coin until you lose, one copy per win → a geometric count).
          if (v_effect ->> 'count') = 'coin_flip' then
            v_copy_n := 0;
            while random() < 0.5 loop v_copy_n := v_copy_n + 1; end loop;
          else
            v_copy_n := greatest(1, coalesce((v_effect ->> 'count')::integer, 1));
          end if;
          perform public.create_copy_token(
            p_session_id, v_controller,
            nullif(v_item.payload ->> 'triggering_card_id', '')::uuid,
            -- '$defender' in except.attacking_defender = the player this attack is
            -- against (Echoing Assault, mig 359): bake in the event's defender.
            case when (v_effect -> 'except' ->> 'attacking_defender') = '$defender'
                 then jsonb_set(v_effect -> 'except', '{attacking_defender}',
                                to_jsonb(coalesce(v_item.payload ->> 'event_player_id', '')))
                 else v_effect -> 'except' end)
          from generate_series(1, v_copy_n);
        end if;
      elsif (v_effect ->> 'target') = 'attached' then
        -- Copy of the equipped/enchanted creature (Helm of the Host, mig 350):
        -- the source's attached_to host. No pick.
        perform public.create_copy_token(
          p_session_id, v_controller,
          (select attached_to from public.game_cards where id = v_item.source_card_id and session_id = p_session_id),
          v_effect -> 'except');
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
          jsonb_build_object('except', v_effect -> 'except', 'count', v_effect -> 'count'))
        returning id into v_decision_id;
        update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
        return v_decision_id;
      end if;

    elsif v_type = 'myriad' then
      -- Myriad (mig 355): "whenever this attacks, for each opponent other than the
      -- defending player, create a tapped token copy attacking that opponent;
      -- exile them at end of combat." The defender rides the attacks event payload.
      -- "you may" is approximated as always creating the copies.
      for v_pe in
        select sp.player_id from public.game_session_players sp
        where sp.session_id = p_session_id
          and sp.player_id is distinct from v_controller
          and sp.player_id is distinct from nullif(v_item.payload ->> 'event_player_id', '')::uuid
      loop
        perform public.create_copy_token(
          p_session_id, v_controller, v_item.source_card_id,
          jsonb_build_object('tapped', true, 'attacking_defender', (v_pe.player_id)::text,
                             'cleanup_at_end_combat', true));
      end loop;

    elsif v_type = 'delina_d20' then
      -- Delina, Wild Mage (mig 360): roll a d20, create a tapped attacking copy of
      -- the target (exiled at end of combat); on 15-20 you may roll again — modelled
      -- as always rolling again. Both ranges make one copy, so at least one. "Not
      -- legendary" is not modelled. Safety-capped to avoid a runaway loop.
      if v_target is not null then
        for v_copy_n in 1..25 loop
          perform public.create_copy_token(
            p_session_id, v_controller, v_target,
            jsonb_build_object('tapped', true, 'attacking_defender', v_item.payload ->> 'event_player_id',
                               'cleanup_at_end_combat', true));
          exit when (1 + floor(random() * 20)::integer) < 15;
        end loop;
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
      -- Shared exile-until-lesser-MV loop (mig 422): exiles the found nonland,
      -- bottoms the looked-at pile, returns the found id (or null).
      v_tid := public.exile_until_cheaper(p_session_id, v_controller, coalesce(v_amount, 0));
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

    elsif v_type = 'cascade' then
      -- Cascade (mig 422): exile from the top until a nonland with mana value
      -- STRICTLY LESS THAN the cast spell's mana value (integer MV, so <= castMV-1),
      -- bottom the rest, then park a "may cast it for free" decision. On cast →
      -- cast_card_free (true nested cast); on decline → the found card bottoms too.
      v_tid := public.exile_until_cheaper(p_session_id, v_controller,
        coalesce((v_effect ->> 'cast_mana_value')::integer, 0) - 1);
      if v_tid is null then v_i := v_i + 1; continue; end if;
      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gc.id, 'name', c.name)), '[]'::jsonb)
        into v_options
      from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.id = v_tid;
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'cascade_cast',
        'Cascade: cast it without paying its mana cost?',
        v_options, 0, 1, jsonb_build_object('found_card_id', v_tid))
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
      -- to:'hand' (mig 392, Watcher for Tomorrow): the hidden card goes to its
      -- OWNER's hand instead — any card type, including instants/sorceries.
      v_tid := nullif((select gc.counters ->> 'hideaway_card'
                       from public.game_cards gc where gc.id = v_item.source_card_id), '')::uuid;
      if v_tid is not null and (v_effect ->> 'to') = 'hand' then
        update public.game_cards gc
        set zone = 'hand', is_tapped = false, damage_marked = 0,
            zone_position = (select coalesce(max(zone_position), -1) + 1
                             from public.game_cards x
                             where x.session_id = p_session_id and x.owner_id = gc.owner_id
                               and x.zone = 'hand')
        where gc.id = v_tid and gc.session_id = p_session_id and gc.zone = 'exile';
        update public.game_cards
        set counters = counters - 'hideaway_card'
        where id = v_item.source_card_id and session_id = p_session_id;
      elsif v_tid is not null and exists (
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
        -- type_line (mig 282, Murasa Rootgrazer: "a BASIC LAND card from your
        -- hand"). Caught by the new card-scripts validation test.
        and (nullif(v_effect -> 'filter' ->> 'type_line', '') is null
             or c.type_line ilike '%' || (v_effect -> 'filter' ->> 'type_line') || '%')
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
             end)
        -- "destroy target NONLAND permanent" (Ruthless Lawbringer, mig 339).
        and (not coalesce((v_effect -> 'target_filter' ->> 'nonland')::boolean, false)
             or c.type_line not ilike '%land%');
      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'destroy_pick',
        'Destroy up to ' || coalesce(v_effect ->> 'count', '1'),
        v_options, 0, greatest(1, coalesce((v_effect ->> 'count')::integer, 1)), '{}'::jsonb)
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'living_weapon' then
      -- Living weapon (mig 267, Bonehoard): create a 0/0 black Phyrexian Germ
      -- token and attach the Equipment to it. The Equipment is the program's
      -- TARGET when one exists (Grip of Phyresis: the freshly stolen
      -- Equipment), otherwise the source itself (Bonehoard's own ETB).
      select id into v_top_id from public.cards
      where lower(name) = 'germ token' and is_token = true limit 1;
      if v_top_id is not null and v_controller is not null then
        select coalesce(max(zone_position), -1) + 1 into v_pos
        from public.game_cards
        where session_id = p_session_id and owner_id = v_controller and zone = 'battlefield';
        select turn_number into v_turn from public.game_turn_state where session_id = p_session_id;
        insert into public.game_cards (
          session_id, card_id, owner_id, controller_player_id, zone, zone_position,
          is_tapped, damage_marked, position_x, position_y, entered_battlefield_turn_number
        ) values (
          p_session_id, v_top_id, v_controller, v_controller, 'battlefield', v_pos,
          false, 0, 0, 0, coalesce(v_turn, 0)
        ) returning id into v_top_id;
        update public.game_cards
        set attached_to = v_top_id
        where id = coalesce(v_target, v_item.source_card_id) and session_id = p_session_id;
        perform public.rebuild_scripted_continuous_effects(p_session_id);
        perform public.recheck_counter_state(p_session_id);
      end if;

    elsif v_type = 'job_select' then
      -- Job select (mig 297): create a 1/1 colourless Hero creature token and
      -- attach this Equipment to it. Mirrors living_weapon (mig 267) with a Hero
      -- token instead of a 0/0 Germ; the source IS the entering Equipment.
      select id into v_top_id from public.cards
      where lower(name) = 'hero token' and is_token = true limit 1;
      if v_top_id is not null and v_controller is not null then
        select coalesce(max(zone_position), -1) + 1 into v_pos
        from public.game_cards
        where session_id = p_session_id and owner_id = v_controller and zone = 'battlefield';
        select turn_number into v_turn from public.game_turn_state where session_id = p_session_id;
        insert into public.game_cards (
          session_id, card_id, owner_id, controller_player_id, zone, zone_position,
          is_tapped, damage_marked, position_x, position_y, entered_battlefield_turn_number
        ) values (
          p_session_id, v_top_id, v_controller, v_controller, 'battlefield', v_pos,
          false, 0, 0, 0, coalesce(v_turn, 0)
        ) returning id into v_top_id;
        update public.game_cards
        set attached_to = v_top_id
        where id = v_item.source_card_id and session_id = p_session_id;
        perform public.rebuild_scripted_continuous_effects(p_session_id);
        perform public.recheck_counter_state(p_session_id);
      end if;

    elsif v_type = 'attach_all_equipment' then
      -- Armory Automaton (mig 267): "attach any number of target Equipment to
      -- it." Approximation: every Equipment YOU control attaches to the source
      -- (opponents' Equipment and partial picks are not modelled).
      update public.game_cards gc
      set attached_to = v_item.source_card_id
      from public.cards c
      where c.id = gc.card_id and gc.session_id = p_session_id and gc.zone = 'battlefield'
        and coalesce(gc.controller_player_id, gc.owner_id) = v_controller
        and c.type_line ilike '%equipment%'
        and gc.id <> v_item.source_card_id;
      perform public.rebuild_scripted_continuous_effects(p_session_id);

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
        -- type_line (mig 263, karoo lands: "return a LAND you control").
        and (coalesce(v_effect -> 'target_filter' ->> 'type_line', '') = ''
             or c.type_line ilike '%' || (v_effect -> 'target_filter' ->> 'type_line') || '%')
        and (v_amount is null or public.mana_value(c.mana_cost) <= v_amount);
      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;
      -- mandatory (mig 411, karoo lands: "return a land you control" — NOT
      -- optional): force exactly `count` picks (clamped to legal option count),
      -- and word the prompt without "up to". Default stays declinable (min 0).
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'bounce_pick',
        case when coalesce((v_effect ->> 'mandatory')::boolean, false)
             then 'Return ' || coalesce(v_effect ->> 'count', '1') || ' to its owner''s hand'
             else 'Return up to ' || coalesce(v_effect ->> 'count', '1') || ' to its owner''s hand' end,
        v_options,
        case when coalesce((v_effect ->> 'mandatory')::boolean, false)
             then least(greatest(1, coalesce((v_effect ->> 'count')::integer, 1)), jsonb_array_length(v_options))
             else 0 end,
        greatest(1, coalesce((v_effect ->> 'count')::integer, 1)), '{}'::jsonb)
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

    elsif v_type = 'graveyard_to_library_top' then
      -- Noxious Revival (mig 275): "put target card from a graveyard on top
      -- of its owner's library." Parks a pick over every graveyard.
      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gy.id, 'name', c.name) order by c.name, gy.id), '[]'::jsonb)
        into v_options
      from public.game_cards gy join public.cards c on c.id = gy.card_id
      where gy.session_id = p_session_id and gy.zone = 'graveyard';
      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'graveyard_to_top_pick',
        'Put a card from a graveyard on top of its owner''s library',
        v_options, 0, 1, '{}'::jsonb)
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

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
      elsif public.trigger_effect_target_type(v_effect) is not null and v_target is null then
        -- A targeted effect with no chosen target: an OPTIONAL "up to one target"
        -- that was declined, or a required target that fizzled (no legal target).
        -- Either way the effect simply does nothing — never apply it with a null
        -- target (which would error / mis-target).
        null;
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

create or replace function public.resolve_count_amount(
  p_session_id uuid,
  p_controller_id uuid,
  p_spec jsonb,
  -- The effect's source permanent (mig 257): lets a count exclude it
  -- ("draw a card for each OTHER Dinosaur you control").
  p_source_card_id uuid default null
) returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_count text := lower(coalesce(p_spec ->> 'count', ''));
  v_type text := p_spec ->> 'type_line';
  v_color text := upper(coalesce(p_spec ->> 'color', ''));
  v_n integer := 0;
begin
  if v_count = 'creatures_you_control' then
    -- min_power (mig 243, Become the Avalanche): only creatures with
    -- effective power >= N count.
    select count(*)::integer into v_n
    from public.game_cards g
    join public.cards c on c.id = g.card_id
    where g.session_id = p_session_id
      and coalesce(g.controller_player_id, g.owner_id) = p_controller_id
      and g.zone = 'battlefield'
      and c.type_line ilike '%creature%'
      and (v_type is null or c.type_line ilike '%' || v_type || '%')
      -- "each OTHER <type> you control" (mig 257, Earthshaker Dreadmaw).
      and (not coalesce((p_spec ->> 'exclude_self')::boolean, false)
           or g.id is distinct from p_source_card_id)
      and ((p_spec ->> 'min_power') is null
           or coalesce(public.card_effective_power(p_session_id, g.id), -1)
              >= (p_spec ->> 'min_power')::integer);

  elsif v_count = 'lands_you_control' then
    select count(*)::integer into v_n
    from public.game_cards g
    join public.cards c on c.id = g.card_id
    where g.session_id = p_session_id
      and coalesce(g.controller_player_id, g.owner_id) = p_controller_id
      and g.zone = 'battlefield'
      and c.type_line ilike '%land%';

  elsif v_count = 'basic_lands_you_control' then
    -- "unless you control two or more basic lands" (mig 217, Sunken Hollow).
    select count(*)::integer into v_n
    from public.game_cards g
    join public.cards c on c.id = g.card_id
    where g.session_id = p_session_id
      and coalesce(g.controller_player_id, g.owner_id) = p_controller_id
      and g.zone = 'battlefield'
      and c.type_line ilike '%basic%'
      and c.type_line ilike '%land%';

  elsif v_count = 'greatest_power_you_control' then
    -- "the greatest power among (non-<type>) creatures you control"
    -- (mig 257, Rishkar's Expertise / Return of the Wildspeaker).
    select coalesce(max(greatest(0, coalesce(public.card_effective_power(p_session_id, g.id), 0))), 0)::integer
    into v_n
    from public.game_cards g
    join public.cards c on c.id = g.card_id
    where g.session_id = p_session_id
      and coalesce(g.controller_player_id, g.owner_id) = p_controller_id
      and g.zone = 'battlefield'
      and c.type_line ilike '%creature%'
      and (v_type is null or
           case when coalesce((p_spec ->> 'exclude_type')::boolean, false)
                then c.type_line not ilike '%' || v_type || '%'
                else c.type_line ilike '%' || v_type || '%' end);

  elsif v_count = 'permanents_you_control' then
    -- Ascend / the city's blessing, approximated as a live count (mig 255,
    -- Arch of Orazca: "if you have the city's blessing" = 10+ permanents).
    select count(*)::integer into v_n
    from public.game_cards g
    where g.session_id = p_session_id
      and coalesce(g.controller_player_id, g.owner_id) = p_controller_id
      and g.zone = 'battlefield';

  elsif v_count = 'total_power_you_control' then
    -- "if creatures you control have total power 10 or greater" (hideaway,
    -- mig 248 — Mosswort Bridge's activation gate).
    select coalesce(sum(greatest(0, coalesce(public.card_effective_power(p_session_id, g.id), 0))), 0)::integer
    into v_n
    from public.game_cards g
    join public.cards c on c.id = g.card_id
    where g.session_id = p_session_id
      and coalesce(g.controller_player_id, g.owner_id) = p_controller_id
      and g.zone = 'battlefield'
      and c.type_line ilike '%creature%';

  elsif v_count = 'cards_in_hand' then
    -- "where X is the number of cards in your hand" (Become the Avalanche).
    select count(*)::integer into v_n
    from public.game_cards g
    where g.session_id = p_session_id
      and g.owner_id = p_controller_id
      and g.zone = 'hand';

  elsif v_count = 'opponent_lands' then
    -- Treacherous Terrain (mig 278): lands the opponent controls (1v1 reading
    -- of 'each opponent ... that player').
    select count(*)::integer into v_n
    from public.game_cards g
    join public.cards c on c.id = g.card_id
    where g.session_id = p_session_id and g.zone = 'battlefield'
      and coalesce(g.controller_player_id, g.owner_id) is distinct from p_controller_id
      and c.type_line ilike '%land%';

  elsif v_count = 'lands_and_graveyard_lands' then
    -- Multani (mig 277): lands you control PLUS land cards in your graveyard.
    select (select count(*) from public.game_cards g join public.cards c on c.id = g.card_id
            where g.session_id = p_session_id and g.zone = 'battlefield'
              and coalesce(g.controller_player_id, g.owner_id) = p_controller_id
              and c.type_line ilike '%land%')
         + (select count(*) from public.game_cards g join public.cards c on c.id = g.card_id
            where g.session_id = p_session_id and g.zone = 'graveyard'
              and g.owner_id = p_controller_id and c.type_line ilike '%land%')
    into v_n;

  elsif v_count = 'countered_creatures_you_control' then
    -- Inspiring Call (mig 276): creatures you control with a +1/+1 counter.
    select count(*)::integer into v_n
    from public.game_cards g
    join public.cards c on c.id = g.card_id
    where g.session_id = p_session_id
      and coalesce(g.controller_player_id, g.owner_id) = p_controller_id
      and g.zone = 'battlefield'
      and c.type_line ilike '%creature%'
      and coalesce(g.plus_one_counters, 0) > 0;

  elsif v_count = 'opponent_hand_excess' then
    -- Sandstone Oracle (mig 276): the opponent's hand size minus yours
    -- (floored at zero; 1v1 reading of 'choose an opponent').
    select greatest(0,
      coalesce((select count(*) from public.game_cards
                where session_id = p_session_id and zone = 'hand'
                  and owner_id = (select sp.player_id from public.game_session_players sp
                                  where sp.session_id = p_session_id
                                    and sp.player_id is distinct from p_controller_id
                                  order by sp.seat_number limit 1)), 0)
      - coalesce((select count(*) from public.game_cards
                  where session_id = p_session_id and zone = 'hand'
                    and owner_id = p_controller_id), 0))::integer
    into v_n;

  elsif v_count = 'opponent_poison_counters' then
    -- Corrupted gates (mig 272, Ixhel deck): the HIGHEST poison total among
    -- opponents (corrupted = at_least 3).
    select coalesce(max(coalesce((sp.counters ->> 'poison')::integer, 0)), 0) into v_n
    from public.game_session_players sp
    where sp.session_id = p_session_id
      and sp.player_id is distinct from p_controller_id;

  elsif v_count = 'opponent_artifacts_and_enchantments' then
    -- Dockside Extortionist (mig 390): "artifacts and enchantments your
    -- opponents control".
    select count(*)::integer into v_n
    from public.game_cards g
    join public.cards c on c.id = g.card_id
    where g.session_id = p_session_id
      and coalesce(g.controller_player_id, g.owner_id) is distinct from p_controller_id
      and g.zone = 'battlefield'
      and (c.type_line ilike '%artifact%' or c.type_line ilike '%enchantment%');

  elsif v_count = 'creatures_on_battlefield' then
    -- Chain Reaction (mig 390): every creature on the battlefield, all players.
    select count(*)::integer into v_n
    from public.game_cards g
    join public.cards c on c.id = g.card_id
    where g.session_id = p_session_id
      and g.zone = 'battlefield'
      and c.type_line ilike '%creature%';

  elsif v_count = 'creature_cards_all_graveyards' then
    -- Bonehoard (mig 267): 'equal to the number of creature cards in ALL
    -- graveyards' — every player's, not just yours.
    select count(*)::integer into v_n
    from public.game_cards g
    join public.cards c on c.id = g.card_id
    where g.session_id = p_session_id
      and g.zone = 'graveyard'
      and c.type_line ilike '%creature%';

  elsif v_count = 'cards_in_graveyard' then
    select count(*)::integer into v_n
    from public.game_cards g
    join public.cards c on c.id = g.card_id
    where g.session_id = p_session_id
      and g.owner_id = p_controller_id
      and g.zone = 'graveyard'
      and (v_type is null or c.type_line ilike '%' || v_type || '%');

  elsif v_count = 'commanders_you_control' then
    -- "If you control your commander" (Lieutenant, mig 205): battlefield cards
    -- you control flagged is_commander. Used as a conditional's count.
    select count(*)::integer into v_n
    from public.game_cards g
    where g.session_id = p_session_id
      and coalesce(g.controller_player_id, g.owner_id) = p_controller_id
      and g.zone = 'battlefield'
      and g.is_commander = true;

  elsif v_count = 'creatures_died_this_turn' then
    -- Turn-stamped: only valid for the current turn (lazy reset).
    select case when sp.turn_creatures_died_turn = ts.turn_number then sp.turn_creatures_died else 0 end
    into v_n
    from public.game_session_players sp
    join public.game_turn_state ts on ts.session_id = sp.session_id
    where sp.session_id = p_session_id and sp.player_id = p_controller_id;

  elsif v_count = 'nontoken_creatures_died_this_turn' then
    -- Game-wide: every NONTOKEN creature that died this turn under ANY player's
    -- control (Gadrak, the Crown-Scourge). Sums the per-controller turn-stamped
    -- tally across all players (each contributes 0 once its stamp goes stale).
    select coalesce(sum(case when sp.turn_nontoken_creatures_died_turn = ts.turn_number
                             then sp.turn_nontoken_creatures_died else 0 end), 0)::integer
    into v_n
    from public.game_session_players sp
    join public.game_turn_state ts on ts.session_id = sp.session_id
    where sp.session_id = p_session_id;

  elsif v_count = 'artifacts_you_control' then
    select count(*)::integer into v_n
    from public.game_cards g
    join public.cards c on c.id = g.card_id
    where g.session_id = p_session_id
      and coalesce(g.controller_player_id, g.owner_id) = p_controller_id
      and g.zone = 'battlefield'
      and c.type_line ilike '%artifact%';

  elsif v_count = 'greatest_mana_value_you_control' then
    -- "the greatest mana value among permanents you control" (Will of the
    -- Temur draw mode, mig 239; mana_value helper since mig 244).
    select coalesce(max(public.mana_value(c.mana_cost)), 0)::integer into v_n
    from public.game_cards g
    join public.cards c on c.id = g.card_id
    where g.session_id = p_session_id
      and coalesce(g.controller_player_id, g.owner_id) = p_controller_id
      and g.zone = 'battlefield';

  elsif v_count = 'graveyard_casts_this_turn' then
    -- Spells you cast from a graveyard this turn (flashback or a cast-from-
    -- graveyard permission). Turn-stamped like creatures_died (mig 206).
    select case when sp.turn_graveyard_casts_turn = ts.turn_number then sp.turn_graveyard_casts else 0 end
    into v_n
    from public.game_session_players sp
    join public.game_turn_state ts on ts.session_id = sp.session_id
    where sp.session_id = p_session_id and sp.player_id = p_controller_id;

  elsif v_count = 'spells_cast_this_turn' then
    -- Spells you have ALREADY cast this turn (mig 369, Alisaie's Dualcast). The
    -- spell being cast now is index (this + 1). Turn-stamped via note_spell_cast.
    select case when sp.turn_spells_cast_turn = ts.turn_number then sp.turn_spells_cast else 0 end
    into v_n
    from public.game_session_players sp
    join public.game_turn_state ts on ts.session_id = sp.session_id
    where sp.session_id = p_session_id and sp.player_id = p_controller_id;

  elsif v_count = 'tokens_created_this_turn' then
    -- Tokens you created this turn (mig 399, Idol of Oblivion's "activate only
    -- if you created a token this turn"). Turn-stamped by fire_token_created.
    select case when sp.turn_tokens_created_turn = ts.turn_number then sp.turn_tokens_created else 0 end
    into v_n
    from public.game_session_players sp
    join public.game_turn_state ts on ts.session_id = sp.session_id
    where sp.session_id = p_session_id and sp.player_id = p_controller_id;

  elsif v_count = 'devotion' and v_color <> '' then
    select coalesce(sum(
      (length(c.mana_cost) - length(replace(c.mana_cost, '{' || v_color || '}', ''))) / 3
    ), 0)::integer into v_n
    from public.game_cards g
    join public.cards c on c.id = g.card_id
    where g.session_id = p_session_id
      and coalesce(g.controller_player_id, g.owner_id) = p_controller_id
      and g.zone = 'battlefield'
      and c.mana_cost is not null;

  elsif v_count = 'max_life_lost_this_turn' then
    -- Most life any single player has lost this turn (mig 294). Gates
    -- "if a player lost N or more life this turn" (Y'shtola) via `conditional`.
    select coalesce(max(life_lost_this_turn), 0)::integer into v_n
    from public.game_session_players
    where session_id = p_session_id;

  elsif v_count = 'players_lost_life_this_turn' then
    -- Number of players who have lost life this turn (mig 294, Reaper's Scythe:
    -- "a soul counter for each player who lost life this turn").
    select count(*)::integer into v_n
    from public.game_session_players
    where session_id = p_session_id and coalesce(life_lost_this_turn, 0) > 0;

  elsif v_count = 'opponents_with_more_lands' then
    -- Priest of the Blessed Graf (mig 435): "the number of opponents who
    -- control more lands than you."
    select count(*)::integer into v_n
    from public.game_session_players sp
    where sp.session_id = p_session_id
      and sp.player_id is distinct from p_controller_id
      and (select count(*) from public.game_cards gc
           join public.cards c on c.id = gc.card_id
           where gc.session_id = p_session_id and gc.zone = 'battlefield'
             and coalesce(gc.controller_player_id, gc.owner_id) = sp.player_id
             and c.type_line ilike '%land%')
        > (select count(*) from public.game_cards gc
           join public.cards c on c.id = gc.card_id
           where gc.session_id = p_session_id and gc.zone = 'battlefield'
             and coalesce(gc.controller_player_id, gc.owner_id) = p_controller_id
             and c.type_line ilike '%land%');

  elsif v_count = 'num_opponents' then
    -- Other players in the game (mig 298, Syphon Mind: "draw a card for each
    -- card discarded this way" ~ one per opponent who discarded).
    select count(*)::integer into v_n
    from public.game_session_players
    where session_id = p_session_id and player_id is distinct from p_controller_id;

  elsif v_count = 'shared_type_attackers' then
    -- Shared Animosity (mig 340): "for each OTHER attacking creature that shares
    -- a creature type with it." The source is the triggering attacker; compare
    -- the creature SUBTYPES (the words after the "—"/"-" in the type line). The
    -- pump resolves at stack resolution, by which point all attackers are
    -- declared in game_combat_assignments.
    with src as (
      select string_to_array(
               regexp_replace(lower(c.type_line), '^.*[—-]\s*', ''), ' ') as subtypes
      from public.game_cards g
      join public.cards c on c.id = g.card_id
      where g.id = p_source_card_id and g.session_id = p_session_id
    )
    select count(*)::integer into v_n
    from public.game_combat_assignments ca
    join public.game_cards g on g.id = ca.attacker_card_id
    join public.cards c on c.id = g.card_id, src
    where ca.session_id = p_session_id
      and ca.attacker_card_id is distinct from p_source_card_id
      and g.zone = 'battlefield'
      and string_to_array(regexp_replace(lower(c.type_line), '^.*[—-]\s*', ''), ' ')
          && src.subtypes;
  end if;

  -- times (mig 268, Filigree Angel: 'gain 3 life for each artifact you
  -- control' = count * 3).
  return greatest(0, coalesce(v_n, 0) * greatest(1, coalesce((p_spec ->> 'times')::integer, 1)));
end;
$$;
grant execute on function public.resolve_count_amount(uuid, uuid, jsonb, uuid) to authenticated;
grant execute on function public.resolve_count_amount(uuid, uuid, jsonb, uuid) to service_role;
