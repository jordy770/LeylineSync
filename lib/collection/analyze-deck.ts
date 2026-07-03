// Deck analysis: load → score → (optionally) cache the result in co_deck_analyses.
// Thin wrapper over the shared loader + pure power score.

import type { SupabaseClient } from '@supabase/supabase-js'

import { loadDeckForScoring } from './deck-loader'
import { computePowerScore } from './power-score'
import type { PowerScore } from './power-score'

export async function analyzeDeck(
  supabase: SupabaseClient,
  deckId: string,
  options: { persist?: boolean } = {},
): Promise<{ power?: PowerScore; error?: string }> {
  const { found, scoreCards } = await loadDeckForScoring(supabase, deckId)
  if (!found) return { error: 'Deck not found.' }

  const power = computePowerScore(scoreCards)

  if (options.persist) {
    await supabase.from('co_deck_analyses').upsert({
      deck_id: deckId,
      power_score: power.power,
      buckets: power.buckets,
      curve: power.curve,
      avg_mv: power.avgMv,
      land_count: power.landCount,
      explanation: power.explanation,
    })
    // Keep the denormalized score on the deck row fresh for list views.
    await supabase.from('co_decks').update({ power_score: power.power }).eq('id', deckId)
  }

  return { power }
}
