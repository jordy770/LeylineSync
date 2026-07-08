-- Upgrade-scan cache (Collection Optimizer UX).
--
-- The dashboard wants to show "N upgrades ready" per deck without running the
-- (expensive) upgrade scanner for every deck on every page load. The scanner
-- already runs whenever a deck-detail page is opened; these columns let that
-- run leave its headline counts behind on the existing per-deck analysis row.
--
-- free_upgrades / occupied_upgrades: NULL = never scanned (dashboard shows
-- nothing) — 0 means "scanned, nothing found". scanned_at lets a collection
-- re-import invalidate the counts (set back to NULL) since new cards change
-- what every deck could gain.
--
-- RLS: co_deck_analyses is already owner-scoped via its deck (mig 364); new
-- columns inherit that.

alter table public.co_deck_analyses
  add column if not exists free_upgrades     int,
  add column if not exists occupied_upgrades int,
  add column if not exists scanned_at        timestamptz;
