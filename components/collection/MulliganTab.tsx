'use client'

import { useState } from 'react'

import { drawSampleHand } from '@/lib/collection/mulligan'
import { CardPocket } from './CardPocket'
import { Panel } from './ui'

// 🃏 Mulligan trainer (premium): draw a real sample hand from THIS deck, make
// the call, get coached. The randomness is client-side; the grading is one
// cheap model call per hand.

interface MulliganDeckCard {
  name: string
  qty: number
  isCommander: boolean
}
interface Grade {
  verdict: 'keep' | 'mulligan' | 'close'
  agreesWithPlayer: boolean
  reasoning: string
}

export function MulliganTab({ deckId, cards }: { deckId: string; cards: MulliganDeckCard[] }) {
  const [hand, setHand] = useState<string[]>([])
  const [grade, setGrade] = useState<Grade | null>(null)
  const [choice, setChoice] = useState<'keep' | 'mulligan' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; code?: string } | null>(null)
  const [record, setRecord] = useState<{ right: number; total: number }>({ right: 0, total: 0 })

  function newHand() {
    setHand(drawSampleHand(cards, Math.random))
    setGrade(null)
    setChoice(null)
    setError(null)
  }

  async function judge(call: 'keep' | 'mulligan') {
    setChoice(call)
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/decks/${deckId}/mulligan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hand, choice: call }),
      })
      const body = await res.json()
      if (!res.ok) {
        setError({ message: body.error ?? 'Grading failed.', code: body.code })
        setChoice(null)
      } else {
        setGrade(body)
        setRecord((r) => ({ right: r.right + (body.agreesWithPlayer ? 1 : 0), total: r.total + 1 }))
      }
    } catch {
      setError({ message: 'Network error while grading.' })
      setChoice(null)
    } finally {
      setBusy(false)
    }
  }

  if (cards.length === 0) return <Panel className="p-6"><p className="font-rules text-sm" style={{ color: 'var(--text-dim)' }}>No cards to draw from.</p></Panel>

  return (
    <div className="space-y-3">
      <Panel className="flex flex-wrap items-center justify-between gap-3 p-4">
        <p className="font-rules text-sm" style={{ color: 'var(--text-dim)' }}>
          A real seven from this deck. Keep or mulligan — then hear the coach&apos;s verdict.
          {record.total > 0 ? (
            <span className="ml-2" style={{ color: 'var(--text-faint)' }}>
              Session record: {record.right}/{record.total} calls matched.
            </span>
          ) : null}
        </p>
        <button
          onClick={newHand}
          disabled={busy}
          className="rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-40"
          style={{ background: 'linear-gradient(150deg, var(--gold-bright), var(--frame-gold))', color: '#1c1407' }}
        >
          {hand.length === 0 ? '🃏 Draw a hand' : 'New hand'}
        </button>
      </Panel>

      {hand.length > 0 ? (
        <Panel className="p-4">
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
            {hand.map((name, i) => (
              <CardPocket key={`${name}-${i}`} name={name} />
            ))}
          </div>
          {!grade ? (
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => judge('keep')}
                disabled={busy}
                className="rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-40"
                style={{ border: '1px solid var(--cast)', color: 'var(--cast)' }}
              >
                {busy && choice === 'keep' ? '…' : 'Keep'}
              </button>
              <button
                onClick={() => judge('mulligan')}
                disabled={busy}
                className="rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-40"
                style={{ border: '1px solid var(--warn)', color: 'var(--warn)' }}
              >
                {busy && choice === 'mulligan' ? '…' : 'Mulligan'}
              </button>
            </div>
          ) : null}
        </Panel>
      ) : null}

      {error ? (
        <Panel className="p-5">
          {error.code === 'premium_required' ? (
            <p className="font-rules text-sm" style={{ color: 'var(--text-dim)' }}>
              <span style={{ color: 'var(--gold-bright)' }}>🃏 The mulligan trainer is a premium feature</span> —
              premium covers the AI costs; drawing hands is free, the coaching is not.
            </p>
          ) : (
            <p className="text-sm" style={{ color: error.code === 'quota_exceeded' ? 'var(--warn)' : 'var(--danger)' }}>
              {error.message}
            </p>
          )}
        </Panel>
      ) : null}

      {grade ? (
        <Panel className="p-5">
          <div className="flex items-center gap-3">
            <span
              className="font-display text-lg"
              style={{
                color: grade.verdict === 'keep' ? 'var(--cast)' : grade.verdict === 'mulligan' ? 'var(--warn)' : 'var(--text-bright)',
              }}
            >
              {grade.verdict === 'close' ? 'Close call' : grade.verdict === 'keep' ? 'Keep' : 'Mulligan'}
            </span>
            <span className="text-sm" style={{ color: grade.agreesWithPlayer ? 'var(--cast)' : 'var(--danger)' }}>
              {grade.agreesWithPlayer ? '✓ you called it' : `✗ you said ${choice}`}
            </span>
          </div>
          <p className="font-rules mt-2 text-sm" style={{ color: 'var(--text-dim)' }}>
            {grade.reasoning}
          </p>
        </Panel>
      ) : null}
    </div>
  )
}
