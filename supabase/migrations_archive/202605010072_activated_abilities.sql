-- Non-mana activated abilities.
--
-- activate_ability pays the ability's costs (tap the source, pay mana) and then
-- puts its effect on the stack by reusing put_action_on_stack — so targeting and
-- resolution are shared with creature-targeting spells. The source stays on the
-- battlefield (it is not a spell), and the ability resolves when priority passes.
--
-- Scope: costs tap_self + mana; effect deal_damage (player or creature target).
-- Other cost/effect types raise a clear "unsupported" error for now.

create or replace function public.activate_ability(
  p_session_id uuid,
  p_source_card_id uuid,
  p_ability_index integer default 0,
  p_target_player_id uuid default null,
  p_target_card_id uuid default null,
  p_generic_payment jsonb default null
)
returns public.game_stack_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn public.game_turn_state;
  v_zone text;
  v_script jsonb;
  v_ability jsonb;
  v_cost jsonb;
  v_effect jsonb;
  v_has_tap boolean := false;
  v_mana_cost text := null;
  v_amount integer;
  v_stack public.game_stack_items;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select *
  into v_turn
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if coalesce(v_turn.priority_player_id, v_turn.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can activate abilities';
  end if;

  select game_cards.zone, coalesce(game_cards.copied_script, cards.script)
  into v_zone, v_script
  from public.game_cards
  join public.cards on cards.id = game_cards.card_id
  where game_cards.id = p_source_card_id
    and game_cards.session_id = p_session_id
    and game_cards.owner_id = auth.uid();

  if not found then
    raise exception 'Source card not found or not owned by current user';
  end if;

  if v_zone <> 'battlefield' then
    raise exception 'Ability source must be on the battlefield';
  end if;

  v_ability := v_script -> 'activated_abilities' -> p_ability_index;

  if v_ability is null then
    raise exception 'Activated ability not found at index %', p_ability_index;
  end if;

  if coalesce((v_ability ->> 'is_mana_ability')::boolean, false) then
    raise exception 'Use the mana ability flow for mana abilities';
  end if;

  -- Parse costs
  for v_cost in select * from jsonb_array_elements(coalesce(v_ability -> 'costs', '[]'::jsonb))
  loop
    case v_cost ->> 'type'
      when 'tap_self' then v_has_tap := true;
      when 'mana' then v_mana_cost := v_cost ->> 'amount';
      else raise exception 'Unsupported ability cost: %', v_cost ->> 'type';
    end case;
  end loop;

  -- Tap cost requires the source to be untapped
  if v_has_tap and exists (
    select 1 from public.game_cards where id = p_source_card_id and is_tapped = true
  ) then
    raise exception 'Source is already tapped';
  end if;

  -- Pay mana cost (raises if the player cannot pay)
  if v_mana_cost is not null then
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_mana_cost, p_generic_payment);
  end if;

  -- Pay the tap cost
  if v_has_tap then
    update public.game_cards
    set is_tapped = true
    where id = p_source_card_id and session_id = p_session_id;
  end if;

  -- Apply the (single) effect by putting it on the stack
  v_effect := v_ability -> 'effects' -> 0;

  if v_effect is null then
    raise exception 'Activated ability has no effect';
  end if;

  if v_effect ->> 'type' = 'deal_damage' then
    v_amount := coalesce((v_effect ->> 'amount')::integer, 0);
    if v_amount <= 0 then
      raise exception 'Invalid damage amount';
    end if;

    if p_target_card_id is not null then
      v_stack := public.put_action_on_stack(
        p_session_id,
        'deal_damage_creature',
        jsonb_build_object('target_card_id', p_target_card_id, 'amount', v_amount, 'timing', 'instant'),
        p_source_card_id
      );
    elsif p_target_player_id is not null then
      v_stack := public.put_action_on_stack(
        p_session_id,
        'deal_damage_player',
        jsonb_build_object('target_player_id', p_target_player_id, 'amount', v_amount, 'timing', 'instant'),
        p_source_card_id
      );
    else
      raise exception 'A target is required for this ability';
    end if;
  else
    raise exception 'Unsupported ability effect: %', v_effect ->> 'type';
  end if;

  return v_stack;
end;
$$;

-- Seed a test card with a non-mana activated ability: {T}: deal 1 damage to any target.
insert into public.cards (id, name, type_line, mana_cost, power_toughness, oracle_text, script)
select
  gen_random_uuid(),
  'Prodigal Sorcerer Test',
  'Creature - Human Wizard',
  '{2}{U}',
  '1/1',
  '{T}: Prodigal Sorcerer Test deals 1 damage to any target.',
  $json${
    "schema_version": 2,
    "activated_abilities": [
      {
        "label": "Deal 1 damage",
        "costs": [{ "type": "tap_self" }],
        "effects": [{ "type": "deal_damage", "amount": 1, "target_type": ["creature", "player"] }],
        "is_mana_ability": false,
        "timing": "instant"
      }
    ]
  }$json$::jsonb
where not exists (
  select 1 from public.cards where lower(name) = 'prodigal sorcerer test'
);

grant execute on function public.activate_ability(uuid, uuid, integer, uuid, uuid, jsonb) to authenticated;
