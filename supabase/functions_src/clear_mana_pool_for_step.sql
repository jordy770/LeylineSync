-- supabase/functions_src/clear_mana_pool_for_step.sql
-- CANONICAL current definition (seeded from 202605010042_battlefield_static_effects_land_limit.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.
--
-- Empties each player's mana pool as a step ends, EXCEPT colours kept by a
-- `mana_does_not_empty` continuous effect. Restricted ("spend only") mana
-- (game_players.restricted_mana) always empties — none of the modelled
-- restricted sources have a does-not-empty rider.

create or replace function public.clear_mana_pool_for_step(
  p_session_id uuid,
  p_phase text,
  p_step text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
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
      coalesce(mana_pool, v_empty_pool) as mana_pool,
      coalesce(restricted_mana, '[]'::jsonb) as restricted_mana
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

    if v_new_pool <> v_player.mana_pool or v_player.restricted_mana <> '[]'::jsonb then
      update public.game_players
      set mana_pool = v_new_pool,
          restricted_mana = '[]'::jsonb
      where session_id = p_session_id
        and player_id = v_player.player_id;

      v_updated_count := v_updated_count + 1;
    end if;
  end loop;

  return v_updated_count;
end;
$$;
grant execute on function public.clear_mana_pool_for_step(uuid, text, text) to authenticated;
grant execute on function public.clear_mana_pool_for_step(uuid, text, text) to service_role;
