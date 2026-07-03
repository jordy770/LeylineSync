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

// Combat-relevant keywords folded onto a creature. All optional → callers that
// don't track keywords (and the older P/T-only tests) keep working unchanged; an
// absent flag is treated as "doesn't have it".
export type Keywords = {
  flying?: boolean
  reach?: boolean
  trample?: boolean
  menace?: boolean
  deathtouch?: boolean
  firstStrike?: boolean
  doubleStrike?: boolean
}

/** A creature in combat — power/toughness already folded (counters/pumps). */
export type Creature = { id: string; power: number; toughness: number; keywords?: Keywords }

const kw = (c: Creature): Keywords => c.keywords ?? {}
// First/double strike both deal damage in the first-strike step.
const strikesEarly = (c: Creature) => !!(kw(c).firstStrike || kw(c).doubleStrike)

// Does `src` deal lethal to `tgt` with one combat hit? Deathtouch makes any
// damage ≥1 lethal; otherwise it takes power ≥ toughness.
function dealsLethal(src: Creature, tgt: Creature): boolean {
  if (src.power <= 0) return false
  return kw(src).deathtouch ? true : src.power >= tgt.toughness
}

// Can `blocker` legally block `attacker`? Flying is only blockable by flying or
// reach. (Menace — must be blocked by two — is enforced where blocks are assigned.)
function canBlock(blocker: Creature, attacker: Creature): boolean {
  if (kw(attacker).flying) return !!(kw(blocker).flying || kw(blocker).reach)
  return true
}

// Does `blocker` free-kill `attacker` — attacker dies, blocker survives (a
// one-sided loss for the attacking side)? Respects strike order:
//  • blocker strikes first and kills  → attacker never connects → blocker lives.
//  • attacker strikes first and kills → blocker dies before it can swing back.
//  • otherwise simultaneous: blocker kills it and isn't killed in return.
function freeKills(blocker: Creature, attacker: Creature): boolean {
  const blockerFirst = strikesEarly(blocker) && !strikesEarly(attacker)
  const attackerFirst = strikesEarly(attacker) && !strikesEarly(blocker)
  if (blockerFirst) return dealsLethal(blocker, attacker)
  if (attackerFirst) return dealsLethal(attacker, blocker) ? false : dealsLethal(blocker, attacker)
  return dealsLethal(blocker, attacker) && !dealsLethal(attacker, blocker)
}

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
// A blocker "free-kills" an attacker when the attacker dies and the blocker lives
// (see freeKills — keyword-aware: deathtouch, first/double strike). Equal and
// favourable trades are NOT free-kills, so those creatures still attack.
//
// Evasion: a flier the opponent can't block (no flying/reach), or a menace
// creature they have fewer than two blockers for, always connects → always swing.
//
// Aggression: blockers are a LIMITED resource — each blocks only one attacker — so
// once we send more attackers than they have blockers, the extras must connect.
// In that case swing with EVERYTHING (this also covers an empty board and the
// lethal alpha-strike). Only when they can cover every attacker do we get picky
// and hold back the creatures they'd free-kill for nothing.
//
// Defensive reserves (only when `myLife` is known): if we're not swinging for
// lethal and the opponent's board could race us to death on the back-swing,
// attacking taps our creatures out of that block — so keep our best wall home.
export function decideAttacks(
  myCreatures: Creature[],
  oppBlockers: Creature[],
  oppLife: number,
  opts: { myLife?: number } = {},
): string[] {
  const able = myCreatures.filter((c) => c.power > 0)
  if (able.length === 0) return []

  // Unblockable on the current board → always connects, so always worth swinging.
  const unblockable = (a: Creature): boolean => {
    const legal = oppBlockers.filter((b) => canBlock(b, a))
    if (legal.length === 0) return true
    if (kw(a).menace && legal.length < 2) return true
    return false
  }

  if (able.length > oppBlockers.length) return able.map((c) => c.id) // we outnumber → pressure leaks through

  let attackers = able.filter((c) => unblockable(c) || !oppBlockers.some((b) => canBlock(b, c) && freeKills(b, c)))

  const { myLife } = opts
  if (myLife !== undefined && attackers.length > 0) {
    const goingForLethal = attackers.reduce((s, c) => s + c.power, 0) >= oppLife
    const swingBack = oppBlockers.reduce((s, b) => s + b.power, 0)
    if (!goingForLethal && swingBack >= myLife) {
      const reserve = [...attackers].sort((a, b) => b.toughness - a.toughness)[0]
      attackers = attackers.filter((c) => c.id !== reserve.id)
    }
  }
  return attackers.map((c) => c.id)
}

// ── Combat: blocks ──────────────────────────────────────────────────────────────
// Returns blockerId → attackerId. First take value blocks (a single blocker that
// legally blocks AND free-kills the attacker), then — only if the unblocked damage
// is lethal — chump the biggest attackers to live. No needless chumping when not
// dying. Keyword-aware: evasion (can't block fliers without flying/reach), menace
// (needs two blockers), and trample (a chump only stops the blocker's toughness;
// the excess still tramples through).
export function decideBlocks(attackers: Creature[], myBlockers: Creature[], myLife: number): Record<string, string> {
  const assign: Record<string, string> = {}
  const used = new Set<string>()
  const blocked = new Set<string>()

  // Value blocks are single-blocker only — committing two creatures for value
  // isn't worth it — so skip menace attackers here (they need two).
  for (const atk of attackers) {
    if (kw(atk).menace) continue
    const b = myBlockers.find((bl) => !used.has(bl.id) && canBlock(bl, atk) && freeKills(bl, atk))
    if (b) { assign[b.id] = atk.id; used.add(b.id); blocked.add(atk.id) }
  }

  let incoming = attackers.filter((a) => !blocked.has(a.id)).reduce((s, a) => s + a.power, 0)
  if (incoming >= myLife) {
    const biggestFirst = attackers.filter((a) => !blocked.has(a.id)).sort((a, b) => b.power - a.power)
    for (const atk of biggestFirst) {
      if (incoming < myLife) break
      const need = kw(atk).menace ? 2 : 1
      const free = myBlockers.filter((bl) => !used.has(bl.id) && canBlock(bl, atk))
      if (free.length < need) continue
      const chosen = free.slice(0, need)
      // Trample: blockers only soak up to their combined toughness; the rest leaks.
      const stopped = kw(atk).trample
        ? Math.min(atk.power, chosen.reduce((s, bl) => s + bl.toughness, 0))
        : atk.power
      chosen.forEach((bl) => { assign[bl.id] = atk.id; used.add(bl.id) })
      incoming -= stopped
    }
  }
  return assign
}
