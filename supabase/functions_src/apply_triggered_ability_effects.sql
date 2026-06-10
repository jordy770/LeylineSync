-- supabase/functions_src/apply_triggered_ability_effects.sql
-- CANONICAL current definition (seeded from 202605010202_grant_keyword_all.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

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
begin
  for v_effect in
    select * from jsonb_array_elements(coalesce(p_effects, '[]'::jsonb))
  loop
    v_eff_type := lower(coalesce(v_effect ->> 'type', ''));
    v_eff_amount := public.resolve_dynamic_amount(
      p_session_id, p_source_card_id, p_controller_id, v_effect -> 'amount');
    v_recipient := lower(coalesce(v_effect ->> 'recipient', ''));

    if v_eff_type = 'gain_life' then
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
      v_token_count := greatest(1, coalesce((v_effect ->> 'count')::integer, 1));
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
          perform public.register_card_continuous_effects(p_session_id, v_new_token_id);
        end loop;
      end if;

    elsif v_eff_type = 'amass' then
      if p_controller_id is not null and v_eff_amount > 0 then
        perform public.amass(p_session_id, p_controller_id, v_eff_amount);
      end if;

    elsif v_eff_type = 'destroy_all' then
      if p_controller_id is not null then
        perform public.destroy_all_creatures(
          p_session_id, p_controller_id,
          nullif(v_effect ->> 'creature_type', ''),
          lower(coalesce(v_effect ->> 'scope', 'all')));
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
        update public.game_cards gc
        set is_tapped = (v_eff_type = 'tap_all')
        from public.cards c
        where c.id = gc.card_id and gc.session_id = p_session_id and gc.zone = 'battlefield'
          and c.type_line ilike '%creature%'
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
