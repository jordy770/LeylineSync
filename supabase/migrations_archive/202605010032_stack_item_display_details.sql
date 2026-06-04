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
    coalesce(nullif(controller_profiles.username, ''), left(stack_items.controller_player_id::text, 8)) as controller_username,
    stack_items.source_card_id,
    source_card.name as source_card_name,
    nullif(stack_items.payload ->> 'target_player_id', '')::uuid as target_player_id,
    coalesce(
      nullif(target_profiles.username, ''),
      left(nullif(stack_items.payload ->> 'target_player_id', ''), 8),
      'target'
    ) as target_username,
    stack_items.action_type,
    stack_items.payload,
    stack_items.position,
    stack_items.status,
    stack_items.created_at,
    stack_items.resolved_at
  from public.game_stack_items stack_items
  left join public.profiles controller_profiles
    on controller_profiles.id = stack_items.controller_player_id
  left join public.game_cards source_instance
    on source_instance.id = stack_items.source_card_id
  left join public.cards source_card
    on source_card.id = source_instance.card_id
  left join public.profiles target_profiles
    on target_profiles.id = nullif(stack_items.payload ->> 'target_player_id', '')::uuid
  where stack_items.session_id = p_session_id
    and public.is_session_player(p_session_id, auth.uid())
  order by
    case stack_items.status when 'pending' then 0 else 1 end,
    stack_items.position desc,
    stack_items.created_at desc;
$$;

grant execute on function public.get_stack_items(uuid) to authenticated;
