create or replace function public.create_mana_retention_effect(
  p_session_id uuid,
  p_source_card_id uuid,
  p_colors text[],
  p_affected_player_id uuid default null,
  p_expires_at_phase text default 'ending',
  p_expires_at_step text default 'cleanup',
  p_should_tap_card boolean default false
)
returns public.game_continuous_effects
language plpgsql
security definer
set search_path = public
as $$
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

grant execute on function public.create_mana_retention_effect(uuid, uuid, text[], uuid, text, text, boolean) to authenticated;
