-- `nonland_permanent` as a TRIGGER target type (Oblivion Ring, Grasp of Fate).
--
-- Mig 150 taught the SPELL path the `nonland_permanent`/`nonland` token
-- (card_type_line_matches_target), but the trigger-target gate
-- behavior_target_type_is_permanent_only (mig 114) still rejected it, so an
-- "exile target nonland permanent" ETB trigger raised "Stack item does not
-- require a trigger target". Reproduced from mig 114 with the token added; the
-- downstream picker validates candidates via card_type_line_matches_target,
-- which already understands it.

create or replace function public.behavior_target_type_is_permanent_only(p_target_type jsonb)
returns boolean language sql immutable as $$
  select case
    when p_target_type is null then false
    else (
      jsonb_array_length(
        case when jsonb_typeof(p_target_type) = 'array' then p_target_type
             else jsonb_build_array(trim(both '"' from p_target_type::text)) end
      ) > 0
      and not exists (
        select 1
        from jsonb_array_elements_text(
          case when jsonb_typeof(p_target_type) = 'array' then p_target_type
               else jsonb_build_array(trim(both '"' from p_target_type::text)) end
        ) as t(value)
        where lower(t.value) not in
          ('artifact', 'enchantment', 'land', 'planeswalker', 'battle', 'permanent', 'creature',
           'nonland_permanent', 'nonland')
      )
    )
  end;
$$;
