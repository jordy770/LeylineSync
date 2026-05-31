'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import CardCatalogPicker from '@/components/CardCatalogPicker'
import { getErrorMessage, relinkCardScripts, setCardScript } from '@/lib/game/actions'
import { getCardDetail } from '@/lib/game/data'
import { validateCardScript } from '@/lib/game/card-behavior-schema'
import { createClient } from '@/lib/supabase/client'
import type { CardScript, LinkedCard } from '@/lib/game/types'

const EMPTY_SCRIPT_PLACEHOLDER = `{
  "schema_version": 2,
  "activated_abilities": [
    {
      "costs": [{ "type": "tap_self" }],
      "effects": [{ "type": "deal_damage", "amount": 1, "target_type": ["creature", "player"] }]
    }
  ]
}`

export default function CardBehaviorEditor() {
  const supabase = useMemo(() => createClient(), [])
  const [selectedCardId, setSelectedCardId] = useState('')
  const [card, setCard] = useState<LinkedCard | null>(null)
  const [draft, setDraft] = useState('')
  const [loadedScriptText, setLoadedScriptText] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isRelinking, setIsRelinking] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const loadCard = useCallback(
    async (cardId: string) => {
      if (!cardId) {
        setCard(null)
        setDraft('')
        setLoadedScriptText('')
        return
      }

      setIsLoading(true)
      setErrorMessage(null)
      setSuccessMessage(null)

      try {
        const detail = await getCardDetail(supabase, cardId)
        setCard(detail)
        const text = detail?.script ? JSON.stringify(detail.script, null, 2) : ''
        setDraft(text)
        setLoadedScriptText(text)
      } catch (error) {
        setErrorMessage(getErrorMessage(error))
      } finally {
        setIsLoading(false)
      }
    },
    [supabase],
  )

  useEffect(() => {
    void loadCard(selectedCardId)
  }, [loadCard, selectedCardId])

  // Live validation of the current draft (empty draft = clears the script).
  const validation = useMemo(() => {
    const trimmed = draft.trim()
    if (!trimmed) {
      return { ok: true as const, version: null, parsed: null as CardScript | null }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      return { ok: false as const, errors: [`JSON parse error: ${getErrorMessage(error)}`] }
    }

    const result = validateCardScript(parsed)
    if (!result.success) {
      return { ok: false as const, errors: result.errors, version: result.version }
    }

    return { ok: true as const, version: result.version, parsed: parsed as CardScript }
  }, [draft])

  const isDirty = draft !== loadedScriptText
  const canSave = !isSaving && !isLoading && Boolean(selectedCardId) && validation.ok && isDirty

  const handleSave = async () => {
    if (!validation.ok) {
      return
    }

    setIsSaving(true)
    setErrorMessage(null)
    setSuccessMessage(null)

    try {
      const script = draft.trim() ? (validation.parsed as CardScript) : null
      const updated = await setCardScript(supabase, selectedCardId, script)
      const text = updated?.script ? JSON.stringify(updated.script, null, 2) : ''
      setCard(updated)
      setDraft(text)
      setLoadedScriptText(text)
      setSuccessMessage(script ? 'Behavior saved.' : 'Behavior cleared.')
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    } finally {
      setIsSaving(false)
    }
  }

  const handleRelink = async () => {
    setIsRelinking(true)
    setErrorMessage(null)
    setSuccessMessage(null)

    try {
      const count = await relinkCardScripts(supabase)
      setSuccessMessage(
        count > 0
          ? `Relinked ${count} printing${count === 1 ? '' : 's'} to a sibling's authored script.`
          : 'No printings needed relinking.',
      )
      if (selectedCardId) {
        await loadCard(selectedCardId)
      }
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    } finally {
      setIsRelinking(false)
    }
  }

  const handleFormat = () => {
    const trimmed = draft.trim()
    if (!trimmed) {
      return
    }
    try {
      setDraft(JSON.stringify(JSON.parse(trimmed), null, 2))
    } catch {
      // Leave the draft untouched; the validation banner already explains why.
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
      <div className="grid content-start gap-3 rounded-lg border border-slate-800 bg-slate-950 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Pick a card</h2>
        <CardCatalogPicker value={selectedCardId} onChange={setSelectedCardId} disabled={isLoading} />
        {card ? (
          <dl className="grid gap-1 border-t border-slate-800 pt-3 text-xs text-slate-400">
            <div className="flex justify-between gap-3">
              <dt>oracle_id</dt>
              <dd className="truncate font-mono text-slate-300">{card.oracle_id ?? '— (reimport to backfill)'}</dd>
            </div>
            {card.oracle_text ? (
              <div className="mt-2 whitespace-pre-wrap text-slate-300">{card.oracle_text}</div>
            ) : null}
          </dl>
        ) : null}

        <button
          type="button"
          onClick={handleRelink}
          disabled={isRelinking}
          className="mt-2 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
          title="Copy authored scripts forward to other printings sharing the same oracle_id that have no script yet."
        >
          {isRelinking ? 'Relinking…' : 'Relink scripts across printings'}
        </button>
      </div>

      <div className="grid content-start gap-3 rounded-lg border border-slate-800 bg-slate-950 p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            Behavior script {card?.name ? `— ${card.name}` : ''}
          </h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleFormat}
              disabled={!draft.trim()}
              className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 disabled:opacity-40"
            >
              Format
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave}
              className="rounded bg-fuchsia-300 px-3 py-1.5 text-xs font-semibold text-fuchsia-950 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSaving ? 'Saving…' : draft.trim() ? 'Save behavior' : 'Clear behavior'}
            </button>
          </div>
        </div>

        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={isLoading || !selectedCardId}
          spellCheck={false}
          placeholder={selectedCardId ? EMPTY_SCRIPT_PLACEHOLDER : 'Select a card to edit its behavior.'}
          className="min-h-[420px] w-full resize-y rounded border border-slate-800 bg-slate-900 p-3 font-mono text-xs leading-relaxed text-slate-100 disabled:opacity-50"
        />

        {validation.ok ? (
          draft.trim() ? (
            <p className="text-xs text-emerald-300">Valid v{validation.version} script.</p>
          ) : (
            <p className="text-xs text-slate-500">Empty — saving will clear this card&apos;s behavior.</p>
          )
        ) : (
          <ul className="space-y-1 text-xs text-red-300">
            {validation.errors.map((message, index) => (
              <li key={index}>• {message}</li>
            ))}
          </ul>
        )}

        {successMessage ? <p className="text-xs text-emerald-300">{successMessage}</p> : null}
        {errorMessage ? <p className="text-xs text-red-300">{errorMessage}</p> : null}
      </div>
    </div>
  )
}
