import { NextResponse } from 'next/server'

import { generateDeckProposal } from '@/lib/collection/deck-generator'
import { findGapBuys, loadCommanderCandidate, loadOwnedOracleCards } from '@/lib/collection/commander-suggest-data'
import { createClient } from '@/lib/supabase/server'

// POST /api/collection/commanders/generate  body: { oracleId, freeOnly } → { proposal: DeckProposal & { gaps } }
// Deterministic 99-card deck proposal for a chosen commander, plus cheap "gap buy"
// suggestions for buckets the collection came up short on. No LLM.

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data, error: authError } = await supabase.auth.getClaims()
  if (authError || !data?.claims?.sub) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  const userId = data.claims.sub as string

  const body = await request.json().catch(() => null)
  const oracleId = typeof body?.oracleId === 'string' ? body.oracleId : null
  if (!oracleId) {
    return NextResponse.json({ error: 'oracleId is required' }, { status: 400 })
  }
  const freeOnly = body?.freeOnly !== false

  try {
    const candidate = await loadCommanderCandidate(supabase, userId, oracleId)
    if (!candidate) {
      return NextResponse.json({ error: 'Commander not found' }, { status: 404 })
    }

    const collection = await loadOwnedOracleCards(supabase, userId)
    const proposal = generateDeckProposal(candidate, collection, { freeOnly })
    const buysByBucket = await findGapBuys(supabase, userId, candidate.colorIdentity, proposal.gapBuckets)
    const buysMap = new Map(buysByBucket.map((g) => [g.bucket, g.buys]))
    // findGapBuys skips 'creatures'/'filler' (no co_card_tags entry to shop) — those
    // buckets still surface in `gaps` with shortfall intact, just an empty buys list.
    const gaps = proposal.gapBuckets.map(({ bucket, shortfall }) => ({
      bucket,
      shortfall,
      buys: buysMap.get(bucket) ?? [],
    }))

    return NextResponse.json({ proposal: { ...proposal, gaps } })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Deck generation failed' }, { status: 500 })
  }
}
