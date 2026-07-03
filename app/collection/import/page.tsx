import { redirect } from 'next/navigation'

import { ImportWizard } from '@/components/collection/ImportWizard'
import { Shell } from '@/components/collection/Shell'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export default async function CollectionImportPage() {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getClaims()
  if (error || !data?.claims?.sub) redirect('/auth/login')

  return (
    <Shell title="Import collection" lead="Upload a ManaBox CSV export. Every row is matched to its Scryfall identity.">
      <ImportWizard />
    </Shell>
  )
}
