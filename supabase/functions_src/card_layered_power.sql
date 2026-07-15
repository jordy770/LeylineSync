-- supabase/functions_src/card_layered_power.sql
-- CANONICAL current definition (seeded from 202605010209_choose_color_anthem.sql,
-- the newest definition in supabase/migrations — verified per bug-682).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs.

create or replace function public.card_layered_power(p_session_id uuid, p_game_card_id uuid)
returns integer
language sql security definer set search_path = public
as $$
  select
    coalesce(
      (select (e.payload ->> 'power')::integer
       from public.game_continuous_effects e
       left join public.game_cards sc on sc.id = e.source_card_id
       where e.session_id = p_session_id
         and e.effect_type = 'set_pt'
         and e.affected_card_id = p_game_card_id
         and (e.source_zone_required is null or sc.zone = e.source_zone_required)
       order by e.created_at desc, e.id desc
       limit 1),
      public.card_cda_value(p_session_id, p_game_card_id, 'power'),
      cards.power,
      case
        when cards.power_toughness ~ '^[0-9]+/[0-9]+$'
          then split_part(cards.power_toughness, '/', 1)::integer
        else 0
      end,
      0
    )
    + coalesce(game_cards.plus_one_counters, 0)
    - coalesce((game_cards.counters ->> 'minus_one_one')::integer, 0)
    + coalesce((
        select sum(coalesce((effects.payload ->> 'power')::integer, 0))
        from public.game_continuous_effects effects
        left join public.game_cards source_card
          on source_card.id = effects.source_card_id
        where effects.session_id = p_session_id
          and effects.effect_type = 'pump'
          and effects.affected_card_id = p_game_card_id
          and (effects.source_zone_required is null or source_card.zone = effects.source_zone_required)
      ), 0)
    + coalesce((
        select sum(coalesce((effects.payload ->> 'power')::integer, 0))
        from public.game_continuous_effects effects
        left join public.game_cards source_card
          on source_card.id = effects.source_card_id
        where effects.session_id = p_session_id
          and effects.effect_type = 'pump'
          and effects.affected_card_id is null
          and (effects.affected_player_id is null
               or effects.affected_player_id = coalesce(game_cards.controller_player_id, game_cards.owner_id))
          and (effects.source_zone_required is null or source_card.zone = effects.source_zone_required)
          and cards.type_line ilike '%creature%'
          -- Tribal anthem type filter honors the type-changing layer (mig 409):
          -- a changeling / granted-type creature gets a lord's bonus.
          and (effects.payload ->> 'creature_type' is null
               or case when coalesce((effects.payload ->> 'exclude_type')::boolean, false)
                    then not public.card_has_creature_type(p_session_id, game_cards.id, effects.payload ->> 'creature_type')
                    else public.card_has_creature_type(p_session_id, game_cards.id, effects.payload ->> 'creature_type')
                  end)
          and (coalesce((effects.payload ->> 'exclude_source')::boolean, false) = false
               or game_cards.id <> effects.source_card_id)
          -- Commander-only anthem (Dancer's Chakrams: "other commanders you
          -- control get +2/+2"). Limits the pump to commanders the source's
          -- controller controls, excluding the equipped creature ("other").
          and (effects.payload ->> 'commander_only' is null
               or (game_cards.is_commander
                   and game_cards.id is distinct from source_card.attached_to))
          -- Colour-filtered anthem (mig 209, Heraldic Banner): only creatures
          -- of the payload colour get the pump.
          -- Conditional anthem (mig 269, Jor Kadeen metalcraft: '+3/+0 as long
          -- as you control three or more artifacts'). Read-time gate against
          -- the SOURCE's controller.
          and (effects.payload ->> 'condition_count' is null
               or public.resolve_count_amount(p_session_id,
                    coalesce(source_card.controller_player_id, source_card.owner_id),
                    jsonb_build_object('count', effects.payload ->> 'condition_count'),
                    effects.source_card_id)
                  >= coalesce((effects.payload ->> 'condition_at_least')::integer, 1))
          -- Conditional anthem on the source controller's library top card colour
          -- (Vampire Nocturnus, mig 342: "as long as the top card is black").
          and (effects.payload ->> 'condition_top_card_color' is null
               or public.library_top_is_color(p_session_id,
                    coalesce(source_card.controller_player_id, source_card.owner_id),
                    effects.payload ->> 'condition_top_card_color'))
          and (effects.payload ->> 'color' is null
               or public.card_color_set(cards.mana_cost) @> array[lower(effects.payload ->> 'color')])
      ), 0)

    + coalesce((
        -- Dynamic pump (mig 267, Cranial Plating / Bonehoard): payload
        -- power_count names a count resolved against the SOURCE's controller
        -- at read time (artifacts_you_control, creature_cards_all_graveyards).
        select sum(public.resolve_count_amount(
                 p_session_id,
                 coalesce(source_card.controller_player_id, source_card.owner_id),
                 jsonb_build_object('count', effects.payload ->> 'power_count'),
                 effects.source_card_id))
        from public.game_continuous_effects effects
        left join public.game_cards source_card
          on source_card.id = effects.source_card_id
        where effects.session_id = p_session_id
          and effects.effect_type = 'pump'
          and effects.affected_card_id = p_game_card_id
          and effects.payload ? 'power_count'
          and (effects.source_zone_required is null or source_card.zone = effects.source_zone_required)
      ), 0)
  from public.game_cards
  join public.cards on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id;
$$;
grant execute on function public.card_layered_power(uuid, uuid) to authenticated;
grant execute on function public.card_layered_power(uuid, uuid) to service_role;
