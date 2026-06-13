-- Hot-path indexes (perf, no behavior change).
--
-- game_continuous_effects: the 12 card_has_<keyword> accessors + the P/T folds
-- run on every targeting/blocking/combat check and filter by
--   (session_id, effect_type, affected_card_id | affected_player_id).
-- The only existing index is (session_id, effect_type); add affected_card_id as
-- a third column so per-card lookups become index(-only) scans. The mass-branch
-- rows (affected_card_id IS NULL) stay clustered together under the same
-- prefix, which also helps the OR arm.
--
-- game_cards: battlefield scans by controller — typed-lord folds, watcher
-- broadcasts, tap_creatures/sacrifice cost picks, destroy_all_creatures — all
-- filter (session_id, zone[, controller_player_id]). The existing
-- library-draw index leads with owner_id, which doesn't serve these.

create index if not exists game_continuous_effects_session_type_card_idx
  on public.game_continuous_effects (session_id, effect_type, affected_card_id);

create index if not exists game_cards_session_zone_controller_idx
  on public.game_cards (session_id, zone, controller_player_id);
