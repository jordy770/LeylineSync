import { NextResponse } from 'next/server'

import { getPullList } from '@/lib/collection/pull-list'
import { createClient } from '@/lib/supabase/server'

// GET /api/decks/:id/pull-list
// Returns: { groups: [{binder, cards:[{name,need,have}]}], missing: [{name,need,inDecks}] } | { error }
// The physical gathering checklist: binder → alphabetical. RLS scopes reads.

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data, error: authError } = await supabase.auth.getClaims()
  if (authError || !data?.claims?.sub) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  const { id: deckId } = await params

  const { result, error } = await getPullList(supabase, data.claims.sub as string, deckId)
  if (error) return NextResponse.json({ error }, { status: 404 })
  return NextResponse.json(result)
}
