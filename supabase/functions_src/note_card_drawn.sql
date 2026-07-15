-- supabase/functions_src/note_card_drawn.sql
-- CANONICAL current definition (introduced in 202605010401_card_drawn_watcher.sql).
-- Per-turn draw tally (the note_spell_cast pattern): bumps the player's
-- turn-stamped counter and returns the 1-based index of THIS draw, so the
-- caller can broadcast 'card_drawn' with draw_number (Ethereal Investigator's
-- "your second card each turn", Astrologian's third-card trigger). Every real
-- DRAW site calls it (natural draw, the draw effect, cycling) — puts/returns
-- into hand are not draws and must not.

create or replace function public.note_card_drawn(
  p_session_id uuid,
  p_player_id uuid
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn integer;
  v_n integer;
begin
  select turn_number into v_turn
  from public.game_turn_state where session_id = p_session_id;

  update public.game_session_players
  set turn_cards_drawn = case
        when turn_cards_drawn_turn = v_turn then turn_cards_drawn + 1
        else 1
      end,
      turn_cards_drawn_turn = v_turn
  where session_id = p_session_id and player_id = p_player_id
  returning turn_cards_drawn into v_n;

  return coalesce(v_n, 1);
end;
$$;
grant execute on function public.note_card_drawn(uuid, uuid) to authenticated, service_role;
