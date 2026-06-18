-- Read-only pre-flight audit for migration 202605010313_dedupe_cards.
-- Nothing here writes. The real duplicate problem is NULL-oracle_id rows that
-- shadow a real card by name (e.g. a second "Forest" with no oracle_id). This
-- mirrors the migration's merge: a null-oracle row merges into the real card of
-- the same name ONLY when exactly one real card has that name.


-- ── 1. Headline counts ──────────────────────────────────────────────────────
with real_by_name as (
  select lower(name) as lname, count(*) as real_count
  from public.cards where oracle_id is not null group by lower(name)
),
junk as (
  select c.id
  from public.cards c
  join real_by_name r on r.lname = lower(c.name)
  where c.oracle_id is null and r.real_count = 1
)
select
  (select count(*) from public.cards)                               as total_rows,
  (select count(*) from public.cards where oracle_id is not null)   as with_oracle_id,
  (select count(*) from public.cards where oracle_id is null)       as null_oracle_id,
  (select count(*) from junk)                                       as junk_to_merge,
  (select count(*) from public.cards where oracle_id is null)
    - (select count(*) from junk)                                   as null_rows_left_alone;


-- ── 2. Live references that get remapped onto the real card ──────────────────
with real_by_name as (
  select lower(name) as lname, count(*) as real_count
  from public.cards where oracle_id is not null group by lower(name)
),
junk as (
  select c.id
  from public.cards c
  join real_by_name r on r.lname = lower(c.name)
  where c.oracle_id is null and r.real_count = 1
)
select
  (select count(*) from public.game_cards gc join junk j on gc.card_id = j.id)
    as game_card_instances_to_remap,
  (select count(*) from public.decks d
     cross join lateral jsonb_array_elements_text(d.list_data) e
     join junk j on j.id::text = e)
    as deck_entries_to_remap;


-- ── 3. Preview the merges (junk row -> kept real row), with script flags ─────
-- junk_has_script = true & real_has_script = false  →  the migration carries the
-- script over so curated behaviour isn't lost.
with real_by_name as (
  select lower(name) as lname, min(id::text)::uuid as real_id, count(*) as real_count
  from public.cards where oracle_id is not null group by lower(name)
)
select
  c.name,
  c.id  as junk_id_to_delete,
  r.real_id as kept_id,
  (c.script  is not null and c.script  <> '{}'::jsonb) as junk_has_script,
  (rc.script is not null and rc.script <> '{}'::jsonb) as real_has_script
from public.cards c
join real_by_name r on r.lname = lower(c.name)
join public.cards rc on rc.id = r.real_id
where c.oracle_id is null and r.real_count = 1
order by junk_has_script desc, c.name
limit 300;
