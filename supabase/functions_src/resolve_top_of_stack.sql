-- supabase/functions_src/resolve_top_of_stack.sql
-- CANONICAL current definition (seeded from 202605010123_apnap_trigger_ordering.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

create or replace function public.resolve_top_of_stack(
  p_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_stack_item public.game_stack_items;
  v_handler_fn text;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select status
  into v_session_status
  from public.game_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Game session not found';
  end if;

  if v_session_status = 'finished' then
    raise exception 'Cannot resolve stack in a finished game session';
  end if;

  -- APNAP: settle the order of any simultaneous triggers before resolving.
  perform public.order_pending_triggers(p_session_id);

  select *
  into v_stack_item
  from public.game_stack_items
  where session_id = p_session_id
    and status = 'pending'
  order by position desc
  limit 1
  for update;

  if not found then
    raise exception 'Stack is empty';
  end if;

  select handler_fn
  into v_handler_fn
  from public.stack_action_handlers
  where action_type = v_stack_item.action_type;

  if v_handler_fn is null then
    raise exception 'Unsupported stack action type: %', v_stack_item.action_type;
  end if;

  -- %I quotes the (table-controlled, public-schema) handler name; the session id
  -- and the whole stack-item row are passed as bound parameters.
  execute format('select public.%I($1, $2)', v_handler_fn)
    into v_result
    using p_session_id, v_stack_item;

  -- A non-null result is an awaiting_decision payload: return it directly,
  -- leaving the item parked. A null result means the side effect is done and the
  -- item should be finalized.
  if v_result is not null then
    return v_result;
  end if;

  return public.finalize_stack_resolution(p_session_id, v_stack_item.id);
end;
$$;
grant execute on function public.resolve_top_of_stack(uuid) to authenticated;
