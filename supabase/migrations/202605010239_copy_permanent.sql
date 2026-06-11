-- 202605010239_copy_permanent — token-copy primitive (Will of the Temur,
-- Reflections of Littjara).
--   • game_cards.is_token: game-level token flag. A copy token points at the
--     COPIED card's catalog row (full characteristics + script for free), so
--     token-ness must live on the game card. Consumers updated to check BOTH
--     flags: cease_token_if_off_battlefield (copies cease), put_in_graveyard
--     (nontoken death tally), fire_watcher_triggers (nontoken filter).
--   • create_copy_token(session, recipient, copied_game_card, except): inserts
--     the battlefield copy (carrying copied_script for copy-of-a-copy), fires
--     ETB/watcher triggers via the existing insert trigger, and applies
--     `except` ({power,toughness,keywords}) as a set_pt override + keyword
--     grant rows. Added TYPES ("a Dragon in addition") are NOT modelled.
--   • copy_permanent program action (apply_trigger_effects): parks a pick over
--     battlefield permanents matching target_filter, applied by
--     submit_decision; target:'triggering_creature' copies the event subject
--     directly (Littjara copying the cast spell — the token enters before the
--     original resolves, matching real copy-resolves-first ordering).
--   • choose_mode/trigger_modal now SPLICES the chosen modes' actions into the
--     parked program at resume_index instead of applying them directly, so
--     modes may contain parking actions (copy_permanent, choose_player, …).
--     Untargeted actions reach the same applier as before via the fallthrough.
--   • choose_one gains may_choose_both_if_commander (Will of the Temur).
--   • choose_creature_type bakes the chosen type into the source's
--     copied_script when its script holds the '"$chosen"' placeholder
--     (Littjara's spell_cast watcher filter).
--   • resolve_count_amount gains greatest_mana_value_you_control (Will's draw
--     mode; mana value parsed from mana_cost text).
-- Approximations (documented in card-scripts.json): Will's draw mode draws for
-- the CASTER (not "target player"); copy type additions not modelled.
-- Generated from supabase/functions_src (create_copy_token, cease_token_if_off_battlefield, apply_trigger_effects, submit_decision, put_in_graveyard, fire_watcher_triggers, resolve_count_amount) — those files are
-- the canonical current definitions; edit them, not past migrations.

-- Game-level token flag (copy tokens reference a NONtoken catalog row).
alter table public.game_cards
  add column if not exists is_token boolean not null default false;

create or replace function public.create_copy_token(
  p_session_id uuid,
  p_recipient uuid,
  p_copied_game_card_id uuid,
  p_except jsonb default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_src public.game_cards;
  v_turn integer;
  v_pos integer;
  v_new uuid;
  v_kw text;
begin
  select * into v_src
  from public.game_cards
  where id = p_copied_game_card_id and session_id = p_session_id;
  if not found or p_recipient is null then
    return null;
  end if;

  select turn_number into v_turn
  from public.game_turn_state where session_id = p_session_id;

  select coalesce(max(zone_position), -1) + 1 into v_pos
  from public.game_cards
  where session_id = p_session_id and owner_id = p_recipient and zone = 'battlefield';

  insert into public.game_cards (
    session_id, card_id, owner_id, controller_player_id,
    zone, zone_position, is_tapped, damage_marked,
    position_x, position_y, entered_battlefield_turn_number,
    copied_script, is_token
  )
  values (
    p_session_id, v_src.card_id, p_recipient, p_recipient,
    'battlefield', v_pos, false, 0, 0, 0, coalesce(v_turn, 0),
    v_src.copied_script, true
  )
  returning id into v_new;

  perform public.register_card_continuous_effects(p_session_id, v_new);

  if p_except ? 'power' or p_except ? 'toughness' then
    insert into public.game_continuous_effects (
      session_id, source_card_id, affected_card_id, effect_type, payload, source_zone_required)
    values (
      p_session_id, v_new, v_new, 'set_pt',
      jsonb_build_object(
        'power', coalesce((p_except ->> 'power')::integer, 0),
        'toughness', coalesce((p_except ->> 'toughness')::integer, 0)),
      'battlefield');
  end if;

  for v_kw in
    select lower(value) from jsonb_array_elements_text(coalesce(p_except -> 'keywords', '[]'::jsonb))
  loop
    if v_kw in ('flying', 'haste', 'trample', 'vigilance', 'first_strike',
                'double_strike', 'reach', 'deathtouch', 'indestructible') then
      insert into public.game_continuous_effects (
        session_id, source_card_id, affected_card_id, effect_type, payload, source_zone_required)
      values (p_session_id, v_new, v_new, v_kw, '{}'::jsonb, 'battlefield');
    end if;
  end loop;

  return v_new;
end;
$$;
grant execute on function public.create_copy_token(uuid, uuid, uuid, jsonb) to authenticated;
grant execute on function public.create_copy_token(uuid, uuid, uuid, jsonb) to service_role;

create or replace function public.cease_token_if_off_battlefield() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.zone is distinct from 'battlefield'
    and (coalesce(NEW.is_token, false)
         or exists (select 1 from public.cards where id = NEW.card_id and is_token = true))
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
  v_controller uuid;
  v_count integer;
  v_i integer;
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
        -- "If you control a commander as you cast this spell, you may choose
        -- both" (Will of the Temur, mig 239): the commander check raises the
        -- ceiling to every mode; the minimum stays at `choose`.
        case when coalesce((v_effect ->> 'may_choose_both_if_commander')::boolean, false)
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
      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', lib.id, 'name', c.name) order by c.name, lib.id), '[]'::jsonb)
        into v_options
      from public.game_cards lib join public.cards c on c.id = lib.card_id
      where lib.session_id = p_session_id and lib.owner_id = v_controller and lib.zone = 'library'
        and (v_filter is null or c.type_line ilike '%' || v_filter || '%')
        and (v_name is null or c.name ilike '%' || v_name || '%');

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

    elsif v_type = 'discard' then
      v_who := lower(coalesce(v_effect ->> 'who', 'you'));
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
        with picked as (
          select id from public.game_cards
          where session_id = p_session_id and owner_id = v_decider and zone = 'hand'
          order by random() limit v_amount
        ),
        numbered as (select id, (row_number() over ()) - 1 as rn from picked),
        base as (
          select coalesce(max(zone_position), -1) as m from public.game_cards
          where session_id = p_session_id and owner_id = v_decider and zone = 'graveyard'
        )
        update public.game_cards g
        set zone = 'graveyard', zone_position = base.m + 1 + numbered.rn, is_tapped = false, damage_marked = 0
        from numbered, base
        where g.id = numbered.id;

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
        jsonb_build_object('effects', coalesce(v_effect -> 'effects', '[]'::jsonb), 'cost', v_effect ->> 'cost'))
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

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'choose_player', 'Choose a player', v_options, 1, 1,
        jsonb_build_object('effects', coalesce(v_effect -> 'effects', '[]'::jsonb)))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;

    elsif v_type = 'choose_creature_type' then
      -- A curated creature-type list (the chooser picks one).
      v_options := '[{"type":"Zombie"},{"type":"Human"},{"type":"Elf"},{"type":"Goblin"},{"type":"Soldier"},{"type":"Wizard"},{"type":"Vampire"},{"type":"Spirit"},{"type":"Beast"},{"type":"Dragon"},{"type":"Merfolk"},{"type":"Knight"},{"type":"Cleric"},{"type":"Warrior"},{"type":"Angel"},{"type":"Demon"},{"type":"Elemental"},{"type":"Snake"},{"type":"Insect"}]'::jsonb;
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'choose_creature_type', 'Choose a creature type', v_options, 1, 1,
        jsonb_build_object('effects', coalesce(v_effect -> 'effects', '[]'::jsonb)))
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
        p_session_id, p_stack_item_id, coalesce((v_effect ->> 'count')::integer, 1), v_filter, v_queue
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
        'You may put a card onto the battlefield; the rest go to the bottom',
        v_options, 0, 1,
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
      where gy.session_id = p_session_id and gy.owner_id = v_controller and gy.zone = 'graveyard'
        and (case when v_filter is not null then c.type_line ilike '%' || v_filter || '%'
                  else c.type_line ilike '%creature%' end);

      if jsonb_array_length(v_options) = 0 then v_i := v_i + 1; continue; end if;

      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'return_from_graveyard',
        'Return up to ' || coalesce((v_effect ->> 'count'), '1') || ' from your graveyard',
        v_options, 0, coalesce((v_effect ->> 'count')::integer, 1),
        -- tapped (mig 218, Victimize): battlefield returns enter tapped.
        jsonb_build_object('to', coalesce(v_effect ->> 'to', 'hand'),
                           'tapped', coalesce((v_effect ->> 'tapped')::boolean, false)))
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
          perform public.create_copy_token(
            p_session_id, v_controller,
            nullif(v_item.payload ->> 'triggering_card_id', '')::uuid,
            v_effect -> 'except');
        end if;
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
          jsonb_build_object('except', v_effect -> 'except'))
        returning id into v_decision_id;
        update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
        return v_decision_id;
      end if;

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
      else
        perform public.apply_targeted_triggered_ability_effects(
          p_session_id, v_controller, v_item.source_card_id, jsonb_build_array(v_effect), v_target
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

  elsif v_decision.decision_type in ('search_library', 'choose_cards', 'sacrifice', 'return_from_graveyard', 'reanimate_destroyed', 'look_top', 'proliferate', 'copy_permanent') then
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
    update public.game_cards g set zone_position = s.rn
    from (select id, (row_number() over (order by random(), id) - 1) as rn from public.game_cards
          where session_id = v_decision.session_id and owner_id = v_decision.deciding_player_id and zone = 'library') s
    where g.id = s.id;
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
        update public.game_cards set zone = 'battlefield', zone_position = v_pos, controller_player_id = owner_id, is_tapped = coalesce((v_decision.params ->> 'tapped')::boolean, false), damage_marked = 0, plus_one_counters = 0, entered_battlefield_turn_number = coalesce(v_turn, 0) where id = v_card;
      else
        select coalesce(max(zone_position), -1) + 1 into v_pos from public.game_cards where session_id = v_decision.session_id and owner_id = v_decision.deciding_player_id and zone = 'hand';
        update public.game_cards set zone = 'hand', zone_position = v_pos, is_tapped = false where id = v_card;
      end if;
    end loop;
    perform public.rebuild_scripted_continuous_effects(v_decision.session_id);
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);

  elsif v_decision.decision_type = 'look_top' then
    -- Ureni (mig 223): the chosen card (0 or 1) goes to the battlefield under
    -- the deciding player's control (fires ETB); every OTHER looked-at card goes
    -- to the bottom of the library in a random order.
    v_dest := coalesce(v_decision.params ->> 'to', 'battlefield');
    for v_card in select (value)::uuid from jsonb_array_elements_text(v_top)
    loop
      select coalesce(max(zone_position), -1) + 1 into v_pos
      from public.game_cards where session_id = v_decision.session_id and owner_id = v_decision.deciding_player_id and zone = 'battlefield';
      select turn_number into v_turn from public.game_turn_state where session_id = v_decision.session_id;
      update public.game_cards
      set zone = 'battlefield', zone_position = v_pos, controller_player_id = owner_id,
          is_tapped = false, damage_marked = 0, plus_one_counters = 0,
          entered_battlefield_turn_number = coalesce(v_turn, 0)
      where id = v_card;
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
         -- Token at either level: catalog tokens (cards.is_token) or copy
         -- tokens (game_cards.is_token, mig 239).
         coalesce(c.is_token, false) or coalesce(g.is_token, false), coalesce(g.plus_one_counters, 0)
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

