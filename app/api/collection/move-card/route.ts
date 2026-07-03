import { NextResponse } from 'next/server'

import { moveCard } from '@/lib/collection/move-card'
import { createClient } from '@/lib/supabase/server'

// POST /api/collection/move-card
// Body: { oracleId, fromDeckId, toDeckId }
// Reassigns an owned card from one deck to another. RLS scopes both decks to the owner.

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data, error: authError } = await supabase.auth.getClaims()
  if (authError || !data?.claims?.sub) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  const userId = data.claims.sub as string

  let body: { oracleId?: string; fromDeckId?: string; toDeckId?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!body.oracleId || !body.fromDeckId || !body.toDeckId) {
    return NextResponse.json({ error: 'oracleId, fromDeckId and toDeckId are required' }, { status: 400 })
  }

  let outcome
  try {
    outcome = await moveCard(supabase, userId, body.oracleId, body.fromDeckId, body.toDeckId)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Move failed' }, { status: 500 })
  }

  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: 422 })
  return NextResponse.json({ ok: true })
}
