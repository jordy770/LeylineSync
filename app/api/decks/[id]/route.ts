import { NextResponse } from 'next/server'

import { analyzeDeck } from '@/lib/collection/analyze-deck'
import { sanitizeCardLocks } from '@/lib/collection/deck-loader'
import { sanitizeTargetOverrides } from '@/lib/collection/power-score'
import { createClient } from '@/lib/supabase/server'

// PATCH  /api/decks/:id  { name? , targetOverrides? }
//   - name: rename the deck
//   - targetOverrides: per-deck target tuning (mig 384) — an object like
//     {"land": 34, "removal": 12}, or null to reset to the guidelines.
//     Changing targets re-scores the deck (needs/scanner/Doctor follow).
// DELETE /api/decks/:id — delete it; co_deck_cards and co_deck_analyses
//   cascade (mig 364), which frees the physical cards for other decks
//   automatically. RLS scopes both to the owner.

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: auth, error: authError } = await supabase.auth.getClaims()
  if (authError || !auth?.claims?.sub) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  const { id: deckId } = await params

  let body: { name?: string; targetOverrides?: unknown; cardLocks?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }

  if (body.name !== undefined) {
    const name = (body.name ?? '').trim()
    if (!name) return NextResponse.json({ error: 'A deck name is required.' }, { status: 400 })
    if (name.length > 120) return NextResponse.json({ error: 'That name is too long (120 max).' }, { status: 400 })
    patch.name = name
  }

  const tuningTargets = 'targetOverrides' in body
  if (tuningTargets) {
    patch.target_overrides = sanitizeTargetOverrides(body.targetOverrides)
  }

  const tuningLocks = 'cardLocks' in body
  if (tuningLocks) {
    patch.card_locks = sanitizeCardLocks(body.cardLocks)
  }

  if (!('name' in patch) && !tuningTargets && !tuningLocks) {
    return NextResponse.json({ error: 'Nothing to change.' }, { status: 400 })
  }

  const { data, error } = await supabase.from('co_decks').update(patch).eq('id', deckId).select('id').maybeSingle()
  if (error) return NextResponse.json({ error: `Update failed: ${error.message}` }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Deck not found.' }, { status: 404 })

  // New targets shift the score and the needs — refresh the cache (best-effort).
  if (tuningTargets) await analyzeDeck(supabase, deckId, { persist: true }).catch(() => {})

  return NextResponse.json({ ok: true })
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
