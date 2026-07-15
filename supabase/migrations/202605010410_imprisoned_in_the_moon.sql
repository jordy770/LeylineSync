-- 202605010410_imprisoned_in_the_moon
-- TODO: describe the change.
-- Generated from supabase/functions_src (effective_script, declare_attacker, declare_blocker) — those files are
-- the canonical current definitions; edit them, not past migrations.

create or replace function public.effective_script(p_session_id uuid, p_game_card_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_script jsonb;
  v_granted record;
  v_ability jsonb;
begin
  select coalesce(game_cards.copied_script, cards.script)
  into v_script
  from public.game_cards
  join public.cards on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id;

  -- Ability strip (mig 410, Imprisoned in the Moon): a granted_type carrying
  -- strip_abilities blanks the enchanted permanent's OWN abilities — it keeps
  -- only what other effects grant it (Imprisoned's "{T}: Add {C}"). Applied
  -- before the granted-ability merge so the grant survives.
  if exists (
    select 1 from public.game_continuous_effects ce
    join public.game_cards src on src.id = ce.source_card_id and src.session_id = ce.session_id
    where ce.session_id = p_session_id and ce.effect_type = 'granted_type'
      and ce.affected_card_id = p_game_card_id and src.zone = 'battlefield'
      and coalesce((ce.payload ->> 'strip_abilities')::boolean, false)) then
    v_script := '{"schema_version":2}'::jsonb;
  end if;

  -- Merge granted abilities (one continuous-effect row per grant).
  if exists (select 1 from public.game_continuous_effects
             where session_id = p_session_id and effect_type = 'granted_ability'
               and affected_card_id = p_game_card_id) then
    -- Guard against scalar catalog scripts: token rows may carry jsonb 'null'
    -- (not SQL null — coalesce passes it), and jsonb_set on a scalar raises
    -- "cannot set path in scalar" (bug-2687: job_select's Hero token receiving
    -- Astrologian's Planisphere's granted trigger).
    if v_script is null or jsonb_typeof(v_script) <> 'object' then
      v_script := '{"schema_version":2}'::jsonb;
    end if;
    for v_granted in
      select payload from public.game_continuous_effects
      where session_id = p_session_id and effect_type = 'granted_ability'
        and affected_card_id = p_game_card_id
      order by id
    loop
      v_ability := v_granted.payload -> 'ability';
      if v_ability is null then continue; end if;
      if lower(coalesce(v_granted.payload ->> 'kind', 'triggered')) = 'activated' then
        v_script := jsonb_set(v_script, '{activated_abilities}',
          coalesce(v_script -> 'activated_abilities', '[]'::jsonb) || jsonb_build_array(v_ability));
      else
        v_script := jsonb_set(v_script, '{triggered_abilities}',
          coalesce(v_script -> 'triggered_abilities', '[]'::jsonb) || jsonb_build_array(v_ability));
      end if;
    end loop;
  end if;

  return v_script;
end;
$$;
grant execute on function public.effective_script(uuid, uuid) to anon, authenticated, service_role;

create or replace function public.declare_attacker(
  p_session_id uuid,
  p_attacker_card_id uuid,
  p_defending_player_id uuid,
  p_defending_planeswalker_id uuid default null,
  p_exert boolean default false
) returns public.game_combat_assignments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_attacker record;
  v_pw record;
  v_defending_player uuid := p_defending_player_id;
  v_assignment public.game_combat_assignments;
  v_curse record;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  -- Attacking a planeswalker: the defending player is its controller.
  if p_defending_planeswalker_id is not null then
    select coalesce(gc.controller_player_id, gc.owner_id) as controller, c.type_line
    into v_pw
    from public.game_cards gc
    join public.cards c on c.id = gc.card_id
    where gc.id = p_defending_planeswalker_id
      and gc.session_id = p_session_id
      and gc.zone = 'battlefield';
    if not found or coalesce(v_pw.type_line, '') not ilike '%planeswalker%' then
      raise exception 'Defending planeswalker not found on the battlefield';
    end if;
    v_defending_player := v_pw.controller;
  end if;

  if not public.is_session_player(p_session_id, v_defending_player) then
    raise exception 'Defending player is not a player in this session';
  end if;

  if v_defending_player = auth.uid() then
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

  -- Creature-ness via the type-changing layer (mig 410): a permanent turned
  -- into a noncreature (Imprisoned in the Moon → colorless land) can't attack.
  if coalesce(public.effective_type_line(p_session_id, p_attacker_card_id), v_attacker.type_line, '') not ilike '%creature%'
     -- Animated lands (mig 277, Obuun): an active 'animated' row makes a
     -- noncreature permanent attack-capable.
     and not exists (
       select 1 from public.game_continuous_effects ce
       where ce.session_id = p_session_id and ce.effect_type = 'animated'
         and ce.affected_card_id = p_attacker_card_id
     )
  then
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

  -- Defender (mig 323): a creature with defender (printed or granted) can't attack.
  if public.card_has_defender(p_session_id, p_attacker_card_id) then
    raise exception 'A creature with defender cannot attack';
  end if;

  -- Attack taxes (mig 275, Ghostly Prison / Windborn Muse / Norn's Annex):
  -- 'attack_tax' rows protecting the DEFENDER are auto-paid per attacker —
  -- payload {mana:N} deducts N generic from the attacker's pool (greedy,
  -- colourless first; raises when short), payload {life:N} pays life.
  declare
    v_tax record;
    v_tax_pool jsonb;
    v_tax_due integer;
    v_tax_col text;
    v_tax_have integer;
  begin
    for v_tax in
      select ce.payload
      from public.game_continuous_effects ce
      join public.game_cards src on src.id = ce.source_card_id and src.session_id = ce.session_id
      where ce.session_id = p_session_id
        and ce.effect_type = 'attack_tax'
        and ce.affected_player_id = v_defending_player
        and src.zone = 'battlefield'
    loop
      if coalesce((v_tax.payload ->> 'life')::integer, 0) > 0 then
        update public.game_session_players
        set life_total = life_total - (v_tax.payload ->> 'life')::integer
        where session_id = p_session_id and player_id = auth.uid();
      end if;
      v_tax_due := coalesce((v_tax.payload ->> 'mana')::integer, 0);
      if v_tax_due > 0 then
        select coalesce(mana_pool, '{}'::jsonb) into v_tax_pool
        from public.game_players
        where session_id = p_session_id and player_id = auth.uid()
        for update;
        foreach v_tax_col in array array['C','W','U','B','R','G'] loop
          exit when v_tax_due <= 0;
          v_tax_have := coalesce((v_tax_pool ->> v_tax_col)::integer, 0);
          if v_tax_have > 0 then
            v_tax_pool := v_tax_pool || jsonb_build_object(v_tax_col, v_tax_have - least(v_tax_have, v_tax_due));
            v_tax_due := v_tax_due - least(v_tax_have, v_tax_due);
          end if;
        end loop;
        if v_tax_due > 0 then
          raise exception 'Cannot pay the attack tax (% generic per attacker)', (v_tax.payload ->> 'mana');
        end if;
        update public.game_players
        set mana_pool = v_tax_pool
        where session_id = p_session_id and player_id = auth.uid();
      end if;
    end loop;
  end;

  -- Attack restriction (Gadrak: "can't attack unless you control four or more
  -- artifacts"). A top-level script prop {count, at_least}; the count is read
  -- for the attacking player (auth.uid()).
  declare
    v_restrict jsonb := public.effective_script(p_session_id, p_attacker_card_id) -> 'cant_attack_unless';
  begin
    if v_restrict is not null
       and public.resolve_count_amount(p_session_id, auth.uid(), v_restrict)
           < coalesce((v_restrict ->> 'at_least')::integer, 1)
    then
      raise exception 'This creature cannot attack: an attack condition is not met';
    end if;
  end;

  -- Pacify (mig 303, Observed Stasis): a 'cant_attack' continuous effect on the
  -- creature (e.g. from an Aura that "can't attack or block") forbids attacking.
  if exists (
    select 1 from public.game_continuous_effects ce
    join public.game_cards src on src.id = ce.source_card_id and src.session_id = ce.session_id
    where ce.session_id = p_session_id and ce.effect_type = 'cant_attack'
      and ce.affected_card_id = p_attacker_card_id and src.zone = 'battlefield'
  ) then
    raise exception 'This creature cannot attack';
  end if;

  -- Goad (mig 249): a goaded creature can't attack the player who goaded it
  -- while another opponent is available ("attacks a player other than you if
  -- able"). With only one opponent, attacking the goader is legal.
  if exists (
    select 1 from public.game_continuous_effects ce
    where ce.session_id = p_session_id and ce.effect_type = 'goaded'
      and ce.affected_card_id = p_attacker_card_id
      and nullif(ce.payload ->> 'goaded_by', '')::uuid = v_defending_player
  ) and exists (
    select 1 from public.game_session_players sp
    where sp.session_id = p_session_id
      and sp.player_id not in (auth.uid(), v_defending_player)
  ) then
    raise exception 'This creature is goaded: it must attack a player other than its goader';
  end if;

  -- Territorial Hellkite (mig 249): a must_attack marker pins THIS combat's
  -- defender to the randomly chosen opponent.
  if (select gc.counters ->> 'must_attack' from public.game_cards gc where gc.id = p_attacker_card_id)
       is not null
     and (select gc.counters ->> 'must_attack' from public.game_cards gc where gc.id = p_attacker_card_id)
       is distinct from v_defending_player::text then
    raise exception 'This creature must attack the randomly chosen player this combat';
  end if;

  -- Assignment BEFORE the tap (mig 283): becomes_tapped watchers with the
  -- not_attacking filter ("if it isn't being declared as an attacker",
  -- Rhoda / Verity Circle) check for this row at tap-trigger time.
  insert into public.game_combat_assignments (
    session_id,
    turn_number,
    attacker_card_id,
    attacking_player_id,
    defending_player_id,
    defending_planeswalker_id
  )
  values (
    p_session_id,
    v_turn_state.turn_number,
    p_attacker_card_id,
    auth.uid(),
    v_defending_player,
    p_defending_planeswalker_id
  )
  returning * into v_assignment;

  update public.game_cards
  set is_tapped = true
  where id = p_attacker_card_id
    and not public.card_has_vigilance(p_session_id, p_attacker_card_id);

  -- Remember the defender + consume the pin (mig 249, Territorial Hellkite's
  -- "an opponent that this creature didn't attack during your last combat").
  -- Only stamped for creatures whose script uses territorial_attack, so the
  -- counter bag stays clean for everything else.
  if (select gc.counters ? 'must_attack' from public.game_cards gc where gc.id = p_attacker_card_id)
     or public.effective_script(p_session_id, p_attacker_card_id)::text like '%territorial_attack%' then
    update public.game_cards
    set counters = (coalesce(counters, '{}'::jsonb) - 'must_attack')
          || jsonb_build_object('last_attacked', v_defending_player::text)
    where id = p_attacker_card_id and session_id = p_session_id;
  end if;

  -- Exert (mig 236, Glorybringer): "You may exert this creature as it attacks.
  -- When you do, <effects>." Exerting marks it (so it skips its next untap, see
  -- advance_step) and enqueues the exert effects (a targeted attack trigger).
  if p_exert then
    declare
      v_exert jsonb := public.effective_script(p_session_id, p_attacker_card_id) -> 'exert';
    begin
      if v_exert is not null and jsonb_typeof(v_exert) = 'array' then
        update public.game_cards
        set counters = public.adjust_counter_bag(coalesce(counters, '{}'::jsonb), 'exerted', 1)
        where id = p_attacker_card_id and session_id = p_session_id;
        perform public.enqueue_triggered_ability(
          p_session_id, auth.uid(), p_attacker_card_id, 'Exert', v_exert);
      end if;
    end;
  end if;

  -- Curse of Disturbance: when the defending player is attacked, each curse
  -- enchanting them makes its controller create a 2/2 black Zombie — and "each
  -- opponent attacking that player does the same" (the attacking player too).
  for v_curse in
    select ce.source_card_id, coalesce(gc.controller_player_id, gc.owner_id) as curse_controller
    from public.game_continuous_effects ce
    join public.game_cards gc on gc.id = ce.source_card_id
      and gc.session_id = p_session_id and gc.zone = 'battlefield'
    where ce.session_id = p_session_id
      and ce.effect_type = 'curse_attacked'
      and ce.affected_player_id = v_defending_player
  loop
    perform public.enqueue_triggered_ability(
      p_session_id, v_curse.curse_controller, v_curse.source_card_id,
      'Curse of Disturbance', jsonb_build_array(jsonb_build_object('type', 'create_token', 'token', 'Zombie Token')));
    if auth.uid() is distinct from v_curse.curse_controller then
      perform public.enqueue_triggered_ability(
        p_session_id, auth.uid(), v_curse.source_card_id,
        'Curse of Disturbance', jsonb_build_array(jsonb_build_object('type', 'create_token', 'token', 'Zombie Token')));
    end if;
  end loop;

  return v_assignment;
end;
$$;
grant execute on function public.declare_attacker(uuid, uuid, uuid, uuid, boolean) to authenticated;
grant execute on function public.declare_attacker(uuid, uuid, uuid, uuid, boolean) to service_role;

create or replace function public.declare_blocker(
  p_session_id uuid, p_blocker_card_id uuid, p_attacker_card_id uuid
) returns public.game_combat_assignments
language plpgsql
security definer
set search_path = public
as $$
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

  -- Pacify (mig 303, Observed Stasis): a 'cant_block' continuous effect on the
  -- creature (e.g. from an Aura that "can't attack or block") forbids blocking.
  if exists (
    select 1 from public.game_continuous_effects ce
    join public.game_cards src on src.id = ce.source_card_id and src.session_id = ce.session_id
    where ce.session_id = p_session_id and ce.effect_type = 'cant_block'
      and ce.affected_card_id = p_blocker_card_id and src.zone = 'battlefield'
  ) then
    raise exception 'This creature cannot block';
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

  -- Creature-ness via the type-changing layer (mig 410): a permanent turned
  -- into a noncreature (Imprisoned in the Moon) can't block.
  if coalesce(public.effective_type_line(p_session_id, p_blocker_card_id), v_blocker_type_line, '') not ilike '%creature%'
     -- Animated lands (mig 277) can block too.
     and not exists (
       select 1 from public.game_continuous_effects ce
       where ce.session_id = p_session_id and ce.effect_type = 'animated'
         and ce.affected_card_id = p_blocker_card_id
     )
  then
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

  -- Protection: an attacker with protection from the blocker's colour can't be
  -- blocked by it.
  if public.card_has_protection_from_any(
       p_session_id, p_attacker_card_id,
       public.game_card_color_set(p_session_id, p_blocker_card_id)
     ) then
    raise exception 'Attacker has protection from this blocker''s colour and cannot be blocked by it';
  end if;

  -- "Can't be blocked this turn" (mig 397, Rogue's Passage): an until-EOT
  -- 'unblockable' grant on the attacker forbids every block.
  if public.card_has_unblockable(p_session_id, p_attacker_card_id) then
    raise exception 'This creature can''t be blocked this turn';
  end if;

  -- Intimidate: only artifact creatures and/or creatures sharing a colour with the
  -- attacker can block it.
  if public.card_has_intimidate(p_session_id, p_attacker_card_id) then
    if not (
      exists (
        select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.id = p_blocker_card_id and gc.session_id = p_session_id and c.type_line ilike '%artifact%'
      )
      or public.game_card_color_set(p_session_id, p_blocker_card_id)
         && public.game_card_color_set(p_session_id, p_attacker_card_id)
    ) then
      raise exception 'An intimidating creature can only be blocked by artifact creatures or creatures that share a colour with it';
    end if;
  end if;

  -- Fear (mig 338, Cover of Darkness): only artifact and/or black creatures can
  -- block a creature with fear.
  if public.card_has_fear(p_session_id, p_attacker_card_id) then
    if not (
      exists (
        select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.id = p_blocker_card_id and gc.session_id = p_session_id and c.type_line ilike '%artifact%'
      )
      or 'black' = any(public.game_card_color_set(p_session_id, p_blocker_card_id))
    ) then
      raise exception 'A creature with fear can only be blocked by artifact creatures and/or black creatures';
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

  -- "Whenever this creature becomes blocked" (mig 273, Ichorclaw Myr): fired
  -- once per block declaration against the ATTACKER. (Multi-blocker combats
  -- fire once per blocker — approximation; the real event fires once.)
  perform public.fire_card_triggers(
    p_session_id, p_attacker_card_id, array['becomes_blocked']);

  return v_assignment;
end;
$$;
grant execute on function public.declare_blocker(uuid, uuid, uuid) to anon, authenticated, service_role;
