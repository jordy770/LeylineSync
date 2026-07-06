import Link from 'next/link'
import { redirect } from 'next/navigation'

import { ConflictResolve } from '@/components/collection/ConflictResolve'
import { Panel, Shell } from '@/components/collection/Shell'
import { listConflicts } from '@/lib/collection/conflicts'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export default async function ConflictsPage() {
  const supabase = await createClient()
  const { data: claims, error } = await supabase.auth.getClaims()
  if (error || !claims?.claims?.sub) redirect('/auth/login')
  const userId = claims.claims.sub as string

  const conflicts = await listConflicts(supabase, userId)

  return (
    <Shell
      title="Deck conflicts"
      lead="Cards claimed by more decks than you own copies of — you can't field them all at once."
      actions={
        <Link href="/collection" className="rounded-lg px-4 py-2 text-sm" style={{ border: '1px solid rgba(201,154,58,0.4)', color: 'var(--text)' }}>
          ← Back
        </Link>
      }
    >
      {conflicts.length === 0 ? (
        <Panel className="p-6">
          <p className="font-rules text-sm" style={{ color: 'var(--text-dim)' }}>
            No conflicts — every deck has the copies it needs. Nicely sorted.
          </p>
        </Panel>
      ) : (
        <div className="space-y-2">
          {conflicts.map((c) => (
            <Panel key={c.oracleId} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <div className="font-display text-base" style={{ color: 'var(--text-bright)' }}>
                  {c.name}
                </div>
                <div className="font-rules mt-1 text-sm" style={{ color: 'var(--text-dim)' }}>
                  Wanted by {c.decks.map((d) => d.name).join(', ')}
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <div className="font-display text-lg" style={{ color: 'var(--warn)' }}>
                    {c.ownedQty}/{c.committedQty}
                  </div>
                  <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
                    owned / needed
                  </div>
                </div>
                <a
                  href={`https://scryfall.com/search?q=${encodeURIComponent(`!"${c.name}"`)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg px-3 py-1.5 text-sm"
                  style={{ border: '1px solid rgba(201,154,58,0.4)', color: 'var(--text)' }}
                >
                  Buy a copy ↗
                </a>
              </div>
              <ConflictResolve oracleId={c.oracleId} decks={c.decks} />
            </Panel>
          ))}
        </div>
      )}
    </Shell>
  )
}
