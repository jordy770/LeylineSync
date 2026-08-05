-- supabase/functions_src/reduce_generic_cost.sql
-- CANONICAL current definition (new in 202605010431_delve.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.
--
-- Returns p_cost with its single generic token reduced by p_by, floored at
-- zero (the token disappears when it hits zero). Coloured/hybrid pips are
-- untouched; a cost without a generic token is returned unchanged. Same
-- rewrite reduced_mana_cost uses for static reductions — extracted so cast
-- paths (delve, mig 431) can reduce an already-computed cost string.

create or replace function public.reduce_generic_cost(
  p_cost text,
  p_by integer
) returns text
language plpgsql
immutable
as $$
declare
  v_cost text := coalesce(p_cost, '');
  v_generic text;
  v_new integer;
begin
  if coalesce(p_by, 0) <= 0 or btrim(v_cost) = '' then
    return v_cost;
  end if;
  v_generic := substring(v_cost from '\{(\d+)\}');
  if v_generic is null then
    return v_cost;
  end if;
  v_new := greatest(0, v_generic::integer - p_by);
  if v_new = 0 then
    return regexp_replace(v_cost, '\{\d+\}', '');
  else
    return regexp_replace(v_cost, '\{\d+\}', '{' || v_new || '}');
  end if;
end;
$$;
grant execute on function public.reduce_generic_cost(text, integer) to authenticated;
grant execute on function public.reduce_generic_cost(text, integer) to service_role;
