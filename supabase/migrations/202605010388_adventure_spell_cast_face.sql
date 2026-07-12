-- Adventure spells trigger as their CAST FACE (bug-1513).
--
-- "Whenever you cast a noncreature spell" watchers (Y'shtola, Night's Blessed
-- and the other spellcraft payoffs) matched the FULL dual type_line, so casting
-- Swift End ("Creature - Zombie Knight // Instant - Adventure") read as a
-- CREATURE cast and never fired them. Fourth member of the dual-type-line bug
-- family (1019/1508/1512).
--
-- fire_watcher_triggers now resolves the cast face for spell_cast events:
--   * adventure casts (cast_spell_effect p_adventure -> p_extra.adventure_face)
--     use the BACK face's type and the adventure's own mana cost/value;
--   * every other cast of a dual-faced card uses the FRONT face.
-- cast_card_from_hand needs no change: its creature casts now match the front
-- face explicitly instead of by accident.

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
      if v_changed_type not ilike '%' || coalesce(v_f_type,
           case p_event when 'spell_cast' then '' when 'cast_from_exile' then ''
                        when 'land_entered' then 'land'
                        when 'ability_activated' then ''
                        -- permanent_sacrificed (mig 341, Carmen): any permanent.
                        when 'permanent_sacrificed' then ''
                        else 'creature' end) || '%' then
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

