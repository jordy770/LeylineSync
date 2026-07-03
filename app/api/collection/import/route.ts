import { NextResponse } from 'next/server'

import { importManaboxCollection } from '@/lib/collection/import-collection'
import { createClient } from '@/lib/supabase/server'

// POST /api/collection/import
// multipart/form-data: { file: <ManaBox collection CSV> }
// Returns: CollectionImportResult | { error }
//
// Parses the upload, matches each row to a Scryfall oracle_id against
// co_card_printings, and replaces the user's collection snapshot. All DB writes go
// through the user's RLS-scoped client, so the route can only touch the caller's rows.

const MAX_BYTES = 15 * 1024 * 1024 // 15 MB — a very large paper collection is still well under this.

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data, error: authError } = await supabase.auth.getClaims()
  if (authError || !data?.claims?.sub) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  const userId = data.claims.sub as string

  let file: File | null = null
  try {
    const form = await request.formData()
    const entry = form.get('file')
    if (entry instanceof File) file = entry
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data with a "file" field.' }, { status: 400 })
  }

  if (!file) {
    return NextResponse.json({ error: 'No file uploaded. Attach a ManaBox CSV as "file".' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'File too large (max 15 MB).' }, { status: 413 })
  }

  const csvText = await file.text()

  let outcome
  try {
    outcome = await importManaboxCollection(supabase, userId, csvText, file.name || null)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected import error'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  if (outcome.error) {
    return NextResponse.json({ error: outcome.error, ...outcome.result }, { status: 422 })
  }

  return NextResponse.json(outcome.result)
}
