'use client'

import { useState } from 'react'

import { CardName } from './CardName'
import { ShopLinksInline } from './ShopLinks'
import { Panel } from './ui'

// ⚡ Combo detector (premium): lines already complete in the deck, lines the
// binder completes, and famous lines one (unowned) card away.

interface ComboCard {
  name: string
  where: 'deck' | 'binder'
}
interface ComboFind {
  cards: ComboCard[]
  result: string
  steps: string
  missing: string | null
}
interface CombosResult {
  summary: string
  combos: ComboFind[]
}

export function CombosTab({ deckId }: { deckId: string }) {
  const [result, setResult] = useState<CombosResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; code?: string } | null>(null)

  async function run() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/decks/${deckId}/combos`, { method: 'POST' })
      const body = await res.json()
      if (!res.ok) setError({ message: body.error ?? 'The combo scan could not run.', code: body.code })
      else setResult(body)
    } catch {
      setError({ message: 'Network error running the combo scan.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <Panel className="flex flex-wrap items-center justify-between gap-3 p-4">
        <p className="font-rules text-sm" style={{ color: 'var(--text-dim)' }}>
          Which combo lines does this deck already contain, which can your binder complete — and which famous line is
          one card away? Only cards you own can appear in a line.
        </p>
        <button
          onClick={run}
          disabled={busy}
          className="rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-40"
          style={{ background: 'linear-gradient(150deg, var(--gold-bright), var(--frame-gold))', color: '#1c1407' }}
        >
          {busy ? 'Scanning…' : result ? 'Scan again' : '⚡ Find combos'}
        </button>
      </Panel>

      {error ? (
        <Panel className="p-5">
          {error.code === 'premium_required' ? (
            <p className="font-rules text-sm" style={{ color: 'var(--text-dim)' }}>
              <span style={{ color: 'var(--gold-bright)' }}>⚡ The combo detector is a premium feature</span> — premium
              covers the AI costs; the heuristic tabs stay free.
            </p>
          ) : (
            <p className="text-sm" style={{ color: error.code === 'quota_exceeded' ? 'var(--warn)' : 'var(--danger)' }}>
              {error.message}
            </p>
          )}
        </Panel>
      ) : null}

      {busy && !result ? (
        <Panel className="p-6">
          <p className="font-rules animate-pulse text-sm" style={{ color: 'var(--text-dim)' }}>
            Tracing lines through your deck and binder…
          </p>
        </Panel>
      ) : null}

      {result ? (
        <>
          <Panel className="p-5">
            <p className="font-rules text-sm" style={{ color: 'var(--text)' }}>
              {result.summary}
            </p>
          </Panel>
          {result.combos.map((combo, i) => (
            <Panel key={i} className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                {combo.cards.map((c, j) => (
                  <span key={c.name} className="flex items-center gap-2">
                    {j > 0 ? <span style={{ color: 'var(--frame-gold)' }}>+</span> : null}
                    <CardName name={c.name} className="font-display text-sm" style={{ color: 'var(--text-bright)' }} />
                    <span
                      className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
                      style={{
                        color: c.where === 'deck' ? 'var(--cast)' : 'var(--gold-bright)',
                        border: `1px solid ${c.where === 'deck' ? 'var(--cast)' : 'rgba(201,154,58,0.45)'}`,
                      }}
                    >
                      {c.where === 'deck' ? 'in deck' : 'in binder'}
                    </span>
                  </span>
                ))}
                {combo.missing ? (
                  <span className="flex items-center gap-2">
                    <span style={{ color: 'var(--frame-gold)' }}>+</span>
                    <CardName name={combo.missing} className="font-display text-sm" style={{ color: 'var(--warn)' }} />
                    <span
                      className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
                      style={{ color: 'var(--warn)', border: '1px solid var(--warn)' }}
                    >
                      missing
                    </span>
                  </span>
                ) : null}
              </div>
              <p className="font-display mt-2 text-sm" style={{ color: 'var(--gold-bright)' }}>
                → {combo.result}
              </p>
              <p className="font-rules mt-1 text-sm" style={{ color: 'var(--text-dim)' }}>
                {combo.steps}
              </p>
              {combo.missing ? (
                <div className="mt-2">
                  <ShopLinksInline name={combo.missing} />
                </div>
              ) : null}
            </Panel>
          ))}
        </>
      ) : null}
    </div>
  )
}
