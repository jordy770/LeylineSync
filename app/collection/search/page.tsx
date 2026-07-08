import { redirect } from 'next/navigation'

import { SearchLive } from '@/components/collection/SearchLive'
import { Shell } from '@/components/collection/Shell'
import { locateCards } from '@/lib/collection/locator'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

// /collection/search?q=…&free=1&color=G&type=creature
// "Where does this card live?" — binders (with counts), decks, free copies.
// The server renders the first results for a deep link; SearchLive takes over
// with instant as-you-type search from there.

const COLORS = ['W', 'U', 'B', 'R', 'G'] as const

export default async function CollectionSearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; free?: string; color?: string; type?: string }>
}) {
  const supabase = await createClient()
  const { data: claims, error } = await supabase.auth.getClaims()
  if (error || !claims?.claims?.sub) redirect('/auth/login')
  const userId = claims.claims.sub as string

  const params = await searchParams
  const q = (params.q ?? '').trim()
  const freeOnly = params.free === '1'
  const color = params.color && COLORS.includes(params.color as (typeof COLORS)[number]) ? params.color : null
  const type = (params.type ?? '').trim() || null

  const [results, { data: deckRows }] = await Promise.all([
    q ? locateCards(supabase, userId, q, { freeOnly, color, type }) : Promise.resolve([]),
    // The user's decks, so a found card can be added right from the results.
    supabase.from('co_decks').select('id, name').eq('user_id', userId).order('updated_at', { ascending: false }),
  ])
  const decks = (deckRows ?? []).map((d) => ({ id: d.id as string, name: d.name as string }))

  return (
    <Shell
      title="Find a card"
      lead="Search your collection: which binder holds it, which decks claim it, and how many copies are free."
      active="search"
    >
      <SearchLive
        initialQ={q}
        initialFree={freeOnly}
        initialColor={color}
        initialType={type}
        initialResults={results}
        decks={decks}
      />
    </Shell>
  )
}
