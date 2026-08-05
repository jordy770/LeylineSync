-- 202605010441_mana_riders
-- Bucket-8-slice (mana-ability-riders):
-- - Mana abilities honoreren nu een activation `condition` (Glistening
--   Sphere's corrupted mana), gespiegeld aan activate_ability's gate.
-- - Card-scoped pump-statics dragen een payload `condition` die de layered
--   P/T-fold live evalueert (Drover of the Mighty: "+2/+2 as long as you
--   control a Dinosaur").
-- - Nieuwe targeted effect remove_from_combat (Labyrinth of Skophos):
--   verwijdert de attack-assignment / onthecht een blocker; nieuwe
--   registry-row hieronder.
-- - Nieuwe ETB-effect sacrifice_unless_pay (Rupture Spire, Transguild
--   Promenade): pay-or-sacrifice-decision.
-- Elves of Deep Shadow werd script-only via mig 438's self_damage; Coveted
-- Jewel blijft open (unblocked-attackers-watcher + controlewissel).

-- remove_from_combat_creature in het stack-action-register (tap_creature-
-- plumbing: zelfde builder + handler) én in de action_type-CHECK (herbouwd
-- van de huidige lijst + de nieuwe waarde — bug-283-regel).
alter table public.game_stack_items
  drop constraint if exists game_stack_items_action_type_check;
alter table public.game_stack_items
  add constraint game_stack_items_action_type_check
  check (action_type = any (array[
    'deal_damage_player', 'deal_damage_creature', 'pump_creature', 'cast_permanent',
    'counter_spell', 'triggered_ability', 'draw_cards', 'destroy_creature',
    'bounce_creature', 'tap_creature', 'untap_creature', 'add_counters_creature',
    'exile_creature', 'grant_keyword_creature', 'gain_control_creature',
    'fight_creatures', 'modal_spell', 'scry', 'surveil', 'spell_effect',
    'multi_creature_effect', 'permanent_effect', 'divided_damage', 'set_pt_creature',
    'exile_from_graveyard', 'reanimate_from_graveyard', 'remove_from_combat_creature'
  ]));

insert into public.stack_action_handlers (action_type, builder_fn, handler_fn)
values ('remove_from_combat_creature', 'build_stack_payload_creature_simple', 'handle_creature_effect')
on conflict (action_type) do nothing;
-- Generated from supabase/functions_src (activate_mana_ability, card_layered_power, card_layered_toughness, activate_ability, apply_creature_effect, apply_trigger_effects, submit_decision) — those files are
-- the canonical current definitions; edit them, not past migrations.

create or replace function public.activate_mana_ability(
  p_session_id uuid,
  p_source_card_id uuid,
  p_ability_index integer default 0,
  p_generic_payment jsonb default null,
  -- The colour chosen for an "any colour" producer (Treasure, mig 226).
  p_chosen_color text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_zone text;
  v_script jsonb;
  v_ability jsonb;
  v_cost jsonb;
  v_effect jsonb;
  v_has_tap boolean := false;
  v_has_sac boolean := false;
  v_mana_cost text := null;
  v_life_cost integer := 0;
  v_self_damage integer := 0;
  v_player_life integer;
  v_color text;
  v_amount integer;
  v_pool jsonb;
  -- Restricted ("spend only") mana: an add_mana effect may carry a `restriction`
  -- ({spell_type_line?, ability_source_type_line?, commander?}); such mana goes
  -- to game_players.restricted_mana instead of the open pool.
  v_restricted jsonb;
  v_restriction jsonb;
  v_produced_restricted boolean := false;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
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
    raise exception 'Mana ability source must be on the battlefield';
  end if;

  v_script := public.effective_script(p_session_id, p_source_card_id);
  v_ability := v_script -> 'activated_abilities' -> p_ability_index;
  if v_ability is null then
    raise exception 'Activated ability not found at index %', p_ability_index;
  end if;
  if not coalesce((v_ability ->> 'is_mana_ability')::boolean, false) then
    raise exception 'Not a mana ability';
  end if;

  -- Activation condition (mig 441, Glistening Sphere's corrupted mana:
  -- "Activate only if an opponent has three or more poison counters") —
  -- mirrors activate_ability's gate.
  if v_ability -> 'condition' is not null then
    if public.resolve_dynamic_amount(p_session_id, p_source_card_id, auth.uid(), v_ability -> 'condition')
       < coalesce((v_ability -> 'condition' ->> 'at_least')::integer, 1)
    then
      raise exception 'This ability cannot be activated right now';
    end if;
  end if;

  -- Parse costs (tap_self / mana / pay_life / self_damage).
  for v_cost in select * from jsonb_array_elements(coalesce(v_ability -> 'costs', '[]'::jsonb))
  loop
    case v_cost ->> 'type'
      when 'tap_self' then v_has_tap := true;
      when 'sacrifice_self' then v_has_sac := true;
      when 'mana' then v_mana_cost := v_cost ->> 'amount';
      when 'pay_life' then v_life_cost := greatest(0, coalesce((v_cost ->> 'amount')::integer, 0));
      -- self_damage (mig 438, pain lands / talismans: "this land deals 1
      -- damage to you") — real DAMAGE through apply_damage_to_player below,
      -- so prevention shields and damage statics apply, unlike pay_life.
      when 'self_damage' then v_self_damage := greatest(0, coalesce((v_cost ->> 'amount')::integer, 0));
      else raise exception 'Unsupported mana-ability cost: %', v_cost ->> 'type';
    end case;
  end loop;

  if v_has_tap and exists (
    select 1 from public.game_cards where id = p_source_card_id and is_tapped = true
  ) then
    raise exception 'Source is already tapped';
  end if;

  -- Life cost (CR 119.4): the player must have at least that much life to pay it.
  if v_life_cost > 0 then
    select life_total into v_player_life
    from public.game_session_players
    where session_id = p_session_id and player_id = auth.uid();
    if coalesce(v_player_life, 0) < v_life_cost then
      raise exception 'Not enough life to pay % life (have %)', v_life_cost, coalesce(v_player_life, 0);
    end if;
  end if;

  -- Pay the activation mana cost (the {1}) BEFORE producing.
  if v_mana_cost is not null and btrim(v_mana_cost) <> '' then
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_mana_cost, p_generic_payment);
  end if;

  -- Pay the life cost.
  if v_life_cost > 0 then
    update public.game_session_players
    set life_total = life_total - v_life_cost
    where session_id = p_session_id and player_id = auth.uid();
  end if;

  -- Self-damage rider (mig 438): dealt as damage, not paid as life.
  if v_self_damage > 0 then
    perform public.apply_damage_to_player(
      p_session_id, auth.uid(), v_self_damage, p_source_card_id, false);
  end if;

  if v_has_tap then
    update public.game_cards
    set is_tapped = true
    where id = p_source_card_id and session_id = p_session_id;
  end if;

  -- Ensure a pool row exists, then add every add_mana effect's mana.
  insert into public.game_players (session_id, player_id, mana_pool)
  values (p_session_id, auth.uid(), jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0))
  on conflict (session_id, player_id) do nothing;

  select coalesce(mana_pool, jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0)),
         coalesce(restricted_mana, '[]'::jsonb)
  into v_pool, v_restricted
  from public.game_players
  where session_id = p_session_id and player_id = auth.uid()
  for update;

  for v_effect in select * from jsonb_array_elements(coalesce(v_ability -> 'effects', '[]'::jsonb))
  loop
    if lower(coalesce(v_effect ->> 'type', '')) = 'add_mana' then
      v_color := upper(coalesce(v_effect ->> 'color', 'C'));
      -- "Any colour" (Treasure, mig 226): the caller picks the colour.
      if v_color = 'ANY' then
        v_color := upper(coalesce(p_chosen_color, ''));
        if v_color not in ('W', 'U', 'B', 'R', 'G', 'C') then
          raise exception 'Choose a colour for this mana ability';
        end if;
      elsif v_color not in ('W', 'U', 'B', 'R', 'G', 'C') then
        raise exception 'A multi-mana ability must produce fixed colours (got %)', v_color;
      end if;
      v_amount := greatest(1, coalesce((v_effect ->> 'amount')::integer, 1));
      v_restriction := v_effect -> 'restriction';
      if v_restriction is not null and jsonb_typeof(v_restriction) = 'object' then
        -- "Spend only to cast …": stash as restricted mana, not open mana.
        v_produced_restricted := true;
        v_restricted := v_restricted || jsonb_build_array(
          jsonb_build_object('color', v_color, 'amount', v_amount) || v_restriction);
      else
        v_pool := v_pool || jsonb_build_object(v_color, coalesce((v_pool ->> v_color)::integer, 0) + v_amount);
      end if;
    end if;
  end loop;

  -- Monarch land bonus (mig 262, Regal Behemoth: "whenever you tap a land for
  -- mana while you're the monarch, add an additional one mana of any color").
  -- Approximations: the bonus is one mana of the colour this ability just
  -- produced (no separate colour pick), once per activation.
  if v_color is not null
     and v_has_tap
     and not v_produced_restricted
     and exists (select 1 from public.game_turn_state ts
                 where ts.session_id = p_session_id and ts.monarch_player_id = auth.uid())
     and exists (select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
                 where gc.id = p_source_card_id and gc.session_id = p_session_id
                   and c.type_line ilike '%land%')
     and exists (select 1 from public.game_cards gc
                 where gc.session_id = p_session_id and gc.zone = 'battlefield'
                   and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
                   and coalesce((public.effective_script(p_session_id, gc.id) ->> 'monarch_land_bonus')::boolean, false))
  then
    v_pool := v_pool || jsonb_build_object(v_color, coalesce((v_pool ->> v_color)::integer, 0) + 1);
  end if;

  update public.game_players
  set mana_pool = v_pool,
      restricted_mana = v_restricted
  where session_id = p_session_id and player_id = auth.uid();

  -- Sacrifice cost (mig 226, Treasure): the source goes to the graveyard after
  -- producing — a token then ceases to exist via the usual cleanup trigger.
  if v_has_sac then
    perform public.put_in_graveyard(p_session_id, p_source_card_id);
  end if;

  return v_pool;
end;
$$;
grant execute on function public.activate_mana_ability(uuid, uuid, integer, jsonb, text) to authenticated;

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
          -- Conditional static (mig 441, Drover of the Mighty: "+2/+2 as long
          -- as you control a Dinosaur") — evaluated live per read against the
          -- source's controller.
          and (effects.payload -> 'condition' is null
               or public.resolve_count_amount(
                    p_session_id,
                    coalesce(source_card.controller_player_id, source_card.owner_id),
                    effects.payload -> 'condition')
                  >= coalesce((effects.payload -> 'condition' ->> 'at_least')::integer, 1))
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
          -- Tribal anthem type filter honors the type-changing layer (mig 409):
          -- a changeling / granted-type creature gets a lord's bonus.
          and (effects.payload ->> 'creature_type' is null
               or case when coalesce((effects.payload ->> 'exclude_type')::boolean, false)
                    then not public.card_has_creature_type(p_session_id, game_cards.id, effects.payload ->> 'creature_type')
                    else public.card_has_creature_type(p_session_id, game_cards.id, effects.payload ->> 'creature_type')
                  end)
          and (coalesce((effects.payload ->> 'exclude_source')::boolean, false) = false
               or game_cards.id <> effects.source_card_id)
          -- Commander-only anthem (Dancer's Chakrams: "other commanders you
          -- control get +2/+2"). Limits the pump to commanders the source's
          -- controller controls, excluding the equipped creature ("other").
          and (effects.payload ->> 'commander_only' is null
               or (game_cards.is_commander
                   and game_cards.id is distinct from source_card.attached_to))
          -- Colour-filtered anthem (mig 209, Heraldic Banner): only creatures
          -- of the payload colour get the pump.
          -- Conditional anthem (mig 269, Jor Kadeen metalcraft: '+3/+0 as long
          -- as you control three or more artifacts'). Read-time gate against
          -- the SOURCE's controller.
          and (effects.payload ->> 'condition_count' is null
               or public.resolve_count_amount(p_session_id,
                    coalesce(source_card.controller_player_id, source_card.owner_id),
                    jsonb_build_object('count', effects.payload ->> 'condition_count'),
                    effects.source_card_id)
                  >= coalesce((effects.payload ->> 'condition_at_least')::integer, 1))
          -- Conditional anthem on the source controller's library top card colour
          -- (Vampire Nocturnus, mig 342: "as long as the top card is black").
          and (effects.payload ->> 'condition_top_card_color' is null
               or public.library_top_is_color(p_session_id,
                    coalesce(source_card.controller_player_id, source_card.owner_id),
                    effects.payload ->> 'condition_top_card_color'))
          and (effects.payload ->> 'color' is null
               or public.card_color_set(cards.mana_cost) @> array[lower(effects.payload ->> 'color')])
      ), 0)

    + coalesce((
        -- Dynamic pump (mig 267, Cranial Plating / Bonehoard): payload
        -- power_count names a count resolved against the SOURCE's controller
        -- at read time (artifacts_you_control, creature_cards_all_graveyards).
        select sum(public.resolve_count_amount(
                 p_session_id,
                 coalesce(source_card.controller_player_id, source_card.owner_id),
                 jsonb_build_object('count', effects.payload ->> 'power_count'),
                 effects.source_card_id))
        from public.game_continuous_effects effects
        left join public.game_cards source_card
          on source_card.id = effects.source_card_id
        where effects.session_id = p_session_id
          and effects.effect_type = 'pump'
          and effects.affected_card_id = p_game_card_id
          and effects.payload ? 'power_count'
          and (effects.source_zone_required is null or source_card.zone = effects.source_zone_required)
      ), 0)
  from public.game_cards
  join public.cards on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id;
$$;
grant execute on function public.card_layered_power(uuid, uuid) to authenticated;
grant execute on function public.card_layered_power(uuid, uuid) to service_role;

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
          -- Conditional static (mig 441, Drover of the Mighty) — mirrors the
          -- power fold.
          and (effects.payload -> 'condition' is null
               or public.resolve_count_amount(
                    p_session_id,
                    coalesce(source_card.controller_player_id, source_card.owner_id),
                    effects.payload -> 'condition')
                  >= coalesce((effects.payload -> 'condition' ->> 'at_least')::integer, 1))
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
          -- Tribal anthem type filter honors the type-changing layer (mig 409):
          -- a changeling / granted-type creature gets a lord's bonus.
          and (effects.payload ->> 'creature_type' is null
               or case when coalesce((effects.payload ->> 'exclude_type')::boolean, false)
                    then not public.card_has_creature_type(p_session_id, game_cards.id, effects.payload ->> 'creature_type')
                    else public.card_has_creature_type(p_session_id, game_cards.id, effects.payload ->> 'creature_type')
                  end)
          and (coalesce((effects.payload ->> 'exclude_source')::boolean, false) = false
               or game_cards.id <> effects.source_card_id)
          -- Commander-only anthem (Dancer's Chakrams: "other commanders you
          -- control get +2/+2"). Limits the pump to commanders the source's
          -- controller controls, excluding the equipped creature ("other").
          and (effects.payload ->> 'commander_only' is null
               or (game_cards.is_commander
                   and game_cards.id is distinct from source_card.attached_to))
          -- Colour-filtered anthem (mig 209, Heraldic Banner): only creatures
          -- of the payload colour get the pump.
          -- Conditional anthem (mig 269, Jor Kadeen metalcraft: '+3/+0 as long
          -- as you control three or more artifacts'). Read-time gate against
          -- the SOURCE's controller.
          and (effects.payload ->> 'condition_count' is null
               or public.resolve_count_amount(p_session_id,
                    coalesce(source_card.controller_player_id, source_card.owner_id),
                    jsonb_build_object('count', effects.payload ->> 'condition_count'),
                    effects.source_card_id)
                  >= coalesce((effects.payload ->> 'condition_at_least')::integer, 1))
          -- Conditional anthem on the source controller's library top card colour
          -- (Vampire Nocturnus, mig 342: "as long as the top card is black").
          and (effects.payload ->> 'condition_top_card_color' is null
               or public.library_top_is_color(p_session_id,
                    coalesce(source_card.controller_player_id, source_card.owner_id),
                    effects.payload ->> 'condition_top_card_color'))
          and (effects.payload ->> 'color' is null
               or public.card_color_set(cards.mana_cost) @> array[lower(effects.payload ->> 'color')])
      ), 0)

    + coalesce((
        -- Dynamic pump (mig 267, Cranial Plating / Bonehoard): payload
        -- toughness_count names a count resolved against the SOURCE's controller
        -- at read time (artifacts_you_control, creature_cards_all_graveyards).
        select sum(public.resolve_count_amount(
                 p_session_id,
                 coalesce(source_card.controller_player_id, source_card.owner_id),
                 jsonb_build_object('count', effects.payload ->> 'toughness_count'),
                 effects.source_card_id))
        from public.game_continuous_effects effects
        left join public.game_cards source_card
          on source_card.id = effects.source_card_id
        where effects.session_id = p_session_id
          and effects.effect_type = 'pump'
          and effects.affected_card_id = p_game_card_id
          and effects.payload ? 'toughness_count'
          and (effects.source_zone_required is null or source_card.zone = effects.source_zone_required)
      ), 0)
  from public.game_cards
  join public.cards on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id;
$$;
grant execute on function public.card_layered_toughness(uuid, uuid) to authenticated;
grant execute on function public.card_layered_toughness(uuid, uuid) to service_role;

create or replace function public.activate_ability(
  p_session_id uuid,
  p_source_card_id uuid,
  p_ability_index integer default 0,
  p_target_player_id uuid default null,
  p_target_card_id uuid default null,
  p_generic_payment jsonb default null,
  p_x_value integer default null,
  -- Chosen cost payments (mig 284): for pick-able costs (sacrifice_artifacts,
  -- return_land, tap_creatures) the client passes the exact cards to pay
  -- with, in cost order. Null = the engine auto-picks (legacy behaviour).
  p_cost_card_ids uuid[] default null
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
  v_sac_artifacts_type text := '';
  v_sac_creature_types jsonb := null;
  v_sac_creature_another boolean := false;
  v_sac_creature_id uuid;
  v_sac_artifact uuid;
  v_return_land_count integer := 0;
  v_cost_pick_i integer := 0;
  v_i integer;
  v_remove_counter_type text;
  v_remove_counter_amount integer := 0;
  v_bag_count integer;
  v_mana_cost text := null;
  v_source_type_line text;
  v_source_is_commander boolean := false;
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

  -- You activate the abilities of permanents you CONTROL (not necessarily own):
  -- a donated/stolen permanent's abilities belong to its controller (mig 361,
  -- Xantcha). For non-battlefield zones (graveyard/hand abilities) fall back to
  -- ownership since control only exists on the battlefield.
  select game_cards.zone
  into v_zone
  from public.game_cards
  where game_cards.id = p_source_card_id
    and game_cards.session_id = p_session_id
    and coalesce(game_cards.controller_player_id, game_cards.owner_id) = auth.uid();

  if not found then
    raise exception 'Source card not found or not controlled by current user';
  end if;

  -- Restricted-mana pay context (Haven: "activate abilities of Dragon sources";
  -- Relic of Legends: "an ability of a commander").
  select c.type_line, coalesce(gc.is_commander, false)
  into v_source_type_line, v_source_is_commander
  from public.game_cards gc join public.cards c on c.id = gc.card_id
  where gc.id = p_source_card_id and gc.session_id = p_session_id;

  v_script := public.effective_script(p_session_id, p_source_card_id);
  v_ability := v_script -> 'activated_abilities' -> p_ability_index;

  -- Zone gate (mig 289): battlefield by default, but an ability may declare
  -- its own source zone (omen back-faces cast from HAND: Flush Out /
  -- Dynamic Soar; the adventure pattern generally).
  if v_zone <> coalesce(v_ability ->> 'source_zone_required', 'battlefield') then
    raise exception 'Ability source must be in its required zone (%)',
      coalesce(v_ability ->> 'source_zone_required', 'battlefield');
  end if;

  if v_ability is null then
    raise exception 'Activated ability not found at index %', p_ability_index;
  end if;

  -- "Activate only as a sorcery" (mig 440, Orthion): the sorcery gate —
  -- active player, main phase, empty stack.
  if lower(coalesce(v_ability ->> 'timing', '')) = 'sorcery' then
    if v_turn.active_player_id <> auth.uid() then
      raise exception 'This ability can only be activated as a sorcery (your turn)';
    end if;
    if v_turn.step not in ('precombat_main', 'postcombat_main') then
      raise exception 'This ability can only be activated as a sorcery (main phase)';
    end if;
    if exists (
      select 1 from public.game_stack_items
      where session_id = p_session_id and status = 'pending'
    ) then
      raise exception 'This ability can only be activated as a sorcery (empty stack)';
    end if;
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
      when 'sacrifice_creature' then
        v_has_sac_creature := true;
        -- type_line_any + another (mig 402, Kalitas: "another Vampire or
        -- Zombie") restrict which creature may pay the cost.
        v_sac_creature_types := case when jsonb_typeof(v_cost -> 'type_line_any') = 'array'
                                     then v_cost -> 'type_line_any' else null end;
        v_sac_creature_another := coalesce((v_cost ->> 'another')::boolean, false);
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
        -- Subtype restriction (mig 402, Professional Face-Breaker: "Sacrifice
        -- a Treasure") — both the auto-pick and a chosen payment honor it.
        v_sac_artifacts_type := lower(coalesce(v_cost ->> 'type_line', ''));
      -- 'Return a land you control to its owner's hand' as a cost (mig 277,
      -- Mina and Denn). Auto-picks: tapped lands first.
      when 'return_land' then
        v_return_land_count := greatest(1, coalesce((v_cost ->> 'count')::integer, 1));
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

  -- Sacrifice-a-creature cost. Two-picks (mig 412): when the ability's EFFECT is
  -- also targeted (Goblin Bombardment: "Sacrifice a creature: deal 1 damage to any
  -- target"), the client passes the sacrificed creature via p_cost_card_ids[1] and
  -- the effect's target via p_target_card_id. Legacy untargeted sac abilities still
  -- pass the creature as p_target_card_id (which is cleared after paying).
  if v_has_sac_creature then
    v_sac_creature_id := case when p_cost_card_ids is not null then p_cost_card_ids[1] else p_target_card_id end;
    if v_sac_creature_id is null then
      raise exception 'Choose a creature to sacrifice for this ability';
    end if;
    if not exists (
      select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.id = v_sac_creature_id and gc.session_id = p_session_id and gc.zone = 'battlefield'
        and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
        and c.type_line ilike '%creature%'
        and (not v_sac_creature_another or gc.id <> p_source_card_id)
        -- type_line_any honors the type-changing layer (mig 409): a changeling
        -- (or a granted-type permanent) satisfies "another Vampire or Zombie".
        and (v_sac_creature_types is null
             or exists (select 1 from jsonb_array_elements_text(v_sac_creature_types) t
                        where public.card_has_creature_type(p_session_id, gc.id, t.value)))
    ) then
      raise exception 'You must sacrifice a matching creature you control';
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
    if p_cost_card_ids is not null then
      -- Chosen payment (mig 284): tap exactly the provided creatures.
      for v_i in 1..v_tap_creatures_count loop
        v_cost_pick_i := v_cost_pick_i + 1;
        v_sac_artifact := p_cost_card_ids[v_cost_pick_i];
        if v_sac_artifact is null or not exists (
          select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
          where gc.id = v_sac_artifact and gc.session_id = p_session_id
            and gc.zone = 'battlefield' and gc.is_tapped = false
            and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
            and c.type_line ilike '%creature%'
            and c.type_line ilike '%' || v_tap_creatures_type || '%'
        ) then
          raise exception 'Chosen cost card is not a legal creature to tap';
        end if;
        update public.game_cards set is_tapped = true where id = v_sac_artifact;
      end loop;
    else
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
  end if;

  if v_mana_cost is not null then
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_mana_cost, p_generic_payment,
      p_pay_context := jsonb_build_object(
        'kind', 'ability',
        'type_line', coalesce(v_source_type_line, ''),
        'is_commander', v_source_is_commander));
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
    perform public.fire_watcher_triggers(p_session_id, p_source_card_id, auth.uid(), 'permanent_sacrificed');
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
    perform public.put_in_graveyard(p_session_id, v_sac_creature_id);
    perform public.fire_watcher_triggers(p_session_id, v_sac_creature_id, auth.uid(), 'permanent_sacrificed');
    -- The chosen creature was the COST, not the effect's target (mig 402,
    -- Kalitas: sacrificing must not aim the +1/+1 counters at the dead body).
    -- Only clear p_target_card_id in the legacy path where the sacrificed
    -- creature WAS passed as the target; when paid via p_cost_card_ids, keep
    -- p_target_card_id for the effect's own target (mig 412, Goblin Bombardment).
    if p_cost_card_ids is null then
      p_target_card_id := null;
    end if;
  end if;

  -- Pay the sacrifice-N-artifacts cost (mig 264): cheapest MV first, source
  -- excluded; raise when you control too few matching artifacts.
  if v_sac_artifacts_count > 0 then
    for v_i in 1..v_sac_artifacts_count loop
      if p_cost_card_ids is not null then
        -- Chosen payment (mig 284): consume the next provided card; it must
        -- be a legal artifact payment or the activation fails whole.
        v_cost_pick_i := v_cost_pick_i + 1;
        v_sac_artifact := p_cost_card_ids[v_cost_pick_i];
        if v_sac_artifact is null or not exists (
          select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
          where gc.id = v_sac_artifact and gc.session_id = p_session_id
            and gc.zone = 'battlefield'
            and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
            and gc.id <> p_source_card_id
            and c.type_line ilike '%artifact%'
            and (v_sac_artifacts_type = '' or c.type_line ilike '%' || v_sac_artifacts_type || '%')
            and (not v_sac_artifacts_nontoken
                 or (not coalesce(c.is_token, false) and not coalesce(gc.is_token, false)))
        ) then
          raise exception 'Chosen cost card is not a legal artifact to sacrifice';
        end if;
      else
      select gc.id into v_sac_artifact
      from public.game_cards gc
      join public.cards c on c.id = gc.card_id
      where gc.session_id = p_session_id and gc.zone = 'battlefield'
        and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
        and gc.id <> p_source_card_id
        and c.type_line ilike '%artifact%'
        and (v_sac_artifacts_type = '' or c.type_line ilike '%' || v_sac_artifacts_type || '%')
        and (not v_sac_artifacts_nontoken
             or (not coalesce(c.is_token, false) and not coalesce(gc.is_token, false)))
      order by public.mana_value(c.mana_cost) asc, gc.zone_position asc, gc.id asc
      limit 1;
      end if;
      if v_sac_artifact is null then
        raise exception 'You must sacrifice % artifact(s) you control', v_sac_artifacts_count;
      end if;
      perform public.put_in_graveyard(p_session_id, v_sac_artifact);
      perform public.fire_watcher_triggers(p_session_id, v_sac_artifact, auth.uid(), 'permanent_sacrificed');
    end loop;
  end if;

  -- Pay the return-a-land cost (mig 277, Mina and Denn): tapped lands first.
  if v_return_land_count > 0 then
    for v_i in 1..v_return_land_count loop
      if p_cost_card_ids is not null then
        v_cost_pick_i := v_cost_pick_i + 1;
        v_sac_artifact := p_cost_card_ids[v_cost_pick_i];
        if v_sac_artifact is null or not exists (
          select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
          where gc.id = v_sac_artifact and gc.session_id = p_session_id
            and gc.zone = 'battlefield'
            and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
            and c.type_line ilike '%land%'
        ) then
          raise exception 'Chosen cost card is not a legal land to return';
        end if;
      else
      select gc.id into v_sac_artifact
      from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.session_id = p_session_id and gc.zone = 'battlefield'
        and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
        and c.type_line ilike '%land%'
      order by gc.is_tapped desc, gc.zone_position asc, gc.id asc
      limit 1;
      end if;
      if v_sac_artifact is null then
        raise exception 'You must return % land(s) you control to pay this cost', v_return_land_count;
      end if;
      update public.game_cards gc
      set zone = 'hand', is_tapped = false, attached_to = null,
          controller_player_id = gc.owner_id,
          zone_position = (select coalesce(max(x.zone_position), -1) + 1
                           from public.game_cards x
                           where x.session_id = p_session_id
                             and x.owner_id = gc.owner_id and x.zone = 'hand')
      where gc.id = v_sac_artifact;
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

  elsif v_eff_type in ('create_token', 'search_library', 'grant_keyword_all', 'return_all_from_graveyard', 'deal_damage_all', 'monstrosity', 'divide_damage', 'return_from_graveyard', 'play_hideaway', 'choose_one', 'gain_life', 'fight_pick', 'destroy_all', 'proliferate', 'copy_permanent', 'copy_self') then
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

  elsif v_eff_type in ('destroy', 'exile', 'bounce', 'tap', 'untap', 'remove_from_combat') then
    if p_target_card_id is null then
      raise exception 'A target is required for this ability';
    end if;
    -- Negative target restrictions (mig 414) ride along so apply_creature_effect
    -- can reject a NONBLACK / non-<type> target (Executioner's Capsule). strip_nulls
    -- keeps absent keys out (the `?` existence check must not see phantom nulls).
    if public.behavior_target_type_is_creature_only(v_effect -> 'target_type') then
      v_stack := public.put_action_on_stack(
        p_session_id, v_eff_type || '_creature',
        jsonb_build_object('target_card_id', p_target_card_id, 'target_controller', v_target_controller, 'timing', 'instant')
          || jsonb_strip_nulls(jsonb_build_object(
               'exclude_type_line', v_effect -> 'exclude_type_line',
               'exclude_color', v_effect -> 'exclude_color')),
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
          'target_controller', v_target_controller, 'timing', 'instant')
          || jsonb_strip_nulls(jsonb_build_object(
               'exclude_type_line', v_effect -> 'exclude_type_line',
               'exclude_color', v_effect -> 'exclude_color')),
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
grant execute on function public.activate_ability(uuid, uuid, integer, uuid, uuid, jsonb, integer, uuid[]) to authenticated;
grant execute on function public.activate_ability(uuid, uuid, integer, uuid, uuid, jsonb, integer, uuid[]) to service_role;

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

  elsif p_kind = 'remove_from_combat' then
    -- Labyrinth of Skophos (mig 441): "remove target attacking or blocking
    -- creature from combat" — drop its attack assignment / detach it as a
    -- blocker. No damage, no untap.
    delete from public.game_combat_assignments
    where session_id = p_session_id and attacker_card_id = p_target_card_id;
    update public.game_combat_assignments
    set blocker_card_id = null
    where session_id = p_session_id and blocker_card_id = p_target_card_id;

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

    elsif v_type = 'sacrifice_unless_pay' then
      -- Rupture Spire / Transguild Promenade (mig 441): "When this enters,
      -- sacrifice it unless you pay {1}." Parks a pay-or-sacrifice confirm;
      -- submit_decision pays the cost or puts the source in the graveyard.
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'sacrifice_unless_pay',
        'Pay ' || coalesce(v_effect ->> 'cost', '{1}') || ' or sacrifice it',
        '[]'::jsonb, 0, 0,
        jsonb_build_object('cost', coalesce(v_effect ->> 'cost', '{1}'),
          'game_card_id', v_item.source_card_id))
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
        case when coalesce((v_effect ->> 'required')::boolean, false)
             then 'Destroy ' || coalesce(v_effect ->> 'count', '1')
             else 'Destroy up to ' || coalesce(v_effect ->> 'count', '1') end,
        v_options,
        -- required (mig 436, Fiery Confluence's third mode): "Destroy target
        -- artifact" is not declinable — demand the pick (capped at what exists).
        case when coalesce((v_effect ->> 'required')::boolean, false)
             then least(jsonb_array_length(v_options), greatest(1, coalesce((v_effect ->> 'count')::integer, 1)))
             else 0 end,
        greatest(1, coalesce((v_effect ->> 'count')::integer, 1)), '{}'::jsonb)
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
  v_target_item public.game_stack_items;
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
  v_madness_card uuid;
  v_madness_x integer;
  v_madness_script jsonb;
  v_madness_type text;
  v_madness_actions jsonb;
  v_madness_pos integer;
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

  elsif v_decision.decision_type in ('search_library', 'choose_cards', 'sacrifice', 'return_from_graveyard', 'reanimate_destroyed', 'look_top', 'proliferate', 'copy_permanent', 'become_copy', 'bounce_pick', 'cast_exiled_free', 'cascade_cast', 'put_from_hand_pick', 'destroy_pick', 'command_zone_pick', 'graveyard_exile_pick', 'graveyard_exile_until_leaves_pick', 'fight_pick', 'etali_cast_pick', 'graveyard_to_top_pick', 'grant_flashback', 'hand_to_library_top', 'corrupted_summons_pick') then
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
  elsif v_decision.decision_type = 'choose_land_type' then
    if (p_result ->> 'type') not in ('Plains', 'Island', 'Swamp', 'Mountain', 'Forest') then
      raise exception 'A basic land type must be chosen';
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
    -- Stack-less search (basic landcycling, mig 427) has no program to resume.
    if v_decision.source_stack_item_id is not null then
      perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);
    end if;

  elsif v_decision.decision_type = 'choose_cards' then
    v_dest := coalesce(v_decision.params ->> 'to', 'graveyard');
    for v_card in select (value)::uuid from jsonb_array_elements_text(v_top)
    loop
      if v_dest = 'graveyard' then
        -- A hand→graveyard pick is a DISCARD: route through discard_card
        -- (mig 434) so a madness card is exiled with its decision instead.
        -- Non-hand cards (mill picks etc.) take the plain graveyard move there.
        perform public.discard_card(v_decision.session_id, v_card);
      else
        select coalesce(max(zone_position), -1) + 1 into v_pos from public.game_cards where session_id = v_decision.session_id and owner_id = v_decision.deciding_player_id and zone = v_dest;
        update public.game_cards set zone = v_dest, zone_position = v_pos, is_tapped = false, damage_marked = 0 where id = v_card;
      end if;
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
      -- "whenever a player sacrifices a permanent" (mig 341, Carmen).
      perform public.fire_watcher_triggers(v_decision.session_id, v_card, v_decision.deciding_player_id, 'permanent_sacrificed');
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
      coalesce(v_decision.params -> 'edict_queue', '[]'::jsonb),
      v_decision.params -> 'filter_any'  -- OR-types carried across the edict chain (mig 417)
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
    -- lose_life_mana_value (mig 346, Reanimate: "you lose life equal to its mana
    -- value") — the decider loses life equal to the summed MV of the cards returned.
    if coalesce((v_decision.params ->> 'lose_life_mana_value')::boolean, false) then
      update public.game_session_players sp
      set life_total = life_total - (
        select coalesce(sum(public.mana_value(c.mana_cost)), 0)::integer
        from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.id = any(v_chosen_ids) and gc.session_id = v_decision.session_id)
      where sp.session_id = v_decision.session_id and sp.player_id = v_decision.deciding_player_id;
    end if;
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

  elsif v_decision.decision_type = 'hand_to_library_top' then
    -- Brainstorm (mig 392): each chosen hand card goes to the top of its
    -- owner's library (top = lowest zone_position); iterating the chosen array
    -- in order means the LAST pick ends on top — "in any order" is the
    -- player's pick order.
    for v_card in select (value)::uuid from jsonb_array_elements_text(v_top)
    loop
      select coalesce(min(zone_position), 0) - 1 into v_pos
      from public.game_cards
      where session_id = v_decision.session_id
        and owner_id = (select owner_id from public.game_cards where id = v_card)
        and zone = 'library';
      update public.game_cards
      set zone = 'library', zone_position = v_pos, is_tapped = false, damage_marked = 0
      where id = v_card and session_id = v_decision.session_id and zone = 'hand';
    end loop;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'sacrifice_unless_pay' then
    -- Rupture Spire / Transguild Promenade (mig 441): pay the tax or the
    -- source goes to the graveyard.
    if coalesce((p_result ->> 'confirmed')::boolean, false) then
      perform public.pay_mana_cost(
        v_decision.session_id, auth.uid(), v_decision.params ->> 'cost', null,
        p_pay_context := jsonb_build_object('kind', 'ability', 'type_line', '', 'is_commander', false));
    else
      perform public.put_in_graveyard(
        v_decision.session_id, (v_decision.params ->> 'game_card_id')::uuid);
    end if;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'corrupted_summons_pick' then
    -- Geth's Summons (mig 436): the chosen creature card (from the corrupted
    -- opponent's graveyard) enters the battlefield under the DECIDER's
    -- control. Stack-less decision — no resume.
    for v_card in select (value)::uuid from jsonb_array_elements_text(v_top)
    loop
      select coalesce(max(zone_position), -1) + 1 into v_pos
      from public.game_cards
      where session_id = v_decision.session_id
        and owner_id = (select owner_id from public.game_cards where id = v_card)
        and zone = 'battlefield';
      select turn_number into v_turn
      from public.game_turn_state where session_id = v_decision.session_id;
      update public.game_cards
      set zone = 'battlefield', zone_position = v_pos,
          controller_player_id = v_decision.deciding_player_id,
          entered_battlefield_turn_number = coalesce(v_turn, 0),
          is_tapped = false, damage_marked = 0
      where id = v_card and session_id = v_decision.session_id and zone = 'graveyard';
    end loop;
    perform public.rebuild_scripted_continuous_effects(v_decision.session_id);

  elsif v_decision.decision_type = 'madness_cast' then
    -- Madness (mig 434): the discarded card sits in exile (discard_card).
    -- {cast:true, x?} pays the madness cost and casts it from there; anything
    -- else drops it into the graveyard. Stack-less decision (null source), so
    -- no resume — the cast itself pushes a normal stack item.
    v_madness_card := (v_decision.params ->> 'game_card_id')::uuid;
    select c.type_line, public.effective_script(v_decision.session_id, gc.id)
    into v_madness_type, v_madness_script
    from public.game_cards gc join public.cards c on c.id = gc.card_id
    where gc.id = v_madness_card and gc.session_id = v_decision.session_id and gc.zone = 'exile';

    if not found or not coalesce((p_result ->> 'cast')::boolean, false) then
      -- Declined (or the card vanished): into the graveyard it goes.
      select coalesce(max(zone_position), -1) + 1 into v_madness_pos
      from public.game_cards
      where session_id = v_decision.session_id
        and owner_id = (select owner_id from public.game_cards where id = v_madness_card)
        and zone = 'graveyard';
      update public.game_cards
      set zone = 'graveyard', zone_position = v_madness_pos, is_tapped = false, damage_marked = 0
      where id = v_madness_card and session_id = v_decision.session_id and zone = 'exile';
    else
      v_madness_x := greatest(coalesce((p_result ->> 'x')::integer, 0), 0);
      perform public.pay_mana_cost(
        v_decision.session_id, auth.uid(), v_decision.params ->> 'cost', null, v_madness_x,
        p_pay_context := jsonb_build_object('kind', 'cast',
          'type_line', coalesce(v_madness_type, ''), 'is_commander', false));

      if v_madness_type ilike any (array[
        '%creature%', '%artifact%', '%enchantment%', '%planeswalker%', '%battle%', '%land%']) then
        -- Permanent: a real cast_permanent push from exile (cast_card_free
        -- precedent) — resolves with true ETBs.
        select coalesce(max(position), -1) + 1 into v_madness_pos
        from public.game_stack_items where session_id = v_decision.session_id;
        update public.game_cards
        set zone = 'stack', zone_position = v_madness_pos, is_tapped = false, damage_marked = 0
        where id = v_madness_card and session_id = v_decision.session_id;
        insert into public.game_stack_items (
          session_id, controller_player_id, source_card_id, action_type, payload, position)
        values (
          v_decision.session_id, auth.uid(), v_madness_card, 'cast_permanent',
          jsonb_build_object('timing', 'sorcery', 'type_line', v_madness_type, 'madness', true),
          v_madness_pos);
      else
        -- Spell: the madness program replaces the base effect when present
        -- ("If this spell's madness cost was paid, instead …"), with the
        -- caster-chosen X substituted like cast_spell_effect does.
        v_madness_actions := coalesce(
          v_madness_script -> 'madness_effect' -> 'actions',
          v_madness_script -> 'spell_effect' -> 'actions',
          '[]'::jsonb);
        select coalesce(jsonb_agg(
          case
            when (elem ->> 'amount') = 'X' or (elem ->> 'count') = 'X' then
              elem
                || (case when (elem ->> 'amount') = 'X'
                      then jsonb_build_object('amount', v_madness_x) else '{}'::jsonb end)
                || (case when (elem ->> 'count') = 'X'
                      then jsonb_build_object('count', v_madness_x) else '{}'::jsonb end)
            else elem
          end
          order by ord
        ), '[]'::jsonb)
        into v_madness_actions
        from jsonb_array_elements(v_madness_actions) with ordinality as t(elem, ord);

        select coalesce(max(position), -1) + 1 into v_madness_pos
        from public.game_stack_items where session_id = v_decision.session_id;
        insert into public.game_stack_items (
          session_id, controller_player_id, source_card_id, action_type, payload, position, status)
        values (
          v_decision.session_id, auth.uid(), v_madness_card, 'spell_effect',
          jsonb_build_object('effects', v_madness_actions,
            'controller_player_id', auth.uid(), 'timing', 'instant', 'madness', true),
          v_madness_pos, 'pending');
        -- The instant/sorcery leaves exile for the graveyard on cast.
        select coalesce(max(zone_position), -1) + 1 into v_madness_pos
        from public.game_cards
        where session_id = v_decision.session_id
          and owner_id = (select owner_id from public.game_cards where id = v_madness_card)
          and zone = 'graveyard';
        update public.game_cards
        set zone = 'graveyard', zone_position = v_madness_pos
        where id = v_madness_card and session_id = v_decision.session_id and zone = 'exile';
      end if;

      -- Madness casts are real casts: fire spell_cast watchers + cast triggers.
      perform public.fire_watcher_triggers(v_decision.session_id, v_madness_card, auth.uid(), 'spell_cast', null);
      perform public.enqueue_cast_triggers(v_decision.session_id, v_madness_card, auth.uid());
    end if;

  elsif v_decision.decision_type = 'grant_flashback' then
    -- Snapcaster Mage (mig 392): the chosen instant/sorcery card in the
    -- decider's graveyard gains flashback until end of turn. The grant is a
    -- turn-stamped counter; cast_spell_effect's graveyard branch accepts it
    -- this turn only (cost = the card's own mana cost) and exiles on cast.
    for v_card in select (value)::uuid from jsonb_array_elements_text(v_top)
    loop
      update public.game_cards
      set counters = coalesce(counters, '{}'::jsonb) || jsonb_build_object(
        'flashback_until_turn',
        (select turn_number from public.game_turn_state where session_id = v_decision.session_id))
      where id = v_card and session_id = v_decision.session_id and zone = 'graveyard';
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

  elsif v_decision.decision_type = 'graveyard_exile_until_leaves_pick' then
    -- Trove Warden (mig 405): exile the chosen permanent card from the
    -- controller's graveyard AND anchor it to the source permanent, so
    -- fire_zone_change_triggers returns it to the battlefield when the source
    -- leaves (dies). Reuses the exiled_until_leaves mechanism (mig 262/404).
    select source_card_id into v_src_card
    from public.game_stack_items where id = v_decision.source_stack_item_id;
    for v_card in select (value)::uuid from jsonb_array_elements_text(v_top)
    loop
      select coalesce(max(zone_position), -1) + 1 into v_pos
      from public.game_cards
      where session_id = v_decision.session_id
        and owner_id = (select owner_id from public.game_cards where id = v_card)
        and zone = 'exile';
      update public.game_cards
      set zone = 'exile', zone_position = v_pos, controller_player_id = owner_id,
          is_tapped = false, damage_marked = 0, plus_one_counters = 0
      where id = v_card and session_id = v_decision.session_id and zone = 'graveyard';
      -- Only anchor when the source is still on the battlefield (else the card
      -- would never return — and a dead source can't hold linked exiles).
      if v_src_card is not null and exists (
        select 1 from public.game_cards
        where id = v_src_card and session_id = v_decision.session_id and zone = 'battlefield'
      ) then
        insert into public.game_continuous_effects (
          session_id, source_card_id, affected_card_id, effect_type, payload, source_zone_required
        ) values (
          v_decision.session_id, v_src_card, v_card, 'exiled_until_leaves', '{}'::jsonb, 'battlefield'
        );
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

  elsif v_decision.decision_type = 'pay_or_be_countered' then
    -- Mana Leak (mig 392): "counter target spell unless its controller pays
    -- {3}." Confirmed → pay the escape cost from the decider's pool (raises if
    -- unaffordable, so declining stays an explicit choice) and the spell
    -- stands. Declined → counter it (same moves as handle_counter_spell).
    if coalesce((v_decision.result ->> 'confirmed')::boolean, false) then
      perform public.pay_mana_cost(
        v_decision.session_id, auth.uid(), v_decision.params ->> 'cost', null, 0);
    else
      select * into v_target_item
      from public.game_stack_items
      where id = nullif(v_decision.params ->> 'target_stack_item_id', '')::uuid
        and session_id = v_decision.session_id and status = 'pending'
      for update;
      if found then
        if v_target_item.action_type = 'cast_permanent' and v_target_item.source_card_id is not null then
          select coalesce(max(zone_position), -1) + 1 into v_pos
          from public.game_cards
          where session_id = v_decision.session_id
            and owner_id = v_target_item.controller_player_id and zone = 'graveyard';
          update public.game_cards
          set zone = 'graveyard', zone_position = v_pos, is_tapped = false, damage_marked = 0
          where id = v_target_item.source_card_id and session_id = v_decision.session_id
            and owner_id = v_target_item.controller_player_id and zone = 'stack';
        end if;
        update public.game_stack_items
        set status = 'cancelled', resolved_at = now()
        where id = v_target_item.id;
      end if;
    end if;
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
      if coalesce((v_decision.params ->> 'program')::boolean, false) then
        -- program:true (Ruthless Lawbringer, mig 339): run the inner effects as a
        -- fresh triggered-ability PROGRAM — "when you do, destroy target nonland
        -- permanent." Each effect parks its own decision (the sacrifice edict,
        -- then the destroy_up_to pick), so the destroy target is chosen AFTER the
        -- sacrifice rather than needing a pre-supplied target.
        perform public.enqueue_triggered_ability(
          v_decision.session_id, coalesce(v_ctrl, v_decision.deciding_player_id), v_src_card,
          'reflexive', coalesce(v_decision.params -> 'effects', '[]'::jsonb),
          nullif(v_decision.params ->> 'triggering_card_id', '')::uuid);
      else
        perform public.apply_targeted_triggered_ability_effects(
          v_decision.session_id, coalesce(v_ctrl, v_decision.deciding_player_id), v_src_card,
          coalesce(v_decision.params -> 'effects', '[]'::jsonb), v_tgt
        );
      end if;
    end if;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'commander_zone_return' then
    -- CR 903.9a (mig 374): the commander is already IN the graveyard/exile
    -- (dies/leaves triggers fired on the way there). Yes moves it to the
    -- owner's command zone; the zone guard covers a card that left meanwhile
    -- (e.g. reanimated while the decision was pending). No standalone
    -- resume_or_finalize: this decision has no source stack item.
    if coalesce((v_decision.result ->> 'confirmed')::boolean, false) then
      select coalesce(max(zone_position), -1) + 1 into v_pos
      from public.game_cards
      where session_id = v_decision.session_id
        and owner_id = v_decision.deciding_player_id
        and zone = 'command';
      update public.game_cards
      set zone = 'command', zone_position = v_pos,
          controller_player_id = owner_id,
          is_tapped = false, damage_marked = 0,
          dealt_deathtouch_damage = false, plus_one_counters = 0,
          attached_to = null
      where id = nullif(v_decision.params ->> 'game_card_id', '')::uuid
        and session_id = v_decision.session_id
        and zone in ('graveyard', 'exile');
    end if;

  elsif v_decision.decision_type = 'copy_permanent' then
    -- Token copy (mig 239, Will of the Temur): create a token that's a copy of
    -- the picked permanent, with the parked `except` overrides (set_pt +
    -- keyword grants), then resume the program.
    foreach v_card in array v_chosen_ids
    loop
      -- count>1 (mig 348, Orthion: "create five tokens that are copies").
      perform public.create_copy_token(
        v_decision.session_id, v_decision.deciding_player_id, v_card,
        v_decision.params -> 'except')
      from generate_series(1, greatest(1, coalesce((v_decision.params ->> 'count')::integer, 1)));
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

  elsif v_decision.decision_type = 'cascade_cast' then
    -- Cascade "you may cast it." Cast → cast_card_free (true nested cast). An
    -- unsupported spell shape returns the sentinel → bottom it instead. Decline /
    -- empty → the found card bottoms with the rest (never to hand — cascade RAW).
    if cardinality(v_chosen_ids) > 0 then
      v_card := public.cast_card_free(v_decision.session_id,
        (v_decision.params ->> 'found_card_id')::uuid, v_decision.deciding_player_id);
      if v_card = '00000000-0000-0000-0000-000000000000'::uuid then
        perform public.bottom_cards_random(v_decision.session_id, v_decision.deciding_player_id,
          array[(v_decision.params ->> 'found_card_id')::uuid]);
      end if;
    else
      perform public.bottom_cards_random(v_decision.session_id, v_decision.deciding_player_id,
        array[(v_decision.params ->> 'found_card_id')::uuid]);
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
    if v_decision.params ? 'apply_permanent_effect' then
      -- "Target PLAYER gains control of target permanent you control" (Harmless
      -- Offering donate): apply the parked permanent_effect to the cast's stored
      -- target with the CHOSEN player as acting_controller. Reusable for any
      -- "choose an opponent, then hand them a permanent" cast.
      v_pe := v_decision.params -> 'apply_permanent_effect';
      perform public.apply_creature_effect(
        v_decision.session_id, v_pe ->> 'kind',
        nullif(v_pe ->> 'target_card_id', '')::uuid,
        v_pe || jsonb_build_object('acting_controller', v_chosen_player));
    else
      select source_card_id into v_src_card from public.game_stack_items where id = v_decision.source_stack_item_id;
      select coalesce(jsonb_agg(e.value || jsonb_build_object('recipient', 'controller')), '[]'::jsonb)
        into v_effects_rewritten
      from jsonb_array_elements(coalesce(v_decision.params -> 'effects', '[]'::jsonb)) e;
      perform public.apply_triggered_ability_effects(v_decision.session_id, v_chosen_player, v_src_card, v_effects_rewritten);
    end if;
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

  elsif v_decision.decision_type = 'choose_land_type' then
    -- Multiversal Passage (mig 407): the land BECOMES the chosen basic type.
    -- (1) register a granted_type so effective_type_line includes it (Domain /
    -- type-matters); (2) bake the matching {T}: add <color> mana ability into
    -- copied_script so the land taps for that colour. Both keyed to the source,
    -- swept when it leaves.
    v_chosen_type := v_decision.result ->> 'type';
    select source_card_id into v_src_card from public.game_stack_items where id = v_decision.source_stack_item_id;
    if v_src_card is not null and v_chosen_type is not null then
      insert into public.game_continuous_effects (
        session_id, source_card_id, affected_card_id, effect_type, payload, source_zone_required)
      values (
        v_decision.session_id, v_src_card, v_src_card, 'granted_type',
        jsonb_build_object('add', v_chosen_type), 'battlefield');

      v_eff_script := public.effective_script(v_decision.session_id, v_src_card);
      update public.game_cards
      set copied_script = jsonb_set(
            coalesce(v_eff_script, '{"schema_version":2}'::jsonb),
            '{activated_abilities}',
            coalesce(v_eff_script -> 'activated_abilities', '[]'::jsonb)
              || jsonb_build_array(jsonb_build_object(
                   'is_mana_ability', true,
                   'costs', jsonb_build_array(jsonb_build_object('type', 'tap_self')),
                   'effects', jsonb_build_array(jsonb_build_object(
                     'type', 'add_mana', 'amount', 1,
                     'color', case v_chosen_type
                                when 'Plains' then 'W' when 'Island' then 'U'
                                when 'Swamp' then 'B' when 'Mountain' then 'R'
                                else 'G' end)))))
      where id = v_src_card and session_id = v_decision.session_id;
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
        -- Re-register continuous effects so a "choose a type" STATIC anthem
        -- (Radiant Destiny: chosen type gets +1/+1; Cover of Darkness: chosen
        -- type has fear) registers with the now-concrete creature_type. The
        -- pre-choice registration carried the literal "$chosen" (matched nothing).
        perform public.rebuild_scripted_continuous_effects(v_decision.session_id);
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
        -- return_all_from_graveyard (mig 343, Patriarch's Bidding: each player
        -- returns their own graveyard's creatures of the type they chose).
        when lower(coalesce(e.value ->> 'type', '')) = 'return_all_from_graveyard'
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
    -- who:'each_player' (mig 343, Patriarch's Bidding): raise the next queued
    -- player's type choice, or finalize when every player has chosen.
    if jsonb_array_length(coalesce(v_decision.params -> 'player_queue', '[]'::jsonb)) > 0 then
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (v_decision.session_id, (v_decision.params -> 'player_queue' ->> 0)::uuid,
        v_decision.source_stack_item_id, 'choose_creature_type', 'Choose a creature type',
        coalesce(v_decision.params -> 'options', '[]'::jsonb), 1, 1,
        jsonb_build_object('effects', coalesce(v_decision.params -> 'effects', '[]'::jsonb),
          'player_queue', (v_decision.params -> 'player_queue') - 0,
          'options', coalesce(v_decision.params -> 'options', '[]'::jsonb)));
    else
      perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);
    end if;
  end if;

  return v_decision;
end;
$$;
