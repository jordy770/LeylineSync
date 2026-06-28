-- supabase/functions_src/get_stack_items.sql
-- CANONICAL current definition (seeded from 202605010077_dies_and_attacks_triggers.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.
--
-- Adds source_card_image_url + source_card_type_line so the controller can show
-- a card thumbnail / zoom for each spell on the stack (the source card lives in
-- zone 'stack', so it is not in the client's hand/battlefield image map).
-- NOTE: changing the RETURNS TABLE shape requires dropping the old function
-- first (Postgres won't change an existing function's return type) — the
-- migration hand-adds `drop function if exists public.get_stack_items(uuid);`.

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
