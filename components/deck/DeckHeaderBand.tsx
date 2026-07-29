'use client'

import { useState } from 'react'
import type { DeckLegality } from '@/lib/game/actions'
import type { DeckDetail } from '@/lib/game/types'

// Band 1 of the Edit Deck editor: commander-art placeholder + name + status
// counts + legality chip, compressed into one row (mockups/decks-editor-restyle.html .dhead).
export default function DeckHeaderBand({
  deck,
  statusCounts,
  legality,
}: {
  deck: DeckDetail
  statusCounts: { scripted: number; vanilla: number; needs: number }
  legality: DeckLegality | null
}) {
  const [issuesOpen, setIssuesOpen] = useState(false)

  return (
    <div className="flex flex-wrap items-center gap-4 px-5 pb-3.5 pt-[18px]">
      {/* Commander-art placeholder — phase B swaps this for a real Scryfall art-crop */}
      <div
        className="relative h-14 w-[76px] flex-none rounded-[10px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)]"
        style={{ background: 'linear-gradient(140deg,#7a4a25,#37502a 55%,#24333f)' }}
        title="Commander art (phase B: real Scryfall art-crop)"
      >
        <span className="absolute bottom-[3px] right-[5px] text-[13px] text-[var(--gold-bright)]">★</span>
      </div>

      <div className="min-w-0">
        <p className="font-display text-[19px] font-semibold text-[var(--text-bright)]">
          {deck.name || 'Untitled Deck'}
        </p>
        <p className="mt-0.5 text-xs text-[var(--text-faint)]">
          {deck.card_count} cards ·{' '}
          <span className="font-semibold text-[var(--cast)]">{statusCounts.scripted} scripted</span> ·{' '}
          <span className="font-semibold text-[var(--text-dim)]">{statusCounts.vanilla} vanilla</span> ·{' '}
          <span className="font-semibold text-[var(--warn)]">{statusCounts.needs} need behavior</span>
        </p>
      </div>

      {legality && (
        <div className="relative ml-auto self-center">
          {legality.legal ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--cast)]/35 px-[11px] py-1 text-[11.5px] font-semibold text-[var(--cast)]">
              ✓ Commander-legal ({legality.card_count})
            </span>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setIssuesOpen((value) => !value)}
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--warn)]/35 px-[11px] py-1 text-[11.5px] font-semibold text-[var(--warn)]"
              >
                ⚠ Not Commander-legal
              </button>
              {issuesOpen && (
                <div className="absolute right-0 top-full z-10 mt-1.5 w-64 rounded-md border border-[var(--warn)]/30 bg-[var(--ink-2)] p-2.5 text-xs text-[var(--warn)] shadow-lg">
                  <ul className="list-disc space-y-0.5 pl-4 text-[var(--warn)]/90">
                    {legality.issues.map((issue, i) => (
                      <li key={i}>{issue}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
