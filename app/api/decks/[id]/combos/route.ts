import { NextResponse } from 'next/server'

import { AiNotConfiguredError } from '@/lib/collection/ai-client'
import { findDeckCombos } from '@/lib/collection/ai-combos'
import { requireAiCredit } from '@/lib/collection/ai-gate'
import { createClient } from '@/lib/supabase/server'

// POST /api/decks/:id/combos — premium: which combo lines does this deck (and
// the binder) already contain, and what is one card away? Grounded: only cards
// the player owns may appear in a line (see ai-combos groundCombos).

const COMBOS_MONTHLY_LIMIT = 20

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data, error: authError } = await supabase.auth.getClaims()
  if (authError || !data?.claims?.sub) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  const userId = data.claims.sub as string
  const { id: deckId } = await params

  const gate = await requireAiCredit(supabase, 'combos', COMBOS_MONTHLY_LIMIT)
  if (gate) return gate

  try {
    const outcome = await findDeckCombos(supabase, userId, deckId)
    if (outcome.error) return NextResponse.json({ error: outcome.error }, { status: 404 })
    return NextResponse.json(outcome.result)
  } catch (err) {
    if (err instanceof AiNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 501 })
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Combo scan failed' }, { status: 502 })
  }
}
