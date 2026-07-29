// Save-deck proposal revalidation — pure server-side re-check of the payload
// the client sends to POST /api/collection/commanders/save-deck. The client's
// proposal is untrusted: the collection may have changed since it was
// generated, and the payload itself may be hand-crafted. No I/O here — the
// route loads a fresh CardMeta snapshot and hands it in.
// Task brief: .superpowers/sdd/2026-07-29-deck-generation/task-3-brief.md

import type { BasicName } from './deck-generator'

export type SavePayloadCard = { oracleId: string; quantity: number }
export type SavePayloadBasics = { name: BasicName; quantity: number }[]
export type CardMeta = { oracleId: string; colorIdentity: string[]; typeLine: string; ownedQty: number }

const BASIC_NAMES: readonly BasicName[] = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes']
const MAX_DECK_SIZE = 100

// Deliberately re-implemented rather than importing the canonical
// fitsColorIdentity from upgrade-scanner.ts: that module transitively pulls in
// supabase-typed I/O helpers, and this validator must stay dependency-free
// (pure, importable with zero DB/client setup) so its unit tests need no mocks.
function fitsIdentity(cardIdentity: string[], deckIdentity: string[]): boolean {
  return cardIdentity.every((c) => deckIdentity.includes(c))
}

export function validateProposal(
  cards: SavePayloadCard[],
  basics: SavePayloadBasics,
  commanderIdentity: string[],
  metaByOracle: Map<string, CardMeta>,
  // Both optional and additive — every pre-existing call site (and its unit
  // tests) omits them and is unaffected. Passed by the save-deck route once
  // it has the commander's own oracleId and the basics' resolved oracle ids
  // in hand (whole-branch review fix round 1: these two tamper cases used to
  // reach a DB insert/500 instead of a clean validation 400).
  commanderOracleId?: string,
  basicOracleIds?: Map<string, string>,
): { ok: true } | { ok: false; error: string } {
  const seen = new Set<string>()
  for (const c of cards) {
    if (seen.has(c.oracleId)) return { ok: false, error: `Duplicate card in proposal: ${c.oracleId}` }
    seen.add(c.oracleId)
  }

  if (commanderOracleId) {
    for (const c of cards) {
      if (c.oracleId === commanderOracleId) {
        return { ok: false, error: `Proposal cannot include the commander as a nonland card: ${c.oracleId}` }
      }
    }
  }

  if (basicOracleIds) {
    const basicIdSet = new Set(basicOracleIds.values())
    for (const c of cards) {
      if (basicIdSet.has(c.oracleId)) {
        return { ok: false, error: `Card ${c.oracleId} duplicates a basic land already in the proposal` }
      }
    }
  }

  for (const c of cards) {
    if (c.quantity !== 1) {
      return { ok: false, error: `Card ${c.oracleId} must have quantity 1, got ${c.quantity}` }
    }
    const meta = metaByOracle.get(c.oracleId)
    if (!meta) return { ok: false, error: `Unknown card in proposal: ${c.oracleId}` }
    if (meta.ownedQty < 1) return { ok: false, error: `Card not owned: ${c.oracleId}` }
    if (!fitsIdentity(meta.colorIdentity, commanderIdentity)) {
      return { ok: false, error: `Card ${c.oracleId} does not fit the commander's color identity` }
    }
  }

  const seenBasics = new Set<string>()
  for (const b of basics) {
    if (seenBasics.has(b.name)) return { ok: false, error: `Duplicate basic land in proposal: ${b.name}` }
    seenBasics.add(b.name)
  }

  for (const b of basics) {
    if (!BASIC_NAMES.includes(b.name)) return { ok: false, error: `Unknown basic land: ${b.name}` }
    // Strict integer guard, not just `< 1`: a missing/undefined or non-numeric
    // quantity (e.g. JSON `{name:'Forest'}` with no quantity key, or a string)
    // makes `< 1` evaluate false (undefined/NaN comparisons are always false),
    // which let a malformed basic slip past this check AND poison the
    // totalBasics sum below into NaN, silently defeating the 100-card cap too.
    if (!Number.isInteger(b.quantity) || b.quantity < 1) {
      return { ok: false, error: `Basic ${b.name} quantity must be a positive integer` }
    }
  }

  const totalBasics = basics.reduce((sum, b) => sum + b.quantity, 0)
  const total = 1 + cards.length + totalBasics // +1 for the commander
  if (total > MAX_DECK_SIZE) {
    return { ok: false, error: `Deck has ${total} cards, exceeding the ${MAX_DECK_SIZE}-card limit` }
  }

  return { ok: true }
}
