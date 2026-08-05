-- 202605010438_damage_replacement
-- Damage replacement / prevention / self-damage (bucket 5):
-- - self_damage-cost op mana-abilities (pain lands / talismans / Yavimaya
--   Coast): "deals 1 damage to you" is nu echte damage via
--   apply_damage_to_player (shields en statics gelden), geen pay_life meer.
-- - damage_double_to_opponents / damage_prevent_half statics (Gisela, Blade
--   of Goldnight) in apply_damage_to_player en apply_damage_to_creature —
--   eerst verdubbelen richting opponents, dan de helft (naar boven afgerond)
--   voorkomen voor de beschermde speler; nieuw in de registratie-allowlist en
--   de CHECK-constraint hieronder.
-- - Scripted deal_damage naar spelers routeert door apply_damage_to_player
--   (Eshki wordt echte damage; lose_life blijft een directe decrement).
-- - Nieuwe count opponents_attacked_this_combat (Drogskol's melee).

-- De twee nieuwe statics in de continuous-effect CHECK-lijst (herbouwd van de
-- mig 432-definitie + de nieuwe waarden — bug-283-regel).
alter table public.game_continuous_effects
  drop constraint if exists game_continuous_effects_effect_type_check;
alter table public.game_continuous_effects
  add constraint game_continuous_effects_effect_type_check
  check (effect_type = any (array[
    'mana_does_not_empty', 'additional_land_plays', 'haste', 'vigilance',
    'indestructible', 'trample', 'first_strike', 'double_strike', 'flying',
    'reach', 'deathtouch', 'pump', 'control', 'set_pt', 'protection', 'switch_pt',
    'infect', 'wither', 'toxic', 'cast_from_graveyard', 'menace',
    'intimidate', 'hexproof', 'curse_attacked', 'play_from_exile', 'cost_reduction',
    'cast_from_library_top', 'goaded', 'creatures_enter_tapped', 'damage_cap',
    'exiled_until_leaves', 'attack_tax', 'animated', 'lifelink',
    'cant_attack', 'cant_block', 'defender', 'fear', 'granted_dies_effect', 'granted_ability',
    'unblockable', 'flash_permission', 'dies_replacement', 'granted_type',
    'grants_convoke', 'damage_double_to_opponents', 'damage_prevent_half'
  ]));
-- Generated from supabase/functions_src (activate_mana_ability, apply_damage_to_player, apply_damage_to_creature, apply_triggered_ability_effects, resolve_count_amount, register_card_continuous_effects) — those files are
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
  v_mod integer;
begin
  if v_remaining <= 0 then
    return 0;
  end if;

  select turn_number into v_turn
  from public.game_turn_state where session_id = p_session_id;

  -- Damage-modifying statics (mig 438, Gisela, Blade of Goldnight), applied
  -- before the prevention shields: first every active "double damage to
  -- opponents" whose controller sees the damaged player as an opponent, then
  -- every "prevent half, rounded up" protecting the damaged player.
  for v_mod in
    select 1 from public.game_continuous_effects ce
    join public.game_cards src on src.id = ce.source_card_id and src.session_id = ce.session_id
    where ce.session_id = p_session_id
      and ce.effect_type = 'damage_double_to_opponents'
      and src.zone = 'battlefield'
      and ce.affected_player_id is not null
      and ce.affected_player_id is distinct from p_player_id
  loop
    v_remaining := v_remaining * 2;
  end loop;
  for v_mod in
    select 1 from public.game_continuous_effects ce
    join public.game_cards src on src.id = ce.source_card_id and src.session_id = ce.session_id
    where ce.session_id = p_session_id
      and ce.effect_type = 'damage_prevent_half'
      and src.zone = 'battlefield'
      and ce.affected_player_id = p_player_id
  loop
    v_remaining := v_remaining - ((v_remaining + 1) / 2);
  end loop;
  if v_remaining <= 0 then
    return 0;
  end if;

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
  v_mod integer;
  v_tgt_controller uuid;
begin
  if v_remaining <= 0 then
    return 0;
  end if;

  -- Damage-modifying statics (mig 438, Gisela): keyed on the damaged
  -- creature's CONTROLLER — double when that player is an opponent of the
  -- static's controller, then prevent half (rounded up) when the static
  -- protects that player. Applied before shields, mirroring the player path.
  select coalesce(gc.controller_player_id, gc.owner_id) into v_tgt_controller
  from public.game_cards gc
  where gc.id = p_card_id and gc.session_id = p_session_id;
  if v_tgt_controller is not null then
    for v_mod in
      select 1 from public.game_continuous_effects ce
      join public.game_cards src on src.id = ce.source_card_id and src.session_id = ce.session_id
      where ce.session_id = p_session_id
        and ce.effect_type = 'damage_double_to_opponents'
        and src.zone = 'battlefield'
        and ce.affected_player_id is not null
        and ce.affected_player_id is distinct from v_tgt_controller
    loop
      v_remaining := v_remaining * 2;
    end loop;
    for v_mod in
      select 1 from public.game_continuous_effects ce
      join public.game_cards src on src.id = ce.source_card_id and src.session_id = ce.session_id
      where ce.session_id = p_session_id
        and ce.effect_type = 'damage_prevent_half'
        and src.zone = 'battlefield'
        and ce.affected_player_id = v_tgt_controller
    loop
      v_remaining := v_remaining - ((v_remaining + 1) / 2);
    end loop;
    if v_remaining <= 0 then
      return 0;
    end if;
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
          if v_eff_type = 'deal_damage' then
            -- DAMAGE routes through apply_damage_to_player (mig 438, Eshki):
            -- prevention shields and damage statics (Gisela) apply; plain
            -- lose_life keeps the direct decrement (loss, not damage).
            perform public.apply_damage_to_player(
              p_session_id, v_rid, v_eff_amount, p_source_card_id, false);
          else
            update public.game_session_players
            set life_total = greatest(0, life_total - v_eff_amount)
            where session_id = p_session_id and player_id = v_rid;
          end if;
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

create or replace function public.register_card_continuous_effects(
  p_session_id uuid, p_source_card_id uuid
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source_card public.game_cards;
  v_script jsonb;
  v_keywords jsonb;
  v_keyword text;
  v_keyword_effect_type text;
  v_effect jsonb;
  v_effect_type text;
  v_affected text;
  v_affected_player_id uuid;
  v_affected_card_id uuid;
  v_source_zone_required text;
  v_payload jsonb;
  v_registered_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select game_cards.*
  into v_source_card
  from public.game_cards
  where game_cards.id = p_source_card_id
    and game_cards.session_id = p_session_id;

  if not found then
    raise exception 'Source card not found';
  end if;

  delete from public.game_continuous_effects
  where session_id = p_session_id
    and source_card_id = p_source_card_id
    and payload ->> 'registered_from_card_script' = 'true';

  if v_source_card.zone <> 'battlefield' or v_source_card.static_effects_suppressed then
    return 0;
  end if;

  -- A manifested (face-down) card has no abilities and no printed keywords
  -- (mig 251, Reality Shift); its 2/2 set_pt row is not script-flagged, so
  -- the delete above leaves it alone.
  if coalesce(v_source_card.counters, '{}'::jsonb) ? 'manifested' then
    return 0;
  end if;

  v_script := public.effective_script(p_session_id, p_source_card_id);

  select coalesce(cards.keywords, '[]'::jsonb)
  into v_keywords
  from public.cards
  where cards.id = v_source_card.card_id;

  for v_effect in
    select value
    from jsonb_array_elements(coalesce(v_script -> 'continuous_effects', '[]'::jsonb))
  loop
    v_effect_type := coalesce(v_effect ->> 'effect_type', v_effect ->> 'type');

    if v_effect_type not in (
      'mana_does_not_empty',
      'additional_land_plays',
      'haste',
      'vigilance',
      'indestructible',
      'trample',
      'first_strike',
      'double_strike',
      'flying',
      'reach',
      'deathtouch',
      'protection',
      'pump',
      'infect',
      'wither',
      'toxic',
      'menace',
      'lifelink',
      'intimidate',
      'hexproof',
      -- Fear (mig 338, Cover of Darkness): "can't be blocked except by artifact
      -- and/or black creatures"; declare_blocker enforces it via card_has_fear.
      'fear',
      -- Granted ability (mig 357, Blade of Selves / Splinter Twin / Mirage Phalanx):
      -- payload {kind, ability}; effective_script merges it onto the affected card.
      'granted_ability',
      -- Defender (mig 323): "this creature can't attack"; declare_attacker rejects it.
      'defender',
      -- STATIC cast-from-graveyard permission (mig 207, Gisa and Geralf): a
      -- script-registered row, swept by rebuild when the source leaves — unlike
      -- the until-EOT grant_cast_from_graveyard effect rows (mig 173).
      'cast_from_graveyard',
      -- STATIC cost reduction (mig 231, Dragonlord's Servant / Sarkhan): payload
      -- {type_line, amount}; reduced_mana_cost sums these for the caster. Defaults
      -- to affected:'controller' (not a source-keyword), so affected_player_id is
      -- the controller.
      'cost_reduction',
      -- STATIC convoke grant (mig 432, Chief Engineer: "Artifact spells you
      -- cast have convoke"): payload {type_line}; cast_card_from_hand's convoke
      -- gate accepts matching casts while the source is fielded.
      'grants_convoke',
      -- STATIC damage modifiers (mig 438, Gisela, Blade of Goldnight): double
      -- damage dealt to opponents of the controller / prevent half (rounded
      -- up) dealt to the controller or their permanents. Read by
      -- apply_damage_to_player and apply_damage_to_creature.
      'damage_double_to_opponents',
      'damage_prevent_half',
      -- STATIC cast-from-the-top-of-your-library permission (mig 244,
      -- Thundermane Dragon): payload {creature, min_power, grant_haste};
      -- cast_card_from_hand's library gate consumes it.
      'cast_from_library_top',
      -- STATIC "creatures your opponents control enter tapped" (mig 258,
      -- Kinjalli's Sunwing): fire_zone_change_triggers taps creatures entering
      -- under any OTHER player's control while this row's source is fielded.
      'creatures_enter_tapped',
      -- STATIC damage cap (mig 259, Temple Altisaur): payload {type_line, cap};
      -- apply_damage_to_creature caps damage to OTHER matching creatures the
      -- source's controller controls.
      'damage_cap',
      -- STATIC base-P/T override via aura (mig 279, Darksteel Mutation:
      -- 'enchanted creature is 0/1'). affected:'enchanted' lands it on the
      -- host; losing abilities/types is NOT modelled.
      'set_pt',
      -- STATIC attack tax (mig 275, Ghostly Prison / Norn's Annex / Windborn
      -- Muse): payload {mana:N} or {life:N}; declare_attacker auto-pays per
      -- attacker against the protected (controller) player.
      'attack_tax',
      -- PACIFY (mig 303, Observed Stasis): affected:'enchanted' rows that forbid
      -- the host from attacking / blocking; declare_attacker / declare_blocker
      -- reject the action while the source (Aura) stays fielded.
      'cant_attack',
      'cant_block',
      -- STATIC "you may cast <filter> spells as though they had flash"
      -- (mig 398, Shimmer Myr): payload {type_line}; card_has_flash consumes it
      -- for the caster (affected:'controller').
      'flash_permission',
      -- DEATH REPLACEMENT (mig 406, Kalitas): "a nontoken creature an opponent
      -- controls would die → exile it instead; you create a token." payload
      -- {scope, nontoken, exile, create_token}; put_in_graveyard consumes it.
      'dies_replacement',
      -- TYPE-CHANGING LAYER (mig 407): payload {add:'Assassin'} adds a type,
      -- {override:'Land'} replaces all types. effective_type_line folds these
      -- (Reaper's Scythe "is an Assassin"; Multiversal Passage's chosen basic
      -- type is registered dynamically by choose_land_type).
      'granted_type'
    ) then
      raise exception 'Unsupported continuous effect type: %', v_effect_type;
    end if;

    -- commander_only anthem (Dancer's Chakrams): the "other commanders you
    -- control" buff is an ability GRANTED to the equipped creature, so it exists
    -- only while a creature is equipped. Skip it when this Equipment is unattached.
    if coalesce((v_effect -> 'payload' ->> 'commander_only')::boolean, false)
       and v_source_card.attached_to is null then
      continue;
    end if;

    v_affected := coalesce(
      v_effect ->> 'affected',
      case
        when v_effect_type in (
          'haste',
          'vigilance',
          'indestructible',
          'trample',
          'first_strike',
          'double_strike',
          'flying',
          'reach',
          'deathtouch',
          'protection',
          'infect',
          'wither',
          'toxic',
          'menace',
          'lifelink',
          'intimidate',
          'hexproof',
          'defender'
        ) then 'source'
        else 'controller'
      end
    );
    v_affected_player_id := null;
    v_affected_card_id := null;

    if v_affected in ('all', 'all_players') then
      v_affected_player_id := null;
    elsif v_affected in ('controller', 'self') then
      v_affected_player_id := coalesce(v_source_card.controller_player_id, v_source_card.owner_id);
    elsif v_affected in ('source', 'this') then
      v_affected_card_id := p_source_card_id;
    elsif v_affected in ('attached', 'host', 'enchanted', 'equipped') then
      -- Aura/Equipment: the effect lands on the host. Unattached → grants nothing.
      v_affected_card_id := v_source_card.attached_to;
      if v_affected_card_id is null then
        continue;
      end if;
    else
      raise exception 'Unsupported continuous effect affected value: %', v_affected;
    end if;

    v_source_zone_required := coalesce(v_effect ->> 'source_zone_required', 'battlefield');

    if v_source_zone_required not in ('library', 'hand', 'stack', 'battlefield', 'graveyard', 'exile') then
      raise exception 'Unsupported source zone requirement: %', v_source_zone_required;
    end if;

    if v_effect_type = 'additional_land_plays' then
      v_payload := jsonb_build_object(
        'amount',
        coalesce((v_effect ->> 'amount')::integer, 1)
      );
    elsif v_effect_type = 'mana_does_not_empty' then
      v_payload := jsonb_build_object(
        'colors',
        coalesce(v_effect -> 'colors', '[]'::jsonb)
      );
    elsif v_effect_type = 'protection' then
      v_payload := jsonb_build_object(
        'from',
        lower(coalesce(v_effect ->> 'from', v_effect ->> 'color'))
      );
    elsif v_effect_type = 'toxic' then
      v_payload := jsonb_build_object(
        'amount',
        greatest(1, coalesce((v_effect ->> 'amount')::integer, 1))
      );
    else
      v_payload := '{}'::jsonb;
    end if;

    v_payload := coalesce(v_effect -> 'payload', v_payload)
      || jsonb_build_object('registered_from_card_script', true);

    insert into public.game_continuous_effects (
      session_id,
      source_card_id,
      affected_player_id,
      affected_card_id,
      effect_type,
      payload,
      source_zone_required,
      expires_at_turn_number,
      expires_at_phase,
      expires_at_step
    )
    values (
      p_session_id,
      p_source_card_id,
      v_affected_player_id,
      v_affected_card_id,
      v_effect_type,
      v_payload,
      v_source_zone_required,
      nullif(v_effect ->> 'expires_at_turn_number', '')::integer,
      nullif(v_effect ->> 'expires_at_phase', ''),
      nullif(v_effect ->> 'expires_at_step', '')
    );

    v_registered_count := v_registered_count + 1;
  end loop;

  for v_keyword in
    select lower(replace(replace(keyword, ' ', '_'), '-', '_'))
    from jsonb_array_elements_text(v_keywords) as keyword
  loop
    v_keyword_effect_type := case v_keyword
      when 'haste'         then 'haste'
      when 'vigilance'     then 'vigilance'
      when 'indestructible' then 'indestructible'
      when 'trample'       then 'trample'
      when 'first_strike'  then 'first_strike'
      when 'double_strike' then 'double_strike'
      when 'flying'        then 'flying'
      when 'reach'         then 'reach'
      when 'deathtouch'    then 'deathtouch'
      when 'infect'        then 'infect'
      when 'wither'        then 'wither'
      when 'menace'        then 'menace'
      -- Printed lifelink (mig 386): grants and scripts worked since mig 283,
      -- but this loop never mapped the catalog keyword — vanilla lifelink
      -- creatures gained no life.
      when 'lifelink'      then 'lifelink'
      when 'intimidate'    then 'intimidate'
      when 'fear'          then 'fear'
      when 'hexproof'      then 'hexproof'
      when 'defender'      then 'defender'
      else null
    end;

    if v_keyword_effect_type is null then
      continue;
    end if;

    insert into public.game_continuous_effects (
      session_id,
      source_card_id,
      affected_card_id,
      effect_type,
      payload,
      source_zone_required
    )
    values (
      p_session_id,
      p_source_card_id,
      p_source_card_id,
      v_keyword_effect_type,
      jsonb_build_object('registered_from_card_script', true, 'registered_from_keywords', true),
      'battlefield'
    );

    v_registered_count := v_registered_count + 1;
  end loop;

  return v_registered_count;
end;
$$;
grant execute on function public.register_card_continuous_effects(uuid, uuid) to authenticated, service_role;
