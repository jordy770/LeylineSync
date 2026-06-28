# Backlog

Future work that's deliberately deferred. Add a line; keep it short.

## AI CPU bot (`lib/game/bot-brain.ts`)

- [x] **Smarter combat heuristics.** (Done 2026-06-22) `decideAttacks`/`decideBlocks`
  are now keyword-aware: evasion (flying blockable only by flying/reach), menace
  (needs two blockers), trample (chump only soaks blocker toughness; excess leaks),
  first/double strike + deathtouch (strike order folded into the free-kill test),
  and defensive reserves (hold back the best wall against a lethal swing-back when
  not attacking for lethal). Runner fetches keywords via `card_has_*`. No lookahead
  yet — still single-turn heuristics.
