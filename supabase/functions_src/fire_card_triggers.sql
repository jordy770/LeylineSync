-- supabase/functions_src/fire_card_triggers.sql
-- CANONICAL current definition (seeded from 00_baseline.sql; first edited in
-- mig 245). Edit THIS file, then generate a migration with
-- scripts/new-migration.mjs — never re-extract from past migrations.

create or replace function public.fire_card_triggers(
  p_session_id uuid,
  p_game_card_id uuid,
  p_events text[]
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_controller uuid;
  v_card_name text;
  v_script jsonb;
  v_ability jsonb;
  v_event text;
begin
  select
    coalesce(game_cards.controller_player_id, game_cards.owner_id),
    cards.name
  into v_controller, v_card_name
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id;

  v_script := public.effective_script(p_session_id, p_game_card_id);

  if v_script is null or not (v_script ? 'triggered_abilities') then
    return;
  end if;

  for v_ability in
    select * from jsonb_array_elements(v_script -> 'triggered_abilities')
  loop
    v_event := lower(coalesce(v_ability ->> 'event', ''));

    -- Mode gate (mig 245, Frontier Siege): an ability carrying `mode` is live
    -- only when `chosen` equals it. The script ships chosen:"$chosen"; the
    -- ETB choice bakes the picked word into copied_script, turning exactly
    -- one mode's abilities on. Before the choice, every gated ability is inert.
    if (v_ability ? 'mode')
       and (v_ability ->> 'mode') is distinct from (v_ability ->> 'chosen') then
      continue;
    end if;

    if v_event = any (p_events) then
      perform public.enqueue_triggered_ability(
        p_session_id,
        v_controller,
        p_game_card_id,
        coalesce(v_card_name, v_ability ->> 'id', v_event),
        v_ability -> 'effects'
      );
    end if;
  end loop;
end;
$$;
grant execute on function public.fire_card_triggers(uuid, uuid, text[]) to authenticated;
grant execute on function public.fire_card_triggers(uuid, uuid, text[]) to service_role;
