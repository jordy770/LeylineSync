-- supabase/functions_src/reduced_mana_cost.sql
-- CANONICAL current definition (new in 202605010231_cost_reduction.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.
--
-- Returns p_cost with its GENERIC portion reduced by all cost reductions that
-- apply to p_caster casting p_card_id:
--   • SELF reduction — the card's own top-level `cost_reduction` script prop
--     ({amount} or {amount, if:{count,type_line?,at_least}} — Draconic Lore:
--     "this spell costs {2} less if you control a Dragon").
--   • STATIC reduction — `cost_reduction` continuous effects the caster controls
--     whose payload.type_line matches the cast card (Dragonlord's Servant /
--     Sarkhan: "Dragon spells you cast cost {1} less").
-- Only generic mana is reduced (coloured/hybrid pips are never removed), floored
-- at zero. A cost with no generic token is returned unchanged.

create or replace function public.reduced_mana_cost(
  p_session_id uuid,
  p_caster uuid,
  p_card_id uuid,
  p_cost text
) returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cost text := coalesce(p_cost, '');
  v_reduction integer := 0;
  v_self jsonb;
  v_type_line text;
  v_generic text;
  v_new integer;
begin
  if btrim(v_cost) = '' or p_caster is null then
    return v_cost;
  end if;

  select c.type_line into v_type_line
  from public.game_cards g join public.cards c on c.id = g.card_id
  where g.id = p_card_id and g.session_id = p_session_id;

  -- Self reduction (the spell's own script).
  v_self := public.effective_script(p_session_id, p_card_id) -> 'cost_reduction';
  if v_self is not null then
    if v_self -> 'if' is not null then
      if public.resolve_count_amount(p_session_id, p_caster, v_self -> 'if')
         >= coalesce((v_self -> 'if' ->> 'at_least')::integer, 1)
      then
        v_reduction := v_reduction + coalesce((v_self ->> 'amount')::integer, 0);
      end if;
    else
      v_reduction := v_reduction + coalesce((v_self ->> 'amount')::integer, 0);
    end if;
  end if;

  -- Static reductions from the caster's battlefield permanents.
  select v_reduction + coalesce(sum(coalesce((ce.payload ->> 'amount')::integer, 0)), 0)
  into v_reduction
  from public.game_continuous_effects ce
  join public.game_cards sc on sc.id = ce.source_card_id and sc.zone = 'battlefield'
  where ce.session_id = p_session_id
    and ce.effect_type = 'cost_reduction'
    and ce.affected_player_id = p_caster
    and (
      coalesce(ce.payload ->> 'type_line', '') = ''
      or coalesce(v_type_line, '') ilike '%' || (ce.payload ->> 'type_line') || '%'
    );

  if v_reduction <= 0 then
    return v_cost;
  end if;

  -- Reduce the single generic token (regexp_replace without 'g' hits the first).
  v_generic := substring(v_cost from '\{(\d+)\}');
  if v_generic is null then
    return v_cost;
  end if;
  v_new := greatest(0, v_generic::integer - v_reduction);
  if v_new = 0 then
    return regexp_replace(v_cost, '\{\d+\}', '');
  else
    return regexp_replace(v_cost, '\{\d+\}', '{' || v_new || '}');
  end if;
end;
$$;
grant execute on function public.reduced_mana_cost(uuid, uuid, uuid, text) to authenticated;
grant execute on function public.reduced_mana_cost(uuid, uuid, uuid, text) to service_role;
