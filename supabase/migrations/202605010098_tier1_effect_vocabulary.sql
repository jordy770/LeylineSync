-- Tier-1 effect vocabulary:
--   * gain_life / lose_life support each_player/all_players recipients.
--   * add_counters_all puts +1/+1 counters on each creature for a controller scope.
--   * tap_all / untap_all tap or untap creatures for a controller scope.
--
-- These are auto-resolved trigger/spell_effect program actions, so no new stack
-- action_type or target picker is introduced.

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
begin
  for v_effect in
    select * from jsonb_array_elements(coalesce(p_effects, '[]'::jsonb))
  loop
    v_eff_type := lower(coalesce(v_effect ->> 'type', ''));
    v_eff_amount := coalesce((v_effect ->> 'amount')::integer, 0);
    v_recipient := lower(coalesce(v_effect ->> 'recipient', ''));

    if v_eff_type = 'gain_life' then
      if v_eff_amount > 0 then
        if v_recipient in ('each_player', 'all_players') then
          select array_agg(player_id)
          into v_recipients
          from public.game_session_players
          where session_id = p_session_id;
        elsif v_recipient = 'each_opponent' then
          select array_agg(player_id)
          into v_recipients
          from public.game_session_players
          where session_id = p_session_id
            and player_id is distinct from p_controller_id;
        else
          v_recipients := array[p_controller_id];
        end if;

        foreach v_rid in array coalesce(v_recipients, array[]::uuid[])
        loop
          if v_rid is not null then
            update public.game_session_players
            set life_total = life_total + v_eff_amount
            where session_id = p_session_id
              and player_id = v_rid;
          end if;
        end loop;
      end if;

    elsif v_eff_type in ('lose_life', 'deal_damage') then
      if v_eff_amount > 0 then
        if v_recipient = 'controller' then
          v_recipients := array[p_controller_id];
        elsif v_recipient in ('each_player', 'all_players') then
          select array_agg(player_id)
          into v_recipients
          from public.game_session_players
          where session_id = p_session_id;
        else
          select array_agg(player_id)
          into v_recipients
          from public.game_session_players
          where session_id = p_session_id
            and player_id is distinct from p_controller_id;
        end if;

        foreach v_rid in array coalesce(v_recipients, array[]::uuid[])
        loop
          update public.game_session_players
          set life_total = greatest(0, life_total - v_eff_amount)
          where session_id = p_session_id
            and player_id = v_rid;
        end loop;
      end if;

    elsif v_eff_type = 'draw' then
      if p_controller_id is not null then
        for v_draw_i in 1..greatest(1, v_eff_amount) loop
          select coalesce(max(zone_position), -1) + 1
          into v_next_hand_position
          from public.game_cards
          where session_id = p_session_id
            and owner_id = p_controller_id
            and zone = 'hand';

          select id
          into v_lib_card
          from public.game_cards
          where session_id = p_session_id
            and owner_id = p_controller_id
            and zone = 'library'
          order by zone_position asc, id asc
          limit 1
          for update skip locked;

          exit when v_lib_card is null;

          update public.game_cards
          set zone = 'hand', zone_position = v_next_hand_position, is_tapped = false
          where id = v_lib_card;
        end loop;
      end if;

    elsif v_eff_type = 'mill' then
      if v_eff_amount > 0 then
        if v_recipient = 'controller' or v_recipient = '' then
          v_recipients := array[p_controller_id];
        elsif v_recipient in ('each_player', 'all_players') then
          select array_agg(player_id)
          into v_recipients
          from public.game_session_players
          where session_id = p_session_id;
        else
          select array_agg(player_id)
          into v_recipients
          from public.game_session_players
          where session_id = p_session_id
            and player_id is distinct from p_controller_id;
        end if;

        foreach v_rid in array coalesce(v_recipients, array[]::uuid[])
        loop
          if v_rid is not null then
            for v_draw_i in 1..v_eff_amount loop
              select coalesce(max(zone_position), -1) + 1
              into v_next_graveyard_position
              from public.game_cards
              where session_id = p_session_id
                and owner_id = v_rid
                and zone = 'graveyard';

              select id
              into v_lib_card
              from public.game_cards
              where session_id = p_session_id
                and owner_id = v_rid
                and zone = 'library'
              order by zone_position asc, id asc
              limit 1
              for update skip locked;

              exit when v_lib_card is null;

              update public.game_cards
              set zone = 'graveyard', zone_position = v_next_graveyard_position, is_tapped = false
              where id = v_lib_card;
            end loop;
          end if;
        end loop;
      end if;

    elsif v_eff_type = 'create_token' then
      v_token_count := greatest(1, coalesce((v_effect ->> 'count')::integer, 1));

      select id
      into v_token_card_id
      from public.cards
      where lower(name) = lower(coalesce(v_effect ->> 'token', ''))
        and is_token = true
      limit 1;

      if found and p_controller_id is not null then
        select turn_number
        into v_turn_number
        from public.game_turn_state
        where session_id = p_session_id;

        for v_i in 1..least(v_token_count, 20) loop
          select coalesce(max(zone_position), -1) + 1
          into v_next_pos
          from public.game_cards
          where session_id = p_session_id
            and owner_id = p_controller_id
            and zone = 'battlefield';

          insert into public.game_cards (
            session_id, card_id, owner_id, controller_player_id,
            zone, zone_position, is_tapped, damage_marked,
            position_x, position_y, entered_battlefield_turn_number
          )
          values (
            p_session_id, v_token_card_id, p_controller_id, p_controller_id,
            'battlefield', v_next_pos, false, 0, 0, 0, coalesce(v_turn_number, 0)
          )
          returning id into v_new_token_id;

          perform public.register_card_continuous_effects(p_session_id, v_new_token_id);
        end loop;
      end if;

    elsif v_eff_type = 'add_counters' then
      if p_source_card_id is not null and v_eff_amount <> 0 then
        update public.game_cards
        set plus_one_counters = greatest(0, plus_one_counters + v_eff_amount)
        where id = p_source_card_id
          and session_id = p_session_id
          and zone = 'battlefield';

        perform public.move_lethal_damaged_creatures_to_graveyard(p_session_id);
      end if;

    elsif v_eff_type = 'add_counters_all' then
      if v_eff_amount > 0 and p_controller_id is not null then
        v_target_controller := public.behavior_target_controller(v_effect || jsonb_build_object(
          'target_controller',
          coalesce(v_effect ->> 'target_controller', 'you')
        ));

        update public.game_cards gc
        set plus_one_counters = greatest(0, gc.plus_one_counters + v_eff_amount)
        from public.cards c
        where c.id = gc.card_id
          and gc.session_id = p_session_id
          and gc.zone = 'battlefield'
          and c.type_line ilike '%creature%'
          and (
            v_target_controller = 'any'
            or (v_target_controller = 'you' and gc.controller_player_id = p_controller_id)
            or (v_target_controller = 'opponent' and gc.controller_player_id is distinct from p_controller_id)
          );
      end if;

    elsif v_eff_type in ('tap_all', 'untap_all') then
      if p_controller_id is not null then
        v_target_controller := public.behavior_target_controller(v_effect || jsonb_build_object(
          'target_controller',
          coalesce(v_effect ->> 'target_controller', 'you')
        ));

        update public.game_cards gc
        set is_tapped = (v_eff_type = 'tap_all')
        from public.cards c
        where c.id = gc.card_id
          and gc.session_id = p_session_id
          and gc.zone = 'battlefield'
          and c.type_line ilike '%creature%'
          and (
            v_target_controller = 'any'
            or (v_target_controller = 'you' and gc.controller_player_id = p_controller_id)
            or (v_target_controller = 'opponent' and gc.controller_player_id is distinct from p_controller_id)
          );
    end if;
    end if;
    -- Unknown effect types are ignored (forward-compatible).
  end loop;
end;
$$;

grant execute on function public.apply_triggered_ability_effects(uuid, uuid, uuid, jsonb) to authenticated;
