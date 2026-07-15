-- supabase/functions_src/card_has_flash.sql
-- CANONICAL current definition (introduced in 202605010398_flash_timing.sql).
-- Whether a HAND card may be cast at instant speed by p_player_id:
--   1. printed Scryfall keyword 'Flash' on the catalog row, or
--   2. script keywords[] containing 'flash', or
--   3. an active 'flash_permission' continuous effect for that player whose
--      payload.type_line filter matches the card's FRONT face ("You may cast
--      artifact spells as though they had flash" — Shimmer Myr; null = all).
-- cast_card_from_hand uses this to bypass the sorcery-speed gate (active
-- player + main phase + empty stack); holding priority is still required.

create or replace function public.card_has_flash(
  p_session_id uuid,
  p_game_card_id uuid,
  p_player_id uuid
) returns boolean language sql security definer set search_path = public as $$
  select
    exists (
      select 1
      from public.game_cards gc
      join public.cards c on c.id = gc.card_id
      where gc.id = p_game_card_id and gc.session_id = p_session_id
        and (
          exists (select 1 from jsonb_array_elements_text(coalesce(c.keywords, '[]'::jsonb)) k
                  where lower(k.value) = 'flash')
          or exists (select 1 from jsonb_array_elements_text(coalesce(c.script -> 'keywords', '[]'::jsonb)) k
                     where lower(k.value) = 'flash')
        )
    )
    or exists (
      select 1
      from public.game_continuous_effects effects
      left join public.game_cards source_card on source_card.id = effects.source_card_id
      join public.game_cards tc on tc.id = p_game_card_id
      join public.cards tcard on tcard.id = tc.card_id
      where effects.session_id = p_session_id
        and effects.effect_type = 'flash_permission'
        and (effects.affected_player_id is null or effects.affected_player_id = p_player_id)
        and (effects.payload ->> 'type_line' is null
             or split_part(coalesce(tcard.type_line, ''), ' // ', 1)
                ilike '%' || (effects.payload ->> 'type_line') || '%')
        and (effects.source_zone_required is null or source_card.zone = effects.source_zone_required)
    );
$$;
grant execute on function public.card_has_flash(uuid, uuid, uuid) to authenticated, service_role;
