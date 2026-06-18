-- supabase/functions_src/activate_mana_ability.sql
-- CANONICAL current definition (seeded from 202605010189_mana_ability_pay_life_cost.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

create or replace function public.activate_mana_ability(
  p_session_id uuid,
  p_source_card_id uuid,
  p_ability_index integer default 0,
  p_generic_payment jsonb default null,
  -- The colour chosen for an "any colour" producer (Treasure, mig 226).
  p_chosen_color text default null
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
  v_has_sac boolean := false;
  v_mana_cost text := null;
  v_life_cost integer := 0;
  v_player_life integer;
  v_color text;
  v_amount integer;
  v_pool jsonb;
  -- Restricted ("spend only") mana: an add_mana effect may carry a `restriction`
  -- ({spell_type_line?, ability_source_type_line?, commander?}); such mana goes
  -- to game_players.restricted_mana instead of the open pool.
  v_restricted jsonb;
  v_restriction jsonb;
  v_produced_restricted boolean := false;
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
      when 'sacrifice_self' then v_has_sac := true;
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

  select coalesce(mana_pool, jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0)),
         coalesce(restricted_mana, '[]'::jsonb)
  into v_pool, v_restricted
  from public.game_players
  where session_id = p_session_id and player_id = auth.uid()
  for update;

  for v_effect in select * from jsonb_array_elements(coalesce(v_ability -> 'effects', '[]'::jsonb))
  loop
    if lower(coalesce(v_effect ->> 'type', '')) = 'add_mana' then
      v_color := upper(coalesce(v_effect ->> 'color', 'C'));
      -- "Any colour" (Treasure, mig 226): the caller picks the colour.
      if v_color = 'ANY' then
        v_color := upper(coalesce(p_chosen_color, ''));
        if v_color not in ('W', 'U', 'B', 'R', 'G', 'C') then
          raise exception 'Choose a colour for this mana ability';
        end if;
      elsif v_color not in ('W', 'U', 'B', 'R', 'G', 'C') then
        raise exception 'A multi-mana ability must produce fixed colours (got %)', v_color;
      end if;
      v_amount := greatest(1, coalesce((v_effect ->> 'amount')::integer, 1));
      v_restriction := v_effect -> 'restriction';
      if v_restriction is not null and jsonb_typeof(v_restriction) = 'object' then
        -- "Spend only to cast …": stash as restricted mana, not open mana.
        v_produced_restricted := true;
        v_restricted := v_restricted || jsonb_build_array(
          jsonb_build_object('color', v_color, 'amount', v_amount) || v_restriction);
      else
        v_pool := v_pool || jsonb_build_object(v_color, coalesce((v_pool ->> v_color)::integer, 0) + v_amount);
      end if;
    end if;
  end loop;

  -- Monarch land bonus (mig 262, Regal Behemoth: "whenever you tap a land for
  -- mana while you're the monarch, add an additional one mana of any color").
  -- Approximations: the bonus is one mana of the colour this ability just
  -- produced (no separate colour pick), once per activation.
  if v_color is not null
     and v_has_tap
     and not v_produced_restricted
     and exists (select 1 from public.game_turn_state ts
                 where ts.session_id = p_session_id and ts.monarch_player_id = auth.uid())
     and exists (select 1 from public.game_cards gc join public.cards c on c.id = gc.card_id
                 where gc.id = p_source_card_id and gc.session_id = p_session_id
                   and c.type_line ilike '%land%')
     and exists (select 1 from public.game_cards gc
                 where gc.session_id = p_session_id and gc.zone = 'battlefield'
                   and coalesce(gc.controller_player_id, gc.owner_id) = auth.uid()
                   and coalesce((public.effective_script(p_session_id, gc.id) ->> 'monarch_land_bonus')::boolean, false))
  then
    v_pool := v_pool || jsonb_build_object(v_color, coalesce((v_pool ->> v_color)::integer, 0) + 1);
  end if;

  update public.game_players
  set mana_pool = v_pool,
      restricted_mana = v_restricted
  where session_id = p_session_id and player_id = auth.uid();

  -- Sacrifice cost (mig 226, Treasure): the source goes to the graveyard after
  -- producing — a token then ceases to exist via the usual cleanup trigger.
  if v_has_sac then
    perform public.put_in_graveyard(p_session_id, p_source_card_id);
  end if;

  return v_pool;
end;
$$;
grant execute on function public.activate_mana_ability(uuid, uuid, integer, jsonb, text) to authenticated;
