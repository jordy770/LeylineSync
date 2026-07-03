-- 202605010326_stack_bot_username
-- Stack/player names for bots. (1) get_session_players + get_stack_items label a
-- bot 'CPU 🤖 <seat>' (else profile name / short id) so CPU spells aren't shown
-- as "Unknown player" and multiple CPUs stay distinct. (2) get_stack_items'
-- target_username is now NULL when the spell has no player target (it used to
-- fall back to "Unknown player", showing a bogus "→ Unknown player"). RETURNS
-- TABLE shapes unchanged.
-- Generated from supabase/functions_src (get_session_players, get_stack_items) — those files are
-- the canonical current definitions; edit them, not past migrations.

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
      -- Seat-numbered so multiple CPUs in one pod stay distinguishable.
      case when game_session_players.is_bot then 'CPU 🤖 ' || game_session_players.seat_number
           else left(game_session_players.player_id::text, 8) end
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

create or replace function public.get_stack_items(
  p_session_id uuid
)
returns table (
  id uuid,
  session_id uuid,
  controller_player_id uuid,
  controller_username text,
  source_card_id uuid,
  source_card_name text,
  source_card_image_url text,
  source_card_type_line text,
  target_player_id uuid,
  target_username text,
  action_type text,
  payload jsonb,
  "position" integer,
  status text,
  created_at timestamptz,
  resolved_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    stack_items.id,
    stack_items.session_id,
    stack_items.controller_player_id,
    -- Fall back to a CPU label / short id (like get_session_players) so bot
    -- spells on the stack aren't shown as "Unknown player".
    coalesce(
      nullif(controller_profiles.username, ''),
      case when controller_sp.is_bot then 'CPU 🤖 ' || controller_sp.seat_number end,
      nullif(left(stack_items.controller_player_id::text, 8), ''),
      'Unknown player'
    ) as controller_username,
    stack_items.source_card_id,
    coalesce(source_card.name, nullif(stack_items.payload ->> 'label', '')) as source_card_name,
    source_card.image_url as source_card_image_url,
    source_card.type_line as source_card_type_line,
    nullif(stack_items.payload ->> 'target_player_id', '')::uuid as target_player_id,
    -- NULL when the spell has no player target (so the UI shows no "→ name"); a
    -- bot target gets the seat-numbered CPU label, like the controller above.
    case
      when nullif(stack_items.payload ->> 'target_player_id', '') is null then null
      else coalesce(
        nullif(target_profiles.username, ''),
        case when target_sp.is_bot then 'CPU 🤖 ' || target_sp.seat_number end,
        nullif(left((nullif(stack_items.payload ->> 'target_player_id', '')::uuid)::text, 8), ''),
        'Unknown player'
      )
    end as target_username,
    stack_items.action_type,
    stack_items.payload,
    stack_items.position,
    stack_items.status,
    stack_items.created_at,
    stack_items.resolved_at
  from public.game_stack_items stack_items
  left join public.profiles controller_profiles
    on controller_profiles.id = stack_items.controller_player_id
  left join public.game_session_players controller_sp
    on controller_sp.session_id = stack_items.session_id
   and controller_sp.player_id = stack_items.controller_player_id
  left join public.game_cards source_instance
    on source_instance.id = stack_items.source_card_id
  left join public.cards source_card
    on source_card.id = source_instance.card_id
  left join public.profiles target_profiles
    on target_profiles.id = nullif(stack_items.payload ->> 'target_player_id', '')::uuid
  left join public.game_session_players target_sp
    on target_sp.session_id = stack_items.session_id
   and target_sp.player_id = nullif(stack_items.payload ->> 'target_player_id', '')::uuid
  where stack_items.session_id = p_session_id
    and public.is_session_player(p_session_id, auth.uid())
  order by
    case stack_items.status when 'pending' then 0 else 1 end,
    stack_items.position desc,
    stack_items.created_at desc;
$$;
grant execute on function public.get_stack_items(uuid) to authenticated;
