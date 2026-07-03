// Synergy tagger — pure heuristics that turn a card's oracle text/type/keywords
// into weighted role tags. This is deliberately transparent (regex rules, fixed
// weights) rather than ML/EDHREC-derived: EDHREC data isn't redistributable, and a
// reproducible score beats an opaque one. Imperfect by design — refine the rules
// over time; the registry of tags is the contract the power-score + scanner read.

export type SynergyTag =
  | 'ramp'
  | 'removal'
  | 'board_wipe'
  | 'counterspell'
  | 'card_draw'
  | 'tutor'
  | 'recursion'
  | 'reanimation'
  | 'protection'
  | 'token'
  | 'artifact'
  | 'enchantment'
  | 'lifegain'
  | 'lifeloss'
  | 'sacrifice'
  | 'spellslinger'
  | 'blink'
  | 'graveyard'
  | 'land'
  | 'win_condition'

export interface CardTag {
  tag: SynergyTag
  weight: number
}

export interface TaggerCard {
  name: string
  typeLine: string
  oracleText: string | null
  keywords: string[]
  cmc: number
}

const MAX_WEIGHT = 4

// Engine-y tags get a +1 bump when the effect is repeatable ("whenever" / "at the
// beginning of") rather than a one-shot.
// Roles where mana efficiency is the dominant quality signal — cheap is better.
const EFFICIENCY_TAGS: ReadonlySet<SynergyTag> = new Set(['removal', 'counterspell', 'card_draw', 'ramp', 'tutor'])

const REPEATABLE_BUMP: ReadonlySet<SynergyTag> = new Set([
  'card_draw',
  'token',
  'lifegain',
  'lifeloss',
  'sacrifice',
  'ramp',
  'graveyard',
  'reanimation',
])

interface TextRule {
  tag: SynergyTag
  weight: number
  re: RegExp
}

