'use client'

import { useState } from 'react'
import DeckInsights from '@/components/DeckInsights'
import { deckManaCurve } from '@/lib/game/deck-insights'
import type { DeckCardLine, LinkedCard } from '@/lib/game/types'

// Band 2 of the Edit Deck editor: a collapsible strip (collapsed by default)
// summarising the curve + creature count, expanding to the full DeckInsights
// panel (mockups/decks-editor-restyle.html .insights / .strip-*).
export default function DeckInsightsStrip({
  cards,
  commanderCard,
}: {
  cards: DeckCardLine[]
  commanderCard?: LinkedCard | null
}) {
  const [open, setOpen] = useState(false)

  const curve = deckManaCurve(cards)
  const peak = curve.reduce((best, bucket) => (bucket.count > best.count ? bucket : best), { label: '0', count: -1 })
  const creatureCount = cards.reduce(
    (sum, line) => sum + ((line.card?.type_line ?? '').toLowerCase().includes('creature') ? line.quantity : 0),
    0,
  )

  return (
    <div className="border-t border-[rgba(255,255,255,0.06)]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2.5 px-5 py-2.5 text-left text-[12.5px] text-[var(--text-dim)]"
      >
        <span>
          📊 Insights — curve piekt op MV {peak.label} · {creatureCount} creatures
        </span>
        <span
          className={`ml-auto text-[var(--text-faint)] transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        >
          ▾
        </span>
      </button>
      {open && (
        <div className="px-5 pb-4">
          <DeckInsights cards={cards} commanderCard={commanderCard} />
        </div>
      )}
    </div>
  )
}
