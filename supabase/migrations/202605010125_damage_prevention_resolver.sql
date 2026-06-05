-- Phase 4 / F2.1a — DAMAGE PREVENTION: the first replacement-effect resolver.
--
-- The frontier's design (cerebrum 2026-06-05): build the hard replacement logic as
-- ONE isolated, well-tested resolver rather than scattering it across call sites.
-- This slice establishes that resolver for player damage and wires it into the
-- canonical targeted-damage chokepoint (handle_deal_damage_player). Authoring the
-- `prevent_damage` card effect (which calls add_damage_prevention) is F2.1b; the
-- creature-damage + combat chokepoints are later slices.
--
-- A prevention "shield" consumes damage before it reaches a player. amount null =
-- prevent ALL (a Fog-style shield, persists for the turn); combat_only restricts
-- it to combat damage. Shields are per-turn (expires_turn); the resolver ignores
-- expired ones (cleanup can come with the combat slice). Damage != life loss —
-- only DAMAGE routes through here, so lose_life stays unpreventable.

-- ---------------------------------------------------------------------------
-- Shield store. affected_card_id is reserved for the future creature-damage
-- resolver; this slice only sets affected_player_id.
-- ---------------------------------------------------------------------------
create table if not exists public.game_damage_prevention (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions(id) on delete cascade,
  affected_player_id uuid,
  affected_card_id uuid,
  amount integer,                                   -- remaining to prevent; null = all
  combat_only boolean not null default false,
  expires_turn integer,                             -- inert once turn_number > this
  source_card_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists game_damage_prevention_player_idx
  on public.game_damage_prevention (session_id, affected_player_id);

alter table public.game_damage_prevention enable row level security;

-- Server-managed: only SECURITY DEFINER functions write; session players may read.
drop policy if exists "session players read damage prevention" on public.game_damage_prevention;
create policy "session players read damage prevention"
  on public.game_damage_prevention
  for select
  using (public.is_session_player(session_id, auth.uid()));

grant select on public.game_damage_prevention to authenticated;
grant select on public.game_damage_prevention to service_role;

-- ---------------------------------------------------------------------------
-- add_damage_prevention — create a shield protecting a player. Called by the
-- (future) prevent_damage card effect and by tests. p_amount null = prevent all.
-- ---------------------------------------------------------------------------
create or replace function public.add_damage_prevention(
  p_session_id uuid,
  p_player_id uuid,
  p_amount integer default null,
  p_combat_only boolean default false,
  p_source_card_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_turn integer;
  v_id uuid;
begin
  select turn_number into v_turn
  from public.game_turn_state where session_id = p_session_id;

  insert into public.game_damage_prevention (
    session_id, affected_player_id, amount, combat_only, expires_turn, source_card_id
  )
  values (
    p_session_id, p_player_id,
    case when p_amount is null then null else greatest(0, p_amount) end,
    coalesce(p_combat_only, false), v_turn, p_source_card_id
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.add_damage_prevention(uuid, uuid, integer, boolean, uuid) from public;
grant execute on function public.add_damage_prevention(uuid, uuid, integer, boolean, uuid) to authenticated;
grant execute on function public.add_damage_prevention(uuid, uuid, integer, boolean, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- apply_damage_to_player — THE RESOLVER. Consume applicable prevention shields
-- (oldest first), then deal the remaining damage to the player's life. Returns
-- the damage actually dealt. is_combat lets combat_only shields apply.
-- ---------------------------------------------------------------------------
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
begin
  if v_remaining <= 0 then
    return 0;
  end if;

  select turn_number into v_turn
  from public.game_turn_state where session_id = p_session_id;

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

  return v_remaining;
end;
$$;

revoke all on function public.apply_damage_to_player(uuid, uuid, integer, uuid, boolean) from public;
grant execute on function public.apply_damage_to_player(uuid, uuid, integer, uuid, boolean) to authenticated;
grant execute on function public.apply_damage_to_player(uuid, uuid, integer, uuid, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- handle_deal_damage_player — route the targeted player-damage path through the
-- resolver. Verbatim from mig 104 except the life update becomes a resolver call
-- (the existence guard is preserved).
-- ---------------------------------------------------------------------------
create or replace function public.handle_deal_damage_player(
  p_session_id uuid,
  p_stack_item public.game_stack_items
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_player_id uuid;
  v_amount integer;
begin
  v_target_player_id := nullif(p_stack_item.payload ->> 'target_player_id', '')::uuid;
  v_amount := coalesce((p_stack_item.payload ->> 'amount')::integer, 0);

  if v_target_player_id is null or v_amount <= 0 then
    raise exception 'Invalid deal_damage_player payload';
  end if;

  perform 1
  from public.game_session_players
  where session_id = p_session_id
    and player_id = v_target_player_id;

  if not found then
    raise exception 'Target player not found';
  end if;

  perform public.apply_damage_to_player(
    p_session_id, v_target_player_id, v_amount, p_stack_item.source_card_id, false
  );

  return null;
end;
$$;

revoke all on function public.handle_deal_damage_player(uuid, public.game_stack_items) from public;
