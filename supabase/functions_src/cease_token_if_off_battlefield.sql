-- supabase/functions_src/cease_token_if_off_battlefield.sql
-- CANONICAL current definition (seeded from the baseline; first edited in mig 239).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

-- A token that leaves the battlefield ceases to exist. Catalog tokens are
-- flagged on cards.is_token; COPY tokens (mig 239, create_copy_token) are
-- game-card-level tokens of a NONtoken catalog row, flagged on
-- game_cards.is_token — both cease. The trigger itself (on game_cards) already
-- exists; only the function body changes.
create or replace function public.cease_token_if_off_battlefield() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.zone is distinct from 'battlefield'
    and (coalesce(NEW.is_token, false)
         or exists (select 1 from public.cards where id = NEW.card_id and is_token = true))
  then
    delete from public.game_continuous_effects
    where session_id = NEW.session_id
      and source_card_id = NEW.id;

    delete from public.game_cards
    where id = NEW.id;
  end if;

  return null;
end;
$$;
