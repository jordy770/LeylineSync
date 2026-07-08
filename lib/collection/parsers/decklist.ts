// Decklist parser — pure, no I/O. Handles the plain-text exports shared by
// Moxfield, Archidekt and bare .txt decklists with one grammar:
//
//   [qty][x] NAME [(SET) [COLLECTOR]] [*F*] [[Category]]
//
// Plus two ways a commander is marked:
//   * a "Commander" section header (Moxfield text export), or
//   * an Archidekt inline category that contains "commander" (e.g. [Commander{top}]).
//
// Sideboard / Maybeboard / Considering / Companion / token sections are skipped —
// they aren't part of the 100.

import type { DeckParseResult, ParsedDeckCard } from '../types'

// Section headers that switch the current section. Compared lower-cased, after
// stripping a trailing "(NN)" count Moxfield appends (e.g. "Deck (99)").
const INCLUDED_SECTIONS = new Set(['commander', 'deck', 'mainboard', 'main'])
const SKIPPED_SECTIONS = new Set([
  'sideboard',
  'maybeboard',
  'maybe',
  'considering',
  'companion',
  'tokens',
  'token',
  'planes',
  'schemes',
  'stickers',
  'attractions',
  'emblems',
])

export function parseDecklist(text: string): DeckParseResult {
  const cards: ParsedDeckCard[] = []
  const errors: string[] = []
  let section: 'commander' | 'included' | 'skipped' = 'included'

  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (line === '' || line.startsWith('//') || line.startsWith('#')) continue

    // MTGO-style sideboard marker.
    if (/^SB:/i.test(line)) continue

    const header = asSectionHeader(line)
    if (header) {
      section = header
      continue
    }
    if (section === 'skipped') continue

    const card = parseCardLine(line)
    if (!card) {
      errors.push(`Line ${i + 1}: could not parse "${line}".`)
      continue
    }

    const isCommander = section === 'commander' || card.categoryIsCommander
    cards.push({
      name: card.name,
      quantity: card.quantity,
      setCode: card.setCode,
      collectorNum: card.collectorNum,
      isCommander,
      category: card.category,
    })
  }

  return { cards, errors }
}

/** Returns the section this header switches to, or null if the line isn't a header. */
function asSectionHeader(line: string): 'commander' | 'included' | 'skipped' | null {
  // A card line always begins with a quantity; a header never does.
  if (/^\d/.test(line)) return null
  // Tolerate a trailing count ("Deck (99)") and a trailing colon ("Commander:").
  const name = line.replace(/\s*\(\d+\)\s*$/, '').replace(/:\s*$/, '').trim().toLowerCase()
  if (name === 'commander' || name === 'commanders') return 'commander'
  if (INCLUDED_SECTIONS.has(name)) return 'included'
  if (SKIPPED_SECTIONS.has(name)) return 'skipped'
  return null
}

interface ParsedLine {
  name: string
  quantity: number
  setCode: string | null
  collectorNum: string | null
  category: string | null
  categoryIsCommander: boolean
}

function parseCardLine(raw: string): ParsedLine | null {
  let rest = raw.trim()

  // Quantity: leading "1", "1x", "1X". Default to 1 when absent (bare name).
  let quantity = 1
  const qtyMatch = rest.match(/^(\d+)\s*[xX]?\s+(.*)$/)
  if (qtyMatch) {
    quantity = Number.parseInt(qtyMatch[1], 10)
    rest = qtyMatch[2].trim()
  }

  // Trailing Archidekt category in square brackets, e.g. "[Ramp]" / "[Commander{top}]".
  let category: string | null = null
  let categoryIsCommander = false
  const catMatch = rest.match(/\[([^\]]+)\]\s*$/)
  if (catMatch) {
    category = catMatch[1].trim()
    categoryIsCommander = /commander/i.test(category)
    rest = rest.slice(0, catMatch.index).trim()
  }

  // TappedOut-style commander marker on the line itself: "1 Atraxa *CMDR*".
  if (/\*cmdr\*/i.test(rest)) {
    categoryIsCommander = true
    rest = rest.replace(/\*cmdr\*/gi, '').trim()
  }

  // Foil / etched markers: *F*, *E*, *foil*.
  rest = rest.replace(/\*(?:f|e|foil|etched)\*/gi, '').trim()

  // Set + collector: "(SET) 123" or "(SET)". Strip from the name, capture if present.
  let setCode: string | null = null
  let collectorNum: string | null = null
  const setMatch = rest.match(/\(([^)]+)\)\s*([A-Za-z0-9\-★]+)?\s*$/)
  if (setMatch) {
    setCode = setMatch[1].trim()
    collectorNum = setMatch[2] ? setMatch[2].trim() : null
    rest = rest.slice(0, setMatch.index).trim()
  }

  const name = rest.trim()
  if (!name) return null
  if (!Number.isFinite(quantity) || quantity <= 0) quantity = 1

  return { name, quantity, setCode, collectorNum, category, categoryIsCommander }
}
