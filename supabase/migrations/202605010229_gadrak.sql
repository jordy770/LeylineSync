-- 202605010229_gadrak — Gadrak, the Crown-Scourge.
--   (1) Game-wide NONTOKEN creature-death tally: a per-controller turn-stamped
--       counter on game_session_players, summed across players by a new
--       resolve_count_amount source 'nontoken_creatures_died_this_turn'.
--   (2) 'artifacts_you_control' count source (Gadrak's attack restriction).
--   (3) create_token now accepts a DYNAMIC count object (resolved via the amount
--       engine, NOT floored at 1 — zero deaths makes zero Treasures).
--   (4) declare_attacker honours a top-level 'cant_attack_unless' {count,at_least}
--       script prop ("can't attack unless you control four or more artifacts").
-- Generated from supabase/functions_src (resolve_count_amount, put_in_graveyard,
-- apply_triggered_ability_effects, declare_attacker) — edit those, not this file.

alter table public.game_session_players
  add column if not exists turn_nontoken_creatures_died integer not null default 0,
  add column if not exists turn_nontoken_creatures_died_turn integer not null default 0;

create or replace function public.resolve_count_amount(
  p_session_id uuid,
  p_controller_id uuid,
  p_spec jsonb
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
    select count(*)::integer into v_n
    from public.game_cards g
    join public.cards c on c.id = g.card_id
    where g.session_id = p_session_id
      and coalesce(g.controller_player_id, g.owner_id) = p_controller_id
      and g.zone = 'battlefield'
      and c.type_line ilike '%creature%'
      and (v_type is null or c.type_line ilike '%' || v_type || '%');

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

  elsif v_count = 'graveyard_casts_this_turn' then
    -- Spells you cast from a graveyard this turn (flashback or a cast-from-
    -- graveyard permission). Turn-stamped like creatures_died (mig 206).
    select case when sp.turn_graveyard_casts_turn = ts.turn_number then sp.turn_graveyard_casts else 0 end
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
  end if;

  return greatest(0, coalesce(v_n, 0));
end;
$$;
grant execute on function public.resolve_count_amount(uuid, uuid, jsonb) to authenticated;
grant execute on function public.resolve_count_amount(uuid, uuid, jsonb) to service_role;

create or replace function public.put_in_graveyard(p_session_id uuid, p_game_card_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_controller_id uuid;
  v_is_creature boolean;
  v_is_token boolean;
  v_turn integer;
  v_next_graveyard_position integer;
  v_had_counters integer;
  v_undying boolean := false;
  v_next_bf_position integer;
begin
  select g.owner_id, coalesce(g.controller_player_id, g.owner_id), (c.type_line ilike '%creature%'),
         coalesce(c.is_token, false), coalesce(g.plus_one_counters, 0)
  into v_owner_id, v_controller_id, v_is_creature, v_is_token, v_had_counters
  from public.game_cards g
  join public.cards c on c.id = g.card_id
  where g.id = p_game_card_id
    and g.session_id = p_session_id
    and g.zone = 'battlefield';

  if not found then
    return false;
  end if;

  -- Undying (mig 219, Geralf's Mindcrusher): "When this creature dies, if it
  -- had no +1/+1 counters on it, return it under its owner's control with a
  -- +1/+1 counter." Captured BEFORE the move (the move resets counters).
  if v_is_creature and v_had_counters = 0 then
    v_undying := coalesce(
      (public.effective_script(p_session_id, p_game_card_id) ->> 'undying')::boolean, false);
  end if;

  select coalesce(max(zone_position), -1) + 1
  into v_next_graveyard_position
  from public.game_cards
  where session_id = p_session_id
    and owner_id = v_owner_id
    and zone = 'graveyard';

  update public.game_cards
  set
    zone = 'graveyard',
    zone_position = v_next_graveyard_position,
    controller_player_id = owner_id,
    is_tapped = false,
    damage_marked = 0,
    dealt_deathtouch_damage = false,
    plus_one_counters = 0
  where id = p_game_card_id;

  -- Tally "creatures that died under your control this turn" (turn-stamped: the
  -- count belongs to the stored turn, so it reads as 0 once the turn changes).
  if v_is_creature and v_controller_id is not null then
    select turn_number into v_turn from public.game_turn_state where session_id = p_session_id;
    update public.game_session_players
    set turn_creatures_died = case when turn_creatures_died_turn = coalesce(v_turn, 0)
                                   then turn_creatures_died + 1 else 1 end,
        turn_creatures_died_turn = coalesce(v_turn, 0),
        -- Nontoken-only tally (Gadrak): summed game-wide by resolve_count_amount.
        turn_nontoken_creatures_died = case
          when not v_is_token then
            case when turn_nontoken_creatures_died_turn = coalesce(v_turn, 0)
                 then turn_nontoken_creatures_died + 1 else 1 end
          when turn_nontoken_creatures_died_turn = coalesce(v_turn, 0)
            then turn_nontoken_creatures_died else 0 end,
        turn_nontoken_creatures_died_turn = case
          when not v_is_token then coalesce(v_turn, 0)
          else turn_nontoken_creatures_died_turn end
    where session_id = p_session_id and player_id = v_controller_id;
  end if;

  -- Undying return: AFTER the graveyard move (so dies triggers and the death
  -- tally fired normally), bring the card back under its OWNER's control with
  -- one +1/+1 counter. It then has a counter, so dying again stays dead.
  if v_undying then
    select turn_number into v_turn from public.game_turn_state where session_id = p_session_id;
    select coalesce(max(zone_position), -1) + 1
    into v_next_bf_position
    from public.game_cards
    where session_id = p_session_id and owner_id = v_owner_id and zone = 'battlefield';

    update public.game_cards
    set zone = 'battlefield',
        zone_position = v_next_bf_position,
        controller_player_id = owner_id,
        is_tapped = false,
        plus_one_counters = 1,
        entered_battlefield_turn_number = coalesce(v_turn, 0)
    where id = p_game_card_id and session_id = p_session_id;
  end if;

  return true;
end;
$$;

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

create or replace function public.declare_attacker(
  p_session_id uuid,
  p_attacker_card_id uuid,
  p_defending_player_id uuid,
  p_defending_planeswalker_id uuid default null
) returns public.game_combat_assignments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_attacker record;
  v_pw record;
  v_defending_player uuid := p_defending_player_id;
  v_assignment public.game_combat_assignments;
  v_curse record;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  -- Attacking a planeswalker: the defending player is its controller.
  if p_defending_planeswalker_id is not null then
    select coalesce(gc.controller_player_id, gc.owner_id) as controller, c.type_line
    into v_pw
    from public.game_cards gc
    join public.cards c on c.id = gc.card_id
    where gc.id = p_defending_planeswalker_id
      and gc.session_id = p_session_id
      and gc.zone = 'battlefield';
    if not found or coalesce(v_pw.type_line, '') not ilike '%planeswalker%' then
      raise exception 'Defending planeswalker not found on the battlefield';
    end if;
    v_defending_player := v_pw.controller;
  end if;

  if not public.is_session_player(p_session_id, v_defending_player) then
    raise exception 'Defending player is not a player in this session';
  end if;

  if v_defending_player = auth.uid() then
    raise exception 'A player cannot attack themselves';
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
    raise exception 'Cannot declare attackers in a finished game session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if v_turn_state.active_player_id <> auth.uid() then
    raise exception 'Only the active player can declare attackers';
  end if;

  if v_turn_state.step <> 'declare_attackers' then
    raise exception 'Attackers can only be declared during Declare Attackers Step';
  end if;

  select
    game_cards.id,
    game_cards.is_tapped,
    game_cards.entered_battlefield_turn_number,
    cards.type_line
  into v_attacker
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_attacker_card_id
    and game_cards.session_id = p_session_id
    and coalesce(game_cards.controller_player_id, game_cards.owner_id) = auth.uid()
    and game_cards.zone = 'battlefield'
  for update of game_cards;

  if not found then
    raise exception 'Attacker card not found, not on battlefield, or not controlled by active player';
  end if;

  if coalesce(v_attacker.type_line, '') not ilike '%creature%' then
    raise exception 'Only creatures can be declared as attackers';
  end if;

  if v_attacker.is_tapped then
    raise exception 'Tapped creatures cannot be declared as attackers';
  end if;

  if coalesce(v_attacker.entered_battlefield_turn_number, v_turn_state.turn_number) >= v_turn_state.turn_number
    and not public.card_has_haste(p_session_id, p_attacker_card_id)
  then
    raise exception 'Creature has summoning sickness';
  end if;

  -- Attack restriction (Gadrak: "can't attack unless you control four or more
  -- artifacts"). A top-level script prop {count, at_least}; the count is read
  -- for the attacking player (auth.uid()).
  declare
    v_restrict jsonb := public.effective_script(p_session_id, p_attacker_card_id) -> 'cant_attack_unless';
  begin
    if v_restrict is not null
       and public.resolve_count_amount(p_session_id, auth.uid(), v_restrict)
           < coalesce((v_restrict ->> 'at_least')::integer, 1)
    then
      raise exception 'This creature cannot attack: an attack condition is not met';
    end if;
  end;

  update public.game_cards
  set is_tapped = true
  where id = p_attacker_card_id
    and not public.card_has_vigilance(p_session_id, p_attacker_card_id);

  insert into public.game_combat_assignments (
    session_id,
    turn_number,
    attacker_card_id,
    attacking_player_id,
    defending_player_id,
    defending_planeswalker_id
  )
  values (
    p_session_id,
    v_turn_state.turn_number,
    p_attacker_card_id,
    auth.uid(),
    v_defending_player,
    p_defending_planeswalker_id
  )
  returning * into v_assignment;

  -- Curse of Disturbance: when the defending player is attacked, each curse
  -- enchanting them makes its controller create a 2/2 black Zombie — and "each
  -- opponent attacking that player does the same" (the attacking player too).
  for v_curse in
    select ce.source_card_id, coalesce(gc.controller_player_id, gc.owner_id) as curse_controller
    from public.game_continuous_effects ce
    join public.game_cards gc on gc.id = ce.source_card_id
      and gc.session_id = p_session_id and gc.zone = 'battlefield'
    where ce.session_id = p_session_id
      and ce.effect_type = 'curse_attacked'
      and ce.affected_player_id = v_defending_player
  loop
    perform public.enqueue_triggered_ability(
      p_session_id, v_curse.curse_controller, v_curse.source_card_id,
      'Curse of Disturbance', jsonb_build_array(jsonb_build_object('type', 'create_token', 'token', 'Zombie Token')));
    if auth.uid() is distinct from v_curse.curse_controller then
      perform public.enqueue_triggered_ability(
        p_session_id, auth.uid(), v_curse.source_card_id,
        'Curse of Disturbance', jsonb_build_array(jsonb_build_object('type', 'create_token', 'token', 'Zombie Token')));
    end if;
  end loop;

  return v_assignment;
end;
$$;
grant execute on function public.declare_attacker(uuid, uuid, uuid, uuid) to authenticated;
grant execute on function public.declare_attacker(uuid, uuid, uuid, uuid) to service_role;
