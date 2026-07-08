import { NextResponse } from 'next/server'

import { AiNotConfiguredError, recommendDeckUpgrades } from '@/lib/collection/ai-recommend'
import { createClient } from '@/lib/supabase/server'

// POST /api/decks/:id/recommend
// Body: { budget?: number | null }
// Returns: { summary, picks[] } | { error, code? }
//
// The AI deck doctor ranks + explains upgrades the deterministic scanner already
// produced (grounded — no invented cards). PREMIUM: every run consumes a credit
// via consume_ai_credit (mig 382) — server-side, so the paywall and the monthly
// quota can't be bypassed. The API key never leaves the server.

const DOCTOR_MONTHLY_LIMIT = 20

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data, error: authError } = await supabase.auth.getClaims()
  if (authError || !data?.claims?.sub) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  const userId = data.claims.sub as string
  const { id: deckId } = await params

  const { data: credit, error: creditError } = await supabase.rpc('consume_ai_credit', {
    p_feature: 'deck_doctor',
    p_limit: DOCTOR_MONTHLY_LIMIT,
  })
  if (creditError) {
    return NextResponse.json({ error: `Credit check failed: ${creditError.message}` }, { status: 500 })
  }
  if (!credit?.allowed) {
    if (credit?.reason === 'premium_required') {
      return NextResponse.json(
        { error: 'The AI Deck Doctor is a premium feature.', code: 'premium_required' },
        { status: 402 },
      )
    }
    return NextResponse.json(
      {
        error: `Monthly AI limit reached (${credit?.used ?? '?'}/${credit?.limit ?? DOCTOR_MONTHLY_LIMIT}) — resets next month.`,
        code: 'quota_exceeded',
      },
      { status: 429 },
    )
  }

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
