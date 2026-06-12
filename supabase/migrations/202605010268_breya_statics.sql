-- 202605010268_breya_statics
-- Breya statics + sweepers batch (8 cards, mig 268): Baleful Strix, Master
-- of Etherium, Filigree Angel, Myr Battlesphere, Vedalken Engineer,
-- Whipflare, Nevinyrral's Disk, Blinkmoth Urn.
--   • card_cda_value (newly canonical from mig 149) gains
--     artifacts_you_control (Master of Etherium */*; its other-artifact
--     anthem rides the existing creature_type pump payload).
--   • resolve_count_amount gains a 'times' multiplier (Filigree Angel:
--     3 life per artifact).
--   • deal_damage_all filter.exclude_type (Whipflare: nonartifact creatures).
--   • destroy_all types array (Nevinyrral's Disk: artifacts + creatures +
--     enchantments; indestructible survives; the Disk destroys itself), and
--     destroy_all joins the activated->spell_effect routing list.
-- Approximations: Battlesphere's tap-X-Myr attack rider not modelled (ETB
-- tokens only); Vedalken Engineer's artifact-only spend restriction
-- unenforced; Blinkmoth Urn gives only ITS controller the mana (real card:
-- each player).
-- Generated from supabase/functions_src (resolve_count_amount, card_cda_value, apply_triggered_ability_effects, activate_ability) — those files are
-- the canonical current definitions; edit them, not past migrations.

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

  -- times (mig 268, Filigree Angel: 'gain 3 life for each artifact you
  -- control' = count * 3).
  return greatest(0, coalesce(v_n, 0) * greatest(1, coalesce((p_spec ->> 'times')::integer, 1)));
end;
$$;
grant execute on function public.resolve_count_amount(uuid, uuid, jsonb, uuid) to authenticated;
grant execute on function public.resolve_count_amount(uuid, uuid, jsonb, uuid) to service_role;

create or replace function public.card_cda_value(
  p_session_id uuid, p_game_card_id uuid, p_which text
)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  with spec as (
    select
      public.effective_script(p_session_id, p_game_card_id) -> 'cda' -> p_which as s,
      coalesce(gc.controller_player_id, gc.owner_id) as controller_id,
      gc.owner_id
    from public.game_cards gc
    where gc.id = p_game_card_id
      and gc.session_id = p_session_id
  )
  select case
    when (select s from spec) is null then null
    else
      coalesce((select (s ->> 'plus')::integer from spec), 0)
      + case (select s ->> 'count' from spec)
          when 'creatures_you_control' then (
            select count(*)::integer
            from public.game_cards g
            join public.cards c on c.id = g.card_id
            where g.session_id = p_session_id
              and coalesce(g.controller_player_id, g.owner_id) = (select controller_id from spec)
              and g.zone = 'battlefield'
              and c.type_line ilike '%creature%'
          )
          when 'artifacts_you_control' then (
            -- Master of Etherium (mig 268): */* = artifacts you control.
            select count(*)::integer
            from public.game_cards g
            join public.cards c on c.id = g.card_id
            where g.session_id = p_session_id
              and coalesce(g.controller_player_id, g.owner_id) = (select controller_id from spec)
              and g.zone = 'battlefield'
              and c.type_line ilike '%artifact%'
          )
          when 'lands_you_control' then (
            select count(*)::integer
            from public.game_cards g
            join public.cards c on c.id = g.card_id
            where g.session_id = p_session_id
              and coalesce(g.controller_player_id, g.owner_id) = (select controller_id from spec)
              and g.zone = 'battlefield'
              and c.type_line ilike '%land%'
          )
          when 'cards_in_graveyard' then (
            select count(*)::integer
            from public.game_cards g
            where g.session_id = p_session_id
              and g.owner_id = (select owner_id from spec)
              and g.zone = 'graveyard'
          )
          else 0
        end
  end;
