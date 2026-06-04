


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';


SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."game_stack_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "controller_player_id" "uuid" NOT NULL,
    "source_card_id" "uuid",
    "action_type" "text" NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "position" integer NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_at" timestamp with time zone,
    CONSTRAINT "game_stack_items_action_type_check" CHECK (("action_type" = ANY (ARRAY['deal_damage_player'::"text", 'deal_damage_creature'::"text", 'pump_creature'::"text", 'cast_permanent'::"text", 'counter_spell'::"text", 'triggered_ability'::"text", 'draw_cards'::"text", 'destroy_creature'::"text", 'bounce_creature'::"text", 'tap_creature'::"text", 'untap_creature'::"text", 'add_counters_creature'::"text", 'exile_creature'::"text"]))),
    CONSTRAINT "game_stack_items_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'resolved'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."game_stack_items" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."activate_ability"("p_session_id" "uuid", "p_source_card_id" "uuid", "p_ability_index" integer DEFAULT 0, "p_target_player_id" "uuid" DEFAULT NULL::"uuid", "p_target_card_id" "uuid" DEFAULT NULL::"uuid", "p_generic_payment" "jsonb" DEFAULT NULL::"jsonb") RETURNS "public"."game_stack_items"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_turn public.game_turn_state;
  v_zone text;
  v_script jsonb;
  v_ability jsonb;
  v_cost jsonb;
  v_effect jsonb;
  v_has_tap boolean := false;
  v_mana_cost text := null;
  v_amount integer;
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

  -- Parse costs
  for v_cost in select * from jsonb_array_elements(coalesce(v_ability -> 'costs', '[]'::jsonb))
  loop
    case v_cost ->> 'type'
      when 'tap_self' then v_has_tap := true;
      when 'mana' then v_mana_cost := v_cost ->> 'amount';
      else raise exception 'Unsupported ability cost: %', v_cost ->> 'type';
    end case;
  end loop;

  -- Tap cost requires the source to be untapped
  if v_has_tap and exists (
    select 1 from public.game_cards where id = p_source_card_id and is_tapped = true
  ) then
    raise exception 'Source is already tapped';
  end if;

  -- Pay mana cost (raises if the player cannot pay)
  if v_mana_cost is not null then
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_mana_cost, p_generic_payment);
  end if;

  -- Pay the tap cost
  if v_has_tap then
    update public.game_cards
    set is_tapped = true
    where id = p_source_card_id and session_id = p_session_id;
  end if;

  -- Apply the (single) effect by putting it on the stack
  v_effect := v_ability -> 'effects' -> 0;

  if v_effect is null then
    raise exception 'Activated ability has no effect';
  end if;

  if v_effect ->> 'type' = 'deal_damage' then
    v_amount := coalesce((v_effect ->> 'amount')::integer, 0);
    if v_amount <= 0 then
      raise exception 'Invalid damage amount';
    end if;

    if p_target_card_id is not null then
      v_stack := public.put_action_on_stack(
        p_session_id,
        'deal_damage_creature',
        jsonb_build_object('target_card_id', p_target_card_id, 'amount', v_amount, 'timing', 'instant'),
        p_source_card_id
      );
    elsif p_target_player_id is not null then
      v_stack := public.put_action_on_stack(
        p_session_id,
        'deal_damage_player',
        jsonb_build_object('target_player_id', p_target_player_id, 'amount', v_amount, 'timing', 'instant'),
        p_source_card_id
      );
    else
      raise exception 'A target is required for this ability';
    end if;
  else
    raise exception 'Unsupported ability effect: %', v_effect ->> 'type';
  end if;

  return v_stack;
end;
$$;


ALTER FUNCTION "public"."activate_ability"("p_session_id" "uuid", "p_source_card_id" "uuid", "p_ability_index" integer, "p_target_player_id" "uuid", "p_target_card_id" "uuid", "p_generic_payment" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."add_mana_from_card"("p_game_card_id" "uuid", "p_session_id" "uuid", "p_player_id" "uuid", "p_color" "text", "p_amount" integer, "p_should_tap_card" boolean DEFAULT true) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_session_status text;
  v_current_pool jsonb;
  v_new_pool jsonb;
  v_current_amount integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_color not in ('W', 'U', 'B', 'R', 'G', 'C') then
    raise exception 'Invalid mana color: %', p_color;
  end if;

  if p_amount <= 0 then
    raise exception 'Mana amount must be positive';
  end if;

  if p_player_id <> auth.uid() then
    raise exception 'Cannot update another player mana pool';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select status
  into v_session_status
  from public.game_sessions
  where id = p_session_id;

  if not found then
    raise exception 'Game session not found';
  end if;

  if v_session_status = 'finished' then
    raise exception 'Cannot add mana in a finished game session';
  end if;

  if p_should_tap_card then
    update public.game_cards
    set is_tapped = true
    where id = p_game_card_id
      and session_id = p_session_id
      and owner_id = auth.uid()
      and zone = 'battlefield'
      and is_tapped = false;

    if not found then
      raise exception 'Card not found, not on battlefield, not owned by current user, or already tapped';
    end if;
  else
    perform 1
    from public.game_cards
    where id = p_game_card_id
      and session_id = p_session_id
      and owner_id = auth.uid()
      and zone = 'battlefield';

    if not found then
      raise exception 'Card not found, not on battlefield, or not owned by current user';
    end if;
  end if;

  insert into public.game_players (session_id, player_id, mana_pool)
  values (
    p_session_id,
    p_player_id,
    jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0)
  )
  on conflict (session_id, player_id) do nothing;

  select coalesce(
    mana_pool,
    jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0)
  )
  into v_current_pool
  from public.game_players
  where session_id = p_session_id
    and player_id = p_player_id
  for update;

  v_current_amount := coalesce((v_current_pool ->> p_color)::integer, 0);
  v_new_pool := v_current_pool || jsonb_build_object(p_color, v_current_amount + p_amount);

  update public.game_players
  set mana_pool = v_new_pool
  where session_id = p_session_id
    and player_id = p_player_id;

  return v_new_pool;
end;
$$;


ALTER FUNCTION "public"."add_mana_from_card"("p_game_card_id" "uuid", "p_session_id" "uuid", "p_player_id" "uuid", "p_color" "text", "p_amount" integer, "p_should_tap_card" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."adjust_card_counters"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_delta" integer) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_new_count integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  update public.game_cards
  set plus_one_counters = greatest(0, plus_one_counters + p_delta)
  where id = p_game_card_id
    and session_id = p_session_id
  returning plus_one_counters into v_new_count;

  if not found then
    raise exception 'Card not found in this session';
  end if;

  -- Adding counters can lift a creature above lethal marked damage; removing
  -- counters can drop it below. Re-check lethal state after the change.
  perform public.move_lethal_damaged_creatures_to_graveyard(p_session_id);

  return v_new_count;
end;
$$;


ALTER FUNCTION "public"."adjust_card_counters"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_delta" integer) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."game_session_players" (
    "session_id" "uuid" NOT NULL,
    "player_id" "uuid" NOT NULL,
    "seat_number" integer NOT NULL,
    "life_total" integer DEFAULT 20 NOT NULL,
    "joined_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "game_session_players_life_total_check" CHECK (("life_total" >= 0))
);


ALTER TABLE "public"."game_session_players" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."adjust_player_life"("p_session_id" "uuid", "p_target_player_id" "uuid", "p_delta" integer) RETURNS "public"."game_session_players"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_session_status text;
  v_player public.game_session_players;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_delta = 0 then
    raise exception 'Life total delta cannot be zero';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if not public.is_session_player(p_session_id, p_target_player_id) then
    raise exception 'Target player is not a player in this session';
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
    raise exception 'Cannot change life totals in a finished game session';
  end if;

  update public.game_session_players
  set life_total = greatest(0, life_total + p_delta)
  where session_id = p_session_id
    and player_id = p_target_player_id
  returning * into v_player;

  if not found then
    raise exception 'Target player not found';
  end if;

  perform public.maybe_finish_game_session(p_session_id);

  return v_player;
end;
$$;


ALTER FUNCTION "public"."adjust_player_life"("p_session_id" "uuid", "p_target_player_id" "uuid", "p_delta" integer) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."game_turn_state" (
    "session_id" "uuid" NOT NULL,
    "active_player_id" "uuid" NOT NULL,
    "turn_number" integer DEFAULT 1 NOT NULL,
    "phase" "text" DEFAULT 'beginning'::"text" NOT NULL,
    "step" "text" DEFAULT 'untap'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "priority_player_id" "uuid",
    "priority_cycle_started_by" "uuid",
    "priority_pass_count" integer DEFAULT 0 NOT NULL,
    "lands_played_this_turn" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "game_turn_state_lands_played_this_turn_check" CHECK (("lands_played_this_turn" >= 0)),
    CONSTRAINT "game_turn_state_phase_check" CHECK (("phase" = ANY (ARRAY['beginning'::"text", 'main_1'::"text", 'combat'::"text", 'main_2'::"text", 'ending'::"text"]))),
    CONSTRAINT "game_turn_state_priority_pass_count_check" CHECK (("priority_pass_count" >= 0)),
    CONSTRAINT "game_turn_state_step_check" CHECK (("step" = ANY (ARRAY['untap'::"text", 'upkeep'::"text", 'draw'::"text", 'precombat_main'::"text", 'beginning_of_combat'::"text", 'declare_attackers'::"text", 'declare_blockers'::"text", 'combat_damage'::"text", 'end_of_combat'::"text", 'postcombat_main'::"text", 'end'::"text", 'cleanup'::"text"])))
);


ALTER TABLE "public"."game_turn_state" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."advance_step"("p_session_id" "uuid") RETURNS "public"."game_turn_state"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_current_state public.game_turn_state;
  v_session_status text;
  v_required_player_id uuid;
  v_next_active_player_id uuid;
  v_next_priority_player_id uuid;
  v_next_phase text;
  v_next_step text;
  v_next_turn_number integer;
  v_next_lands_played_this_turn integer;
  v_drawn_card_id uuid;
  v_next_hand_position integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
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
    raise exception 'Cannot advance a finished game session';
  end if;

  select *
  into v_current_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  v_required_player_id := coalesce(v_current_state.priority_player_id, v_current_state.active_player_id);

  if v_required_player_id <> auth.uid() then
    raise exception 'Only the priority player can advance the step';
  end if;

  perform public.clear_mana_pool_for_step(
    p_session_id,
    v_current_state.phase,
    v_current_state.step
  );

  perform public.expire_continuous_effects_for_step(
    p_session_id,
    v_current_state.turn_number,
    v_current_state.phase,
    v_current_state.step
  );

  v_next_active_player_id := v_current_state.active_player_id;
  v_next_priority_player_id := v_current_state.active_player_id;
  v_next_turn_number := v_current_state.turn_number;
  v_next_lands_played_this_turn := coalesce(v_current_state.lands_played_this_turn, 0);
  v_next_phase := v_current_state.phase;
  v_next_step := v_current_state.step;

  case v_current_state.step
    when 'untap' then
      delete from public.game_combat_assignments
      where session_id = p_session_id;

      update public.game_cards
      set is_tapped = false
      where session_id = p_session_id
        and owner_id = v_current_state.active_player_id
        and zone = 'battlefield'
        and is_tapped = true;

      v_next_phase := 'beginning';
      v_next_step := 'upkeep';
    when 'upkeep' then
      v_next_phase := 'beginning';
      v_next_step := 'draw';
    when 'draw' then
      select coalesce(max(zone_position), -1) + 1
      into v_next_hand_position
      from public.game_cards
      where session_id = p_session_id
        and owner_id = v_current_state.active_player_id
        and zone = 'hand';

      select id
      into v_drawn_card_id
      from public.game_cards
      where session_id = p_session_id
        and owner_id = v_current_state.active_player_id
        and zone = 'library'
      order by zone_position asc, id asc
      limit 1
      for update skip locked;

      if v_drawn_card_id is null then
        raise exception 'Library is empty';
      end if;

      update public.game_cards
      set
        zone = 'hand',
        zone_position = v_next_hand_position,
        is_tapped = false,
        damage_marked = 0
      where id = v_drawn_card_id;

      v_next_phase := 'main_1';
      v_next_step := 'precombat_main';
    when 'precombat_main' then
      v_next_phase := 'combat';
      v_next_step := 'beginning_of_combat';
    when 'beginning_of_combat' then
      v_next_phase := 'combat';
      v_next_step := 'declare_attackers';
    when 'declare_attackers' then
      v_next_phase := 'combat';
      v_next_step := 'declare_blockers';

      select defending_player_id
      into v_next_priority_player_id
      from public.game_combat_assignments
      where session_id = p_session_id
        and turn_number = v_current_state.turn_number
        and blocker_card_id is null
      order by created_at
      limit 1;

      v_next_priority_player_id := coalesce(v_next_priority_player_id, v_current_state.active_player_id);
    when 'declare_blockers' then
      v_next_priority_player_id := v_current_state.active_player_id;
      v_next_phase := 'combat';
      v_next_step := 'combat_damage';
    when 'combat_damage' then
      v_next_phase := 'combat';
      v_next_step := 'end_of_combat';
    when 'end_of_combat' then
      delete from public.game_combat_assignments
      where session_id = p_session_id;

      v_next_phase := 'main_2';
      v_next_step := 'postcombat_main';
    when 'postcombat_main' then
      v_next_phase := 'ending';
      v_next_step := 'end';
    when 'end' then
      v_next_phase := 'ending';
      v_next_step := 'cleanup';
    when 'cleanup' then
      delete from public.game_combat_assignments
      where session_id = p_session_id;

      update public.game_cards
      set damage_marked = 0
      where session_id = p_session_id
        and damage_marked <> 0;

      select next_player.player_id
      into v_next_active_player_id
      from public.game_session_players current_player
      join public.game_session_players next_player
        on next_player.session_id = current_player.session_id
       and next_player.seat_number > current_player.seat_number
      where current_player.session_id = p_session_id
        and current_player.player_id = v_current_state.active_player_id
      order by next_player.seat_number
      limit 1;

      if v_next_active_player_id is null then
        select player_id
        into v_next_active_player_id
        from public.game_session_players
        where session_id = p_session_id
        order by seat_number
        limit 1;
      end if;

      if v_next_active_player_id is null then
        raise exception 'No players found for game session';
      end if;

      v_next_priority_player_id := v_next_active_player_id;
      v_next_turn_number := v_current_state.turn_number + 1;
      v_next_lands_played_this_turn := 0;
      v_next_phase := 'beginning';
      v_next_step := 'untap';
    else
      raise exception 'Unsupported turn step: %', v_current_state.step;
  end case;

  update public.game_turn_state
  set
    active_player_id = v_next_active_player_id,
    priority_player_id = v_next_priority_player_id,
    priority_cycle_started_by = null,
    priority_pass_count = 0,
    lands_played_this_turn = v_next_lands_played_this_turn,
    turn_number = v_next_turn_number,
    phase = v_next_phase,
    step = v_next_step
  where session_id = p_session_id
  returning * into v_current_state;

  return v_current_state;
end;
$$;


