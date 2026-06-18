// Heuristic decision logic for the AI CPU bot — "reasonably good" plays without
// lookahead or an LLM. Pure and side-effect-free (no DB/RPC): the runner gathers
// a snapshot, calls these, and executes the result. Kept pure so the play quality
// is unit-testable in isolation (tests/unit/bot-brain.test.ts) — the same reason
// shouldAutoPass was extracted.

export type BotCard = {
  id: string
  /** Raw type line, e.g. "Creature — Goblin" or "Basic Land — Mountain". */
  typeLine: string
  /** Mana value (cmc). */
  manaValue: number
}

/** A creature in combat — power/toughness already folded (counters/pumps). */
export type Creature = { id: string; power: number; toughness: number }

export const isLand = (typeLine: string) => /\bland\b/i.test(typeLine)
export const isCreatureType = (typeLine: string) => /creature/i.test(typeLine) && !isLand(typeLine)

// ── Mulligan ────────────────────────────────────────────────────────────────
// Keep a hand with a workable land count; mulligan a flood/screw — but stop after
// two so we don't spiral down to a crippled hand.
export function shouldMulligan(handTypeLines: string[], mulligansSoFar: number): boolean {
  if (mulligansSoFar >= 2) return false
  const lands = handTypeLines.filter(isLand).length
  return lands < 2 || lands > 5
}

// On keep, choose `n` cards to bottom: shed flood (lands beyond ~3) first, then the
// highest-cost cards (least castable soon). Falls back to remaining cards if short.
export function chooseBottom(hand: BotCard[], n: number): string[] {
  if (n <= 0) return []
  const lands = hand.filter((c) => isLand(c.typeLine))
  const nonland = hand.filter((c) => !isLand(c.typeLine))
  const out: string[] = []
  const push = (id: string) => { if (out.length < n && !out.includes(id)) out.push(id) }

  for (const c of lands.slice(3)) push(c.id)                                  // extra lands
  for (const c of [...nonland].sort((a, b) => b.manaValue - a.manaValue)) push(c.id) // priciest spells
  for (const c of lands.slice(0, 3)) push(c.id)                              // last resort: keep lands
  return out.slice(0, n)
}

// ── Main phase: what to play ──────────────────────────────────────────────────
export type MainPlan = { playLandId: string | null; castIds: string[]; castCommanderId?: string }

/** The commander in the command zone, with its CURRENT cost (manaValue already
 *  includes the {2}-per-prior-cast commander tax). */
export type CommanderOption = { id: string; manaValue: number }

// Play one land (if you have one and a drop is available), then cast the spells
// that fit your mana, cheapest first — developing the board on-curve without
// pretending to have mana you don't. `availableMana` is REAL (untapped sources +
// floating), so the bot sequences sensibly even though the runner may cheat the
// actual payment. If a commander is available and affordable it's cast FIRST —
// it's almost always the strongest play — before filling the rest with hand spells.
export function decideMainPlays(
  hand: BotCard[],
  availableMana: number,
  canPlayLand: boolean,
  commander?: CommanderOption | null,
): MainPlan {
  const lands = hand.filter((c) => isLand(c.typeLine))
  const playLandId = canPlayLand && lands.length > 0 ? lands[0].id : null
  // A freshly-played land usually adds mana this turn → +1 to the budget.
  let budget = availableMana + (playLandId ? 1 : 0)

  let castCommanderId: string | undefined
  if (commander && commander.manaValue <= budget) {
    castCommanderId = commander.id
    budget -= Math.max(commander.manaValue, 1)
  }

  const spells = hand.filter((c) => !isLand(c.typeLine)).sort((a, b) => a.manaValue - b.manaValue)
  const castIds: string[] = []
  for (const c of spells) {
    if (c.manaValue <= budget) { castIds.push(c.id); budget -= Math.max(c.manaValue, 1) }
  }
  return { playLandId, castIds, castCommanderId }
}

// ── Combat: attacks ────────────────────────────────────────────────────────────
// A blocker "free-kills" an attacker if it kills it (power ≥ its toughness) AND
// survives (its toughness > attacker power) — a one-sided loss for us. Equal and
// favourable trades are NOT free-kills, so they still attack.
//
// Aggression: blockers are a LIMITED resource — each blocks only one attacker — so
// once we send more attackers than they have blockers, the extras must connect.
// In that case swing with EVERYTHING (this also covers an empty board and the
// lethal alpha-strike). Only when they can cover every attacker do we get picky
// and hold back the creatures they'd free-kill for nothing.
export function decideAttacks(myCreatures: Creature[], oppBlockers: Creature[], _oppLife: number): string[] {
  const able = myCreatures.filter((c) => c.power > 0)
  if (able.length === 0) return []

  if (able.length > oppBlockers.length) return able.map((c) => c.id) // we outnumber → pressure leaks through

  return able
    .filter((c) => !oppBlockers.some((b) => b.power >= c.toughness && b.toughness > c.power))
    .map((c) => c.id)
}

// ── Combat: blocks ──────────────────────────────────────────────────────────────
// Returns blockerId → attackerId. First take value blocks (kill the attacker and
// survive), then — only if the unblocked damage is lethal — chump the biggest
// attackers to live. No needless chumping when you're not dying.
export function decideBlocks(attackers: Creature[], myBlockers: Creature[], myLife: number): Record<string, string> {
  const assign: Record<string, string> = {}
  const used = new Set<string>()
  const blocked = new Set<string>()

  for (const atk of attackers) {
    const b = myBlockers.find((bl) => !used.has(bl.id) && bl.power >= atk.toughness && bl.toughness > atk.power)
    if (b) { assign[b.id] = atk.id; used.add(b.id); blocked.add(atk.id) }
  }

  let incoming = attackers.filter((a) => !blocked.has(a.id)).reduce((s, a) => s + a.power, 0)
  if (incoming >= myLife) {
    const biggestFirst = attackers.filter((a) => !blocked.has(a.id)).sort((a, b) => b.power - a.power)
    for (const atk of biggestFirst) {
      if (incoming < myLife) break
      const b = myBlockers.find((bl) => !used.has(bl.id))
      if (!b) break
      assign[b.id] = atk.id; used.add(b.id); incoming -= atk.power
    }
  }
  return assign
}
