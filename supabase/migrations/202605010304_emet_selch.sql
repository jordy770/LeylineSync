-- 202605010304_emet_selch
-- Zone-conditioned cost reduction (mig 304, Emet-Selch). cost_reduction
-- continuous effects gain an optional payload.from_zone — the discount applies
-- only when the card is cast from that zone. "Spells you cast from your
-- graveyard cost {2} less." (Emet-Selch's lose-life recast trigger is not modelled.)
-- Generated from supabase/functions_src (reduced_mana_cost) — those files are
-- the canonical current definitions; edit them, not past migrations.

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
  v_zone text;
  v_generic text;
  v_new integer;
begin
  if btrim(v_cost) = '' or p_caster is null then
    return v_cost;
  end if;

  select c.type_line, g.zone into v_type_line, v_zone
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
    )
    -- from_zone (mig 304, Emet-Selch): "spells you cast from your graveyard cost
    -- {2} less" — apply only when the card is being cast from that zone.
    and (
      coalesce(ce.payload ->> 'from_zone', '') = ''
      or coalesce(v_zone, '') = (ce.payload ->> 'from_zone')
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
