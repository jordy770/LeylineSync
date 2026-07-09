// Combo detector — which combo/synergy lines does this deck ALREADY contain,
// which can the binder complete, and which famous line is one missing card
// away? The model brings the combo knowledge; grounding keeps it honest: every
// non-missing card it names must exist in the deck or the (color-legal, free)
// binder pool we hand it, or the combo is dropped.

import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'

import { askClaudeJson, requireApiKey } from './ai-client'
import { loadAvailability, loadDeckForScoring, loadOracleMeta } from './deck-loader'

const BINDER_CAP = 150

const ReplySchema = z.object({
  summary: z.string(),
  combos: z.array(
    z.object({
      cards: z.array(z.string()).min(2).max(5),
      result: z.string(),
      steps: z.string(),
      missing: z.string().nullable().optional(),
    }),
  ),
})

export interface ComboCard {
  name: string
  where: 'deck' | 'binder'
}

export interface ComboFind {
  cards: ComboCard[]
  result: string
  steps: string
  /** A card completing the line that the player does NOT own (buy target). */
  missing: string | null
}

export interface CombosResult {
  summary: string
  combos: ComboFind[]
}

/** Pure: keep only combos whose non-missing cards are all actually owned, and
 *  annotate where each piece lives. Case-insensitive on names. */
export function groundCombos(
  raw: { cards: string[]; result: string; steps: string; missing?: string | null }[],
  deckNames: string[],
  binderNames: string[],
): ComboFind[] {
  const deck = new Map(deckNames.map((n) => [n.toLowerCase(), n]))
  const binder = new Map(binderNames.map((n) => [n.toLowerCase(), n]))
  const out: ComboFind[] = []
  for (const combo of raw) {
    const cards: ComboCard[] = []
    let grounded = true
    for (const name of combo.cards) {
      const key = name.trim().toLowerCase()
      if (deck.has(key)) cards.push({ name: deck.get(key) as string, where: 'deck' })
      else if (binder.has(key)) cards.push({ name: binder.get(key) as string, where: 'binder' })
      else {
        grounded = false
        break
      }
    }
    if (!grounded || cards.length < 2) continue
    const missing = (combo.missing ?? '').trim() || null
    // A "missing" piece the player actually owns isn't missing — drop the flag.
    const missingOwned = missing != null && (deck.has(missing.toLowerCase()) || binder.has(missing.toLowerCase()))
    out.push({ cards, result: combo.result, steps: combo.steps, missing: missingOwned ? null : missing })
  }
  return out
}

const SYSTEM = `You are a Magic: The Gathering Commander combo analyst.
You get a deck list ("deckCards"), the commander, and a list of the player's spare owned cards ("binderCards").
Find, in order of priority:
1. Combo lines and strong synergy engines ALREADY COMPLETE in deckCards (2-5 cards).
2. Lines the player can complete by adding binderCards to the deck.
3. At most 2 famous lines that are exactly ONE card away — put that one card in "missing" (it may be a card the player does not own).
Rules:
- Every card in "cards" MUST appear verbatim in deckCards or binderCards. Only "missing" may name an unowned card.
- Only real, rules-correct interactions. No "good stuff" pairs — a combo/engine must produce a concrete result (infinite X, each-turn value loop, lock, one-shot kill).
- "steps" = how the line executes, 1-2 sentences. "result" = what you get (e.g. "infinite death triggers").
- Be selective: 3-8 findings beats 20 weak ones. If the deck has no real lines, say so in the summary.
Respond with ONLY a JSON object: {"summary": string, "combos": [{"cards": [string], "result": string, "steps": string, "missing": string|null}]}. No prose, no code fences.`

export async function findDeckCombos(
  supabase: SupabaseClient,
  userId: string,
  deckId: string,
  options: { apiKey?: string } = {},
): Promise<{ result?: CombosResult; error?: string }> {
  const apiKey = requireApiKey(options.apiKey)

  const loaded = await loadDeckForScoring(supabase, deckId)
  if (!loaded.found) return { error: 'Deck not found.' }
  const deckNames = loaded.inDeck.map((c) => c.name)

  const { data: deckRow } = await supabase.from('co_decks').select('commander_oracle_id, color_identity').eq('id', deckId).maybeSingle()
  const deckIdentity = (deckRow?.color_identity as string[]) ?? []
  let commander: string | null = null
  if (deckRow?.commander_oracle_id) {
    commander =
      (await loadOracleMeta(supabase, [deckRow.commander_oracle_id as string])).get(deckRow.commander_oracle_id as string)
        ?.name ?? null
  }

  // The spare binder: color-legal free cards, strongest roles first (capped).
  const avail = await loadAvailability(supabase, userId)
  const freeIds = avail.filter((a) => a.freeQty > 0).map((a) => a.oracleId)
  const meta = await loadOracleMeta(supabase, freeIds)
  const inDeck = new Set(loaded.deckOracleIds)
  const binderNames = freeIds
    .filter((id) => !inDeck.has(id))
    .flatMap((id) => {
      const m = meta.get(id)
      if (!m || /basic land/i.test(m.typeLine)) return []
      if (!m.colorIdentity.every((c) => deckIdentity.includes(c))) return []
      return [{ name: m.name, priceEur: m.priceEur ?? 0 }]
    })
    .sort((a, b) => b.priceEur - a.priceEur)
    .slice(0, BINDER_CAP)
    .map((c) => c.name)

  const context = { commander, deckCards: deckNames, binderCards: binderNames }
  const raw = await askClaudeJson(apiKey, SYSTEM, context, ReplySchema, 2500)

  return { result: { summary: raw.summary, combos: groundCombos(raw.combos, deckNames, binderNames) } }
}
