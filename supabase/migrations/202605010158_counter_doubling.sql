-- Counter doubling — Doubling Season / Corpsejack Menace (roadmap Counters #5, half 1).
--
-- A REPLACEMENT effect: "if an effect would put one or more counters on a permanent
-- you control, it puts twice that many of those counters on that permanent instead."
-- Crucially the rule keys off the controller of the PERMANENT RECEIVING the counters
-- (not the effect's controller), so every placement site already knows the recipient —
-- no acting-controller plumbing is needed.
--
-- Modeled as a top-level static `doubles_counters: true` on the script (same shape as
-- cant_be_countered). counter_factor(session, controller) returns 2^(number of such
-- permanents that player controls) — two Doubling Seasons quadruple, as the rules say.
-- Each counter-placement site multiplies POSITIVE amounts by the recipient-controller's
-- factor (removal / `all` are untouched — Doubling Season only doubles counters put ON).
-- Player counters (poison/energy/experience) are NOT doubled (players aren't permanents),
-- so add_player_counters is deliberately left alone.
--
-- NOT in scope (deferred Counters #5 half 2): dynamic "for each counter" / "X = number
-- of counters" amount scaling — a separate effect-amount feature, no overlap. Also not
-- doubled: proliferate's hardcoded +1 (consistent with the existing proliferate gaps).
--
-- Reproduced from CURRENT (grep-first): apply_creature_effect (157),
-- apply_triggered_ability_effects (157), apply_enters_with_counters (156).
-- (IDE T-SQL false-positives on $$ bodies — ignore.)

-- ===========================================================================
-- counter_factor — how many times a player's counter placements are multiplied.
-- 2^(battlefield permanents that player controls whose script doubles_counters),
-- capped to keep the exponent sane. No doublers → count 0 → factor 1.
-- ===========================================================================
create or replace function public.counter_factor(p_session_id uuid, p_controller_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select (2 ^ least(8, count(*)))::integer
  from public.game_cards gc
  where gc.session_id = p_session_id
    and gc.zone = 'battlefield'
    and gc.controller_player_id = p_controller_id
    and coalesce((public.effective_script(gc.session_id, gc.id) ->> 'doubles_counters')::boolean, false);
$$;
grant execute on function public.counter_factor(uuid, uuid) to authenticated;

-- ===========================================================================
-- apply_creature_effect (CURRENT = mig 157) — double a targeted counter PLACEMENT
-- by the target's controller's factor. Only the add_counters branch changes.
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
-- apply_triggered_ability_effects (CURRENT = mig 157) — double counter placements:
-- add_counters (source's controller) and add_counters_all (each affected creature's
-- own controller, per row). Only those two branches change.
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
        -- Doubling Season: multiply a counter PLACEMENT by the source's controller's factor.
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
        -- Each creature's counters are doubled by ITS OWN controller's factor (per row).
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
    end if;
    -- Unknown effect types are ignored (forward-compatible).
  end loop;
end;
$$;
grant execute on function public.apply_triggered_ability_effects(uuid, uuid, uuid, jsonb) to authenticated;

-- ===========================================================================
-- apply_enters_with_counters (CURRENT = mig 156) — a permanent entering with counters
-- under a Doubling Season controller enters with twice as many (e.g. Hangarback).
-- ===========================================================================
create or replace function public.apply_enters_with_counters()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_script jsonb;
  v_ewc jsonb;
  v_amount integer;
  v_counter_type text;
begin
  -- Only when ENTERING the battlefield (INSERT onto it, or a move from another zone).
  if NEW.zone <> 'battlefield' then
    return NEW;
  end if;
  if TG_OP = 'UPDATE' and OLD.zone = 'battlefield' then
    return NEW;
  end if;

  -- Effective script = the card's copied script (if any) else its printed script.
  -- Read inline (NEW isn't committed yet, so effective_script() can't see it).
  v_script := coalesce(NEW.copied_script, (select script from public.cards where id = NEW.card_id), '{}'::jsonb);
  v_ewc := v_script -> 'enters_with_counters';
  if v_ewc is null or jsonb_typeof(v_ewc) <> 'object' then
    return NEW;
  end if;

  v_amount := coalesce((v_ewc ->> 'amount')::integer, 0);
  if v_amount <= 0 then
    return NEW;
  end if;
  -- Doubling Season doubles counters a permanent enters with (NEW isn't in the table
  -- yet, so counter_factor counts only the OTHER permanents this controller has).
  v_amount := v_amount * public.counter_factor(NEW.session_id, NEW.controller_player_id);
  v_counter_type := v_ewc ->> 'counter_type';

  if public.is_plus_one_counter(v_counter_type) then
    NEW.plus_one_counters := coalesce(NEW.plus_one_counters, 0) + v_amount;
  else
    NEW.counters := public.adjust_counter_bag(coalesce(NEW.counters, '{}'::jsonb), lower(v_counter_type), v_amount);
  end if;

  return NEW;
end;
$$;

drop trigger if exists apply_enters_with_counters on public.game_cards;
create trigger apply_enters_with_counters
  before insert or update of zone on public.game_cards
  for each row execute function public.apply_enters_with_counters();
