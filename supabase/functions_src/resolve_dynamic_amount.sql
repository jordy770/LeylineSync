-- supabase/functions_src/resolve_dynamic_amount.sql
-- CANONICAL current definition (seeded from 202605010166_count_dynamic_amounts.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

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
    -- The source rides along for exclude_self counts (mig 257).
    if p_amount ? 'count' then
      return public.resolve_count_amount(p_session_id, p_controller_id, p_amount, p_source_card_id);
    end if;

    -- Power of a permanent ("damage equal to Eshki's power"). of: source | target.
    if p_amount ? 'power_of' then
      v_of := lower(coalesce(p_amount ->> 'power_of', 'source'));
      v_card := case when v_of = 'target' then p_target_card_id else p_source_card_id end;
      return greatest(0, coalesce(public.card_effective_power(p_session_id, v_card), 0));
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
