-- Collection value history (Collection Optimizer UX).
--
-- A collection import replaces the snapshot, so historical quantities are gone
-- afterwards — remember what the WHOLE snapshot was worth (EUR, Scryfall/
-- Cardmarket prices at import time) on the import row itself. The dashboard
-- plots these points as the collection's value over time; rows imported before
-- this migration stay NULL (no fake history).

alter table public.co_imports
  add column if not exists snapshot_value_eur numeric;
