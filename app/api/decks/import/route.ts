import { NextResponse } from 'next/server'

import { fetchDecklistFromUrl } from '@/lib/collection/fetch-decklist'
import { importDeck } from '@/lib/collection/import-deck'
import { createClient } from '@/lib/supabase/server'

// POST /api/decks/import
//   JSON:            { text: <decklist>, name?, source? }  OR  { url: <moxfield/archidekt link>, name? }
//   multipart/form:  { file: <.txt>, name?, source? }
// Returns: DeckImportResult | { error }
//
// Parses a Moxfield / Archidekt / plain-txt decklist (pasted, uploaded, or fetched
// from a deck URL), matches each line to a Scryfall oracle_id, and creates a
// co_decks row + its cards for the signed-in user.

const MAX_BYTES = 2 * 1024 * 1024 // a 100-card list is a few KB; 2 MB is generous.

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data, error: authError } = await supabase.auth.getClaims()
  if (authError || !data?.claims?.sub) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  const userId = data.claims.sub as string

  let text = ''
  let name: string | null = null
  let source: string | null = null
  let sourceUrl: string | null = null

  const contentType = request.headers.get('content-type') ?? ''
  try {
    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData()
      const entry = form.get('file')
      if (entry instanceof File) {
        if (entry.size > MAX_BYTES) {
          return NextResponse.json({ error: 'File too large (max 2 MB).' }, { status: 413 })
        }
        text = await entry.text()
        name = (form.get('name') as string) || entry.name.replace(/\.[^.]+$/, '')
      }
      source = (form.get('source') as string) || 'txt'
    } else {
      const body = (await request.json()) as { text?: string; name?: string; source?: string; url?: string }
      if (body.url) {
        const fetched = await fetchDecklistFromUrl(body.url)
        text = fetched.text
        name = body.name || fetched.name
        source = fetched.source
        sourceUrl = body.url.trim()
      } else {
        text = body.text ?? ''
        name = body.name ?? null
        source = body.source ?? null
      }
    }
  } catch (err) {
    // Surface URL-fetch problems (private deck, site blocked, bad link) clearly.
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Invalid request body.' }, { status: 400 })
  }

  if (!text.trim()) {
    return NextResponse.json({ error: 'No decklist provided.' }, { status: 400 })
  }
  if (text.length > MAX_BYTES) {
    return NextResponse.json({ error: 'Decklist too large (max 2 MB).' }, { status: 413 })
  }

  let outcome
  try {
    outcome = await importDeck(supabase, userId, text, { name, source, sourceUrl })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected import error'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  if (outcome.error) {
    return NextResponse.json({ error: outcome.error, ...outcome.result }, { status: 422 })
  }

  return NextResponse.json(outcome.result)
}
