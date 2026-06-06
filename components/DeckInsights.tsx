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
  C: 'bg-slate-400',
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
    <div className="mt-4 grid gap-3 rounded-md border border-slate-800 bg-slate-900/50 p-3 text-xs sm:grid-cols-2">
      {/* Commander legality verdict */}
      {legality && (
        <div
          className={`rounded border p-2 sm:col-span-2 ${
            legality.legal
              ? 'border-emerald-500/40 bg-emerald-500/10'
              : 'border-rose-500/40 bg-rose-500/10'
          }`}
        >
          {legality.legal ? (
            <p className="font-semibold text-emerald-300">✓ Commander-legal (100 cards, singleton, colour identity)</p>
          ) : (
            <>
              <p className="font-semibold text-rose-300">
                Not Commander-legal — {legality.issues.length} issue{legality.issues.length > 1 ? 's' : ''}
              </p>
              <ul className="mt-0.5 list-disc pl-4 text-rose-200/80">
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
        <p className="mb-1 font-semibold uppercase tracking-wide text-slate-400">Mana curve</p>
        <div className="flex h-20 items-end gap-1">
          {curve.map((b) => (
            <div key={b.label} className="flex flex-1 flex-col items-center gap-1">
              <span className="text-[9px] text-slate-400">{b.count || ''}</span>
              <div
                className="w-full rounded-t bg-sky-500/70"
                style={{ height: `${(b.count / maxCurve) * 100}%`, minHeight: b.count ? 2 : 0 }}
              />
              <span className="text-[9px] text-slate-500">{b.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Colour pips */}
      <div>
        <p className="mb-1 font-semibold uppercase tracking-wide text-slate-400">Colour pips</p>
        <div className="space-y-1">
          {DECK_MANA_COLORS.filter((c) => pips[c] > 0).map((c) => (
            <div key={c} className="flex items-center gap-2">
              <span className={`h-3 w-3 shrink-0 rounded-full ${COLOR_DOT[c]}`} />
              <div className="h-2 flex-1 overflow-hidden rounded bg-slate-800">
                <div className={`h-full ${COLOR_DOT[c]}`} style={{ width: `${(pips[c] / totalPips) * 100}%` }} />
              </div>
              <span className="w-6 text-right text-slate-400">{pips[c]}</span>
            </div>
          ))}
          {totalPips === 0 && <p className="text-slate-500">Colourless / no mana costs.</p>}
        </div>
      </div>

      {/* Type breakdown */}
      <div className="sm:col-span-2">
        <p className="mb-1 font-semibold uppercase tracking-wide text-slate-400">Types</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-slate-300">
          {(Object.keys(TYPE_LABEL) as DeckType[])
            .filter((t) => types[t] > 0)
            .map((t) => (
              <span key={t}>
                {TYPE_LABEL[t]}: <span className="font-semibold text-white">{types[t]}</span>
              </span>
            ))}
        </div>
      </div>

      {/* Colour-identity (Commander) warnings */}
      {offIdentity.length > 0 && (
        <div className="rounded border border-rose-500/30 bg-rose-500/10 p-2 sm:col-span-2">
          <p className="font-semibold text-rose-300">
            {offIdentity.length} card{offIdentity.length > 1 ? 's' : ''} outside the commander&apos;s colour identity
            <span className="font-normal text-rose-200/70"> (illegal in Commander; approximate)</span>
          </p>
          <p className="mt-0.5 truncate text-rose-200/80">
            {offIdentity.map((c) => `${c.name} (${c.colors.join('')})`).join(', ')}
          </p>
        </div>
      )}

      {/* Singleton (Commander) warnings */}
      {dupes.length > 0 && (
        <div className="rounded border border-amber-500/30 bg-amber-500/10 p-2 sm:col-span-2">
          <p className="font-semibold text-amber-300">
            Not singleton — {dupes.length} card{dupes.length > 1 ? 's' : ''} listed more than once
            <span className="font-normal text-amber-200/70"> (illegal in Commander; basics are fine)</span>
          </p>
          <p className="mt-0.5 truncate text-amber-200/80">
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
      <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className="text-lg font-black text-white">{value}</p>
    </div>
  )
}
