-- supabase/functions_src/effective_type_line.sql
-- CANONICAL current definition (introduced in 202605010407_type_changing_layer.sql).
-- A permanent's EFFECTIVE type line: its catalog/copied type plus any
-- 'granted_type' continuous effects on it (the type-changing layer). Two forms:
--   payload.override = 'Land'            → the permanent BECOMES that type,
--                                          losing its other types (Imprisoned
--                                          in the Moon: "is a colorless land").
--   payload.add      = 'Island'          → the type is ADDED (Multiversal
--                                          Passage's chosen basic type; Reaper's
--                                          Scythe's "is an Assassin").
-- Overrides win over adds; multiple adds accumulate. Only rows whose source is
-- on the battlefield apply. Callers that match types (fire_watcher_triggers,
-- and later the sac-cost / anthem filters) read THIS instead of the raw
-- cards.type_line so granted types are visible.

create or replace function public.effective_type_line(p_session_id uuid, p_game_card_id uuid)
returns text
language plpgsql stable security definer set search_path = public
as $$
declare
  v_base text;
  v_override text;
  v_added text := '';
  v_add text;
begin
  select c.type_line into v_base
  from public.game_cards gc join public.cards c on c.id = gc.card_id
  where gc.id = p_game_card_id and gc.session_id = p_session_id;

  if v_base is null then
    return null;
  end if;

  -- Full override (last one wins) — the permanent becomes exactly that type.
  select ce.payload ->> 'override' into v_override
  from public.game_continuous_effects ce
  join public.game_cards src on src.id = ce.source_card_id and src.session_id = ce.session_id
  where ce.session_id = p_session_id
    and ce.effect_type = 'granted_type'
    and ce.affected_card_id = p_game_card_id
    and src.zone = 'battlefield'
    and nullif(ce.payload ->> 'override', '') is not null
  order by ce.id desc
  limit 1;

  if v_override is not null then
    v_base := v_override;
  end if;

  -- Added types: appended (deduped by a case-insensitive substring check).
  for v_add in
    select ce.payload ->> 'add'
    from public.game_continuous_effects ce
    join public.game_cards src on src.id = ce.source_card_id and src.session_id = ce.session_id
    where ce.session_id = p_session_id
      and ce.effect_type = 'granted_type'
      and ce.affected_card_id = p_game_card_id
      and src.zone = 'battlefield'
      and nullif(ce.payload ->> 'add', '') is not null
    order by ce.id
  loop
    if v_base !~* ('\m' || v_add || '\M') then
      v_added := v_added || ' ' || v_add;
    end if;
  end loop;

  return v_base || v_added;
end;
$$;
grant execute on function public.effective_type_line(uuid, uuid) to anon, authenticated, service_role;
