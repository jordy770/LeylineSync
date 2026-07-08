import { NextResponse } from 'next/server'

import { classifyCard, ALL_RULES } from '@/lib/intelligence/card-engine'
import { allCommanderSynergies } from '@/lib/intelligence/commander-profiles'
import { createClient } from '@/lib/supabase/server'

// GET /api/intelligence/classify?name=<card name>
// The Rule Playground's backend: loads the card's oracle identity, runs the
// FULL rule registry, and returns the profile + every rule that fired (with
// evidence) + commander synergies. Pure engine — no AI, no caching.

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: auth, error: authError } = await supabase.auth.getClaims()
  if (authError || !auth?.claims?.sub) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  const name = new URL(request.url).searchParams.get('name')?.trim()
  if (!name || name.length < 2) {
    return NextResponse.json({ error: 'Pass ?name=<card name>.' }, { status: 400 })
  }

  // Exact first, then prefix (DFC front faces), then contains.
  const { data: rows } = await supabase
    .from('co_card_oracle')
    .select('name, type_line, oracle_text, keywords, cmc, color_identity')
    .ilike('name', `%${name}%`)
    .limit(25)
  const exact = (rows ?? []).find((r) => r.name.toLowerCase() === name.toLowerCase())
  const card = exact
    ?? (rows ?? []).find((r) => r.name.toLowerCase().startsWith(`${name.toLowerCase()} //`))
    ?? (rows ?? [])[0]
  if (!card) return NextResponse.json({ error: `No card matches “${name}”.` }, { status: 404 })

  const profile = classifyCard({
    name: card.name,
    typeLine: card.type_line ?? '',
    oracleText: card.oracle_text,
    keywords: card.keywords ?? [],
    cmc: Number(card.cmc ?? 0),
    colorIdentity: card.color_identity ?? [],
  })

  return NextResponse.json({
    card: { name: card.name, typeLine: card.type_line, oracleText: card.oracle_text, cmc: card.cmc },
    profile,
    synergies: allCommanderSynergies(profile),
    ruleCount: ALL_RULES.length,
    suggestions: (rows ?? []).map((r) => r.name).slice(0, 8),
  })
}
