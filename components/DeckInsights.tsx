'use client'

import type { DeckCardLine, LinkedCard, ManaColor } from '@/lib/game/types'
import {
  DECK_MANA_COLORS,
  deckAverageManaValue,
  deckColorIdentityViolations,
  deckColorPips,
  deckLandCount,
  deckManaCurve,
  deckSingletonViolations,
  deckTypeBreakdown,
  commanderDeckLegality,
  type DeckType,
} from '@/lib/game/deck-insights'

const COLOR_DOT: Record<ManaColor, string> = {
  W: 'bg-amber-100',
  U: 'bg-sky-400',
  B: 'bg-zinc-500',
  R: 'bg-red-500',
  G: 'bg-green-500',
  C: 'bg-neutral-400',
}

const TYPE_LABEL: Record<DeckType, string> = {
  creature: 'Creatures',
  planeswalker: 'Planeswalkers',
  instant: 'Instants',
  sorcery: 'Sorceries',
  artifact: 'Artifacts',
  enchantment: 'Enchantments',
  land: 'Lands',
  other: 'Other',
}

export default function DeckInsights({
  cards,
  commanderCard,
}: {
  cards: DeckCardLine[]
  commanderCard?: LinkedCard | null
}) {
  const total = cards.reduce((sum, line) => sum + line.quantity, 0)
  const curve = deckManaCurve(cards)
  const types = deckTypeBreakdown(cards)
  const pips = deckColorPips(cards)
  const avg = deckAverageManaValue(cards)
  const lands = deckLandCount(cards)
  const dupes = deckSingletonViolations(cards)
  const offIdentity = deckColorIdentityViolations(cards, commanderCard ?? null)
  const maxCurve = Math.max(1, ...curve.map((b) => b.count))
  const totalPips = DECK_MANA_COLORS.reduce((sum, c) => sum + pips[c], 0)
  // Only a deck with a designated commander is a Commander deck to judge.
  const legality = commanderCard ? commanderDeckLegality(cards, commanderCard) : null

  return (
    <div className="mt-4 grid gap-3 rounded-md border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] p-3 text-xs sm:grid-cols-2">
      {/* Commander legality verdict */}
      {legality && (
        <div
          className={`rounded border p-2 sm:col-span-2 ${
            legality.legal
              ? 'border-[var(--cast)]/40 bg-[var(--cast)]/10'
              : 'border-[var(--danger)]/40 bg-[var(--danger)]/10'
          }`}
        >
          {legality.legal ? (
            <p className="font-semibold text-[var(--cast)]">✓ Commander-legal (100 cards, singleton, colour identity)</p>
          ) : (
            <>
              <p className="font-semibold text-[var(--danger)]">
                Not Commander-legal — {legality.issues.length} issue{legality.issues.length > 1 ? 's' : ''}
              </p>
              <ul className="mt-0.5 list-disc pl-4 text-[var(--danger)]/80">
                {legality.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {/* Headline numbers */}
      <div className="flex flex-wrap gap-4 sm:col-span-2">
        <Stat label="Cards" value={String(total)} />
        <Stat label="Lands" value={String(lands)} />
        <Stat label="Avg. mana value" value={avg.toFixed(1)} />
        <Stat label="Nonland spells" value={String(total - lands)} />
      </div>

      {/* Mana curve */}
      <div>
        <p className="mb-1 font-semibold uppercase tracking-wide text-[var(--text-faint)]">Mana curve</p>
        <div className="flex h-20 items-end gap-1">
          {curve.map((b) => (
            <div key={b.label} className="flex flex-1 flex-col items-center gap-1">
              <span className="text-[9px] text-[var(--text-faint)]">{b.count || ''}</span>
              <div
                className="w-full rounded-t bg-gradient-to-b from-[var(--gold-bright)] to-[var(--frame-gold)]"
                style={{ height: `${(b.count / maxCurve) * 100}%`, minHeight: b.count ? 2 : 0 }}
              />
              <span className="text-[9px] text-[var(--text-faint)]">{b.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Colour pips */}
      <div>
        <p className="mb-1 font-semibold uppercase tracking-wide text-[var(--text-faint)]">Colour pips</p>
        <div className="space-y-1">
          {DECK_MANA_COLORS.filter((c) => pips[c] > 0).map((c) => (
            <div key={c} className="flex items-center gap-2">
              <span className={`h-3 w-3 shrink-0 rounded-full ${COLOR_DOT[c]}`} />
              <div className="h-2 flex-1 overflow-hidden rounded bg-[rgba(255,255,255,0.08)]">
                <div className={`h-full ${COLOR_DOT[c]}`} style={{ width: `${(pips[c] / totalPips) * 100}%` }} />
              </div>
              <span className="w-6 text-right text-[var(--text-faint)]">{pips[c]}</span>
            </div>
          ))}
          {totalPips === 0 && <p className="text-[var(--text-faint)]">Colourless / no mana costs.</p>}
        </div>
      </div>

      {/* Type breakdown */}
      <div className="sm:col-span-2">
        <p className="mb-1 font-semibold uppercase tracking-wide text-[var(--text-faint)]">Types</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[var(--text-dim)]">
          {(Object.keys(TYPE_LABEL) as DeckType[])
            .filter((t) => types[t] > 0)
            .map((t) => (
              <span key={t}>
                {TYPE_LABEL[t]}: <span className="font-semibold text-[var(--text-bright)]">{types[t]}</span>
              </span>
            ))}
        </div>
      </div>

      {/* Colour-identity (Commander) warnings */}
      {offIdentity.length > 0 && (
        <div className="rounded border border-[var(--danger)]/30 bg-[var(--danger)]/10 p-2 sm:col-span-2">
          <p className="font-semibold text-[var(--danger)]">
            {offIdentity.length} card{offIdentity.length > 1 ? 's' : ''} outside the commander&apos;s colour identity
            <span className="font-normal text-[var(--danger)]/70"> (illegal in Commander; approximate)</span>
          </p>
          <p className="mt-0.5 truncate text-[var(--danger)]/80">
            {offIdentity.map((c) => `${c.name} (${c.colors.join('')})`).join(', ')}
          </p>
        </div>
      )}

      {/* Singleton (Commander) warnings */}
      {dupes.length > 0 && (
        <div className="rounded border border-[var(--warn)]/30 bg-[var(--warn)]/10 p-2 sm:col-span-2">
          <p className="font-semibold text-[var(--warn)]">
            Not singleton — {dupes.length} card{dupes.length > 1 ? 's' : ''} listed more than once
            <span className="font-normal text-[var(--warn)]/70"> (illegal in Commander; basics are fine)</span>
          </p>
          <p className="mt-0.5 truncate text-[var(--warn)]/80">
            {dupes.map((d) => `${d.quantity}× ${d.name}`).join(', ')}
          </p>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-[var(--text-faint)]">{label}</p>
      <p className="text-lg font-black text-[var(--text-bright)]">{value}</p>
    </div>
  )
}
