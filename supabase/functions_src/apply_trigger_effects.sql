-- supabase/functions_src/apply_trigger_effects.sql
-- CANONICAL current definition (seeded from 202605010198_each_player_sacrifice.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

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
        coalesce((v_effect ->> 'choose')::integer, 1),
        jsonb_build_object('trigger_modal', true))
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
