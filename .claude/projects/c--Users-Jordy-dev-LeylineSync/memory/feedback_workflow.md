---
name: feedback-workflow
description: Preferred workflow patterns for Claude Code sessions on this project — plan-first, one mechanic per session, verify commands
metadata:
  type: feedback
---

Verify with these commands after every change:
```
npx tsc --noEmit
npm run lint
npm run build
```
Also run new migrations against local Supabase and test the actual mechanic in the UI.

**Session workflow:**
- Read CLAUDE.md and relevant files before starting — orientation first
- Ask for a plan before making changes; catch wrong assumptions cheap
- One mechanic per session — don't sprawl across unrelated changes
- Commit before every session and after every meaningful change
- When things go sideways: `git reset` and restart with better context rather than debugging confused state

**Why:** Explicitly listed in the design document as "patterns that work well." Owner has used these to maintain a clean 60+ migration history.

**How to apply:** Default to showing a plan first on any non-trivial task. Default to one focused mechanic per session. Always run the three verify commands before calling a task complete.
