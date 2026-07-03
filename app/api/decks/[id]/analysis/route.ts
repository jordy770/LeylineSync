import { NextResponse } from 'next/server'

import { analyzeDeck } from '@/lib/collection/analyze-deck'
import { createClient } from '@/lib/supabase/server'

// GET /api/decks/:id/analysis  → power score + buckets + curve (cached to co_deck_analyses)
// RLS scopes the deck read to the signed-in owner.

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data, error: authError } = await supabase.auth.getClaims()
  if (authError || !data?.claims?.sub) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  const { id: deckId } = await params

  let outcome
  try {
    outcome = await analyzeDeck(supabase, deckId, { persist: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected analysis error'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  if (outcome.error) {
    return NextResponse.json({ error: outcome.error }, { status: 404 })
  }
  return NextResponse.json(outcome.power)
}
