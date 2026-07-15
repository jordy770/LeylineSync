-- supabase/functions_src/card_has_creature_type.sql
-- CANONICAL current definition (introduced in 202605010409_changeling_anthems_costs.sql).
-- Whether a permanent effectively has creature type p_type — folding the
-- type-changing layer (mig 407 granted_type add/override, via
-- effective_type_line) AND changeling (mig 408: "is every creature type").
-- The reusable primitive for routing tribal type checks through the type layer;
-- used by the anthem P/T fold (card_layered_power/toughness) and the sacrifice
-- cost filter (activate_ability). fire_watcher_triggers keeps its own inline
-- match (it must stay adventure-face-aware for spell events).
--
-- Changeling only matches a CREATURE type: a stable negative list of card
-- types / supertypes / known noncreature subtypes keeps it catalog-independent
-- (the test catalog holds only fixtures) and prevents a changeling matching
-- 'artifact' / 'land' / 'vehicle' etc. (which the concrete match already handles).

create or replace function public.card_has_creature_type(
  p_session_id uuid, p_game_card_id uuid, p_type text
) returns boolean
language plpgsql stable security definer set search_path = public
as $$
begin
  if nullif(p_type, '') is null then
    return false;
  end if;

  -- Concrete: base type line + granted_type add/override.
  if public.effective_type_line(p_session_id, p_game_card_id) ilike '%' || p_type || '%' then
    return true;
  end if;

  -- A non-creature type is never granted by changeling.
  if lower(p_type) in (
       'artifact','creature','enchantment','land','planeswalker','instant','sorcery',
       'battle','tribal','kindred','basic','legendary','snow','world',
       'aura','equipment','vehicle','saga','shrine','curse','background','class','role',
       'food','treasure','clue','blood','gold','powerstone','map','incubator','adventure') then
    return false;
  end if;

  -- Changeling: is every creature type (granted_type {changeling} with its
  -- source fielded, or the catalog Changeling keyword).
  return exists (
    select 1 from public.game_continuous_effects ce
    join public.game_cards src on src.id = ce.source_card_id and src.session_id = ce.session_id
    where ce.session_id = p_session_id and ce.effect_type = 'granted_type'
      and ce.affected_card_id = p_game_card_id and src.zone = 'battlefield'
      and coalesce((ce.payload ->> 'changeling')::boolean, false))
    or exists (
      select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.id = p_game_card_id and gc.session_id = p_session_id
        and c.keywords::text ilike '%changeling%');
end;
$$;
grant execute on function public.card_has_creature_type(uuid, uuid, text) to anon, authenticated, service_role;
