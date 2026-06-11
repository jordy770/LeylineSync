-- supabase/functions_src/revert_copy_before_leave.sql
-- CANONICAL current definition (new in mig 240, become-copy).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

-- A card that became a copy (become_copy, mig 240) reverts to its original
-- printed card the moment it leaves the battlefield — the graveyard/hand/exile
-- card is the original again. BEFORE UPDATE, so the AFTER triggers
-- (cease_token, fire_zone_change_triggers) see the reverted card: dies
-- triggers read the ORIGINAL's script, which is the correct rules behavior.
-- Every continuous-effect row the card sources is dropped (the except-keyword
-- grants must not survive a later reanimation).
create or replace function public.revert_copy_before_leave() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if OLD.zone = 'battlefield'
    and NEW.zone is distinct from 'battlefield'
    and OLD.copy_original_card_id is not null
  then
    delete from public.game_continuous_effects
    where session_id = OLD.session_id
      and source_card_id = OLD.id;

    NEW.card_id := OLD.copy_original_card_id;
    NEW.copied_script := null;
    NEW.copy_original_card_id := null;
    NEW.copy_revert_at_turn := null;
  end if;

  return NEW;
end;
$$;
