-- Planeswalkers — core framework (roadmap Tribal #4, slice 1).
--
-- A planeswalker is a permanent (type_line "Planeswalker — …") that enters with a
-- starting LOYALTY (a loyalty counter, stored in the counters bag under 'loyalty') and
-- has LOYALTY ABILITIES: +N / −N / 0 activated abilities, sorcery-speed, once per turn
-- per planeswalker, where the cost is paid by adjusting loyalty. A planeswalker with 0
-- loyalty is put into its owner's graveyard as a state-based action.
--
-- Authoring (top level): "loyalty": N (starting loyalty) and "loyalty_abilities":
-- [{ "cost": +1|-3|0, "effects": [ … ] }, …]. The ability's effects use the normal
-- triggered-ability vocabulary (resolved with the planeswalker as source).
--
-- SCOPE (slice 1): no combat yet — attacking a planeswalker / redirecting combat or
-- burn damage to its loyalty is a deferred follow-on. Loyalty changes only via its
-- abilities here. Starting loyalty rides enters_with_counters, so Doubling Season
-- doubles it (correct). Reproduced from CURRENT (grep-first): apply_enters_with_counters
-- (mig 158). (IDE T-SQL false-positives on $$ bodies — ignore.)

-- ===========================================================================
-- apply_enters_with_counters (CURRENT = mig 158) — ALSO set a planeswalker's starting
-- loyalty (a 'loyalty' bag counter, doubled by Doubling Season). The enters_with_counters
-- block is unchanged; the early-return was removed so both can apply.
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
  if NEW.zone <> 'battlefield' then
    return NEW;
  end if;
  if TG_OP = 'UPDATE' and OLD.zone = 'battlefield' then
    return NEW;
  end if;

  v_script := coalesce(NEW.copied_script, (select script from public.cards where id = NEW.card_id), '{}'::jsonb);

  -- Planeswalker starting loyalty (a loyalty counter; Doubling Season doubles it).
  if (v_script ->> 'loyalty') is not null then
    v_amount := coalesce((v_script ->> 'loyalty')::integer, 0)
              * public.counter_factor(NEW.session_id, NEW.controller_player_id);
    if v_amount > 0 then
      NEW.counters := public.adjust_counter_bag(coalesce(NEW.counters, '{}'::jsonb), 'loyalty', v_amount);
    end if;
  end if;

  -- "Enters the battlefield with N counters on it."
  v_ewc := v_script -> 'enters_with_counters';
  if v_ewc is not null and jsonb_typeof(v_ewc) = 'object' then
    v_amount := coalesce((v_ewc ->> 'amount')::integer, 0);
    if v_amount > 0 then
      v_amount := v_amount * public.counter_factor(NEW.session_id, NEW.controller_player_id);
      v_counter_type := v_ewc ->> 'counter_type';
      if public.is_plus_one_counter(v_counter_type) then
        NEW.plus_one_counters := coalesce(NEW.plus_one_counters, 0) + v_amount;
      else
        NEW.counters := public.adjust_counter_bag(coalesce(NEW.counters, '{}'::jsonb), lower(v_counter_type), v_amount);
      end if;
    end if;
  end if;

  return NEW;
end;
$$;

-- ===========================================================================
-- move_zero_loyalty_planeswalkers_to_graveyard — SBA: a planeswalker at 0 loyalty dies.
-- ===========================================================================
create or replace function public.move_zero_loyalty_planeswalkers_to_graveyard(p_session_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card uuid;
  v_n integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  for v_card in
    select gc.id
    from public.game_cards gc
    join public.cards c on c.id = gc.card_id
    where gc.session_id = p_session_id
      and gc.zone = 'battlefield'
      and c.type_line ilike '%planeswalker%'
      and coalesce((gc.counters ->> 'loyalty')::integer, 0) = 0
    order by gc.owner_id, gc.zone_position, gc.id
  loop
    if public.put_in_graveyard(p_session_id, v_card) then
      v_n := v_n + 1;
    end if;
  end loop;

  return v_n;
end;
$$;
grant execute on function public.move_zero_loyalty_planeswalkers_to_graveyard(uuid) to authenticated;
grant execute on function public.move_zero_loyalty_planeswalkers_to_graveyard(uuid) to service_role;

-- ===========================================================================
-- activate_loyalty_ability — pay the +N/−N/0 loyalty cost (sorcery speed, once per turn
-- per planeswalker) and put the ability's effects on the stack. A −N needs ≥ N loyalty.
-- ===========================================================================
create or replace function public.activate_loyalty_ability(
  p_session_id uuid,
  p_source_card_id uuid,
  p_ability_index integer default 0
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn public.game_turn_state;
  v_zone text;
  v_type_line text;
  v_controller uuid;
  v_counters jsonb;
  v_script jsonb;
  v_ability jsonb;
  v_cost integer;
  v_loyalty integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select * into v_turn
  from public.game_turn_state where session_id = p_session_id for update;
  if not found then
    raise exception 'Turn state not found';
  end if;

  -- Sorcery speed: your turn, a main phase, you have priority, the stack is empty.
  if v_turn.active_player_id <> auth.uid() then
    raise exception 'Loyalty abilities can only be activated on your own turn';
  end if;
  if v_turn.step not in ('precombat_main', 'postcombat_main') then
    raise exception 'Loyalty abilities can only be activated during a main phase';
  end if;
  if coalesce(v_turn.priority_player_id, v_turn.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can activate a loyalty ability';
  end if;
  if exists (select 1 from public.game_stack_items where session_id = p_session_id and status = 'pending') then
    raise exception 'Loyalty abilities can only be activated while the stack is empty';
  end if;

  select gc.zone, c.type_line, coalesce(gc.controller_player_id, gc.owner_id), gc.counters
    into v_zone, v_type_line, v_controller, v_counters
  from public.game_cards gc
  join public.cards c on c.id = gc.card_id
  where gc.id = p_source_card_id and gc.session_id = p_session_id;
  if not found then
    raise exception 'Source card not found';
  end if;
  if v_controller <> auth.uid() then
    raise exception 'You do not control this planeswalker';
  end if;
  if v_zone <> 'battlefield' then
    raise exception 'Planeswalker must be on the battlefield';
  end if;
  if v_type_line not ilike '%planeswalker%' then
    raise exception 'Source is not a planeswalker';
  end if;

  -- One loyalty ability per planeswalker per turn.
  if coalesce((v_counters ->> 'loyalty_turn')::integer, -1) = v_turn.turn_number then
    raise exception 'This planeswalker already activated a loyalty ability this turn';
  end if;

  v_script := public.effective_script(p_session_id, p_source_card_id);
  v_ability := v_script -> 'loyalty_abilities' -> p_ability_index;
  if v_ability is null then
    raise exception 'Loyalty ability not found at index %', p_ability_index;
  end if;
  v_cost := coalesce((v_ability ->> 'cost')::integer, 0);

  v_loyalty := coalesce((v_counters ->> 'loyalty')::integer, 0);
  if v_loyalty + v_cost < 0 then
    raise exception 'Not enough loyalty: have %, ability costs %', v_loyalty, v_cost;
  end if;

  -- Pay the loyalty cost and mark the ability used this turn.
  update public.game_cards
  set counters = jsonb_set(
        public.adjust_counter_bag(coalesce(counters, '{}'::jsonb), 'loyalty', v_cost),
        '{loyalty_turn}', to_jsonb(v_turn.turn_number))
  where id = p_source_card_id and session_id = p_session_id;

  -- The ability's effects go on the stack with the planeswalker as source.
  perform public.enqueue_triggered_ability(
    p_session_id, auth.uid(), p_source_card_id, 'loyalty', v_ability -> 'effects');

  -- 0-loyalty SBA (an ultimate that pays the planeswalker to 0 kills it; its ability
  -- still resolves off the stack).
  perform public.move_zero_loyalty_planeswalkers_to_graveyard(p_session_id);
end;
$$;
grant execute on function public.activate_loyalty_ability(uuid, uuid, integer) to authenticated;
grant execute on function public.activate_loyalty_ability(uuid, uuid, integer) to service_role;
