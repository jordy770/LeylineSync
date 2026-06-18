# Backlog

Future work that's deliberately deferred. Add a line; keep it short.

## AI CPU bot (`lib/game/bot-brain.ts`)

- [ ] **Smarter combat heuristics.** The current `decideAttacks`/`decideBlocks` are
  pure power/toughness math with no keyword awareness or lookahead. Consider:
  trample (excess damage tramples → push attacks even into a blocker), first
  strike / deathtouch (changes who dies), evasion (flying/menace → unblockable by
  ground), and holding back attackers as defensive reserves for the opponent's
  swing-back. (Deferred 2026-06-18 — current swing-all-when-outnumbering heuristic
  is good enough for a test bot.)
