-- Operational / security — scope game-state reads to SESSION MEMBERS.
--
-- Two legacy policies granted SELECT with USING (true) and NO role restriction, so
-- ANY caller — including `anon` and authenticated users who are NOT in the session —
-- could read EVERY row globally:
--   * game_cards  "Zichtbaar voor sessie-deelnemers"     (every card in every game)
--   * game_players "Sessie deelnemers kunnen stats zien" (every player's mana pool)
-- Postgres OR-combines permissive policies, so these overrode the intended
-- is_session_player gates entirely.
--
-- Fix: drop the open policies and ensure each table has a SELECT policy scoped to
-- session members (is_session_player). game_cards already has that policy (kept), so
-- it only needs the open one dropped; game_players had only owner-self policies, so a
-- member-scoped read policy is added (the judge + opponent displays read other
-- members' mana, and they are members — preserved). NO behaviour change for any
-- legitimate reader (judge, controller, opponent counts are all session members);
-- only anon / non-member global reads are closed.
--
-- NOT changed:
--   * game_sessions "...zichtbaar voor iedereen met de ID" (USING true) — the
--     deliberate join-by-unguessable-ID flow (you must read a session you're not yet
--     a member of, to join it). A capability-URL design; left intentionally.
--   * cards "Anyone can read cards" — the public card catalog.
--
-- DEFERRED (Slice B): hiding HIDDEN ZONES (hand/library) between FELLOW members. That
-- conflicts with the judge view (which is meant to see all hands) and the opponent
-- hand/library COUNT display (both read game_cards rows directly), and would require a
-- privileged-judge concept + a count RPC + client rewiring first. Roadmap conditions
-- it on "if private decklists matter".

-- game_cards: drop the open policy; the member-scoped "Session players can read game
-- cards" policy already exists and remains the SELECT gate.
drop policy if exists "Zichtbaar voor sessie-deelnemers" on public.game_cards;

-- game_players: drop the open policy and add a member-scoped read (the owner-self
-- policies remain for a player reading their own row even outside the member check).
drop policy if exists "Sessie deelnemers kunnen stats zien" on public.game_players;

drop policy if exists "Session players can read game player state" on public.game_players;
create policy "Session players can read game player state"
  on public.game_players
  for select
  to authenticated
  using (public.is_session_player(session_id, auth.uid()));
