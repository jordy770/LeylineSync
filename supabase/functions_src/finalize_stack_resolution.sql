-- supabase/functions_src/finalize_stack_resolution.sql
-- CANONICAL current definition (seeded from 202605010087_finalize_stack_resolution.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

create or replace function public.finalize_stack_resolution(
  p_session_id uuid,
  p_stack_item_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_finish_state jsonb;
  v_action_type text;
  v_source_card_id uuid;
  v_buyback boolean;
begin
  update public.game_stack_items
  set status = 'resolved', resolved_at = now()
  where id = p_stack_item_id
  returning action_type, source_card_id, coalesce((payload ->> 'buyback')::boolean, false)
  into v_action_type, v_source_card_id, v_buyback;

  -- Buyback (mig 430, Disturbed Burial / Mind Games): a spell cast with
  -- buyback goes to its owner's hand AS IT RESOLVES. The cast moved the card
  -- to the graveyard, so pull it back from there only — a countered spell is
  -- cancelled by handle_counter_spell, never reaches this finalize, and stays
  -- in the graveyard. Decision-parked items arrive here via resume_or_finalize,
  -- so the return also fires after a resolution-time pick.
  if v_buyback and v_source_card_id is not null then
    update public.game_cards
    set zone = 'hand',
        zone_position = (select coalesce(max(x.zone_position), -1) + 1
                         from public.game_cards x
                         where x.session_id = p_session_id
                           and x.owner_id = game_cards.owner_id
                           and x.zone = 'hand')
    where id = v_source_card_id
      and session_id = p_session_id
      and zone = 'graveyard';
  end if;

  perform public.rebuild_scripted_continuous_effects(p_session_id);

  update public.game_turn_state
  set
    priority_player_id = active_player_id,
    priority_cycle_started_by = null,
    priority_pass_count = 0
  where session_id = p_session_id;

  v_finish_state := public.maybe_finish_game_session(p_session_id);

  return jsonb_build_object(
    'resolved_stack_item_id', p_stack_item_id,
    'action_type', v_action_type,
    'finished', coalesce((v_finish_state ->> 'finished')::boolean, false),
    'winner_player_id', v_finish_state ->> 'winner_player_id'
  );
end;
$$;
grant execute on function public.finalize_stack_resolution(uuid, uuid) to authenticated;
