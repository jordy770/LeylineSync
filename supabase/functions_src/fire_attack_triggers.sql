-- supabase/functions_src/fire_attack_triggers.sql
-- CANONICAL current definition (seeded from 00_baseline.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

CREATE OR REPLACE FUNCTION "public"."fire_attack_triggers"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_attacker_controller uuid;
begin
  -- Myriad / Delina tokens (mig 355) are PUT INTO combat already attacking, not
  -- declared as attackers, so "whenever this attacks" must NOT fire for them
  -- (else a myriad copy's own myriad re-triggers forever). They carry a
  -- no_attack_trigger marker stamped before their combat assignment is inserted.
  if exists (select 1 from public.game_cards
             where id = NEW.attacker_card_id and session_id = NEW.session_id
               and counters ? 'no_attack_trigger') then
    return null;
  end if;

  -- The defender rides as event context (mig 250: dethrone's "attacks the
  -- player with the most life").
  perform public.fire_card_triggers(
    NEW.session_id,
    NEW.attacker_card_id,
    array['attacks', 'declares_attack', 'attack'],
    jsonb_build_object('event_player_id', NEW.defending_player_id)
  );

  -- Watcher broadcast (mig 227): "whenever a creature you control attacks"
  -- (Atarka, World Render). The attacking creature is the event subject, so a
  -- reflexive "it gains double strike" lands on it.
  select coalesce(controller_player_id, owner_id) into v_attacker_controller
  from public.game_cards
  where id = NEW.attacker_card_id and session_id = NEW.session_id;

  perform public.fire_watcher_triggers(
    NEW.session_id, NEW.attacker_card_id, v_attacker_controller, 'creature_attacks'
  );

  return null;
end;
$$;
