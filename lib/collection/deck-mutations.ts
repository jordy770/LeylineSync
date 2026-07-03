// Low-level deck-card mutations shared by apply-swap and move-card. Quantity-aware
// so multiples (rare in Commander, common in 60-card) decrement before deleting.
// All writes go through the caller's RLS-scoped client (child policy via parent deck).

import type { SupabaseClient } from '@supabase/supabase-js'

export async function addCardToDeck(supabase: SupabaseClient, deckId: string, oracleId: string): Promise<void> {
  const { data: existing, error } = await supabase
    .from('co_deck_cards')
    .select('quantity')
    .eq('deck_id', deckId)
    .eq('oracle_id', oracleId)
    .maybeSingle()
  if (error) throw new Error(`Deck read failed: ${error.message}`)

  if (existing) {
    const { error: upErr } = await supabase
      .from('co_deck_cards')
      .update({ quantity: (existing.quantity as number) + 1 })
      .eq('deck_id', deckId)
      .eq('oracle_id', oracleId)
    if (upErr) throw new Error(`Deck update failed: ${upErr.message}`)
    return
  }

  const { error: insErr } = await supabase.from('co_deck_cards').insert({ deck_id: deckId, oracle_id: oracleId, quantity: 1 })
  if (insErr) throw new Error(`Deck insert failed: ${insErr.message}`)
}

/** Returns false if the card wasn't in the deck to begin with. */
export async function removeCardFromDeck(supabase: SupabaseClient, deckId: string, oracleId: string): Promise<boolean> {
  const { data: existing, error } = await supabase
    .from('co_deck_cards')
    .select('quantity')
    .eq('deck_id', deckId)
    .eq('oracle_id', oracleId)
    .maybeSingle()
  if (error) throw new Error(`Deck read failed: ${error.message}`)
  if (!existing) return false

  const qty = existing.quantity as number
  if (qty > 1) {
    const { error: upErr } = await supabase
      .from('co_deck_cards')
      .update({ quantity: qty - 1 })
      .eq('deck_id', deckId)
      .eq('oracle_id', oracleId)
    if (upErr) throw new Error(`Deck update failed: ${upErr.message}`)
  } else {
    const { error: delErr } = await supabase.from('co_deck_cards').delete().eq('deck_id', deckId).eq('oracle_id', oracleId)
    if (delErr) throw new Error(`Deck delete failed: ${delErr.message}`)
  }
  return true
}
