'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Panel } from './ui'

interface ImportResult {
  rowsTotal: number
  rowsMatched: number
  rowsUnmatched: number
  unmatched: { name: string; setCode: string | null; collectorNum: string | null; quantity: number }[]
  parseErrors: string[]
  diff: {
    addedUnique: number
    removedUnique: number
    qtyAdded: number
    qtyRemoved: number
    added: { name: string; qty: number }[]
    removed: { name: string; qty: number }[]
  } | null
}

export function ImportWizard() {
  const router = useRouter()
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [copiedUnmatched, setCopiedUnmatched] = useState(false)

  // Unmatched cards as plain "N Name" lines — paste into Scryfall, a fix-up
  // sheet, or a support message instead of retyping them.
  async function copyUnmatched() {
    if (!result || result.unmatched.length === 0) return
    await navigator.clipboard.writeText(result.unmatched.map((u) => `${u.quantity} ${u.name}`).join('\n'))
    setCopiedUnmatched(true)
    setTimeout(() => setCopiedUnmatched(false), 2000)
  }

  async function submit() {
    if (!file) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/collection/import', { method: 'POST', body: form })
      const body = await res.json()
      if (!res.ok) {
        setError(body.error ?? 'Import failed.')
        if (body.rowsTotal !== undefined) setResult(body)
        return
      }
      setResult(body)
    } catch {
      setError('Network error during import.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <Panel className="p-6">
        <label
          className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-6 py-10 text-center transition-colors"
          style={{ borderColor: 'rgba(201,154,58,0.4)' }}
        >
          <input
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null)
              setResult(null)
              setError(null)
            }}
          />
          <span className="font-display text-base" style={{ color: 'var(--text-bright)' }}>
            {file ? file.name : 'Choose a ManaBox CSV'}
          </span>
          <span className="font-rules mt-1 text-sm" style={{ color: 'var(--text-dim)' }}>
            ManaBox → Export collection → CSV. Re-importing replaces your collection snapshot.
          </span>
        </label>

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={submit}
            disabled={!file || busy}
            className="rounded-lg px-5 py-2 text-sm font-medium disabled:opacity-40"
            style={{ background: 'linear-gradient(150deg, var(--gold-bright), var(--frame-gold))', color: '#1c1407' }}
          >
            {busy ? 'Importing…' : 'Import'}
          </button>
          {error ? (
            <span className="text-sm" style={{ color: 'var(--danger)' }}>
              {error}
            </span>
          ) : null}
        </div>
      </Panel>

      {result ? (
        <Panel className="p-6">
          <h2 className="font-display text-lg" style={{ color: 'var(--text-bright)' }}>
            Import report
          </h2>
          <div className="mt-3 flex flex-wrap gap-6">
            <Figure value={result.rowsMatched} label="matched" tone="var(--cast)" />
            <Figure value={result.rowsUnmatched} label="unmatched" tone={result.rowsUnmatched > 0 ? 'var(--warn)' : 'var(--text-faint)'} />
            <Figure value={result.rowsTotal} label="total" tone="var(--text-dim)" />
          </div>

          {result.diff ? (
            <div className="mt-4 rounded-lg p-3" style={{ border: '1px solid rgba(201,154,58,0.18)' }}>
              <h3 className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
                Changes vs your previous snapshot
              </h3>
              <div className="mt-2 flex flex-wrap gap-6">
                <Figure value={result.diff.qtyAdded} label={`cards in (+${result.diff.addedUnique} new)`} tone="var(--cast)" />
                <Figure value={result.diff.qtyRemoved} label={`cards out (−${result.diff.removedUnique} gone)`} tone={result.diff.qtyRemoved > 0 ? 'var(--warn)' : 'var(--text-faint)'} />
              </div>
              {result.diff.added.length > 0 ? (
                <p className="font-rules mt-2 text-sm" style={{ color: 'var(--text-dim)' }}>
                  <span style={{ color: 'var(--cast)' }}>+</span>{' '}
                  {result.diff.added.map((a) => `${a.qty}× ${a.name}`).join(', ')}
                </p>
              ) : null}
              {result.diff.removed.length > 0 ? (
                <p className="font-rules mt-1 text-sm" style={{ color: 'var(--text-dim)' }}>
                  <span style={{ color: 'var(--warn)' }}>−</span>{' '}
                  {result.diff.removed.map((r) => `${r.qty}× ${r.name}`).join(', ')}
                </p>
              ) : null}
            </div>
          ) : null}

          {result.unmatched.length > 0 ? (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm" style={{ color: 'var(--warn)' }}>
                {result.unmatched.length} cards couldn&apos;t be matched
              </summary>
              <ul className="font-rules mt-2 max-h-48 overflow-auto text-sm" style={{ color: 'var(--text-dim)' }}>
                {result.unmatched.map((u, i) => (
                  <li key={i}>
                    {u.quantity}× {u.name}
                    {u.setCode ? ` (${u.setCode} ${u.collectorNum ?? ''})` : ''}{' '}
                    <a
                      href={`https://scryfall.com/search?q=${encodeURIComponent(u.name)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs underline underline-offset-2"
                      style={{ color: 'var(--text-faint)' }}
                      title="Look the card up on Scryfall to check the exact name"
                    >
                      check ↗
                    </a>
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex items-center gap-3">
                <button
                  onClick={copyUnmatched}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium"
                  style={{ border: '1px solid rgba(201,154,58,0.4)', color: 'var(--text)' }}
                >
                  {copiedUnmatched ? 'Copied ✓' : 'Copy list'}
                </button>
                <p className="text-xs" style={{ color: 'var(--text-faint)' }}>
                  Most misses are split / double-faced cards or names that differ from Scryfall. Exact-printing matching
                  improves once the full printings mirror is loaded.
                </p>
              </div>
            </details>
          ) : null}

          <button
            onClick={() => router.push('/collection')}
            className="mt-5 rounded-lg px-4 py-2 text-sm font-medium"
            style={{ border: '1px solid rgba(201,154,58,0.4)', color: 'var(--text)' }}
          >
            Go to collection →
          </button>
        </Panel>
      ) : null}
    </div>
  )
}

function Figure({ value, label, tone }: { value: number; label: string; tone: string }) {
  return (
    <div>
      <div className="font-display text-2xl" style={{ color: tone }}>
        {value.toLocaleString()}
      </div>
      <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
        {label}
      </div>
    </div>
  )
}
