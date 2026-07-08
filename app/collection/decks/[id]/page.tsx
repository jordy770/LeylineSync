import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { DeckDetail } from '@/components/collection/DeckDetail'
import { Shell } from '@/components/collection/Shell'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export default async function DeckDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: claims, error: authError } = await supabase.auth.getClaims()
  if (authError || !claims?.claims?.sub) redirect('/auth/login')

  const { data: deck } = await supabase.from('co_decks').select('id, name, color_identity, source, source_url').eq('id', id).single()
  if (!deck) notFound()

  return (
    <Shell
      title={deck.name}
      lead="Power score and upgrades drawn from your own collection."
      actions={
        <Link href="/collection" className="rounded-lg px-4 py-2 text-sm" style={{ border: '1px solid rgba(201,154,58,0.4)', color: 'var(--text)' }}>
          ← Back
        </Link>
      }
    >
      <DeckDetail
        deckId={deck.id as string}
        colorIdentity={(deck.color_identity as string[]) ?? []}
        source={(deck.source as string) ?? null}
        sourceUrl={(deck.source_url as string) ?? null}
      />
    </Shell>
  )
}
