// Mulligan trainer — the player judges a sample hand from their own deck, the
// model grades the call. Grounded: the hand must actually be drawable from the
// deck, and the model gets the deck's real shape (lands, curve, commander).

import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'

import { askClaudeJson, requireApiKey } from './ai-client'
import { loadDeckForScoring, loadOracleMeta } from './deck-loader'

const ReplySchema = z.object({
  verdict: z.enum(['keep', 'mulligan', 'close']),
  agreesWithPlayer: z.boolean(),
  reasoning: z.string(),
})

export type MulliganGrade = z.infer<typeof ReplySchema>

const SYSTEM = `You are a Magic: The Gathering Commander mulligan coach.
You get a 7-card (or fewer) sample hand from the player's own deck, the deck's shape (commander, land count, average mana value, deck size), and the player's keep-or-mulligan call.
Judge the hand for a typical 4-player Commander game (free first mulligan is common, but assume London mulligan rules and no special house rules).
- "verdict": "keep" (clearly keepable), "mulligan" (clearly a mull), or "close" (defensible either way).
- "agreesWithPlayer": whether the player's call matches your verdict ("close" agrees with either call).
- "reasoning": 2-4 sentences — lands + early plays + what the hand actually DOES; name the cards that carry or sink it. Coach, don't lecture.
Respond with ONLY a JSON object: {"verdict": "keep"|"mulligan"|"close", "agreesWithPlayer": boolean, "reasoning": string}. No prose, no code fences.`

export async function gradeMulligan(
  supabase: SupabaseClient,
  deckId: string,
  options: { hand: string[]; choice: 'keep' | 'mulligan'; apiKey?: string },
): Promise<{ result?: MulliganGrade; error?: string }> {
  const apiKey = requireApiKey(options.apiKey)

  const loaded = await loadDeckForScoring(supabase, deckId)
  if (!loaded.found) return { error: 'Deck not found.' }

  // Ground the hand: every card must exist in the deck.
  const deckNames = new Set(loaded.inDeck.map((c) => c.name.toLowerCase()))
  const hand = options.hand.map((n) => n.trim()).filter(Boolean).slice(0, 7)
  if (hand.length < 1) return { error: 'No hand provided.' }
  for (const name of hand) {
    if (!deckNames.has(name.toLowerCase())) return { error: `${name} is not in this deck.` }
  }

  let landCount = 0
  let nonlandCards = 0
  let mvSum = 0
  for (const c of loaded.scoreCards) {
    if (/\bLand\b/.test(c.typeLine)) landCount += c.quantity
    else {
      nonlandCards += c.quantity
      mvSum += c.cmc * c.quantity
    }
  }

  const { data: deckRow } = await supabase.from('co_decks').select('commander_oracle_id').eq('id', deckId).maybeSingle()
  let commander: string | null = null
  if (deckRow?.commander_oracle_id) {
    commander =
      (await loadOracleMeta(supabase, [deckRow.commander_oracle_id as string])).get(deckRow.commander_oracle_id as string)
        ?.name ?? null
  }

  const context = {
    commander,
    deckSize: loaded.scoreCards.reduce((n, c) => n + c.quantity, 0),
    landCount,
    avgManaValue: nonlandCards > 0 ? Math.round((mvSum / nonlandCards) * 10) / 10 : 0,
    hand,
    playerChoice: options.choice,
  }

  const result = await askClaudeJson(apiKey, SYSTEM, context, ReplySchema, 600)
  return { result }
}
