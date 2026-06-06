-- Phase 4 / F2.2e — the LAYER resolver, sublayer 7e: SWITCH power and toughness.
--
-- CR 613.7e is the LAST P/T sublayer: after set (7b), counters (7c) and modifiers
-- (7d, pumps/anthems) produce the final P/T, a "switch power and toughness" effect
-- swaps them. Two switches cancel (parity): an even number of active switches = no
-- net switch.
--
-- To swap, card_effective_power must be able to return the fully-LAYERED TOUGHNESS
-- (and vice versa). So the existing 7b/7c/7d computation (CURRENT def = mig 145, with
-- the anthem fold) is extracted verbatim into card_layered_power / card_layered_
-- toughness, and the public card_effective_power / card_effective_toughness become
-- thin switch-aware wrappers: if an odd number of switch_pt effects affect the card,
-- power returns the layered toughness and toughness returns the layered power.
--
-- SCOPE: per-card switches (affected_card_id), the common case ("switch target
-- creature's P/T", or a static "this creature's P/T are switched"). The layer +
-- add_switch_pt_effect helper land here (like mig 128 did for set_pt); the spell /
-- trigger / script-authoring paths are follow-ups. (IDE T-SQL false-positives on $$.)

-- Allow the new effect_type. CURRENT list = mig 131 (baseline + control + set_pt +
-- protection); append 'switch_pt' (bug-283: never rebuild from the stale list).
alter table public.game_continuous_effects
  drop constraint if exists game_continuous_effects_effect_type_check;
alter table public.game_continuous_effects
  add constraint game_continuous_effects_effect_type_check
  check (effect_type = any (array[
    'mana_does_not_empty', 'additional_land_plays', 'haste', 'vigilance',
    'indestructible', 'trample', 'first_strike', 'double_strike', 'flying',
    'reach', 'deathtouch', 'pump', 'control', 'set_pt', 'protection', 'switch_pt'
  ]));

-- ---------------------------------------------------------------------------
-- add_switch_pt_effect — switch a creature's P/T (layer 7e). Used by tests now and
-- by the (future) "switch target creature's P/T" authoring.
-- ---------------------------------------------------------------------------
create or replace function public.add_switch_pt_effect(
  p_session_id uuid,
  p_affected_card_id uuid,
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
    p_session_id, p_source_card_id, p_affected_card_id, 'switch_pt', '{}'::jsonb, null
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.add_switch_pt_effect(uuid, uuid, uuid) from public;
grant execute on function public.add_switch_pt_effect(uuid, uuid, uuid) to authenticated;
grant execute on function public.add_switch_pt_effect(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- card_layered_power / card_layered_toughness — the 7b set → 7c counters → 7d pumps
-- + anthems computation (reproduced verbatim from mig 145), WITHOUT the 7e switch.
-- ---------------------------------------------------------------------------
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

create or replace function public.card_layered_toughness(p_session_id uuid, p_game_card_id uuid)
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

-- ---------------------------------------------------------------------------
-- A card has its P/T switched when an ODD number of switch_pt effects apply.
-- ---------------------------------------------------------------------------
create or replace function public.card_pt_switched(p_session_id uuid, p_game_card_id uuid)
returns boolean
language sql security definer set search_path = public
as $$
  select (count(*) % 2) = 1
  from public.game_continuous_effects e
  left join public.game_cards sc on sc.id = e.source_card_id
  where e.session_id = p_session_id
    and e.effect_type = 'switch_pt'
    and e.affected_card_id = p_game_card_id
    and (e.source_zone_required is null or sc.zone = e.source_zone_required);
$$;

-- ---------------------------------------------------------------------------
-- card_effective_power / toughness — switch-aware (7e) wrappers over the layered P/T.
-- ---------------------------------------------------------------------------
create or replace function public.card_effective_power(p_session_id uuid, p_game_card_id uuid)
returns integer
language sql security definer set search_path = public
as $$
  select case
    when public.card_pt_switched(p_session_id, p_game_card_id)
      then public.card_layered_toughness(p_session_id, p_game_card_id)
    else public.card_layered_power(p_session_id, p_game_card_id)
  end;
$$;

create or replace function public.card_effective_toughness(p_session_id uuid, p_game_card_id uuid)
returns integer
language sql security definer set search_path = public
as $$
  select case
    when public.card_pt_switched(p_session_id, p_game_card_id)
      then public.card_layered_power(p_session_id, p_game_card_id)
    else public.card_layered_toughness(p_session_id, p_game_card_id)
  end;
$$;
