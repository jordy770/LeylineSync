import { NextResponse } from 'next/server'

import { locateCards } from '@/lib/collection/locator'
import { createClient } from '@/lib/supabase/server'

// GET /api/collection/search?q=…&free=1&color=G&type=creature
// JSON twin of the /collection/search page — powers its instant (as-you-type)
// results. Returns: { results: LocatedCard[] } | { error }

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data, error: authError } = await supabase.auth.getClaims()
  if (authError || !data?.claims?.sub) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  const userId = data.claims.sub as string

  const url = new URL(request.url)
  const q = (url.searchParams.get('q') ?? '').trim()
  const freeOnly = url.searchParams.get('free') === '1'
  const color = url.searchParams.get('color')
  const type = url.searchParams.get('type')

  if (!q) return NextResponse.json({ results: [] })

  try {
    const results = await locateCards(supabase, userId, q, { freeOnly, color, type })
    return NextResponse.json({ results })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Search failed' }, { status: 500 })
  }
}
