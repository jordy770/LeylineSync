import { NextResponse } from 'next/server'

import { AiNotConfiguredError } from '@/lib/collection/ai-client'
import { requireAiCredit } from '@/lib/collection/ai-gate'
import { gradeMulligan } from '@/lib/collection/ai-mulligan'
import { createClient } from '@/lib/supabase/server'

// POST /api/decks/:id/mulligan  { hand: string[], choice: 'keep'|'mulligan' }
// Premium mulligan trainer — grades the player's call on a sample hand drawn
// from their own deck. Higher monthly limit: it's a drill, not a report.

const MULLIGAN_MONTHLY_LIMIT = 100

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data, error: authError } = await supabase.auth.getClaims()
  if (authError || !data?.claims?.sub) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  const { id: deckId } = await params

  let body: { hand?: string[]; choice?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }
  if (!Array.isArray(body.hand) || body.hand.length === 0 || (body.choice !== 'keep' && body.choice !== 'mulligan')) {
    return NextResponse.json({ error: 'hand[] and choice (keep|mulligan) are required.' }, { status: 400 })
  }

  const gate = await requireAiCredit(supabase, 'mulligan', MULLIGAN_MONTHLY_LIMIT)
  if (gate) return gate

  try {
    const outcome = await gradeMulligan(supabase, deckId, { hand: body.hand.map(String), choice: body.choice })
    if (outcome.error) return NextResponse.json({ error: outcome.error }, { status: 404 })
    return NextResponse.json(outcome.result)
  } catch (err) {
    if (err instanceof AiNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 501 })
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Grading failed' }, { status: 502 })
  }
}
