import { NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'

// POST /api/collection/commanders/start-deck { oracleId, name } → { deckId }
// Creates a fresh co_decks row with the chosen commander already seated — the
// "Start this deck" action from the Advisor's Buildable Commanders section.
// Mirrors the insert/cleanup pattern of lib/collection/import-deck.ts.

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data, error: authError } = await supabase.auth.getClaims()
  if (authError || !data?.claims?.sub) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  const userId = data.claims.sub as string

  const body = await request.json().catch(() => null)
  const oracleId = typeof body?.oracleId === 'string' ? body.oracleId.trim() : ''
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!oracleId) {
    return NextResponse.json({ error: 'oracleId is required' }, { status: 400 })
  }

  const { data: deckRow, error: deckError } = await supabase
    .from('co_decks')
    .insert({ user_id: userId, name: name || 'New deck', commander_oracle_id: oracleId })
    .select('id')
    .single()
  if (deckError || !deckRow) {
    return NextResponse.json({ error: `Could not create the deck: ${deckError?.message ?? 'unknown'}` }, { status: 500 })
  }
  const deckId = deckRow.id as string

  const { error: cardError } = await supabase
    .from('co_deck_cards')
    .insert({ deck_id: deckId, oracle_id: oracleId, quantity: 1, is_commander: true })
  if (cardError) {
    await supabase.from('co_decks').delete().eq('id', deckId)
    return NextResponse.json({ error: `Could not seat the commander: ${cardError.message}` }, { status: 500 })
  }

  return NextResponse.json({ deckId })
}
