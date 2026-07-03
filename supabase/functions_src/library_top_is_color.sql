-- supabase/functions_src/library_top_is_color.sql
-- CANONICAL current definition (introduced in 202605010342_vampire_nocturnus.sql).
-- "the top card of your library is black" (Vampire Nocturnus). The library top is
-- the lowest zone_position (what draw_card / look_top take). Used by the
-- conditional anthem predicate in card_layered_power and card_has_flying.

create or replace function public.library_top_is_color(
  p_session_id uuid,
  p_player_id uuid,
  p_color text
) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select lower(p_color) = any(public.card_color_set(
    (select c.mana_cost
       from public.game_cards g
       join public.cards c on c.id = g.card_id
      where g.session_id = p_session_id and g.owner_id = p_player_id and g.zone = 'library'
      order by g.zone_position asc
      limit 1)));
$$;
grant execute on function public.library_top_is_color(uuid, uuid, text) to authenticated, service_role;
