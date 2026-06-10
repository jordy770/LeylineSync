-- supabase/functions_src/fire_turn_step_triggers.sql
-- CANONICAL current definition (seeded from 00_baseline.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

CREATE OR REPLACE FUNCTION "public"."fire_turn_step_triggers"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_card uuid;
  v_events text[];
begin
  if NEW.step is not distinct from OLD.step then
    return null;
  end if;

  v_events := case NEW.step
    when 'upkeep' then array['beginning_of_upkeep', 'upkeep']
    when 'draw' then array['beginning_of_draw_step', 'draw_step']
    -- "At the beginning of combat on your turn" (mig 205, Loyal Subordinate).
    -- The controller filter below already scopes to the ACTIVE player's permanents.
    when 'beginning_of_combat' then array['beginning_of_combat', 'begin_combat']
    when 'end' then array['beginning_of_end_step', 'end_step', 'beginning_of_end']
    else null
  end;

  if v_events is null then
    return null;
  end if;

  for v_card in
    select game_cards.id
    from public.game_cards
    where game_cards.session_id = NEW.session_id
      and game_cards.zone = 'battlefield'
      and coalesce(game_cards.controller_player_id, game_cards.owner_id) = NEW.active_player_id
    order by game_cards.zone_position, game_cards.id
  loop
    perform public.fire_card_triggers(NEW.session_id, v_card, v_events);
  end loop;

  -- "At the beginning of EACH end step" (mig 206, Laboratory Drudge): fires for
  -- EVERY battlefield permanent regardless of controller — unlike the events
  -- above, which are "your <step>" (active player's permanents only).
  if NEW.step = 'end' then
    for v_card in
      select game_cards.id
      from public.game_cards
      where game_cards.session_id = NEW.session_id
        and game_cards.zone = 'battlefield'
      order by game_cards.zone_position, game_cards.id
    loop
      perform public.fire_card_triggers(
        NEW.session_id, v_card, array['beginning_of_each_end_step', 'each_end_step']);
    end loop;
  end if;

  return null;
end;
$$;
