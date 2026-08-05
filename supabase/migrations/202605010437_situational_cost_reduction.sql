-- 202605010437_situational_cost_reduction
-- TODO: describe the change.
-- Generated from supabase/functions_src (resolve_count_amount, reduced_mana_cost, handle_counter_spell, fire_watcher_triggers, apply_triggered_ability_effects) — those files are
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

create or replace function public.reduced_mana_cost(
  p_session_id uuid,
  p_caster uuid,
  p_card_id uuid,
  p_cost text
) returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cost text := coalesce(p_cost, '');
  v_reduction integer := 0;
  v_self jsonb;
  v_type_line text;
  v_zone text;
  v_mana_cost text;
  v_generic text;
  v_new integer;
  v_spells_cast integer;
begin
  if btrim(v_cost) = '' or p_caster is null then
    return v_cost;
  end if;

  select c.type_line, g.zone, c.mana_cost into v_type_line, v_zone, v_mana_cost
  from public.game_cards g join public.cards c on c.id = g.card_id
  where g.id = p_card_id and g.session_id = p_session_id;

  -- Self reduction (the spell's own script).
  v_self := public.effective_script(p_session_id, p_card_id) -> 'cost_reduction';
  if v_self is not null then
    if v_self -> 'per' is not null then
      -- Count-scaled reduction (mig 416): `amount` less PER counted thing —
      -- Blasphemous Act ("{1} less for each creature on the battlefield"),
      -- Coastal Breach / Undaunted ("{1} less for each opponent").
      v_reduction := v_reduction
        + coalesce((v_self ->> 'amount')::integer, 1)
          * greatest(0, public.resolve_count_amount(p_session_id, p_caster, v_self -> 'per'));
    elsif v_self -> 'if' is not null then
      if public.resolve_count_amount(p_session_id, p_caster, v_self -> 'if')
         >= coalesce((v_self -> 'if' ->> 'at_least')::integer, 1)
      then
        v_reduction := v_reduction + coalesce((v_self ->> 'amount')::integer, 0);
      end if;
    else
      v_reduction := v_reduction + coalesce((v_self ->> 'amount')::integer, 0);
    end if;
  end if;

  -- The number of spells already cast by this player this turn — the spell being
  -- cast now is index (v_spells_cast + 1). Powers nth_spell reductions below.
  v_spells_cast := public.resolve_count_amount(
    p_session_id, p_caster, '{"count":"spells_cast_this_turn"}'::jsonb);

  -- Static reductions from the caster's battlefield permanents.
  select v_reduction + coalesce(sum(coalesce((ce.payload ->> 'amount')::integer, 0)), 0)
  into v_reduction
  from public.game_continuous_effects ce
  join public.game_cards sc on sc.id = ce.source_card_id and sc.zone = 'battlefield'
  where ce.session_id = p_session_id
    and ce.effect_type = 'cost_reduction'
    and ce.affected_player_id = p_caster
    and (
      coalesce(ce.payload ->> 'type_line', '') = ''
      or coalesce(v_type_line, '') ilike '%' || (ce.payload ->> 'type_line') || '%'
    )
    -- exclude_type_line (mig 437, Lyse Hext: "NONcreature spells you cast cost
    -- {1} less") — the negative twin of the type_line filter above.
    and (
      coalesce(ce.payload ->> 'exclude_type_line', '') = ''
      or coalesce(v_type_line, '') not ilike '%' || (ce.payload ->> 'exclude_type_line') || '%'
    )
    -- from_zone (mig 304, Emet-Selch): "spells you cast from your graveyard cost
    -- {2} less" — apply only when the card is being cast from that zone.
    and (
      coalesce(ce.payload ->> 'from_zone', '') = ''
      or coalesce(v_zone, '') = (ce.payload ->> 'from_zone')
    )
    -- nth_spell (mig 369, Alisaie's Dualcast): "the SECOND spell you cast each turn
    -- costs {2} less" — apply only to exactly the Kth spell, i.e. when this player
    -- has already cast K-1 spells this turn.
    and (
      coalesce(ce.payload ->> 'nth_spell', '') = ''
      or v_spells_cast = (ce.payload ->> 'nth_spell')::integer - 1
    )
    -- color (mig 391, Sapphire Medallion): "BLUE spells you cast cost {1} less" —
    -- full-word color (white/blue/black/red/green) matched against the cast
    -- card's colors, derived from its mana cost (card_color_set, mig 131).
    and (
      coalesce(ce.payload ->> 'color', '') = ''
      or (ce.payload ->> 'color') = any(public.card_color_set(coalesce(v_mana_cost, '')))
    );

  if v_reduction <= 0 then
    return v_cost;
  end if;

  -- Reduce the single generic token (regexp_replace without 'g' hits the first).
  v_generic := substring(v_cost from '\{(\d+)\}');
  if v_generic is null then
    return v_cost;
  end if;
  v_new := greatest(0, v_generic::integer - v_reduction);
  if v_new = 0 then
    return regexp_replace(v_cost, '\{\d+\}', '');
  else
    return regexp_replace(v_cost, '\{\d+\}', '{' || v_new || '}');
  end if;
end;
$$;
grant execute on function public.reduced_mana_cost(uuid, uuid, uuid, text) to authenticated;
grant execute on function public.reduced_mana_cost(uuid, uuid, uuid, text) to service_role;

create or replace function public.handle_counter_spell(
  p_session_id uuid,
  p_stack_item public.game_stack_items
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_stack_item public.game_stack_items;
  v_next_graveyard_position integer;
  v_cant_be_countered boolean := false;
  v_life_loss integer := 0;
  v_surveil integer := 0;
  v_unless_pays text;
  v_decision_id uuid;
begin
  select *
  into v_target_stack_item
  from public.game_stack_items
  where id = nullif(p_stack_item.payload ->> 'target_stack_item_id', '')::uuid
    and session_id = p_session_id
    and status = 'pending'
  for update;

  if found then
    if v_target_stack_item.id = p_stack_item.id then
      raise exception 'A stack item cannot counter itself';
    end if;

    -- Is the targeted spell uncounterable? Read its source card's behavior.
    if v_target_stack_item.source_card_id is not null then
      select coalesce((cards.script ->> 'cant_be_countered')::boolean, false)
      into v_cant_be_countered
      from public.game_cards
      join public.cards on cards.id = game_cards.card_id
      where game_cards.id = v_target_stack_item.source_card_id
        and game_cards.session_id = p_session_id;
    end if;

    -- unless_pays escape (mig 392, Mana Leak: "unless its controller pays {3}"):
    -- park a pay-or-be-countered decision for the TARGET spell's controller
    -- instead of countering outright; submit_decision pays (spell stands) or
    -- counters on decline. Note: unless_pays does not combine with the
    -- life-loss/surveil riders below (no card in the curated set needs both).
    if not coalesce(v_cant_be_countered, false) and p_stack_item.source_card_id is not null then
      select nullif(btrim(max(act ->> 'unless_pays')), '')
      into v_unless_pays
      from public.game_cards gc
      join public.cards c on c.id = gc.card_id
      cross join lateral jsonb_array_elements(coalesce(c.script -> 'spell_effect' -> 'actions', '[]'::jsonb)) as act
      where gc.id = p_stack_item.source_card_id
        and gc.session_id = p_session_id
        and lower(act ->> 'type') = 'counter';
    end if;
    if v_unless_pays is not null and v_target_stack_item.controller_player_id is not null then
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_target_stack_item.controller_player_id, p_stack_item.id, 'pay_or_be_countered',
        'Pay ' || v_unless_pays || ' or your spell is countered',
        '[]'::jsonb, 0, 0,
        jsonb_build_object('cost', v_unless_pays, 'target_stack_item_id', v_target_stack_item.id))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision' where id = p_stack_item.id;
      return jsonb_build_object('awaiting_decision', v_decision_id);
    end if;

    if not coalesce(v_cant_be_countered, false) then
      if v_target_stack_item.action_type = 'cast_permanent'
        and v_target_stack_item.source_card_id is not null
      then
        select coalesce(max(zone_position), -1) + 1
        into v_next_graveyard_position
        from public.game_cards
        where session_id = p_session_id
          and owner_id = v_target_stack_item.controller_player_id
          and zone = 'graveyard';

        update public.game_cards
        set
          zone = 'graveyard',
          zone_position = v_next_graveyard_position,
          is_tapped = false,
          damage_marked = 0
        where id = v_target_stack_item.source_card_id
          and session_id = p_session_id
          and owner_id = v_target_stack_item.controller_player_id
          and zone = 'stack';
      end if;

      update public.game_stack_items
      set
        status = 'cancelled',
        resolved_at = now()
      where id = v_target_stack_item.id;

      -- "Whenever a spell or ability you control counters a spell" (mig 437,
      -- Baral): broadcast the successful counter; the counterer is the actor.
      perform public.fire_watcher_triggers(
        p_session_id, p_stack_item.source_card_id, p_stack_item.controller_player_id,
        'spell_countered', null);
    end if;

    -- Life-loss rider (Undermine): the countered spell's controller loses N life.
    -- The amount is on the counter spell's own `counter` action; it applies even
    -- when the target can't be countered (the life loss is a separate instruction).
    if p_stack_item.source_card_id is not null then
      select coalesce(max((act ->> 'controller_loses_life')::integer), 0)
      into v_life_loss
      from public.game_cards gc
      join public.cards c on c.id = gc.card_id
      cross join lateral jsonb_array_elements(coalesce(c.script -> 'spell_effect' -> 'actions', '[]'::jsonb)) as act
      where gc.id = p_stack_item.source_card_id
        and gc.session_id = p_session_id
        and lower(act ->> 'type') = 'counter';
    end if;

    if coalesce(v_life_loss, 0) > 0 and v_target_stack_item.controller_player_id is not null then
      update public.game_session_players
      set life_total = greatest(0, life_total - v_life_loss)
      where session_id = p_session_id
        and player_id = v_target_stack_item.controller_player_id;
      perform public.maybe_finish_game_session(p_session_id);
    end if;

    -- Surveil rider (mig 204, Sinister Sabotage "Counter target spell. Surveil 1"):
    -- read symmetrically from the counter spell's own `counter` action and enqueue
    -- as a triggered ability for the COUNTER's caster — the trigger machinery
    -- parks the surveil decision (the source instant being in the graveyard is
    -- fine; the label/effects ride in the payload). Applies even when the target
    -- can't be countered, like the life-loss rider.
    if p_stack_item.source_card_id is not null then
      select coalesce(max((act ->> 'surveil')::integer), 0)
      into v_surveil
      from public.game_cards gc
      join public.cards c on c.id = gc.card_id
      cross join lateral jsonb_array_elements(coalesce(c.script -> 'spell_effect' -> 'actions', '[]'::jsonb)) as act
      where gc.id = p_stack_item.source_card_id
        and gc.session_id = p_session_id
        and lower(act ->> 'type') = 'counter';
    end if;

    if coalesce(v_surveil, 0) > 0 and p_stack_item.controller_player_id is not null then
      perform public.enqueue_triggered_ability(
        p_session_id, p_stack_item.controller_player_id, p_stack_item.source_card_id,
        'Surveil ' || v_surveil,
        jsonb_build_array(jsonb_build_object('type', 'surveil', 'amount', v_surveil)));
    end if;
  end if;

  return null;
end;
$$;

create or replace function public.fire_watcher_triggers(
  p_session_id uuid,
  p_changed_card_id uuid,
  p_changed_controller uuid,
  p_event text,
  -- Event context merged onto the enqueued trigger's payload (mig 260,
  -- Wrathful Raptors: creature_damaged carries event_amount).
  p_extra jsonb default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changed_type text;
  v_changed_mv integer;
  v_changed_mana_cost text;
  v_changed_is_token boolean;
  v_changed_is_changeling boolean := false;
  v_f_match text;
  v_watcher record;
  v_ability jsonb;
  v_filter jsonb;
  v_f_type text;
  v_f_controller text;
  v_exclude_self boolean;
  v_ctrl_ok boolean;
  v_once_key text;
begin
  -- Per-turn spell-cast tally (Alisaie's Dualcast: "the second spell you cast each
  -- turn costs {2} less"). spell_cast fires once per cast with the caster as
  -- p_changed_controller; bot/system casts pass a null caster and are skipped.
  if p_event = 'spell_cast' and p_changed_controller is not null then
    perform public.note_spell_cast(p_session_id, p_changed_controller);
  end if;

  -- Token at either level: catalog tokens (cards.is_token) or copy tokens
  -- (game_cards.is_token, mig 239).
  select cards.type_line, public.mana_value(cards.mana_cost), cards.mana_cost,
         coalesce(cards.is_token, false) or coalesce(gc.is_token, false)
  into v_changed_type, v_changed_mv, v_changed_mana_cost, v_changed_is_token
  from public.game_cards gc
  join public.cards on cards.id = gc.card_id
  where gc.id = p_changed_card_id and gc.session_id = p_session_id;

  -- Type-changing layer (mig 407): fold granted_type continuous effects into
  -- the changed permanent's type for tribal/type-specific watchers (a permanent
  -- that "is an Assassin" / became a Land counts as such). Only for permanent
  -- events — a spell on the stack (cast events) has no battlefield granted types,
  -- and effective_type_line returns the base type there anyway.
  if p_event not in ('spell_cast', 'cast_from_exile') then
    v_changed_type := coalesce(public.effective_type_line(p_session_id, p_changed_card_id), v_changed_type);
    -- Changeling (mig 408, Mirror Entity): "is every creature type". Can't be a
    -- string (~250 subtypes), so a tribal type filter matches a changeling for
    -- any CREATURE type (see the type-filter match below). Only battlefield
    -- permanents — a spell on the stack has no changeling continuous effect.
    v_changed_is_changeling := exists (
      select 1 from public.game_continuous_effects ce
      join public.game_cards src on src.id = ce.source_card_id and src.session_id = ce.session_id
      where ce.session_id = p_session_id and ce.effect_type = 'granted_type'
        and ce.affected_card_id = p_changed_card_id and src.zone = 'battlefield'
        and coalesce((ce.payload ->> 'changeling')::boolean, false))
      or exists (
        select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.id = p_changed_card_id and gc.session_id = p_session_id
          and c.keywords::text ilike '%changeling%');
  end if;

  -- Adventure faces (mig 388, bug-1513): a spell on the stack has ONLY the cast
  -- face's characteristics. The full dual type_line ("Creature - X // Instant -
  -- Adventure") made Swift End count as a CREATURE spell, so noncreature
  -- watchers (Y'shtola) never fired; and the printed mana value leaked into
  -- adventure casts (Stomp is MV 2, not Bonecrusher's 3).
  if p_event in ('spell_cast', 'cast_from_exile') and v_changed_type like '% // %' then
    if coalesce(p_extra ->> 'adventure_face', 'false') = 'true' then
      select split_part(c.type_line, ' // ', 2),
             coalesce(public.mana_value(c.script -> 'adventure' ->> 'cost'), v_changed_mv),
             coalesce(c.script -> 'adventure' ->> 'cost', v_changed_mana_cost)
        into v_changed_type, v_changed_mv, v_changed_mana_cost
        from public.game_cards gc
        join public.cards c on c.id = gc.card_id
       where gc.id = p_changed_card_id and gc.session_id = p_session_id;
    else
      v_changed_type := split_part(v_changed_type, ' // ', 1);
    end if;
  end if;

  for v_watcher in
    select gc.id, coalesce(gc.controller_player_id, gc.owner_id) as controller, c.name as card_name,
           gc.attached_to
    from public.game_cards gc
    join public.cards c on c.id = gc.card_id
    where gc.session_id = p_session_id
      -- Watchers are permanents already on the battlefield. The changed card is
      -- also allowed to watch its OWN event (e.g. a creature reacting to its own
      -- tap/attack) — EXCEPT for cast events: a spell being cast is on the stack,
      -- not yet on the battlefield, so it must not trigger its own "whenever you
      -- cast …" ability (mig 325, Bygone Bishop casting itself).
      and (
        gc.zone = 'battlefield'
        or (gc.id = p_changed_card_id and p_event not in ('spell_cast', 'cast_from_exile'))
      )
    order by gc.controller_player_id, gc.id
  loop
    for v_ability in
      select * from jsonb_array_elements(
        coalesce(public.effective_script(p_session_id, v_watcher.id) -> 'triggered_abilities', '[]'::jsonb))
    loop
      if lower(coalesce(v_ability ->> 'event', '')) <> p_event then
        continue;
      end if;

      -- Mode gate (mig 245, Frontier Siege Dragons mode): see fire_card_triggers.
      if (v_ability ? 'mode')
         and (v_ability ->> 'mode') is distinct from (v_ability ->> 'chosen') then
        continue;
      end if;

      -- "This ability triggers only once each turn" (mig 253, Pantlaza). Keyed
      -- per ABILITY (mig 301) by its `id` so a card with two once-per-turn
      -- watchers — Champions from Beyond's Light Party (4+) and Full Party (8+) —
      -- stamps each independently. The CHECK (skip if already stamped) is here;
      -- the STAMP is deferred to just before enqueue, so it only fires when the
      -- ability actually triggers (after the attacker-count/other filters pass).
      if coalesce((v_ability ->> 'once_per_turn')::boolean, false) then
        v_once_key := 'watcher_once_turn_' || coalesce(v_ability ->> 'id', v_ability ->> 'event', '');
        if (select gc2.counters ->> v_once_key
            from public.game_cards gc2 where gc2.id = v_watcher.id)
           = (select ts.turn_number::text from public.game_turn_state ts
              where ts.session_id = p_session_id) then
          continue;
        end if;
      end if;

      v_filter := v_ability -> 'filter';
      v_f_type := v_filter ->> 'type_line';
      v_f_controller := lower(coalesce(v_filter ->> 'controller', 'you'));
      v_exclude_self := coalesce((v_filter ->> 'exclude_self')::boolean, false);

      -- "another …": skip when the changed card IS the watcher.
      if v_exclude_self and v_watcher.id = p_changed_card_id then
        continue;
      end if;

      -- "whenever EQUIPPED creature dies" (mig 267, Skullclamp): only fire
      -- when the event subject is the permanent this watcher is attached to.
      if coalesce((v_filter ->> 'attached_host')::boolean, false)
         and v_watcher.attached_to is distinct from p_changed_card_id then
        continue;
      end if;

      -- "whenever a COMMANDER you control enters or attacks" (mig 274,
      -- Norn's Choirmaster): the event subject must be a commander.
      if coalesce((v_filter ->> 'commander')::boolean, false)
         and not exists (
           select 1 from public.game_cards gc2
           where gc2.id = p_changed_card_id and gc2.session_id = p_session_id
             and gc2.is_commander = true
         ) then
        continue;
      end if;

      -- "nontoken …": skip when the changed creature is a token.
      if coalesce((v_filter ->> 'nontoken')::boolean, false) and v_changed_is_token then
        continue;
      end if;

      -- "whenever a creature TOKEN …" (mig 280, Twilight Drover): only tokens.
      if coalesce((v_filter ->> 'token')::boolean, false) and not v_changed_is_token then
        continue;
      end if;

      -- "with power N or less" (mig 280, Mentor of the Meek).
      if v_filter ? 'max_power'
         and coalesce(public.card_effective_power(p_session_id, p_changed_card_id), 99)
             > (v_filter ->> 'max_power')::integer then
        continue;
      end if;

      -- "if it isn't being declared as an attacker" (mig 283, Rhoda / Verity
      -- Circle): skip taps that come from an attack declaration —
      -- declare_attacker inserts the combat assignment BEFORE tapping.
      if coalesce((v_filter ->> 'not_attacking')::boolean, false)
         and exists (
           select 1 from public.game_combat_assignments ca
           where ca.session_id = p_session_id
             and ca.attacker_card_id = p_changed_card_id
         ) then
        continue;
      end if;

      -- "whenever a GOADED creature attacks" (mig 249, Vengeful Ancestor):
      -- only fire when the event subject carries an active goaded row.
      if coalesce((v_filter ->> 'goaded')::boolean, false)
         and not exists (
           select 1 from public.game_continuous_effects ce
           where ce.session_id = p_session_id
             and ce.effect_type = 'goaded'
             and ce.affected_card_id = p_changed_card_id
         ) then
        continue;
      end if;

      -- Type filter: default "creature" for permanent watchers; spell_cast
      -- (Taurean Mauler) matches a SPELL of any type; land_entered (Nesting
      -- Dragon landfall) defaults to 'land' so only land entries match;
      -- ability_activated (mig 258, Runic Armasaur) defaults to '' — any
      -- permanent whose non-mana ability was activated.
      v_f_match := coalesce(v_f_type,
           case p_event when 'spell_cast' then '' when 'cast_from_exile' then ''
                        when 'land_entered' then 'land'
                        when 'ability_activated' then ''
                        when 'permanent_sacrificed' then ''
                        when 'token_created' then ''
                        when 'card_drawn' then ''
                        -- spell_countered (mig 437, Baral): the event subject is
                        -- the countering spell/source, any type.
                        when 'spell_countered' then ''
                        else 'creature' end);
      -- A changeling (mig 408) matches any CREATURE-type filter: skip only when
      -- neither the effective type line matches NOR (it is a changeling and the
      -- filter names a creature type — i.e. not a card type / supertype / known
      -- noncreature subtype, which the base ilike already handles or excludes).
      if v_changed_type not ilike '%' || v_f_match || '%'
         and not (v_changed_is_changeling and v_f_match <> ''
                  and lower(v_f_match) not in (
                    'artifact','creature','enchantment','land','planeswalker','instant','sorcery',
                    'battle','tribal','kindred','basic','legendary','snow','world',
                    'aura','equipment','vehicle','saga','shrine','curse','background','class','role',
                    'food','treasure','clue','blood','gold','powerstone','map','incubator','adventure')) then
        continue;
      end if;

      -- Negative type filter (mig 292): "whenever you cast a NONCREATURE spell"
      -- (the magecraft/spellcraft payoffs — Y'shtola, Archmage Emeritus, Hermes,
      -- Papalymo, …), and any other "non-<type>" watcher. Skip when the changed
      -- card's type line MATCHES exclude_type. Complements the positive type
      -- filter above (which has no way to express exclusion).
      if v_filter ? 'exclude_type'
         and v_changed_type ilike '%' || (v_filter ->> 'exclude_type') || '%' then
        continue;
      end if;

      -- Mana-value filter (mig 293): "whenever you cast a noncreature spell with
      -- mana value N or greater" (Y'shtola, Night's Blessed). For spell_cast,
      -- reads the cast card's mana value (lands/tokens = 0).
      if v_filter ? 'min_mana_value'
         and coalesce(v_changed_mv, 0) < (v_filter ->> 'min_mana_value')::integer then
        continue;
      end if;

      -- Colour filter (mig 299): "whenever you cast a WHITE/BLACK spell" (Ardbert).
      -- A spell is that colour if its mana cost contains the colour symbol.
      if v_filter ? 'spell_color'
         and coalesce(v_changed_mana_cost, '') not ilike '%' || upper(v_filter ->> 'spell_color') || '%' then
        continue;
      end if;

      -- Power filter (mig 225): "a creature with power N or greater enters"
      -- (Elemental Bond, Temur Ascendancy). Reads the changed card's effective
      -- power; non-creatures (no P/T) never qualify.
      if v_filter ? 'min_power'
         and coalesce(public.card_effective_power(p_session_id, p_changed_card_id), -1)
             < (v_filter ->> 'min_power')::integer then
        continue;
      end if;

      -- Keyword filter (mig 227): "a creature you control WITH FLYING enters"
      -- (Dragon Tempest). Only 'flying' is supported (the common case). At the
      -- entry instant the granted-flying row isn't registered yet (the resolver
      -- registers AFTER the move), so check INTRINSIC flying — the card's own
      -- keywords or a source-scoped flying continuous effect — OR an already
      -- registered grant.
      if lower(coalesce(v_filter ->> 'has_keyword', '')) = 'flying'
         and not (
           public.card_has_flying(p_session_id, p_changed_card_id)
           or exists (
             select 1
             from public.game_cards gc
             left join public.cards c on c.id = gc.card_id
             where gc.id = p_changed_card_id and gc.session_id = p_session_id
               and (
                 coalesce(c.keywords::text, '') ilike '%flying%'
                 or exists (
                   select 1
                   from jsonb_array_elements(
                     coalesce(public.effective_script(p_session_id, gc.id) -> 'continuous_effects', '[]'::jsonb)) e
                   where lower(coalesce(e ->> 'type', e ->> 'effect_type', '')) = 'flying'
                     and coalesce(e ->> 'affected', 'source') in ('source', 'this')
                 )
               )
           )
         ) then
        continue;
      end if;

      -- Controller filter, relative to the WATCHER's controller.
      v_ctrl_ok := case v_f_controller
        when 'you' then p_changed_controller = v_watcher.controller
        when 'opponent' then p_changed_controller is distinct from v_watcher.controller
        else true
      end;
      if not v_ctrl_ok then
        continue;
      end if;

      -- "your second spell each turn" (mig 372, Alphinaud's Eukrasia): fire only
      -- when the cast spell is exactly the Nth the controller has cast this turn.
      -- note_spell_cast (top of this fn) already counted THIS cast, so the 2nd
      -- spell reads 2. Pairs with the spells_cast_this_turn counter (mig 369).
      if v_filter ? 'spell_number'
         and public.resolve_count_amount(p_session_id, p_changed_controller,
               '{"count":"spells_cast_this_turn"}'::jsonb)
             <> (v_filter ->> 'spell_number')::integer then
        continue;
      end if;

      -- "your SECOND/THIRD card each turn" (mig 401, Ethereal Investigator /
      -- Astrologian's Planisphere): the draw site passes the 1-based per-turn
      -- index as p_extra.draw_number; fire only on the exact Nth draw.
      if v_filter ? 'draw_number'
         and coalesce((p_extra ->> 'draw_number')::integer, 0)
             <> (v_filter ->> 'draw_number')::integer then
        continue;
      end if;

      -- "if it isn't that player's turn" (mig 401, Tataru Taru's Scions'
      -- Secretary): the event's subject player must not be the active player.
      if coalesce((v_filter ->> 'off_turn')::boolean, false)
         and exists (
           select 1 from public.game_turn_state ts
           where ts.session_id = p_session_id
             and ts.active_player_id = p_changed_controller
         ) then
        continue;
      end if;

      -- Attacker-count filter (mig 301): "whenever you attack with N or more
      -- creatures" (Champions from Beyond's Light/Full Party). Counts the
      -- attacking player's declared attackers this combat; the per-ability
      -- once_per_turn stamp keeps it to a single fire once the threshold is met.
      if v_filter ? 'attackers_at_least'
         and (select count(*) from public.game_combat_assignments ca
              where ca.session_id = p_session_id
                and ca.attacking_player_id = p_changed_controller)
             < (v_filter ->> 'attackers_at_least')::integer then
        continue;
      end if;

      -- Deferred once_per_turn stamp: now that every filter has passed, mark the
      -- ability fired this turn so it doesn't re-trigger on later attackers.
      if coalesce((v_ability ->> 'once_per_turn')::boolean, false) then
        v_once_key := 'watcher_once_turn_' || coalesce(v_ability ->> 'id', v_ability ->> 'event', '');
        update public.game_cards gc2
        set counters = coalesce(gc2.counters, '{}'::jsonb)
              || jsonb_build_object(v_once_key,
                   (select ts.turn_number::text from public.game_turn_state ts
                    where ts.session_id = p_session_id))
        where gc2.id = v_watcher.id;
      end if;

      perform public.enqueue_triggered_ability(
        p_session_id, v_watcher.controller, v_watcher.id,
        coalesce(v_watcher.card_name, p_event), v_ability -> 'effects',
        p_changed_card_id,  -- the triggering creature, for reflexive "it gains …"
        p_extra
      );
    end loop;
  end loop;
end;
$$;
grant execute on function public.fire_watcher_triggers(uuid, uuid, uuid, text, jsonb) to authenticated;
grant execute on function public.fire_watcher_triggers(uuid, uuid, uuid, text, jsonb) to service_role;

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
  v_goader uuid;
  v_goad_players integer;
  v_turn integer;
  v_options jsonb;
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
        -- Corrupted per-opponent gate (mig 436, Feed the Infection / Phyrexian
        -- Atlas: "each opponent WHO HAS three or more poison counters") — keep
        -- only recipients whose own poison count meets the filter, instead of
        -- gating the whole effect on the table maximum.
        if (v_effect -> 'recipient_filter' ->> 'poison_at_least') is not null then
          select array_agg(sp.player_id) into v_recipients
          from public.game_session_players sp
          where sp.session_id = p_session_id
            and sp.player_id = any(coalesce(v_recipients, array[]::uuid[]))
            and coalesce((sp.counters ->> 'poison')::integer, 0)
                >= (v_effect -> 'recipient_filter' ->> 'poison_at_least')::integer;
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

    elsif v_eff_type = 'grant_type' then
      -- Nogi (mig 437): "until end of turn, ~ becomes a Dragon ..." — an
      -- until-EOT granted_type ADD on the source; effective_type_line folds it
      -- into every type-matters check.
      if p_source_card_id is not null and nullif(v_effect ->> 'type_line', '') is not null then
        insert into public.game_continuous_effects (
          session_id, source_card_id, affected_card_id, effect_type, payload,
          source_zone_required, expires_at_phase, expires_at_step)
        values (
          p_session_id, p_source_card_id, p_source_card_id, 'granted_type',
          jsonb_build_object('add', v_effect ->> 'type_line'),
          'battlefield', 'ending', 'cleanup');
      end if;

    elsif v_eff_type = 'goad_all' then
      -- Geode Rager (mig 436): "goad each creature target player controls" —
      -- runs nested under choose_player, so p_controller_id is the CHOSEN
      -- player; the goader is the SOURCE card's current controller. Mirrors
      -- the single-target goad rows (apply_creature_effect): expiry = before
      -- the goader's next turn.
      select coalesce(gc.controller_player_id, gc.owner_id) into v_goader
      from public.game_cards gc
      where gc.id = p_source_card_id and gc.session_id = p_session_id;
      select turn_number into v_turn from public.game_turn_state where session_id = p_session_id;
      select count(*) into v_goad_players from public.game_session_players where session_id = p_session_id;
      for v_rid in
        select gc.id from public.game_cards gc
        join public.cards c on c.id = gc.card_id
        where gc.session_id = p_session_id and gc.zone = 'battlefield'
          and coalesce(gc.controller_player_id, gc.owner_id) = p_controller_id
          and c.type_line ilike '%creature%'
      loop
        insert into public.game_continuous_effects (
          session_id, source_card_id, affected_card_id, effect_type, payload, expires_at_turn_number)
        values (
          p_session_id, coalesce(p_source_card_id, v_rid), v_rid, 'goaded',
          jsonb_build_object('goaded_by', v_goader),
          coalesce(v_turn, 0) + greatest(1, coalesce(v_goad_players, 2) - 1));
      end loop;

    elsif v_eff_type = 'corrupted_summons' then
      -- Geth's Summons (mig 436): "for each opponent who has three or more
      -- poison counters, put up to one target creature card from that player's
      -- graveyard onto the battlefield under your control." One STACK-LESS
      -- pick per corrupted opponent with creature cards in their graveyard
      -- (pass_priority freezes on pending decisions; submit_decision's
      -- corrupted_summons_pick branch does the reanimate).
      for v_rid in
        select sp.player_id from public.game_session_players sp
        where sp.session_id = p_session_id
          and sp.player_id is distinct from p_controller_id
          and coalesce((sp.counters ->> 'poison')::integer, 0) >= 3
      loop
        select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gc.id, 'name', c.name) order by c.name, gc.id), '[]'::jsonb)
          into v_options
        from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.session_id = p_session_id and gc.owner_id = v_rid and gc.zone = 'graveyard'
          and c.type_line ilike '%creature%';
        if jsonb_array_length(v_options) > 0 then
          insert into public.game_pending_decisions (
            session_id, deciding_player_id, source_stack_item_id, decision_type,
            prompt, options, min_choices, max_choices, params)
          values (
            p_session_id, p_controller_id, null, 'corrupted_summons_pick',
            'Corrupted — put up to one creature from that graveyard onto the battlefield',
            v_options, 0, 1, jsonb_build_object('from_player', v_rid));
        end if;
      end loop;

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
