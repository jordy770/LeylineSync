-- supabase/functions_src/apply_damage_allocations.sql
-- CANONICAL current definition (new in 202605010233_divide_damage.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.
--
-- Applies a resolved divide_damage allocation list: each entry is
-- {game_card_id|player_id, amount}. Creatures take damage via apply_creature_effect
-- (runs the lethal SBA), planeswalkers via apply_damage_to_planeswalker, players
-- lose life. One zero-loyalty sweep + game-end check at the end.

create or replace function public.apply_damage_allocations(
  p_session_id uuid,
  p_allocations jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alloc jsonb;
  v_card uuid;
  v_player uuid;
  v_amount integer;
  v_is_pw boolean;
begin
  for v_alloc in select * from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb))
  loop
    v_card := nullif(v_alloc ->> 'game_card_id', '')::uuid;
    v_player := nullif(v_alloc ->> 'player_id', '')::uuid;
    v_amount := coalesce((v_alloc ->> 'amount')::integer, 0);
    if v_amount <= 0 then
      continue;
    end if;

    if v_card is not null then
      select c.type_line ilike '%planeswalker%' into v_is_pw
      from public.game_cards g join public.cards c on c.id = g.card_id
      where g.id = v_card and g.session_id = p_session_id;
      if coalesce(v_is_pw, false) then
        perform public.apply_damage_to_planeswalker(p_session_id, v_card, v_amount);
      else
        perform public.apply_creature_effect(p_session_id, 'deal_damage', v_card,
          jsonb_build_object('amount', v_amount));
      end if;
    elsif v_player is not null then
      update public.game_session_players
      set life_total = greatest(0, life_total - v_amount)
      where session_id = p_session_id and player_id = v_player;
    end if;
  end loop;

  perform public.move_zero_loyalty_planeswalkers_to_graveyard(p_session_id);
  perform public.maybe_finish_game_session(p_session_id);
end;
$$;
grant execute on function public.apply_damage_allocations(uuid, jsonb) to authenticated;
grant execute on function public.apply_damage_allocations(uuid, jsonb) to service_role;
