---
name: project-styling
description: LeylineSync visual language — mobile controller vs big screen, fonts, mana colors as functional only
metadata:
  type: project
---

**Split visual language between the two screens:**

**Mobile controller** — utilitarian, dark warm base (`#0F1117`), off-white text (`#E8E4D8`). Minimal chrome, large tap targets. Mana colors as functional accents only (not decoration). Serif typography reserved for hero moments (life total, active phase). Think DJ deck or fighting game HUD.

**Big screen playmat** — atmospheric, immersive, spectacle. Full-bleed Scryfall art, dynamic lighting tied to game state, smooth animations. Very large serif life totals readable from across a table. Frame supports the art; doesn't compete.

**Mobile UI structure** — phase-specific layouts, not one cluttered universal layout:
- Declare attackers: drag-line targeting from creatures to defending players/planeswalkers
- Main phase: hand + battlefield interaction
- Priority/response windows: prominent but non-blocking, Pass/Respond choice
- Mana: six-part quick-add (W/U/B/R/G/C) + slide-right expansion to full mana overview

**Fonts:** Cinzel or Cormorant (Google Fonts, Beleren-adjacent serifs — Beleren is not free for commercial use). Mana symbol font: Andrew Gioia's free Mana font.

**Why:** Design direction from conversation with project owner. Keeps each screen focused on its role.

**How to apply:** When implementing UI, keep the mobile view dense and functional; keep the big screen visual and atmospheric. Never use mana colors as decoration on the mobile controller.
