-- 202605010313_dedupe_cards — merge duplicate card rows into one canonical row,
-- remap every reference, preserve curated scripts, then enforce uniqueness.
--
-- What the audit found on the live DB:
--   * oracle_id'd cards are essentially clean (no real printing duplicates).
--   * ~11.7k rows have oracle_id = NULL and shadow a real card by name (e.g. a
--     second "Forest" with no oracle_id). Decks/games reference these null rows,
--     and 195 of them carry a curated behaviour script.
--
-- Strategy:
--   A) (defensive) collapse any real cards that share an oracle_id to one
--      canonical row — keeps the index creation safe even if the data shifts.
--   B) merge each NULL-oracle row into the real card of the SAME name, but ONLY
--      when exactly one real card has that name (skip Un-set / ambiguous names).
--   Carry the junk row's script onto the canonical card (the in-use one), remap
--   game_cards.card_id + decks.list_data, delete the junk, add the unique index.
--
-- Runs as one transaction on db push: any error rolls it all back.

-- Reference counts (game_cards + decks) — used to pick the canonical real row.
create temporary table _card_remap as
with refs as (
  select card_id as id, count(*)::bigint as n
  from public.game_cards
  group by card_id
  union all
  select elem::uuid as id, count(*)::bigint as n
  from public.decks d
  cross join lateral jsonb_array_elements_text(d.list_data) as elem
  group by elem::uuid
),
ref_totals as (
  select id, sum(n) as ref_n from refs group by id
),
-- A) duplicate REAL cards sharing an oracle_id -> canonical (scripted, then
--    most-referenced, then lowest id).
real_ranked as (
  select
    c.id,
    c.oracle_id,
    row_number() over (
      partition by c.oracle_id
      order by (c.script is not null and c.script <> '{}'::jsonb) desc,
               coalesce(rt.ref_n, 0) desc, c.id
    ) as rn,
    first_value(c.id) over (
      partition by c.oracle_id
      order by (c.script is not null and c.script <> '{}'::jsonb) desc,
               coalesce(rt.ref_n, 0) desc, c.id
    ) as canon_id
  from public.cards c
  left join ref_totals rt on rt.id = c.id
  where c.oracle_id is not null
),
real_remap as (
  select id as dup_id, canon_id, null::jsonb as dup_script
  from real_ranked
  where rn > 1
),
-- B) NULL-oracle junk rows that match EXACTLY ONE real card by name.
real_by_name as (
  -- min(uuid) has no aggregate; min(text)::uuid is fine since real_count = 1 is
  -- the only case we use real_id for (exactly one real row, so the pick is moot).
  select lower(name) as lname, min(id::text)::uuid as real_id, count(*) as real_count
  from public.cards
  where oracle_id is not null
  group by lower(name)
),
null_remap as (
  select c.id as dup_id, r.real_id as canon_id, c.script as dup_script
  from public.cards c
  join real_by_name r on r.lname = lower(c.name)
  where c.oracle_id is null
    and r.real_count = 1
)
select dup_id, canon_id, dup_script from real_remap
union all
select dup_id, canon_id, dup_script from null_remap;

-- Preserve the live curated script: if a merged row had one, put it on the
-- canonical card (decks/games used the junk rows, so their script is in-use).
-- distinct on collapses the rare case of two junk rows -> one canonical.
update public.cards c
set script = s.dup_script
from (
  select distinct on (canon_id) canon_id, dup_script
  from _card_remap
  where dup_script is not null and dup_script <> '{}'::jsonb
  order by canon_id
) s
where c.id = s.canon_id;

-- Remap live game instances.
update public.game_cards gc
set card_id = rm.canon_id
from _card_remap rm
where gc.card_id = rm.dup_id;

-- Remap deck lists (jsonb array of card-id strings), preserving order.
update public.decks d
set list_data = (
  select coalesce(
           jsonb_agg(coalesce(rm.canon_id::text, e.elem) order by e.ord),
           '[]'::jsonb
         )
  from jsonb_array_elements_text(d.list_data) with ordinality as e(elem, ord)
  left join _card_remap rm on rm.dup_id::text = e.elem
)
where jsonb_typeof(d.list_data) = 'array'
  and exists (
    select 1
    from jsonb_array_elements_text(d.list_data) as x(elem)
    join _card_remap rm2 on rm2.dup_id::text = x.elem
  );

-- Drop the now-unreferenced duplicate rows.
delete from public.cards
where id in (select dup_id from _card_remap);

-- Prevent real-oracle printing duplicates from recurring (importer now upserts
-- ON CONFLICT (oracle_id)). NULLs stay allowed/distinct.
create unique index if not exists cards_oracle_id_key
  on public.cards (oracle_id);

drop table if exists _card_remap;
