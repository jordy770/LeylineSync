import { NextResponse } from 'next/server'

import { analyzeDeck } from '@/lib/collection/analyze-deck'
import { loadOracleMeta } from '@/lib/collection/deck-loader'
import { createClient } from '@/lib/supabase/server'

// POST /api/decks/:id/commander  { oracleId }
// Set (or change) a deck's commander after the fact — the rescue for text
// imports whose list had no "Commander" header. Flags the chosen card on
// co_deck_cards, updates commander_oracle_id + color_identity (a legal deck's
// identity equals its commander's) and re-scores. RLS scopes every write.

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: auth, error: authError } = await supabase.auth.getClaims()
  if (authError || !auth?.claims?.sub) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  const { id: deckId } = await params

  let body: { oracleId?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }
  if (!body.oracleId) {
    return NextResponse.json({ error: 'oracleId is required.' }, { status: 400 })
  }

  const { data: deck } = await supabase.from('co_decks').select('id').eq('id', deckId).maybeSingle()
  if (!deck) return NextResponse.json({ error: 'Deck not found.' }, { status: 404 })

  const { data: cardRow } = await supabase
    .from('co_deck_cards')
    .select('oracle_id')
    .eq('deck_id', deckId)
    .eq('oracle_id', body.oracleId)
    .maybeSingle()
  if (!cardRow) return NextResponse.json({ error: 'That card is not in this deck.' }, { status: 404 })

  const meta = await loadOracleMeta(supabase, [body.oracleId])
  const identity = meta.get(body.oracleId)?.colorIdentity ?? []

  const { error: clearError } = await supabase
    .from('co_deck_cards')
    .update({ is_commander: false })
    .eq('deck_id', deckId)
    .eq('is_commander', true)
  if (clearError) return NextResponse.json({ error: `Could not clear the old commander: ${clearError.message}` }, { status: 500 })

  const { error: setError } = await supabase
    .from('co_deck_cards')
    .update({ is_commander: true })
    .eq('deck_id', deckId)
    .eq('oracle_id', body.oracleId)
  if (setError) return NextResponse.json({ error: `Could not set the commander: ${setError.message}` }, { status: 500 })

  const { error: deckError } = await supabase
    .from('co_decks')
    .update({
      commander_oracle_id: body.oracleId,
      partner_oracle_id: null,
      color_identity: identity,
      updated_at: new Date().toISOString(),
    })
    .eq('id', deckId)
  if (deckError) return NextResponse.json({ error: `Could not update the deck: ${deckError.message}` }, { status: 500 })

  // Identity/commander changed → the cached score is stale (best-effort refresh).
  await analyzeDeck(supabase, deckId, { persist: true }).catch(() => {})

  return NextResponse.json({ ok: true, colorIdentity: identity })
}
