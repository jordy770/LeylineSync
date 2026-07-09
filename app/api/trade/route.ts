import { NextResponse } from 'next/server'

import { AiNotConfiguredError } from '@/lib/collection/ai-client'
import { requireAiCredit } from '@/lib/collection/ai-gate'
import { buildTradePackage } from '@/lib/collection/ai-trade'
import { createClient } from '@/lib/supabase/server'

// POST /api/trade  { want: string, targetValueEur?: number }
// Premium trade-package builder — a fair offer assembled from the player's own
// free binder cards at OUR prices (totals recomputed server-side).

const TRADE_MONTHLY_LIMIT = 20

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data, error: authError } = await supabase.auth.getClaims()
  if (authError || !data?.claims?.sub) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  const userId = data.claims.sub as string

  let body: { want?: string; targetValueEur?: number | null }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }
  if (!body.want || typeof body.want !== 'string') {
    return NextResponse.json({ error: 'Say what you want to trade for.' }, { status: 400 })
  }

  const gate = await requireAiCredit(supabase, 'trade_builder', TRADE_MONTHLY_LIMIT)
  if (gate) return gate

  try {
    const outcome = await buildTradePackage(supabase, userId, {
      want: body.want,
      targetValueEur: typeof body.targetValueEur === 'number' ? body.targetValueEur : null,
    })
    if (outcome.error) return NextResponse.json({ error: outcome.error }, { status: 422 })
    return NextResponse.json(outcome.result)
  } catch (err) {
    if (err instanceof AiNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 501 })
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Trade build failed' }, { status: 502 })
  }
}
