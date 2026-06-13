-- supabase/functions_src/get_session_players.sql
-- CANONICAL current definition (seeded from 00_baseline.sql; mig 222 added
-- mulligans + opening_hand_kept for the opening-hand overlay).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs.
-- NOTE: changing the RETURNS TABLE shape needs `drop function if exists
-- public.get_session_players(uuid);` in the migration prelude.

CREATE OR REPLACE FUNCTION "public"."get_session_players"("p_session_id" "uuid") RETURNS TABLE("session_id" "uuid", "player_id" "uuid", "username" "text", "seat_number" integer, "life_total" integer, "mulligans" integer, "opening_hand_kept" boolean, "joined_at" timestamp with time zone)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select
    game_session_players.session_id,
    game_session_players.player_id,
    coalesce(
      nullif(profiles.username, ''),
      left(game_session_players.player_id::text, 8)
    ) as username,
    game_session_players.seat_number,
    game_session_players.life_total,
    game_session_players.mulligans,
    game_session_players.opening_hand_kept,
    game_session_players.joined_at
  from public.game_session_players
  left join public.profiles
    on profiles.id = game_session_players.player_id
  where game_session_players.session_id = p_session_id
    and public.is_session_player(p_session_id, auth.uid())
  order by game_session_players.seat_number;
$$;
grant execute on function public.get_session_players(uuid) to authenticated;
