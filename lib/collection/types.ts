// Shared types for the Collection Optimizer module. Kept framework-free so the
// parsers/resolvers stay pure and unit-testable.

export type Finish = 'nonfoil' | 'foil' | 'etched'
export type BinderType = 'binder' | 'deck' | 'list'

/** One physical stack of cards as parsed from an import file (pre-resolution). */
export interface ParsedCollectionRow {
  name: string
  quantity: number
  setCode: string | null
  collectorNum: string | null
  finish: Finish
  language: string
  condition: string | null
  binderType: BinderType
  binderName: string | null
  scryfallId: string | null
}

export interface ParseResult {
  rows: ParsedCollectionRow[]
  /** Non-fatal per-line problems (e.g. a row with no name); the import continues. */
  errors: string[]
}

/** A parsed row that has been matched to a Scryfall gameplay identity. */
export interface ResolvedCollectionRow extends ParsedCollectionRow {
  oracleId: string
}

export interface UnmatchedRow {
  name: string
  setCode: string | null
  collectorNum: string | null
  quantity: number
}

export interface CollectionImportResult {
  rowsTotal: number
  rowsMatched: number
  rowsUnmatched: number
  /** Capped sample of rows that could not be matched (for the import report UI). */
  unmatched: UnmatchedRow[]
  parseErrors: string[]
  importId: string | null
  /** What changed vs the replaced snapshot (null on a first import). */
  diff: CollectionDiff | null
}

/** Re-import delta: the new snapshot compared against the one it replaced. */
export interface CollectionDiff {
  addedUnique: number
  removedUnique: number
  qtyAdded: number
  qtyRemoved: number
  /** Top samples for the report UI (capped, sorted by quantity). */
  added: { name: string; qty: number }[]
  removed: { name: string; qty: number }[]
}

/** Lookups the resolver consults, in priority order (scryfall id → set+collector → name). */
export interface PrintingLookup {
  byScryfallId: Map<string, string>
  bySetCollector: Map<string, string>
  byName: Map<string, string>
  /** oracle_id → color identity, for deriving a deck's color identity. */
  colorIdentityByOracle: Map<string, string[]>
}

// ── Deck import ──

/** One card line parsed from a decklist (Moxfield / Archidekt / plain txt). */
export interface ParsedDeckCard {
  name: string
  quantity: number
  setCode: string | null
  collectorNum: string | null
  isCommander: boolean
  category: string | null
}

export interface DeckParseResult {
  cards: ParsedDeckCard[]
  errors: string[]
}

export interface DeckImportResult {
  deckId: string | null
  deckName: string
  colorIdentity: string[]
  cardsMatched: number
  cardsUnmatched: number
  unmatched: UnmatchedRow[]
  commanderResolved: boolean
  parseErrors: string[]
}
