import { NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'

// POST /api/decks/:id/play
// Bridges a Collection Optimizer deck (co_decks) to a PLAYABLE game deck: builds
// the decklist text (Commander section + Deck section) and feeds it through the
// game importer RPC (import_deck_from_text, which captures the commander per
// mig 139). Returns: { deckId, deckName, missing: [{line,name}] } | { error }

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: auth, error: authError } = await supabase.auth.getClaims()
  if (authError || !auth?.claims?.sub) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  const { id: deckId } = await params

  const { data: deck } = await supabase
    .from('co_decks')
    .select('id, name, commander_oracle_id')
    .eq('id', deckId)
    .maybeSingle()
  if (!deck) return NextResponse.json({ error: 'Deck not found.' }, { status: 404 })

  const { data: cards } = await supabase
    .from('co_deck_cards')
    .select('oracle_id, quantity, is_commander')
    .eq('deck_id', deckId)
  if (!cards || cards.length === 0) {
    return NextResponse.json({ error: 'This deck has no cards.' }, { status: 400 })
  }

  const names = new Map<string, string>()
  const oracleIds = cards.map((c) => c.oracle_id)
  for (let i = 0; i < oracleIds.length; i += 100) {
    const { data } = await supabase
      .from('co_card_oracle')
      .select('oracle_id, name')
      .in('oracle_id', oracleIds.slice(i, i + 100))
    for (const m of data ?? []) names.set(m.oracle_id, m.name)
  }

  const commanderOracle = deck.commander_oracle_id
  const lines: string[] = []
  if (commanderOracle && names.has(commanderOracle)) {
    lines.push('Commander', `1 ${names.get(commanderOracle)}`, '', 'Deck')
  }
  for (const card of cards) {
    if (card.oracle_id === commanderOracle) continue // already in the Commander section
    const name = names.get(card.oracle_id)
    if (!name) continue // unresolvable oracle — the game importer would miss it anyway
    lines.push(`${card.quantity} ${name}`)
  }

  const { data: result, error } = await supabase.rpc('import_deck_from_text', {
    p_name: deck.name || 'Collection deck',
    p_decklist: lines.join('\n'),
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    deckId: result?.id ?? null,
    deckName: deck.name,
    missing: result?.missing ?? [],
  })
}
