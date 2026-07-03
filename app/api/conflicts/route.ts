import { NextResponse } from 'next/server'

import { listConflicts } from '@/lib/collection/conflicts'
import { createClient } from '@/lib/supabase/server'

// GET /api/conflicts → cards committed to more decks than the player owns copies of.

export async function GET() {
  const supabase = await createClient()
  const { data, error: authError } = await supabase.auth.getClaims()
  if (authError || !data?.claims?.sub) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  const userId = data.claims.sub as string

  try {
    const conflicts = await listConflicts(supabase, userId)
    return NextResponse.json({ conflicts })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Conflict lookup failed' }, { status: 500 })
  }
}
