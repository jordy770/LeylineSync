-- Buy suggestions: find cards the player does NOT own that fill a deck's needs,
-- within the colour identity and (optional) budget. Done in SQL so the colour/price
-- filter + collection/deck anti-joins happen in one round trip over the 33k pool,
-- ranked by synergy weight. security_invoker so co_collection_items RLS still applies.

create or replace function public.co_buy_candidates(
  p_user_id   uuid,
  p_deck_id   uuid,
  p_identity  text[],
  p_need_tags text[],
  p_max_price numeric,            -- null = no budget cap
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
    -- Best tag per oracle (highest weight) among the requested needs.
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
      and o.color_identity <@ p_identity              -- card identity fits the deck
      and not exists (                                 -- not already owned
        select 1 from public.co_collection_items ci
        where ci.user_id = p_user_id and ci.oracle_id = t.oracle_id
      )
      and not exists (                                 -- not already in the deck
        select 1 from public.co_deck_cards dc
        where dc.deck_id = p_deck_id and dc.oracle_id = t.oracle_id
      )
    order by t.oracle_id, t.weight desc
  ) q
  where p_max_price is null or (q.price_eur is not null and q.price_eur <= p_max_price)
  order by q.weight desc, q.price_eur asc nulls last
  limit p_limit;
$$;

grant execute on function public.co_buy_candidates(uuid, uuid, text[], text[], numeric, int) to authenticated, service_role;
