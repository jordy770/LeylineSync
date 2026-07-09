import { NextResponse } from 'next/server'

import { requireAiCredit } from '@/lib/collection/ai-gate'
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

  const gate = await requireAiCredit(supabase, 'deck_doctor', DOCTOR_MONTHLY_LIMIT)
  if (gate) return gate

  let budget: number | null = null
  let goal: string | null = null
  let targetPower: number | null = null
  try {
    const body = (await request.json().catch(() => ({}))) as {
      budget?: number | null
      goal?: string | null
      targetPower?: number | null
    }
    budget = body.budget ?? null
    goal = typeof body.goal === 'string' ? body.goal : null
    targetPower = typeof body.targetPower === 'number' ? body.targetPower : null
  } catch {
    budget = null
  }

  try {
    const outcome = await recommendDeckUpgrades(supabase, userId, deckId, { budget, goal, targetPower })
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
