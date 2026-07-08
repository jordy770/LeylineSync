import { redirect } from 'next/navigation'

import { RulePlayground } from '@/components/collection/RulePlayground'
import { Shell } from '@/components/collection/Shell'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

// Rule Playground — hidden developer page (not in the sub-nav): pick any card
// and see exactly what the Intelligence Engine concludes and WHY (which rules
// fired, with oracle-text evidence) plus commander synergies. The debugging
// surface for the rule registry.

export default async function PlaygroundPage() {
  const supabase = await createClient()
  const { data: claims, error } = await supabase.auth.getClaims()
  if (error || !claims?.claims?.sub) redirect('/auth/login')

  return (
    <Shell
      title="Rule Playground"
      lead="Developer tool: classify any card with the Intelligence Engine and see exactly which rules fired and why."
    >
      <RulePlayground />
    </Shell>
  )
}
