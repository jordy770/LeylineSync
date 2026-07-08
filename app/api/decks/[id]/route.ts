import { NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'

// PATCH  /api/decks/:id  { name }  — rename a collection deck.
// DELETE /api/decks/:id            — delete it; co_deck_cards and
//   co_deck_analyses cascade (mig 364), which frees the physical cards for
//   other decks automatically. RLS scopes both to the owner.

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: auth, error: authError } = await supabase.auth.getClaims()
  if (authError || !auth?.claims?.sub) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  const { id: deckId } = await params

  let body: { name?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }
  const name = (body.name ?? '').trim()
  if (!name) return NextResponse.json({ error: 'A deck name is required.' }, { status: 400 })
  if (name.length > 120) return NextResponse.json({ error: 'That name is too long (120 max).' }, { status: 400 })

  const { data, error } = await supabase
    .from('co_decks')
    .update({ name, updated_at: new Date().toISOString() })
    .eq('id', deckId)
    .select('id')
    .maybeSingle()
  if (error) return NextResponse.json({ error: `Rename failed: ${error.message}` }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Deck not found.' }, { status: 404 })

  return NextResponse.json({ ok: true, name })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: auth, error: authError } = await supabase.auth.getClaims()
  if (authError || !auth?.claims?.sub) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  const { id: deckId } = await params

  const { data, error } = await supabase.from('co_decks').delete().eq('id', deckId).select('id').maybeSingle()
  if (error) return NextResponse.json({ error: `Delete failed: ${error.message}` }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Deck not found.' }, { status: 404 })

  return NextResponse.json({ ok: true })
}
