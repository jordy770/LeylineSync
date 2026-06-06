import { redirect } from 'next/navigation'
import { Suspense } from 'react'

import CardBehaviorEditor from '@/components/CardBehaviorEditor'
import { createClient } from '@/lib/supabase/server'

export default function CardBehaviorPage({
  searchParams,
}: {
  searchParams: Promise<{ card?: string }>
}) {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 p-4 md:p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">Card behavior authoring</h1>
        <p className="text-sm text-muted-foreground">
          Attach a validated behavior script to a catalog card. Scripts are stored on{' '}
          <code className="font-mono">cards.script</code> and survive Scryfall reimports. If the
          representative printing for an oracle changes, use “Relink scripts” to re-attach.
        </p>
      </header>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <CardBehaviorContent searchParams={searchParams} />
      </Suspense>
    </div>
  )
}

async function CardBehaviorContent({
  searchParams,
}: {
  searchParams: Promise<{ card?: string }>
}) {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getClaims()

  if (error || !data?.claims) {
    redirect('/auth/login')
  }

  const params = await searchParams
  const initialCardId = typeof params?.card === 'string' ? params.card : undefined

  return <CardBehaviorEditor initialCardId={initialCardId} />
}
