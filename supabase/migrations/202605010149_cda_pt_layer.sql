-- Phase 4 / F2.2f — the LAYER resolver, sublayer 7a: CHARACTERISTIC-DEFINING P/T.
--
-- A CDA defines a creature's base power/toughness from a game count ("*/*" =
-- the number of creatures you control, etc.). Layer 7a is applied FIRST — before set
-- (7b), counters (7c), modifiers (7d) and switch (7e) — and is overridable by a 7b
-- set ("becomes 0/1" beats a CDA).
--
-- A CDA is an inherent characteristic of the card, not a game_continuous_effects row,
-- so it's read straight from the card's (effective) script via a top-level `cda` key:
--   { "cda": { "power": {"count":"creatures_you_control"},
--              "toughness": {"count":"creatures_you_control","plus":1} } }
-- This needs NO register/effect_type changes. card_layered_power/toughness
-- (reproduced from mig 146) just gain the CDA in their base coalesce:
--   coalesce( 7b set , 7a cda , printed ).
--
-- Supported counts (bounded): creatures_you_control, lands_you_control,
-- cards_in_graveyard (controller's). `plus` adds a fixed offset (the */1+* pattern).
-- A card with no `cda` key is unaffected (card_cda_value returns null → coalesce falls
-- through to the printed base). (IDE T-SQL false-positives on $$ bodies — ignore.)

-- ---------------------------------------------------------------------------
-- card_cda_value — the 7a base for 'power' or 'toughness', or NULL if the card has
-- no CDA for that characteristic. Count is evaluated live against the board.
-- ---------------------------------------------------------------------------
create or replace function public.card_cda_value(
  p_session_id uuid, p_game_card_id uuid, p_which text
)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  with spec as (
    select
      public.effective_script(p_session_id, p_game_card_id) -> 'cda' -> p_which as s,
      coalesce(gc.controller_player_id, gc.owner_id) as controller_id,
      gc.owner_id
    from public.game_cards gc
    where gc.id = p_game_card_id
      and gc.session_id = p_session_id
  )
  select case
    when (select s from spec) is null then null
    else
      coalesce((select (s ->> 'plus')::integer from spec), 0)
      + case (select s ->> 'count' from spec)
          when 'creatures_you_control' then (
            select count(*)::integer
            from public.game_cards g
            join public.cards c on c.id = g.card_id
            where g.session_id = p_session_id
              and coalesce(g.controller_player_id, g.owner_id) = (select controller_id from spec)
              and g.zone = 'battlefield'
              and c.type_line ilike '%creature%'
          )
          when 'lands_you_control' then (
            select count(*)::integer
            from public.game_cards g
            join public.cards c on c.id = g.card_id
            where g.session_id = p_session_id
              and coalesce(g.controller_player_id, g.owner_id) = (select controller_id from spec)
              and g.zone = 'battlefield'
              and c.type_line ilike '%land%'
          )
          when 'cards_in_graveyard' then (
            select count(*)::integer
            from public.game_cards g
            where g.session_id = p_session_id
              and g.owner_id = (select owner_id from spec)
              and g.zone = 'graveyard'
          )
          else 0
        end
  end;
$$;

grant execute on function public.card_cda_value(uuid, uuid, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- card_layered_power / toughness — reproduced from mig 146 with the 7a CDA inserted
-- into the base coalesce (set 7b overrides CDA 7a overrides printed).
-- ---------------------------------------------------------------------------
create or replace function public.card_layered_power(p_session_id uuid, p_game_card_id uuid)
returns integer
language sql security definer set search_path = public
as $$
  select
    coalesce(
      -- 7b: a set_pt effect overrides everything below (most recent wins).
      (select (e.payload ->> 'power')::integer
       from public.game_continuous_effects e
       left join public.game_cards sc on sc.id = e.source_card_id
       where e.session_id = p_session_id
         and e.effect_type = 'set_pt'
         and e.affected_card_id = p_game_card_id
         and (e.source_zone_required is null or sc.zone = e.source_zone_required)
       order by e.created_at desc, e.id desc
       limit 1),
      -- 7a: a characteristic-defining ability defines the base.
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
      public.card_cda_value(p_session_id, p_game_card_id, 'toughness'),
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
