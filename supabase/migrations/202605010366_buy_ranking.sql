-- Refine buy-candidate ranking. Two changes vs migration 365:
--  1. Drop pure filler — require weight >= 2 (weight-1 cards are weak fills).
--  2. Within a budget, rank by SYNERGY then by price DESC (best card you can afford),
--     not price ASC — cheapest-first surfaced bulk commons over real staples.
-- The synergy weight itself is now CMC-aware (efficient cards score higher), so the
-- weight sort does most of the work; the price tiebreak just picks the premium option.

create or replace function public.co_buy_candidates(
  p_user_id   uuid,
  p_deck_id   uuid,
  p_identity  text[],
  p_need_tags text[],
  p_max_price numeric,
  p_limit     int default 40
)
returns table (oracle_id text, name text, tag text, weight numeric, price_eur numeric, cmc numeric)
language sql
stable
security invoker
set search_path = public
as $$
  select q.oracle_id, q.name, q.tag, q.weight, q.price_eur, q.cmc
  from (
    select distinct on (t.oracle_id)
      t.oracle_id,
      o.name,
      t.tag,
      t.weight,
      nullif(o.prices->>'eur', '')::numeric as price_eur,
      o.cmc
    from public.co_card_tags t
    join public.co_card_oracle o on o.oracle_id = t.oracle_id
    where t.tag = any(p_need_tags)
      and t.weight >= 2                                -- skip filler
      and o.color_identity <@ p_identity
      and not exists (
        select 1 from public.co_collection_items ci
        where ci.user_id = p_user_id and ci.oracle_id = t.oracle_id
      )
      and not exists (
        select 1 from public.co_deck_cards dc
        where dc.deck_id = p_deck_id and dc.oracle_id = t.oracle_id
      )
    order by t.oracle_id, t.weight desc
  ) q
  where p_max_price is null or (q.price_eur is not null and q.price_eur <= p_max_price)
  order by q.weight desc, q.price_eur desc nulls last   -- best card within budget first
  limit p_limit;
$$;
