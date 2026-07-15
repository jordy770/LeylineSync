-- supabase/functions_src/effective_script.sql
-- CANONICAL current definition (seeded from 00_baseline.sql; canonicalised in
-- 202605010357_granted_ability.sql to merge granted abilities).
--
-- A card's behaviour script: copied_script (a copy/baked override) if present,
-- else the catalog script. PLUS any granted_ability continuous effects on the
-- card (Splinter Twin / Blade of Selves / Mirage Phalanx) — their payload.ability
-- is appended to activated_abilities (kind:'activated') or triggered_abilities
-- (kind:'triggered'), so fire_card_triggers / activate_ability see the grant.

create or replace function public.effective_script(p_session_id uuid, p_game_card_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_script jsonb;
  v_granted record;
  v_ability jsonb;
begin
  select coalesce(game_cards.copied_script, cards.script)
  into v_script
  from public.game_cards
  join public.cards on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id;

  -- Ability strip (mig 410, Imprisoned in the Moon): a granted_type carrying
  -- strip_abilities blanks the enchanted permanent's OWN abilities — it keeps
  -- only what other effects grant it (Imprisoned's "{T}: Add {C}"). Applied
  -- before the granted-ability merge so the grant survives.
  if exists (
    select 1 from public.game_continuous_effects ce
    join public.game_cards src on src.id = ce.source_card_id and src.session_id = ce.session_id
    where ce.session_id = p_session_id and ce.effect_type = 'granted_type'
      and ce.affected_card_id = p_game_card_id and src.zone = 'battlefield'
      and coalesce((ce.payload ->> 'strip_abilities')::boolean, false)) then
    v_script := '{"schema_version":2}'::jsonb;
  end if;

  -- Merge granted abilities (one continuous-effect row per grant).
  if exists (select 1 from public.game_continuous_effects
             where session_id = p_session_id and effect_type = 'granted_ability'
               and affected_card_id = p_game_card_id) then
    -- Guard against scalar catalog scripts: token rows may carry jsonb 'null'
    -- (not SQL null — coalesce passes it), and jsonb_set on a scalar raises
    -- "cannot set path in scalar" (bug-2687: job_select's Hero token receiving
    -- Astrologian's Planisphere's granted trigger).
    if v_script is null or jsonb_typeof(v_script) <> 'object' then
      v_script := '{"schema_version":2}'::jsonb;
    end if;
    for v_granted in
      select payload from public.game_continuous_effects
      where session_id = p_session_id and effect_type = 'granted_ability'
        and affected_card_id = p_game_card_id
      order by id
    loop
      v_ability := v_granted.payload -> 'ability';
      if v_ability is null then continue; end if;
      if lower(coalesce(v_granted.payload ->> 'kind', 'triggered')) = 'activated' then
        v_script := jsonb_set(v_script, '{activated_abilities}',
          coalesce(v_script -> 'activated_abilities', '[]'::jsonb) || jsonb_build_array(v_ability));
      else
        v_script := jsonb_set(v_script, '{triggered_abilities}',
          coalesce(v_script -> 'triggered_abilities', '[]'::jsonb) || jsonb_build_array(v_ability));
      end if;
    end loop;
  end if;

  return v_script;
end;
$$;
grant execute on function public.effective_script(uuid, uuid) to anon, authenticated, service_role;
