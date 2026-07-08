import Link from 'next/link'
import { redirect } from 'next/navigation'

import { CardName } from '@/components/collection/CardName'
import { CollectionValueChart } from '@/components/collection/CollectionValueChart'
import { ColorPips, Panel, Shell } from '@/components/collection/Shell'
import { listConflicts } from '@/lib/collection/conflicts'
import { getDashboard } from '@/lib/collection/dashboard'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export default async function CollectionDashboardPage() {
  const supabase = await createClient()
  const { data: claims, error: authError } = await supabase.auth.getClaims()
  if (authError || !claims?.claims?.sub) redirect('/auth/login')

  const userId = claims.claims.sub as string
  const [d, conflicts] = await Promise.all([getDashboard(supabase, userId), listConflicts(supabase, userId)])
  const hasCollection = d.uniqueCards > 0

  return (
    <Shell
      title="Your collection"
      lead="Import your binder and decks, then scan for upgrades you already own."
      active="overview"
      actions={
        <div className="flex gap-2">
          <Link href="/collection/import" className="rounded-lg px-4 py-2 text-sm font-medium" style={goldButton}>
            Import collection
          </Link>
          <Link href="/collection/decks/import" className="rounded-lg px-4 py-2 text-sm font-medium" style={ghostButton}>
            Import deck
          </Link>
        </div>
      }
    >
      {hasCollection ? (
        <form action="/collection/search" className="mb-4 flex gap-2">
          <input
            type="search"
            name="q"
            placeholder="Where does a card live? Search binders & decks…"
            className="w-full max-w-md rounded-lg px-3 py-2 text-sm outline-none"
            style={{ border: '1px solid rgba(201,154,58,0.3)', background: 'var(--ink-2)', color: 'var(--text)' }}
          />
          <button type="submit" className="rounded-lg px-4 py-2 text-sm font-medium" style={ghostButton}>
            Find
          </button>
        </form>
      ) : null}
      {!hasCollection ? (
        <Panel className="p-8 text-center">
          <p className="font-display text-lg" style={{ color: 'var(--text-bright)' }}>
            No cards yet
          </p>
          <p className="font-rules mx-auto mt-2 max-w-md text-sm" style={{ color: 'var(--text-dim)' }}>
            Export your collection from ManaBox as CSV and import it here. We&apos;ll match every card to its Scryfall
            identity and work out which copies are free versus locked in a deck.
          </p>
          <Link href="/collection/import" className="mt-5 inline-block rounded-lg px-5 py-2 text-sm font-medium" style={goldButton}>
            Import a ManaBox CSV
          </Link>
        </Panel>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Collection value" value={`€${d.collectionValueEur.toLocaleString()}`} accent />
          <Stat label="Total cards" value={d.totalCards.toLocaleString()} />
          <Stat label="Unique cards" value={d.uniqueCards.toLocaleString()} />
          <Stat label="Free copies" value={d.freeCopies.toLocaleString()} hint="in your binder" />
          <Stat label="Decks" value={d.deckCount.toLocaleString()} />
          <Stat label="Avg power" value={d.avgPower == null ? '—' : d.avgPower.toFixed(1)} hint="/10" />
        </div>
      )}

      {d.valueHistory.length >= 2 ? (
        <section className="mt-10">
          <div className="mb-3 flex items-end justify-between">
            <h2 className="font-display text-xl" style={{ color: 'var(--text-bright)' }}>
              Collection value
            </h2>
            <span className="text-sm" style={{ color: 'var(--text-faint)' }}>
              one point per import · today&apos;s prices close the line
            </span>
          </div>
          <Panel className="p-4">
            <CollectionValueChart points={d.valueHistory} />
          </Panel>
        </section>
      ) : hasCollection ? (
        <p className="mt-3 text-xs" style={{ color: 'var(--text-faint)' }}>
          Value history builds from your next collection import — each import adds a point to the value-over-time chart.
        </p>
      ) : null}

      {d.freeStaples.length > 0 ? (
        <section className="mt-10">
          <div className="mb-3 flex items-end justify-between">
            <h2 className="font-display text-xl" style={{ color: 'var(--text-bright)' }}>
              Free staples
            </h2>
            <span className="text-sm" style={{ color: 'var(--text-faint)' }}>
              strong cards sitting unused in your binder
            </span>
          </div>
          <Panel className="divide-y p-0" >
            {d.freeStaples.map((s) => (
              <Link
                key={s.oracleId}
                href={`/collection/search?q=${encodeURIComponent(s.name)}`}
                className="flex items-center justify-between px-4 py-2.5 hover:bg-[rgba(201,154,58,0.06)]"
                style={{ borderColor: 'rgba(201,154,58,0.12)' }}
              >
                <div className="flex items-center gap-2">
                  <CardName name={s.name} className="font-display text-sm" style={{ color: 'var(--text-bright)' }} />
                  <span className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-faint)', border: '1px solid rgba(201,154,58,0.25)' }}>
                    {s.tag.replace(/_/g, ' ')}
                  </span>
                  {s.binderNames && s.binderNames.length > 0 ? (
                    <span className="text-xs" style={{ color: 'var(--text-faint)' }}>
                      📒 {s.binderNames.join(', ')}
                    </span>
                  ) : null}
                </div>
                <span className="text-xs" style={{ color: 'var(--text-faint)' }}>
                  {s.priceEur != null ? `€${s.priceEur.toFixed(2)}` : ''}
                </span>
              </Link>
            ))}
          </Panel>
        </section>
      ) : null}

      {conflicts.length > 0 ? (
        <section className="mt-10">
          <Link href="/collection/advisor">
            <Panel className="flex items-center justify-between gap-4 p-4 transition-transform hover:scale-[1.005]">
              <div className="flex items-center gap-3">
                <span className="font-display text-2xl" style={{ color: 'var(--warn)' }}>
                  {conflicts.length}
                </span>
                <div>
                  <div className="font-display text-sm" style={{ color: 'var(--text-bright)' }}>
                    {conflicts.length === 1 ? 'Card is' : 'Cards are'} claimed by more decks than you own copies
                  </div>
                  <div className="font-rules text-xs" style={{ color: 'var(--text-dim)' }}>
                    Pick which deck keeps each one, or buy another copy.
                  </div>
                </div>
              </div>
              <span className="shrink-0 text-sm" style={{ color: 'var(--warn)' }}>
                Resolve →
              </span>
            </Panel>
          </Link>
        </section>
      ) : null}

      <section className="mt-10">
        <div className="mb-3 flex items-end justify-between">
          <h2 className="font-display text-xl" style={{ color: 'var(--text-bright)' }}>
            Decks
          </h2>
          <Link href="/collection/decks/import" className="text-sm hover:underline" style={{ color: 'var(--text-dim)' }}>
            + Import a deck
          </Link>
        </div>

        {d.decks.length === 0 ? (
          <Panel className="p-6 text-center">
            <p className="font-rules mx-auto max-w-md text-sm" style={{ color: 'var(--text-dim)' }}>
              No decks yet. Paste a Moxfield or Archidekt link — we&apos;ll analyse it and find upgrades sitting in your
              binder.
            </p>
            <Link href="/collection/decks/import" className="mt-4 inline-block rounded-lg px-5 py-2 text-sm font-medium" style={hasCollection ? goldButton : ghostButton}>
              Import a deck
            </Link>
          </Panel>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {d.decks.map((deck) => (
              <Link key={deck.id} href={`/collection/decks/${deck.id}`}>
                <Panel className="flex items-center justify-between p-4 transition-transform hover:scale-[1.01]">
                  <div className="min-w-0">
                    <div className="truncate font-display text-base" style={{ color: 'var(--text-bright)' }}>
                      {deck.name}
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <ColorPips colors={deck.colorIdentity} />
                      <UpgradeHint free={deck.freeUpgrades} occupied={deck.occupiedUpgrades} />
                    </div>
                  </div>
                  <PowerBadge score={deck.power} />
                </Panel>
              </Link>
            ))}
          </div>
        )}
      </section>

      {d.imports.length > 0 ? (
        <section className="mt-10">
          <h2 className="mb-3 font-display text-xl" style={{ color: 'var(--text-bright)' }}>
            Import history
          </h2>
          <Panel className="divide-y p-0">
            {d.imports.map((imp) => (
              <div key={imp.id} className="flex items-center justify-between px-4 py-2.5" style={{ borderColor: 'rgba(201,154,58,0.12)' }}>
                <div className="min-w-0">
                  <span className="font-display text-sm" style={{ color: 'var(--text)' }}>
                    {imp.kind === 'deck' ? 'Deck' : 'Collection'}
                  </span>
                  <span className="ml-2 text-xs" style={{ color: 'var(--text-faint)' }}>
                    {imp.source}
                    {imp.filename ? ` · ${imp.filename}` : ''}
                  </span>
                </div>
                <span className="shrink-0 text-xs" style={{ color: 'var(--text-faint)' }}>
                  {imp.rowsMatched ?? 0} matched
                  {imp.rowsUnmatched ? `, ${imp.rowsUnmatched} unmatched` : ''} · {formatDate(imp.createdAt)}
                </span>
              </div>
            ))}
          </Panel>
        </section>
      ) : null}
    </Shell>
  )
}

