-- supabase/functions_src/fire_token_created.sql
-- CANONICAL current definition (introduced in 202605010399_token_created_watcher.sql).
-- AFTER INSERT trigger on game_cards (battlefield rows only, see the trigger's
-- WHEN clause): when the new row is a TOKEN, (1) bump the creator's turn-stamped
-- tally (turn_tokens_created / _turn — the note_spell_cast pattern) feeding the
-- 'tokens_created_this_turn' count, and (2) broadcast the 'token_created'
-- watcher event (Mirkwood Bats: "whenever you create ... a token").
-- Central by design: create_token, copy tokens, job_select, amass — every path
-- that materialises a battlefield token fires it without call-site changes.

CREATE OR REPLACE FUNCTION "public"."fire_token_created"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_is_token boolean;
  v_turn integer;
  v_controller uuid;
begin
  select coalesce(is_token, false) into v_is_token
  from public.cards where id = NEW.card_id;
  if not v_is_token then
    return null;
  end if;

  v_controller := coalesce(NEW.controller_player_id, NEW.owner_id);
  select turn_number into v_turn
  from public.game_turn_state where session_id = NEW.session_id;

  update public.game_session_players
  set turn_tokens_created = case
        when turn_tokens_created_turn = v_turn then turn_tokens_created + 1
        else 1
      end,
      turn_tokens_created_turn = v_turn
  where session_id = NEW.session_id and player_id = v_controller;

  perform public.fire_watcher_triggers(NEW.session_id, NEW.id, v_controller, 'token_created');
  return null;
end;
$$;
