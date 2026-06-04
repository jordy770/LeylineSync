-- LOCAL TEST DB ONLY (sorts right after the baseline). Do NOT apply to hosted.
--
-- The schema chains game rows to real auth users:
--   game_cards.owner_id -> profiles.id -> auth.users.id
--   game_players.player_id -> profiles.id
-- The rules-engine test harness uses throwaway player UUIDs (no auth users), so
-- these FKs would force seeding auth.users + profiles for every test. They don't
-- affect any rules-engine logic, so we drop them locally. Session-scoped FKs
-- (e.g. game_cards.session_id -> game_sessions, ON DELETE CASCADE) are kept.
alter table public.profiles     drop constraint if exists profiles_id_fkey;
alter table public.game_cards    drop constraint if exists game_cards_owner_id_fkey;
alter table public.game_players  drop constraint if exists game_players_player_id_fkey;
alter table public.game_sessions drop constraint if exists game_sessions_host_id_fkey;
alter table public.game_sessions drop constraint if exists game_sessions_current_turn_player_fkey;
alter table public.decks         drop constraint if exists decks_owner_id_fkey;
