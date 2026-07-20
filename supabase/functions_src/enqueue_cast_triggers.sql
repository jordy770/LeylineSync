-- supabase/functions_src/enqueue_cast_triggers.sql
-- CANONICAL current definition.
-- Reads a just-cast card's script.cascade ({count:N} or true) and enqueues N
-- cascade triggered abilities via enqueue_triggered_ability. Called from every
-- cast path (cast_card_from_hand, cast_spell_effect, cast_card_free) right
-- after the 'spell_cast' watcher fire, so a cascade card actually cascades.
-- Written for cascade / generalized nested-cast (design doc:
-- 2026-07-20-cascade-nested-cast-design.md).
create or replace function public.enqueue_cast_triggers(
  p_session_id uuid, p_card_id uuid, p_controller uuid
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_script jsonb; v_mana_cost text; v_mv integer; v_count integer; v_i integer;
begin
  select public.effective_script(p_session_id, p_card_id), c.mana_cost
    into v_script, v_mana_cost
  from public.game_cards gc join public.cards c on c.id = gc.card_id
  where gc.id = p_card_id and gc.session_id = p_session_id;

  if v_script -> 'cascade' is null then return; end if;

  v_mv := public.mana_value(v_mana_cost);
  v_count := case
    when jsonb_typeof(v_script -> 'cascade') = 'object'
      then coalesce((v_script -> 'cascade' ->> 'count')::integer, 1)
    else 1 end;

  for v_i in 1 .. greatest(1, v_count) loop
    perform public.enqueue_triggered_ability(
      p_session_id, p_controller, p_card_id, 'Cascade',
      jsonb_build_array(jsonb_build_object('type', 'cascade', 'cast_mana_value', v_mv)));
  end loop;
end;
$$;
grant execute on function public.enqueue_cast_triggers(uuid, uuid, uuid) to authenticated;
