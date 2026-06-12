-- supabase/functions_src/fire_zone_change_triggers.sql
-- CANONICAL current definition (seeded from 202605010201_creature_left_watcher.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

create or replace function public.fire_zone_change_triggers() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Enters the battlefield.
  if NEW.zone = 'battlefield'
    and (TG_OP = 'INSERT' or OLD.zone is distinct from 'battlefield')
  then
    -- "Creatures your opponents control enter tapped" (mig 258, Kinjalli's
    -- Sunwing): a battlefield source with a creatures_enter_tapped row taps
    -- every creature entering under another player's control. The is_tapped
    -- update re-fires this trigger with zone unchanged, so it skips this block.
    if exists (
      select 1
      from public.game_continuous_effects ce
      join public.game_cards src
        on src.id = ce.source_card_id and src.session_id = ce.session_id
      where ce.session_id = NEW.session_id
        and ce.effect_type = 'creatures_enter_tapped'
        and src.zone = 'battlefield'
        and coalesce(src.controller_player_id, src.owner_id)
            is distinct from coalesce(NEW.controller_player_id, NEW.owner_id)
    ) and exists (
      select 1 from public.cards c
      where c.id = NEW.card_id and c.type_line ilike '%creature%'
    ) then
      update public.game_cards
      set is_tapped = true
      where id = NEW.id and session_id = NEW.session_id and is_tapped = false;
    end if;

    perform public.fire_card_triggers(
      NEW.session_id, NEW.id,
      array['enters_the_battlefield', 'etb', 'enters']
    );
    perform public.fire_watcher_triggers(
      NEW.session_id, NEW.id,
      coalesce(NEW.controller_player_id, NEW.owner_id), 'creature_entered'
    );
    -- Landfall (mig 238, Nesting Dragon): "whenever a land you control enters."
    -- Fired for every entry; the watcher's type filter defaults to 'land' for
    -- this event, so only land entries actually match.
    perform public.fire_watcher_triggers(
      NEW.session_id, NEW.id,
      coalesce(NEW.controller_player_id, NEW.owner_id), 'land_entered'
    );
  end if;

  -- Dies (moves from the battlefield to the graveyard).
  if TG_OP = 'UPDATE'
    and OLD.zone = 'battlefield'
    and NEW.zone = 'graveyard'
  then
    perform public.fire_card_triggers(
      NEW.session_id, NEW.id,
      array['dies', 'death']
    );
    -- OLD.controller = the creature's controller while it was alive.
    perform public.fire_watcher_triggers(
      NEW.session_id, NEW.id,
      coalesce(OLD.controller_player_id, OLD.owner_id), 'creature_died'
    );
  end if;

  -- Leaves the battlefield (to any other zone, including graveyard/hand/exile).
  if TG_OP = 'UPDATE'
    and OLD.zone = 'battlefield'
    and NEW.zone is distinct from 'battlefield'
  then
    -- "For as long as ~ remains on the battlefield" steals (mig 246,
    -- Opportunistic Dragon): the thief leaving reverts control of everything
    -- it stole (and restores a blanked script).
    update public.game_cards gc
    set controller_player_id = nullif(ce.payload ->> 'original_controller', '')::uuid,
        copied_script = case when coalesce((ce.payload ->> 'lose_abilities')::boolean, false)
                             then null else gc.copied_script end
    from public.game_continuous_effects ce
    where ce.session_id = NEW.session_id
      and ce.effect_type = 'control'
      and coalesce((ce.payload ->> 'while_source')::boolean, false)
      and ce.source_card_id = NEW.id
      and ce.affected_card_id = gc.id
      and gc.session_id = NEW.session_id
      and gc.zone = 'battlefield'
      and nullif(ce.payload ->> 'original_controller', '') is not null;
    delete from public.game_continuous_effects ce
    where ce.session_id = NEW.session_id
      and ce.effect_type = 'control'
      and coalesce((ce.payload ->> 'while_source')::boolean, false)
      and ce.source_card_id = NEW.id;

    -- Exile-until-leaves returns (mig 262, Bronzebeak Foragers): everything
    -- this card exiled comes back to the battlefield under its owner.
    update public.game_cards gc
    set zone = 'battlefield', controller_player_id = gc.owner_id, is_tapped = false,
        damage_marked = 0, plus_one_counters = 0,
        entered_battlefield_turn_number = coalesce(
          (select ts.turn_number from public.game_turn_state ts
           where ts.session_id = NEW.session_id), 0),
        zone_position = (select coalesce(max(x.zone_position), -1) + 1
                         from public.game_cards x
                         where x.session_id = NEW.session_id
                           and x.owner_id = gc.owner_id and x.zone = 'battlefield')
    from public.game_continuous_effects ce
    where ce.session_id = NEW.session_id
      and ce.effect_type = 'exiled_until_leaves'
      and ce.source_card_id = NEW.id
      and ce.affected_card_id = gc.id
      and gc.session_id = NEW.session_id
      and gc.zone = 'exile';
    delete from public.game_continuous_effects ce
    where ce.session_id = NEW.session_id
      and ce.effect_type = 'exiled_until_leaves'
      and ce.source_card_id = NEW.id;

    perform public.fire_card_triggers(
      NEW.session_id, NEW.id,
      array['leaves_the_battlefield', 'ltb', 'leaves']
    );
    -- Watcher broadcast (mig 201): "whenever a creature you control leaves the
    -- battlefield" (Vela the Night-Clad). OLD.controller = controller while it
    -- was on the battlefield.
    perform public.fire_watcher_triggers(
      NEW.session_id, NEW.id,
      coalesce(OLD.controller_player_id, OLD.owner_id), 'creature_left'
    );
  end if;

  return null;
end;
$$;
