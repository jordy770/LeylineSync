-- supabase/functions_src/divide_damage_options.sql
-- CANONICAL current definition (new in 202605010233_divide_damage.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.
--
-- Builds the legal-target option list for a divide_damage decision (Dragonlord
-- Atarka, Skarrgan Hellkite). p_filter is {controller:'any'|'opponent'|'you',
-- types:['creature','planeswalker','player']}. Card targets carry
-- {game_card_id, name, kind}; player targets carry {player_id, username, kind}.

create or replace function public.divide_damage_options(
  p_session_id uuid,
  p_controller uuid,
  p_filter jsonb
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ctrl text := lower(coalesce(p_filter ->> 'controller', 'any'));
  v_types jsonb := coalesce(p_filter -> 'types', '["creature"]'::jsonb);
  v_opts jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'game_card_id', g.id, 'name', c.name,
           'kind', case when c.type_line ilike '%planeswalker%' then 'planeswalker' else 'creature' end)
           order by c.name, g.id), '[]'::jsonb)
  into v_opts
  from public.game_cards g join public.cards c on c.id = g.card_id
  where g.session_id = p_session_id and g.zone = 'battlefield'
    and (
      (v_types ? 'creature' and c.type_line ilike '%creature%')
      or (v_types ? 'planeswalker' and c.type_line ilike '%planeswalker%')
    )
    and (
      v_ctrl = 'any'
      or (v_ctrl = 'you' and coalesce(g.controller_player_id, g.owner_id) = p_controller)
      or (v_ctrl = 'opponent' and coalesce(g.controller_player_id, g.owner_id) is distinct from p_controller)
    );

  if v_types ? 'player' then
    v_opts := v_opts || coalesce((
      select jsonb_agg(jsonb_build_object('player_id', sp.player_id, 'username', pr.username, 'kind', 'player')
               order by sp.seat_number)
      from public.game_session_players sp
      left join public.profiles pr on pr.id = sp.player_id
      where sp.session_id = p_session_id
        and (
          v_ctrl = 'any'
          or (v_ctrl = 'you' and sp.player_id = p_controller)
          or (v_ctrl = 'opponent' and sp.player_id is distinct from p_controller)
        )
    ), '[]'::jsonb);
  end if;

  return coalesce(v_opts, '[]'::jsonb);
end;
$$;
grant execute on function public.divide_damage_options(uuid, uuid, jsonb) to authenticated;
grant execute on function public.divide_damage_options(uuid, uuid, jsonb) to service_role;
