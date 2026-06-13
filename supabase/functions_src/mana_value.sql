-- supabase/functions_src/mana_value.sql
-- CANONICAL current definition (new in mig 244).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

-- Mana value parsed from mana_cost text: numeric symbols add their value, X
-- adds 0, every other symbol ({R}, {G/U}, …) adds 1 ({2/W}-style monohybrids
-- count as 1 — not present in supported decks). Null/empty cost (lands,
-- tokens) is 0.
create or replace function public.mana_value(p_mana_cost text)
returns integer
language sql
immutable
as $$
  select coalesce((
    select sum(case when t.sym ~ '^[0-9]+$' then t.sym::integer
                    when upper(t.sym) = 'X' then 0
                    else 1 end)
    from regexp_matches(coalesce(p_mana_cost, ''), '\{([^}]+)\}', 'g') r(arr),
         lateral (select r.arr[1] as sym) t
  ), 0)::integer;
$$;
grant execute on function public.mana_value(text) to anon, authenticated, service_role;
