import { NextResponse } from 'next/server'

import { importDeckFromContainer, listDeckContainers } from '@/lib/collection/deck-containers'
import { createClient } from '@/lib/supabase/server'

// GET  /api/collection/deck-containers
//   → { containers: DeckContainer[] } — the ManaBox deck containers found in the
//     imported collection (binder_type='deck'), with commander candidates.
//
// POST /api/collection/deck-containers
//   { decks: [{ name, commanderOracleId? }] }
//   → { results: ContainerImportResult[] } — creates a co_decks row per container.

const MAX_DECKS_PER_REQUEST = 50

async function requireUser() {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getClaims()
  if (error || !data?.claims?.sub) return { supabase, userId: null }
  return { supabase, userId: data.claims.sub as string }
}

export async function GET() {
  const { supabase, userId } = await requireUser()
  if (!userId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })

  try {
    const containers = await listDeckContainers(supabase, userId)
    return NextResponse.json({ containers })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not list deck containers'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const { supabase, userId } = await requireUser()
  if (!userId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })

  let body: { decks?: { name?: string; commanderOracleId?: string | null }[] }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const decks = (body.decks ?? []).filter((d) => typeof d.name === 'string' && d.name.trim() !== '')
  if (decks.length === 0) {
    return NextResponse.json({ error: 'No decks selected.' }, { status: 400 })
  }
  if (decks.length > MAX_DECKS_PER_REQUEST) {
    return NextResponse.json({ error: `Too many decks (max ${MAX_DECKS_PER_REQUEST} per import).` }, { status: 400 })
  }

  const results = []
  for (const deck of decks) {
    results.push(await importDeckFromContainer(supabase, userId, deck.name as string, deck.commanderOracleId ?? null))
  }
  return NextResponse.json({ results })
}
