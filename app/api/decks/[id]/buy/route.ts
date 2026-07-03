import { NextResponse } from 'next/server'

import { suggestBuys } from '@/lib/collection/buy-suggestions'
import { createClient } from '@/lib/supabase/server'

// GET /api/decks/:id/buy?budget=5   (budget omitted / 0 = no cap)
// Returns: { needs, buys[] } | { error }
// Suggests cards to purchase that fill the deck's needs (not owned, colour-legal).

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data, error: authError } = await supabase.auth.getClaims()
  if (authError || !data?.claims?.sub) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  const userId = data.claims.sub as string
  const { id: deckId } = await params

  const budgetParam = new URL(request.url).searchParams.get('budget')
  const budget = budgetParam && Number(budgetParam) > 0 ? Number(budgetParam) : null

  try {
    const outcome = await suggestBuys(supabase, userId, deckId, budget)
    if (outcome.error) return NextResponse.json({ error: outcome.error }, { status: 404 })
    return NextResponse.json(outcome.result)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Buy lookup failed' }, { status: 500 })
  }
}