ALTER FUNCTION "public"."advance_step"("p_session_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."apply_creature_effect"("p_session_id" "uuid", "p_kind" "text", "p_target_card_id" "uuid", "p_params" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_amount integer := coalesce((p_params ->> 'amount')::integer, 0);
  v_target_owner_id uuid;
  v_next_position integer;
begin
  if p_target_card_id is null then
    return;
  end if;

  if p_kind = 'deal_damage' then
    if v_amount > 0 then
      update public.game_cards
      set damage_marked = damage_marked + v_amount
      where id = p_target_card_id
        and session_id = p_session_id
        and zone = 'battlefield';

      perform public.move_lethal_damaged_creatures_to_graveyard(p_session_id);
    end if;

  elsif p_kind = 'destroy' then
    perform public.put_in_graveyard(p_session_id, p_target_card_id);

  elsif p_kind = 'exile' then
    select owner_id
    into v_target_owner_id
    from public.game_cards
    where id = p_target_card_id
      and session_id = p_session_id
      and zone = 'battlefield';

    if found then
      select coalesce(max(zone_position), -1) + 1
      into v_next_position
      from public.game_cards
      where session_id = p_session_id
        and owner_id = v_target_owner_id
        and zone = 'exile';

      update public.game_cards
      set
        zone = 'exile',
        zone_position = v_next_position,
        controller_player_id = owner_id,
        is_tapped = false,
        damage_marked = 0,
        dealt_deathtouch_damage = false,
        plus_one_counters = 0
      where id = p_target_card_id;
    end if;

  elsif p_kind = 'bounce' then
    select owner_id
    into v_target_owner_id
    from public.game_cards
    where id = p_target_card_id
      and session_id = p_session_id
      and zone = 'battlefield';

    if found then
      select coalesce(max(zone_position), -1) + 1
      into v_next_position
      from public.game_cards
      where session_id = p_session_id
        and owner_id = v_target_owner_id
        and zone = 'hand';

      update public.game_cards
      set
        zone = 'hand',
        zone_position = v_next_position,
        controller_player_id = owner_id,
        is_tapped = false,
        damage_marked = 0,
        dealt_deathtouch_damage = false,
        plus_one_counters = 0
      where id = p_target_card_id;
    end if;

  elsif p_kind in ('tap', 'untap') then
    update public.game_cards
    set is_tapped = (p_kind = 'tap')
    where id = p_target_card_id
      and session_id = p_session_id
      and zone = 'battlefield';

  elsif p_kind = 'add_counters' then
    if v_amount > 0 then
      update public.game_cards
      set plus_one_counters = greatest(0, plus_one_counters + v_amount)
      where id = p_target_card_id
        and session_id = p_session_id
        and zone = 'battlefield';
    end if;

  elsif p_kind = 'pump' then
    if exists (
      select 1 from public.game_cards
      where id = p_target_card_id
        and session_id = p_session_id
        and zone = 'battlefield'
    ) then
      perform public.create_pt_pump(
        p_session_id,
        p_target_card_id,
        coalesce((p_params ->> 'power')::integer, 0),
        coalesce((p_params ->> 'toughness')::integer, 0)
      );
    end if;

  else
    raise exception 'Unsupported creature effect kind: %', p_kind;
  end if;
end;
$$;


ALTER FUNCTION "public"."apply_creature_effect"("p_session_id" "uuid", "p_kind" "text", "p_target_card_id" "uuid", "p_params" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."apply_targeted_triggered_ability_effects"("p_session_id" "uuid", "p_controller_id" "uuid", "p_source_card_id" "uuid", "p_effects" "jsonb", "p_target_card_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_effect jsonb;
  v_eff_type text;
begin
  for v_effect in
    select * from jsonb_array_elements(coalesce(p_effects, '[]'::jsonb))
  loop
    if not public.trigger_effect_requires_creature_target(v_effect) then
      perform public.apply_triggered_ability_effects(
        p_session_id,
        p_controller_id,
        p_source_card_id,
        jsonb_build_array(v_effect)
      );
      continue;
    end if;

    -- Targeted trigger effects fizzle harmlessly if the target is gone; the
    -- primitive re-checks the target is on the battlefield per mutation.
    v_eff_type := lower(coalesce(v_effect ->> 'type', ''));

    perform public.apply_creature_effect(
      p_session_id,
      v_eff_type,
      p_target_card_id,
      jsonb_build_object('amount', coalesce((v_effect ->> 'amount')::integer, 0))
    );
  end loop;
end;
$$;


ALTER FUNCTION "public"."apply_targeted_triggered_ability_effects"("p_session_id" "uuid", "p_controller_id" "uuid", "p_source_card_id" "uuid", "p_effects" "jsonb", "p_target_card_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."apply_triggered_ability_effects"("p_session_id" "uuid", "p_controller_id" "uuid", "p_source_card_id" "uuid", "p_effects" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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
begin
  for v_effect in
    select * from jsonb_array_elements(coalesce(p_effects, '[]'::jsonb))
  loop
    v_eff_type := lower(coalesce(v_effect ->> 'type', ''));
    v_eff_amount := coalesce((v_effect ->> 'amount')::integer, 0);
    v_recipient := lower(coalesce(v_effect ->> 'recipient', ''));

    if v_eff_type = 'gain_life' then
      if v_eff_amount > 0 and p_controller_id is not null then
        update public.game_session_players
        set life_total = life_total + v_eff_amount
        where session_id = p_session_id
          and player_id = p_controller_id;
      end if;

    elsif v_eff_type in ('lose_life', 'deal_damage') then
      if v_eff_amount > 0 then
        if v_recipient = 'controller' then
          v_recipients := array[p_controller_id];
        else
          select array_agg(player_id)
          into v_recipients
          from public.game_session_players
          where session_id = p_session_id
            and player_id is distinct from p_controller_id;
        end if;

        foreach v_rid in array coalesce(v_recipients, array[]::uuid[])
        loop
          update public.game_session_players
          set life_total = greatest(0, life_total - v_eff_amount)
          where session_id = p_session_id
            and player_id = v_rid;
        end loop;
      end if;

    elsif v_eff_type = 'draw' then
      if p_controller_id is not null then
        for v_draw_i in 1..greatest(1, v_eff_amount) loop
          select coalesce(max(zone_position), -1) + 1
          into v_next_hand_position
          from public.game_cards
          where session_id = p_session_id
            and owner_id = p_controller_id
            and zone = 'hand';

          select id
          into v_lib_card
          from public.game_cards
          where session_id = p_session_id
            and owner_id = p_controller_id
            and zone = 'library'
          order by zone_position asc, id asc
          limit 1
          for update skip locked;

          exit when v_lib_card is null;

          update public.game_cards
          set zone = 'hand', zone_position = v_next_hand_position, is_tapped = false
          where id = v_lib_card;
        end loop;
      end if;

    elsif v_eff_type = 'mill' then
      -- A recipient mills N cards from the top of their library to their graveyard.
      if v_eff_amount > 0 then
        if v_recipient = 'controller' or v_recipient = '' then
          v_recipients := array[p_controller_id];
        elsif v_recipient in ('each_player', 'all_players') then
          select array_agg(player_id)
          into v_recipients
          from public.game_session_players
          where session_id = p_session_id;
        else
          -- each_opponent
          select array_agg(player_id)
          into v_recipients
          from public.game_session_players
          where session_id = p_session_id
            and player_id is distinct from p_controller_id;
        end if;

        foreach v_rid in array coalesce(v_recipients, array[]::uuid[])
        loop
          if v_rid is not null then
            for v_draw_i in 1..v_eff_amount loop
              select coalesce(max(zone_position), -1) + 1
              into v_next_graveyard_position
              from public.game_cards
              where session_id = p_session_id
                and owner_id = v_rid
                and zone = 'graveyard';

              select id
              into v_lib_card
              from public.game_cards
              where session_id = p_session_id
                and owner_id = v_rid
                and zone = 'library'
              order by zone_position asc, id asc
              limit 1
              for update skip locked;

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

      select id
      into v_token_card_id
      from public.cards
      where lower(name) = lower(coalesce(v_effect ->> 'token', ''))
        and is_token = true
      limit 1;

      if found and p_controller_id is not null then
        select turn_number
        into v_turn_number
        from public.game_turn_state
        where session_id = p_session_id;

        for v_i in 1..least(v_token_count, 20) loop
          select coalesce(max(zone_position), -1) + 1
          into v_next_pos
          from public.game_cards
          where session_id = p_session_id
            and owner_id = p_controller_id
            and zone = 'battlefield';

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
      -- +1/+1 counters on the source permanent (e.g. "put a +1/+1 counter on it").
      if p_source_card_id is not null and v_eff_amount <> 0 then
        update public.game_cards
        set plus_one_counters = greatest(0, plus_one_counters + v_eff_amount)
        where id = p_source_card_id
          and session_id = p_session_id
          and zone = 'battlefield';

        -- Removing counters can drop a creature to lethal / 0 toughness.
        perform public.move_lethal_damaged_creatures_to_graveyard(p_session_id);
      end if;
    end if;
    -- Unknown effect types are ignored (forward-compatible).
  end loop;
end;
$$;


ALTER FUNCTION "public"."apply_triggered_ability_effects"("p_session_id" "uuid", "p_controller_id" "uuid", "p_source_card_id" "uuid", "p_effects" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."behavior_target_controller"("p_effect" "jsonb") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select case lower(coalesce(p_effect ->> 'target_controller', ''))
    when 'opponent' then 'opponent'
    when 'you' then 'you'
    when 'self' then 'you'
    when 'controller' then 'you'
    else 'any'
  end;
$$;


ALTER FUNCTION "public"."behavior_target_controller"("p_effect" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."behavior_target_type_is_creature_only"("p_target_type" "jsonb") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select
    case
      when p_target_type is null then false
      when jsonb_typeof(p_target_type) = 'string' then
        lower(trim(both '"' from p_target_type::text)) = 'creature'
      when jsonb_typeof(p_target_type) = 'array' then
        jsonb_array_length(p_target_type) > 0
        and not exists (
          select 1
          from jsonb_array_elements_text(p_target_type) as t(value)
          where lower(t.value) <> 'creature'
        )
      else false
    end;
$$;


ALTER FUNCTION "public"."behavior_target_type_is_creature_only"("p_target_type" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."behavior_target_type_matches"("p_target_type" "jsonb", "p_want" "text") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select
    case
      when p_target_type is null then false
      when jsonb_typeof(p_target_type) = 'string' then
        lower(trim(both '"' from p_target_type::text)) in (lower(p_want), 'any')
      when jsonb_typeof(p_target_type) = 'array' then
        exists (
          select 1
          from jsonb_array_elements_text(p_target_type) as target_types(value)
          where lower(target_types.value) in (lower(p_want), 'any')
        )
      else false
    end;
$$;


ALTER FUNCTION "public"."behavior_target_type_matches"("p_target_type" "jsonb", "p_want" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."card_behavior_has_continuous_effects"("p_script" "jsonb") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
  select jsonb_array_length(public.get_card_behavior_continuous_effects(p_script)) > 0;
$$;


ALTER FUNCTION "public"."card_behavior_has_continuous_effects"("p_script" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."card_effective_power"("p_session_id" "uuid", "p_game_card_id" "uuid") RETURNS integer
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
  select
    coalesce(
      cards.power,
      case
        when cards.power_toughness ~ '^[0-9]+/[0-9]+$'
          then split_part(cards.power_toughness, '/', 1)::integer
        else 0
      end,
      0
    )
    + coalesce(game_cards.plus_one_counters, 0)
    + coalesce((
        select sum(coalesce((effects.payload ->> 'power')::integer, 0))
        from public.game_continuous_effects effects
        left join public.game_cards source_card
          on source_card.id = effects.source_card_id
        where effects.session_id = p_session_id
          and effects.effect_type = 'pump'
          and effects.affected_card_id = p_game_card_id
          and (
            effects.source_zone_required is null
            or source_card.zone = effects.source_zone_required
          )
      ), 0)
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id;
$_$;


ALTER FUNCTION "public"."card_effective_power"("p_session_id" "uuid", "p_game_card_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."card_effective_toughness"("p_session_id" "uuid", "p_game_card_id" "uuid") RETURNS integer
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
  select
    coalesce(
      cards.toughness,
      case
        when cards.power_toughness ~ '^[0-9]+/[0-9]+$'
          then split_part(cards.power_toughness, '/', 2)::integer
        else 0
      end,
      0
    )
    + coalesce(game_cards.plus_one_counters, 0)
    + coalesce((
        select sum(coalesce((effects.payload ->> 'toughness')::integer, 0))
        from public.game_continuous_effects effects
        left join public.game_cards source_card
          on source_card.id = effects.source_card_id
        where effects.session_id = p_session_id
          and effects.effect_type = 'pump'
          and effects.affected_card_id = p_game_card_id
          and (
            effects.source_zone_required is null
            or source_card.zone = effects.source_zone_required
          )
      ), 0)
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id;
$_$;


ALTER FUNCTION "public"."card_effective_toughness"("p_session_id" "uuid", "p_game_card_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."card_has_deathtouch"("p_session_id" "uuid", "p_game_card_id" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.game_continuous_effects effects
    left join public.game_cards source_card
      on source_card.id = effects.source_card_id
    where effects.session_id = p_session_id
      and effects.effect_type = 'deathtouch'
      and public.is_session_player(p_session_id, auth.uid())
      and (
        effects.affected_card_id = p_game_card_id
        or effects.affected_card_id is null
      )
      and (
        effects.source_zone_required is null
        or source_card.zone = effects.source_zone_required
      )
  );
$$;


ALTER FUNCTION "public"."card_has_deathtouch"("p_session_id" "uuid", "p_game_card_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."card_has_double_strike"("p_session_id" "uuid", "p_game_card_id" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.game_continuous_effects effects
    left join public.game_cards source_card
      on source_card.id = effects.source_card_id
    where effects.session_id = p_session_id
      and effects.effect_type = 'double_strike'
      and public.is_session_player(p_session_id, auth.uid())
      and (
        effects.affected_card_id = p_game_card_id
        or effects.affected_card_id is null
      )
      and (
        effects.source_zone_required is null
        or source_card.zone = effects.source_zone_required
      )
  );
$$;


ALTER FUNCTION "public"."card_has_double_strike"("p_session_id" "uuid", "p_game_card_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."card_has_first_strike"("p_session_id" "uuid", "p_game_card_id" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.game_continuous_effects effects
    left join public.game_cards source_card
      on source_card.id = effects.source_card_id
    where effects.session_id = p_session_id
      and effects.effect_type = 'first_strike'
      and public.is_session_player(p_session_id, auth.uid())
      and (
        effects.affected_card_id = p_game_card_id
        or effects.affected_card_id is null
      )
      and (
        effects.source_zone_required is null
        or source_card.zone = effects.source_zone_required
      )
  );
$$;


ALTER FUNCTION "public"."card_has_first_strike"("p_session_id" "uuid", "p_game_card_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."card_has_flying"("p_session_id" "uuid", "p_game_card_id" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.game_continuous_effects effects
    left join public.game_cards source_card
      on source_card.id = effects.source_card_id
    where effects.session_id = p_session_id
      and effects.effect_type = 'flying'
      and public.is_session_player(p_session_id, auth.uid())
      and (
        effects.affected_card_id = p_game_card_id
        or effects.affected_card_id is null
      )
      and (
        effects.source_zone_required is null
        or source_card.zone = effects.source_zone_required
      )
  );
$$;


ALTER FUNCTION "public"."card_has_flying"("p_session_id" "uuid", "p_game_card_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."card_has_haste"("p_session_id" "uuid", "p_game_card_id" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.game_continuous_effects effects
    left join public.game_cards source_card
      on source_card.id = effects.source_card_id
    where effects.session_id = p_session_id
      and effects.effect_type = 'haste'
      and public.is_session_player(p_session_id, auth.uid())
      and (
        effects.affected_card_id = p_game_card_id
        or effects.affected_card_id is null
      )
      and (
        effects.source_zone_required is null
        or source_card.zone = effects.source_zone_required
      )
  );
$$;


ALTER FUNCTION "public"."card_has_haste"("p_session_id" "uuid", "p_game_card_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."card_has_indestructible"("p_session_id" "uuid", "p_game_card_id" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.game_continuous_effects effects
    left join public.game_cards source_card
      on source_card.id = effects.source_card_id
    where effects.session_id = p_session_id
      and effects.effect_type = 'indestructible'
      and public.is_session_player(p_session_id, auth.uid())
      and (
        effects.affected_card_id = p_game_card_id
        or effects.affected_card_id is null
      )
      and (
        effects.source_zone_required is null
        or source_card.zone = effects.source_zone_required
      )
  );
$$;


ALTER FUNCTION "public"."card_has_indestructible"("p_session_id" "uuid", "p_game_card_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."card_has_reach"("p_session_id" "uuid", "p_game_card_id" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.game_continuous_effects effects
    left join public.game_cards source_card
      on source_card.id = effects.source_card_id
    where effects.session_id = p_session_id
      and effects.effect_type = 'reach'
      and public.is_session_player(p_session_id, auth.uid())
      and (
        effects.affected_card_id = p_game_card_id
        or effects.affected_card_id is null
      )
      and (
        effects.source_zone_required is null
        or source_card.zone = effects.source_zone_required
      )
  );
$$;


ALTER FUNCTION "public"."card_has_reach"("p_session_id" "uuid", "p_game_card_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."card_has_trample"("p_session_id" "uuid", "p_game_card_id" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.game_continuous_effects effects
    left join public.game_cards source_card
      on source_card.id = effects.source_card_id
    where effects.session_id = p_session_id
      and effects.effect_type = 'trample'
      and public.is_session_player(p_session_id, auth.uid())
      and (
        effects.affected_card_id = p_game_card_id
        or effects.affected_card_id is null
      )
      and (
        effects.source_zone_required is null
        or source_card.zone = effects.source_zone_required
      )
  );
$$;


ALTER FUNCTION "public"."card_has_trample"("p_session_id" "uuid", "p_game_card_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."card_has_vigilance"("p_session_id" "uuid", "p_game_card_id" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.game_continuous_effects effects
    left join public.game_cards source_card
      on source_card.id = effects.source_card_id
    where effects.session_id = p_session_id
      and effects.effect_type = 'vigilance'
      and public.is_session_player(p_session_id, auth.uid())
      and (
        effects.affected_card_id = p_game_card_id
        or effects.affected_card_id is null
      )
      and (
        effects.source_zone_required is null
        or source_card.zone = effects.source_zone_required
      )
  );
$$;


ALTER FUNCTION "public"."card_has_vigilance"("p_session_id" "uuid", "p_game_card_id" "uuid") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."game_cards" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "card_id" "uuid" NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "zone" "text" DEFAULT 'library'::"text",
    "is_tapped" boolean DEFAULT false,
    "position_x" smallint DEFAULT 0,
    "position_y" smallint DEFAULT 0,
    "inserted_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()),
    "zone_position" integer DEFAULT 0 NOT NULL,
    "damage_marked" integer DEFAULT 0 NOT NULL,
    "controller_player_id" "uuid",
    "copied_script" "jsonb",
    "static_effects_suppressed" boolean DEFAULT false NOT NULL,
    "entered_battlefield_turn_number" integer,
    "is_face_down" boolean DEFAULT false NOT NULL,
    "dealt_deathtouch_damage" boolean DEFAULT false NOT NULL,
    "plus_one_counters" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "game_cards_damage_marked_check" CHECK (("damage_marked" >= 0)),
    CONSTRAINT "game_cards_zone_check" CHECK (("zone" = ANY (ARRAY['library'::"text", 'hand'::"text", 'stack'::"text", 'battlefield'::"text", 'graveyard'::"text", 'exile'::"text"])))
);


ALTER TABLE "public"."game_cards" OWNER TO "postgres";


COMMENT ON COLUMN "public"."game_cards"."is_face_down" IS 'True when the card is in exile face-down and should not be revealed to other players.';



COMMENT ON COLUMN "public"."game_cards"."dealt_deathtouch_damage" IS 'True when this creature was dealt damage by a deathtouch source during the current combat damage resolution. Read by the lethal-damage mover, cleared after each resolve.';



COMMENT ON COLUMN "public"."game_cards"."plus_one_counters" IS 'Number of +1/+1 counters on this permanent. Each raises effective power and toughness by 1.';



CREATE OR REPLACE FUNCTION "public"."cast_card_from_hand"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_generic_payment" "jsonb" DEFAULT NULL::"jsonb") RETURNS "public"."game_cards"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_card public.game_cards;
  v_card_type_line text;
  v_card_mana_cost text;
  v_pending_stack_count integer := 0;
  v_land_play_limit integer := 1;
  v_next_battlefield_position integer;
  v_next_stack_position integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
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
    raise exception 'Cannot cast cards in a finished game session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can cast cards';
  end if;

  select game_cards.*
  into v_card
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id
    and game_cards.owner_id = auth.uid()
    and game_cards.zone = 'hand'
  for update of game_cards;

  if not found then
    raise exception 'Card not found in hand or not owned by current user';
  end if;

  select cards.type_line, cards.mana_cost
  into v_card_type_line, v_card_mana_cost
  from public.cards
  where cards.id = v_card.card_id;

  if coalesce(v_card_type_line, '') ilike '%instant%'
    or coalesce(v_card_type_line, '') ilike '%sorcery%'
  then
    raise exception 'Use this spell action to cast instant and sorcery cards';
  end if;

  if v_turn_state.active_player_id <> auth.uid() then
    raise exception 'Cards can only be played by the active player in this first implementation';
  end if;

  if v_turn_state.step not in ('precombat_main', 'postcombat_main') then
    raise exception 'Cards can only be played during a main phase';
  end if;

  select count(*)
  into v_pending_stack_count
  from public.game_stack_items
  where session_id = p_session_id
    and status = 'pending';

  if v_pending_stack_count > 0 then
    raise exception 'Cards can only be played while the stack is empty';
  end if;

  if coalesce(v_card_type_line, '') ilike '%land%' then
    v_land_play_limit := public.get_land_play_limit(p_session_id, auth.uid());

    if coalesce(v_turn_state.lands_played_this_turn, 0) >= v_land_play_limit then
      raise exception 'You have already used all land plays this turn';
    end if;

    update public.game_turn_state
    set lands_played_this_turn = lands_played_this_turn + 1
    where session_id = p_session_id;

    select coalesce(max(zone_position), -1) + 1
    into v_next_battlefield_position
    from public.game_cards
    where session_id = p_session_id
      and owner_id = auth.uid()
      and zone = 'battlefield';

    update public.game_cards
    set
      zone = 'battlefield',
      zone_position = v_next_battlefield_position,
      entered_battlefield_turn_number = v_turn_state.turn_number,
      controller_player_id = coalesce(controller_player_id, owner_id),
      is_tapped = false,
      damage_marked = 0
    where id = p_game_card_id
    returning * into v_card;

    perform public.rebuild_scripted_continuous_effects(p_session_id);

    return v_card;
  end if;

  perform public.pay_mana_cost(p_session_id, auth.uid(), v_card_mana_cost, p_generic_payment);

  select coalesce(max(position), -1) + 1
  into v_next_stack_position
  from public.game_stack_items
  where session_id = p_session_id;

  update public.game_cards
  set
    zone = 'stack',
    zone_position = v_next_stack_position,
    is_tapped = false,
    damage_marked = 0
  where id = p_game_card_id
  returning * into v_card;

  insert into public.game_stack_items (
    session_id,
    controller_player_id,
    source_card_id,
    action_type,
    payload,
    position
  )
  values (
    p_session_id,
    auth.uid(),
    p_game_card_id,
    'cast_permanent',
    jsonb_build_object(
      'timing', 'sorcery',
      'card_id', v_card.card_id,
      'type_line', v_card_type_line
    ),
    v_next_stack_position
  );

  update public.game_turn_state
  set
    priority_player_id = active_player_id,
    priority_cycle_started_by = null,
    priority_pass_count = 0
  where session_id = p_session_id;

  return v_card;
end;
$$;


ALTER FUNCTION "public"."cast_card_from_hand"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_generic_payment" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cease_token_if_off_battlefield"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if NEW.zone is distinct from 'battlefield'
    and exists (select 1 from public.cards where id = NEW.card_id and is_token = true)
  then
    delete from public.game_continuous_effects
    where session_id = NEW.session_id
      and source_card_id = NEW.id;

    delete from public.game_cards
    where id = NEW.id;
  end if;

  return null;
end;
$$;


ALTER FUNCTION "public"."cease_token_if_off_battlefield"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."choose_triggered_ability_creature_target"("p_session_id" "uuid", "p_stack_item_id" "uuid", "p_target_card_id" "uuid") RETURNS "public"."game_stack_items"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_stack_item public.game_stack_items;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select *
  into v_stack_item
  from public.game_stack_items
  where id = p_stack_item_id
    and session_id = p_session_id
    and status = 'pending'
  for update;

  if not found then
    raise exception 'Triggered ability stack item not found';
  end if;

  if v_stack_item.action_type <> 'triggered_ability'
    or coalesce((v_stack_item.payload ->> 'target_required')::boolean, false) is not true
  then
    raise exception 'Stack item does not require a trigger target';
  end if;

  if v_stack_item.controller_player_id <> auth.uid() then
    raise exception 'Only the trigger controller can choose its target';
  end if;

  if not public.creature_target_controller_ok(
    p_session_id,
    p_target_card_id,
    v_stack_item.controller_player_id,
    coalesce(v_stack_item.payload ->> 'target_controller', 'any')
  ) then
    raise exception 'Target is not a legal creature for this ability';
  end if;

  update public.game_stack_items
  set payload = payload || jsonb_build_object(
    'target_card_id', p_target_card_id,
    'target_chosen', true
  )
  where id = v_stack_item.id
  returning * into v_stack_item;

  return v_stack_item;
end;
$$;


ALTER FUNCTION "public"."choose_triggered_ability_creature_target"("p_session_id" "uuid", "p_stack_item_id" "uuid", "p_target_card_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."clear_combat_assignments"("p_session_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_deleted_count integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  delete from public.game_combat_assignments
  where session_id = p_session_id;

  get diagnostics v_deleted_count = row_count;

  return v_deleted_count;
end;
$$;


ALTER FUNCTION "public"."clear_combat_assignments"("p_session_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."clear_mana_pool"("p_session_id" "uuid", "p_player_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_session_status text;
  v_empty_pool jsonb := jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0);
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_player_id <> auth.uid() then
    raise exception 'Cannot clear another player mana pool';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select status
  into v_session_status
  from public.game_sessions
  where id = p_session_id;

  if not found then
    raise exception 'Game session not found';
  end if;

  if v_session_status = 'finished' then
    raise exception 'Cannot clear mana in a finished game session';
  end if;

  insert into public.game_players (session_id, player_id, mana_pool)
  values (p_session_id, p_player_id, v_empty_pool)
  on conflict (session_id, player_id)
  do update set mana_pool = excluded.mana_pool;

  return v_empty_pool;
end;
$$;


ALTER FUNCTION "public"."clear_mana_pool"("p_session_id" "uuid", "p_player_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."clear_mana_pool_for_step"("p_session_id" "uuid", "p_phase" "text", "p_step" "text") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_empty_pool jsonb := jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0);
  v_player record;
  v_retained_colors text[];
  v_new_pool jsonb;
  v_color text;
  v_updated_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  for v_player in
    select
      player_id,
      coalesce(mana_pool, v_empty_pool) as mana_pool
    from public.game_players
    where session_id = p_session_id
    for update
  loop
    select coalesce(array_agg(distinct retained.color), '{}'::text[])
    into v_retained_colors
    from public.game_continuous_effects effects
    left join public.game_cards source_card
      on source_card.id = effects.source_card_id
    cross join lateral jsonb_array_elements_text(
      coalesce(effects.payload -> 'colors', '[]'::jsonb)
    ) as retained(color)
    where effects.session_id = p_session_id
      and effects.effect_type = 'mana_does_not_empty'
      and (effects.affected_player_id is null or effects.affected_player_id = v_player.player_id)
      and (
        effects.source_zone_required is null
        or source_card.zone = effects.source_zone_required
      );

    v_new_pool := v_empty_pool;

    foreach v_color in array array['W', 'U', 'B', 'R', 'G', 'C']
    loop
      if v_color = any(v_retained_colors) then
        v_new_pool := v_new_pool || jsonb_build_object(
          v_color,
          coalesce((v_player.mana_pool ->> v_color)::integer, 0)
        );
      end if;
    end loop;

    if v_new_pool <> v_player.mana_pool then
      update public.game_players
      set mana_pool = v_new_pool
      where session_id = p_session_id
        and player_id = v_player.player_id;

      v_updated_count := v_updated_count + 1;
    end if;
  end loop;

  return v_updated_count;
end;
$$;


ALTER FUNCTION "public"."clear_mana_pool_for_step"("p_session_id" "uuid", "p_phase" "text", "p_step" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_game_session"() RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_session_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  insert into public.game_sessions (created_by)
  values (auth.uid())
  returning id into v_session_id;

  insert into public.game_session_players (
    session_id,
    player_id,
    seat_number,
    life_total
  )
  values (
    v_session_id,
    auth.uid(),
    1,
    20
  );

  insert into public.game_turn_state (
    session_id,
    active_player_id,
    turn_number,
    phase,
    step
  )
  values (
    v_session_id,
    auth.uid(),
    1,
    'beginning',
    'untap'
  )
  on conflict (session_id) do nothing;

  return v_session_id;
end;
$$;


ALTER FUNCTION "public"."create_game_session"() OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."game_continuous_effects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "source_card_id" "uuid",
    "affected_player_id" "uuid",
    "affected_card_id" "uuid",
    "effect_type" "text" NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "expires_at_turn_number" integer,
    "expires_at_phase" "text",
    "expires_at_step" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source_zone_required" "text",
    CONSTRAINT "game_continuous_effects_effect_type_check" CHECK (("effect_type" = ANY (ARRAY['mana_does_not_empty'::"text", 'additional_land_plays'::"text", 'haste'::"text", 'vigilance'::"text", 'indestructible'::"text", 'trample'::"text", 'first_strike'::"text", 'double_strike'::"text", 'flying'::"text", 'reach'::"text", 'deathtouch'::"text", 'pump'::"text"]))),
    CONSTRAINT "game_continuous_effects_source_zone_required_check" CHECK ((("source_zone_required" IS NULL) OR ("source_zone_required" = ANY (ARRAY['library'::"text", 'hand'::"text", 'stack'::"text", 'battlefield'::"text", 'graveyard'::"text", 'exile'::"text"]))))
);


ALTER TABLE "public"."game_continuous_effects" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_mana_retention_effect"("p_session_id" "uuid", "p_source_card_id" "uuid", "p_colors" "text"[], "p_affected_player_id" "uuid" DEFAULT NULL::"uuid", "p_expires_at_phase" "text" DEFAULT 'ending'::"text", "p_expires_at_step" "text" DEFAULT 'cleanup'::"text", "p_should_tap_card" boolean DEFAULT false) RETURNS "public"."game_continuous_effects"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_source_card public.game_cards;
  v_affected_player_id uuid;
  v_color text;
  v_effect public.game_continuous_effects;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
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
    raise exception 'Cannot create effects in a finished game session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can create mana retention effects';
  end if;

  select *
  into v_source_card
  from public.game_cards
  where id = p_source_card_id
    and session_id = p_session_id
    and owner_id = auth.uid()
    and zone = 'battlefield'
  for update;

  if not found then
    raise exception 'Source card not found on battlefield or not owned by current user';
  end if;

  if coalesce(array_length(p_colors, 1), 0) = 0 then
    raise exception 'At least one mana color is required';
  end if;

  foreach v_color in array p_colors
  loop
    if upper(v_color) not in ('W', 'U', 'B', 'R', 'G', 'C') then
      raise exception 'Unsupported mana color: %', v_color;
    end if;
  end loop;

  v_affected_player_id := coalesce(p_affected_player_id, auth.uid());

  if not public.is_session_player(p_session_id, v_affected_player_id) then
    raise exception 'Affected player is not a player in this session';
  end if;

  if p_should_tap_card then
    if v_source_card.is_tapped then
      raise exception 'Source card is already tapped';
    end if;

    update public.game_cards
    set is_tapped = true
    where id = p_source_card_id;
  end if;

  delete from public.game_continuous_effects
  where session_id = p_session_id
    and source_card_id = p_source_card_id
    and affected_player_id = v_affected_player_id
    and effect_type = 'mana_does_not_empty';

  insert into public.game_continuous_effects (
    session_id,
    source_card_id,
    affected_player_id,
    effect_type,
    payload,
    expires_at_phase,
    expires_at_step
  )
  values (
    p_session_id,
    p_source_card_id,
    v_affected_player_id,
    'mana_does_not_empty',
    jsonb_build_object(
      'colors',
      (
        select jsonb_agg(distinct upper(color_symbol))
        from unnest(p_colors) as color_symbol
      )
    ),
    p_expires_at_phase,
    p_expires_at_step
  )
  returning * into v_effect;

  update public.game_turn_state
  set
    priority_player_id = active_player_id,
    priority_cycle_started_by = null,
    priority_pass_count = 0
  where session_id = p_session_id;

  return v_effect;
end;
$$;


ALTER FUNCTION "public"."create_mana_retention_effect"("p_session_id" "uuid", "p_source_card_id" "uuid", "p_colors" "text"[], "p_affected_player_id" "uuid", "p_expires_at_phase" "text", "p_expires_at_step" "text", "p_should_tap_card" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_pt_pump"("p_session_id" "uuid", "p_target_card_id" "uuid", "p_power" integer, "p_toughness" integer) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  perform 1
  from public.game_cards
  where id = p_target_card_id
    and session_id = p_session_id;

  if not found then
    raise exception 'Target card not found in this session';
  end if;

  insert into public.game_continuous_effects (
    session_id,
    source_card_id,
    affected_card_id,
    effect_type,
    payload,
    source_zone_required,
    expires_at_phase,
    expires_at_step
  )
  values (
    p_session_id,
    p_target_card_id,
    p_target_card_id,
    'pump',
    jsonb_build_object('power', p_power, 'toughness', p_toughness, 'until_end_of_turn', true),
    'battlefield',
    'ending',
    'cleanup'
  );

  -- A negative pump can drop a creature to lethal; re-check state.
  perform public.move_lethal_damaged_creatures_to_graveyard(p_session_id);
end;
$$;


ALTER FUNCTION "public"."create_pt_pump"("p_session_id" "uuid", "p_target_card_id" "uuid", "p_power" integer, "p_toughness" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_token"("p_session_id" "uuid", "p_player_id" "uuid", "p_token_card_id" "uuid", "p_count" integer DEFAULT 1) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_is_token boolean;
  v_turn_number integer;
  v_next_pos integer;
  v_new_id uuid;
  v_created integer := 0;
  i integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if not public.is_session_player(p_session_id, p_player_id) then
    raise exception 'Target player is not a player in this session';
  end if;

  if p_count < 1 or p_count > 20 then
    raise exception 'Token count must be between 1 and 20';
  end if;

  select is_token
  into v_is_token
  from public.cards
  where id = p_token_card_id;

  if not found then
    raise exception 'Token card not found';
  end if;

  if not coalesce(v_is_token, false) then
    raise exception 'Card is not a token';
  end if;

  select turn_number
  into v_turn_number
  from public.game_turn_state
  where session_id = p_session_id;

  for i in 1..p_count loop
    select coalesce(max(zone_position), -1) + 1
    into v_next_pos
    from public.game_cards
    where session_id = p_session_id
      and owner_id = p_player_id
      and zone = 'battlefield';

    insert into public.game_cards (
      session_id,
      card_id,
      owner_id,
      controller_player_id,
      zone,
      zone_position,
      is_tapped,
      damage_marked,
      position_x,
      position_y,
      entered_battlefield_turn_number
    )
    values (
      p_session_id,
      p_token_card_id,
      p_player_id,
      p_player_id,
      'battlefield',
      v_next_pos,
      false,
      0,
      0,
      0,
      coalesce(v_turn_number, 0)
    )
    returning id into v_new_id;

    perform public.register_card_continuous_effects(p_session_id, v_new_id);

    v_created := v_created + 1;
  end loop;

  return v_created;
end;
$$;


ALTER FUNCTION "public"."create_token"("p_session_id" "uuid", "p_player_id" "uuid", "p_token_card_id" "uuid", "p_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."creature_target_controller_ok"("p_session_id" "uuid", "p_target_card_id" "uuid", "p_controller_id" "uuid", "p_target_controller" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.game_cards gc
    join public.cards c on c.id = gc.card_id
    where gc.id = p_target_card_id
      and gc.session_id = p_session_id
      and gc.zone = 'battlefield'
      and c.type_line ilike '%creature%'
      and (
        coalesce(p_target_controller, 'any') = 'any'
        or (p_target_controller = 'opponent' and gc.controller_player_id is distinct from p_controller_id)
        or (p_target_controller = 'you' and gc.controller_player_id = p_controller_id)
      )
  );
$$;


ALTER FUNCTION "public"."creature_target_controller_ok"("p_session_id" "uuid", "p_target_card_id" "uuid", "p_controller_id" "uuid", "p_target_controller" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."game_combat_assignments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "turn_number" integer NOT NULL,
    "attacker_card_id" "uuid" NOT NULL,
    "attacking_player_id" "uuid" NOT NULL,
    "defending_player_id" "uuid" NOT NULL,
    "blocker_card_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "damage_resolved" boolean DEFAULT false NOT NULL,
    "first_strike_damage_resolved" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."game_combat_assignments" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."declare_attacker"("p_session_id" "uuid", "p_attacker_card_id" "uuid", "p_defending_player_id" "uuid") RETURNS "public"."game_combat_assignments"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_attacker record;
  v_assignment public.game_combat_assignments;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if not public.is_session_player(p_session_id, p_defending_player_id) then
    raise exception 'Defending player is not a player in this session';
  end if;

  if p_defending_player_id = auth.uid() then
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

  update public.game_cards
  set is_tapped = true
  where id = p_attacker_card_id
    and not public.card_has_vigilance(p_session_id, p_attacker_card_id);

  insert into public.game_combat_assignments (
    session_id,
    turn_number,
    attacker_card_id,
    attacking_player_id,
    defending_player_id
  )
  values (
    p_session_id,
    v_turn_state.turn_number,
    p_attacker_card_id,
    auth.uid(),
    p_defending_player_id
  )
  returning * into v_assignment;

  return v_assignment;
end;
$$;


ALTER FUNCTION "public"."declare_attacker"("p_session_id" "uuid", "p_attacker_card_id" "uuid", "p_defending_player_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."declare_blocker"("p_session_id" "uuid", "p_blocker_card_id" "uuid", "p_attacker_card_id" "uuid") RETURNS "public"."game_combat_assignments"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_assignment public.game_combat_assignments;
  v_blocker_type_line text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
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
    raise exception 'Cannot declare blockers in a finished game session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if v_turn_state.step <> 'declare_blockers' then
    raise exception 'Blockers can only be declared during Declare Blockers Step';
  end if;

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can declare blockers';
  end if;

  select *
  into v_assignment
  from public.game_combat_assignments
  where session_id = p_session_id
    and turn_number = v_turn_state.turn_number
    and attacker_card_id = p_attacker_card_id
  for update;

  if not found then
    raise exception 'Attacker assignment not found';
  end if;

  if v_assignment.defending_player_id <> auth.uid() then
    raise exception 'Only the defending player can block this attacker';
  end if;

  perform 1
  from public.game_combat_blockers
  where session_id = p_session_id
    and turn_number = v_turn_state.turn_number
    and blocker_card_id = p_blocker_card_id;

  if found then
    raise exception 'This blocker is already assigned';
  end if;

  select cards.type_line
  into v_blocker_type_line
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_blocker_card_id
    and game_cards.session_id = p_session_id
    and coalesce(game_cards.controller_player_id, game_cards.owner_id) = auth.uid()
    and game_cards.zone = 'battlefield'
    and game_cards.is_tapped = false;

  if not found then
    raise exception 'Blocker card not found, not on battlefield, not controlled by defending player, or already tapped';
  end if;

  if coalesce(v_blocker_type_line, '') not ilike '%creature%' then
    raise exception 'Only creatures can be declared as blockers';
  end if;

  -- Flying legality: only flying or reach creatures can block a flying attacker.
  if public.card_has_flying(p_session_id, p_attacker_card_id) then
    if not (
      public.card_has_flying(p_session_id, p_blocker_card_id) or
      public.card_has_reach(p_session_id, p_blocker_card_id)
    ) then
      raise exception 'Only creatures with flying or reach can block a flying creature';
    end if;
  end if;

  insert into public.game_combat_blockers (
    assignment_id,
    session_id,
    turn_number,
    attacker_card_id,
    blocker_card_id,
    blocking_player_id
  )
  values (
    v_assignment.id,
    p_session_id,
    v_turn_state.turn_number,
    p_attacker_card_id,
    p_blocker_card_id,
    auth.uid()
  );

  update public.game_combat_assignments
  set blocker_card_id = coalesce(blocker_card_id, p_blocker_card_id)
  where id = v_assignment.id
  returning * into v_assignment;

  return v_assignment;
end;
$$;


ALTER FUNCTION "public"."declare_blocker"("p_session_id" "uuid", "p_blocker_card_id" "uuid", "p_attacker_card_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dev_add_mana"("p_session_id" "uuid", "p_player_id" "uuid", "p_color" "text", "p_amount" integer) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_empty_pool jsonb := jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0);
  v_current_pool jsonb;
  v_new_pool jsonb;
  v_current_amount integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if not public.is_session_player(p_session_id, p_player_id) then
    raise exception 'Target player is not a player in this session';
  end if;

  if p_color not in ('W', 'U', 'B', 'R', 'G', 'C') then
    raise exception 'Invalid mana color: %', p_color;
  end if;

  if p_amount = 0 then
    raise exception 'Mana amount cannot be zero';
  end if;

  insert into public.game_players (session_id, player_id, mana_pool)
  values (p_session_id, p_player_id, v_empty_pool)
  on conflict (session_id, player_id) do nothing;

  select coalesce(mana_pool, v_empty_pool)
  into v_current_pool
  from public.game_players
  where session_id = p_session_id
    and player_id = p_player_id
  for update;

  v_current_amount := coalesce((v_current_pool ->> p_color)::integer, 0);
  v_new_pool := v_current_pool || jsonb_build_object(p_color, greatest(0, v_current_amount + p_amount));

  update public.game_players
  set mana_pool = v_new_pool
  where session_id = p_session_id
    and player_id = p_player_id;

  return v_new_pool;
end;
$$;


ALTER FUNCTION "public"."dev_add_mana"("p_session_id" "uuid", "p_player_id" "uuid", "p_color" "text", "p_amount" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dev_clear_mana_pool"("p_session_id" "uuid", "p_player_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_empty_pool jsonb := jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0);
  v_before_pool jsonb;
  v_after_pool jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if not public.is_session_player(p_session_id, p_player_id) then
    raise exception 'Target player is not a player in this session';
  end if;

  insert into public.game_players (session_id, player_id, mana_pool)
  values (p_session_id, p_player_id, v_empty_pool)
  on conflict (session_id, player_id) do nothing;

  select coalesce(mana_pool, v_empty_pool)
  into v_before_pool
  from public.game_players
  where session_id = p_session_id
    and player_id = p_player_id
  for update;

  update public.game_players
  set mana_pool = v_empty_pool
  where session_id = p_session_id
    and player_id = p_player_id
  returning mana_pool into v_after_pool;

  perform public.dev_log_action(
    p_session_id,
    p_player_id,
    'clear_mana_pool',
    'Clear mana pool',
    jsonb_build_object('mana_pool', v_before_pool),
    jsonb_build_object('mana_pool', v_after_pool)
  );

  return v_after_pool;
end;
$$;


ALTER FUNCTION "public"."dev_clear_mana_pool"("p_session_id" "uuid", "p_player_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dev_clear_summoning_sickness"("p_session_id" "uuid", "p_game_card_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_card public.game_cards;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select *
  into v_card
  from public.game_cards
  where id = p_game_card_id
    and session_id = p_session_id
  for update;

  if not found then
    raise exception 'Card not found in this session';
  end if;

  update public.game_cards
  set entered_battlefield_turn_number = 0
  where id = p_game_card_id
    and session_id = p_session_id;

  perform public.dev_log_action(
    p_session_id,
    null,
    'dev_clear_summoning_sickness',
    format('Cleared summoning sickness on card %s', p_game_card_id),
    jsonb_build_object('entered_battlefield_turn_number', v_card.entered_battlefield_turn_number),
    jsonb_build_object('entered_battlefield_turn_number', 0)
  );
end;
$$;


ALTER FUNCTION "public"."dev_clear_summoning_sickness"("p_session_id" "uuid", "p_game_card_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dev_draw_card"("p_session_id" "uuid", "p_player_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_session_status text;
  v_card_id uuid;
  v_next_hand_position integer;
  v_before_card jsonb;
  v_after_card jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if not public.is_session_player(p_session_id, p_player_id) then
    raise exception 'Target player is not a player in this session';
  end if;

  select status into v_session_status from public.game_sessions where id = p_session_id;
  if not found then raise exception 'Game session not found'; end if;
  if v_session_status = 'finished' then raise exception 'Cannot draw cards in a finished game session'; end if;

  select coalesce(max(zone_position), -1) + 1
  into v_next_hand_position
  from public.game_cards
  where session_id = p_session_id and owner_id = p_player_id and zone = 'hand';

  select id, to_jsonb(game_cards.*)
  into v_card_id, v_before_card
  from public.game_cards
  where session_id = p_session_id and owner_id = p_player_id and zone = 'library'
  order by zone_position asc, id asc
  limit 1
  for update skip locked;

  if v_card_id is null then raise exception 'Library is empty'; end if;

  update public.game_cards
  set
    zone = 'hand',
    zone_position = v_next_hand_position,
    is_tapped = false,
    damage_marked = 0
  where id = v_card_id
  returning to_jsonb(game_cards.*) into v_after_card;

  perform public.dev_log_action(
    p_session_id,
    p_player_id,
    'draw_card',
    'Draw card',
    jsonb_build_object('card', v_before_card),
    jsonb_build_object('card', v_after_card)
  );

  return v_card_id;
end;
$$;


ALTER FUNCTION "public"."dev_draw_card"("p_session_id" "uuid", "p_player_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dev_log_action"("p_session_id" "uuid", "p_target_player_id" "uuid", "p_action_type" "text", "p_description" "text", "p_before_state" "jsonb", "p_after_state" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_log_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  insert into public.game_action_log (
    session_id,
    actor_player_id,
    target_player_id,
    action_type,
    description,
    before_state,
    after_state
  )
  values (
    p_session_id,
    auth.uid(),
    p_target_player_id,
    p_action_type,
    p_description,
    coalesce(p_before_state, '{}'::jsonb),
    coalesce(p_after_state, '{}'::jsonb)
  )
  returning id into v_log_id;

  return v_log_id;
end;
$$;


ALTER FUNCTION "public"."dev_log_action"("p_session_id" "uuid", "p_target_player_id" "uuid", "p_action_type" "text", "p_description" "text", "p_before_state" "jsonb", "p_after_state" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dev_move_card_to_zone"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_zone" "text") RETURNS "public"."game_cards"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_card public.game_cards;
  v_before_card jsonb;
  v_after_card jsonb;
  v_next_zone_position integer;
  v_turn_number integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not public.is_session_player(p_session_id, auth.uid()) then raise exception 'Current user is not a player in this session'; end if;
  if p_zone not in ('library', 'hand', 'stack', 'battlefield', 'graveyard', 'exile') then raise exception 'Invalid zone: %', p_zone; end if;

  -- CORRECTIE: Record en JSON apart ophalen
  select * into v_card
  from public.game_cards
  where id = p_game_card_id and session_id = p_session_id
  for update;

  if not found then raise exception 'Card not found in this session'; end if;
  v_before_card := to_jsonb(v_card);

  select coalesce(max(zone_position), -1) + 1
  into v_next_zone_position
  from public.game_cards
  where session_id = p_session_id and owner_id = v_card.owner_id and zone = p_zone;

  select turn_number into v_turn_number from public.game_turn_state where session_id = p_session_id;

  update public.game_cards
  set
    zone = p_zone,
    zone_position = v_next_zone_position,
    is_tapped = false,
    damage_marked = 0,
    entered_battlefield_turn_number = case
      when p_zone = 'battlefield' then coalesce(v_turn_number, entered_battlefield_turn_number)
      else null
    end
  where id = p_game_card_id
  returning * into v_card;

  v_after_card := to_jsonb(v_card);

  perform public.rebuild_scripted_continuous_effects(p_session_id);

  perform public.dev_log_action(
    p_session_id,
    v_card.owner_id,
    'move_card_to_zone',
    'Move card to ' || p_zone,
    jsonb_build_object('card', v_before_card),
    jsonb_build_object('card', v_after_card)
  );

  return v_card;
end;
$$;


ALTER FUNCTION "public"."dev_move_card_to_zone"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_zone" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dev_pass_priority"("p_session_id" "uuid") RETURNS "public"."game_turn_state"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_player_count integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  perform 1
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  select count(*)
  into v_player_count
  from public.game_session_players
  where session_id = p_session_id;

  -- Treat this as the final pass of the round: hand priority to the judge and
  -- set the pass count so the next pass completes the cycle.
  update public.game_turn_state
  set
    priority_player_id = auth.uid(),
    priority_pass_count = greatest(0, v_player_count - 1)
  where session_id = p_session_id;

  return public.pass_priority(p_session_id);
end;
$$;


ALTER FUNCTION "public"."dev_pass_priority"("p_session_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dev_put_card_on_bottom"("p_session_id" "uuid", "p_game_card_id" "uuid") RETURNS "public"."game_cards"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_card public.game_cards;
  v_before_card jsonb;
  v_after_card jsonb;
  v_next_position integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  -- CORRECTIE: Record en JSON apart
  select * into v_card from public.game_cards 
  where id = p_game_card_id and session_id = p_session_id for update;
  if not found then raise exception 'Card not found in this session'; end if;
  v_before_card := to_jsonb(v_card);

  select coalesce(max(zone_position), -1) + 1
  into v_next_position
  from public.game_cards
  where session_id = p_session_id and owner_id = v_card.owner_id and zone = 'library';

  update public.game_cards
  set
    zone = 'library',
    zone_position = v_next_position,
    is_tapped = false,
    damage_marked = 0,
    entered_battlefield_turn_number = null
  where id = p_game_card_id
  returning * into v_card;

  v_after_card := to_jsonb(v_card);
  perform public.rebuild_scripted_continuous_effects(p_session_id);
  perform public.dev_log_action(p_session_id, v_card.owner_id, 'put_card_on_bottom', 'Put card on bottom', jsonb_build_object('card', v_before_card), jsonb_build_object('card', v_after_card));

  return v_card;
end;
$$;


ALTER FUNCTION "public"."dev_put_card_on_bottom"("p_session_id" "uuid", "p_game_card_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dev_put_card_on_top"("p_session_id" "uuid", "p_game_card_id" "uuid") RETURNS "public"."game_cards"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_card public.game_cards;
  v_before_card jsonb;
  v_after_card jsonb;
  v_next_position integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  -- CORRECTIE: Record en JSON apart
  select * into v_card from public.game_cards 
  where id = p_game_card_id and session_id = p_session_id for update;
  if not found then raise exception 'Card not found in this session'; end if;
  v_before_card := to_jsonb(v_card);

  select coalesce(min(zone_position), 0) - 1
  into v_next_position
  from public.game_cards
  where session_id = p_session_id and owner_id = v_card.owner_id and zone = 'library';

  update public.game_cards
  set
    zone = 'library',
    zone_position = v_next_position,
    is_tapped = false,
    damage_marked = 0,
    entered_battlefield_turn_number = null
  where id = p_game_card_id
  returning * into v_card;

  v_after_card := to_jsonb(v_card);
  perform public.rebuild_scripted_continuous_effects(p_session_id);
  perform public.dev_log_action(p_session_id, v_card.owner_id, 'put_card_on_top', 'Put card on top', jsonb_build_object('card', v_before_card), jsonb_build_object('card', v_after_card));

  return v_card;
end;
$$;


ALTER FUNCTION "public"."dev_put_card_on_top"("p_session_id" "uuid", "p_game_card_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dev_set_card_damage"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_damage_marked" integer) RETURNS "public"."game_cards"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_card public.game_cards;
  v_before_card jsonb;
  v_after_card jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_damage_marked < 0 then raise exception 'Damage cannot be negative'; end if;

  select * into v_card 
  from public.game_cards 
  where id = p_game_card_id and session_id = p_session_id 
  for update;

  if not found then raise exception 'Card not found in this session'; end if;
  v_before_card := to_jsonb(v_card);

  update public.game_cards
  set damage_marked = p_damage_marked
  where id = p_game_card_id and session_id = p_session_id
  returning * into v_card;

  v_after_card := to_jsonb(v_card);

  perform public.dev_log_action(
    p_session_id,
    v_card.owner_id,
    'set_card_damage',
    'Set card damage',
    jsonb_build_object('card', v_before_card),
    jsonb_build_object('card', v_after_card)
  );

  return v_card;
end;
$$;


ALTER FUNCTION "public"."dev_set_card_damage"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_damage_marked" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dev_set_card_tapped"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_is_tapped" boolean) RETURNS "public"."game_cards"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_card public.game_cards;
  v_before_card jsonb;
  v_after_card jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select * into v_card 
  from public.game_cards 
  where id = p_game_card_id and session_id = p_session_id 
  for update;
  
  if not found then raise exception 'Card not found in this session'; end if;
  v_before_card := to_jsonb(v_card);

  update public.game_cards
  set is_tapped = p_is_tapped
  where id = p_game_card_id and session_id = p_session_id
  returning * into v_card;

  v_after_card := to_jsonb(v_card);

  perform public.dev_log_action(
    p_session_id,
    v_card.owner_id,
    'set_card_tapped',
    case when p_is_tapped then 'Tap card' else 'Untap card' end,
    jsonb_build_object('card', v_before_card),
    jsonb_build_object('card', v_after_card)
  );

  return v_card;
end;
$$;


ALTER FUNCTION "public"."dev_set_card_tapped"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_is_tapped" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dev_set_turn_state"("p_session_id" "uuid", "p_phase" "text", "p_step" "text", "p_active_player_id" "uuid" DEFAULT NULL::"uuid", "p_priority_player_id" "uuid" DEFAULT NULL::"uuid", "p_turn_number" integer DEFAULT NULL::integer) RETURNS "public"."game_turn_state"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_state public.game_turn_state;
  v_active_player_id uuid;
  v_priority_player_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if p_phase not in ('beginning', 'main_1', 'combat', 'main_2', 'ending') then
    raise exception 'Invalid phase: %', p_phase;
  end if;

  if p_step not in (
    'untap',
    'upkeep',
    'draw',
    'precombat_main',
    'beginning_of_combat',
    'declare_attackers',
    'declare_blockers',
    'combat_damage',
    'end_of_combat',
    'postcombat_main',
    'end',
    'cleanup'
  ) then
    raise exception 'Invalid step: %', p_step;
  end if;

  select *
  into v_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  v_active_player_id := coalesce(p_active_player_id, v_state.active_player_id);
  v_priority_player_id := coalesce(p_priority_player_id, v_active_player_id);

  if not public.is_session_player(p_session_id, v_active_player_id) then
    raise exception 'Active player is not a player in this session';
  end if;

  if not public.is_session_player(p_session_id, v_priority_player_id) then
    raise exception 'Priority player is not a player in this session';
  end if;

  update public.game_turn_state
  set
    active_player_id = v_active_player_id,
    priority_player_id = v_priority_player_id,
    priority_cycle_started_by = null,
    priority_pass_count = 0,
    turn_number = coalesce(p_turn_number, turn_number),
    phase = p_phase,
    step = p_step
  where session_id = p_session_id
  returning * into v_state;

  return v_state;
end;
$$;


ALTER FUNCTION "public"."dev_set_turn_state"("p_session_id" "uuid", "p_phase" "text", "p_step" "text", "p_active_player_id" "uuid", "p_priority_player_id" "uuid", "p_turn_number" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dev_shuffle_library"("p_session_id" "uuid", "p_player_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_count integer;
  v_before_cards jsonb;
  v_after_cards jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'zone_position', zone_position) order by zone_position, id), '[]'::jsonb)
  into v_before_cards
  from public.game_cards
  where session_id = p_session_id and owner_id = p_player_id and zone = 'library';

  with shuffled as (
    select id, row_number() over (order by random(), id) - 1 as next_position
    from public.game_cards
    where session_id = p_session_id and owner_id = p_player_id and zone = 'library'
  )
  update public.game_cards
  set zone_position = shuffled.next_position
  from shuffled where game_cards.id = shuffled.id;

  get diagnostics v_count = row_count;

  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'zone_position', zone_position) order by zone_position, id), '[]'::jsonb)
  into v_after_cards
  from public.game_cards
  where session_id = p_session_id and owner_id = p_player_id and zone = 'library';

  perform public.dev_log_action(
    p_session_id, p_player_id, 'shuffle_library', 'Shuffle library',
    jsonb_build_object('cards', v_before_cards),
    jsonb_build_object('cards', v_after_cards)
  );

  return v_count;
end;
$$;


ALTER FUNCTION "public"."dev_shuffle_library"("p_session_id" "uuid", "p_player_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dev_spawn_card"("p_session_id" "uuid", "p_player_id" "uuid", "p_card_id" "uuid", "p_zone" "text" DEFAULT 'hand'::"text", "p_tapped" boolean DEFAULT false) RETURNS "public"."game_cards"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_turn_number integer;
  v_next_zone_position integer;
  v_card public.game_cards;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if not public.is_session_player(p_session_id, p_player_id) then
    raise exception 'Target player is not a player in this session';
  end if;

  if p_zone not in ('library', 'hand', 'stack', 'battlefield', 'graveyard', 'exile') then
    raise exception 'Invalid zone: %', p_zone;
  end if;

  perform 1
  from public.cards
  where id = p_card_id;

  if not found then
    raise exception 'Card not found';
  end if;

  select turn_number
  into v_turn_number
  from public.game_turn_state
  where session_id = p_session_id;

  select coalesce(max(zone_position), -1) + 1
  into v_next_zone_position
  from public.game_cards
  where session_id = p_session_id
    and owner_id = p_player_id
    and zone = p_zone;

  insert into public.game_cards (
    session_id,
    card_id,
    owner_id,
    controller_player_id,
    zone,
    zone_position,
    is_tapped,
    damage_marked,
    position_x,
    position_y,
    entered_battlefield_turn_number
  )
  values (
    p_session_id,
    p_card_id,
    p_player_id,
    p_player_id,
    p_zone,
    v_next_zone_position,
    p_tapped,
    0,
    0,
    0,
    case when p_zone = 'battlefield' then coalesce(v_turn_number, 0) else null end
  )
  returning * into v_card;

  if p_zone = 'battlefield' then
    perform public.rebuild_scripted_continuous_effects(p_session_id);
  end if;

  return v_card;
end;
$$;


ALTER FUNCTION "public"."dev_spawn_card"("p_session_id" "uuid", "p_player_id" "uuid", "p_card_id" "uuid", "p_zone" "text", "p_tapped" boolean) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."game_action_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "actor_player_id" "uuid" NOT NULL,
    "target_player_id" "uuid",
    "action_type" "text" NOT NULL,
    "description" "text",
    "before_state" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "after_state" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "undone_at" timestamp with time zone,
    "undone_by" "uuid"
);


ALTER TABLE "public"."game_action_log" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dev_undo_action"("p_action_id" "uuid") RETURNS "public"."game_action_log"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_action public.game_action_log;
  v_card jsonb;
  v_card_id uuid;
  v_library_card jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select * into v_action from public.game_action_log where id = p_action_id for update;
  if not found then raise exception 'Action not found'; end if;
  if v_action.undone_at is not null then raise exception 'Action is already undone'; end if;

  if v_action.action_type in ('draw_card', 'move_card_to_zone', 'set_card_tapped', 'set_card_damage', 'put_card_on_top', 'put_card_on_bottom') then
    v_card := v_action.before_state -> 'card';
    v_card_id := (v_card ->> 'id')::uuid;

    update public.game_cards
    set
      zone = v_card ->> 'zone',
      zone_position = (v_card ->> 'zone_position')::integer,
      is_tapped = coalesce((v_card ->> 'is_tapped')::boolean, false),
      damage_marked = coalesce((v_card ->> 'damage_marked')::integer, 0),
      controller_player_id = nullif(v_card ->> 'controller_player_id', '')::uuid,
      entered_battlefield_turn_number = nullif(v_card ->> 'entered_battlefield_turn_number', '')::integer
    where id = v_card_id and session_id = v_action.session_id;

    perform public.rebuild_scripted_continuous_effects(v_action.session_id);
  elsif v_action.action_type = 'shuffle_library' then
    for v_library_card in select value from jsonb_array_elements(v_action.before_state -> 'cards') loop
      update public.game_cards set zone_position = (v_library_card ->> 'zone_position')::integer
      where id = (v_library_card ->> 'id')::uuid and session_id = v_action.session_id and zone = 'library';
    end loop;
  elsif v_action.action_type = 'untap_all' then
    for v_library_card in select value from jsonb_array_elements(v_action.before_state -> 'cards') loop
      update public.game_cards
      set is_tapped = coalesce((v_library_card ->> 'is_tapped')::boolean, false)
      where id = (v_library_card ->> 'id')::uuid and session_id = v_action.session_id;
    end loop;
  elsif v_action.action_type = 'clear_mana_pool' then
    update public.game_players
    set mana_pool = v_action.before_state -> 'mana_pool'
    where session_id = v_action.session_id and player_id = v_action.target_player_id;
  else
    raise exception 'Undo not supported for: %', v_action.action_type;
  end if;

  update public.game_action_log set undone_at = now(), undone_by = auth.uid()
  where id = p_action_id returning * into v_action;

  return v_action;
end;
$$;


ALTER FUNCTION "public"."dev_undo_action"("p_action_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dev_undo_last_draw"("p_session_id" "uuid", "p_player_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_session_status text;
  v_card_id uuid;
  v_next_library_position integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not public.is_session_player(p_session_id, auth.uid()) then raise exception 'Current user is not a player in this session'; end if;

  select status into v_session_status from public.game_sessions where id = p_session_id;
  if v_session_status = 'finished' then raise exception 'Cannot undo draws in a finished game session'; end if;

  select coalesce(min(zone_position), 0) - 1
  into v_next_library_position
  from public.game_cards
  where session_id = p_session_id and owner_id = p_player_id and zone = 'library';

  select id into v_card_id
  from public.game_cards
  where session_id = p_session_id and owner_id = p_player_id and zone = 'hand'
  order by zone_position desc, id desc
  limit 1
  for update skip locked;

  if v_card_id is null then raise exception 'Hand is empty'; end if;

  update public.game_cards
  set zone = 'library', zone_position = v_next_library_position, is_tapped = false, damage_marked = 0
  where id = v_card_id;

  return v_card_id;
end;
$$;


ALTER FUNCTION "public"."dev_undo_last_draw"("p_session_id" "uuid", "p_player_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dev_untap_all"("p_session_id" "uuid", "p_player_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_count integer;
  v_before_cards jsonb;
  v_after_cards jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if not public.is_session_player(p_session_id, p_player_id) then
    raise exception 'Target player is not a player in this session';
  end if;

  select coalesce(jsonb_agg(to_jsonb(game_cards.*) order by zone_position, id), '[]'::jsonb)
  into v_before_cards
  from public.game_cards
  where session_id = p_session_id
    and owner_id = p_player_id
    and zone = 'battlefield'
    and is_tapped = true;

  update public.game_cards
  set is_tapped = false
  where session_id = p_session_id
    and owner_id = p_player_id
    and zone = 'battlefield'
    and is_tapped = true;

  get diagnostics v_count = row_count;

  select coalesce(jsonb_agg(to_jsonb(game_cards.*) order by zone_position, id), '[]'::jsonb)
  into v_after_cards
  from public.game_cards
  where session_id = p_session_id
    and owner_id = p_player_id
    and id in (
      select (value ->> 'id')::uuid
      from jsonb_array_elements(v_before_cards)
    );

  perform public.dev_log_action(
    p_session_id,
    p_player_id,
    'untap_all',
    'Untap all',
    jsonb_build_object('cards', v_before_cards),
    jsonb_build_object('cards', v_after_cards)
  );

  return v_count;
end;
$$;


ALTER FUNCTION "public"."dev_untap_all"("p_session_id" "uuid", "p_player_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."draw_card"("p_session_id" "uuid", "p_player_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_session_status text;
  v_card_id uuid;
  v_next_hand_position integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_player_id <> auth.uid() then
    raise exception 'Cannot draw for another player';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select status
  into v_session_status
  from public.game_sessions
  where id = p_session_id;

  if not found then
    raise exception 'Game session not found';
  end if;

  if v_session_status = 'finished' then
    raise exception 'Cannot draw cards in a finished game session';
  end if;

  select coalesce(max(zone_position), -1) + 1
  into v_next_hand_position
  from public.game_cards
  where session_id = p_session_id
    and owner_id = auth.uid()
    and zone = 'hand';

  select id
  into v_card_id
  from public.game_cards
  where session_id = p_session_id
    and owner_id = auth.uid()
    and zone = 'library'
  order by zone_position asc, id asc
  limit 1
  for update skip locked;

  if v_card_id is null then
    raise exception 'Library is empty';
  end if;

  update public.game_cards
  set
    zone = 'hand',
    zone_position = v_next_hand_position,
    is_tapped = false,
    damage_marked = 0
  where id = v_card_id;

  return v_card_id;
end;
$$;


ALTER FUNCTION "public"."draw_card"("p_session_id" "uuid", "p_player_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."effective_script"("p_session_id" "uuid", "p_game_card_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_script jsonb;
begin
  select coalesce(game_cards.copied_script, cards.script)
  into v_script
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id;

  return v_script;
end;
$$;


ALTER FUNCTION "public"."effective_script"("p_session_id" "uuid", "p_game_card_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enqueue_triggered_ability"("p_session_id" "uuid", "p_controller_id" "uuid", "p_source_card_id" "uuid", "p_label" "text", "p_effects" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_next_position integer;
  v_requires_creature_target boolean;
  v_target_controller text;
begin
  if p_effects is null or jsonb_typeof(p_effects) <> 'array' or jsonb_array_length(p_effects) = 0 then
    return;
  end if;

  v_requires_creature_target := public.trigger_effects_require_creature_target(p_effects);

  if v_requires_creature_target then
    v_target_controller := coalesce(public.trigger_effects_target_controller(p_effects), 'any');

    if not public.session_has_targetable_creature(p_session_id, p_controller_id, v_target_controller) then
      return;
    end if;
  end if;

  select coalesce(max(position), -1) + 1
  into v_next_position
  from public.game_stack_items
  where session_id = p_session_id;

  insert into public.game_stack_items (
    session_id,
    controller_player_id,
    source_card_id,
    action_type,
    payload,
    position
  )
  values (
    p_session_id,
    p_controller_id,
    p_source_card_id,
    'triggered_ability',
    jsonb_build_object(
      'label', p_label,
      'controller_player_id', p_controller_id,
      'effects', p_effects,
      'target_required', v_requires_creature_target,
      'target_type', case when v_requires_creature_target then 'creature' else null end,
      'target_controller', case when v_requires_creature_target then v_target_controller else null end,
      'timing', 'triggered'
    ),
    v_next_position
  );
end;
$$;


ALTER FUNCTION "public"."enqueue_triggered_ability"("p_session_id" "uuid", "p_controller_id" "uuid", "p_source_card_id" "uuid", "p_label" "text", "p_effects" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."expire_continuous_effects_for_step"("p_session_id" "uuid", "p_turn_number" integer, "p_phase" "text", "p_step" "text") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_deleted_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  delete from public.game_continuous_effects
  where session_id = p_session_id
    and (
      (expires_at_turn_number is not null and expires_at_turn_number < p_turn_number)
      or (
        expires_at_phase = p_phase
        and (expires_at_step is null or expires_at_step = p_step)
      )
    );

  get diagnostics v_deleted_count = row_count;

  return v_deleted_count;
end;
$$;


ALTER FUNCTION "public"."expire_continuous_effects_for_step"("p_session_id" "uuid", "p_turn_number" integer, "p_phase" "text", "p_step" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."finish_game_session"("p_session_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  update public.game_sessions
  set
    status = 'finished',
    finished_at = coalesce(finished_at, now()),
    winner_player_id = null
  where id = p_session_id
    and created_by = auth.uid()
    and status <> 'finished';

  if not found then
    raise exception 'Game session not found, already finished, or not created by current user';
  end if;

  return true;
end;
$$;


ALTER FUNCTION "public"."finish_game_session"("p_session_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fire_attack_triggers"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform public.fire_card_triggers(
    NEW.session_id,
    NEW.attacker_card_id,
    array['attacks', 'declares_attack', 'attack']
  );

  return null;
end;
$$;


ALTER FUNCTION "public"."fire_attack_triggers"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fire_block_triggers"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform public.fire_card_triggers(
    NEW.session_id,
    NEW.blocker_card_id,
    array['blocks', 'declares_block', 'block']
  );

  return null;
end;
$$;


ALTER FUNCTION "public"."fire_block_triggers"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fire_card_triggers"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_events" "text"[]) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_controller uuid;
  v_card_name text;
  v_script jsonb;
  v_ability jsonb;
  v_event text;
begin
  select
    coalesce(game_cards.controller_player_id, game_cards.owner_id),
    cards.name
  into v_controller, v_card_name
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id;

  v_script := public.effective_script(p_session_id, p_game_card_id);

  if v_script is null or not (v_script ? 'triggered_abilities') then
    return;
  end if;

  for v_ability in
    select * from jsonb_array_elements(v_script -> 'triggered_abilities')
  loop
    v_event := lower(coalesce(v_ability ->> 'event', ''));

    if v_event = any (p_events) then
      perform public.enqueue_triggered_ability(
        p_session_id,
        v_controller,
        p_game_card_id,
        coalesce(v_card_name, v_ability ->> 'id', v_event),
        v_ability -> 'effects'
      );
    end if;
  end loop;
end;
$$;


ALTER FUNCTION "public"."fire_card_triggers"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_events" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fire_target_triggers"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_target_card_id uuid;
begin
  if NEW.action_type not in (
    'deal_damage_creature',
    'pump_creature',
    'destroy_creature',
    'bounce_creature',
    'tap_creature',
    'untap_creature',
    'add_counters_creature'
  ) then
    return null;
  end if;

  v_target_card_id := nullif(NEW.payload ->> 'target_card_id', '')::uuid;

  if v_target_card_id is not null then
    perform public.fire_card_triggers(
      NEW.session_id,
      v_target_card_id,
      array['becomes_targeted', 'targeted', 'becomes_target']
    );
  end if;

  return null;
end;
$$;


ALTER FUNCTION "public"."fire_target_triggers"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fire_turn_step_triggers"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_card uuid;
  v_events text[];
begin
  if NEW.step is not distinct from OLD.step then
    return null;
  end if;

  v_events := case NEW.step
    when 'upkeep' then array['beginning_of_upkeep', 'upkeep']
    when 'draw' then array['beginning_of_draw_step', 'draw_step']
    when 'end' then array['beginning_of_end_step', 'end_step', 'beginning_of_end']
    else null
  end;

  if v_events is null then
    return null;
  end if;

  for v_card in
    select game_cards.id
    from public.game_cards
    where game_cards.session_id = NEW.session_id
      and game_cards.zone = 'battlefield'
      and coalesce(game_cards.controller_player_id, game_cards.owner_id) = NEW.active_player_id
    order by game_cards.zone_position, game_cards.id
  loop
    perform public.fire_card_triggers(NEW.session_id, v_card, v_events);
  end loop;

  return null;
end;
$$;


ALTER FUNCTION "public"."fire_turn_step_triggers"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fire_zone_change_triggers"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  -- Enters the battlefield.
  if NEW.zone = 'battlefield'
    and (TG_OP = 'INSERT' or OLD.zone is distinct from 'battlefield')
  then
    perform public.fire_card_triggers(
      NEW.session_id,
      NEW.id,
      array['enters_the_battlefield', 'etb', 'enters']
    );
  end if;

  -- Dies (moves from the battlefield to the graveyard).
  if TG_OP = 'UPDATE'
    and OLD.zone = 'battlefield'
    and NEW.zone = 'graveyard'
  then
    perform public.fire_card_triggers(
      NEW.session_id,
      NEW.id,
      array['dies', 'death']
    );
  end if;

  -- Leaves the battlefield (to any other zone, including graveyard/hand/exile).
  if TG_OP = 'UPDATE'
    and OLD.zone = 'battlefield'
    and NEW.zone is distinct from 'battlefield'
  then
    perform public.fire_card_triggers(
      NEW.session_id,
      NEW.id,
      array['leaves_the_battlefield', 'ltb', 'leaves']
    );
  end if;

  return null;
end;
$$;


ALTER FUNCTION "public"."fire_zone_change_triggers"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_card_behavior_continuous_effects"("p_script" "jsonb") RETURNS "jsonb"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
  select coalesce(p_script -> 'continuous_effects', '[]'::jsonb);
$$;


ALTER FUNCTION "public"."get_card_behavior_continuous_effects"("p_script" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_card_behavior_mana_abilities"("p_script" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
declare
  v_version integer;
  v_actions jsonb;
  v_has_manual_tap boolean;
begin
  v_version := public.get_card_behavior_schema_version(p_script);

  if v_version = 2 then
    return coalesce(
      (
        select jsonb_agg(ability)
        from jsonb_array_elements(coalesce(p_script -> 'activated_abilities', '[]'::jsonb)) as ability
        where coalesce((ability ->> 'is_mana_ability')::boolean, false)
      ),
      '[]'::jsonb
    );
  end if;

  v_has_manual_tap := coalesce(p_script -> 'triggers', '[]'::jsonb) ? 'manual_tap';

  if not v_has_manual_tap then
    return '[]'::jsonb;
  end if;

  v_actions := coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'costs',
          jsonb_build_array(jsonb_build_object('type', 'tap_self')),
          'effects',
          jsonb_build_array(action),
          'is_mana_ability',
          true,
          'source_zone_required',
          'battlefield'
        )
      )
      from jsonb_array_elements(coalesce(p_script -> 'actions', '[]'::jsonb)) as action
      where action ->> 'type' = 'add_mana'
        and action ? 'color'
        and action ? 'amount'
    ),
    '[]'::jsonb
  );

  return v_actions;
end;
$$;


ALTER FUNCTION "public"."get_card_behavior_mana_abilities"("p_script" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_card_behavior_schema_version"("p_script" "jsonb") RETURNS integer
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
  select case
    when coalesce((p_script ->> 'schema_version')::integer, 1) = 2 then 2
    when coalesce(p_script ? 'spell_effect', false)
      or coalesce(p_script ? 'activated_abilities', false)
      or coalesce(p_script ? 'triggered_abilities', false)
      then 2
    else 1
  end;
$$;


ALTER FUNCTION "public"."get_card_behavior_schema_version"("p_script" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_combat_action_state"("p_session_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_turn_state public.game_turn_state;
  v_is_session_player boolean;
  v_attack_reason text;
  v_block_reason text;
  v_damage_reason text;
  v_blockable_attackers_count integer := 0;
  v_unresolved_combat_count integer := 0;
begin
  if auth.uid() is null then
    return jsonb_build_object(
      'can_declare_attackers', false,
      'can_declare_blockers', false,
      'can_resolve_combat_damage', false,
      'reason', 'Authentication required',
      'attack_reason', 'Authentication required',
      'block_reason', 'Authentication required',
      'damage_reason', 'Authentication required'
    );
  end if;

  v_is_session_player := public.is_session_player(p_session_id, auth.uid());

  if not v_is_session_player then
    return jsonb_build_object(
      'can_declare_attackers', false,
      'can_declare_blockers', false,
      'can_resolve_combat_damage', false,
      'reason', 'Current user is not a player in this session',
      'attack_reason', 'Current user is not a player in this session',
      'block_reason', 'Current user is not a player in this session',
      'damage_reason', 'Current user is not a player in this session',
      'current_player_id', auth.uid()
    );
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id;

  if not found then
    return jsonb_build_object(
      'can_declare_attackers', false,
      'can_declare_blockers', false,
      'can_resolve_combat_damage', false,
      'reason', 'Turn state not found',
      'attack_reason', 'Turn state not found',
      'block_reason', 'Turn state not found',
      'damage_reason', 'Turn state not found',
      'current_player_id', auth.uid()
    );
  end if;

  if v_turn_state.active_player_id <> auth.uid() then
    v_attack_reason := 'Only the active player can declare attackers';
  elsif v_turn_state.step <> 'declare_attackers' then
    v_attack_reason := 'Attackers can only be declared during Declare Attackers Step';
  end if;

  select count(*)
  into v_blockable_attackers_count
  from public.game_combat_assignments
  where session_id = p_session_id
    and turn_number = v_turn_state.turn_number
    and defending_player_id = auth.uid();

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    v_block_reason := 'Only the priority player can declare blockers';
  elsif v_turn_state.step <> 'declare_blockers' then
    v_block_reason := 'Blockers can only be declared during Declare Blockers Step';
  elsif v_blockable_attackers_count = 0 then
    v_block_reason := 'No attackers are attacking you';
  end if;

  select count(*)
  into v_unresolved_combat_count
  from public.game_combat_assignments
  where session_id = p_session_id
    and turn_number = v_turn_state.turn_number
    and damage_resolved = false;

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    v_damage_reason := 'Only the priority player can resolve combat damage';
  elsif v_turn_state.step <> 'combat_damage' then
    v_damage_reason := 'Combat damage can only be resolved during Combat Damage Step';
  elsif v_unresolved_combat_count = 0 then
    v_damage_reason := 'No unresolved combat damage';
  end if;

  return jsonb_build_object(
    'can_declare_attackers',
    v_attack_reason is null,
    'can_declare_blockers',
    v_block_reason is null,
    'can_resolve_combat_damage',
    v_damage_reason is null,
    'reason',
    coalesce(v_attack_reason, v_block_reason, v_damage_reason),
    'attack_reason',
    v_attack_reason,
    'block_reason',
    v_block_reason,
    'damage_reason',
    v_damage_reason,
    'blockable_attackers_count',
    v_blockable_attackers_count,
    'unresolved_combat_count',
    v_unresolved_combat_count,
    'active_player_id',
    v_turn_state.active_player_id,
    'priority_player_id',
    coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id),
    'current_player_id',
    auth.uid(),
    'turn_number',
    v_turn_state.turn_number,
    'phase',
    v_turn_state.phase,
    'step',
    v_turn_state.step
  );
end;
$$;


ALTER FUNCTION "public"."get_combat_action_state"("p_session_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_combat_assignments"("p_session_id" "uuid") RETURNS TABLE("id" "uuid", "session_id" "uuid", "turn_number" integer, "attacker_card_id" "uuid", "attacker_name" "text", "attacker_power" integer, "attacker_toughness" integer, "attacking_player_id" "uuid", "attacking_username" "text", "defending_player_id" "uuid", "defending_username" "text", "blocker_card_id" "uuid", "blocker_name" "text", "blocker_count" integer, "blockers" "jsonb", "created_at" timestamp with time zone)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  with blocker_summary as (
    select
      blockers.assignment_id,
      (array_agg(blockers.blocker_card_id order by blockers.damage_assignment_order, blockers.created_at, blockers.id))[1] as first_blocker_card_id,
      string_agg(coalesce(cards.name, 'Unknown'), ', ' order by blockers.damage_assignment_order, blockers.created_at, blockers.id) as blocker_names,
      count(*)::integer as blocker_count,
      jsonb_agg(
        jsonb_build_object(
          'id', blockers.id,
          'blocker_card_id', blockers.blocker_card_id,
          'blocker_name', coalesce(cards.name, 'Unknown'),
          'damage_assignment_order', blockers.damage_assignment_order,
          'blocking_player_id', blockers.blocking_player_id
        )
        order by blockers.damage_assignment_order, blockers.created_at, blockers.id
      ) as blockers
    from public.game_combat_blockers blockers
    left join public.game_cards blocker_instance
      on blocker_instance.id = blockers.blocker_card_id
    left join public.cards
      on cards.id = blocker_instance.card_id
    group by blockers.assignment_id
  )
  select
    combat.id,
    combat.session_id,
    combat.turn_number,
    combat.attacker_card_id,
    coalesce(attacker_card.name, 'Unknown') as attacker_name,
    public.card_effective_power(combat.session_id, combat.attacker_card_id) as attacker_power,
    public.card_effective_toughness(combat.session_id, combat.attacker_card_id) as attacker_toughness,
    combat.attacking_player_id,
    coalesce(nullif(attacking_profile.username, ''), left(combat.attacking_player_id::text, 8)) as attacking_username,
    combat.defending_player_id,
    coalesce(nullif(defending_profile.username, ''), left(combat.defending_player_id::text, 8)) as defending_username,
    coalesce(blocker_summary.first_blocker_card_id, combat.blocker_card_id) as blocker_card_id,
    coalesce(blocker_summary.blocker_names, blocker_card.name) as blocker_name,
    coalesce(blocker_summary.blocker_count, 0) as blocker_count,
    coalesce(blocker_summary.blockers, '[]'::jsonb) as blockers,
    combat.created_at
  from public.game_combat_assignments combat
  join public.game_turn_state turn_state
    on turn_state.session_id = combat.session_id
   and turn_state.turn_number = combat.turn_number
  left join blocker_summary
    on blocker_summary.assignment_id = combat.id
  left join public.game_cards attacker_instance
    on attacker_instance.id = combat.attacker_card_id
  left join public.cards attacker_card
    on attacker_card.id = attacker_instance.card_id
  left join public.game_cards blocker_instance
    on blocker_instance.id = combat.blocker_card_id
  left join public.cards blocker_card
    on blocker_card.id = blocker_instance.card_id
  left join public.profiles attacking_profile
    on attacking_profile.id = combat.attacking_player_id
  left join public.profiles defending_profile
    on defending_profile.id = combat.defending_player_id
  where combat.session_id = p_session_id
    and public.is_session_player(p_session_id, auth.uid())
  order by combat.created_at;
$$;


ALTER FUNCTION "public"."get_combat_assignments"("p_session_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_land_play_limit"("p_session_id" "uuid", "p_player_id" "uuid") RETURNS integer
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select 1 + coalesce(sum(coalesce((effects.payload ->> 'amount')::integer, 0)), 0)::integer
  from public.game_continuous_effects effects
  left join public.game_cards source_card
    on source_card.id = effects.source_card_id
  where effects.session_id = p_session_id
    and effects.effect_type = 'additional_land_plays'
    and (effects.affected_player_id is null or effects.affected_player_id = p_player_id)
    and public.is_session_player(p_session_id, auth.uid())
    and public.is_session_player(p_session_id, p_player_id)
    and (
      effects.source_zone_required is null
      or source_card.zone = effects.source_zone_required
    );
$$;


ALTER FUNCTION "public"."get_land_play_limit"("p_session_id" "uuid", "p_player_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_session_players"("p_session_id" "uuid") RETURNS TABLE("session_id" "uuid", "player_id" "uuid", "username" "text", "seat_number" integer, "life_total" integer, "joined_at" timestamp with time zone)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select
    game_session_players.session_id,
    game_session_players.player_id,
    coalesce(
      nullif(profiles.username, ''),
      left(game_session_players.player_id::text, 8)
    ) as username,
    game_session_players.seat_number,
    game_session_players.life_total,
    game_session_players.joined_at
  from public.game_session_players
  left join public.profiles
    on profiles.id = game_session_players.player_id
  where game_session_players.session_id = p_session_id
    and public.is_session_player(p_session_id, auth.uid())
  order by game_session_players.seat_number;
$$;


ALTER FUNCTION "public"."get_session_players"("p_session_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_stack_items"("p_session_id" "uuid") RETURNS TABLE("id" "uuid", "session_id" "uuid", "controller_player_id" "uuid", "controller_username" "text", "source_card_id" "uuid", "source_card_name" "text", "target_player_id" "uuid", "target_username" "text", "action_type" "text", "payload" "jsonb", "position" integer, "status" "text", "created_at" timestamp with time zone, "resolved_at" timestamp with time zone)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select
    stack_items.id,
    stack_items.session_id,
    stack_items.controller_player_id,
    coalesce(nullif(controller_profiles.username, ''), 'Unknown player') as controller_username,
    stack_items.source_card_id,
    coalesce(source_card.name, nullif(stack_items.payload ->> 'label', '')) as source_card_name,
    nullif(stack_items.payload ->> 'target_player_id', '')::uuid as target_player_id,
    coalesce(nullif(target_profiles.username, ''), 'Unknown player') as target_username,
    stack_items.action_type,
    stack_items.payload,
    stack_items.position,
    stack_items.status,
    stack_items.created_at,
    stack_items.resolved_at
  from public.game_stack_items stack_items
  left join public.profiles controller_profiles
    on controller_profiles.id = stack_items.controller_player_id
  left join public.game_cards source_instance
    on source_instance.id = stack_items.source_card_id
  left join public.cards source_card
    on source_card.id = source_instance.card_id
  left join public.profiles target_profiles
    on target_profiles.id = nullif(stack_items.payload ->> 'target_player_id', '')::uuid
  where stack_items.session_id = p_session_id
    and public.is_session_player(p_session_id, auth.uid())
  order by
    case stack_items.status when 'pending' then 0 else 1 end,
    stack_items.position desc,
    stack_items.created_at desc;
$$;


ALTER FUNCTION "public"."get_stack_items"("p_session_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_turn_state"("p_session_id" "uuid") RETURNS TABLE("session_id" "uuid", "active_player_id" "uuid", "active_username" "text", "priority_player_id" "uuid", "priority_username" "text", "priority_cycle_started_by" "uuid", "priority_pass_count" integer, "lands_played_this_turn" integer, "land_play_limit" integer, "turn_number" integer, "phase" "text", "step" "text", "created_at" timestamp with time zone, "updated_at" timestamp with time zone)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select
    turn_state.session_id,
    turn_state.active_player_id,
    coalesce(nullif(active_profiles.username, ''), left(turn_state.active_player_id::text, 8)) as active_username,
    coalesce(turn_state.priority_player_id, turn_state.active_player_id) as priority_player_id,
    coalesce(
      nullif(priority_profiles.username, ''),
      nullif(active_profiles.username, ''),
      left(coalesce(turn_state.priority_player_id, turn_state.active_player_id)::text, 8)
    ) as priority_username,
    turn_state.priority_cycle_started_by,
    coalesce(turn_state.priority_pass_count, 0) as priority_pass_count,
    coalesce(turn_state.lands_played_this_turn, 0) as lands_played_this_turn,
    public.get_land_play_limit(p_session_id, auth.uid()) as land_play_limit,
    turn_state.turn_number,
    turn_state.phase,
    turn_state.step,
    turn_state.created_at,
    turn_state.updated_at
  from public.game_turn_state turn_state
  left join public.profiles active_profiles
    on active_profiles.id = turn_state.active_player_id
  left join public.profiles priority_profiles
    on priority_profiles.id = coalesce(turn_state.priority_player_id, turn_state.active_player_id)
  where turn_state.session_id = p_session_id
    and public.is_session_player(p_session_id, auth.uid());
$$;


ALTER FUNCTION "public"."get_turn_state"("p_session_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."import_deck_from_text"("p_name" "text", "p_decklist" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_deck_name text := nullif(trim(p_name), '');
  v_line text;
  v_clean_line text;
  v_quantity integer;
  v_card_name text;
  v_card_id uuid;
  v_card_ids jsonb := '[]'::jsonb;
  v_missing jsonb := '[]'::jsonb;
  v_line_number integer := 0;
  v_total_count integer := 0;
  v_deck_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if v_deck_name is null then
    raise exception 'Deck name is required';
  end if;

  if nullif(trim(coalesce(p_decklist, '')), '') is null then
    raise exception 'Decklist is required';
  end if;

  for v_line in
    select regexp_split_to_table(p_decklist, E'\r?\n')
  loop
    v_line_number := v_line_number + 1;
    v_clean_line := trim(v_line);

    if v_clean_line = ''
      or left(v_clean_line, 1) = '#'
      or lower(v_clean_line) in ('deck', 'sideboard', 'commander')
    then
      continue;
    end if;

    v_clean_line := regexp_replace(v_clean_line, '^[[:space:]]*SB:[[:space:]]*', '', 'i');

    if v_clean_line ~* '^[0-9]+x?[[:space:]]+.+' then
      v_quantity := substring(v_clean_line from '^[0-9]+')::integer;
      v_card_name := trim(regexp_replace(v_clean_line, '^[0-9]+x?[[:space:]]+', '', 'i'));
    else
      v_quantity := 1;
      v_card_name := v_clean_line;
    end if;

    v_card_name := trim(regexp_replace(v_card_name, '[[:space:]]+\([^)]*\)[[:space:]]+[0-9]+[[:space:]]*$', ''));
    v_card_name := trim(regexp_replace(v_card_name, '[[:space:]]+\([^)]*\)[[:space:]]*$', ''));
    v_card_name := trim(regexp_replace(v_card_name, '[[:space:]]+\[[^]]*\][[:space:]]*$', ''));

    if v_quantity <= 0 or v_card_name = '' then
      continue;
    end if;

    select cards.id
    into v_card_id
    from public.cards
    where lower(cards.name) = lower(v_card_name)
    order by
      case when cards.image_url is null then 1 else 0 end,
      cards.name,
      cards.id
    limit 1;

    if not found then
      v_missing := v_missing || jsonb_build_array(
        jsonb_build_object(
          'line_number', v_line_number,
          'line', v_clean_line,
          'name', v_card_name,
          'quantity', v_quantity
        )
      );
      continue;
    end if;

    for i in 1..v_quantity loop
      v_card_ids := v_card_ids || jsonb_build_array(v_card_id);
      v_total_count := v_total_count + 1;
    end loop;
  end loop;

  if v_total_count = 0 then
    return jsonb_build_object(
      'id', null,
      'name', v_deck_name,
      'card_count', 0,
      'missing', v_missing
    );
  end if;

  insert into public.decks (
    name,
    list_data,
    created_by,
    owner_id
  )
  values (
    v_deck_name,
    v_card_ids,
    auth.uid(),
    auth.uid()
  )
  returning id into v_deck_id;

  return jsonb_build_object(
    'id', v_deck_id,
    'name', v_deck_name,
    'card_count', v_total_count,
    'missing', v_missing
  );
end;
$_$;


ALTER FUNCTION "public"."import_deck_from_text"("p_name" "text", "p_decklist" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."initialize_turn_state"("p_session_id" "uuid", "p_active_player_id" "uuid") RETURNS "public"."game_turn_state"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_active_player_id <> auth.uid() then
    raise exception 'Cannot initialize turn state for another player';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select status
  into v_session_status
  from public.game_sessions
  where id = p_session_id;

  if not found then
    raise exception 'Game session not found';
  end if;

  if v_session_status = 'finished' then
    raise exception 'Cannot initialize turn state for a finished game session';
  end if;

  insert into public.game_turn_state (
    session_id,
    active_player_id,
    priority_player_id,
    turn_number,
    phase,
    step
  )
  values (
    p_session_id,
    p_active_player_id,
    p_active_player_id,
    1,
    'beginning',
    'untap'
  )
  on conflict (session_id) do update
  set session_id = excluded.session_id
  returning * into v_turn_state;

  return v_turn_state;
end;
$$;


ALTER FUNCTION "public"."initialize_turn_state"("p_session_id" "uuid", "p_active_player_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_session_player"("p_session_id" "uuid", "p_player_id" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.game_session_players
    where session_id = p_session_id
      and player_id = p_player_id
  );
$$;


ALTER FUNCTION "public"."is_session_player"("p_session_id" "uuid", "p_player_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."join_game_session"("p_session_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_status text;
  v_seat_number integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select status
  into v_status
  from public.game_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Game session not found';
  end if;

  if v_status <> 'open' then
    raise exception 'Game session is not open';
  end if;

  select seat_number
  into v_seat_number
  from public.game_session_players
  where session_id = p_session_id
    and player_id = auth.uid();

  if found then
    return v_seat_number;
  end if;

  select coalesce(max(seat_number), 0) + 1
  into v_seat_number
  from public.game_session_players
  where session_id = p_session_id;

  insert into public.game_session_players (
    session_id,
    player_id,
    seat_number,
    life_total
  )
  values (
    p_session_id,
    auth.uid(),
    v_seat_number,
    20
  );

  return v_seat_number;
end;
$$;


ALTER FUNCTION "public"."join_game_session"("p_session_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."lock_game_session"("p_session_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  update public.game_sessions
  set
    status = 'locked',
    locked_at = coalesce(locked_at, now())
  where id = p_session_id
    and created_by = auth.uid()
    and status = 'open';

  if not found then
    raise exception 'Game session not found, not open, or not created by current user';
  end if;

  return true;
end;
$$;


ALTER FUNCTION "public"."lock_game_session"("p_session_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."maybe_finish_game_session"("p_session_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_alive_count integer;
  v_total_players integer;
  v_winner_player_id uuid;
  v_session_status text;
begin
  select status
  into v_session_status
  from public.game_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Game session not found';
  end if;

  if v_session_status = 'finished' then
    return jsonb_build_object(
      'finished', true,
      'winner_player_id', (
        select winner_player_id
        from public.game_sessions
        where id = p_session_id
      )
    );
  end if;

  select
    count(*) filter (where life_total > 0),
    count(*)
  into v_alive_count, v_total_players
  from public.game_session_players
  where session_id = p_session_id;

  if v_total_players < 2 then
    return jsonb_build_object('finished', false, 'winner_player_id', null);
  end if;

  if v_alive_count = 1 then
    select player_id
    into v_winner_player_id
    from public.game_session_players
    where session_id = p_session_id
      and life_total > 0
    limit 1;

    update public.game_sessions
    set
      status = 'finished',
      finished_at = coalesce(finished_at, now()),
      winner_player_id = v_winner_player_id
    where id = p_session_id;

    return jsonb_build_object(
      'finished', true,
      'winner_player_id', v_winner_player_id
    );
  end if;

  if v_alive_count = 0 then
    update public.game_sessions
    set
      status = 'finished',
      finished_at = coalesce(finished_at, now()),
      winner_player_id = null
    where id = p_session_id;

    return jsonb_build_object('finished', true, 'winner_player_id', null);
  end if;

  return jsonb_build_object('finished', false, 'winner_player_id', null);
end;
$$;


ALTER FUNCTION "public"."maybe_finish_game_session"("p_session_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."move_card_to_zone"("p_game_card_id" "uuid", "p_zone" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_session_id uuid;
  v_turn_number integer;
begin
  if p_zone not in ('library', 'hand', 'stack', 'battlefield', 'graveyard', 'exile') then
    raise exception 'Invalid zone: %', p_zone;
  end if;

  if p_zone = 'battlefield' then
    select turn_number
    into v_turn_number
    from public.game_turn_state
    where session_id = (
      select session_id
      from public.game_cards
      where id = p_game_card_id
        and owner_id = auth.uid()
    );
  end if;

  update public.game_cards
  set
    zone = p_zone,
    entered_battlefield_turn_number = case
      when p_zone = 'battlefield' then coalesce(v_turn_number, entered_battlefield_turn_number, 0)
      else entered_battlefield_turn_number
    end,
    is_tapped = false
  where id = p_game_card_id
    and owner_id = auth.uid()
  returning session_id into v_session_id;

  if not found then
    raise exception 'Card not found or not owned by current user';
  end if;

  perform public.rebuild_scripted_continuous_effects(v_session_id);
end;
$$;


ALTER FUNCTION "public"."move_card_to_zone"("p_game_card_id" "uuid", "p_zone" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."move_lethal_damaged_creatures_to_graveyard"("p_session_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_destroyed_count integer := 0;
  v_dying uuid[];
  v_card uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select array_agg(
    game_cards.id
    order by game_cards.owner_id, game_cards.zone_position, game_cards.id
  )
  into v_dying
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.session_id = p_session_id
    and game_cards.zone = 'battlefield'
    and coalesce(cards.type_line, '') ilike '%creature%'
    and (
      -- 704.5f: toughness 0 or less. Ignores indestructible and damage.
      public.card_effective_toughness(p_session_id, game_cards.id) <= 0
      or (
        -- 704.5g: lethal marked damage. Indestructible prevents this.
        game_cards.damage_marked > 0
        and not public.card_has_indestructible(p_session_id, game_cards.id)
        and (
          game_cards.dealt_deathtouch_damage = true
          or game_cards.damage_marked >= public.card_effective_toughness(p_session_id, game_cards.id)
        )
      )
    );

  foreach v_card in array coalesce(v_dying, array[]::uuid[])
  loop
    if public.put_in_graveyard(p_session_id, v_card) then
      v_destroyed_count := v_destroyed_count + 1;
    end if;
  end loop;

  if v_destroyed_count > 0 then
    perform public.rebuild_scripted_continuous_effects(p_session_id);
  end if;

  return v_destroyed_count;
end;
$$;


ALTER FUNCTION "public"."move_lethal_damaged_creatures_to_graveyard"("p_session_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pass_priority"("p_session_id" "uuid") RETURNS "public"."game_turn_state"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_current_state public.game_turn_state;
  v_session_status text;
  v_current_priority_player_id uuid;
  v_next_priority_player_id uuid;
  v_player_count integer;
  v_pending_stack_count integer;
  v_next_pass_count integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
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
    raise exception 'Cannot pass priority in a finished game session';
  end if;

  select *
  into v_current_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  v_current_priority_player_id := coalesce(
    v_current_state.priority_player_id,
    v_current_state.active_player_id
  );

  if v_current_priority_player_id <> auth.uid() then
    raise exception 'Only the priority player can pass priority';
  end if;

  select count(*)
  into v_player_count
  from public.game_session_players
  where session_id = p_session_id;

  if v_player_count <= 1 then
    select count(*)
    into v_pending_stack_count
    from public.game_stack_items
    where session_id = p_session_id
      and status = 'pending';

    if v_pending_stack_count > 0 then
      perform public.resolve_top_of_stack(p_session_id);

      select *
      into v_current_state
      from public.game_turn_state
      where session_id = p_session_id;

      return v_current_state;
    end if;

    return public.advance_step(p_session_id);
  end if;

  v_next_pass_count := coalesce(v_current_state.priority_pass_count, 0) + 1;

  if v_next_pass_count >= v_player_count then
    select count(*)
    into v_pending_stack_count
    from public.game_stack_items
    where session_id = p_session_id
      and status = 'pending';

    if v_pending_stack_count > 0 then
      perform public.resolve_top_of_stack(p_session_id);

      select *
      into v_current_state
      from public.game_turn_state
      where session_id = p_session_id;

      return v_current_state;
    end if;

    return public.advance_step(p_session_id);
  end if;

  select next_player.player_id
  into v_next_priority_player_id
  from public.game_session_players current_player
  join public.game_session_players next_player
    on next_player.session_id = current_player.session_id
   and next_player.seat_number > current_player.seat_number
  where current_player.session_id = p_session_id
    and current_player.player_id = v_current_priority_player_id
  order by next_player.seat_number
  limit 1;

  if v_next_priority_player_id is null then
    select player_id
    into v_next_priority_player_id
    from public.game_session_players
    where session_id = p_session_id
    order by seat_number
    limit 1;
  end if;

  if v_next_priority_player_id is null then
    raise exception 'No players found for game session';
  end if;

  update public.game_turn_state
  set
    priority_player_id = v_next_priority_player_id,
    priority_cycle_started_by = coalesce(
      priority_cycle_started_by,
      v_current_priority_player_id
    ),
    priority_pass_count = v_next_pass_count
  where session_id = p_session_id
  returning * into v_current_state;

  return v_current_state;
end;
$$;


ALTER FUNCTION "public"."pass_priority"("p_session_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pay_mana_cost"("p_session_id" "uuid", "p_player_id" "uuid", "p_mana_cost" "text", "p_generic_payment" "jsonb" DEFAULT NULL::"jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_empty_pool jsonb := jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0);
  v_current_pool jsonb;
  v_new_pool jsonb;
  v_clean_cost text;
  v_symbol text;
  v_generic_cost integer := 0;
  v_available_generic integer := 0;
  v_declared_generic_payment integer := 0;
  v_pay_amount integer;
  v_color text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_player_id <> auth.uid() then
    raise exception 'Cannot pay mana for another player';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if p_mana_cost is null or btrim(p_mana_cost) = '' then
    return v_empty_pool;
  end if;

  insert into public.game_players (session_id, player_id, mana_pool)
  values (p_session_id, p_player_id, v_empty_pool)
  on conflict (session_id, player_id) do nothing;

  select coalesce(mana_pool, v_empty_pool)
  into v_current_pool
  from public.game_players
  where session_id = p_session_id
    and player_id = p_player_id
  for update;

  v_new_pool := v_current_pool;
  v_clean_cost := upper(regexp_replace(p_mana_cost, '[{}\s]', '', 'g'));

  for v_symbol in
    select token[1]
    from regexp_matches(v_clean_cost, '([0-9]+|[WUBRGC])', 'g') as token
  loop
    if v_symbol ~ '^[0-9]+$' then
      v_generic_cost := v_generic_cost + v_symbol::integer;
    else
      v_pay_amount := coalesce((v_new_pool ->> v_symbol)::integer, 0);

      if v_pay_amount <= 0 then
        raise exception 'Not enough % mana to pay %', v_symbol, p_mana_cost;
      end if;

      v_new_pool := v_new_pool || jsonb_build_object(v_symbol, v_pay_amount - 1);
    end if;
  end loop;

  if v_generic_cost > 0 then
    select sum(coalesce((v_new_pool ->> color_symbol)::integer, 0))
    into v_available_generic
    from unnest(array['C', 'W', 'U', 'B', 'R', 'G']) as color_symbol;

    if coalesce(v_available_generic, 0) < v_generic_cost then
      raise exception 'Not enough mana to pay generic cost % for %', v_generic_cost, p_mana_cost;
    end if;

    if p_generic_payment is not null and p_generic_payment <> 'null'::jsonb then
      foreach v_color in array array['C', 'W', 'U', 'B', 'R', 'G']
      loop
        v_pay_amount := coalesce((p_generic_payment ->> v_color)::integer, 0);

        if v_pay_amount < 0 then
          raise exception 'Generic mana payment cannot be negative';
        end if;

        v_declared_generic_payment := v_declared_generic_payment + v_pay_amount;
      end loop;

      if v_declared_generic_payment <> v_generic_cost then
        raise exception 'Generic mana payment must total %, got %', v_generic_cost, v_declared_generic_payment;
      end if;

      foreach v_color in array array['C', 'W', 'U', 'B', 'R', 'G']
      loop
        v_pay_amount := coalesce((p_generic_payment ->> v_color)::integer, 0);

        if v_pay_amount > coalesce((v_new_pool ->> v_color)::integer, 0) then
          raise exception 'Not enough % mana to pay chosen generic cost', v_color;
        end if;

        if v_pay_amount > 0 then
          v_new_pool := v_new_pool || jsonb_build_object(
            v_color,
            coalesce((v_new_pool ->> v_color)::integer, 0) - v_pay_amount
          );
        end if;
      end loop;
    else
      foreach v_color in array array['C', 'W', 'U', 'B', 'R', 'G']
      loop
        exit when v_generic_cost <= 0;

        v_pay_amount := least(coalesce((v_new_pool ->> v_color)::integer, 0), v_generic_cost);

        if v_pay_amount > 0 then
          v_new_pool := v_new_pool || jsonb_build_object(
            v_color,
            coalesce((v_new_pool ->> v_color)::integer, 0) - v_pay_amount
          );
          v_generic_cost := v_generic_cost - v_pay_amount;
        end if;
      end loop;
    end if;
  end if;

  update public.game_players
  set mana_pool = v_new_pool
  where session_id = p_session_id
    and player_id = p_player_id;

  return v_new_pool;
end;
$_$;


ALTER FUNCTION "public"."pay_mana_cost"("p_session_id" "uuid", "p_player_id" "uuid", "p_mana_cost" "text", "p_generic_payment" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."put_action_on_stack"("p_session_id" "uuid", "p_action_type" "text", "p_payload" "jsonb", "p_source_card_id" "uuid" DEFAULT NULL::"uuid") RETURNS "public"."game_stack_items"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_target_player_id uuid;
  v_target_card_id uuid;
  v_target_stack_item public.game_stack_items;
  v_target_stack_label text;
  v_amount integer;
  v_pump_power integer;
  v_pump_toughness integer;
  v_action_timing text;
  v_target_controller text;
  v_source_type_line text;
  v_source_zone text;
  v_source_mana_cost text;
  v_generic_payment jsonb;
  v_pending_stack_count integer;
  v_next_graveyard_position integer;
  v_next_position integer;
  v_stack_item public.game_stack_items;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
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
    raise exception 'Cannot put actions on the stack in a finished game session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can put actions on the stack';
  end if;

  if p_action_type not in (
    'deal_damage_player',
    'deal_damage_creature',
    'pump_creature',
    'counter_spell',
    'draw_cards',
    'destroy_creature',
    'bounce_creature',
    'tap_creature',
    'untap_creature',
    'add_counters_creature',
    'exile_creature'
  ) then
    raise exception 'Unsupported stack action type: %', p_action_type;
  end if;

  if p_source_card_id is not null then
    select cards.type_line, cards.mana_cost, game_cards.zone
    into v_source_type_line, v_source_mana_cost, v_source_zone
    from public.game_cards
    join public.cards
      on cards.id = game_cards.card_id
    where game_cards.id = p_source_card_id
      and game_cards.session_id = p_session_id
      and game_cards.owner_id = auth.uid();

    if not found then
      raise exception 'Source card not found or not owned by current user';
    end if;
  end if;

  v_action_timing := lower(nullif(p_payload ->> 'timing', ''));

  if v_action_timing is null then
    if v_source_type_line ilike '%instant%' then
      v_action_timing := 'instant';
    elsif v_source_type_line ilike '%sorcery%' then
      v_action_timing := 'sorcery';
    else
      raise exception 'Action timing is required for non-Instant and non-Sorcery sources';
    end if;
  end if;

  if v_action_timing not in ('instant', 'sorcery') then
    raise exception 'Unsupported action timing: %', v_action_timing;
  end if;

  if p_action_type = 'counter_spell' and v_action_timing <> 'instant' then
    raise exception 'Counterspell actions must use instant timing';
  end if;

  if v_action_timing = 'sorcery' then
    if v_turn_state.active_player_id <> auth.uid() then
      raise exception 'Sorcery actions can only be used by the active player';
    end if;

    if v_turn_state.step not in ('precombat_main', 'postcombat_main') then
      raise exception 'Sorcery actions can only be used during a main phase';
    end if;

    select count(*)
    into v_pending_stack_count
    from public.game_stack_items
    where session_id = p_session_id
      and status = 'pending';

    if v_pending_stack_count > 0 then
      raise exception 'Sorcery actions can only be used while the stack is empty';
    end if;
  end if;

  v_generic_payment := p_payload -> 'generic_payment';
  v_target_controller := coalesce(lower(nullif(p_payload ->> 'target_controller', '')), 'any');

  if p_action_type = 'deal_damage_player' then
    v_target_player_id := nullif(p_payload ->> 'target_player_id', '')::uuid;
    v_amount := coalesce((p_payload ->> 'amount')::integer, 0);

    if v_target_player_id is null then
      raise exception 'target_player_id is required';
    end if;

    if v_amount <= 0 then
      raise exception 'amount must be positive';
    end if;

    if not public.is_session_player(p_session_id, v_target_player_id) then
      raise exception 'Target player is not a player in this session';
    end if;
  elsif p_action_type = 'deal_damage_creature' then
    v_target_card_id := nullif(p_payload ->> 'target_card_id', '')::uuid;
    v_amount := coalesce((p_payload ->> 'amount')::integer, 0);

    if v_target_card_id is null then
      raise exception 'target_card_id is required';
    end if;

    if v_amount <= 0 then
      raise exception 'amount must be positive';
    end if;

    if not public.creature_target_controller_ok(p_session_id, v_target_card_id, auth.uid(), v_target_controller) then
      raise exception 'Target is not a legal creature for this spell';
    end if;
  elsif p_action_type = 'pump_creature' then
    v_target_card_id := nullif(p_payload ->> 'target_card_id', '')::uuid;
    v_pump_power := coalesce((p_payload ->> 'power')::integer, 0);
    v_pump_toughness := coalesce((p_payload ->> 'toughness')::integer, 0);

    if v_target_card_id is null then
      raise exception 'target_card_id is required';
    end if;

    if not public.creature_target_controller_ok(p_session_id, v_target_card_id, auth.uid(), v_target_controller) then
      raise exception 'Target is not a legal creature for this spell';
    end if;
  elsif p_action_type in ('destroy_creature', 'bounce_creature', 'tap_creature', 'untap_creature', 'add_counters_creature', 'exile_creature') then
    -- These all target a creature on the battlefield; identical validation.
    v_target_card_id := nullif(p_payload ->> 'target_card_id', '')::uuid;
    v_amount := coalesce((p_payload ->> 'amount')::integer, 0);

    if v_target_card_id is null then
      raise exception 'target_card_id is required';
    end if;

    if p_action_type = 'add_counters_creature' and v_amount <= 0 then
      raise exception 'amount must be positive';
    end if;

    if not public.creature_target_controller_ok(p_session_id, v_target_card_id, auth.uid(), v_target_controller) then
      raise exception 'Target is not a legal creature for this spell';
    end if;
  elsif p_action_type = 'draw_cards' then
    v_amount := coalesce((p_payload ->> 'amount')::integer, 0);

    if v_amount <= 0 then
      raise exception 'amount must be positive';
    end if;
  elsif p_action_type = 'counter_spell' then
    select *
    into v_target_stack_item
    from public.game_stack_items
    where id = nullif(p_payload ->> 'target_stack_item_id', '')::uuid
      and session_id = p_session_id
      and status = 'pending'
    for update;

    if not found then
      raise exception 'Target stack item not found or no longer pending';
    end if;

    select coalesce(source_card.name, v_target_stack_item.action_type)
    into v_target_stack_label
    from public.game_stack_items target_stack
    left join public.game_cards source_instance
      on source_instance.id = target_stack.source_card_id
    left join public.cards source_card
      on source_card.id = source_instance.card_id
    where target_stack.id = v_target_stack_item.id;
  end if;

  if p_source_card_id is not null and v_source_zone = 'hand' then
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_source_mana_cost, v_generic_payment);
  end if;

  select coalesce(max(position), -1) + 1
  into v_next_position
  from public.game_stack_items
  where session_id = p_session_id;

  insert into public.game_stack_items (
    session_id,
    controller_player_id,
    source_card_id,
    action_type,
    payload,
    position
  )
  values (
    p_session_id,
    auth.uid(),
    p_source_card_id,
    p_action_type,
    case
      when p_action_type = 'deal_damage_player' then
        jsonb_build_object(
          'target_player_id', v_target_player_id,
          'amount', v_amount,
          'timing', v_action_timing
        )
      when p_action_type = 'deal_damage_creature' then
        jsonb_build_object(
          'target_card_id', v_target_card_id,
          'amount', v_amount,
          'target_controller', v_target_controller,
          'timing', v_action_timing
        )
      when p_action_type = 'pump_creature' then
        jsonb_build_object(
          'target_card_id', v_target_card_id,
          'power', v_pump_power,
          'toughness', v_pump_toughness,
          'target_controller', v_target_controller,
          'timing', v_action_timing
        )
      when p_action_type in ('destroy_creature', 'bounce_creature', 'tap_creature', 'untap_creature', 'exile_creature') then
        jsonb_build_object(
          'target_card_id', v_target_card_id,
          'target_controller', v_target_controller,
          'timing', v_action_timing
        )
      when p_action_type = 'add_counters_creature' then
        jsonb_build_object(
          'target_card_id', v_target_card_id,
          'amount', v_amount,
          'target_controller', v_target_controller,
          'timing', v_action_timing
        )
      when p_action_type = 'draw_cards' then
        jsonb_build_object(
          'amount', v_amount,
          'timing', v_action_timing
        )
      else
        jsonb_build_object(
          'target_stack_item_id', v_target_stack_item.id,
          'target_stack_label', coalesce(v_target_stack_label, v_target_stack_item.action_type),
          'timing', v_action_timing
        )
    end,
    v_next_position
  )
  returning * into v_stack_item;

  if p_source_card_id is not null
    and v_source_zone = 'hand'
    and (
      v_source_type_line ilike '%instant%'
      or v_source_type_line ilike '%sorcery%'
    )
  then
    select coalesce(max(zone_position), -1) + 1
    into v_next_graveyard_position
    from public.game_cards
    where session_id = p_session_id
      and owner_id = auth.uid()
      and zone = 'graveyard';

    update public.game_cards
    set
      zone = 'graveyard',
      zone_position = v_next_graveyard_position,
      is_tapped = false,
      damage_marked = 0
    where id = p_source_card_id;
  end if;

  return v_stack_item;
end;
$$;


ALTER FUNCTION "public"."put_action_on_stack"("p_session_id" "uuid", "p_action_type" "text", "p_payload" "jsonb", "p_source_card_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."put_in_graveyard"("p_session_id" "uuid", "p_game_card_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_owner_id uuid;
  v_next_graveyard_position integer;
begin
  select owner_id
  into v_owner_id
  from public.game_cards
  where id = p_game_card_id
    and session_id = p_session_id
    and zone = 'battlefield';

  if not found then
    return false;
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

  return true;
end;
$$;


ALTER FUNCTION "public"."put_in_graveyard"("p_session_id" "uuid", "p_game_card_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rebuild_scripted_continuous_effects"("p_session_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_card record;
  v_registered_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  delete from public.game_continuous_effects
  where session_id = p_session_id
    and payload ->> 'registered_from_card_script' = 'true';

  for v_card in
    select game_cards.id
    from public.game_cards
    left join public.cards
      on cards.id = game_cards.card_id
    where game_cards.session_id = p_session_id
      and game_cards.zone = 'battlefield'
      and game_cards.static_effects_suppressed = false
      and (
        public.card_behavior_has_continuous_effects(coalesce(game_cards.copied_script, '{}'::jsonb))
        or public.card_behavior_has_continuous_effects(coalesce(cards.script, '{}'::jsonb))
        or jsonb_array_length(coalesce(cards.keywords, '[]'::jsonb)) > 0
      )
  loop
    v_registered_count := v_registered_count
      + public.register_card_continuous_effects(p_session_id, v_card.id);
  end loop;

  return v_registered_count;
end;
$$;


ALTER FUNCTION "public"."rebuild_scripted_continuous_effects"("p_session_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."register_card_continuous_effects"("p_session_id" "uuid", "p_source_card_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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
      'deathtouch'
    ) then
      raise exception 'Unsupported continuous effect type: %', v_effect_type;
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
          'deathtouch'
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


ALTER FUNCTION "public"."register_card_continuous_effects"("p_session_id" "uuid", "p_source_card_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."relink_card_scripts"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_updated integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  with scripted as (
    -- One canonical script per oracle_id (any printing that has a non-empty one).
    select distinct on (oracle_id)
      oracle_id,
      script
    from public.cards
    where oracle_id is not null
      and script is not null
      and script <> '{}'::jsonb
    order by oracle_id, id
  )
  update public.cards target
  set script = scripted.script
  from scripted
  where target.oracle_id = scripted.oracle_id
    and (target.script is null or target.script = '{}'::jsonb);

  get diagnostics v_updated = row_count;

  return v_updated;
end;
$$;


ALTER FUNCTION "public"."relink_card_scripts"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_combat_damage"("p_session_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_required_player_id uuid;
  v_assignment record;
  v_blocker record;
  v_attacker_damage integer;
  v_remaining_attacker_damage integer;
  v_blocker_damage integer;
  v_assigned_damage integer;
  v_has_blockers boolean;
  v_is_first_strike_stage boolean := false;
  v_attacker_has_first_strike boolean;
  v_attacker_has_double_strike boolean;
  v_attacker_has_deathtouch boolean;
  v_attacker_deals_damage boolean;
  v_blocker_has_first_strike boolean;
  v_blocker_has_double_strike boolean;
  v_blocker_has_deathtouch boolean;
  v_blocker_deals_damage boolean;
  v_lethal_per_blocker integer;
  v_total_player_damage integer := 0;
  v_total_creature_damage integer := 0;
  v_destroyed_count integer := 0;
  v_resolved_count integer := 0;
  v_finish_state jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
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
    raise exception 'Cannot resolve combat damage in a finished game session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if v_turn_state.step <> 'combat_damage' then
    raise exception 'Combat damage can only be resolved during Combat Damage Step';
  end if;

  v_required_player_id := coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id);

  if v_required_player_id <> auth.uid() then
    raise exception 'Only the priority player can resolve combat damage';
  end if;

  select exists (
    select 1
    from public.game_combat_assignments combat
    left join public.game_cards attacker_instance
      on attacker_instance.id = combat.attacker_card_id
     and attacker_instance.zone = 'battlefield'
    left join public.game_combat_blockers blockers
      on blockers.assignment_id = combat.id
    left join public.game_cards blocker_instance
      on blocker_instance.id = blockers.blocker_card_id
     and blocker_instance.zone = 'battlefield'
    where combat.session_id = p_session_id
      and combat.turn_number = v_turn_state.turn_number
      and combat.damage_resolved = false
      and combat.first_strike_damage_resolved = false
      and (
        public.card_has_first_strike(p_session_id, attacker_instance.id)
        or public.card_has_double_strike(p_session_id, attacker_instance.id)
        or public.card_has_first_strike(p_session_id, blocker_instance.id)
        or public.card_has_double_strike(p_session_id, blocker_instance.id)
      )
  )
  into v_is_first_strike_stage;

  for v_assignment in
    select
      combat.id,
      combat.attacker_card_id,
      combat.defending_player_id,
      attacker_instance.id is not null as attacker_on_battlefield,
      public.card_effective_power(p_session_id, combat.attacker_card_id) as attacker_power
    from public.game_combat_assignments combat
    left join public.game_cards attacker_instance
      on attacker_instance.id = combat.attacker_card_id
     and attacker_instance.zone = 'battlefield'
    where combat.session_id = p_session_id
      and combat.turn_number = v_turn_state.turn_number
      and combat.damage_resolved = false
      and (
        v_is_first_strike_stage = false
        or combat.first_strike_damage_resolved = false
      )
    order by combat.created_at
    for update of combat
  loop
    if not v_assignment.attacker_on_battlefield then
      if not v_is_first_strike_stage then
        update public.game_combat_assignments
        set damage_resolved = true
        where id = v_assignment.id;
      end if;

      continue;
    end if;

    v_attacker_damage := greatest(0, v_assignment.attacker_power);
    v_remaining_attacker_damage := v_attacker_damage;
    v_attacker_has_first_strike := public.card_has_first_strike(p_session_id, v_assignment.attacker_card_id);
    v_attacker_has_double_strike := public.card_has_double_strike(p_session_id, v_assignment.attacker_card_id);
    v_attacker_has_deathtouch := public.card_has_deathtouch(p_session_id, v_assignment.attacker_card_id);

    if v_is_first_strike_stage then
      v_attacker_deals_damage := v_attacker_has_first_strike or v_attacker_has_double_strike;
    else
      v_attacker_deals_damage := (not v_attacker_has_first_strike) or v_attacker_has_double_strike;
    end if;

    select exists (
      select 1
      from public.game_combat_blockers blockers
      where blockers.assignment_id = v_assignment.id
    )
    into v_has_blockers;

    if not v_has_blockers then
      if v_attacker_deals_damage and v_attacker_damage > 0 then
        update public.game_session_players
        set life_total = greatest(0, life_total - v_attacker_damage)
        where session_id = p_session_id
          and player_id = v_assignment.defending_player_id;

        v_total_player_damage := v_total_player_damage + v_attacker_damage;
      end if;
    else
      for v_blocker in
        select
          blockers.blocker_card_id,
          public.card_effective_power(p_session_id, blockers.blocker_card_id) as blocker_power,
          public.card_effective_toughness(p_session_id, blockers.blocker_card_id) as blocker_toughness
        from public.game_combat_blockers blockers
        join public.game_cards blocker_instance
          on blocker_instance.id = blockers.blocker_card_id
         and blocker_instance.zone = 'battlefield'
        where blockers.assignment_id = v_assignment.id
        order by blockers.damage_assignment_order, blockers.created_at, blockers.id
      loop
        v_blocker_damage := greatest(0, v_blocker.blocker_power);
        v_blocker_has_first_strike := public.card_has_first_strike(p_session_id, v_blocker.blocker_card_id);
        v_blocker_has_double_strike := public.card_has_double_strike(p_session_id, v_blocker.blocker_card_id);
        v_blocker_has_deathtouch := public.card_has_deathtouch(p_session_id, v_blocker.blocker_card_id);

        if v_is_first_strike_stage then
          v_blocker_deals_damage := v_blocker_has_first_strike or v_blocker_has_double_strike;
        else
          v_blocker_deals_damage := (not v_blocker_has_first_strike) or v_blocker_has_double_strike;
        end if;

        if v_attacker_deals_damage and v_remaining_attacker_damage > 0 then
          -- Deathtouch: 1 damage is lethal, so only 1 needs to be assigned per blocker.
          if v_attacker_has_deathtouch then
            v_lethal_per_blocker := 1;
          else
            v_lethal_per_blocker := greatest(1, v_blocker.blocker_toughness);
          end if;

          v_assigned_damage := least(v_remaining_attacker_damage, v_lethal_per_blocker);

          update public.game_cards
          set
            damage_marked = damage_marked + v_assigned_damage,
            dealt_deathtouch_damage = dealt_deathtouch_damage or v_attacker_has_deathtouch
          where id = v_blocker.blocker_card_id
            and session_id = p_session_id
            and zone = 'battlefield';

          if not found then
            raise exception 'Blocker card not found on battlefield';
          end if;

          v_total_creature_damage := v_total_creature_damage + v_assigned_damage;
          v_remaining_attacker_damage := v_remaining_attacker_damage - v_assigned_damage;
        end if;

        if v_blocker_deals_damage and v_blocker_damage > 0 then
          update public.game_cards
          set
            damage_marked = damage_marked + v_blocker_damage,
            dealt_deathtouch_damage = dealt_deathtouch_damage or v_blocker_has_deathtouch
          where id = v_assignment.attacker_card_id
            and session_id = p_session_id
            and zone = 'battlefield';

          if found then
            v_total_creature_damage := v_total_creature_damage + v_blocker_damage;
          end if;
        end if;
      end loop;

      if v_attacker_deals_damage
        and v_remaining_attacker_damage > 0
        and public.card_has_trample(p_session_id, v_assignment.attacker_card_id)
      then
        update public.game_session_players
        set life_total = greatest(0, life_total - v_remaining_attacker_damage)
        where session_id = p_session_id
          and player_id = v_assignment.defending_player_id;

        v_total_player_damage := v_total_player_damage + v_remaining_attacker_damage;
      end if;
    end if;

    if v_is_first_strike_stage then
      update public.game_combat_assignments
      set first_strike_damage_resolved = true
      where id = v_assignment.id;
    else
      update public.game_combat_assignments
      set damage_resolved = true
      where id = v_assignment.id;
    end if;

    v_resolved_count := v_resolved_count + 1;
  end loop;

  if v_is_first_strike_stage then
    update public.game_combat_assignments
    set first_strike_damage_resolved = true
    where session_id = p_session_id
      and turn_number = v_turn_state.turn_number
      and damage_resolved = false
      and first_strike_damage_resolved = false;
  else
    update public.game_combat_assignments
    set damage_resolved = true
    where session_id = p_session_id
      and turn_number = v_turn_state.turn_number
      and damage_resolved = false;
  end if;

  v_destroyed_count := public.move_lethal_damaged_creatures_to_graveyard(p_session_id);

  update public.game_cards
  set dealt_deathtouch_damage = false
  where session_id = p_session_id
    and dealt_deathtouch_damage = true;

  v_finish_state := public.maybe_finish_game_session(p_session_id);

  return jsonb_build_object(
    'assignments_resolved',
    v_resolved_count,
    'damage_stage',
    case when v_is_first_strike_stage then 'first_strike' else 'regular' end,
    'total_damage',
    v_total_player_damage,
    'total_player_damage',
    v_total_player_damage,
    'total_creature_damage',
    v_total_creature_damage,
    'creatures_destroyed',
    v_destroyed_count,
    'finished',
    coalesce((v_finish_state ->> 'finished')::boolean, false),
    'winner_player_id',
    v_finish_state ->> 'winner_player_id'
  );
end;
$$;


ALTER FUNCTION "public"."resolve_combat_damage"("p_session_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_top_of_stack"("p_session_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_session_status text;
  v_stack_item public.game_stack_items;
  v_target_stack_item public.game_stack_items;
  v_target_player_id uuid;
  v_amount integer;
  v_next_battlefield_position integer;
  v_next_graveyard_position integer;
  v_finish_state jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
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
    raise exception 'Cannot resolve stack in a finished game session';
  end if;

  select *
  into v_stack_item
  from public.game_stack_items
  where session_id = p_session_id
    and status = 'pending'
  order by position desc
  limit 1
  for update;

  if not found then
    raise exception 'Stack is empty';
  end if;

  if v_stack_item.action_type = 'deal_damage_player' then
    v_target_player_id := nullif(v_stack_item.payload ->> 'target_player_id', '')::uuid;
    v_amount := coalesce((v_stack_item.payload ->> 'amount')::integer, 0);

    if v_target_player_id is null or v_amount <= 0 then
      raise exception 'Invalid deal_damage_player payload';
    end if;

    update public.game_session_players
    set life_total = greatest(0, life_total - v_amount)
    where session_id = p_session_id
      and player_id = v_target_player_id;

    if not found then
      raise exception 'Target player not found';
    end if;
  elsif v_stack_item.action_type in (
    'deal_damage_creature',
    'pump_creature',
    'destroy_creature',
    'exile_creature',
    'bounce_creature',
    'tap_creature',
    'untap_creature',
    'add_counters_creature'
  ) then
    -- Every creature action_type is "<kind>_creature"; the payload already
    -- carries amount / power / toughness for the primitive.
    perform public.apply_creature_effect(
      p_session_id,
      regexp_replace(v_stack_item.action_type, '_creature$', ''),
      nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid,
      v_stack_item.payload
    );
  elsif v_stack_item.action_type = 'draw_cards' then
    perform public.apply_triggered_ability_effects(
      p_session_id,
      v_stack_item.controller_player_id,
      null,
      jsonb_build_array(
        jsonb_build_object('type', 'draw', 'amount', coalesce((v_stack_item.payload ->> 'amount')::integer, 1))
      )
    );
  elsif v_stack_item.action_type = 'counter_spell' then
    select *
    into v_target_stack_item
    from public.game_stack_items
    where id = nullif(v_stack_item.payload ->> 'target_stack_item_id', '')::uuid
      and session_id = p_session_id
      and status = 'pending'
    for update;

    if found then
      if v_target_stack_item.id = v_stack_item.id then
        raise exception 'A stack item cannot counter itself';
      end if;

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
    end if;
  elsif v_stack_item.action_type = 'cast_permanent' then
    if v_stack_item.source_card_id is null then
      raise exception 'Permanent spell has no source card';
    end if;

    select coalesce(max(zone_position), -1) + 1
    into v_next_battlefield_position
    from public.game_cards
    where session_id = p_session_id
      and owner_id = v_stack_item.controller_player_id
      and zone = 'battlefield';

    update public.game_cards
    set
      zone = 'battlefield',
      zone_position = v_next_battlefield_position,
      controller_player_id = coalesce(controller_player_id, owner_id),
      is_tapped = false,
      damage_marked = 0
    where id = v_stack_item.source_card_id
      and session_id = p_session_id
      and owner_id = v_stack_item.controller_player_id
      and zone = 'stack';

    if not found then
      raise exception 'Permanent spell source card not found on stack';
    end if;
  elsif v_stack_item.action_type = 'triggered_ability' then
    if coalesce((v_stack_item.payload ->> 'target_required')::boolean, false)
      and nullif(v_stack_item.payload ->> 'target_card_id', '') is null
    then
      if public.session_has_targetable_creature(
        p_session_id,
        nullif(v_stack_item.payload ->> 'controller_player_id', '')::uuid,
        coalesce(v_stack_item.payload ->> 'target_controller', 'any')
      ) then
        raise exception 'Triggered ability requires a target';
      end if;
    end if;

    perform public.apply_targeted_triggered_ability_effects(
      p_session_id,
      nullif(v_stack_item.payload ->> 'controller_player_id', '')::uuid,
      v_stack_item.source_card_id,
      coalesce(v_stack_item.payload -> 'effects', '[]'::jsonb),
      nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid
    );
  else
    raise exception 'Unsupported stack action type: %', v_stack_item.action_type;
  end if;

  update public.game_stack_items
  set
    status = 'resolved',
    resolved_at = now()
  where id = v_stack_item.id;

  perform public.rebuild_scripted_continuous_effects(p_session_id);

  update public.game_turn_state
  set
    priority_player_id = active_player_id,
    priority_cycle_started_by = null,
    priority_pass_count = 0
  where session_id = p_session_id;

  v_finish_state := public.maybe_finish_game_session(p_session_id);

  return jsonb_build_object(
    'resolved_stack_item_id',
    v_stack_item.id,
    'action_type',
    v_stack_item.action_type,
    'finished',
    coalesce((v_finish_state ->> 'finished')::boolean, false),
    'winner_player_id',
    v_finish_state ->> 'winner_player_id'
  );
end;
$_$;


ALTER FUNCTION "public"."resolve_top_of_stack"("p_session_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rls_auto_enable"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."rls_auto_enable"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."session_has_targetable_creature"("p_session_id" "uuid", "p_controller_id" "uuid", "p_target_controller" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.game_cards gc
    join public.cards c on c.id = gc.card_id
    where gc.session_id = p_session_id
      and gc.zone = 'battlefield'
      and c.type_line ilike '%creature%'
      and (
        coalesce(p_target_controller, 'any') = 'any'
        or (p_target_controller = 'opponent' and gc.controller_player_id is distinct from p_controller_id)
        or (p_target_controller = 'you' and gc.controller_player_id = p_controller_id)
      )
  );
$$;


ALTER FUNCTION "public"."session_has_targetable_creature"("p_session_id" "uuid", "p_controller_id" "uuid", "p_target_controller" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_card_controller"("p_game_card_id" "uuid", "p_controller_player_id" "uuid") RETURNS "public"."game_cards"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_card public.game_cards;
  v_turn_state public.game_turn_state;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select *
  into v_card
  from public.game_cards
  where id = p_game_card_id
  for update;

  if not found then
    raise exception 'Card not found';
  end if;

  if not public.is_session_player(v_card.session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = v_card.session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can change card controller';
  end if;

  if not public.is_session_player(v_card.session_id, p_controller_player_id) then
    raise exception 'Controller is not a player in this session';
  end if;

  update public.game_cards
  set controller_player_id = p_controller_player_id
  where id = p_game_card_id
  returning * into v_card;

  perform public.rebuild_scripted_continuous_effects(v_card.session_id);

  return v_card;
end;
$$;


ALTER FUNCTION "public"."set_card_controller"("p_game_card_id" "uuid", "p_controller_player_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_card_copied_script"("p_game_card_id" "uuid", "p_copied_script" "jsonb") RETURNS "public"."game_cards"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_card public.game_cards;
  v_turn_state public.game_turn_state;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select *
  into v_card
  from public.game_cards
  where id = p_game_card_id
  for update;

  if not found then
    raise exception 'Card not found';
  end if;

  if not public.is_session_player(v_card.session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = v_card.session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can change copied script';
  end if;

  update public.game_cards
  set copied_script = p_copied_script
  where id = p_game_card_id
  returning * into v_card;

  perform public.rebuild_scripted_continuous_effects(v_card.session_id);

  return v_card;
end;
$$;


ALTER FUNCTION "public"."set_card_copied_script"("p_game_card_id" "uuid", "p_copied_script" "jsonb") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cards" (
    "id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "mana_cost" "text",
    "type_line" "text",
    "oracle_text" "text",
    "power_toughness" "text",
    "keywords" "jsonb" DEFAULT '[]'::"jsonb",
    "script" "jsonb" DEFAULT '{}'::"jsonb",
    "image_url" "text",
    "power" integer,
    "toughness" integer,
    "is_token" boolean DEFAULT false NOT NULL,
    "oracle_id" "text"
);


ALTER TABLE "public"."cards" OWNER TO "postgres";


COMMENT ON COLUMN "public"."cards"."is_token" IS 'True for token catalog rows. Instances of these cease to exist when they leave the battlefield.';



COMMENT ON COLUMN "public"."cards"."oracle_id" IS 'Scryfall oracle_id (card identity shared across printings). cards.id is the printing id. Used to re-attach authored scripts when the representative printing changes.';



CREATE OR REPLACE FUNCTION "public"."set_card_script"("p_card_id" "uuid", "p_script" "jsonb") RETURNS "public"."cards"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_card public.cards;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_script is not null and jsonb_typeof(p_script) <> 'object' then
    raise exception 'Card script must be a JSON object';
  end if;

  update public.cards
  set script = coalesce(nullif(p_script, '{}'::jsonb), null)
  where id = p_card_id
  returning * into v_card;

  if not found then
    raise exception 'Card not found';
  end if;

  return v_card;
end;
$$;


ALTER FUNCTION "public"."set_card_script"("p_card_id" "uuid", "p_script" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_card_static_effects_suppressed"("p_game_card_id" "uuid", "p_suppressed" boolean) RETURNS "public"."game_cards"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_card public.game_cards;
  v_turn_state public.game_turn_state;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select *
  into v_card
  from public.game_cards
  where id = p_game_card_id
  for update;

  if not found then
    raise exception 'Card not found';
  end if;

  if not public.is_session_player(v_card.session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = v_card.session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can suppress static effects';
  end if;

  update public.game_cards
  set static_effects_suppressed = p_suppressed
  where id = p_game_card_id
  returning * into v_card;

  perform public.rebuild_scripted_continuous_effects(v_card.session_id);

  return v_card;
end;
$$;


ALTER FUNCTION "public"."set_card_static_effects_suppressed"("p_game_card_id" "uuid", "p_suppressed" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_card_tapped"("p_game_card_id" "uuid", "p_is_tapped" boolean) RETURNS "public"."game_cards"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_card public.game_cards;
  v_session_status text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select *
  into v_card
  from public.game_cards
  where id = p_game_card_id
  for update;

  if not found then
    raise exception 'Game card not found';
  end if;

  if v_card.owner_id <> auth.uid() then
    raise exception 'Only the owner can tap or untap this card';
  end if;

  if not public.is_session_player(v_card.session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select status
  into v_session_status
  from public.game_sessions
  where id = v_card.session_id;

  if not found then
    raise exception 'Game session not found';
  end if;

  if v_session_status = 'finished' then
    raise exception 'Cannot tap or untap cards in a finished game session';
  end if;

  update public.game_cards
  set is_tapped = p_is_tapped
  where id = p_game_card_id
  returning * into v_card;

  return v_card;
end;
$$;


ALTER FUNCTION "public"."set_card_tapped"("p_game_card_id" "uuid", "p_is_tapped" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_combat_blocker_order"("p_session_id" "uuid", "p_assignment_id" "uuid", "p_blocker_card_ids" "uuid"[]) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_assignment public.game_combat_assignments;
  v_expected_count integer;
  v_new_count integer;
  v_updated_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
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
    raise exception 'Cannot set combat damage order in a finished game session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if v_turn_state.step not in ('declare_blockers', 'combat_damage') then
    raise exception 'Blocker damage order can only be set before combat damage resolves';
  end if;

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can set blocker damage order';
  end if;

  select *
  into v_assignment
  from public.game_combat_assignments
  where id = p_assignment_id
    and session_id = p_session_id
    and turn_number = v_turn_state.turn_number
    and damage_resolved = false
  for update;

  if not found then
    raise exception 'Combat assignment not found or already resolved';
  end if;

  if v_assignment.attacking_player_id <> auth.uid() then
    raise exception 'Only the attacking player can set blocker damage order';
  end if;

  select count(*)
  into v_expected_count
  from public.game_combat_blockers
  where assignment_id = p_assignment_id;

  select count(distinct blocker_card_id)
  into v_new_count
  from unnest(p_blocker_card_ids) as blocker_card_id;

  if v_expected_count <> v_new_count then
    raise exception 'Blocker order must include every blocker exactly once';
  end if;

  perform 1
  from unnest(p_blocker_card_ids) as requested_blocker(blocker_card_id)
  left join public.game_combat_blockers blockers
    on blockers.assignment_id = p_assignment_id
   and blockers.blocker_card_id = requested_blocker.blocker_card_id
  where blockers.id is null;

  if found then
    raise exception 'Blocker order contains a card that is not blocking this attacker';
  end if;

  with requested_order as (
    select
      blocker_card_id,
      ordinal_position - 1 as next_order
    from unnest(p_blocker_card_ids) with ordinality as ordered(blocker_card_id, ordinal_position)
  )
  update public.game_combat_blockers blockers
  set damage_assignment_order = requested_order.next_order
  from requested_order
  where blockers.assignment_id = p_assignment_id
    and blockers.blocker_card_id = requested_order.blocker_card_id;

  get diagnostics v_updated_count = row_count;

  return v_updated_count;
end;
$$;


ALTER FUNCTION "public"."set_combat_blocker_order"("p_session_id" "uuid", "p_assignment_id" "uuid", "p_blocker_card_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_game_turn_state_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_game_turn_state_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_effect_requires_creature_target"("p_effect" "jsonb") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select
    lower(coalesce(p_effect ->> 'type', '')) in (
      'deal_damage',
      'destroy',
      'exile',
      'bounce',
      'tap',
      'untap',
      'add_counters'
    )
    and public.behavior_target_type_is_creature_only(p_effect -> 'target_type');
$$;


ALTER FUNCTION "public"."trigger_effect_requires_creature_target"("p_effect" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_effects_require_creature_target"("p_effects" "jsonb") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select exists (
    select 1
    from jsonb_array_elements(coalesce(p_effects, '[]'::jsonb)) as effects(effect)
    where public.trigger_effect_requires_creature_target(effects.effect)
  );
$$;


ALTER FUNCTION "public"."trigger_effects_require_creature_target"("p_effects" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_effects_target_controller"("p_effects" "jsonb") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select public.behavior_target_controller(effects.effect)
  from jsonb_array_elements(coalesce(p_effects, '[]'::jsonb)) as effects(effect)
  where public.trigger_effect_requires_creature_target(effects.effect)
  limit 1;
$$;


ALTER FUNCTION "public"."trigger_effects_target_controller"("p_effects" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."untap_all"("p_session_id" "uuid", "p_player_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_session_status text;
  v_updated_count integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_player_id <> auth.uid() then
    raise exception 'Cannot untap cards for another player';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select status
  into v_session_status
  from public.game_sessions
  where id = p_session_id;

  if not found then
    raise exception 'Game session not found';
  end if;

  if v_session_status = 'finished' then
    raise exception 'Cannot untap cards in a finished game session';
  end if;

  update public.game_cards
  set is_tapped = false
  where session_id = p_session_id
    and owner_id = auth.uid()
    and zone = 'battlefield'
    and is_tapped = true;

  get diagnostics v_updated_count = row_count;

  return v_updated_count;
end;
$$;


ALTER FUNCTION "public"."untap_all"("p_session_id" "uuid", "p_player_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_deck_list"("p_deck_id" "uuid", "p_card_ids" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_deck public.decks;
  v_card_id uuid;
  v_missing uuid[] := '{}'::uuid[];
  v_card_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select *
  into v_deck
  from public.decks
  where id = p_deck_id
  for update;

  if not found then
    raise exception 'Deck not found';
  end if;

  if coalesce(v_deck.created_by, v_deck.owner_id) <> auth.uid()
    and v_deck.owner_id <> auth.uid()
  then
    raise exception 'Current user does not own this deck';
  end if;

  if p_card_ids is null or array_length(p_card_ids, 1) is null then
    raise exception 'Deck must contain at least one card';
  end if;

  foreach v_card_id in array p_card_ids
  loop
    if not exists (
      select 1
      from public.cards
      where id = v_card_id
    ) then
      v_missing := array_append(v_missing, v_card_id);
    end if;
  end loop;

  if array_length(v_missing, 1) is not null then
    raise exception 'Deck contains unknown card ids: %', array_to_string(v_missing, ', ');
  end if;

  v_card_count := array_length(p_card_ids, 1);

  update public.decks
  set
    list_data = to_jsonb(p_card_ids),
    created_by = coalesce(created_by, auth.uid()),
    owner_id = coalesce(owner_id, auth.uid())
  where id = p_deck_id;

  return jsonb_build_object(
    'id', p_deck_id,
    'card_count', v_card_count
  );
end;
$$;


ALTER FUNCTION "public"."update_deck_list"("p_deck_id" "uuid", "p_card_ids" "uuid"[]) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."decks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "list_data" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "created_by" "uuid"
);


ALTER TABLE "public"."decks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."game_combat_blockers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "assignment_id" "uuid" NOT NULL,
    "session_id" "uuid" NOT NULL,
    "turn_number" integer NOT NULL,
    "attacker_card_id" "uuid" NOT NULL,
    "blocker_card_id" "uuid" NOT NULL,
    "blocking_player_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "damage_assignment_order" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."game_combat_blockers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."game_players" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "player_id" "uuid" NOT NULL,
    "life_total" integer DEFAULT 40,
    "mana_pool" "jsonb" DEFAULT '{"B": 0, "C": 0, "G": 0, "R": 0, "U": 0, "W": 0}'::"jsonb",
    "is_active" boolean DEFAULT true
);


ALTER TABLE "public"."game_players" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."game_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "host_id" "uuid",
    "status" "text" DEFAULT 'open'::"text",
    "current_turn_player" "uuid",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()),
    "created_by" "uuid" DEFAULT "auth"."uid"(),
    "locked_at" timestamp with time zone,
    "finished_at" timestamp with time zone,
    "winner_player_id" "uuid",
    CONSTRAINT "game_sessions_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'locked'::"text", 'finished'::"text"])))
);


ALTER TABLE "public"."game_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "username" "text",
    "is_pro" boolean DEFAULT false,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"())
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


ALTER TABLE ONLY "public"."cards"
    ADD CONSTRAINT "cards_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."decks"
    ADD CONSTRAINT "decks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."game_action_log"
    ADD CONSTRAINT "game_action_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."game_cards"
    ADD CONSTRAINT "game_cards_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."game_combat_assignments"
    ADD CONSTRAINT "game_combat_assignments_attacker_unique" UNIQUE ("session_id", "turn_number", "attacker_card_id");



ALTER TABLE ONLY "public"."game_combat_assignments"
    ADD CONSTRAINT "game_combat_assignments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."game_combat_blockers"
    ADD CONSTRAINT "game_combat_blockers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."game_combat_blockers"
    ADD CONSTRAINT "game_combat_blockers_unique_blocker_per_turn" UNIQUE ("session_id", "turn_number", "blocker_card_id");



ALTER TABLE ONLY "public"."game_continuous_effects"
    ADD CONSTRAINT "game_continuous_effects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."game_players"
    ADD CONSTRAINT "game_players_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."game_players"
    ADD CONSTRAINT "game_players_session_id_player_id_key" UNIQUE ("session_id", "player_id");



ALTER TABLE ONLY "public"."game_session_players"
    ADD CONSTRAINT "game_session_players_pkey" PRIMARY KEY ("session_id", "player_id");



ALTER TABLE ONLY "public"."game_session_players"
    ADD CONSTRAINT "game_session_players_seat_unique" UNIQUE ("session_id", "seat_number");



ALTER TABLE ONLY "public"."game_sessions"
    ADD CONSTRAINT "game_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."game_stack_items"
    ADD CONSTRAINT "game_stack_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."game_turn_state"
    ADD CONSTRAINT "game_turn_state_pkey" PRIMARY KEY ("session_id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_username_key" UNIQUE ("username");



CREATE INDEX "cards_oracle_id_idx" ON "public"."cards" USING "btree" ("oracle_id") WHERE ("oracle_id" IS NOT NULL);



CREATE INDEX "game_action_log_session_created_idx" ON "public"."game_action_log" USING "btree" ("session_id", "created_at" DESC);



CREATE INDEX "game_cards_library_draw_idx" ON "public"."game_cards" USING "btree" ("session_id", "owner_id", "zone", "zone_position", "id");



CREATE INDEX "game_combat_assignments_session_turn_idx" ON "public"."game_combat_assignments" USING "btree" ("session_id", "turn_number");



CREATE INDEX "game_combat_blockers_assignment_idx" ON "public"."game_combat_blockers" USING "btree" ("assignment_id", "created_at");



CREATE INDEX "game_combat_blockers_damage_order_idx" ON "public"."game_combat_blockers" USING "btree" ("assignment_id", "damage_assignment_order", "created_at", "id");



CREATE INDEX "game_combat_blockers_session_turn_idx" ON "public"."game_combat_blockers" USING "btree" ("session_id", "turn_number");



CREATE INDEX "game_continuous_effects_session_type_idx" ON "public"."game_continuous_effects" USING "btree" ("session_id", "effect_type");



CREATE UNIQUE INDEX "game_players_session_player_key" ON "public"."game_players" USING "btree" ("session_id", "player_id");



CREATE INDEX "game_session_players_player_idx" ON "public"."game_session_players" USING "btree" ("player_id", "session_id");



CREATE INDEX "game_stack_items_session_pending_idx" ON "public"."game_stack_items" USING "btree" ("session_id", "status", "position" DESC);



CREATE INDEX "idx_decks_owner" ON "public"."decks" USING "btree" ("owner_id");



CREATE INDEX "idx_game_cards_owner" ON "public"."game_cards" USING "btree" ("owner_id");



CREATE INDEX "idx_game_cards_session" ON "public"."game_cards" USING "btree" ("session_id");



CREATE OR REPLACE TRIGGER "set_game_turn_state_updated_at" BEFORE UPDATE ON "public"."game_turn_state" FOR EACH ROW EXECUTE FUNCTION "public"."set_game_turn_state_updated_at"();



CREATE OR REPLACE TRIGGER "trg_a_fire_zone_change" AFTER INSERT OR UPDATE OF "zone" ON "public"."game_cards" FOR EACH ROW EXECUTE FUNCTION "public"."fire_zone_change_triggers"();



CREATE OR REPLACE TRIGGER "trg_cease_token_off_battlefield" AFTER UPDATE OF "zone" ON "public"."game_cards" FOR EACH ROW EXECUTE FUNCTION "public"."cease_token_if_off_battlefield"();



CREATE OR REPLACE TRIGGER "trg_fire_attack" AFTER INSERT ON "public"."game_combat_assignments" FOR EACH ROW EXECUTE FUNCTION "public"."fire_attack_triggers"();



CREATE OR REPLACE TRIGGER "trg_fire_block" AFTER INSERT ON "public"."game_combat_blockers" FOR EACH ROW EXECUTE FUNCTION "public"."fire_block_triggers"();



CREATE OR REPLACE TRIGGER "trg_fire_target" AFTER INSERT ON "public"."game_stack_items" FOR EACH ROW EXECUTE FUNCTION "public"."fire_target_triggers"();



CREATE OR REPLACE TRIGGER "trg_fire_turn_step" AFTER UPDATE OF "step" ON "public"."game_turn_state" FOR EACH ROW EXECUTE FUNCTION "public"."fire_turn_step_triggers"();



ALTER TABLE ONLY "public"."decks"
    ADD CONSTRAINT "decks_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_action_log"
    ADD CONSTRAINT "game_action_log_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_cards"
    ADD CONSTRAINT "game_cards_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id");



ALTER TABLE ONLY "public"."game_cards"
    ADD CONSTRAINT "game_cards_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."game_cards"
    ADD CONSTRAINT "game_cards_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_combat_assignments"
    ADD CONSTRAINT "game_combat_assignments_attacker_card_id_fkey" FOREIGN KEY ("attacker_card_id") REFERENCES "public"."game_cards"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_combat_assignments"
    ADD CONSTRAINT "game_combat_assignments_blocker_card_id_fkey" FOREIGN KEY ("blocker_card_id") REFERENCES "public"."game_cards"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."game_combat_assignments"
    ADD CONSTRAINT "game_combat_assignments_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_combat_blockers"
    ADD CONSTRAINT "game_combat_blockers_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "public"."game_combat_assignments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_combat_blockers"
    ADD CONSTRAINT "game_combat_blockers_attacker_card_id_fkey" FOREIGN KEY ("attacker_card_id") REFERENCES "public"."game_cards"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_combat_blockers"
    ADD CONSTRAINT "game_combat_blockers_blocker_card_id_fkey" FOREIGN KEY ("blocker_card_id") REFERENCES "public"."game_cards"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_combat_blockers"
    ADD CONSTRAINT "game_combat_blockers_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_continuous_effects"
    ADD CONSTRAINT "game_continuous_effects_affected_card_id_fkey" FOREIGN KEY ("affected_card_id") REFERENCES "public"."game_cards"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_continuous_effects"
    ADD CONSTRAINT "game_continuous_effects_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_continuous_effects"
    ADD CONSTRAINT "game_continuous_effects_source_card_id_fkey" FOREIGN KEY ("source_card_id") REFERENCES "public"."game_cards"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."game_players"
    ADD CONSTRAINT "game_players_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."game_players"
    ADD CONSTRAINT "game_players_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_session_players"
    ADD CONSTRAINT "game_session_players_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_sessions"
    ADD CONSTRAINT "game_sessions_current_turn_player_fkey" FOREIGN KEY ("current_turn_player") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."game_sessions"
    ADD CONSTRAINT "game_sessions_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."game_stack_items"
    ADD CONSTRAINT "game_stack_items_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_stack_items"
    ADD CONSTRAINT "game_stack_items_source_card_id_fkey" FOREIGN KEY ("source_card_id") REFERENCES "public"."game_cards"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



CREATE POLICY "Alleen de host kan de sessie aanpassen" ON "public"."game_sessions" FOR UPDATE USING (("auth"."uid"() = "host_id"));



CREATE POLICY "Anyone can read cards" ON "public"."cards" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "Eigenaar kan kaart acties uitvoeren" ON "public"."game_cards" FOR UPDATE USING (("auth"."uid"() = "owner_id")) WITH CHECK (("auth"."uid"() = "owner_id"));



CREATE POLICY "Eigenaar kan kaarten invoegen" ON "public"."game_cards" FOR INSERT WITH CHECK (("auth"."uid"() = "owner_id"));



CREATE POLICY "Gebruikers kunnen eigen decks aanmaken" ON "public"."decks" FOR INSERT WITH CHECK (("auth"."uid"() = "owner_id"));



CREATE POLICY "Gebruikers kunnen eigen decks inzien" ON "public"."decks" FOR SELECT USING (("auth"."uid"() = "owner_id"));



CREATE POLICY "Gebruikers kunnen eigen decks verwijderen" ON "public"."decks" FOR DELETE USING (("auth"."uid"() = "owner_id"));



CREATE POLICY "Gebruikers kunnen eigen decks wijzigen" ON "public"."decks" FOR UPDATE USING (("auth"."uid"() = "owner_id"));



CREATE POLICY "Players can create their own player state" ON "public"."game_players" FOR INSERT TO "authenticated" WITH CHECK (("player_id" = "auth"."uid"()));



CREATE POLICY "Players can read combat assignments in their sessions" ON "public"."game_combat_assignments" FOR SELECT TO "authenticated" USING ("public"."is_session_player"("session_id", "auth"."uid"()));



CREATE POLICY "Players can read their own game player state" ON "public"."game_players" FOR SELECT TO "authenticated" USING ((("player_id" = "auth"."uid"()) AND "public"."is_session_player"("session_id", "auth"."uid"())));



CREATE POLICY "Players can read their own player state" ON "public"."game_players" FOR SELECT TO "authenticated" USING (("player_id" = "auth"."uid"()));



CREATE POLICY "Players can read their own session memberships" ON "public"."game_session_players" FOR SELECT TO "authenticated" USING (("player_id" = "auth"."uid"()));



CREATE POLICY "Players can read their sessions" ON "public"."game_sessions" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."game_session_players"
  WHERE (("game_session_players"."session_id" = "game_sessions"."id") AND ("game_session_players"."player_id" = "auth"."uid"())))));



CREATE POLICY "Players can update their own player state" ON "public"."game_players" FOR UPDATE TO "authenticated" USING (("player_id" = "auth"."uid"())) WITH CHECK (("player_id" = "auth"."uid"()));



CREATE POLICY "Sessie deelnemers kunnen stats zien" ON "public"."game_players" FOR SELECT USING (true);



CREATE POLICY "Sessies zijn zichtbaar voor iedereen met de ID" ON "public"."game_sessions" FOR SELECT USING (true);



CREATE POLICY "Session players can read action log" ON "public"."game_action_log" FOR SELECT USING ("public"."is_session_player"("session_id", "auth"."uid"()));



CREATE POLICY "Session players can read combat blockers" ON "public"."game_combat_blockers" FOR SELECT TO "authenticated" USING ("public"."is_session_player"("session_id", "auth"."uid"()));



CREATE POLICY "Session players can read continuous effects" ON "public"."game_continuous_effects" FOR SELECT TO "authenticated" USING ("public"."is_session_player"("session_id", "auth"."uid"()));



CREATE POLICY "Session players can read game cards" ON "public"."game_cards" FOR SELECT TO "authenticated" USING ("public"."is_session_player"("session_id", "auth"."uid"()));



CREATE POLICY "Session players can read stack items" ON "public"."game_stack_items" FOR SELECT TO "authenticated" USING ("public"."is_session_player"("session_id", "auth"."uid"()));



CREATE POLICY "Session players can read turn state" ON "public"."game_turn_state" FOR SELECT TO "authenticated" USING ("public"."is_session_player"("session_id", "auth"."uid"()));



CREATE POLICY "Spelers kunnen eigen stats bijwerken" ON "public"."game_players" FOR UPDATE USING (("auth"."uid"() = "player_id"));



CREATE POLICY "Users can insert own decks" ON "public"."decks" FOR INSERT TO "authenticated" WITH CHECK ((("created_by" = "auth"."uid"()) AND ("owner_id" = "auth"."uid"())));



CREATE POLICY "Users can read own decks" ON "public"."decks" FOR SELECT TO "authenticated" USING ((("created_by" = "auth"."uid"()) OR ("owner_id" = "auth"."uid"())));



CREATE POLICY "Users can update own decks" ON "public"."decks" FOR UPDATE TO "authenticated" USING ((("created_by" = "auth"."uid"()) OR ("owner_id" = "auth"."uid"()))) WITH CHECK ((("created_by" = "auth"."uid"()) AND ("owner_id" = "auth"."uid"())));



CREATE POLICY "Zichtbaar voor sessie-deelnemers" ON "public"."game_cards" FOR SELECT USING (true);



ALTER TABLE "public"."cards" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."decks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."game_action_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."game_cards" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."game_combat_assignments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."game_combat_blockers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."game_continuous_effects" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."game_players" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."game_session_players" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."game_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."game_stack_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."game_turn_state" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON TABLE "public"."game_stack_items" TO "anon";
GRANT ALL ON TABLE "public"."game_stack_items" TO "authenticated";
GRANT ALL ON TABLE "public"."game_stack_items" TO "service_role";



GRANT ALL ON FUNCTION "public"."activate_ability"("p_session_id" "uuid", "p_source_card_id" "uuid", "p_ability_index" integer, "p_target_player_id" "uuid", "p_target_card_id" "uuid", "p_generic_payment" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."activate_ability"("p_session_id" "uuid", "p_source_card_id" "uuid", "p_ability_index" integer, "p_target_player_id" "uuid", "p_target_card_id" "uuid", "p_generic_payment" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."activate_ability"("p_session_id" "uuid", "p_source_card_id" "uuid", "p_ability_index" integer, "p_target_player_id" "uuid", "p_target_card_id" "uuid", "p_generic_payment" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."add_mana_from_card"("p_game_card_id" "uuid", "p_session_id" "uuid", "p_player_id" "uuid", "p_color" "text", "p_amount" integer, "p_should_tap_card" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."add_mana_from_card"("p_game_card_id" "uuid", "p_session_id" "uuid", "p_player_id" "uuid", "p_color" "text", "p_amount" integer, "p_should_tap_card" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."add_mana_from_card"("p_game_card_id" "uuid", "p_session_id" "uuid", "p_player_id" "uuid", "p_color" "text", "p_amount" integer, "p_should_tap_card" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."adjust_card_counters"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_delta" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."adjust_card_counters"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_delta" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."adjust_card_counters"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_delta" integer) TO "service_role";



GRANT ALL ON TABLE "public"."game_session_players" TO "anon";
GRANT ALL ON TABLE "public"."game_session_players" TO "authenticated";
GRANT ALL ON TABLE "public"."game_session_players" TO "service_role";



GRANT ALL ON FUNCTION "public"."adjust_player_life"("p_session_id" "uuid", "p_target_player_id" "uuid", "p_delta" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."adjust_player_life"("p_session_id" "uuid", "p_target_player_id" "uuid", "p_delta" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."adjust_player_life"("p_session_id" "uuid", "p_target_player_id" "uuid", "p_delta" integer) TO "service_role";



GRANT ALL ON TABLE "public"."game_turn_state" TO "anon";
GRANT ALL ON TABLE "public"."game_turn_state" TO "authenticated";
GRANT ALL ON TABLE "public"."game_turn_state" TO "service_role";



GRANT ALL ON FUNCTION "public"."advance_step"("p_session_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."advance_step"("p_session_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."advance_step"("p_session_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."apply_creature_effect"("p_session_id" "uuid", "p_kind" "text", "p_target_card_id" "uuid", "p_params" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."apply_creature_effect"("p_session_id" "uuid", "p_kind" "text", "p_target_card_id" "uuid", "p_params" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."apply_creature_effect"("p_session_id" "uuid", "p_kind" "text", "p_target_card_id" "uuid", "p_params" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."apply_targeted_triggered_ability_effects"("p_session_id" "uuid", "p_controller_id" "uuid", "p_source_card_id" "uuid", "p_effects" "jsonb", "p_target_card_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."apply_targeted_triggered_ability_effects"("p_session_id" "uuid", "p_controller_id" "uuid", "p_source_card_id" "uuid", "p_effects" "jsonb", "p_target_card_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."apply_targeted_triggered_ability_effects"("p_session_id" "uuid", "p_controller_id" "uuid", "p_source_card_id" "uuid", "p_effects" "jsonb", "p_target_card_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."apply_triggered_ability_effects"("p_session_id" "uuid", "p_controller_id" "uuid", "p_source_card_id" "uuid", "p_effects" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."apply_triggered_ability_effects"("p_session_id" "uuid", "p_controller_id" "uuid", "p_source_card_id" "uuid", "p_effects" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."apply_triggered_ability_effects"("p_session_id" "uuid", "p_controller_id" "uuid", "p_source_card_id" "uuid", "p_effects" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."behavior_target_controller"("p_effect" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."behavior_target_controller"("p_effect" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."behavior_target_controller"("p_effect" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."behavior_target_type_is_creature_only"("p_target_type" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."behavior_target_type_is_creature_only"("p_target_type" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."behavior_target_type_is_creature_only"("p_target_type" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."behavior_target_type_matches"("p_target_type" "jsonb", "p_want" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."behavior_target_type_matches"("p_target_type" "jsonb", "p_want" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."behavior_target_type_matches"("p_target_type" "jsonb", "p_want" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."card_behavior_has_continuous_effects"("p_script" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."card_behavior_has_continuous_effects"("p_script" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."card_behavior_has_continuous_effects"("p_script" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."card_effective_power"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."card_effective_power"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."card_effective_power"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."card_effective_toughness"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."card_effective_toughness"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."card_effective_toughness"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."card_has_deathtouch"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."card_has_deathtouch"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."card_has_deathtouch"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."card_has_double_strike"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."card_has_double_strike"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."card_has_double_strike"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."card_has_first_strike"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."card_has_first_strike"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."card_has_first_strike"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."card_has_flying"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."card_has_flying"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."card_has_flying"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."card_has_haste"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."card_has_haste"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."card_has_haste"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."card_has_indestructible"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."card_has_indestructible"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."card_has_indestructible"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."card_has_reach"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."card_has_reach"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."card_has_reach"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."card_has_trample"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."card_has_trample"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."card_has_trample"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."card_has_vigilance"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."card_has_vigilance"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."card_has_vigilance"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "service_role";



GRANT ALL ON TABLE "public"."game_cards" TO "anon";
GRANT ALL ON TABLE "public"."game_cards" TO "authenticated";
GRANT ALL ON TABLE "public"."game_cards" TO "service_role";



GRANT ALL ON FUNCTION "public"."cast_card_from_hand"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_generic_payment" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."cast_card_from_hand"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_generic_payment" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cast_card_from_hand"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_generic_payment" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."cease_token_if_off_battlefield"() TO "anon";
GRANT ALL ON FUNCTION "public"."cease_token_if_off_battlefield"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."cease_token_if_off_battlefield"() TO "service_role";



GRANT ALL ON FUNCTION "public"."choose_triggered_ability_creature_target"("p_session_id" "uuid", "p_stack_item_id" "uuid", "p_target_card_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."choose_triggered_ability_creature_target"("p_session_id" "uuid", "p_stack_item_id" "uuid", "p_target_card_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."choose_triggered_ability_creature_target"("p_session_id" "uuid", "p_stack_item_id" "uuid", "p_target_card_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."clear_combat_assignments"("p_session_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."clear_combat_assignments"("p_session_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."clear_combat_assignments"("p_session_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."clear_mana_pool"("p_session_id" "uuid", "p_player_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."clear_mana_pool"("p_session_id" "uuid", "p_player_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."clear_mana_pool"("p_session_id" "uuid", "p_player_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."clear_mana_pool_for_step"("p_session_id" "uuid", "p_phase" "text", "p_step" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."clear_mana_pool_for_step"("p_session_id" "uuid", "p_phase" "text", "p_step" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."clear_mana_pool_for_step"("p_session_id" "uuid", "p_phase" "text", "p_step" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."create_game_session"() TO "anon";
GRANT ALL ON FUNCTION "public"."create_game_session"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_game_session"() TO "service_role";



GRANT ALL ON TABLE "public"."game_continuous_effects" TO "anon";
GRANT ALL ON TABLE "public"."game_continuous_effects" TO "authenticated";
GRANT ALL ON TABLE "public"."game_continuous_effects" TO "service_role";



GRANT ALL ON FUNCTION "public"."create_mana_retention_effect"("p_session_id" "uuid", "p_source_card_id" "uuid", "p_colors" "text"[], "p_affected_player_id" "uuid", "p_expires_at_phase" "text", "p_expires_at_step" "text", "p_should_tap_card" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."create_mana_retention_effect"("p_session_id" "uuid", "p_source_card_id" "uuid", "p_colors" "text"[], "p_affected_player_id" "uuid", "p_expires_at_phase" "text", "p_expires_at_step" "text", "p_should_tap_card" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_mana_retention_effect"("p_session_id" "uuid", "p_source_card_id" "uuid", "p_colors" "text"[], "p_affected_player_id" "uuid", "p_expires_at_phase" "text", "p_expires_at_step" "text", "p_should_tap_card" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."create_pt_pump"("p_session_id" "uuid", "p_target_card_id" "uuid", "p_power" integer, "p_toughness" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."create_pt_pump"("p_session_id" "uuid", "p_target_card_id" "uuid", "p_power" integer, "p_toughness" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_pt_pump"("p_session_id" "uuid", "p_target_card_id" "uuid", "p_power" integer, "p_toughness" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."create_token"("p_session_id" "uuid", "p_player_id" "uuid", "p_token_card_id" "uuid", "p_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."create_token"("p_session_id" "uuid", "p_player_id" "uuid", "p_token_card_id" "uuid", "p_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_token"("p_session_id" "uuid", "p_player_id" "uuid", "p_token_card_id" "uuid", "p_count" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."creature_target_controller_ok"("p_session_id" "uuid", "p_target_card_id" "uuid", "p_controller_id" "uuid", "p_target_controller" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."creature_target_controller_ok"("p_session_id" "uuid", "p_target_card_id" "uuid", "p_controller_id" "uuid", "p_target_controller" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."creature_target_controller_ok"("p_session_id" "uuid", "p_target_card_id" "uuid", "p_controller_id" "uuid", "p_target_controller" "text") TO "service_role";



GRANT ALL ON TABLE "public"."game_combat_assignments" TO "anon";
GRANT ALL ON TABLE "public"."game_combat_assignments" TO "authenticated";
GRANT ALL ON TABLE "public"."game_combat_assignments" TO "service_role";



GRANT ALL ON FUNCTION "public"."declare_attacker"("p_session_id" "uuid", "p_attacker_card_id" "uuid", "p_defending_player_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."declare_attacker"("p_session_id" "uuid", "p_attacker_card_id" "uuid", "p_defending_player_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."declare_attacker"("p_session_id" "uuid", "p_attacker_card_id" "uuid", "p_defending_player_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."declare_blocker"("p_session_id" "uuid", "p_blocker_card_id" "uuid", "p_attacker_card_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."declare_blocker"("p_session_id" "uuid", "p_blocker_card_id" "uuid", "p_attacker_card_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."declare_blocker"("p_session_id" "uuid", "p_blocker_card_id" "uuid", "p_attacker_card_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."dev_add_mana"("p_session_id" "uuid", "p_player_id" "uuid", "p_color" "text", "p_amount" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."dev_add_mana"("p_session_id" "uuid", "p_player_id" "uuid", "p_color" "text", "p_amount" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."dev_add_mana"("p_session_id" "uuid", "p_player_id" "uuid", "p_color" "text", "p_amount" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."dev_clear_mana_pool"("p_session_id" "uuid", "p_player_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."dev_clear_mana_pool"("p_session_id" "uuid", "p_player_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dev_clear_mana_pool"("p_session_id" "uuid", "p_player_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."dev_clear_summoning_sickness"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."dev_clear_summoning_sickness"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dev_clear_summoning_sickness"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."dev_draw_card"("p_session_id" "uuid", "p_player_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."dev_draw_card"("p_session_id" "uuid", "p_player_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dev_draw_card"("p_session_id" "uuid", "p_player_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."dev_log_action"("p_session_id" "uuid", "p_target_player_id" "uuid", "p_action_type" "text", "p_description" "text", "p_before_state" "jsonb", "p_after_state" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."dev_log_action"("p_session_id" "uuid", "p_target_player_id" "uuid", "p_action_type" "text", "p_description" "text", "p_before_state" "jsonb", "p_after_state" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dev_log_action"("p_session_id" "uuid", "p_target_player_id" "uuid", "p_action_type" "text", "p_description" "text", "p_before_state" "jsonb", "p_after_state" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."dev_move_card_to_zone"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_zone" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."dev_move_card_to_zone"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_zone" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dev_move_card_to_zone"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_zone" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."dev_pass_priority"("p_session_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."dev_pass_priority"("p_session_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dev_pass_priority"("p_session_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."dev_put_card_on_bottom"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."dev_put_card_on_bottom"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dev_put_card_on_bottom"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."dev_put_card_on_top"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."dev_put_card_on_top"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dev_put_card_on_top"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."dev_set_card_damage"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_damage_marked" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."dev_set_card_damage"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_damage_marked" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."dev_set_card_damage"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_damage_marked" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."dev_set_card_tapped"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_is_tapped" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."dev_set_card_tapped"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_is_tapped" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."dev_set_card_tapped"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_is_tapped" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."dev_set_turn_state"("p_session_id" "uuid", "p_phase" "text", "p_step" "text", "p_active_player_id" "uuid", "p_priority_player_id" "uuid", "p_turn_number" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."dev_set_turn_state"("p_session_id" "uuid", "p_phase" "text", "p_step" "text", "p_active_player_id" "uuid", "p_priority_player_id" "uuid", "p_turn_number" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."dev_set_turn_state"("p_session_id" "uuid", "p_phase" "text", "p_step" "text", "p_active_player_id" "uuid", "p_priority_player_id" "uuid", "p_turn_number" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."dev_shuffle_library"("p_session_id" "uuid", "p_player_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."dev_shuffle_library"("p_session_id" "uuid", "p_player_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dev_shuffle_library"("p_session_id" "uuid", "p_player_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."dev_spawn_card"("p_session_id" "uuid", "p_player_id" "uuid", "p_card_id" "uuid", "p_zone" "text", "p_tapped" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."dev_spawn_card"("p_session_id" "uuid", "p_player_id" "uuid", "p_card_id" "uuid", "p_zone" "text", "p_tapped" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."dev_spawn_card"("p_session_id" "uuid", "p_player_id" "uuid", "p_card_id" "uuid", "p_zone" "text", "p_tapped" boolean) TO "service_role";



GRANT ALL ON TABLE "public"."game_action_log" TO "anon";
GRANT ALL ON TABLE "public"."game_action_log" TO "authenticated";
GRANT ALL ON TABLE "public"."game_action_log" TO "service_role";



GRANT ALL ON FUNCTION "public"."dev_undo_action"("p_action_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."dev_undo_action"("p_action_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dev_undo_action"("p_action_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."dev_undo_last_draw"("p_session_id" "uuid", "p_player_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."dev_undo_last_draw"("p_session_id" "uuid", "p_player_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dev_undo_last_draw"("p_session_id" "uuid", "p_player_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."dev_untap_all"("p_session_id" "uuid", "p_player_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."dev_untap_all"("p_session_id" "uuid", "p_player_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dev_untap_all"("p_session_id" "uuid", "p_player_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."draw_card"("p_session_id" "uuid", "p_player_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."draw_card"("p_session_id" "uuid", "p_player_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."draw_card"("p_session_id" "uuid", "p_player_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."effective_script"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."effective_script"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."effective_script"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."enqueue_triggered_ability"("p_session_id" "uuid", "p_controller_id" "uuid", "p_source_card_id" "uuid", "p_label" "text", "p_effects" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."enqueue_triggered_ability"("p_session_id" "uuid", "p_controller_id" "uuid", "p_source_card_id" "uuid", "p_label" "text", "p_effects" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."enqueue_triggered_ability"("p_session_id" "uuid", "p_controller_id" "uuid", "p_source_card_id" "uuid", "p_label" "text", "p_effects" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."expire_continuous_effects_for_step"("p_session_id" "uuid", "p_turn_number" integer, "p_phase" "text", "p_step" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."expire_continuous_effects_for_step"("p_session_id" "uuid", "p_turn_number" integer, "p_phase" "text", "p_step" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."expire_continuous_effects_for_step"("p_session_id" "uuid", "p_turn_number" integer, "p_phase" "text", "p_step" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."finish_game_session"("p_session_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."finish_game_session"("p_session_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."finish_game_session"("p_session_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."fire_attack_triggers"() TO "anon";
GRANT ALL ON FUNCTION "public"."fire_attack_triggers"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fire_attack_triggers"() TO "service_role";



GRANT ALL ON FUNCTION "public"."fire_block_triggers"() TO "anon";
GRANT ALL ON FUNCTION "public"."fire_block_triggers"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fire_block_triggers"() TO "service_role";



GRANT ALL ON FUNCTION "public"."fire_card_triggers"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_events" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."fire_card_triggers"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_events" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."fire_card_triggers"("p_session_id" "uuid", "p_game_card_id" "uuid", "p_events" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."fire_target_triggers"() TO "anon";
GRANT ALL ON FUNCTION "public"."fire_target_triggers"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fire_target_triggers"() TO "service_role";



GRANT ALL ON FUNCTION "public"."fire_turn_step_triggers"() TO "anon";
GRANT ALL ON FUNCTION "public"."fire_turn_step_triggers"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fire_turn_step_triggers"() TO "service_role";



GRANT ALL ON FUNCTION "public"."fire_zone_change_triggers"() TO "anon";
GRANT ALL ON FUNCTION "public"."fire_zone_change_triggers"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fire_zone_change_triggers"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_card_behavior_continuous_effects"("p_script" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."get_card_behavior_continuous_effects"("p_script" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_card_behavior_continuous_effects"("p_script" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_card_behavior_mana_abilities"("p_script" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."get_card_behavior_mana_abilities"("p_script" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_card_behavior_mana_abilities"("p_script" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_card_behavior_schema_version"("p_script" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."get_card_behavior_schema_version"("p_script" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_card_behavior_schema_version"("p_script" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_combat_action_state"("p_session_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_combat_action_state"("p_session_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_combat_action_state"("p_session_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_combat_assignments"("p_session_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_combat_assignments"("p_session_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_combat_assignments"("p_session_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_land_play_limit"("p_session_id" "uuid", "p_player_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_land_play_limit"("p_session_id" "uuid", "p_player_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_land_play_limit"("p_session_id" "uuid", "p_player_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_session_players"("p_session_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_session_players"("p_session_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_session_players"("p_session_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_stack_items"("p_session_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_stack_items"("p_session_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_stack_items"("p_session_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_turn_state"("p_session_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_turn_state"("p_session_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_turn_state"("p_session_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."import_deck_from_text"("p_name" "text", "p_decklist" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."import_deck_from_text"("p_name" "text", "p_decklist" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."import_deck_from_text"("p_name" "text", "p_decklist" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."initialize_turn_state"("p_session_id" "uuid", "p_active_player_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."initialize_turn_state"("p_session_id" "uuid", "p_active_player_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."initialize_turn_state"("p_session_id" "uuid", "p_active_player_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_session_player"("p_session_id" "uuid", "p_player_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_session_player"("p_session_id" "uuid", "p_player_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_session_player"("p_session_id" "uuid", "p_player_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."join_game_session"("p_session_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."join_game_session"("p_session_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."join_game_session"("p_session_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."lock_game_session"("p_session_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."lock_game_session"("p_session_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."lock_game_session"("p_session_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."maybe_finish_game_session"("p_session_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."maybe_finish_game_session"("p_session_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."maybe_finish_game_session"("p_session_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."move_card_to_zone"("p_game_card_id" "uuid", "p_zone" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."move_card_to_zone"("p_game_card_id" "uuid", "p_zone" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."move_card_to_zone"("p_game_card_id" "uuid", "p_zone" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."move_lethal_damaged_creatures_to_graveyard"("p_session_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."move_lethal_damaged_creatures_to_graveyard"("p_session_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."move_lethal_damaged_creatures_to_graveyard"("p_session_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."pass_priority"("p_session_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."pass_priority"("p_session_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pass_priority"("p_session_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."pay_mana_cost"("p_session_id" "uuid", "p_player_id" "uuid", "p_mana_cost" "text", "p_generic_payment" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."pay_mana_cost"("p_session_id" "uuid", "p_player_id" "uuid", "p_mana_cost" "text", "p_generic_payment" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pay_mana_cost"("p_session_id" "uuid", "p_player_id" "uuid", "p_mana_cost" "text", "p_generic_payment" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."put_action_on_stack"("p_session_id" "uuid", "p_action_type" "text", "p_payload" "jsonb", "p_source_card_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."put_action_on_stack"("p_session_id" "uuid", "p_action_type" "text", "p_payload" "jsonb", "p_source_card_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."put_action_on_stack"("p_session_id" "uuid", "p_action_type" "text", "p_payload" "jsonb", "p_source_card_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."put_in_graveyard"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."put_in_graveyard"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."put_in_graveyard"("p_session_id" "uuid", "p_game_card_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."rebuild_scripted_continuous_effects"("p_session_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."rebuild_scripted_continuous_effects"("p_session_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."rebuild_scripted_continuous_effects"("p_session_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."register_card_continuous_effects"("p_session_id" "uuid", "p_source_card_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."register_card_continuous_effects"("p_session_id" "uuid", "p_source_card_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."register_card_continuous_effects"("p_session_id" "uuid", "p_source_card_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."relink_card_scripts"() TO "anon";
GRANT ALL ON FUNCTION "public"."relink_card_scripts"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."relink_card_scripts"() TO "service_role";



GRANT ALL ON FUNCTION "public"."resolve_combat_damage"("p_session_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."resolve_combat_damage"("p_session_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."resolve_combat_damage"("p_session_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."resolve_top_of_stack"("p_session_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."resolve_top_of_stack"("p_session_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."resolve_top_of_stack"("p_session_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "anon";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "service_role";



GRANT ALL ON FUNCTION "public"."session_has_targetable_creature"("p_session_id" "uuid", "p_controller_id" "uuid", "p_target_controller" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."session_has_targetable_creature"("p_session_id" "uuid", "p_controller_id" "uuid", "p_target_controller" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."session_has_targetable_creature"("p_session_id" "uuid", "p_controller_id" "uuid", "p_target_controller" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_card_controller"("p_game_card_id" "uuid", "p_controller_player_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."set_card_controller"("p_game_card_id" "uuid", "p_controller_player_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_card_controller"("p_game_card_id" "uuid", "p_controller_player_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_card_copied_script"("p_game_card_id" "uuid", "p_copied_script" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."set_card_copied_script"("p_game_card_id" "uuid", "p_copied_script" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_card_copied_script"("p_game_card_id" "uuid", "p_copied_script" "jsonb") TO "service_role";



GRANT ALL ON TABLE "public"."cards" TO "anon";
GRANT ALL ON TABLE "public"."cards" TO "authenticated";
GRANT ALL ON TABLE "public"."cards" TO "service_role";



GRANT ALL ON FUNCTION "public"."set_card_script"("p_card_id" "uuid", "p_script" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."set_card_script"("p_card_id" "uuid", "p_script" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_card_script"("p_card_id" "uuid", "p_script" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_card_static_effects_suppressed"("p_game_card_id" "uuid", "p_suppressed" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."set_card_static_effects_suppressed"("p_game_card_id" "uuid", "p_suppressed" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_card_static_effects_suppressed"("p_game_card_id" "uuid", "p_suppressed" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."set_card_tapped"("p_game_card_id" "uuid", "p_is_tapped" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."set_card_tapped"("p_game_card_id" "uuid", "p_is_tapped" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_card_tapped"("p_game_card_id" "uuid", "p_is_tapped" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."set_combat_blocker_order"("p_session_id" "uuid", "p_assignment_id" "uuid", "p_blocker_card_ids" "uuid"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."set_combat_blocker_order"("p_session_id" "uuid", "p_assignment_id" "uuid", "p_blocker_card_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_combat_blocker_order"("p_session_id" "uuid", "p_assignment_id" "uuid", "p_blocker_card_ids" "uuid"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."set_game_turn_state_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_game_turn_state_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_game_turn_state_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trigger_effect_requires_creature_target"("p_effect" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."trigger_effect_requires_creature_target"("p_effect" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."trigger_effect_requires_creature_target"("p_effect" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."trigger_effects_require_creature_target"("p_effects" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."trigger_effects_require_creature_target"("p_effects" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."trigger_effects_require_creature_target"("p_effects" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."trigger_effects_target_controller"("p_effects" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."trigger_effects_target_controller"("p_effects" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."trigger_effects_target_controller"("p_effects" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."untap_all"("p_session_id" "uuid", "p_player_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."untap_all"("p_session_id" "uuid", "p_player_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."untap_all"("p_session_id" "uuid", "p_player_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."update_deck_list"("p_deck_id" "uuid", "p_card_ids" "uuid"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."update_deck_list"("p_deck_id" "uuid", "p_card_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_deck_list"("p_deck_id" "uuid", "p_card_ids" "uuid"[]) TO "service_role";



GRANT ALL ON TABLE "public"."decks" TO "anon";
GRANT ALL ON TABLE "public"."decks" TO "authenticated";
GRANT ALL ON TABLE "public"."decks" TO "service_role";



GRANT ALL ON TABLE "public"."game_combat_blockers" TO "anon";
GRANT ALL ON TABLE "public"."game_combat_blockers" TO "authenticated";
GRANT ALL ON TABLE "public"."game_combat_blockers" TO "service_role";



GRANT ALL ON TABLE "public"."game_players" TO "anon";
GRANT ALL ON TABLE "public"."game_players" TO "authenticated";
GRANT ALL ON TABLE "public"."game_players" TO "service_role";



GRANT ALL ON TABLE "public"."game_sessions" TO "anon";
GRANT ALL ON TABLE "public"."game_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."game_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







