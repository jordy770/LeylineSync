'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import CardBehaviorForm from '@/components/CardBehaviorForm'
import CardCatalogPicker from '@/components/CardCatalogPicker'
import { getErrorMessage, relinkCardScripts, setCardScript } from '@/lib/game/actions'
import { getCardDetail } from '@/lib/game/data'
import { validateCardScript } from '@/lib/game/card-behavior-schema'
import {
  EMPTY_BUILDER_FORM,
  buildScriptFromForm,
  parseScriptToForm,
  type BuilderForm,
} from '@/lib/game/card-behavior-builder'
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

type EditorMode = 'form' | 'json'

const emptyBuilderForm = (): BuilderForm => ({
  keywords: [...EMPTY_BUILDER_FORM.keywords],
  triggers: [...EMPTY_BUILDER_FORM.triggers],
  activatedAbilities: [...EMPTY_BUILDER_FORM.activatedAbilities],
})

const scriptToText = (script: CardScript | null | undefined) =>
  script ? JSON.stringify(script, null, 2) : ''

const formToText = (form: BuilderForm) => scriptToText(buildScriptFromForm(form))

export default function CardBehaviorEditor() {
  const supabase = useMemo(() => createClient(), [])
  const [selectedCardId, setSelectedCardId] = useState('')
  const [card, setCard] = useState<LinkedCard | null>(null)
  const [draft, setDraft] = useState('')
  const [editorMode, setEditorMode] = useState<EditorMode>('form')
  const [formValue, setFormValue] = useState<BuilderForm>(() => emptyBuilderForm())
  const [loadedScriptText, setLoadedScriptText] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isRelinking, setIsRelinking] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const loadCard = useCallback(
    async (cardId: string) => {
      if (!cardId) {
        setCard(null)
        setDraft('')
        setEditorMode('form')
        setFormValue(emptyBuilderForm())
        setLoadedScriptText('')
        return
      }

      setIsLoading(true)
      setErrorMessage(null)
      setSuccessMessage(null)

      try {
        const detail = await getCardDetail(supabase, cardId)
        setCard(detail)
        const text = scriptToText(detail?.script)
        const parsedForm = parseScriptToForm(detail?.script ?? null)
        setDraft(text)
        setFormValue(parsedForm ?? emptyBuilderForm())
        setEditorMode(parsedForm ? 'form' : 'json')
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

  const formCompatibleDraft = useMemo(() => {
    if (!validation.ok) {
      return null
    }
    return parseScriptToForm(validation.parsed)
  }, [validation])

  const isDirty = draft !== loadedScriptText
  const canSave = !isSaving && !isLoading && Boolean(selectedCardId) && validation.ok && isDirty

  const handleFormChange = (next: BuilderForm) => {
    setFormValue(next)
    setDraft(formToText(next))
  }

  const switchToForm = () => {
    if (formCompatibleDraft === null) {
      return
    }
    setFormValue(formCompatibleDraft)
    setDraft(formToText(formCompatibleDraft))
    setEditorMode('form')
  }

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
      const text = scriptToText(updated?.script)
      const parsedForm = parseScriptToForm(updated?.script ?? null)
      setCard(updated)
      setDraft(text)
      setFormValue(parsedForm ?? emptyBuilderForm())
      setEditorMode((mode) => (mode === 'form' && parsedForm ? 'form' : mode))
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

  const handleGenerate = async () => {
    if (!card) {
      return
    }

    setIsGenerating(true)
    setErrorMessage(null)
    setSuccessMessage(null)

    try {
      const response = await fetch('/api/cards/generate-behavior', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: card.name,
          type_line: card.type_line,
          oracle_text: card.oracle_text,
        }),
      })

      const payload = (await response.json()) as { script?: CardScript; error?: string }
      if (!response.ok || !payload.script) {
        throw new Error(payload.error ?? 'Generation failed')
      }

      const text = scriptToText(payload.script)
      const parsedForm = parseScriptToForm(payload.script)
      setDraft(text)
      setFormValue(parsedForm ?? emptyBuilderForm())
      setEditorMode(parsedForm ? 'form' : 'json')
      setSuccessMessage('Generated a draft from the rules text — review it, then Save.')
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    } finally {
      setIsGenerating(false)
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
          onClick={handleGenerate}
          disabled={isGenerating || !card || !card.oracle_text}
          className="mt-2 rounded bg-indigo-400 px-3 py-2 text-xs font-semibold text-indigo-950 disabled:cursor-not-allowed disabled:opacity-50"
          title={
            card?.oracle_text
              ? 'Use AI to draft a behavior script from this card’s rules text. Review before saving.'
              : 'This card has no rules text to generate from.'
          }
        >
          {isGenerating ? 'Generating…' : '✨ Generate with AI'}
        </button>

        <button
          type="button"
          onClick={handleRelink}
          disabled={isRelinking}
          className="rounded border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
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
            <div className="flex overflow-hidden rounded border border-slate-700">
              <button
                type="button"
                onClick={switchToForm}
                disabled={!selectedCardId || formCompatibleDraft === null}
                className={`px-2 py-1 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${
                  editorMode === 'form'
                    ? 'bg-fuchsia-300 text-fuchsia-950'
                    : 'bg-slate-900 text-slate-300'
                }`}
                title={
                  formCompatibleDraft === null
                    ? 'This script uses fields the guided form cannot edit.'
                    : undefined
                }
              >
                Form
              </button>
              <button
                type="button"
                onClick={() => setEditorMode('json')}
                disabled={!selectedCardId}
                className={`px-2 py-1 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${
                  editorMode === 'json'
                    ? 'bg-fuchsia-300 text-fuchsia-950'
                    : 'bg-slate-900 text-slate-300'
                }`}
              >
                JSON
              </button>
            </div>
            <button
              type="button"
              onClick={handleFormat}
              disabled={!draft.trim() || editorMode === 'form'}
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

        {editorMode === 'form' ? (
          <div className="min-h-[420px] rounded border border-slate-800 bg-slate-950/40 p-3">
            <CardBehaviorForm
              value={formValue}
              onChange={handleFormChange}
              disabled={isLoading || !selectedCardId}
            />
          </div>
        ) : (
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={isLoading || !selectedCardId}
            spellCheck={false}
            placeholder={selectedCardId ? EMPTY_SCRIPT_PLACEHOLDER : 'Select a card to edit its behavior.'}
            className="min-h-[420px] w-full resize-y rounded border border-slate-800 bg-slate-900 p-3 font-mono text-xs leading-relaxed text-slate-100 disabled:opacity-50"
          />
        )}

        {editorMode === 'form' && draft.trim() ? (
          <details className="rounded border border-slate-800 bg-slate-900/60 p-3">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-400">
              Generated JSON
            </summary>
            <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-slate-200">
              {draft}
            </pre>
          </details>
        ) : null}

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
