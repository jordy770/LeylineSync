import { NextResponse } from 'next/server'

import { scanDeckUpgrades } from '@/lib/collection/upgrade-scanner'
import { createClient } from '@/lib/supabase/server'

// GET /api/decks/:id/upgrades
// Returns: { deckId, power, free[], occupied[] } | { error }
//
// Scores the deck, derives its needs, and proposes free (binder) + occupied
// (locked-in-another-deck) upgrades from the signed-in user's collection. RLS
// scopes every read to the caller.

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data, error: authError } = await supabase.auth.getClaims()
  if (authError || !data?.claims?.sub) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  const userId = data.claims.sub as string
  const { id: deckId } = await params

  let outcome
  try {
    outcome = await scanDeckUpgrades(supabase, userId, deckId)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected scan error'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  if (outcome.error) {
    return NextResponse.json({ error: outcome.error }, { status: 404 })
  }

  // Leave the headline counts behind on the analysis row (mig 380) so the
  // dashboard can show "N upgrades ready" without re-running the scanner.
  // Best-effort: a cache write must never fail the scan response.
  const r = outcome.result
  if (r) {
    await supabase
      .from('co_deck_analyses')
      .upsert({
        deck_id: deckId,
        power_score: r.power.power,
        free_upgrades: r.free.length,
        occupied_upgrades: r.occupied.length,
        scanned_at: new Date().toISOString(),
      })
      .then(undefined, () => {})
  }

  return NextResponse.json(outcome.result)
}
