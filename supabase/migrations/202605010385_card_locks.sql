-- Card locks per deck.
--
-- {"locked": [oracle_id...], "excluded": [oracle_id...]}
--   locked   — pet cards: the scanner/Doctor may NEVER propose cutting these.
--   excluded — dismissed suggestions: never propose ADDING these to this deck.
-- Sanitized in lib/collection/deck-loader.ts; NULL = no locks. Enforced in the
-- upgrade scanner, buy suggestions and the AI Doctor's goal pool.

alter table public.co_decks
  add column if not exists card_locks jsonb;
