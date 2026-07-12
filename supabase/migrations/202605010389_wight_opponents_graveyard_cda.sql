-- Wight of Precinct Six (Wilhelt precon) — new CDA count (mig 149 layer 7a):
--   'creature_cards_in_opponents_graveyards'
-- "This creature gets +1/+1 for each creature card in your opponents' graveyards"
-- is authored as cda power/toughness { count, plus: 1 } (printed 1/1 + the count).
--
-- Reproduces card_cda_value from mig 268 (the latest definition) verbatim and adds
-- the one new branch. Token cards/copies never count as creature CARDS in a
-- graveyard (cards.is_token OR game_cards.is_token — the mig 239 convention).

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
          when 'artifacts_you_control' then (
            -- Master of Etherium (mig 268): */* = artifacts you control.
            select count(*)::integer
            from public.game_cards g
            join public.cards c on c.id = g.card_id
            where g.session_id = p_session_id
              and coalesce(g.controller_player_id, g.owner_id) = (select controller_id from spec)
              and g.zone = 'battlefield'
              and c.type_line ilike '%artifact%'
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
          when 'creature_cards_in_opponents_graveyards' then (
            -- Wight of Precinct Six (mig 389): creature CARDS in every other
            -- player's graveyard (tokens are not cards).
            select count(*)::integer
            from public.game_cards g
            join public.cards c on c.id = g.card_id
            where g.session_id = p_session_id
              and g.owner_id <> (select controller_id from spec)
              and g.zone = 'graveyard'
              and c.type_line ilike '%creature%'
              and c.is_token = false
              and g.is_token = false
          )
          else 0
        end
  end;
$$;
grant execute on function public.card_cda_value(uuid, uuid, text) to authenticated;
grant execute on function public.card_cda_value(uuid, uuid, text) to service_role;
