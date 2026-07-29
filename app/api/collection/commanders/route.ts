import { NextResponse } from 'next/server'

import { scoreCommander } from '@/lib/collection/commander-suggest'
import { loadCommanderCandidate, loadOwnedOracleCards, searchCommanderCatalog } from '@/lib/collection/commander-suggest-data'
import { createClient } from '@/lib/supabase/server'

// GET /api/collection/commanders?q=…              → { results: [{ oracleId, name, typeLine, colorIdentity }] }
// GET /api/collection/commanders?oracleId=…&freeOnly=… → { suggestion: CommanderSuggestion }
// Search + lookup-scoring for the Advisor's "Commanders you can build" section.

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data, error: authError } = await supabase.auth.getClaims()
  if (authError || !data?.claims?.sub) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  const userId = data.claims.sub as string

  const url = new URL(request.url)
  const q = (url.searchParams.get('q') ?? '').trim()
  const oracleId = url.searchParams.get('oracleId')

  if (!q && !oracleId) {
    return NextResponse.json({ error: 'Provide q or oracleId' }, { status: 400 })
  }

  try {
    if (oracleId) {
      const candidate = await loadCommanderCandidate(supabase, userId, oracleId)
      if (!candidate) {
        return NextResponse.json({ error: 'Commander not found' }, { status: 404 })
      }
      const freeOnly = url.searchParams.get('freeOnly') !== 'false'
      const collection = await loadOwnedOracleCards(supabase, userId)
      const suggestion = scoreCommander(candidate, collection, { freeOnly })
      return NextResponse.json({ suggestion })
    }

    const results = await searchCommanderCatalog(supabase, q)
    return NextResponse.json({ results })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Commander lookup failed' }, { status: 500 })
  }
}
