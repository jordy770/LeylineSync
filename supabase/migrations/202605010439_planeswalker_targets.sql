-- 202605010439_planeswalker_targets
-- Bucket-6-slice (planeswalker-eligible effects):
-- - Nieuwe count nonland_permanents_on_battlefield voor cost_reduction.if
--   (Hour of Revelation).
-- - add_counters krijgt if_target_type_line (Sorins +1-rider: "If it's a
--   Vampire, put a +1/+1 counter on it") — gate in apply_creature_effect op
--   de effective type line; de add_counters-builder laat de key nu door
--   (nieuw canoniek functions_src-bestand, seed mig 162).
-- - De edicts (Demon's Disciple / Plaguecrafter) en Haven of the Spirit
--   Dragon bleken script-only (park_edict_sacrifice's mig-417 type_line_any
--   resp. return_from_graveyards mig-265 types-array); Banishing Light idem
--   (nonland_permanent-target bestond al); Norn's Annex was een stale flag.
-- Generated from supabase/functions_src (resolve_count_amount, apply_creature_effect, build_stack_payload_add_counters_creature) — those files are
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

  elsif v_count = 'nonland_permanents_on_battlefield' then
    -- Hour of Revelation (mig 439): "if there are ten or more nonland
    -- permanents on the battlefield" — every player's, any type but land.
    select count(*)::integer into v_n
    from public.game_cards gc
    join public.cards c on c.id = gc.card_id
    where gc.session_id = p_session_id and gc.zone = 'battlefield'
      and c.type_line not ilike '%land%';

  elsif v_count = 'opponents_attacked_this_combat' then
    -- Melee (mig 438, Drogskol Reinforcements): the number of distinct
    -- opponents attacked by the controller's creatures this combat.
    select count(distinct ca.defending_player_id)::integer into v_n
    from public.game_combat_assignments ca
    join public.game_cards gc on gc.id = ca.attacker_card_id and gc.session_id = ca.session_id
    where ca.session_id = p_session_id
      and coalesce(gc.controller_player_id, gc.owner_id) = p_controller_id
      and ca.defending_player_id is not null;

  elsif v_count = 'opponent_graveyard_cards' then
    -- Into the Story (mig 437): "if an opponent has seven or more cards in
    -- their graveyard" — the HIGHEST graveyard count among opponents.
    select coalesce(max(cnt), 0)::integer into v_n
    from (
      select count(*) as cnt
      from public.game_cards gc
      where gc.session_id = p_session_id and gc.zone = 'graveyard'
        and gc.owner_id is distinct from p_controller_id
      group by gc.owner_id
    ) g;

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
  v_is_pw boolean;
begin
  if p_target_card_id is null then
    return;
  end if;

  -- Negative target restriction (mig 414): "destroy target NONBLACK creature"
  -- (exclude_color) / "…that isn't a Vampire, Werewolf, or Zombie"
  -- (exclude_type_line). If the chosen target matches, the removal simply does
  -- nothing to it. Only the removal kinds honour it; the effect JSON carries the
  -- fields for spell + triggered paths, and activate_ability threads them for the
  -- activated path. (This is also what finally enforces exclude_type_line on the
  -- triggered/activated paths, which the target pickers never checked.)
  if p_kind in ('destroy', 'exile', 'bounce', 'tap', 'untap')
     and (p_params ? 'exclude_type_line' or p_params ? 'exclude_color')
     and public.card_matches_exclusion(
           p_session_id, p_target_card_id,
           p_params -> 'exclude_type_line', p_params -> 'exclude_color') then
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
      -- Planeswalker targets take loyalty loss, not marked damage (mig 412).
      -- Single-target deal_damage (spell / trigger / activated all funnel here)
      -- can now hit a planeswalker, mirroring divide_damage / combat damage
      -- (apply_damage_allocations). SBA then sweeps any 0-loyalty walker.
      select c.type_line ilike '%planeswalker%' into v_is_pw
      from public.game_cards g join public.cards c on c.id = g.card_id
      where g.id = p_target_card_id and g.session_id = p_session_id;
      if coalesce(v_is_pw, false) then
        perform public.apply_damage_to_planeswalker(p_session_id, p_target_card_id, v_amount);
        perform public.move_zero_loyalty_planeswalkers_to_graveyard(p_session_id);
      else
        perform public.apply_damage_to_creature(
          p_session_id, p_target_card_id, v_amount, null, false,
          coalesce((p_params ->> 'deathtouch')::boolean, false)
        );
      end if;
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
          'exiled_until_leaves',
          -- return_to (mig 404, Angel of Serenity → owners' hands); default
          -- battlefield when absent (Bronzebeak Foragers).
          case when lower(coalesce(p_params ->> 'return_to', '')) = 'hand'
               then jsonb_build_object('return_to', 'hand') else '{}'::jsonb end,
          'battlefield'
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
    -- stun rider (mig 403, Frost Titan: "It doesn't untap during its
    -- controller's next untap step") — a 'stun' bag counter; advance_step's
    -- untap skips stunned permanents and removes one counter instead.
    if p_kind = 'tap' and coalesce((p_params ->> 'stun')::boolean, false) then
      update public.game_cards
      set counters = public.adjust_counter_bag(counters, 'stun', 1)
      where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield';
    end if;

  elsif p_kind = 'add_counters' then
    v_counter_type := p_params ->> 'counter_type';
    v_all := coalesce((p_params ->> 'all')::boolean, false);
    -- if_target_type_line (mig 439, Sorin's +1: "If it's a Vampire, put a
    -- +1/+1 counter on it") — the rider only lands when the TARGET's effective
    -- type line matches; otherwise the effect silently does nothing.
    if nullif(p_params ->> 'if_target_type_line', '') is not null
       and coalesce(public.effective_type_line(p_session_id, p_target_card_id), '')
           not ilike '%' || (p_params ->> 'if_target_type_line') || '%' then
      return;
    end if;
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

create or replace function public.build_stack_payload_add_counters_creature(
  p_session_id uuid, p_actor uuid, p_payload jsonb, p_timing text, p_target_controller text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_target_card_id uuid;
  v_amount integer;
  v_all boolean;
begin
  v_target_card_id := nullif(p_payload ->> 'target_card_id', '')::uuid;
  if jsonb_typeof(p_payload -> 'amount') = 'object' then
    v_amount := public.resolve_dynamic_amount(p_session_id, null, p_actor, p_payload -> 'amount', v_target_card_id);
  else
    v_amount := coalesce((p_payload ->> 'amount')::integer, 0);
  end if;
  v_all := coalesce((p_payload ->> 'all')::boolean, false);

  if v_target_card_id is null then
    raise exception 'target_card_id is required';
  end if;
  if v_amount = 0 and not v_all then
    raise exception 'amount must be non-zero (or all=true to remove every counter)';
  end if;
  if not public.creature_target_controller_ok(p_session_id, v_target_card_id, p_actor, p_target_controller) then
    raise exception 'Target is not a legal creature for this spell';
  end if;

  return jsonb_build_object(
    'target_card_id', v_target_card_id,
    'amount', v_amount,
    'all', v_all,
    'counter_type', p_payload ->> 'counter_type',
    'target_controller', p_target_controller,
    'timing', p_timing
  )
  -- if_target_type_line (mig 439, Sorin's Vampire rider): ride the built
  -- payload through to apply_creature_effect, which enforces the gate.
  || (case when nullif(p_payload ->> 'if_target_type_line', '') is not null
           then jsonb_build_object('if_target_type_line', p_payload ->> 'if_target_type_line')
           else '{}'::jsonb end);
end;
$$;
