-- Count-based dynamic amounts (roadmap Tribal #2). "X = number of creatures you
-- control / creatures in your graveyard / your devotion to black."
--
-- Extends resolve_dynamic_amount (mig 162) with a `{ "count": <source>, … }` amount
-- shape alongside the existing `{ "counters": … }` shape. Counts are relative to the
-- amount's CONTROLLER (the spell/ability's controller):
--   { "count": "creatures_you_control", "type_line"?: "Zombie" }  — battlefield creatures
--       you control (optionally one subtype). Distant Melody / Loyal Subordinate.
--   { "count": "cards_in_graveyard",   "type_line"?: "creature" } — cards you own in your
--       graveyard (optionally filtered). Lotleth Giant.
--   { "count": "lands_you_control" }                              — your battlefield lands.
--   { "count": "devotion", "color": "B" }                         — black mana symbols in
--       the mana costs of permanents you control (Gray Merchant of Asphodel). Counts
--       "{B}" pips; hybrid/Phyrexian pips are NOT counted (rare — documented gap).
--
-- Works everywhere resolve_dynamic_amount is called (triggers, activated abilities,
-- targeted spells). Reproduced from CURRENT (grep-first): resolve_dynamic_amount (162),
-- same 5-arg signature (no DROP needed). (IDE T-SQL false-positives on $$ bodies.)

-- ===========================================================================
-- resolve_count_amount — a `{ count, … }` spec → an integer, relative to the controller.
-- ===========================================================================
create or replace function public.resolve_count_amount(
  p_session_id uuid,
  p_controller_id uuid,
  p_spec jsonb
) returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_count text := lower(coalesce(p_spec ->> 'count', ''));
  v_type text := p_spec ->> 'type_line';
  v_color text := upper(coalesce(p_spec ->> 'color', ''));
  v_n integer := 0;
begin
  if v_count = 'creatures_you_control' then
    select count(*)::integer into v_n
    from public.game_cards g
    join public.cards c on c.id = g.card_id
    where g.session_id = p_session_id
      and coalesce(g.controller_player_id, g.owner_id) = p_controller_id
      and g.zone = 'battlefield'
      and c.type_line ilike '%creature%'
      and (v_type is null or c.type_line ilike '%' || v_type || '%');

  elsif v_count = 'lands_you_control' then
    select count(*)::integer into v_n
    from public.game_cards g
    join public.cards c on c.id = g.card_id
    where g.session_id = p_session_id
      and coalesce(g.controller_player_id, g.owner_id) = p_controller_id
      and g.zone = 'battlefield'
      and c.type_line ilike '%land%';

  elsif v_count = 'cards_in_graveyard' then
    select count(*)::integer into v_n
    from public.game_cards g
    join public.cards c on c.id = g.card_id
    where g.session_id = p_session_id
      and g.owner_id = p_controller_id
      and g.zone = 'graveyard'
      and (v_type is null or c.type_line ilike '%' || v_type || '%');

  elsif v_count = 'devotion' and v_color <> '' then
    -- Count "{<color>}" pips in the mana costs of permanents you control. Each pip is
    -- 3 chars ("{B}"), so occurrences = (len - len without the pip) / 3.
    select coalesce(sum(
      (length(c.mana_cost) - length(replace(c.mana_cost, '{' || v_color || '}', ''))) / 3
    ), 0)::integer into v_n
    from public.game_cards g
    join public.cards c on c.id = g.card_id
    where g.session_id = p_session_id
      and coalesce(g.controller_player_id, g.owner_id) = p_controller_id
      and g.zone = 'battlefield'
      and c.mana_cost is not null;
  end if;

  return greatest(0, coalesce(v_n, 0));
end;
$$;
grant execute on function public.resolve_count_amount(uuid, uuid, jsonb) to authenticated;
grant execute on function public.resolve_count_amount(uuid, uuid, jsonb) to service_role;

-- ===========================================================================
-- resolve_dynamic_amount (CURRENT = mig 162) — a `{ count }` object delegates to
-- resolve_count_amount; the `{ counters }` object is unchanged. Same 5-arg signature.
-- ===========================================================================
create or replace function public.resolve_dynamic_amount(
  p_session_id uuid,
  p_source_card_id uuid,
  p_controller_id uuid,
  p_amount jsonb,
  p_target_card_id uuid default null
) returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_txt text;
  v_kind text;
  v_of text;
  v_card uuid;
  v_count integer := 0;
begin
  if p_amount is null then
    return 0;
  end if;

  if jsonb_typeof(p_amount) in ('number', 'string') then
    v_txt := p_amount #>> '{}';
    if v_txt = 'X' then
      return 0; -- triggered/source effects have no chosen X
    end if;
    -- NO clamp: a NEGATIVE literal removes counters (mig 155 removal path).
    return coalesce(floor(v_txt::numeric)::integer, 0);
  end if;

  if jsonb_typeof(p_amount) = 'object' then
    -- Count-based amount ("number of creatures you control", devotion, …).
    if p_amount ? 'count' then
      return public.resolve_count_amount(p_session_id, p_controller_id, p_amount);
    end if;

    v_kind := lower(coalesce(p_amount ->> 'counters', ''));
    v_of := lower(coalesce(p_amount ->> 'of', 'self'));

    if v_of in ('you', 'your', 'controller') then
      select coalesce((counters ->> v_kind)::integer, 0)
      into v_count
      from public.game_session_players
      where session_id = p_session_id and player_id = p_controller_id;

      return greatest(0, coalesce(v_count, 0));
    end if;

    -- self / source / this → the source permanent; target → the targeted permanent.
    if v_of = 'target' then
      v_card := p_target_card_id;
    else
      v_card := p_source_card_id;
    end if;

    if public.is_plus_one_counter(v_kind) then
      select coalesce(plus_one_counters, 0)
      into v_count
      from public.game_cards
      where id = v_card and session_id = p_session_id;
    else
      select coalesce((counters ->> v_kind)::integer, 0)
      into v_count
      from public.game_cards
      where id = v_card and session_id = p_session_id;
    end if;

    return greatest(0, coalesce(v_count, 0));
  end if;

  return 0;
end;
$$;
grant execute on function public.resolve_dynamic_amount(uuid, uuid, uuid, jsonb, uuid) to authenticated;
grant execute on function public.resolve_dynamic_amount(uuid, uuid, uuid, jsonb, uuid) to service_role;
