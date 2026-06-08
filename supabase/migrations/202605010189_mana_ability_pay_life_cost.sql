-- `pay_life` as a mana-ability activation cost (Talisman of Dominance: "{T}, Pay 1
-- life: Add {U} or {B}", modelled as two single-colour {T}+pay-1 abilities since
-- only one taps per untap). The player must have at least that much life (CR 119.4).
--
-- Reproduced from migration 180 with: declare v_life_cost; a 'pay_life' cost
-- branch; and the life-payment block (validate + deduct) before tapping.

create or replace function public.activate_mana_ability(
  p_session_id uuid,
  p_source_card_id uuid,
  p_ability_index integer default 0,
  p_generic_payment jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_zone text;
  v_script jsonb;
  v_ability jsonb;
  v_cost jsonb;
  v_effect jsonb;
  v_has_tap boolean := false;
  v_mana_cost text := null;
  v_life_cost integer := 0;
  v_player_life integer;
  v_color text;
  v_amount integer;
  v_pool jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select game_cards.zone
  into v_zone
  from public.game_cards
  where game_cards.id = p_source_card_id
    and game_cards.session_id = p_session_id
    and game_cards.owner_id = auth.uid();
  if not found then
    raise exception 'Source card not found or not owned by current user';
  end if;
  if v_zone <> 'battlefield' then
    raise exception 'Mana ability source must be on the battlefield';
  end if;

  v_script := public.effective_script(p_session_id, p_source_card_id);
  v_ability := v_script -> 'activated_abilities' -> p_ability_index;
  if v_ability is null then
    raise exception 'Activated ability not found at index %', p_ability_index;
  end if;
  if not coalesce((v_ability ->> 'is_mana_ability')::boolean, false) then
    raise exception 'Not a mana ability';
  end if;

  -- Parse costs (tap_self / mana / pay_life).
  for v_cost in select * from jsonb_array_elements(coalesce(v_ability -> 'costs', '[]'::jsonb))
  loop
    case v_cost ->> 'type'
      when 'tap_self' then v_has_tap := true;
      when 'mana' then v_mana_cost := v_cost ->> 'amount';
      when 'pay_life' then v_life_cost := greatest(0, coalesce((v_cost ->> 'amount')::integer, 0));
      else raise exception 'Unsupported mana-ability cost: %', v_cost ->> 'type';
    end case;
  end loop;

  if v_has_tap and exists (
    select 1 from public.game_cards where id = p_source_card_id and is_tapped = true
  ) then
    raise exception 'Source is already tapped';
  end if;

  -- Life cost (CR 119.4): the player must have at least that much life to pay it.
  if v_life_cost > 0 then
    select life_total into v_player_life
    from public.game_session_players
    where session_id = p_session_id and player_id = auth.uid();
    if coalesce(v_player_life, 0) < v_life_cost then
      raise exception 'Not enough life to pay % life (have %)', v_life_cost, coalesce(v_player_life, 0);
    end if;
  end if;

  -- Pay the activation mana cost (the {1}) BEFORE producing.
  if v_mana_cost is not null and btrim(v_mana_cost) <> '' then
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_mana_cost, p_generic_payment);
  end if;

  -- Pay the life cost.
  if v_life_cost > 0 then
    update public.game_session_players
    set life_total = life_total - v_life_cost
    where session_id = p_session_id and player_id = auth.uid();
  end if;

  if v_has_tap then
    update public.game_cards
    set is_tapped = true
    where id = p_source_card_id and session_id = p_session_id;
  end if;

  -- Ensure a pool row exists, then add every add_mana effect's mana.
  insert into public.game_players (session_id, player_id, mana_pool)
  values (p_session_id, auth.uid(), jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0))
  on conflict (session_id, player_id) do nothing;

  select coalesce(mana_pool, jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0))
  into v_pool
  from public.game_players
  where session_id = p_session_id and player_id = auth.uid()
  for update;

  for v_effect in select * from jsonb_array_elements(coalesce(v_ability -> 'effects', '[]'::jsonb))
  loop
    if lower(coalesce(v_effect ->> 'type', '')) = 'add_mana' then
      v_color := upper(coalesce(v_effect ->> 'color', 'C'));
      if v_color not in ('W', 'U', 'B', 'R', 'G', 'C') then
        raise exception 'A multi-mana ability must produce fixed colours (got %)', v_color;
      end if;
      v_amount := greatest(1, coalesce((v_effect ->> 'amount')::integer, 1));
      v_pool := v_pool || jsonb_build_object(v_color, coalesce((v_pool ->> v_color)::integer, 0) + v_amount);
    end if;
  end loop;

  update public.game_players
  set mana_pool = v_pool
  where session_id = p_session_id and player_id = auth.uid();

  return v_pool;
end;
$$;

grant execute on function public.activate_mana_ability(uuid, uuid, integer, jsonb) to authenticated;