create or replace function public.fire_watcher_triggers(
  p_session_id uuid,
  p_changed_card_id uuid,
  p_changed_controller uuid,
  p_event text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changed_type text;
  v_changed_is_token boolean;
  v_watcher record;
  v_ability jsonb;
  v_filter jsonb;
  v_f_type text;
  v_f_controller text;
  v_exclude_self boolean;
  v_ctrl_ok boolean;
begin
  -- Token at either level: catalog tokens (cards.is_token) or copy tokens
  -- (game_cards.is_token, mig 239).
  select cards.type_line, coalesce(cards.is_token, false) or coalesce(gc.is_token, false)
  into v_changed_type, v_changed_is_token
  from public.game_cards gc
  join public.cards on cards.id = gc.card_id
  where gc.id = p_changed_card_id and gc.session_id = p_session_id;

  for v_watcher in
    select gc.id, coalesce(gc.controller_player_id, gc.owner_id) as controller, c.name as card_name
    from public.game_cards gc
    join public.cards c on c.id = gc.card_id
    where gc.session_id = p_session_id
      and (gc.zone = 'battlefield' or gc.id = p_changed_card_id)
    order by gc.controller_player_id, gc.id
  loop
    for v_ability in
      select * from jsonb_array_elements(
        coalesce(public.effective_script(p_session_id, v_watcher.id) -> 'triggered_abilities', '[]'::jsonb))
    loop
      if lower(coalesce(v_ability ->> 'event', '')) <> p_event then
        continue;
      end if;

      v_filter := v_ability -> 'filter';
      v_f_type := v_filter ->> 'type_line';
      v_f_controller := lower(coalesce(v_filter ->> 'controller', 'you'));
      v_exclude_self := coalesce((v_filter ->> 'exclude_self')::boolean, false);

      -- "another …": skip when the changed card IS the watcher.
      if v_exclude_self and v_watcher.id = p_changed_card_id then
        continue;
      end if;

      -- "nontoken …": skip when the changed creature is a token.
      if coalesce((v_filter ->> 'nontoken')::boolean, false) and v_changed_is_token then
        continue;
      end if;

      -- Type filter: default "creature" for permanent watchers; spell_cast
      -- (Taurean Mauler) matches a SPELL of any type; land_entered (Nesting
      -- Dragon landfall) defaults to 'land' so only land entries match.
      if v_changed_type not ilike '%' || coalesce(v_f_type,
           case p_event when 'spell_cast' then '' when 'land_entered' then 'land' else 'creature' end) || '%' then
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

      perform public.enqueue_triggered_ability(
        p_session_id, v_watcher.controller, v_watcher.id,
        coalesce(v_watcher.card_name, p_event), v_ability -> 'effects',
        p_changed_card_id  -- the triggering creature, for reflexive "it gains …"
      );
    end loop;
  end loop;
end;
$$;
grant execute on function public.fire_watcher_triggers(uuid, uuid, uuid, text) to authenticated;
grant execute on function public.fire_watcher_triggers(uuid, uuid, uuid, text) to service_role;

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

  elsif v_count = 'greatest_mana_value_you_control' then
    -- "the greatest mana value among permanents you control" (Will of the
    -- Temur draw mode, mig 239). Parsed from mana_cost text: numeric symbols
    -- add their value, X adds 0, every other symbol ({R}, {G/U}, …) adds 1.
    select coalesce(max(mv.v), 0)::integer into v_n
    from public.game_cards g
    join public.cards c on c.id = g.card_id
    cross join lateral (
      select coalesce(sum(case when t.sym ~ '^[0-9]+$' then t.sym::integer
                               when upper(t.sym) = 'X' then 0
                               else 1 end), 0) as v
      from regexp_matches(coalesce(c.mana_cost, ''), '\{([^}]+)\}', 'g') r(arr),
           lateral (select r.arr[1] as sym) t
    ) mv
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

  return greatest(0, coalesce(v_n, 0));
end;
$$;
grant execute on function public.resolve_count_amount(uuid, uuid, jsonb) to authenticated;
grant execute on function public.resolve_count_amount(uuid, uuid, jsonb) to service_role;
