-- supabase/functions_src/apply_mass_pump_until_eot.sql
-- CANONICAL current definition (seeded from 202605010179_mass_typed_debuff.sql;
-- first edited in mig 243). Edit THIS file, then generate a migration with
-- scripts/new-migration.mjs — never re-extract from past migrations.

-- A TEMPORARY (until-EOT) mass P/T pump applied to every creature matching the
-- type filter. mig 243: power/toughness may be count-based amount objects
-- (Become the Avalanche: "+X/+X where X is the number of cards in your hand"),
-- resolved HERE at apply time against the pumping player; the inserted row
-- always carries plain integers, so the layered P/T fold is unchanged.
create or replace function public.apply_mass_pump_until_eot(
  p_session_id uuid,
  p_source_card_id uuid,
  p_controller_id uuid,
  p_effect jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_power integer;
  v_tough integer;
begin
  v_power := public.resolve_dynamic_amount(
    p_session_id, p_source_card_id, p_controller_id, p_effect -> 'power');
  if coalesce((p_effect -> 'power' ->> 'negate')::boolean, false) then
    v_power := -v_power;
  end if;
  v_tough := public.resolve_dynamic_amount(
    p_session_id, p_source_card_id, p_controller_id, p_effect -> 'toughness');
  if coalesce((p_effect -> 'toughness' ->> 'negate')::boolean, false) then
    v_tough := -v_tough;
  end if;

  -- scope 'controller' => only that player's creatures (affected_player_id set);
  -- 'all' (default) => every creature, any controller (affected_player_id null);
  -- 'opponent' (mig 395, Phyresis Outbreak: "creatures your opponents control
  -- get -1/-1…") => one 'pump' row PER OPPONENT, so the layered P/T fold
  -- (which matches on affected_player_id) needs no reader changes.
  if lower(coalesce(p_effect ->> 'scope', 'all')) = 'opponent' then
    insert into public.game_continuous_effects (
      session_id, source_card_id, affected_player_id, effect_type, payload,
      expires_at_phase, expires_at_step
    )
    select
      p_session_id, p_source_card_id, sp.player_id,
      'pump',
      jsonb_build_object(
        'power', coalesce(v_power, 0),
        'toughness', coalesce(v_tough, 0),
        'creature_type', p_effect ->> 'creature_type',
        'exclude_type', coalesce((p_effect ->> 'exclude_type')::boolean, false)
      ),
      'ending', 'cleanup'
    from public.game_session_players sp
    where sp.session_id = p_session_id
      and sp.player_id is distinct from p_controller_id;
  else
    insert into public.game_continuous_effects (
      session_id, source_card_id, affected_player_id, effect_type, payload,
      expires_at_phase, expires_at_step
    ) values (
      p_session_id, p_source_card_id,
      case when lower(coalesce(p_effect ->> 'scope', 'all')) = 'controller' then p_controller_id else null end,
      'pump',
      jsonb_build_object(
        'power', coalesce(v_power, 0),
        'toughness', coalesce(v_tough, 0),
        'creature_type', p_effect ->> 'creature_type',
        'exclude_type', coalesce((p_effect ->> 'exclude_type')::boolean, false)
      ),
      'ending', 'cleanup'
    );
  end if;
  -- A -X/-X can drop creatures to 0 toughness; the SBA reads effective toughness.
  perform public.move_lethal_damaged_creatures_to_graveyard(p_session_id);
end;
$$;
grant execute on function public.apply_mass_pump_until_eot(uuid, uuid, uuid, jsonb) to authenticated;
