-- 202605010336_lifegain_event
-- Add a `you_gain_life` triggered event (Marauding Blight-Priest: "whenever you
-- gain life, each opponent loses 1 life"). New helper fire_lifegain_triggers
-- enqueues the watcher; it is called AFTER each of the ~6 life-gain sites (the
-- gain_life action ×2, both lifelink paths, the then-rider, Deathgorge's exile).
-- Player-scoped (no card subject), so it does not ride fire_watcher_triggers.
-- Generated from supabase/functions_src (fire_lifegain_triggers, apply_triggered_ability_effects, apply_damage_to_creature, apply_damage_to_player, handle_permanent_effect, submit_decision) — those files are
-- the canonical current definitions; edit them, not past migrations.

create or replace function public.fire_lifegain_triggers(
  p_session_id uuid,
  p_player_id uuid,
  p_amount integer
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_watcher record;
  v_ability jsonb;
  v_controller text;
begin
  -- Only an actual gain fires "whenever you gain life" (0 or negative is no gain).
  if coalesce(p_amount, 0) <= 0 or p_player_id is null then
    return;
  end if;

  for v_watcher in
    select gc.id, gc.controller_player_id
    from public.game_cards gc
    where gc.session_id = p_session_id and gc.zone = 'battlefield'
    order by gc.controller_player_id, gc.id
  loop
    for v_ability in
      select * from jsonb_array_elements(
        coalesce(public.effective_script(p_session_id, v_watcher.id) -> 'triggered_abilities', '[]'::jsonb))
    loop
      if lower(coalesce(v_ability ->> 'event', '')) <> 'you_gain_life' then
        continue;
      end if;

      -- controller is relative to the player who gained life (default 'you' =
      -- the watcher's controller gained the life). 'any' fires for every player.
      v_controller := lower(coalesce(v_ability -> 'filter' ->> 'controller', 'you'));
      if (v_controller = 'you' and v_watcher.controller_player_id is distinct from p_player_id)
         or (v_controller = 'opponent' and v_watcher.controller_player_id = p_player_id) then
        continue;
      end if;

      perform public.enqueue_triggered_ability(
        p_session_id, v_watcher.controller_player_id, v_watcher.id,
        'you_gain_life', coalesce(v_ability -> 'effects', '[]'::jsonb),
        null, jsonb_build_object('event_amount', p_amount));
    end loop;
  end loop;
end;
$$;

grant execute on function public.fire_lifegain_triggers(uuid, uuid, integer) to authenticated;

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
      if p_controller_id is not null then
        -- "draw a card" (no amount key) defaults to 1; an explicit amount draws
        -- exactly that many — incl. a dynamic count that resolves to 0 ("draw a
        -- card for each X" with X=0 draws nothing). 1..0 runs zero iterations.
        for v_draw_i in 1..(case when v_effect ? 'amount' then v_eff_amount else 1 end) loop
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
             or c.type_line not ilike '%land%');

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

create or replace function public.apply_damage_to_creature(
  p_session_id uuid,
  p_card_id uuid,
  p_amount integer,
  p_source_card_id uuid default null,
  p_is_combat boolean default false,
  p_deathtouch boolean default false,
  p_run_sweep boolean default true,
  p_as_minus_counters boolean default false
) returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_remaining integer := greatest(0, coalesce(p_amount, 0));
  v_turn integer;
  v_shield record;
  v_prevent integer;
  v_cap integer;
begin
  if v_remaining <= 0 then
    return 0;
  end if;

  -- Counter shield (mig 210, Unbreathing Horde): "If this creature would be
  -- dealt damage, prevent that damage and remove a +1/+1 counter from it." A
  -- top-level script flag `damage_removes_counters: true` — the WHOLE damage
  -- event is prevented and ONE +1/+1 counter is removed (if any; the
  -- replacement applies even at zero). The counter-state recheck handles the
  -- resulting 0-toughness SBA.
  if exists (
    select 1 from public.game_cards gc
    where gc.id = p_card_id and gc.session_id = p_session_id and gc.zone = 'battlefield'
      and coalesce((public.effective_script(p_session_id, gc.id) ->> 'damage_removes_counters')::boolean, false)
  ) then
    update public.game_cards
    set plus_one_counters = greatest(0, coalesce(plus_one_counters, 0) - 1)
    where id = p_card_id and session_id = p_session_id;
    if p_run_sweep then
      perform public.recheck_counter_state(p_session_id);
    end if;
    return 0;
  end if;

  select turn_number into v_turn
  from public.game_turn_state where session_id = p_session_id;

  for v_shield in
    select * from public.game_damage_prevention
    where session_id = p_session_id
      and affected_card_id = p_card_id
      and (combat_only = false or p_is_combat = true)
      and (expires_turn is null or expires_turn >= coalesce(v_turn, 0))
    order by created_at asc, id asc
    for update
  loop
    exit when v_remaining <= 0;

    if v_shield.amount is null then
      v_remaining := 0;
    else
      v_prevent := least(v_remaining, v_shield.amount);
      v_remaining := v_remaining - v_prevent;
      if v_shield.amount - v_prevent <= 0 then
        delete from public.game_damage_prevention where id = v_shield.id;
      else
        update public.game_damage_prevention
        set amount = amount - v_prevent
        where id = v_shield.id;
      end if;
    end if;
  end loop;

  -- Static damage cap (mig 259, Temple Altisaur: "if a source would deal
  -- damage to ANOTHER Dinosaur you control, prevent all but 1"). A fielded
  -- 'damage_cap' row caps damage to matching creatures sharing its source's
  -- controller; the protector never caps damage to itself.
  if v_remaining > 0 then
    select min(greatest(1, coalesce((ce.payload ->> 'cap')::integer, 1))) into v_cap
    from public.game_continuous_effects ce
    join public.game_cards src
      on src.id = ce.source_card_id and src.session_id = ce.session_id
    join public.game_cards tgt on tgt.id = p_card_id and tgt.session_id = p_session_id
    join public.cards tc on tc.id = tgt.card_id
    where ce.session_id = p_session_id
      and ce.effect_type = 'damage_cap'
      and src.zone = 'battlefield'
      and ce.source_card_id <> p_card_id
      and coalesce(src.controller_player_id, src.owner_id)
          = coalesce(tgt.controller_player_id, tgt.owner_id)
      and tc.type_line ilike '%' || coalesce(ce.payload ->> 'type_line', '') || '%';
    if v_cap is not null then
      v_remaining := least(v_remaining, v_cap);
    end if;
  end if;

  if v_remaining > 0 then
    if p_as_minus_counters then
      -- wither / infect: damage becomes −1/−1 counters (still "damage" for the
      -- toughness SBA; deathtouch-via-counters is a known deferred gap).
      update public.game_cards
      set counters = public.adjust_counter_bag(counters, 'minus_one_one', v_remaining)
      where id = p_card_id
        and session_id = p_session_id
        and zone = 'battlefield';
    else
      update public.game_cards
      set damage_marked = damage_marked + v_remaining,
          dealt_deathtouch_damage = dealt_deathtouch_damage or coalesce(p_deathtouch, false)
      where id = p_card_id
        and session_id = p_session_id
        and zone = 'battlefield';
    end if;

    -- Enrage (mig 254, Ripjaw Raptor / Ranging Raptors): "whenever this
    -- creature is dealt damage." Broadcast BEFORE the lethal sweep so the
    -- trigger fires even when the damage kills it (rules-correct); the
    -- enqueued trigger resolves later.
    perform public.fire_card_triggers(
      p_session_id, p_card_id, array['dealt_damage', 'enrage'],
      jsonb_build_object('event_amount', v_remaining));

    -- Lifelink (mig 283): the source's controller gains the damage dealt.
    if p_source_card_id is not null
       and public.card_has_lifelink(p_session_id, p_source_card_id) then
      update public.game_session_players
      set life_total = life_total + v_remaining
      where session_id = p_session_id
        and player_id = (select coalesce(gc.controller_player_id, gc.owner_id)
                         from public.game_cards gc
                         where gc.id = p_source_card_id and gc.session_id = p_session_id);
      perform public.fire_lifegain_triggers(p_session_id,
        (select coalesce(gc.controller_player_id, gc.owner_id) from public.game_cards gc
         where gc.id = p_source_card_id and gc.session_id = p_session_id),
        v_remaining);
    end if;

    -- Watcher broadcast (mig 260, Wrathful Raptors: "whenever a Dinosaur you
    -- control is dealt damage"). The amount rides the payload as event_amount.
    perform public.fire_watcher_triggers(
      p_session_id, p_card_id,
      (select coalesce(gc.controller_player_id, gc.owner_id)
       from public.game_cards gc
       where gc.id = p_card_id and gc.session_id = p_session_id),
      'creature_damaged',
      jsonb_build_object('event_amount', v_remaining));

    -- Combat defers the lethal sweep to its single end-of-step pass (simultaneity).
    if p_run_sweep then
      if p_as_minus_counters then
        perform public.recheck_counter_state(p_session_id);
      else
        perform public.move_lethal_damaged_creatures_to_graveyard(p_session_id);
      end if;
    end if;
  end if;

  return v_remaining;
end;
$$;

create or replace function public.apply_damage_to_player(
  p_session_id uuid,
  p_player_id uuid,
  p_amount integer,
  p_source_card_id uuid default null,
  p_is_combat boolean default false
) returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_remaining integer := greatest(0, coalesce(p_amount, 0));
  v_turn integer;
  v_shield record;
  v_prevent integer;
  v_cmd_total integer;
begin
  if v_remaining <= 0 then
    return 0;
  end if;

  select turn_number into v_turn
  from public.game_turn_state where session_id = p_session_id;

  for v_shield in
    select * from public.game_damage_prevention
    where session_id = p_session_id
      and affected_player_id = p_player_id
      and (combat_only = false or p_is_combat = true)
      and (expires_turn is null or expires_turn >= coalesce(v_turn, 0))
    order by created_at asc, id asc
    for update
  loop
    exit when v_remaining <= 0;

    if v_shield.amount is null then
      -- Prevent-all shield: stops everything and persists for the turn.
      v_remaining := 0;
    else
      v_prevent := least(v_remaining, v_shield.amount);
      v_remaining := v_remaining - v_prevent;
      if v_shield.amount - v_prevent <= 0 then
        delete from public.game_damage_prevention where id = v_shield.id;
      else
        update public.game_damage_prevention
        set amount = amount - v_prevent
        where id = v_shield.id;
      end if;
    end if;
  end loop;

  if v_remaining > 0 then
    update public.game_session_players
    set life_total = greatest(0, life_total - v_remaining)
    where session_id = p_session_id
      and player_id = p_player_id;
  end if;

  -- Commander damage: combat damage from a commander accumulates per (defender,
  -- commander); 21 cumulative from one commander loses the game for that player.
  if p_is_combat
    and v_remaining > 0
    and p_source_card_id is not null
    and exists (
      select 1 from public.game_cards
      where id = p_source_card_id
        and session_id = p_session_id
        and is_commander = true
    )
  then
    insert into public.game_commander_damage (session_id, defender_player_id, source_card_id, damage)
    values (p_session_id, p_player_id, p_source_card_id, v_remaining)
    on conflict (session_id, defender_player_id, source_card_id)
    do update set damage = public.game_commander_damage.damage + excluded.damage
    returning damage into v_cmd_total;

    if v_cmd_total >= 21 then
      update public.game_session_players
      set life_total = 0
      where session_id = p_session_id
        and player_id = p_player_id;
    end if;
  end if;

  -- Lifelink (mig 283): the damage source's controller gains that much life.
  if v_remaining > 0 and p_source_card_id is not null
     and public.card_has_lifelink(p_session_id, p_source_card_id) then
    update public.game_session_players
    set life_total = life_total + v_remaining
    where session_id = p_session_id
      and player_id = (select coalesce(gc.controller_player_id, gc.owner_id)
                       from public.game_cards gc
                       where gc.id = p_source_card_id and gc.session_id = p_session_id);
    perform public.fire_lifegain_triggers(p_session_id,
      (select coalesce(gc.controller_player_id, gc.owner_id) from public.game_cards gc
       where gc.id = p_source_card_id and gc.session_id = p_session_id),
      v_remaining);
  end if;

  return v_remaining;
end;
$$;
grant execute on function public.apply_damage_to_player(uuid, uuid, integer, uuid, boolean) to authenticated;
grant execute on function public.apply_damage_to_player(uuid, uuid, integer, uuid, boolean) to service_role;

create or replace function public.handle_permanent_effect(
  p_session_id uuid,
  p_stack_item public.game_stack_items
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_controller uuid := p_stack_item.controller_player_id;
  v_rider jsonb;
  v_rtype text;
  v_ramount integer;
  v_card uuid;
  v_pos integer;
  i integer;
  v_target_card_id uuid := nullif(p_stack_item.payload ->> 'target_card_id', '')::uuid;
  v_affected_controller uuid;
  v_search_options jsonb;
  v_decision_id uuid;
begin
  -- The destroyed permanent's controller, captured BEFORE the removal (which resets
  -- it to the owner) — for the affected-player search rider.
  select controller_player_id into v_affected_controller
  from public.game_cards
  where id = v_target_card_id and session_id = p_session_id and zone = 'battlefield';

  perform public.apply_creature_effect(
    p_session_id,
    lower(coalesce(p_stack_item.payload ->> 'kind', '')),
    v_target_card_id,
    p_stack_item.payload
  );

  -- Caster `then` riders (mig 150): simple effects applied to the CASTER.
  for v_rider in
    select value from jsonb_array_elements(coalesce(p_stack_item.payload -> 'then', '[]'::jsonb))
  loop
    v_rtype := lower(coalesce(v_rider ->> 'type', ''));
    -- Amount may be a fixed number, or {"mana_value_of":"target"} = the destroyed
    -- permanent's mana value (Feed the Swarm).
    if jsonb_typeof(v_rider -> 'amount') = 'object'
       and (v_rider -> 'amount' ->> 'mana_value_of') = 'target' then
      v_ramount := public.card_mana_value(
        p_session_id, nullif(p_stack_item.payload ->> 'target_card_id', '')::uuid);
    else
      v_ramount := coalesce((v_rider ->> 'amount')::integer, 0);
    end if;

    if v_rtype = 'lose_life' then
      update public.game_session_players
      set life_total = greatest(0, life_total - v_ramount)
      where session_id = p_session_id and player_id = v_controller;

    elsif v_rtype = 'gain_life' then
      update public.game_session_players
      set life_total = life_total + v_ramount
      where session_id = p_session_id and player_id = v_controller;
      perform public.fire_lifegain_triggers(p_session_id, v_controller, v_ramount);

    elsif v_rtype = 'draw' then
      for i in 1..greatest(0, v_ramount) loop
        select id into v_card
        from public.game_cards
        where session_id = p_session_id and owner_id = v_controller and zone = 'library'
        order by zone_position asc, id asc
        limit 1 for update skip locked;

        exit when v_card is null;

        select coalesce(max(zone_position), -1) + 1 into v_pos
        from public.game_cards
        where session_id = p_session_id and owner_id = v_controller and zone = 'hand';

        update public.game_cards
        set zone = 'hand', zone_position = v_pos, is_tapped = false, damage_marked = 0
        where id = v_card;
      end loop;

    else
      raise exception 'Unsupported rider effect in then: % (allowed: lose_life, gain_life, draw)', v_rtype;
    end if;
  end loop;

  -- Affected-controller rider: "its controller may search their library for a basic
  -- land, put it onto the battlefield, then shuffle." Park a search decision for that
  -- player (min 0 = may). Resolution awaits the decision (submit_decision finishes it).
  if coalesce((p_stack_item.payload ->> 'controller_searches_basic_land')::boolean, false)
     and v_affected_controller is not null then
    select coalesce(
             jsonb_agg(jsonb_build_object('game_card_id', lib.id, 'name', c.name) order by c.name, lib.id),
             '[]'::jsonb)
      into v_search_options
    from public.game_cards lib
    join public.cards c on c.id = lib.card_id
    where lib.session_id = p_session_id
      and lib.owner_id = v_affected_controller
      and lib.zone = 'library'
      and c.type_line ilike '%basic%'
      and c.type_line ilike '%land%';

    if jsonb_array_length(v_search_options) > 0 then
      insert into public.game_pending_decisions (
        session_id, deciding_player_id, source_stack_item_id, decision_type,
        prompt, options, min_choices, max_choices, params
      )
      values (
        p_session_id, v_affected_controller, p_stack_item.id, 'search_library',
        'Search your library for a basic land', v_search_options, 0, 1,
        jsonb_build_object('to', 'battlefield')
      )
      returning id into v_decision_id;

      update public.game_stack_items
      set status = 'awaiting_decision'
      where id = p_stack_item.id;

      return jsonb_build_object('awaiting_decision', true, 'decision_id', v_decision_id);
    end if;
  end if;

  -- Caster graveyard-return rider (mig 220, Cruel Revival: "Return up to one
  -- target Zombie card from your graveyard to your hand"). Parks the existing
  -- return_from_graveyard decision (min 0 = "up to") for the CASTER; the
  -- submit_decision branch finishes the move.
  if jsonb_typeof(p_stack_item.payload -> 'then_return_from_graveyard') = 'object' then
    select coalesce(
             jsonb_agg(jsonb_build_object('game_card_id', gy.id, 'name', c.name) order by c.name, gy.id),
             '[]'::jsonb)
      into v_search_options
    from public.game_cards gy
    join public.cards c on c.id = gy.card_id
    where gy.session_id = p_session_id
      and gy.owner_id = v_controller
      and gy.zone = 'graveyard'
      and c.type_line ilike '%' || coalesce(
            p_stack_item.payload -> 'then_return_from_graveyard' -> 'filter' ->> 'type_line',
            'creature') || '%';

    if jsonb_array_length(v_search_options) > 0 then
      insert into public.game_pending_decisions (
        session_id, deciding_player_id, source_stack_item_id, decision_type,
        prompt, options, min_choices, max_choices, params
      )
      values (
        p_session_id, v_controller, p_stack_item.id, 'return_from_graveyard',
        'Return up to '
          || coalesce(p_stack_item.payload -> 'then_return_from_graveyard' ->> 'count', '1')
          || ' from your graveyard',
        v_search_options, 0,
        coalesce((p_stack_item.payload -> 'then_return_from_graveyard' ->> 'count')::integer, 1),
        jsonb_build_object(
          'to', coalesce(p_stack_item.payload -> 'then_return_from_graveyard' ->> 'to', 'hand'),
          'tapped', coalesce((p_stack_item.payload -> 'then_return_from_graveyard' ->> 'tapped')::boolean, false))
      )
      returning id into v_decision_id;

      update public.game_stack_items
      set status = 'awaiting_decision'
      where id = p_stack_item.id;

      return jsonb_build_object('awaiting_decision', true, 'decision_id', v_decision_id);
    end if;
  end if;

  return null;
end;
$$;

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

  elsif v_decision.decision_type in ('search_library', 'choose_cards', 'sacrifice', 'return_from_graveyard', 'reanimate_destroyed', 'look_top', 'proliferate', 'copy_permanent', 'become_copy', 'bounce_pick', 'cast_exiled_free', 'put_from_hand_pick', 'destroy_pick', 'command_zone_pick', 'graveyard_exile_pick', 'fight_pick', 'etali_cast_pick', 'graveyard_to_top_pick') then
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
    -- Shuffle BEFORE placing the picks (mig 288): with a to:'top' destination
    -- the rules order is "shuffle, THEN put it on top" — shuffling after
    -- placement would bury the tutored card again. Other destinations are
    -- order-insensitive (the picks leave the library either way).
    update public.game_cards g set zone_position = s.rn
    from (select id, (row_number() over (order by random(), id) - 1) as rn from public.game_cards
          where session_id = v_decision.session_id and owner_id = v_decision.deciding_player_id and zone = 'library') s
    where g.id = s.id;
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
        -- params.control 'decider' (mig 270, Beacon of Unrest): the card enters
        -- under the DECIDER's control regardless of owner.
        update public.game_cards set zone = 'battlefield', zone_position = v_pos,
          controller_player_id = case when (v_decision.params ->> 'control') = 'decider'
                                      then v_decision.deciding_player_id else owner_id end,
          is_tapped = coalesce((v_decision.params ->> 'tapped')::boolean, false), damage_marked = 0, plus_one_counters = 0, entered_battlefield_turn_number = coalesce(v_turn, 0) where id = v_card;
        -- params.haste (mig 270, Grave Upheaval: "it gains haste") — a plain
        -- unexpiring row (NOT script-flagged, so re-registers keep it).
        if coalesce((v_decision.params ->> 'haste')::boolean, false) then
          insert into public.game_continuous_effects (
            session_id, source_card_id, affected_card_id, effect_type, payload, source_zone_required
          ) values (v_decision.session_id, v_card, v_card, 'haste', '{}'::jsonb, 'battlefield');
        end if;
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

  elsif v_decision.decision_type = 'graveyard_to_top_pick' then
    -- Noxious Revival (mig 275): the chosen graveyard card goes to the TOP of
    -- its owner's library (top = lowest zone_position).
    for v_card in select (value)::uuid from jsonb_array_elements_text(v_top)
    loop
      select coalesce(min(zone_position), 0) - 1 into v_pos
      from public.game_cards
      where session_id = v_decision.session_id
        and owner_id = (select owner_id from public.game_cards where id = v_card)
        and zone = 'library';
      update public.game_cards
      set zone = 'library', zone_position = v_pos, is_tapped = false, damage_marked = 0
      where id = v_card and session_id = v_decision.session_id and zone = 'graveyard';
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
        perform public.fire_lifegain_triggers(v_decision.session_id, v_decision.deciding_player_id,
          coalesce((v_decision.params ->> 'gain_if_creature')::integer, 2));
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
      if v_dest = 'hand' then
        -- "Put N into your hand" (mig 302, Dig Through Time); the rest bottom.
        select coalesce(max(zone_position), -1) + 1 into v_pos
        from public.game_cards where session_id = v_decision.session_id and owner_id = v_decision.deciding_player_id and zone = 'hand';
        update public.game_cards
        set zone = 'hand', zone_position = v_pos, controller_player_id = owner_id,
            is_tapped = false, damage_marked = 0
        where id = v_card;
      elsif v_dest = 'exile' then
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

  elsif v_decision.decision_type = 'pay_life_untap' then
    -- Shock land (Overgrown Tomb, …): the land is already on the battlefield tapped.
    -- If the player chose to pay AND can afford it (MTG 119.4: only if life >= cost),
    -- deduct the life and untap it; otherwise it stays tapped.
    if coalesce((v_decision.result ->> 'confirmed')::boolean, false)
       and (select life_total from public.game_session_players
            where session_id = v_decision.session_id and player_id = v_decision.deciding_player_id)
           >= coalesce((v_decision.params ->> 'life')::integer, 2)
    then
      update public.game_session_players
      set life_total = life_total - coalesce((v_decision.params ->> 'life')::integer, 2)
      where session_id = v_decision.session_id and player_id = v_decision.deciding_player_id;
      update public.game_cards
      set is_tapped = false
      where id = nullif(v_decision.params ->> 'card_id', '')::uuid and session_id = v_decision.session_id;
    end if;
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
