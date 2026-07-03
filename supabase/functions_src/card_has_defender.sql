-- supabase/functions_src/card_has_defender.sql
-- CANONICAL current definition. Edit THIS file, then generate a migration with
-- scripts/new-migration.mjs — never re-extract from past migrations.
--
-- Defender (mig 323): a creature with defender can't attack. Modelled like the
-- other keyword accessors (mig 200 family) — a 'defender' continuous effect,
-- seeded from the card's printed script keywords by register_card_continuous_effects,
-- or granted ("creatures you control have defender") via the same mass-branch
-- filters (creature_type / exclude_source / token_only).
create or replace function public.card_has_defender(p_session_id uuid, p_game_card_id uuid)
returns boolean language sql security definer set search_path = public as $$
  select exists (
    select 1
    from public.game_continuous_effects effects
    left join public.game_cards source_card on source_card.id = effects.source_card_id
    left join public.game_cards tc on tc.id = p_game_card_id
    left join public.cards tcard on tcard.id = tc.card_id
    where effects.session_id = p_session_id
      and effects.effect_type = 'defender'
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
        )
      )
      and (effects.source_zone_required is null or source_card.zone = effects.source_zone_required)
  );
$$;
grant execute on function public.card_has_defender(uuid, uuid) to authenticated, service_role;
