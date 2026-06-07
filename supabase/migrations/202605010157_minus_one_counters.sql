-- −1/−1 counters (roadmap Counters #4, the Tier-2 P/T-touching item).
--
-- Stored as a BAG key 'minus_one_one' (NOT a new column) — so proliferate, counter
-- removal, judge tools and display all handle it for free via the existing
-- multi-counter infra. The ONLY hot-path change is that the layered P/T helpers
-- subtract it. Two new rules consequences:
--   * it lowers P/T (and a creature dropped to 0 toughness dies — the existing
--     move_lethal SBA already reads effective toughness), and
--   * CR 122.3 annihilation: +1/+1 and −1/−1 counters on the same permanent cancel
--     in pairs as a state-based action.
-- Both live in recheck_counter_state(session), called wherever a −1/−1 is added.
--
-- Reproduced from CURRENT (grep-first): card_layered_power/toughness (149),
-- apply_creature_effect (155), apply_triggered_ability_effects (155),
-- adjust_card_bag_counter (155). (IDE T-SQL false-positives on $$ bodies — ignore.)

-- ===========================================================================
-- recheck_counter_state — annihilation (CR 122.3) + lethal/0-toughness SBA.
-- ===========================================================================
create or replace function public.recheck_counter_state(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- +1/+1 (fast column) and −1/−1 (bag key) on one permanent cancel in pairs.
  -- Both SET expressions read the OLD row, so they subtract the same `least`.
  update public.game_cards
  set
    plus_one_counters = plus_one_counters
      - least(plus_one_counters, coalesce((counters ->> 'minus_one_one')::integer, 0)),
    counters = public.adjust_counter_bag(
      counters, 'minus_one_one',
      -least(plus_one_counters, coalesce((counters ->> 'minus_one_one')::integer, 0)))
  where session_id = p_session_id
    and plus_one_counters > 0
    and coalesce((counters ->> 'minus_one_one')::integer, 0) > 0;

  -- −1/−1 counters can drop a creature to lethal / 0 toughness.
  perform public.move_lethal_damaged_creatures_to_graveyard(p_session_id);
end;
$$;
grant execute on function public.recheck_counter_state(uuid) to authenticated;

-- ===========================================================================
-- card_layered_power / card_layered_toughness (CURRENT = mig 149) — subtract the
-- −1/−1 bag counter at the counter layer (alongside +1/+1). Only that term changes.
-- ===========================================================================
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
      ), 0)
  from public.game_cards
  join public.cards on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id;
$$;

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
      ), 0)
  from public.game_cards
  join public.cards on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id;
$$;

-- ===========================================================================
-- apply_creature_effect (CURRENT = mig 155) — after writing a −1/−1 bag counter,
-- run recheck_counter_state (annihilation + lethal). Only the add_counters bag
-- branch gains the recheck call.
-- ===========================================================================
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
  v_amount integer := coalesce((p_params ->> 'amount')::integer, 0);
  v_target_owner_id uuid;
  v_next_position integer;
  v_keyword text;
  v_acting_controller uuid;
  v_duration text;
  v_prev_controller uuid;
  v_counter_type text;
  v_all boolean;
begin
  if p_target_card_id is null then
    return;
  end if;

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

  elsif p_kind in ('tap', 'untap') then
    update public.game_cards
    set is_tapped = (p_kind = 'tap')
    where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield';

  elsif p_kind = 'add_counters' then
    v_counter_type := p_params ->> 'counter_type';
    v_all := coalesce((p_params ->> 'all')::boolean, false);
    if v_amount <> 0 or v_all then
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
      perform public.create_pt_pump(
        p_session_id, p_target_card_id,
        coalesce((p_params ->> 'power')::integer, 0),
        coalesce((p_params ->> 'toughness')::integer, 0)
      );
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

  elsif p_kind = 'gain_control' then
    v_acting_controller := nullif(p_params ->> 'acting_controller', '')::uuid;
    if v_acting_controller is null then
      raise exception 'gain_control requires an acting controller';
    end if;
    v_duration := lower(coalesce(p_params ->> 'duration', 'permanent'));
    if v_duration not in ('permanent', 'end_of_turn') then
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
      end if;
    end if;

  else
    raise exception 'Unsupported creature effect kind: %', p_kind;
  end if;
end;
$$;
grant execute on function public.apply_creature_effect(uuid, text, uuid, jsonb) to authenticated;

-- ===========================================================================
-- apply_triggered_ability_effects (CURRENT = mig 155) — recheck after a −1/−1 bag
-- write on add_counters (source) and add_counters_all (mass). Only those branches.
-- ===========================================================================
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
              update public.game_cards
              set zone = 'graveyard', zone_position = v_next_graveyard_position, is_tapped = false
              where id = v_lib_card;
            end loop;
          end if;
        end loop;
      end if;

    elsif v_eff_type = 'create_token' then
      v_token_count := greatest(1, coalesce((v_effect ->> 'count')::integer, 1));
      select id into v_token_card_id
      from public.cards
      where lower(name) = lower(coalesce(v_effect ->> 'token', '')) and is_token = true
      limit 1;
      if found and p_controller_id is not null then
        select turn_number into v_turn_number
        from public.game_turn_state where session_id = p_session_id;
        for v_i in 1..least(v_token_count, 20) loop
          select coalesce(max(zone_position), -1) + 1 into v_next_pos
          from public.game_cards
          where session_id = p_session_id and owner_id = p_controller_id and zone = 'battlefield';
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
      v_counter_type := v_effect ->> 'counter_type';
      v_all := coalesce((v_effect ->> 'all')::boolean, false);
      if p_source_card_id is not null and (v_eff_amount <> 0 or v_all) then
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
          set plus_one_counters = case when v_all then 0 else greatest(0, gc.plus_one_counters + v_eff_amount) end
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
                              else public.adjust_counter_bag(gc.counters, lower(v_counter_type), v_eff_amount) end
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
    end if;
    -- Unknown effect types are ignored (forward-compatible).
  end loop;
end;
$$;
grant execute on function public.apply_triggered_ability_effects(uuid, uuid, uuid, jsonb) to authenticated;

-- ===========================================================================
-- adjust_card_bag_counter (CURRENT = mig 155) — judge recheck after a −1/−1 change.
-- ===========================================================================
create or replace function public.adjust_card_bag_counter(
  p_session_id uuid, p_game_card_id uuid, p_kind text, p_delta integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_counters jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  update public.game_cards
  set counters = public.adjust_counter_bag(counters, lower(p_kind), p_delta)
  where id = p_game_card_id and session_id = p_session_id
  returning counters into v_counters;

  if not found then
    raise exception 'Card not found in this session';
  end if;

  if lower(p_kind) = 'minus_one_one' then
    perform public.recheck_counter_state(p_session_id);
  end if;

  return v_counters;
end;
$$;
grant execute on function public.adjust_card_bag_counter(uuid, uuid, text, integer) to authenticated;
