-- scaling_cost_reduction
-- Count-scaled self cost reduction: cost_reduction {amount, per:{count}} reduces
-- the generic cost by amount × resolve_count_amount(per). Blasphemous Act ("{1}
-- less for each creature on the battlefield") and Coastal Breach / Undaunted
-- ("{1} less for each opponent"). Fixed and if-conditional forms unchanged.
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
  v_mana_cost text;
  v_generic text;
  v_new integer;
  v_spells_cast integer;
begin
  if btrim(v_cost) = '' or p_caster is null then
    return v_cost;
  end if;

  select c.type_line, g.zone, c.mana_cost into v_type_line, v_zone, v_mana_cost
  from public.game_cards g join public.cards c on c.id = g.card_id
  where g.id = p_card_id and g.session_id = p_session_id;

  -- Self reduction (the spell's own script).
  v_self := public.effective_script(p_session_id, p_card_id) -> 'cost_reduction';
  if v_self is not null then
    if v_self -> 'per' is not null then
      -- Count-scaled reduction (mig 416): `amount` less PER counted thing —
      -- Blasphemous Act ("{1} less for each creature on the battlefield"),
      -- Coastal Breach / Undaunted ("{1} less for each opponent").
      v_reduction := v_reduction
        + coalesce((v_self ->> 'amount')::integer, 1)
          * greatest(0, public.resolve_count_amount(p_session_id, p_caster, v_self -> 'per'));
    elsif v_self -> 'if' is not null then
      if public.resolve_count_amount(p_session_id, p_caster, v_self -> 'if')
         >= coalesce((v_self -> 'if' ->> 'at_least')::integer, 1)
      then
        v_reduction := v_reduction + coalesce((v_self ->> 'amount')::integer, 0);
      end if;
    else
      v_reduction := v_reduction + coalesce((v_self ->> 'amount')::integer, 0);
    end if;
  end if;

  -- The number of spells already cast by this player this turn — the spell being
  -- cast now is index (v_spells_cast + 1). Powers nth_spell reductions below.
  v_spells_cast := public.resolve_count_amount(
    p_session_id, p_caster, '{"count":"spells_cast_this_turn"}'::jsonb);

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
    )
    -- nth_spell (mig 369, Alisaie's Dualcast): "the SECOND spell you cast each turn
    -- costs {2} less" — apply only to exactly the Kth spell, i.e. when this player
    -- has already cast K-1 spells this turn.
    and (
      coalesce(ce.payload ->> 'nth_spell', '') = ''
      or v_spells_cast = (ce.payload ->> 'nth_spell')::integer - 1
    )
    -- color (mig 391, Sapphire Medallion): "BLUE spells you cast cost {1} less" —
    -- full-word color (white/blue/black/red/green) matched against the cast
    -- card's colors, derived from its mana cost (card_color_set, mig 131).
    and (
      coalesce(ce.payload ->> 'color', '') = ''
      or (ce.payload ->> 'color') = any(public.card_color_set(coalesce(v_mana_cost, '')))
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
