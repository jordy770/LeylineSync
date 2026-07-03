import { redirect } from 'next/navigation'

import { DeckImportForm } from '@/components/collection/DeckImportForm'
import { Shell } from '@/components/collection/Shell'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export default async function DeckImportPage() {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getClaims()
  if (error || !data?.claims?.sub) redirect('/auth/login')

  return (
    <Shell title="Import a deck" lead="Paste a Moxfield, Archidekt or plain-text decklist to analyse and scan it.">
      <DeckImportForm />
    </Shell>
  )
}
