import { NextResponse } from 'next/server'

import { AiNotConfiguredError, recommendDeckUpgrades } from '@/lib/collection/ai-recommend'
import { createClient } from '@/lib/supabase/server'

// POST /api/decks/:id/recommend
// Body: { budget?: number | null }
// Returns: { summary, picks[] } | { error }
//
// The AI deck doctor ranks + explains upgrades the deterministic scanner already
// produced (grounded — no invented cards). Gated to signed-in users; the API key
// never leaves the server.

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data, error: authError } = await supabase.auth.getClaims()
  if (authError || !data?.claims?.sub) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  const userId = data.claims.sub as string
  const { id: deckId } = await params

  let budget: number | null = null
  try {
    const body = (await request.json().catch(() => ({}))) as { budget?: number | null }
    budget = body.budget ?? null
  } catch {
    budget = null
  }

  try {
    const outcome = await recommendDeckUpgrades(supabase, userId, deckId, { budget })
    if (outcome.error) return NextResponse.json({ error: outcome.error }, { status: 404 })
    return NextResponse.json(outcome.result)
  } catch (err) {
    if (err instanceof AiNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 501 })
    }
    const message = err instanceof Error ? err.message : 'Recommendation failed'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
