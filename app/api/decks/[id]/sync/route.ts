import { NextResponse } from 'next/server'

import { fetchDecklistFromUrl } from '@/lib/collection/fetch-decklist'
import { syncDeckFromText } from '@/lib/collection/import-deck'
import { createClient } from '@/lib/supabase/server'

// POST /api/decks/:id/sync
// Re-fetches the deck's stored source URL (Moxfield/Archidekt) and replaces the
// deck's cards with the current list, returning what changed. Only decks that
// were imported from a URL can sync. RLS scopes everything to the owner.

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data, error: authError } = await supabase.auth.getClaims()
  if (authError || !data?.claims?.sub) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  const { id: deckId } = await params

  const { data: deck } = await supabase.from('co_decks').select('id, source_url').eq('id', deckId).maybeSingle()
  if (!deck) return NextResponse.json({ error: 'Deck not found' }, { status: 404 })
  if (!deck.source_url) {
    return NextResponse.json({ error: 'This deck has no source URL to sync from.' }, { status: 422 })
  }

  let text: string
  try {
    const fetched = await fetchDecklistFromUrl(deck.source_url as string)
    text = fetched.text
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Could not fetch the deck.' }, { status: 502 })
  }

  let outcome
  try {
    outcome = await syncDeckFromText(supabase, deckId, text)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Sync failed' }, { status: 500 })
  }
  if (outcome.error) return NextResponse.json({ error: outcome.error }, { status: 422 })
  return NextResponse.json(outcome.result)
}
