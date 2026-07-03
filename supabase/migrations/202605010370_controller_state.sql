-- 202605010370_controller_state
-- get_controller_state(session, player): one jsonb payload bundling every read the
-- controller hook used to make as ~19 separate PostgREST requests per game action.
-- Cuts per-action request volume ~19x so a long game stops accumulating network.
-- security definer, locked to the caller reading their OWN state in their session.
-- Generated from supabase/functions_src (get_controller_state) — those files are
-- the canonical current definitions; edit them, not past migrations.

create or replace function public.get_controller_state(
  p_session_id uuid,
  p_player_id uuid
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
  if p_player_id is distinct from auth.uid() then
    raise exception 'Can only read your own controller state';
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
    'combat_action_state', public.get_combat_action_state(p_session_id),
    'combat_assignments', (select coalesce(jsonb_agg(to_jsonb(ca)), '[]'::jsonb)
                           from public.get_combat_assignments(p_session_id) ca),
    'stack_items', (select coalesce(jsonb_agg(to_jsonb(si)), '[]'::jsonb)
                    from public.get_stack_items(p_session_id) si),
    'pending_decisions', (select coalesce(jsonb_agg(to_jsonb(pd)), '[]'::jsonb)
                          from public.get_pending_decisions(p_session_id) pd),
    'mana_pool', (select mana_pool from public.game_players
                  where session_id = p_session_id and player_id = p_player_id),
    'restricted_mana', (select restricted_mana from public.game_players
                        where session_id = p_session_id and player_id = p_player_id),
    -- Raw continuous effects — the client filters this once for pump / protection /
    -- animated+attack_tax / granted keywords / cost_reduction / cast_from_library_top
    -- / play_from_exile (previously seven separate queries).
    'continuous_effects', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'effect_type', ce.effect_type,
        'affected_card_id', ce.affected_card_id,
        'affected_player_id', ce.affected_player_id,
        'payload', ce.payload)), '[]'::jsonb)
      from public.game_continuous_effects ce
      where ce.session_id = p_session_id),
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
      where g.session_id = p_session_id and g.zone = 'battlefield'),
    'controller_cards', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', g.id, 'card_id', g.card_id, 'is_tapped', g.is_tapped, 'damage_marked', g.damage_marked,
        'zone', g.zone, 'zone_position', g.zone_position, 'controller_player_id', g.controller_player_id,
        'copied_script', g.copied_script, 'static_effects_suppressed', g.static_effects_suppressed,
        'entered_battlefield_turn_number', g.entered_battlefield_turn_number,
        'plus_one_counters', g.plus_one_counters, 'counters', g.counters, 'is_commander', g.is_commander,
        'command_zone_casts', g.command_zone_casts, 'attached_to', g.attached_to, 'is_token', g.is_token,
        'copy_original_card_id', g.copy_original_card_id, 'name', c.name,
        'cards', case when c.id is null then null else jsonb_build_object(
          'id', c.id, 'name', c.name, 'image_url', c.image_url, 'script', c.script,
          'type_line', c.type_line, 'mana_cost', c.mana_cost, 'oracle_text', c.oracle_text,
          'keywords', c.keywords, 'power', c.power, 'toughness', c.toughness,
          'power_toughness', c.power_toughness, 'is_token', c.is_token) end)
        order by g.zone_position asc, g.id asc), '[]'::jsonb)
      from public.game_cards g
      left join public.cards c on c.id = g.card_id
      where g.session_id = p_session_id and g.owner_id = p_player_id)
  ) into v_result;

  return v_result;
end;
$$;
grant execute on function public.get_controller_state(uuid, uuid) to authenticated, service_role;
