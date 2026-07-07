'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Panel } from './ui'

export function DeckImportForm() {
  const router = useRouter()
  const [mode, setMode] = useState<'url' | 'paste'>('url')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [text, setText] = useState('')
  const [source, setSource] = useState('moxfield')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    const payload =
      mode === 'url'
        ? url.trim()
          ? { name, url: url.trim() }
          : null
        : text.trim()
          ? { name, source, text }
          : null
    if (!payload) {
      setError(mode === 'url' ? 'Paste a Moxfield or Archidekt deck link first.' : 'Paste a decklist first.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/decks/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await res.json()
      if (!res.ok) {
        setError(body.error ?? 'Import failed.')
        return
      }
      router.push(`/collection/decks/${body.deckId}`)
    } catch {
      setError('Network error during import.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel className="space-y-4 p-6">
      <div className="flex gap-2">
        <ModeTab active={mode === 'url'} onClick={() => setMode('url')}>
          From URL
        </ModeTab>
        <ModeTab active={mode === 'paste'} onClick={() => setMode('paste')}>
          Paste list
        </ModeTab>
      </div>

      <div className="flex flex-wrap gap-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Deck name (optional)"
          className="flex-1 rounded-lg bg-transparent px-3 py-2 text-sm"
          style={{ border: '1px solid rgba(201,154,58,0.3)', color: 'var(--text)', minWidth: '12rem' }}
        />
        {mode === 'paste' ? (
          <select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="rounded-lg px-3 py-2 text-sm"
            style={{ border: '1px solid rgba(201,154,58,0.3)', background: 'var(--ink-2)', color: 'var(--text)' }}
          >
            <option value="moxfield">Moxfield</option>
            <option value="archidekt">Archidekt</option>
            <option value="txt">Plain text</option>
          </select>
        ) : null}
      </div>

      {mode === 'url' ? (
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://moxfield.com/decks/…  or  https://archidekt.com/decks/…"
          className="font-rules w-full rounded-lg bg-transparent px-3 py-2 text-sm"
          style={{ border: '1px solid rgba(201,154,58,0.3)', color: 'var(--text)' }}
        />
      ) : (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={12}
          placeholder={'1 Sol Ring\n1 Arcane Signet\n\nCommander\n1 Atraxa, Praetors’ Voice'}
          className="font-rules w-full rounded-lg bg-transparent px-3 py-2 text-sm"
          style={{ border: '1px solid rgba(201,154,58,0.3)', color: 'var(--text)' }}
        />
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={submit}
          disabled={busy}
          className="rounded-lg px-5 py-2 text-sm font-medium disabled:opacity-40"
          style={{ background: 'linear-gradient(150deg, var(--gold-bright), var(--frame-gold))', color: '#1c1407' }}
        >
          {busy ? 'Importing…' : 'Import & analyse'}
        </button>
        {error ? (
          <span className="text-sm" style={{ color: 'var(--danger)' }}>
            {error}
          </span>
        ) : null}
      </div>
      <p className="text-xs" style={{ color: 'var(--text-faint)' }}>
        {mode === 'url'
          ? 'Paste a public Moxfield or Archidekt deck link. Private decks can’t be fetched — paste the list instead.'
          : 'A “Commander” section header or Archidekt [Commander] category marks the commander. Sideboard / maybeboard sections are ignored.'}
      </p>
    </Panel>
  )
}

function ModeTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="rounded-lg px-3 py-1.5 text-sm font-medium"
      style={
        active
          ? { background: 'linear-gradient(150deg, var(--gold-bright), var(--frame-gold))', color: '#1c1407' }
          : { border: '1px solid rgba(201,154,58,0.3)', color: 'var(--text-dim)' }
      }
    >
      {children}
    </button>
  )
}
