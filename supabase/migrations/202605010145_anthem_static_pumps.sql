-- Phase 4 / F2.2d — ANTHEMS: static, source-gated team pumps (CR 613 layer 7d).
--
-- register_card_continuous_effects already stores a `pump` continuous effect authored
-- with affected:'controller' (→ affected_player_id = the source's controller) or
-- affected:'all' (→ both affected ids null) — i.e. "creatures you control get +1/+1"
-- (Glorious Anthem) / "all creatures get +1/+1". But card_effective_power/toughness
-- only summed pumps with affected_card_id = the creature (auras/equipment/until-EOT),
-- so these player-scoped anthems were stored yet NEVER applied.
--
-- This reproduces the two accessors (CURRENT def = mig 128) and adds an anthem fold:
-- a player-scoped (affected_player_id = the creature's controller) or global
-- (affected_player_id null) pump with NO affected_card_id, applied only to CREATURES,
-- gated on the source still being in its required zone (so the anthem stops the moment
-- its source leaves the battlefield). Layer order is unchanged: 7b set → 7c counters →
-- 7d pumps (per-card pumps + anthems, same layer).
--
-- SCOPE: untyped anthems ("creatures you control"). Tribal/typed anthems ("Goblins
-- you control") and "OTHER creatures you control" (excluding a creature-lord itself)
-- are later refinements. (IDE T-SQL false-positives on $$ — ignore.)

create or replace function public.card_effective_power(p_session_id uuid, p_game_card_id uuid)
returns integer
language sql security definer set search_path = public
as $$
  select
    coalesce(
      -- 7b: a set_pt effect overrides the printed base (most recent wins).
      (select (e.payload ->> 'power')::integer
       from public.game_continuous_effects e
       left join public.game_cards sc on sc.id = e.source_card_id
       where e.session_id = p_session_id
         and e.effect_type = 'set_pt'
         and e.affected_card_id = p_game_card_id
         and (e.source_zone_required is null or sc.zone = e.source_zone_required)
       order by e.created_at desc, e.id desc
       limit 1),
      cards.power,
      case
        when cards.power_toughness ~ '^[0-9]+/[0-9]+$'
          then split_part(cards.power_toughness, '/', 1)::integer
        else 0
      end,
      0
    )
    + coalesce(game_cards.plus_one_counters, 0)
    -- 7d: per-card pumps (auras / equipment / until-end-of-turn).
    + coalesce((
        select sum(coalesce((effects.payload ->> 'power')::integer, 0))
        from public.game_continuous_effects effects
        left join public.game_cards source_card
          on source_card.id = effects.source_card_id
        where effects.session_id = p_session_id
          and effects.effect_type = 'pump'
          and effects.affected_card_id = p_game_card_id
          and (
            effects.source_zone_required is null
            or source_card.zone = effects.source_zone_required
          )
      ), 0)
    -- 7d: ANTHEMS — player-scoped ('controller') or global ('all') pumps, on creatures.
    + coalesce((
        select sum(coalesce((effects.payload ->> 'power')::integer, 0))
        from public.game_continuous_effects effects
        left join public.game_cards source_card
          on source_card.id = effects.source_card_id
        where effects.session_id = p_session_id
          and effects.effect_type = 'pump'
          and effects.affected_card_id is null
          and (
            effects.affected_player_id is null
            or effects.affected_player_id = coalesce(game_cards.controller_player_id, game_cards.owner_id)
          )
          and (
            effects.source_zone_required is null
            or source_card.zone = effects.source_zone_required
          )
          and cards.type_line ilike '%creature%'
      ), 0)
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id;
$$;

create or replace function public.card_effective_toughness(p_session_id uuid, p_game_card_id uuid)
returns integer
language sql security definer set search_path = public
as $$
  select
    coalesce(
      (select (e.payload ->> 'toughness')::integer
       from public.game_continuous_effects e
       left join public.game_cards sc on sc.id = e.source_card_id
       where e.session_id = p_session_id
         and e.effect_type = 'set_pt'
         and e.affected_card_id = p_game_card_id
         and (e.source_zone_required is null or sc.zone = e.source_zone_required)
       order by e.created_at desc, e.id desc
       limit 1),
      cards.toughness,
      case
        when cards.power_toughness ~ '^[0-9]+/[0-9]+$'
          then split_part(cards.power_toughness, '/', 2)::integer
        else 0
      end,
      0
    )
    + coalesce(game_cards.plus_one_counters, 0)
    + coalesce((
        select sum(coalesce((effects.payload ->> 'toughness')::integer, 0))
        from public.game_continuous_effects effects
        left join public.game_cards source_card
          on source_card.id = effects.source_card_id
        where effects.session_id = p_session_id
          and effects.effect_type = 'pump'
          and effects.affected_card_id = p_game_card_id
          and (
            effects.source_zone_required is null
            or source_card.zone = effects.source_zone_required
          )
      ), 0)
    + coalesce((
        select sum(coalesce((effects.payload ->> 'toughness')::integer, 0))
        from public.game_continuous_effects effects
        left join public.game_cards source_card
          on source_card.id = effects.source_card_id
        where effects.session_id = p_session_id
          and effects.effect_type = 'pump'
          and effects.affected_card_id is null
          and (
            effects.affected_player_id is null
            or effects.affected_player_id = coalesce(game_cards.controller_player_id, game_cards.owner_id)
          )
          and (
            effects.source_zone_required is null
            or source_card.zone = effects.source_zone_required
          )
          and cards.type_line ilike '%creature%'
      ), 0)
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id;
$$;
