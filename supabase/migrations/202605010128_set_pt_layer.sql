-- Phase 4 / F2.2a — the LAYER resolver, slice 1: SET power/toughness (CR 613 7b).
--
-- Continuous P/T was flat-additive: card_effective_power/toughness = printed base
-- + counters + Σpumps. That is wrong whenever something SETS P/T ("becomes a 0/1",
-- "base power and toughness are 1/1"): a set must REPLACE the base, and only then
-- do counters (7c) and other modifiers (7d, pumps/anthems) apply on top. Example:
-- a 4/4 with a +1/+1 counter that becomes 0/1 is a 1/2, not a 5/5.
--
-- This introduces a `set_pt` continuous effect and makes the two effective-P/T
-- accessors layer-aware: the most recent set_pt (by created_at — within-layer
-- timestamp order) overrides the printed base, then counters + pumps add. Switch
-- (7e) and CDAs (7a) remain future slices. card_effective_power/toughness are only
-- defined in the baseline (no later migration redefines them), so this reproduces
-- the baseline bodies verbatim except the new 7b coalesce branch.

-- Allow the new effect_type.
alter table public.game_continuous_effects
  drop constraint if exists game_continuous_effects_effect_type_check;
alter table public.game_continuous_effects
  add constraint game_continuous_effects_effect_type_check
  check (effect_type = any (array[
    'mana_does_not_empty', 'additional_land_plays', 'haste', 'vigilance',
    'indestructible', 'trample', 'first_strike', 'double_strike', 'flying',
    'reach', 'deathtouch', 'pump', 'control', 'set_pt'
  ]));

-- ---------------------------------------------------------------------------
-- add_set_pt_effect — set a creature's base P/T (layer 7b). Used by tests now and
-- by the (future) "becomes X/Y" card authoring. source_zone_required is left null
-- so the effect applies until it expires or is removed (an until-end-of-turn or a
-- static source-gated variant can pass expiry / a zone later).
-- ---------------------------------------------------------------------------
create or replace function public.add_set_pt_effect(
  p_session_id uuid,
  p_affected_card_id uuid,
  p_power integer,
  p_toughness integer,
  p_source_card_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.game_continuous_effects (
    session_id, source_card_id, affected_card_id, effect_type, payload, source_zone_required
  )
  values (
    p_session_id, p_source_card_id, p_affected_card_id, 'set_pt',
    jsonb_build_object('power', p_power, 'toughness', p_toughness), null
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.add_set_pt_effect(uuid, uuid, integer, integer, uuid) from public;
grant execute on function public.add_set_pt_effect(uuid, uuid, integer, integer, uuid) to authenticated;
grant execute on function public.add_set_pt_effect(uuid, uuid, integer, integer, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- card_effective_power — 7b set base (latest wins) → 7c counters → 7d pumps.
-- ---------------------------------------------------------------------------
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
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id;
$$;

-- ---------------------------------------------------------------------------
-- card_effective_toughness — same layering for toughness.
-- ---------------------------------------------------------------------------
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
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id;
$$;
