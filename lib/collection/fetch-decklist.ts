// Fetch a decklist from a Moxfield or Archidekt URL and normalise it to the plain
// text our parser already understands, so the rest of the import path is unchanged.
//
// Security: we never fetch the user's URL directly. We extract a deck id (regex,
// alphanumeric only) and fetch a FIXED API host — no arbitrary-URL/SSRF surface.
// The JSON mappers are pure + defensive (sites change shapes) and unit-tested.

export interface FetchedDeck {
  source: 'moxfield' | 'archidekt'
  name: string | null
  text: string
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

const SECTIONS_TO_SKIP = new Set(['maybeboard', 'sideboard', 'considering'])

/** Pure: identify the site + deck id from a pasted URL. */
export function parseDeckUrl(url: string): { source: 'moxfield' | 'archidekt'; id: string } | null {
  let host: string
  let path: string
  try {
    const u = new URL(url.trim())
    host = u.hostname.toLowerCase()
    path = u.pathname
  } catch {
    return null
  }

  if (host.endsWith('moxfield.com')) {
    const m = path.match(/\/decks\/([A-Za-z0-9_-]+)/)
    return m ? { source: 'moxfield', id: m[1] } : null
  }
  if (host.endsWith('archidekt.com')) {
    // /decks/123456 or /decks/123456-some-slug
    const m = path.match(/\/decks\/(\d+)/)
    return m ? { source: 'archidekt', id: m[1] } : null
  }
  return null
}

interface CardLine {
  quantity: number
  name: string
  isCommander: boolean
}

/** Pure: Moxfield deck JSON (v2 flat or v3 boards) → normalised decklist text. */
export function moxfieldJsonToText(json: unknown): { name: string | null; text: string } {
  const root = (json ?? {}) as Record<string, unknown>
  const boards = (root.boards as Record<string, unknown>) ?? root

  const commanders = boardCards(boards.commanders).map((c) => ({ ...c, isCommander: true }))
  const main = boardCards(boards.mainboard).map((c) => ({ ...c, isCommander: false }))

  return { name: typeof root.name === 'string' ? root.name : null, text: linesToText(commanders, main) }
}

/** Pure: Archidekt deck JSON → normalised decklist text. */
export function archidektJsonToText(json: unknown): { name: string | null; text: string } {
  const root = (json ?? {}) as Record<string, unknown>
  const cards = Array.isArray(root.cards) ? (root.cards as Record<string, unknown>[]) : []

  const commanders: CardLine[] = []
  const main: CardLine[] = []
  for (const entry of cards) {
    const cats = (Array.isArray(entry.categories) ? (entry.categories as string[]) : []).map((c) => String(c).toLowerCase())
    if (cats.some((c) => SECTIONS_TO_SKIP.has(c))) continue

    const card = (entry.card ?? {}) as Record<string, unknown>
    const oracle = (card.oracleCard ?? {}) as Record<string, unknown>
    const name = (oracle.name as string) ?? (card.name as string) ?? null
    if (!name) continue
    const quantity = Number(entry.quantity) || 1
    const isCommander = cats.includes('commander')
    ;(isCommander ? commanders : main).push({ quantity, name, isCommander })
  }

  return { name: typeof root.name === 'string' ? root.name : null, text: linesToText(commanders, main) }
}

export async function fetchDecklistFromUrl(url: string, fetchImpl: FetchLike = fetch): Promise<FetchedDeck> {
  const parsed = parseDeckUrl(url)
  if (!parsed) {
    throw new Error('Unsupported or invalid deck URL. Use a Moxfield or Archidekt deck link, or paste the list.')
  }

  const apiUrl =
    parsed.source === 'moxfield'
      ? `https://api.moxfield.com/v2/decks/all/${parsed.id}`
      : `https://archidekt.com/api/decks/${parsed.id}/`

  let res: Response
  try {
    res = await fetchImpl(apiUrl, { headers: { accept: 'application/json', 'user-agent': 'LeylineSync/1.0 (deck import)' } })
  } catch {
    throw new Error('Could not reach the deck site. Paste the list instead.')
  }
  if (!res.ok) {
    throw new Error(
      parsed.source === 'moxfield'
        ? `Moxfield returned ${res.status} — the deck may be private or Moxfield is blocking the request. Paste the list instead.`
        : `Archidekt returned ${res.status}. Paste the list instead.`,
    )
  }

  const json = await res.json()
  const mapped = parsed.source === 'moxfield' ? moxfieldJsonToText(json) : archidektJsonToText(json)
  if (!mapped.text.trim()) throw new Error('The deck appears to be empty.')
  return { source: parsed.source, name: mapped.name, text: mapped.text }
}

function boardCards(board: unknown): { quantity: number; name: string }[] {
  if (!board) return []
  const b = board as Record<string, unknown>
  const cards = (b.cards ?? b) as Record<string, unknown>
  const out: { quantity: number; name: string }[] = []
  for (const entry of Object.values(cards)) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const card = (e.card ?? {}) as Record<string, unknown>
    const name = (card.name as string) ?? (e.name as string)
    if (!name) continue
    out.push({ quantity: Number(e.quantity) || 1, name })
  }
  return out
}

function linesToText(commanders: CardLine[], main: CardLine[]): string {
  const lines: string[] = []
  if (commanders.length) {
    lines.push('Commander')
    for (const c of commanders) lines.push(`${c.quantity} ${c.name}`)
    lines.push('')
  }
  lines.push('Deck')
  for (const c of main) lines.push(`${c.quantity} ${c.name}`)
  return lines.join('\n')
}
