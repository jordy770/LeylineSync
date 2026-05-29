---
name: reference-pencil-designs
description: Pencil design file for LeylineSync — 14 screens covering mobile controller and big screen playmat
metadata:
  type: reference
---

**File:** `docs/leylinesync_pencil.pen`

Access ONLY via Pencil MCP tools (`mcp__pencil__get_editor_state`, `batch_get`, `batch_design`, etc.). Never use Read/Grep on .pen files — they are encrypted.

**Known screens (top-level frames as of 2026-05-27):**
- `HIB35` — Mobile Landscape — Declare Blockers v5
- `a1hD7` — Mobile — Main Phase
- `TGhOV` — Mobile — Priority
- `JEean` — Big Screen — Playmat
- `k2dAoH` — Mobile Landscape — Main Phase
- `fLudH` — Mobile Landscape v2
- `BL0VK` — Mobile Landscape — Declare Attackers
- `r8ujJ8` — Mobile Landscape — Declare Attackers (4 Opponents)
- `p5elHO` — Mobile Landscape — Priority Accordion
- `bi8Au` — Frame (unlabeled)
- +4 others (load `get_editor_state` for the full list)

**How to apply:** When working on UI or visual design tasks for LeylineSync, load this Pencil file first with `get_editor_state(include_schema: true)` to see the existing designs before making changes or adding new screens.
