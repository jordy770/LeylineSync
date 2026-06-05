-- F3 — Protection (DEBT), slice 4a: AURAS + the attachment substrate (the basis
-- for the E "can't be Enchanted/Equipped" gate).
--
-- The engine had no attachment model, so the E gate had nothing to enforce. This
-- adds the substrate (game_cards.attached_to + host-directed continuous effects +
-- an attachment-cleanup trigger) and the first attacher, AURAS:
--   * an Aura is an Enchantment whose type_line contains 'Aura'. It is cast from
--     hand TARGETING a creature; on resolution it enters the battlefield attached
--     to that creature and grants its continuous effect(s) to the host.
--   * a continuous effect authored with affected:'attached' lands on attached_to
--     (so card_effective_power / card_has_* pick it up on the host), and only while
--     the aura is attached and on the battlefield.
--   * E gate: an Aura can't enchant a creature with protection from the Aura's
--     colour — checked at cast (announce) AND re-checked at resolution (the aura is
--     put into its owner's graveyard if the target is no longer legal). Casting an
--     Aura targets, so this also reads as the T gate for Aura spells.
--   * cleanup: when a permanent leaves the battlefield, auras attached to it go to
--     the graveyard; an aura that itself leaves clears its host effects + attachment.
--
-- Equipment + the equip ability land in 134b (next migration). Reproduced fns:
-- register_card_continuous_effects (mig 131 lift + attachment arm), handle_cast_
-- permanent (mig 104 lift + aura attach), cast_card_from_hand (baseline lift + aura
-- target). (IDE T-SQL false-positives on $$ bodies — ignore.)

-- ---------------------------------------------------------------------------
-- 1. Attachment column. Plain uuid (no FK — game_cards rows are only deleted for
-- tokens, and the cleanup trigger nulls stale references). NULL = not attached.
-- ---------------------------------------------------------------------------
alter table public.game_cards
  add column if not exists attached_to uuid;

comment on column public.game_cards.attached_to is
  'For an Aura/Equipment on the battlefield: the game_cards.id of the permanent it is attached to. NULL when unattached. Drives affected:''attached'' continuous effects.';

-- ---------------------------------------------------------------------------
-- 2. register_card_continuous_effects — mig 131 lift, plus the attachment arm:
-- affected:'attached' (aliases host/enchanted/equipped) lands the effect on
-- attached_to. An unattached source skips the effect (grants nothing).
-- ---------------------------------------------------------------------------
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
      'pump'
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
          'deathtouch',
          'protection'
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

-- ---------------------------------------------------------------------------
-- 3. attach_permanent(session, attachment, host) — shared attach primitive used by
-- aura resolution (here) and the equip ability (next migration). Sets attached_to
-- and re-registers the attachment's host effects. SECURITY DEFINER; callers own
-- legality (control, E gate). Returns void.
-- ---------------------------------------------------------------------------
create or replace function public.attach_permanent(
  p_session_id uuid, p_attachment_card_id uuid, p_host_card_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.game_cards
  set attached_to = p_host_card_id
  where id = p_attachment_card_id
    and session_id = p_session_id
    and zone = 'battlefield';

  if not found then
    raise exception 'Attachment is not on the battlefield';
  end if;

  perform public.register_card_continuous_effects(p_session_id, p_attachment_card_id);
end;
$$;

grant execute on function public.attach_permanent(uuid, uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. handle_cast_permanent (mig 104 lift) — on resolution, an Aura attaches to its
-- stored target. The target must still be a legal creature without protection from
-- the Aura's colour, else the Aura is put into its owner's graveyard (it doesn't
-- attach). Non-aura permanents are unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.handle_cast_permanent(
  p_session_id uuid,
  p_stack_item public.game_stack_items
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next_battlefield_position integer;
  v_type_line text;
  v_mana_cost text;
  v_target_card_id uuid;
  v_target_legal boolean;
begin
  if p_stack_item.source_card_id is null then
    raise exception 'Permanent spell has no source card';
  end if;

  select coalesce(max(zone_position), -1) + 1
  into v_next_battlefield_position
  from public.game_cards
  where session_id = p_session_id
    and owner_id = p_stack_item.controller_player_id
    and zone = 'battlefield';

  update public.game_cards
  set
    zone = 'battlefield',
    zone_position = v_next_battlefield_position,
    controller_player_id = coalesce(controller_player_id, owner_id),
    is_tapped = false,
    damage_marked = 0
  where id = p_stack_item.source_card_id
    and session_id = p_session_id
    and owner_id = p_stack_item.controller_player_id
    and zone = 'stack';

  if not found then
    raise exception 'Permanent spell source card not found on stack';
  end if;

  select cards.type_line, cards.mana_cost
  into v_type_line, v_mana_cost
  from public.game_cards
  join public.cards on cards.id = game_cards.card_id
  where game_cards.id = p_stack_item.source_card_id;

  -- Aura: attach to the stored target if it is still a legal creature without
  -- protection from the Aura's colour; otherwise the Aura goes to the graveyard.
  if coalesce(v_type_line, '') ilike '%aura%' then
    v_target_card_id := nullif(p_stack_item.payload ->> 'target_card_id', '')::uuid;

    v_target_legal := v_target_card_id is not null
      and exists (
        select 1 from public.game_cards gc
        join public.cards c on c.id = gc.card_id
        where gc.id = v_target_card_id
          and gc.session_id = p_session_id
          and gc.zone = 'battlefield'
          and c.type_line ilike '%creature%'
      )
      and not public.card_has_protection_from_any(
        p_session_id, v_target_card_id, public.card_color_set(v_mana_cost)
      );

    if v_target_legal then
      perform public.attach_permanent(p_session_id, p_stack_item.source_card_id, v_target_card_id);
    else
      perform public.put_in_graveyard(p_session_id, p_stack_item.source_card_id);
    end if;
  end if;

  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. cast_card_from_hand (baseline lift) — gains p_target_card_id. An Aura REQUIRES
-- a legal creature target without protection from the Aura's colour (E/T gate at
-- announce); the target rides in the cast_permanent payload. Drop the 3-arg first
-- so the 4-arg (4th defaulted) replaces it and existing 3-arg callers resolve to it.
-- ---------------------------------------------------------------------------
drop function if exists public.cast_card_from_hand(uuid, uuid, jsonb);

create or replace function public.cast_card_from_hand(
  p_session_id uuid,
  p_game_card_id uuid,
  p_generic_payment jsonb default null,
  p_target_card_id uuid default null
) returns public.game_cards
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_card public.game_cards;
  v_card_type_line text;
  v_card_mana_cost text;
  v_is_aura boolean;
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

  -- Aura: validate the enchant target (a legal creature without protection from the
  -- Aura's colour) at announce; it rides in the cast_permanent payload to resolution.
  v_is_aura := coalesce(v_card_type_line, '') ilike '%aura%';
  if v_is_aura then
    if p_target_card_id is null then
      raise exception 'An Aura must target a creature to enchant';
    end if;
    if not public.creature_target_controller_ok(p_session_id, p_target_card_id, auth.uid(), 'any') then
      raise exception 'An Aura can only enchant a creature on the battlefield';
    end if;
    if public.card_has_protection_from_any(
         p_session_id, p_target_card_id, public.card_color_set(v_card_mana_cost)
       ) then
      raise exception 'Target creature has protection from this Aura''s colour and can''t be enchanted by it';
    end if;
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
    ) || case when v_is_aura
            then jsonb_build_object('target_card_id', p_target_card_id)
            else '{}'::jsonb end,
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

grant execute on function public.cast_card_from_hand(uuid, uuid, jsonb, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Attachment cleanup trigger. When a permanent LEAVES the battlefield:
--   * Auras attached to it go to the graveyard (state-based: an Aura attached to
--     nothing can't exist).
--   * Equipment attached to it detaches (stays on the battlefield).
--   * If the leaving card is itself an Aura/Equipment, its host continuous effects
--     are cleared and its attachment nulled.
-- Bounded recursion: put_in_graveyard on an aura re-fires this for that aura, which
-- takes the "leaving attachment" branch (no further battlefield exits).
-- ---------------------------------------------------------------------------
create or replace function public.cleanup_attachments_on_zone_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_aura record;
begin
  if TG_OP = 'UPDATE'
     and OLD.zone = 'battlefield'
     and NEW.zone is distinct from 'battlefield'
  then
    -- The leaving card was a host: detach its attachments.
    for v_aura in
      select gc.id, c.type_line
      from public.game_cards gc
      join public.cards c on c.id = gc.card_id
      where gc.session_id = NEW.session_id
        and gc.attached_to = NEW.id
        and gc.zone = 'battlefield'
    loop
      if v_aura.type_line ilike '%aura%' then
        perform public.put_in_graveyard(NEW.session_id, v_aura.id);
      else
        -- Equipment falls off but stays on the battlefield; clear its host effects.
        update public.game_cards
        set attached_to = null
        where id = v_aura.id;

        delete from public.game_continuous_effects
        where session_id = NEW.session_id
          and source_card_id = v_aura.id
          and payload ->> 'registered_from_card_script' = 'true';
      end if;
    end loop;

    -- The leaving card was itself an attachment: clear its host effects + link.
    if NEW.attached_to is not null then
      delete from public.game_continuous_effects
      where session_id = NEW.session_id
        and source_card_id = NEW.id
        and payload ->> 'registered_from_card_script' = 'true';

      update public.game_cards
      set attached_to = null
      where id = NEW.id;
    end if;
  end if;

  return null;
end;
$$;

drop trigger if exists trg_cleanup_attachments on public.game_cards;
create trigger trg_cleanup_attachments
  after update of zone on public.game_cards
  for each row
  execute function public.cleanup_attachments_on_zone_change();
