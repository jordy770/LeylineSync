-- 202605010371_board_state
-- get_board_state(session): the big-screen board view in one jsonb payload —
-- board counterpart of get_controller_state (mig 370). Replaces useBoardGameState's
-- ~8 PostgREST reads + the per-refresh catalog re-fetch with one round-trip.
-- security definer, gated to a session member; returns only public board state.
-- Generated from supabase/functions_src (get_board_state) — those files are
-- the canonical current definitions; edit them, not past migrations.

create or replace function public.get_board_state(
  p_session_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null or not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Not a player in this session';
  end if;

  select jsonb_build_object(
    'session', (
      select to_jsonb(s) from (
        select id, status, format, created_by, created_at, locked_at, finished_at, winner_player_id
        from public.game_sessions where id = p_session_id
      ) s),
    'turn_state', (select to_jsonb(t) from public.get_turn_state(p_session_id) t limit 1),
    'players', (select coalesce(jsonb_agg(to_jsonb(pl)), '[]'::jsonb)
                from public.get_session_players(p_session_id) pl),
    'combat_assignments', (select coalesce(jsonb_agg(to_jsonb(ca)), '[]'::jsonb)
                           from public.get_combat_assignments(p_session_id) ca),
    'stack_items', (select coalesce(jsonb_agg(to_jsonb(si)), '[]'::jsonb)
                    from public.get_stack_items(p_session_id) si),
    'commander_damage', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'defender_player_id', d.defender_player_id,
        'source_card_id', d.source_card_id,
        'damage', d.damage,
        'name', coalesce(c.name, 'Commander'))), '[]'::jsonb)
      from public.game_commander_damage d
      left join public.game_cards gc on gc.id = d.source_card_id
      left join public.cards c on c.id = gc.card_id
      where d.session_id = p_session_id and d.damage > 0),
    -- Only the two board-badged status types (mirrors getStatusEffects).
    'status_effects', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'effect_type', ce.effect_type,
        'affected_card_id', ce.affected_card_id,
        'affected_player_id', ce.affected_player_id,
        'payload', ce.payload)), '[]'::jsonb)
      from public.game_continuous_effects ce
      where ce.session_id = p_session_id and ce.effect_type in ('animated', 'attack_tax')),
    'board_cards', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', g.id, 'card_id', g.card_id, 'position_x', g.position_x, 'position_y', g.position_y,
        'is_tapped', g.is_tapped, 'damage_marked', g.damage_marked, 'zone', g.zone,
        'controller_player_id', g.controller_player_id, 'plus_one_counters', g.plus_one_counters,
        'counters', g.counters, 'attached_to', g.attached_to, 'is_token', g.is_token,
        'copy_original_card_id', g.copy_original_card_id,
        'name', c.name, 'image_url', c.image_url, 'type_line', c.type_line, 'mana_cost', c.mana_cost,
        'power_toughness', c.power_toughness, 'keywords', c.keywords)
        order by g.zone_position asc, g.id asc), '[]'::jsonb)
      from public.game_cards g
      left join public.cards c on c.id = g.card_id
      where g.session_id = p_session_id and g.zone = 'battlefield')
  ) into v_result;

  return v_result;
end;
$$;
grant execute on function public.get_board_state(uuid) to authenticated, service_role;