function formatDate(iso: string): string {
  // Stable, locale-independent YYYY-MM-DD (avoids server/client hydration drift).
  return iso.slice(0, 10)
}

function Stat({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: boolean }) {
  return (
    <Panel className="p-4">
      <div className="font-display text-2xl" style={{ color: accent ? 'var(--gold-bright)' : 'var(--text-bright)' }}>
        {value}
      </div>
      <div className="mt-1 text-xs uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
        {label}
      </div>
      {hint ? (
        <div className="text-xs" style={{ color: 'var(--text-faint)' }}>
          {hint}
        </div>
      ) : null}
    </Panel>
  )
}

// Cached scan verdict per deck: gold when upgrades are waiting, quiet when the
// deck is up to date, nothing when it was never scanned (no fake certainty).
function UpgradeHint({ free, occupied }: { free: number | null; occupied: number | null }) {
  if (free == null) return null
  if (free > 0) {
    return (
      <span className="rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ color: 'var(--gold-bright)', border: '1px solid rgba(201,154,58,0.45)' }}>
        {free} upgrade{free === 1 ? '' : 's'} ready
      </span>
    )
  }
  if ((occupied ?? 0) > 0) {
    return (
      <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ color: 'var(--text-faint)', border: '1px solid rgba(201,154,58,0.2)' }}>
        {occupied} in other decks
      </span>
    )
  }
  return (
    <span className="text-[10px]" style={{ color: 'var(--text-faint)' }}>
      up to date
    </span>
  )
}

function PowerBadge({ score }: { score: number | null }) {
  return (
    <div className="shrink-0 text-right">
      <div className="font-display text-2xl" style={{ color: score == null ? 'var(--text-faint)' : 'var(--gold-bright)' }}>
        {score == null ? '—' : score.toFixed(1)}
      </div>
      <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
        power
      </div>
    </div>
  )
}

const goldButton = {
  background: 'linear-gradient(150deg, var(--gold-bright), var(--frame-gold))',
  color: '#1c1407',
}
const ghostButton = {
  border: '1px solid rgba(201,154,58,0.4)',
  color: 'var(--text)',
}
