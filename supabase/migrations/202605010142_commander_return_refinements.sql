-- Commander (EDH) — return-to-command refinements.
--
-- Slice 1 (mig 136) auto-returned a commander to the command zone ONLY on death
-- (put_in_graveyard, the graveyard case). This generalises that to a single
-- chokepoint and adds owner agency:
--
--   * commander_redirect (per player, default true): "send my commander to the
--     command zone instead of letting it go to graveyard/exile/hand/library."
--   * A BEFORE UPDATE OF zone trigger on game_cards intercepts a COMMANDER leaving
--     the BATTLEFIELD to graveyard/exile/hand/library and (if the owner's preference
--     is on) rewrites the destination to the command zone. This one seam covers
--     EVERY mover — put_in_graveyard, exile/bounce (apply_creature_effect), combat
--     lethal, SBA, sacrifice, direct writes — with no per-mover reproduction. It also
--     fixes the slice-1 gaps: exile/bounce now return the commander (were lost), and
--     the redirect now honours the preference.
--   * The FALSE 'dies' trigger is suppressed correctly: fire_zone_change_triggers
--     (AFTER UPDATE) fires 'dies' only on battlefield->graveyard. Because this BEFORE
--     trigger rewrites NEW.zone to 'command' first, 'dies' does not fire on a
--     redirect — but DOES fire when the owner opts out (NEW.zone stays 'graveyard').
--   * put_in_graveyard loses its bespoke commander branch (reproduced from mig 136
--     as a plain graveyard move) so the trigger is the single source of truth.
--
-- DESIGN: owner agency is a STANDING preference, not a per-event pending decision —
-- a per-event choice would require turning the synchronous movers (called mid-combat
-- / mid-SBA) into async decision-parking. SCOPE: battlefield-source only (the 99%
-- case); a commander going to graveyard from the STACK (countered) or LIBRARY
-- (milled/drawn) is a later refinement (the draw case is genuinely a "may").
-- (IDE T-SQL false-positives on $$ bodies — ignore.)

-- ---------------------------------------------------------------------------
-- 1. The per-player redirect preference.
-- ---------------------------------------------------------------------------
alter table public.game_session_players
  add column if not exists commander_redirect boolean not null default true;

comment on column public.game_session_players.commander_redirect is
  'When true (default), this player''s commander returns to the command zone instead of going to graveyard/exile/hand/library from the battlefield (CR 903.9).';

create or replace function public.set_commander_redirect(p_session_id uuid, p_redirect boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  update public.game_session_players
  set commander_redirect = p_redirect
  where session_id = p_session_id and player_id = auth.uid();
end;
$$;

grant execute on function public.set_commander_redirect(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The redirect chokepoint: a BEFORE UPDATE OF zone trigger.
-- ---------------------------------------------------------------------------
create or replace function public.redirect_commander_zone_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_redirect boolean;
  v_next_position integer;
begin
  -- Only a COMMANDER leaving the BATTLEFIELD to a zone it can be pulled back from.
  if not (
    TG_OP = 'UPDATE'
    and OLD.zone = 'battlefield'
    and NEW.zone in ('graveyard', 'exile', 'hand', 'library')
    and NEW.is_commander
  ) then
    return NEW;
  end if;

  -- Honour the owner's standing preference (default true if no row).
  select commander_redirect into v_redirect
  from public.game_session_players
  where session_id = NEW.session_id and player_id = NEW.owner_id;

  if not coalesce(v_redirect, true) then
    return NEW; -- opt-out: let it go to the natural zone (dies/leaves fire normally)
  end if;

  -- Redirect to the owner's command zone (its own ordered zone per owner).
  select coalesce(max(zone_position), -1) + 1
  into v_next_position
  from public.game_cards
  where session_id = NEW.session_id
    and owner_id = NEW.owner_id
    and zone = 'command';

  NEW.zone := 'command';
  NEW.zone_position := v_next_position;
  NEW.controller_player_id := NEW.owner_id;
  NEW.is_tapped := false;
  NEW.damage_marked := 0;
  NEW.dealt_deathtouch_damage := false;
  NEW.plus_one_counters := 0;
  NEW.attached_to := null;
  return NEW;
end;
$$;

drop trigger if exists redirect_commander_zone_change on public.game_cards;
create trigger redirect_commander_zone_change
  before update of zone on public.game_cards
  for each row execute function public.redirect_commander_zone_change();

-- ---------------------------------------------------------------------------
-- 3. put_in_graveyard — drop the bespoke commander branch (mig 136); the trigger
-- now owns the redirect. Plain graveyard move, otherwise byte-identical.
-- ---------------------------------------------------------------------------
create or replace function public.put_in_graveyard(p_session_id uuid, p_game_card_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_next_position integer;
begin
  select owner_id
  into v_owner_id
  from public.game_cards
  where id = p_game_card_id
    and session_id = p_session_id
    and zone = 'battlefield';

  if not found then
    return false;
  end if;

  select coalesce(max(zone_position), -1) + 1
  into v_next_position
  from public.game_cards
  where session_id = p_session_id
    and owner_id = v_owner_id
    and zone = 'graveyard';

  -- The commander redirect (CR 903.9) is applied by the redirect_commander_zone_change
  -- trigger on this UPDATE, honouring the owner's preference.
  update public.game_cards
  set
    zone = 'graveyard',
    zone_position = v_next_position,
    controller_player_id = owner_id,
    is_tapped = false,
    damage_marked = 0,
    dealt_deathtouch_damage = false,
    plus_one_counters = 0
  where id = p_game_card_id;

  return true;
end;
$$;