create or replace function public.cast_spell_effect(
  p_session_id uuid,
  p_actions jsonb,
  p_source_card_id uuid default null,
  p_x_value integer default null,
  p_target_card_id uuid default null,
  -- Adventure (mig 295): casting the adventure HALF of a card. On resolution the
  -- source goes to exile (not the graveyard) with a non-expiring play_from_exile
  -- permission, so the creature face can be cast from exile later.
  p_adventure boolean default false
)
returns public.game_stack_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn public.game_turn_state;
  v_session_status text;
  v_source_type_line text;
  v_source_is_commander boolean := false;
  v_source_zone text;
  v_source_mana_cost text;
  v_source_script jsonb;
  v_flashback_cost text;
  v_flashback_life integer;
  v_is_flashback boolean := false;
  v_program jsonb;
  v_timing text;
  v_pending integer;
  v_next_position integer;
  v_next_graveyard integer;
  v_next_exile integer;
  v_resolved_actions jsonb;
  v_stack public.game_stack_items;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if jsonb_typeof(p_actions) <> 'array' or jsonb_array_length(p_actions) < 1 then
    raise exception 'Spell effect needs at least one action';
  end if;

  select status into v_session_status
  from public.game_sessions where id = p_session_id for update;
  if not found then
    raise exception 'Game session not found';
  end if;
  if v_session_status = 'finished' then
    raise exception 'Cannot cast in a finished game session';
  end if;

  select * into v_turn
  from public.game_turn_state where session_id = p_session_id for update;
  if not found then
    raise exception 'Turn state not found';
  end if;
  if coalesce(v_turn.priority_player_id, v_turn.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can cast';
  end if;

  if p_source_card_id is not null then
    select cards.type_line, cards.mana_cost, game_cards.zone, cards.script,
           coalesce(game_cards.is_commander, false)
      into v_source_type_line, v_source_mana_cost, v_source_zone, v_source_script,
           v_source_is_commander
    from public.game_cards
    join public.cards on cards.id = game_cards.card_id
    where game_cards.id = p_source_card_id
      and game_cards.session_id = p_session_id
      and game_cards.owner_id = auth.uid();
    if not found then
      raise exception 'Source card not found or not owned by current user';
    end if;
  end if;

  -- An EXILE source (mig 230 impulse, mig 295 adventure) requires a
  -- play_from_exile permission listing this card. Mirrors cast_card_from_hand;
  -- the card pays its printed cost (below) and goes to the graveyard on cast.
  if p_source_card_id is not null and v_source_zone = 'exile' then
    if not exists (
      select 1 from public.game_continuous_effects ce
      where ce.session_id = p_session_id
        and ce.effect_type = 'play_from_exile'
        and ce.affected_player_id = auth.uid()
        and (ce.payload -> 'card_ids') ? p_source_card_id::text
    ) then
      raise exception 'You do not have permission to play that card from exile';
    end if;
  end if;

  -- Timing: instants any time the caster has priority; sorceries main-phase only,
  -- empty stack, active player. A sourceless cast (tests) defaults to instant.
  if v_source_type_line ilike '%sorcery%' then
    v_timing := 'sorcery';
  else
    v_timing := 'instant';
  end if;

  if v_timing = 'sorcery' then
    if v_turn.active_player_id <> auth.uid() then
      raise exception 'Sorcery actions can only be used by the active player';
    end if;
    if v_turn.step not in ('precombat_main', 'postcombat_main') then
      raise exception 'Sorcery actions can only be used during a main phase';
    end if;
    select count(*) into v_pending
    from public.game_stack_items
    where session_id = p_session_id and status = 'pending';
    if v_pending > 0 then
      raise exception 'Sorcery actions can only be used while the stack is empty';
    end if;
  end if;

  -- The spell program. A FLASHBACK (graveyard) cast uses the script's
  -- `flashback_effect` actions when present, REPLACING the normal effect (the
  -- "Increasing …" cards do more / different on flashback). The engine selects by
  -- cast zone — it does not trust the client's actions for the flashback effect.
  if v_source_zone = 'graveyard'
     and jsonb_typeof(v_source_script -> 'flashback_effect' -> 'actions') = 'array'
     and jsonb_array_length(v_source_script -> 'flashback_effect' -> 'actions') > 0 then
    v_program := v_source_script -> 'flashback_effect' -> 'actions';
  else
    v_program := p_actions;
  end if;

  -- Resolve any top-level "X" amount/count to the caster-chosen x_value before it
  -- is stored on the stack item (resolution code never sees the "X" token).
  select coalesce(jsonb_agg(
    case
      when (elem ->> 'amount') = 'X' or (elem ->> 'count') = 'X' then
        elem
          || (case when (elem ->> 'amount') = 'X'
                then jsonb_build_object('amount', greatest(coalesce(p_x_value, 0), 0)) else '{}'::jsonb end)
          || (case when (elem ->> 'count') = 'X'
                then jsonb_build_object('count', greatest(coalesce(p_x_value, 0), 0)) else '{}'::jsonb end)
      else elem
    end
    order by ord
  ), '[]'::jsonb)
  into v_resolved_actions
  from jsonb_array_elements(v_program) with ordinality as t(elem, ord);

  -- Pay the cast cost. A hand cast pays the printed mana cost (incl {X}). A graveyard
  -- cast is a FLASHBACK: it requires the card's script to carry a `flashback` cost,
  -- pays that instead, and marks the card for exile (below). No-op when the source is
  -- sourceless or free (the free-cast test fixtures).
  if p_source_card_id is not null and v_source_zone in ('hand', 'exile') then
    -- Adventure half (mig 388): the spell being cast is the ADVENTURE, which
    -- has its OWN mana cost (Stomp is {1}{R}, not Bonecrusher's {2}{R}). The
    -- printed cost was charged before — unnoticed only because Murderous
    -- Rider's two costs happen to match.
    if p_adventure then
      v_source_mana_cost := coalesce(v_source_script -> 'adventure' ->> 'cost', v_source_mana_cost);
      v_source_type_line := nullif(split_part(coalesce(v_source_type_line, ''), ' // ', 2), '');
    end if;
    if v_source_mana_cost is not null and btrim(v_source_mana_cost) <> '' then
      -- Cost reduction (mig 231, Draconic Lore: "costs {2} less if you control a
      -- Dragon"). Generic mana is auto-paid here (null generic payment), so the
      -- reduced cost is consumed with no client change. An exile cast (impulse)
      -- pays the printed cost too — impulse is not a free cast.
      perform public.pay_mana_cost(
        p_session_id, auth.uid(),
        public.reduced_mana_cost(p_session_id, auth.uid(), p_source_card_id, v_source_mana_cost),
        null, coalesce(p_x_value, 0),
        p_pay_context := jsonb_build_object('kind', 'cast', 'type_line', coalesce(v_source_type_line, ''),
          'is_commander', v_source_is_commander));
    end if;
  elsif p_source_card_id is not null and v_source_zone = 'graveyard' then
    v_flashback_cost := v_source_script ->> 'flashback';
    if v_flashback_cost is null then
      raise exception 'This card cannot be cast from your graveyard';
    end if;
    v_is_flashback := true;
    if btrim(v_flashback_cost) <> '' then
      perform public.pay_mana_cost(p_session_id, auth.uid(), v_flashback_cost, null, coalesce(p_x_value, 0),
        p_pay_context := jsonb_build_object('kind', 'cast', 'type_line', coalesce(v_source_type_line, ''),
          'is_commander', v_source_is_commander));
    end if;
    -- Additional "Pay N life" flashback cost (Deep Analysis). You cannot pay life
    -- you do not have.
    v_flashback_life := coalesce((v_source_script ->> 'flashback_life')::integer, 0);
    if v_flashback_life > 0 then
      if (select life_total from public.game_session_players
          where session_id = p_session_id and player_id = auth.uid()) < v_flashback_life then
        raise exception 'Not enough life to pay the flashback cost (need %)', v_flashback_life;
      end if;
      update public.game_session_players
      set life_total = life_total - v_flashback_life
      where session_id = p_session_id and player_id = auth.uid();
    end if;
    -- Turn-stamped graveyard-cast tracker (mig 206, Laboratory Drudge).
    perform public.note_graveyard_cast(p_session_id, auth.uid());
  end if;

  select coalesce(max(position), 0) + 1 into v_next_position
  from public.game_stack_items where session_id = p_session_id;

  insert into public.game_stack_items (
    session_id, controller_player_id, source_card_id, action_type, payload, position, status
  )
  values (
    p_session_id,
    auth.uid(),
    p_source_card_id,
    'spell_effect',
    jsonb_build_object('effects', v_resolved_actions, 'controller_player_id', auth.uid(), 'timing', v_timing)
      || (case when p_target_card_id is not null
               then jsonb_build_object('target_card_id', p_target_card_id) else '{}'::jsonb end),
    v_next_position,
    'pending'
  )
  returning * into v_stack;

  -- "Whenever you/an opponent cast a spell" (mig 234, Taurean Mauler): broadcast
  -- the cast to spell_cast watchers. The caster is the source's controller.
  if p_source_card_id is not null then
    perform public.fire_watcher_triggers(p_session_id, p_source_card_id, auth.uid(), 'spell_cast',
      case when p_adventure then jsonb_build_object('adventure_face', true) else null end);
    -- "Whenever you cast a spell from exile" (mig 307, Urianger Augurelt).
    if v_source_zone = 'exile' then
      perform public.fire_watcher_triggers(p_session_id, p_source_card_id, auth.uid(), 'cast_from_exile',
        case when p_adventure then jsonb_build_object('adventure_face', true) else null end);
    end if;
  end if;

  -- Adventure (mig 295): the card is exiled with a non-expiring play_from_exile
  -- permission so its creature face can be cast from exile later. Checked before
  -- the type_line graveyard rule because the source is a CREATURE card.
  if p_adventure and p_source_card_id is not null then
    select coalesce(max(zone_position), -1) + 1 into v_next_exile
    from public.game_cards
    where session_id = p_session_id and owner_id = auth.uid() and zone = 'exile';

    update public.game_cards
    set zone = 'exile', zone_position = v_next_exile, controller_player_id = owner_id,
        is_tapped = false, damage_marked = 0
    where id = p_source_card_id;

    insert into public.game_continuous_effects (
      session_id, source_card_id, affected_player_id, effect_type, payload
    ) values (
      p_session_id, p_source_card_id, auth.uid(), 'play_from_exile',
      jsonb_build_object('card_ids', jsonb_build_array(p_source_card_id), 'permanent', true)
    );

  -- Non-permanent spell leaves its cast zone on cast: a hand OR exile cast goes
  -- to the graveyard; a flashback cast (from the graveyard) is exiled instead.
  elsif v_is_flashback then
    select coalesce(max(zone_position), -1) + 1 into v_next_exile
    from public.game_cards
    where session_id = p_session_id and owner_id = auth.uid() and zone = 'exile';

    update public.game_cards
    set zone = 'exile', zone_position = v_next_exile, controller_player_id = owner_id,
        is_tapped = false, damage_marked = 0
    where id = p_source_card_id;

  elsif p_source_card_id is not null
    and v_source_zone in ('hand', 'exile')
    and (v_source_type_line ilike '%instant%' or v_source_type_line ilike '%sorcery%')
  then
    select coalesce(max(zone_position), -1) + 1 into v_next_graveyard
    from public.game_cards
    where session_id = p_session_id and owner_id = auth.uid() and zone = 'graveyard';

    update public.game_cards
    set zone = 'graveyard', zone_position = v_next_graveyard, is_tapped = false, damage_marked = 0
    where id = p_source_card_id;
  end if;

  return v_stack;
end;
$$;
