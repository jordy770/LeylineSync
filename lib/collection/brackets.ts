// Commander Brackets (WotC's official 1-5 system) — pure helpers.
//
// The GAME_CHANGERS list below is the official list as of the February 9, 2026
// beta update (53 cards), fetched from Scryfall's `is:gamechanger` search on
// 2026-07-09. WotC updates it a few times a year — refresh by re-running:
//   curl "https://api.scryfall.com/cards/search?q=is%3Agamechanger&order=name"
//
// Bracket rules for Game Changers: none in 1-2, up to 3 in bracket 3,
// unlimited in 4-5. The other criteria (mass land denial, chained extra
// turns, early 2-card combos) are judgment calls the estimate can't measure —
// the UI says so, and the ⚡ combo detector covers the combo side.

export const GAME_CHANGERS: readonly string[] = [
  'Ad Nauseam', 'Ancient Tomb', 'Aura Shards', 'Biorhythm', "Bolas's Citadel",
  'Braids, Cabal Minion', 'Chrome Mox', 'Coalition Victory', 'Consecrated Sphinx',
  'Crop Rotation', 'Cyclonic Rift', 'Demonic Tutor', 'Drannith Magistrate',
  'Enlightened Tutor', 'Farewell', 'Field of the Dead', 'Fierce Guardianship',
  'Force of Will', "Gaea's Cradle", 'Gamble', 'Gifts Ungiven', 'Glacial Chasm',
  'Grand Arbiter Augustin IV', 'Grim Monolith', 'Humility', 'Imperial Seal',
  'Intuition', "Jeska's Will", "Lion's Eye Diamond", 'Mana Vault',
  "Mishra's Workshop", 'Mox Diamond', 'Mystical Tutor', 'Narset, Parter of Veils',
  'Natural Order', 'Necropotence', 'Notion Thief', 'Opposition Agent',
  'Orcish Bowmasters', 'Panoptic Mirror', 'Rhystic Study', 'Seedborn Muse',
  "Serra's Sanctum", 'Smothering Tithe', 'Survival of the Fittest',
  "Teferi's Protection", "Tergrid, God of Fright // Tergrid's Lantern",
  "Thassa's Oracle", 'The One Ring', 'The Tabernacle at Pendrell Vale',
  'Underworld Breach', 'Vampiric Tutor', 'Worldly Tutor',
]

export const BRACKET_LABELS: Record<number, string> = {
  1: 'Exhibition',
  2: 'Core',
  3: 'Upgraded',
  4: 'Optimized',
  5: 'cEDH',
}

// Match on the full name AND the front face ("Tergrid, God of Fright" alone
// counts), case-insensitive.
const GC_KEYS = new Set(
  GAME_CHANGERS.flatMap((n) => {
    const keys = [n.toLowerCase()]
    if (n.includes(' // ')) keys.push(n.split(' // ')[0].toLowerCase())
    return keys
  }),
)

export function isGameChanger(name: string): boolean {
  const key = name.trim().toLowerCase()
  return GC_KEYS.has(key) || (key.includes(' // ') && GC_KEYS.has(key.split(' // ')[0]))
}

export function findGameChangers(deckNames: string[]): string[] {
  return deckNames.filter(isGameChanger)
}

/** How many Game Changers a deck may hold at a target bracket. */
export function gameChangerAllowance(targetBracket: number | null | undefined): number {
  if (targetBracket == null) return Number.POSITIVE_INFINITY
  if (targetBracket <= 2) return 0
  if (targetBracket === 3) return 3
  return Number.POSITIVE_INFINITY
}

export interface BracketEstimate {
  /** 2..4 — bracket 1 vs 2 and 4 vs 5 are declarations, not measurements. */
  bracket: number
  label: string
  gameChangers: string[]
  tutorCount: number
  note: string
}

/** Heuristic estimate from what IS measurable: Game Changers + tutor density.
 *  Mass land denial, chained extra turns and early 2-card combos stay the
 *  player's own call (the note says so). */
export function estimateBracket(deckNames: string[], tutorCount: number): BracketEstimate {
  const gameChangers = findGameChangers(deckNames)
  let bracket: number
  if (gameChangers.length === 0) bracket = tutorCount >= 4 ? 3 : 2
  else if (gameChangers.length <= 3) bracket = 3
  else bracket = 4

  const parts: string[] = []
  parts.push(
    gameChangers.length === 0
      ? 'No Game Changers'
      : `${gameChangers.length} Game Changer${gameChangers.length === 1 ? '' : 's'} (${gameChangers.join(', ')})`,
  )
  if (tutorCount > 0) parts.push(`${tutorCount} tutors`)
  parts.push('mass land denial, chained extra turns and early combos are your own call')

  return { bracket, label: BRACKET_LABELS[bracket], gameChangers, tutorCount, note: `${parts.join(' · ')}.` }
}