// Rules are tested against the lower-cased oracle text. Order doesn't matter — a
// card may earn many tags, and we keep the max weight per tag.
const TEXT_RULES: TextRule[] = [
  // ── ramp ──
  { tag: 'ramp', weight: 2, re: /\badd\s+(?:\{[wubrgcx0-9/]+\}|one mana|two mana|three mana|that much mana|\w+ mana of any)/ },
  { tag: 'ramp', weight: 2, re: /search your library for .*?\bland\b.*?(?:onto the battlefield|put (?:it|them) onto the battlefield)/ },
  { tag: 'ramp', weight: 1, re: /play (?:an )?additional land|additional land each turn/ },

  // ── targeted removal ── (allow adjectives like "nonblack"/"attacking" before the noun)
  { tag: 'removal', weight: 2, re: /(?:destroy|exile) target (?:[a-z]+ ){0,3}(?:creature|permanent|artifact|enchantment|planeswalker|nonland|land|token)/ },
  { tag: 'removal', weight: 2, re: /deals?\s+\d+\s+damage to (?:target|any target|that creature)/ },
  { tag: 'removal', weight: 1, re: /target creature gets [-−]\d+\/[-−]\d+/ },
  { tag: 'removal', weight: 1, re: /return target (?:creature|permanent|nonland permanent) to its owner'?s hand/ },
  { tag: 'removal', weight: 1, re: /fight target|target creature fights/ },

  // ── board wipes ── hard wipe (wraths) rank above soft mass -X/-X or pings.
  { tag: 'board_wipe', weight: 3, re: /destroy all|exile all (?:creatures|permanents)/ },
  { tag: 'board_wipe', weight: 2, re: /each creature gets [-−]\d+\/[-−]\d+|deals?\s+\d+\s+damage to each (?:creature|opponent)|all creatures get [-−]/ },

  // ── counters ──
  { tag: 'counterspell', weight: 2, re: /counter target (?:spell|activated|triggered|ability)/ },

  // ── card draw ──
  { tag: 'card_draw', weight: 2, re: /draws? (?:a card|two cards|three cards|\w+ cards|cards equal|that many cards)/ },

  // ── tutor (search for a non-basic card) ──
  { tag: 'tutor', weight: 2, re: /search your library for (?:a|an|up to (?:one|two|three))(?![^.]*\bbasic\b)[^.]*\bcard\b/ },

  // ── recursion / reanimation ──
  { tag: 'reanimation', weight: 2, re: /return target creature card from (?:your|a) graveyard to the battlefield|put target creature card from .*?graveyard onto the battlefield/ },
  { tag: 'recursion', weight: 1, re: /return (?:target|all|each)?[^.]*card[s]? from (?:your|a) graveyard to (?:your hand|the battlefield)|return [^.]*from your graveyard/ },

  // ── protection ──
  { tag: 'protection', weight: 1, re: /hexproof|shroud|indestructible|protection from|can't be (?:countered|targeted)|prevent (?:all|the next)/ },

  // ── tokens ──
  { tag: 'token', weight: 2, re: /create (?:a|an|x|that many|\w+) [^.]*token/ },

  // ── life ──
  { tag: 'lifegain', weight: 1, re: /gains? \d+ life|gain that much life|you gain life/ },
  { tag: 'lifeloss', weight: 1, re: /(?:each|target) (?:opponent|player) loses \d+ life|loses? that much life|drain/ },

  // ── sacrifice ──
  { tag: 'sacrifice', weight: 1, re: /sacrifice (?:a|an|another|two|three|x|target|that|this|each)/ },

  // ── spellslinger ──
  { tag: 'spellslinger', weight: 1, re: /instant (?:and|or) sorcery|whenever you cast (?:an|your first|a noncreature)[^.]*(?:instant|sorcery|noncreature)|noncreature spell/ },

  // ── blink / flicker ──
  { tag: 'blink', weight: 1, re: /exile [^.]*(?:return (?:it|that card|them|those cards))[^.]*battlefield/ },

  // ── graveyard / mill ──
  { tag: 'graveyard', weight: 1, re: /\bmill\b|put (?:the top|that many)[^.]*into (?:your|their) graveyard|cards? in (?:your|each) graveyard|from your graveyard/ },

  // ── win conditions ──
  { tag: 'win_condition', weight: 3, re: /wins? the game|can't lose the game/ },
]

export function tagCard(card: TaggerCard): CardTag[] {
  const text = (card.oracleText ?? '').toLowerCase()
  const type = card.typeLine.toLowerCase()
  const keywords = card.keywords.map((k) => k.toLowerCase())
  const repeatable = /\bwhenever\b|at the beginning of/.test(text)

  const weights = new Map<SynergyTag, number>()
  const bump = (tag: SynergyTag, weight: number) => {
    const w = REPEATABLE_BUMP.has(tag) && repeatable ? weight + 1 : weight
    weights.set(tag, Math.min(MAX_WEIGHT, Math.max(weights.get(tag) ?? 0, w)))
  }

  for (const rule of TEXT_RULES) {
    if (rule.re.test(text)) bump(rule.tag, rule.weight)
  }

  // Type-line tags.
  if (/\bartifact\b/.test(type)) bump('artifact', 1)
  if (/\benchantment\b/.test(type)) bump('enchantment', 1)
  if (/\bland\b/.test(type)) bump('land', 1)
  // "matters" text strengthens the artifact/enchantment role.
  if (/artifacts you control|whenever an artifact|target artifact/.test(text)) bump('artifact', 2)
  if (/enchantments you control|whenever an enchantment|target enchantment/.test(text)) bump('enchantment', 2)

  // Keyword tags the text rules miss.
  if (keywords.includes('lifelink')) bump('lifegain', 1)

  // A land taps for mana by definition — that's not "ramp". Keep the land tag, drop
  // the false-positive ramp the mana-add rule produced. (Land ramp like Cultivate is
  // a nonland card, so it's unaffected.)
  if (/\bland\b/.test(type)) weights.delete('ramp')

  // Efficiency: cheap interaction/acceleration is stronger than clunky versions, so a
  // 1-mana removal spell outranks a 6-mana one. Applies only to roles where mana cost
  // is the dominant quality signal.
  for (const tag of EFFICIENCY_TAGS) {
    const w = weights.get(tag)
    if (w === undefined) continue
    const adjusted = card.cmc <= 2 ? w + 1 : card.cmc >= 6 ? w - 1 : w
    weights.set(tag, Math.min(MAX_WEIGHT, Math.max(1, adjusted)))
  }

  return [...weights.entries()]
    .map(([tag, weight]) => ({ tag, weight }))
    .sort((a, b) => (b.weight - a.weight) || a.tag.localeCompare(b.tag))
}
