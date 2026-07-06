import { NextResponse } from 'next/server'

import { analyzeDeck } from '@/lib/collection/analyze-deck'
import { removeCardFromDeck } from '@/lib/collection/deck-mutations'
import { createClient } from '@/lib/supabase/server'

// POST /api/collection/resolve-conflict  { oracleId, deckId }
// One-click conflict resolution: release the card from the chosen deck (the
// other decks keep their claim). Re-scores the touched deck. RLS scopes writes.

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: auth, error: authError } = await supabase.auth.getClaims()
  if (authError || !auth?.claims?.sub) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  let body: { oracleId?: string; deckId?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }
  if (!body.oracleId || !body.deckId) {
    return NextResponse.json({ error: 'oracleId and deckId are required.' }, { status: 400 })
  }

  const removed = await removeCardFromDeck(supabase, body.deckId, body.oracleId)
  if (!removed) {
    return NextResponse.json({ error: 'That card is not in the chosen deck.' }, { status: 404 })
  }
  await analyzeDeck(supabase, body.deckId, { persist: true })

  return NextResponse.json({ ok: true })
}
