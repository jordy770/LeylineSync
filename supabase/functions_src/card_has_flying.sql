-- supabase/functions_src/card_has_flying.sql
-- CANONICAL current definition (seeded from 202605010200_keyword_grant_filters.sql;
-- canonicalized in 202605010342_vampire_nocturnus.sql to add the conditional anthem
-- predicate). A creature has flying if a 'flying' continuous effect applies to it.
-- condition_top_card_color (Vampire Nocturnus): the anthem is live only while the
-- SOURCE controller's library top card is that colour.

create or replace function public.card_has_flying(p_session_id uuid, p_game_card_id uuid)
returns boolean language sql security definer set search_path = public as $$
  select exists (
    select 1
    from public.game_continuous_effects effects
    left join public.game_cards source_card on source_card.id = effects.source_card_id
    left join public.game_cards tc on tc.id = p_game_card_id
    left join public.cards tcard on tcard.id = tc.card_id
    where effects.session_id = p_session_id
      and effects.effect_type = 'flying'
      and public.is_session_player(p_session_id, auth.uid())
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
          -- Conditional anthem (Vampire Nocturnus, mig 342): only while the
          -- source controller's library top card is the named colour.
          and (effects.payload ->> 'condition_top_card_color' is null
               or public.library_top_is_color(p_session_id,
                    coalesce(source_card.controller_player_id, source_card.owner_id),
                    effects.payload ->> 'condition_top_card_color'))
        )
      )
      and (effects.source_zone_required is null or source_card.zone = effects.source_zone_required)
  );
$$;
grant execute on function public.card_has_flying(uuid, uuid) to authenticated, service_role;
