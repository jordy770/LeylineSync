-- supabase/functions_src/apply_damage_to_player.sql
-- CANONICAL (mig 283): seeded from 202605010137_commander_format_and_damage.sql
-- (the newest definition in supabase/migrations — verified per bug-682).

create or replace function public.apply_damage_to_player(
  p_session_id uuid,
  p_player_id uuid,
  p_amount integer,
  p_source_card_id uuid default null,
  p_is_combat boolean default false
) returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_remaining integer := greatest(0, coalesce(p_amount, 0));
  v_turn integer;
  v_shield record;
  v_prevent integer;
  v_cmd_total integer;
  v_mod integer;
begin
  if v_remaining <= 0 then
    return 0;
  end if;

  select turn_number into v_turn
  from public.game_turn_state where session_id = p_session_id;

  -- Damage-modifying statics (mig 438, Gisela, Blade of Goldnight), applied
  -- before the prevention shields: first every active "double damage to
  -- opponents" whose controller sees the damaged player as an opponent, then
  -- every "prevent half, rounded up" protecting the damaged player.
  for v_mod in
    select 1 from public.game_continuous_effects ce
    join public.game_cards src on src.id = ce.source_card_id and src.session_id = ce.session_id
    where ce.session_id = p_session_id
      and ce.effect_type = 'damage_double_to_opponents'
      and src.zone = 'battlefield'
      and ce.affected_player_id is not null
      and ce.affected_player_id is distinct from p_player_id
  loop
    v_remaining := v_remaining * 2;
  end loop;
  for v_mod in
    select 1 from public.game_continuous_effects ce
    join public.game_cards src on src.id = ce.source_card_id and src.session_id = ce.session_id
    where ce.session_id = p_session_id
      and ce.effect_type = 'damage_prevent_half'
      and src.zone = 'battlefield'
      and ce.affected_player_id = p_player_id
  loop
    v_remaining := v_remaining - ((v_remaining + 1) / 2);
  end loop;
  if v_remaining <= 0 then
    return 0;
  end if;

  for v_shield in
    select * from public.game_damage_prevention
    where session_id = p_session_id
      and affected_player_id = p_player_id
      and (combat_only = false or p_is_combat = true)
      and (expires_turn is null or expires_turn >= coalesce(v_turn, 0))
    order by created_at asc, id asc
    for update
  loop
    exit when v_remaining <= 0;

    if v_shield.amount is null then
      -- Prevent-all shield: stops everything and persists for the turn.
      v_remaining := 0;
    else
      v_prevent := least(v_remaining, v_shield.amount);
      v_remaining := v_remaining - v_prevent;
      if v_shield.amount - v_prevent <= 0 then
        delete from public.game_damage_prevention where id = v_shield.id;
      else
        update public.game_damage_prevention
        set amount = amount - v_prevent
        where id = v_shield.id;
      end if;
    end if;
  end loop;

  if v_remaining > 0 then
    update public.game_session_players
    set life_total = greatest(0, life_total - v_remaining)
    where session_id = p_session_id
      and player_id = p_player_id;
  end if;

  -- Commander damage: combat damage from a commander accumulates per (defender,
  -- commander); 21 cumulative from one commander loses the game for that player.
  if p_is_combat
    and v_remaining > 0
    and p_source_card_id is not null
    and exists (
      select 1 from public.game_cards
      where id = p_source_card_id
        and session_id = p_session_id
        and is_commander = true
    )
  then
    insert into public.game_commander_damage (session_id, defender_player_id, source_card_id, damage)
    values (p_session_id, p_player_id, p_source_card_id, v_remaining)
    on conflict (session_id, defender_player_id, source_card_id)
    do update set damage = public.game_commander_damage.damage + excluded.damage
    returning damage into v_cmd_total;

    if v_cmd_total >= 21 then
      update public.game_session_players
      set life_total = 0
      where session_id = p_session_id
        and player_id = p_player_id;
    end if;
  end if;

  -- Lifelink (mig 283): the damage source's controller gains that much life.
  if v_remaining > 0 and p_source_card_id is not null
     and public.card_has_lifelink(p_session_id, p_source_card_id) then
    update public.game_session_players
    set life_total = life_total + v_remaining
    where session_id = p_session_id
      and player_id = (select coalesce(gc.controller_player_id, gc.owner_id)
                       from public.game_cards gc
                       where gc.id = p_source_card_id and gc.session_id = p_session_id);
    perform public.fire_lifegain_triggers(p_session_id,
      (select coalesce(gc.controller_player_id, gc.owner_id) from public.game_cards gc
       where gc.id = p_source_card_id and gc.session_id = p_session_id),
      v_remaining);
  end if;

  return v_remaining;
end;
$$;
grant execute on function public.apply_damage_to_player(uuid, uuid, integer, uuid, boolean) to authenticated;
grant execute on function public.apply_damage_to_player(uuid, uuid, integer, uuid, boolean) to service_role;
