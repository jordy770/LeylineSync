-- supabase/functions_src/card_has_unblockable.sql
-- CANONICAL current definition (introduced in 202605010397_unblockable_grant.sql).
-- Cloned from card_has_fear (mig 338). A creature "can't be blocked" while an
-- 'unblockable' continuous effect applies to it — grant_keyword writes an
-- until-EOT row (Rogue's Passage: "{4},{T}: Target creature can't be blocked
-- this turn"). declare_blocker rejects any block against it.

create or replace function public.card_has_unblockable(p_session_id uuid, p_game_card_id uuid)
returns boolean language sql security definer set search_path = public as $$
  select exists (
    select 1
    from public.game_continuous_effects effects
    left join public.game_cards source_card on source_card.id = effects.source_card_id
    left join public.game_cards tc on tc.id = p_game_card_id
    left join public.cards tcard on tcard.id = tc.card_id
    where effects.session_id = p_session_id
      and effects.effect_type = 'unblockable'
      and (
        effects.affected_card_id = p_game_card_id
        or (
          effects.affected_card_id is null
          and (effects.affected_player_id is null
               or effects.affected_player_id = coalesce(tc.controller_player_id, tc.owner_id))
          and (effects.payload ->> 'creature_type' is null
               or tcard.type_line ilike '%' || (effects.payload ->> 'creature_type') || '%')
          and (not coalesce((effects.payload ->> 'exclude_source')::boolean, false)
               or p_game_card_id is distinct from effects.source_card_id)
          and (not coalesce((effects.payload ->> 'token_only')::boolean, false)
               or coalesce(tcard.is_token, false))
        )
      )
      and (effects.source_zone_required is null or source_card.zone = effects.source_zone_required)
  );
$$;
grant execute on function public.card_has_unblockable(uuid, uuid) to authenticated, service_role;
