-- Per-deck target tuning.
--
-- The power score / needs engine uses classic Commander guidelines (37 lands,
-- 10 ramp, 10 draw, 8 removal, 3 wipes). Real decks deviate on purpose: a
-- low-curve deck runs fewer lands, a control deck wants more interaction.
-- target_overrides stores the player's per-deck adjustments as jsonb, e.g.
-- {"land": 34, "removal": 12, "counterspell": 6}. Only known tags with sane
-- values are accepted (sanitized in lib/collection/power-score.ts); NULL means
-- "use the guidelines". Needs, the upgrade scanner, the Advisor and the AI
-- Doctor all flow from these targets automatically.

alter table public.co_decks
  add column if not exists target_overrides jsonb;
