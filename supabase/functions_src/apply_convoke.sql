-- supabase/functions_src/apply_convoke.sql
-- CANONICAL current definition (new in 202605010432_convoke.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.
--
-- Convoke (CR 702.52): each creature tapped while casting pays for {1} or one
-- mana of that creature's colour. Validates the chosen creatures (distinct,
-- untapped, on the battlefield, controlled by the caster), TAPS them, and
-- returns p_cost with — per creature — one matching coloured pip removed when
-- the creature's colour matches one, else the generic reduced by one. Creature
-- colour derives from card_color_set(mana_cost); tokens without a mana cost
-- therefore pay generic only (documented approximation — the catalog has no
-- colours column). Raises when a creature cannot pay anything (over-convoke).
-- Runs inside the cast transaction: a later payment failure rolls the taps back.

create or replace function public.apply_convoke(
  p_session_id uuid,
  p_caster uuid,
  p_cost text,
  p_convoke_card_ids uuid[]
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := coalesce(array_length(p_convoke_card_ids, 1), 0);
  v_cost text := coalesce(p_cost, '');
  v_rec record;
  v_color text;
  v_letter text;
  v_paid boolean;
begin
  if v_count = 0 then
    return v_cost;
  end if;

  if (select count(distinct u) from unnest(p_convoke_card_ids) u) <> v_count
     or (select count(*)
         from public.game_cards gc
         join public.cards c on c.id = gc.card_id
         where gc.id = any(p_convoke_card_ids)
           and gc.session_id = p_session_id
           and gc.zone = 'battlefield'
           and coalesce(gc.controller_player_id, gc.owner_id) = p_caster
           and not gc.is_tapped
           and c.type_line ilike '%creature%') <> v_count then
    raise exception 'Convoke creatures must be distinct untapped creatures you control';
  end if;

  for v_rec in
    select gc.id, public.card_color_set(coalesce(c.mana_cost, '')) as colors
    from public.game_cards gc
    join public.cards c on c.id = gc.card_id
    where gc.id = any(p_convoke_card_ids) and gc.session_id = p_session_id
  loop
    v_paid := false;
    -- A matching coloured pip first (card_color_set yields full colour words).
    foreach v_color in array coalesce(v_rec.colors, array[]::text[])
    loop
      v_letter := case v_color
        when 'white' then 'W' when 'blue' then 'U' when 'black' then 'B'
        when 'red' then 'R' when 'green' then 'G' else null end;
      if v_letter is not null and position('{' || v_letter || '}' in v_cost) > 0 then
        -- regexp_replace without 'g' removes the first occurrence only.
        v_cost := regexp_replace(v_cost, '\{' || v_letter || '\}', '');
        v_paid := true;
        exit;
      end if;
    end loop;
    -- Otherwise {1} of the generic part.
    if not v_paid and coalesce(substring(v_cost from '\{(\d+)\}')::integer, 0) > 0 then
      v_cost := public.reduce_generic_cost(v_cost, 1);
      v_paid := true;
    end if;
    if not v_paid then
      raise exception 'Too many convoke creatures for this cost';
    end if;
  end loop;

  -- Tapping is part of the cast; a failed payment rolls this back with it.
  update public.game_cards
  set is_tapped = true
  where id = any(p_convoke_card_ids) and session_id = p_session_id;

  return v_cost;
end;
$$;
grant execute on function public.apply_convoke(uuid, uuid, text, uuid[]) to authenticated;
grant execute on function public.apply_convoke(uuid, uuid, text, uuid[]) to service_role;
