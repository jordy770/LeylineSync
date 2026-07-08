import { NextResponse } from 'next/server'

import { applySwap } from '@/lib/collection/apply-swap'
import { createClient } from '@/lib/supabase/server'

// POST /api/decks/:id/swaps
// Body: { inOracleId?: string | null, outOracleId?: string | null } — at least one.
// Applies a free upgrade — cut OUT (if given), add IN (if given). A remove-only
// call (out without in) is the undo of an add-only upgrade. RLS scopes writes
// to the owner.

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data, error: authError } = await supabase.auth.getClaims()
  if (authError || !data?.claims?.sub) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  const userId = data.claims.sub as string
  const { id: deckId } = await params

  let body: { inOracleId?: string | null; outOracleId?: string | null }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!body.inOracleId && !body.outOracleId) {
    return NextResponse.json({ error: 'inOracleId or outOracleId is required' }, { status: 400 })
  }

  let outcome
  try {
    outcome = await applySwap(supabase, userId, deckId, body.outOracleId ?? null, body.inOracleId ?? null)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Swap failed' }, { status: 500 })
  }

  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: 422 })
  return NextResponse.json({ ok: true })
}