$$;
grant execute on function public.card_cda_value(uuid, uuid, text) to authenticated;
grant execute on function public.card_cda_value(uuid, uuid, text) to service_role;

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
            -- exclude_type (mig 268, Whipflare: "each NONARTIFACT creature").
            and (nullif(v_effect -> 'filter' ->> 'exclude_type', '') is null
                 or c.type_line not ilike '%' || (v_effect -> 'filter' ->> 'exclude_type') || '%')
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
        if jsonb_typeof(v_effect -> 'types') = 'array' then
          -- "Destroy all artifacts, creatures, and enchantments" (mig 268,
          -- Nevinyrral's Disk). Any-type match; indestructible survives.
          for v_dmg_target in
            select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
            where gc.session_id = p_session_id and gc.zone = 'battlefield'
              and exists (select 1 from jsonb_array_elements_text(v_effect -> 'types') t
                          where c.type_line ilike '%' || t.value || '%')
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

create or replace function public.activate_ability(
  p_session_id uuid,
  p_source_card_id uuid,
  p_ability_index integer default 0,
  p_target_player_id uuid default null,
  p_target_card_id uuid default null,
  p_generic_payment jsonb default null,
  p_x_value integer default null
) returns public.game_stack_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn public.game_turn_state;
  v_zone text;
  v_script jsonb;
  v_ability jsonb;
  v_cost jsonb;
  v_effect jsonb;
  v_eff_type text;
  v_target_controller text;
  v_has_tap boolean := false;
  v_has_sac boolean := false;
  v_has_sac_creature boolean := false;
  v_has_gy_exile boolean := false;
  v_gy_filter text;
  v_tap_creatures_count integer := 0;
  v_tap_creatures_type text;
  v_discard_cost integer := 0;
  v_sac_artifacts_count integer := 0;
  v_sac_artifacts_nontoken boolean := false;
  v_sac_artifact uuid;
  v_i integer;
  v_remove_counter_type text;
  v_remove_counter_amount integer := 0;
  v_bag_count integer;
  v_mana_cost text := null;
  v_energy_cost integer := 0;
  v_player_energy integer;
  v_amount integer;
  v_next_position integer;
  v_stack public.game_stack_items;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select *
  into v_turn
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if coalesce(v_turn.priority_player_id, v_turn.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can activate abilities';
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
    raise exception 'Ability source must be on the battlefield';
  end if;

  v_script := public.effective_script(p_session_id, p_source_card_id);
  v_ability := v_script -> 'activated_abilities' -> p_ability_index;

  if v_ability is null then
    raise exception 'Activated ability not found at index %', p_ability_index;
  end if;

  if coalesce((v_ability ->> 'is_mana_ability')::boolean, false) then
    raise exception 'Use the mana ability flow for mana abilities';
  end if;

  -- Activation condition (mig 233, Skarrgan Hellkite: "Activate only if this
  -- creature has a +1/+1 counter on it"). A {counters, of, at_least} spec read
  -- via resolve_dynamic_amount before any cost is paid.
  if v_ability -> 'condition' is not null then
    if public.resolve_dynamic_amount(p_session_id, p_source_card_id, auth.uid(), v_ability -> 'condition')
       < coalesce((v_ability -> 'condition' ->> 'at_least')::integer, 1)
    then
      raise exception 'This ability cannot be activated right now';
    end if;
  end if;

  -- Parse costs
  for v_cost in select * from jsonb_array_elements(coalesce(v_ability -> 'costs', '[]'::jsonb))
  loop
    case v_cost ->> 'type'
      when 'tap_self' then v_has_tap := true;
      when 'sacrifice_self' then v_has_sac := true;
      when 'sacrifice_creature' then v_has_sac_creature := true;
      when 'exile_from_graveyard' then
        v_has_gy_exile := true;
        v_gy_filter := lower(coalesce(v_cost ->> 'type_line', 'creature'));
      when 'mana' then v_mana_cost := v_cost ->> 'amount';
      when 'energy' then v_energy_cost := greatest(0, coalesce((v_cost ->> 'amount')::integer, 0));
      -- "Tap five untapped Zombies you control" (mig 212, Gravespawn Sovereign).
      -- The engine auto-picks the N untapped matching creatures (incl. the
      -- source); a client-chosen set is a future refinement.
      when 'tap_creatures' then
        v_tap_creatures_count := greatest(1, coalesce((v_cost ->> 'count')::integer, 1));
        v_tap_creatures_type := lower(coalesce(v_cost ->> 'type_line', 'creature'));
      -- "Discard a card" as a cost (mig 214, Grimoire of the Dead): the chosen
      -- hand card rides p_target_card_id (these abilities' effect is untargeted,
      -- like the exile_from_graveyard cost).
      when 'discard' then v_discard_cost := greatest(1, coalesce((v_cost ->> 'amount')::integer, 1));
      -- "Sacrifice N artifacts" (mig 264, Breya / Thopter Foundry). The engine
      -- auto-picks the N cheapest-MV artifacts you control other than the
      -- source (tokens are MV 0, so they go first — matching real play);
      -- nontoken:true restricts to nontoken artifacts. A client-chosen set is
      -- a future refinement.
      when 'sacrifice_artifacts' then
        v_sac_artifacts_count := greatest(1, coalesce((v_cost ->> 'count')::integer, 1));
        v_sac_artifacts_nontoken := coalesce((v_cost ->> 'nontoken')::boolean, false);
      -- "Remove three study counters from ~" as a cost (mig 214).
      when 'remove_counters' then
        v_remove_counter_type := lower(coalesce(v_cost ->> 'counter_type', 'study'));
        v_remove_counter_amount := greatest(1, coalesce((v_cost ->> 'amount')::integer, 1));
      else raise exception 'Unsupported ability cost: %', v_cost ->> 'type';
    end case;
  end loop;

  -- {X} in the activation cost (mig 242, Kessig Wolf Run): the activator
  -- chooses X (p_x_value); it is paid as that much generic mana and every
  -- literal 'X' power/toughness/amount in the effects becomes the chosen
  -- value before the effects are put on the stack.
  if v_mana_cost is not null and position('{X}' in v_mana_cost) > 0 then
    if coalesce(p_x_value, -1) < 0 then
      raise exception 'This ability requires a chosen X';
    end if;
    v_mana_cost := replace(v_mana_cost, '{X}', '{' || p_x_value::text || '}');
    select jsonb_set(v_ability, '{effects}', coalesce(jsonb_agg(
      e.value
      || case when e.value ->> 'power' = 'X' then jsonb_build_object('power', p_x_value) else '{}'::jsonb end
      || case when e.value ->> 'toughness' = 'X' then jsonb_build_object('toughness', p_x_value) else '{}'::jsonb end
      || case when e.value ->> 'amount' = 'X' then jsonb_build_object('amount', p_x_value) else '{}'::jsonb end
    ), '[]'::jsonb))
    into v_ability
    from jsonb_array_elements(coalesce(v_ability -> 'effects', '[]'::jsonb)) e;
  end if;

  if v_has_tap and exists (
    select 1 from public.game_cards where id = p_source_card_id and is_tapped = true
  ) then
    raise exception 'Source is already tapped';
  end if;

  -- Energy: the activating player must have enough in their pool.
  if v_energy_cost > 0 then
    select coalesce((counters ->> 'energy')::integer, 0)
    into v_player_energy
    from public.game_session_players
    where session_id = p_session_id and player_id = auth.uid();

    if coalesce(v_player_energy, 0) < v_energy_cost then
      raise exception 'Not enough energy: need % (have %)', v_energy_cost, coalesce(v_player_energy, 0);
    end if;
  end if;

  -- Graveyard-exile cost: validate the chosen card BEFORE paying anything (it is
  -- passed as p_target_card_id; the effect of such abilities is untargeted).
  if v_has_gy_exile then
    if p_target_card_id is null then
      raise exception 'Choose a card in a graveyard to exile for this ability';
    end if;
    if not exists (
      select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.id = p_target_card_id and gc.session_id = p_session_id and gc.zone = 'graveyard'
        and (v_gy_filter = '' or c.type_line ilike '%' || v_gy_filter || '%')
    ) then
      raise exception 'That card is not a matching card in a graveyard';
    end if;
  end if;

  -- Sacrifice-a-creature cost: validate the chosen creature you control (passed as
  -- p_target_card_id; the effect is untargeted).
  if v_has_sac_creature then
    if p_target_card_id is null then
      raise exception 'Choose a creature to sacrifice for this ability';
    end if;
    if not exists (
      select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.id = p_target_card_id and gc.session_id = p_session_id and gc.zone = 'battlefield'
        and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
        and c.type_line ilike '%creature%'
    ) then
      raise exception 'You must sacrifice a creature you control';
    end if;
  end if;

  -- Discard cost: the chosen hand card rides p_target_card_id (untargeted-effect
  -- abilities only, like the graveyard-exile cost). Single-card discard only.
  if v_discard_cost > 0 then
    if v_discard_cost > 1 then
      raise exception 'Multi-card discard costs are not supported yet';
    end if;
    if p_target_card_id is null then
      raise exception 'Choose a card in your hand to discard for this ability';
    end if;
    if not exists (
      select 1 from public.game_cards
      where id = p_target_card_id and session_id = p_session_id
        and zone = 'hand' and owner_id = auth.uid()
    ) then
      raise exception 'You must discard a card from your own hand';
    end if;
    update public.game_cards gc
    set zone = 'graveyard', is_tapped = false,
        zone_position = (select coalesce(max(zone_position), -1) + 1
                         from public.game_cards x
                         where x.session_id = p_session_id and x.owner_id = gc.owner_id and x.zone = 'graveyard')
    where gc.id = p_target_card_id and gc.session_id = p_session_id;
    -- The cost consumed the target slot; the effect is untargeted.
    p_target_card_id := null;
  end if;

  -- Remove-counters cost (mig 214): the SOURCE must carry enough bag counters.
  if v_remove_counter_amount > 0 then
    select coalesce((counters ->> v_remove_counter_type)::integer, 0)
    into v_bag_count
    from public.game_cards
    where id = p_source_card_id and session_id = p_session_id;
    if coalesce(v_bag_count, 0) < v_remove_counter_amount then
      raise exception 'Not enough % counters: need % (have %)', v_remove_counter_type, v_remove_counter_amount, coalesce(v_bag_count, 0);
    end if;
    update public.game_cards
    set counters = public.adjust_counter_bag(counters, v_remove_counter_type, -v_remove_counter_amount)
    where id = p_source_card_id and session_id = p_session_id;
  end if;

  -- Tap-creatures cost: validate there are enough untapped matching creatures,
  -- then tap the first N (zone-position order).
  if v_tap_creatures_count > 0 then
    if (select count(*) from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.session_id = p_session_id and gc.zone = 'battlefield' and gc.is_tapped = false
          and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
          and c.type_line ilike '%creature%'
          and c.type_line ilike '%' || v_tap_creatures_type || '%') < v_tap_creatures_count
    then
      raise exception 'You need % untapped % creatures to activate this', v_tap_creatures_count, v_tap_creatures_type;
    end if;
    update public.game_cards
    set is_tapped = true
    where id in (
      select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.session_id = p_session_id and gc.zone = 'battlefield' and gc.is_tapped = false
        and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
        and c.type_line ilike '%creature%'
        and c.type_line ilike '%' || v_tap_creatures_type || '%'
      order by gc.zone_position, gc.id
      limit v_tap_creatures_count
    );
  end if;

  if v_mana_cost is not null then
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_mana_cost, p_generic_payment);
  end if;

  if v_energy_cost > 0 then
    update public.game_session_players
    set counters = public.adjust_counter_bag(counters, 'energy', -v_energy_cost)
    where session_id = p_session_id and player_id = auth.uid();
  end if;

  if v_has_tap then
    update public.game_cards
    set is_tapped = true
    where id = p_source_card_id and session_id = p_session_id;
  end if;

  -- Sacrifice the source as a cost (after the other costs are paid).
  if v_has_sac then
    perform public.put_in_graveyard(p_session_id, p_source_card_id);
  end if;

  -- Pay the graveyard-exile cost: exile the chosen card (controller := owner).
  if v_has_gy_exile then
    update public.game_cards gc
    set zone = 'exile', controller_player_id = gc.owner_id, is_tapped = false, damage_marked = 0,
        zone_position = (select coalesce(max(zone_position), -1) + 1
                         from public.game_cards x
                         where x.session_id = p_session_id and x.owner_id = gc.owner_id and x.zone = 'exile')
    where gc.id = p_target_card_id and gc.session_id = p_session_id;
  end if;

  -- Pay the sacrifice-a-creature cost.
  if v_has_sac_creature then
    perform public.put_in_graveyard(p_session_id, p_target_card_id);
  end if;

  -- Pay the sacrifice-N-artifacts cost (mig 264): cheapest MV first, source
  -- excluded; raise when you control too few matching artifacts.
  if v_sac_artifacts_count > 0 then
    for v_i in 1..v_sac_artifacts_count loop
      select gc.id into v_sac_artifact
      from public.game_cards gc
      join public.cards c on c.id = gc.card_id
      where gc.session_id = p_session_id and gc.zone = 'battlefield'
        and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
        and gc.id <> p_source_card_id
        and c.type_line ilike '%artifact%'
        and (not v_sac_artifacts_nontoken
             or (not coalesce(c.is_token, false) and not coalesce(gc.is_token, false)))
      order by public.mana_value(c.mana_cost) asc, gc.zone_position asc, gc.id asc
      limit 1;
      if v_sac_artifact is null then
        raise exception 'You must sacrifice % artifact(s) you control', v_sac_artifacts_count;
      end if;
      perform public.put_in_graveyard(p_session_id, v_sac_artifact);
    end loop;
  end if;

  v_effect := v_ability -> 'effects' -> 0;
  if v_effect is null then
    raise exception 'Activated ability has no effect';
  end if;

  -- Non-mana activation broadcast (mig 258, Runic Armasaur: "whenever an
  -- opponent activates an ability of a creature or land that isn't a mana
  -- ability, you may draw a card"). Mana abilities route through
  -- activate_mana_ability and never reach here, so every fire is non-mana.
  -- Approximation: the watcher's type filter defaults to '' for this event
  -- (any permanent type, not just creature-or-land).
  perform public.fire_watcher_triggers(
    p_session_id, p_source_card_id, auth.uid(), 'ability_activated');

  -- A MULTI-effect ability (Vampiric Rites: draw + lose life; Kessig Wolf
  -- Run: targeted pump + trample) resolves its whole program via a
  -- spell_effect stack item. A provided target rides the payload — the
  -- program resolver routes each targeted effect to it.
  if jsonb_array_length(coalesce(v_ability -> 'effects', '[]'::jsonb)) > 1 then
    select coalesce(max(position), 0) + 1 into v_next_position
    from public.game_stack_items where session_id = p_session_id;
    insert into public.game_stack_items (
      session_id, controller_player_id, source_card_id, action_type, payload, position, status
    ) values (
      p_session_id, auth.uid(), p_source_card_id, 'spell_effect',
      jsonb_build_object('effects', v_ability -> 'effects', 'controller_player_id', auth.uid(), 'timing', 'instant')
        || case when p_target_card_id is not null
                then jsonb_build_object('target_card_id', p_target_card_id) else '{}'::jsonb end,
      v_next_position, 'pending'
    )
    returning * into v_stack;
    return v_stack;
  end if;

  v_eff_type := lower(coalesce(v_effect ->> 'type', ''));
  v_target_controller := coalesce(lower(nullif(v_effect ->> 'target_controller', '')), 'any');
  -- Dynamic amount resolved NOW against the source permanent / controller / target.
  v_amount := public.resolve_dynamic_amount(
    p_session_id, p_source_card_id, auth.uid(), v_effect -> 'amount', p_target_card_id);

  if v_eff_type = 'draw' then
    v_stack := public.put_action_on_stack(
      p_session_id, 'draw_cards',
      jsonb_build_object('amount', greatest(1, v_amount), 'timing', 'instant'),
      p_source_card_id
    );

  elsif v_eff_type in ('create_token', 'search_library', 'grant_keyword_all', 'return_all_from_graveyard', 'deal_damage_all', 'monstrosity', 'divide_damage', 'return_from_graveyard', 'play_hideaway', 'choose_one', 'gain_life', 'fight_pick', 'destroy_all') then
    -- A single create_token / search_library / grant_keyword_all effect
    -- routes through a spell_effect stack item so it reuses the spell-effect
    -- resolver (incl. the `tapped` flag and tutor `filter`). Wayfarer's Bauble.
    -- A provided target rides the payload (mig 261, Wayta's fight_pick: the
    -- activation target is the fighter).
    select coalesce(max(position), 0) + 1 into v_next_position
    from public.game_stack_items where session_id = p_session_id;
    insert into public.game_stack_items (
      session_id, controller_player_id, source_card_id, action_type, payload, position, status
    ) values (
      p_session_id, auth.uid(), p_source_card_id, 'spell_effect',
      jsonb_build_object('effects', jsonb_build_array(v_effect), 'controller_player_id', auth.uid(), 'timing', 'instant')
        || case when p_target_card_id is not null
                then jsonb_build_object('target_card_id', p_target_card_id) else '{}'::jsonb end,
      v_next_position, 'pending'
    )
    returning * into v_stack;

  elsif v_eff_type = 'exile_from_graveyard' then
    -- Withered Wretch: target is a card in ANY graveyard (not consumed as a cost).
    if p_target_card_id is null then
      raise exception 'A target card in a graveyard is required';
    end if;
    if not exists (
      select 1 from public.game_cards
      where id = p_target_card_id and session_id = p_session_id and zone = 'graveyard'
    ) then
      raise exception 'Target must be a card in a graveyard';
    end if;
    -- Direct-insert the stack item (the dispatcher resolves it via the registered
    -- handle_exile_from_graveyard handler). put_action_on_stack's hardcoded action
    -- allowlist doesn't carry this type, so mirror the create_token path above.
    select coalesce(max(position), 0) + 1 into v_next_position
    from public.game_stack_items where session_id = p_session_id;
    insert into public.game_stack_items (
      session_id, controller_player_id, source_card_id, action_type, payload, position, status
    ) values (
      p_session_id, auth.uid(), p_source_card_id, 'exile_from_graveyard',
      jsonb_build_object('target_card_id', p_target_card_id, 'timing', 'instant'),
      v_next_position, 'pending'
    )
    returning * into v_stack;

  elsif v_eff_type = 'grant_cast_from_graveyard' and p_target_card_id is not null then
    -- Havengul Lich (mig 215): "{1}: You may cast target creature card in a
    -- graveyard this turn." The chosen card gets a card-specific until-EOT
    -- cast-from-graveyard permission (the ATAE branch writes the row). The
    -- "gains all activated abilities of that card" rider is NOT modelled.
    -- Engine limitation: the cast path only casts cards you OWN, so targeting
    -- an opponent's graveyard grants a permission that can't be used yet.
    if not exists (
      select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.id = p_target_card_id and gc.session_id = p_session_id and gc.zone = 'graveyard'
        and c.type_line ilike '%creature%'
    ) then
      raise exception 'Target must be a creature card in a graveyard';
    end if;
    select coalesce(max(position), 0) + 1 into v_next_position
    from public.game_stack_items where session_id = p_session_id;
    insert into public.game_stack_items (
      session_id, controller_player_id, source_card_id, action_type, payload, position, status
    ) values (
      p_session_id, auth.uid(), p_source_card_id, 'spell_effect',
      jsonb_build_object(
        'effects', jsonb_build_array(v_effect || jsonb_build_object('card_id', p_target_card_id)),
        'controller_player_id', auth.uid(), 'timing', 'instant'),
      v_next_position, 'pending'
    )
    returning * into v_stack;

  elsif v_eff_type = 'reanimate_from_graveyard' then
    -- Gravespawn Sovereign (mig 212): "Put target creature card from a
    -- graveyard onto the battlefield under your control." Same direct-insert
    -- route as exile_from_graveyard; the registered handler moves the card.
    if p_target_card_id is null then
      raise exception 'A target creature card in a graveyard is required';
    end if;
    if not exists (
      select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.id = p_target_card_id and gc.session_id = p_session_id and gc.zone = 'graveyard'
        and c.type_line ilike '%creature%'
    ) then
      raise exception 'Target must be a creature card in a graveyard';
    end if;
    select coalesce(max(position), 0) + 1 into v_next_position
    from public.game_stack_items where session_id = p_session_id;
    insert into public.game_stack_items (
      session_id, controller_player_id, source_card_id, action_type, payload, position, status
    ) values (
      p_session_id, auth.uid(), p_source_card_id, 'reanimate_from_graveyard',
      jsonb_build_object('target_card_id', p_target_card_id, 'timing', 'instant'),
      v_next_position, 'pending'
    )
    returning * into v_stack;

  elsif v_eff_type = 'deal_damage' then
    if v_amount <= 0 then
      raise exception 'Invalid damage amount';
    end if;
    if p_target_card_id is not null then
      v_stack := public.put_action_on_stack(
        p_session_id, 'deal_damage_creature',
        jsonb_build_object('target_card_id', p_target_card_id, 'amount', v_amount, 'target_controller', v_target_controller, 'timing', 'instant'),
        p_source_card_id
      );
    elsif p_target_player_id is not null then
      v_stack := public.put_action_on_stack(
        p_session_id, 'deal_damage_player',
        jsonb_build_object('target_player_id', p_target_player_id, 'amount', v_amount, 'timing', 'instant'),
        p_source_card_id
      );
    else
      raise exception 'A target is required for this ability';
    end if;

  elsif v_eff_type in ('destroy', 'exile', 'bounce', 'tap', 'untap') then
    if p_target_card_id is null then
      raise exception 'A target is required for this ability';
    end if;
    if public.behavior_target_type_is_creature_only(v_effect -> 'target_type') then
      v_stack := public.put_action_on_stack(
        p_session_id, v_eff_type || '_creature',
        jsonb_build_object('target_card_id', p_target_card_id, 'target_controller', v_target_controller, 'timing', 'instant'),
        p_source_card_id
      );
    else
      -- A non-creature / any-permanent target (Unstable Obelisk) goes through the
      -- type-flexible permanent_effect action; apply_creature_effect's removal
      -- kinds operate on any permanent.
      v_stack := public.put_action_on_stack(
        p_session_id, 'permanent_effect',
        jsonb_build_object('kind', v_eff_type, 'target_card_id', p_target_card_id,
          'target_type', coalesce(v_effect -> 'target_type', '"permanent"'::jsonb),
          'target_controller', v_target_controller, 'timing', 'instant'),
        p_source_card_id
      );
    end if;

  elsif v_eff_type = 'add_counters' then
    if v_amount <= 0 then
      raise exception 'Invalid counter amount';
    end if;
    if p_target_card_id is null then
      -- Untargeted (mig 214, Grimoire of the Dead "put a study counter on ~"):
      -- route through a spell_effect stack item — the trigger resolver's
      -- add_counters defaults to the SOURCE (incl. bag counter_type).
      select coalesce(max(position), 0) + 1 into v_next_position
      from public.game_stack_items where session_id = p_session_id;
      insert into public.game_stack_items (
        session_id, controller_player_id, source_card_id, action_type, payload, position, status
      ) values (
        p_session_id, auth.uid(), p_source_card_id, 'spell_effect',
        jsonb_build_object('effects', jsonb_build_array(v_effect), 'controller_player_id', auth.uid(), 'timing', 'instant'),
        v_next_position, 'pending'
      )
      returning * into v_stack;
    else
      v_stack := public.put_action_on_stack(
        p_session_id, 'add_counters_creature',
        jsonb_build_object('target_card_id', p_target_card_id, 'amount', v_amount, 'target_controller', v_target_controller, 'timing', 'instant'),
        p_source_card_id
      );
    end if;

  elsif v_eff_type = 'pump' then
    if p_target_card_id is null then
      raise exception 'A target is required for this ability';
    end if;
    v_stack := public.put_action_on_stack(
      p_session_id, 'pump_creature',
      jsonb_build_object('target_card_id', p_target_card_id,
        'power', coalesce((v_effect ->> 'power')::integer, 0),
        'toughness', coalesce((v_effect ->> 'toughness')::integer, 0),
        'target_controller', v_target_controller, 'timing', 'instant'),
      p_source_card_id
    );

  elsif v_eff_type = 'grant_keyword' then
    if p_target_card_id is null then
      raise exception 'A target is required for this ability';
    end if;
    v_stack := public.put_action_on_stack(
      p_session_id, 'grant_keyword_creature',
      jsonb_build_object('target_card_id', p_target_card_id, 'keyword', lower(coalesce(v_effect ->> 'keyword', '')),
        'target_controller', v_target_controller, 'timing', 'instant'),
      p_source_card_id
    );

  elsif v_eff_type = 'equip' then
    -- Equip {N} (mig 266, Breya Equipment cluster): attach this Equipment to
    -- target creature you control. register_card_continuous_effects already
    -- lands affected:'equipped' rows on attached_to, so a re-register after
    -- the move grants the Equipment's bonuses to the new host. Sorcery-speed
    -- timing is not enforced (consistent with the engine's loose timing).
    if p_target_card_id is null then
      raise exception 'Equip needs a target creature you control';
    end if;
    if not exists (
      select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.id = p_target_card_id and gc.session_id = p_session_id
        and gc.zone = 'battlefield'
        and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
        and c.type_line ilike '%creature%'
    ) then
      raise exception 'Equip target must be a creature you control';
    end if;
    update public.game_cards
    set attached_to = p_target_card_id
    where id = p_source_card_id and session_id = p_session_id;
    perform public.rebuild_scripted_continuous_effects(p_session_id);
    v_stack := null;

  elsif v_eff_type = 'gain_control' then
    if p_target_card_id is null then
      raise exception 'A target is required for this ability';
    end if;
    v_stack := public.put_action_on_stack(
      p_session_id, 'gain_control_creature',
      jsonb_build_object('target_card_id', p_target_card_id,
        'duration', coalesce(v_effect ->> 'duration', 'permanent'),
        'untap', coalesce((v_effect ->> 'untap')::boolean, false),
        'haste', coalesce((v_effect ->> 'haste')::boolean, false),
        'target_controller', v_target_controller, 'timing', 'instant'),
      p_source_card_id
    );

  else
    raise exception 'Unsupported ability effect: %', v_eff_type;
  end if;

  return v_stack;
end;
$$;
grant execute on function public.activate_ability(uuid, uuid, integer, uuid, uuid, jsonb, integer) to authenticated;
