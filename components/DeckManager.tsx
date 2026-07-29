'use client'

import { useEffect, useMemo, useState } from 'react'
import CardCatalogPicker from '@/components/CardCatalogPicker'
import CardBehaviorEditor from '@/components/CardBehaviorEditor'
import DeckHeaderBand from '@/components/deck/DeckHeaderBand'
import DeckInsightsStrip from '@/components/deck/DeckInsightsStrip'
import { importDeckFromText, getErrorMessage, getDeckLegality, setCardScript, setDeckCommander, updateDeckList, type DeckLegality } from '@/lib/game/actions'
import { getCardConfigStatus, type CardConfigStatus } from '@/lib/game/card-behavior'
import { manaValue } from '@/lib/game/deck-insights'
import { getDeckDetail, getUserDecks } from '@/lib/game/data'
import { createClient } from '@/lib/supabase/client'
import type { DeckCardLine, DeckDetail, DeckSummary, LinkedCard } from '@/lib/game/types'

export default function DeckManager() {
  const supabase = useMemo(() => createClient(), [])
  const [decks, setDecks] = useState<DeckSummary[]>([])
  const [selectedDeckId, setSelectedDeckId] = useState('')
  const [selectedDeck, setSelectedDeck] = useState<DeckDetail | null>(null)
  const [selectedCardId, setSelectedCardId] = useState('')
  const [addQuantity, setAddQuantity] = useState(1)
  const [deckNameInput, setDeckNameInput] = useState('')
  const [decklistInput, setDecklistInput] = useState('')
  const [missingLines, setMissingLines] = useState<Array<{ line: string; name: string }> | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [isWorking, setIsWorking] = useState(false)
  const [forgeOpen, setForgeOpen] = useState(false)
  // Deck-list view controls + ergonomics.
  const [showNeedsOnly, setShowNeedsOnly] = useState(false)
  const [sortKey, setSortKey] = useState<'name' | 'cmc' | 'type' | 'behavior'>('name')
  const [sampleHand, setSampleHand] = useState<string[] | null>(null)
  const [preview, setPreview] = useState<LinkedCard | null>(null)
  const [batch, setBatch] = useState<{ done: number; total: number; ok: number; failed: number } | null>(null)
  const [behaviorCardId, setBehaviorCardId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const [legality, setLegality] = useState<DeckLegality | null>(null)

  // Remember the grid/list choice across sessions.
  useEffect(() => {
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem('deckViewMode') : null
    if (saved === 'grid' || saved === 'list') setViewMode(saved)
  }, [])
  useEffect(() => {
    if (typeof window !== 'undefined') window.localStorage.setItem('deckViewMode', viewMode)
  }, [viewMode])

  const refreshDecks = async () => {
    const nextDecks = await getUserDecks(supabase)
    setDecks(nextDecks)
    setSelectedDeckId((current) => current || nextDecks[0]?.id || '')
  }

  const refreshSelectedDeck = async (deckId = selectedDeckId) => {
    if (!deckId) {
      setSelectedDeck(null)
      return
    }

    const deck = await getDeckDetail(supabase, deckId)
    setSelectedDeck(deck)
  }

  useEffect(() => {
    let isMounted = true

    const loadDecks = async () => {
      try {
        const nextDecks = await getUserDecks(supabase)

        if (isMounted) {
          setDecks(nextDecks)
          setSelectedDeckId((current) => current || nextDecks[0]?.id || '')
        }
      } catch (error) {
        const message = getErrorMessage(error)
        console.error('Failed to load decks:', message, error)
        if (isMounted) {
          setErrorMessage(message)
        }
      }
    }

    loadDecks()

    return () => {
      isMounted = false
    }
  }, [supabase])

  useEffect(() => {
    if (!selectedDeckId) {
      setSelectedDeck(null)
      return
    }

    let isMounted = true

    const loadDeck = async () => {
      try {
        const deck = await getDeckDetail(supabase, selectedDeckId)

        if (isMounted) {
          setSelectedDeck(deck)
        }
      } catch (error) {
        const message = getErrorMessage(error)
        console.error('Failed to load deck:', message, error)
        if (isMounted) {
          setErrorMessage(message)
        }
      }
    }

    loadDeck()

    return () => {
      isMounted = false
    }
  }, [selectedDeckId, supabase])

  // Authoritative Commander legality, refreshed whenever the deck changes. Only
  // for decks with a commander designated (otherwise every standard deck would
  // read as "illegal: not 100 cards").
  useEffect(() => {
    if (!selectedDeck?.commander_card_id) {
      setLegality(null)
      return
    }
    let alive = true
    getDeckLegality(supabase, selectedDeck.id)
      .then((result) => { if (alive) setLegality(result) })
      .catch(() => { if (alive) setLegality(null) })
    return () => { alive = false }
  }, [selectedDeck, supabase])

  const handleImportDeck = async () => {
    const deckName = deckNameInput.trim()
    const decklist = decklistInput.trim()

    if (!deckName) {
      setErrorMessage('Enter a deck name')
      return
    }

    if (!decklist) {
      setErrorMessage('Paste a decklist')
      return
    }

    setErrorMessage(null)
    setStatusMessage(null)
    setMissingLines(null)
    setIsWorking(true)

    try {
      const result = await importDeckFromText(supabase, deckName, decklist)
      setMissingLines(result.missing?.map((item) => ({ line: item.line, name: item.name })) ?? null)
      setStatusMessage(
        result.card_count === 0
          ? 'No cards were imported. Check the not accepted lines below.'
          : result.missing?.length
          ? `Imported ${result.card_count} card(s). ${result.missing.length} line(s) were not accepted.`
          : `Imported ${result.card_count} card(s).`,
      )
      if (result.card_count > 0 && result.id) {
        setDeckNameInput('')
        setDecklistInput('')
        setForgeOpen(false)
        await refreshDecks()
        setSelectedDeckId(result.id)
      }
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to import deck:', message, error)
      setErrorMessage(message)
    } finally {
      setIsWorking(false)
    }
  }

  const saveDeckCards = async (deckId: string, cardIds: string[], success: string) => {
    setErrorMessage(null)
    setStatusMessage(null)
    setIsWorking(true)

    try {
      const result = await updateDeckList(supabase, deckId, cardIds)
      setStatusMessage(`${success} ${result.card_count} card(s) in deck.`)
      await refreshDecks()
      await refreshSelectedDeck(deckId)
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to update deck:', message, error)
      setErrorMessage(message)
    } finally {
      setIsWorking(false)
    }
  }

  const handleAddCard = async () => {
    if (!selectedDeck || !selectedCardId) {
      return
    }

    const quantity = Math.max(1, Math.min(addQuantity, 99))
    const cardIds = [
      ...expandDeckCardIds(selectedDeck),
      ...Array.from({ length: quantity }, () => selectedCardId),
    ]

    await saveDeckCards(selectedDeck.id, cardIds, 'Added card.')
  }

  const handleSetQuantity = async (cardId: string, nextQuantity: number) => {
    if (!selectedDeck) {
      return
    }

    const quantity = Math.max(0, Math.min(nextQuantity, 99))
    const cardIds = selectedDeck.cards.flatMap((line) =>
      line.card_id === cardId ? Array.from({ length: quantity }, () => cardId) : Array.from({ length: line.quantity }, () => line.card_id),
    )

    if (cardIds.length === 0) {
      setErrorMessage('Deck must contain at least one card')
      return
    }

    await saveDeckCards(selectedDeck.id, cardIds, quantity === 0 ? 'Removed card.' : 'Updated quantity.')
  }

  // Designate (or clear) the deck's commander for Commander games.
  const handleSetCommander = async (cardId: string | null) => {
    if (!selectedDeck) return
    setErrorMessage(null)
    setStatusMessage(null)
    setIsWorking(true)
    try {
      await setDeckCommander(supabase, selectedDeck.id, cardId)
      await refreshSelectedDeck(selectedDeck.id)
      setStatusMessage(cardId ? 'Commander set.' : 'Commander cleared.')
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    } finally {
      setIsWorking(false)
    }
  }

  // Generate behavior scripts (via the AI route) for every deck card that still
  // needs one. Sequential to be gentle on the API; saves each validated script.
  const handleBatchGenerate = async () => {
    if (!selectedDeck) return
    const seen = new Set<string>()
    const needs: LinkedCard[] = []
    for (const line of selectedDeck.cards) {
      const card = line.card
      if (!card || seen.has(card.id) || getCardConfigStatus(card) !== 'needs') continue
      seen.add(card.id)
      needs.push(card)
    }
    if (needs.length === 0) {
      setStatusMessage('No cards need behavior.')
      return
    }
    if (!window.confirm(`Generate behavior for ${needs.length} card(s) with AI? This calls the AI once per card (uses tokens).`)) {
      return
    }

    setErrorMessage(null)
    setStatusMessage(null)
    setIsWorking(true)
    let ok = 0
    let failed = 0
    setBatch({ done: 0, total: needs.length, ok: 0, failed: 0 })
    for (let i = 0; i < needs.length; i += 1) {
      const card = needs[i]!
      try {
        const response = await fetch('/api/cards/generate-behavior', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: card.name, type_line: card.type_line, oracle_text: card.oracle_text }),
        })
        const payload = (await response.json()) as { script?: unknown; error?: string }
        if (!response.ok || !payload.script) {
          // Server not configured (no API key) → abort the whole batch.
          if (response.status === 501 || /not configured/i.test(payload.error ?? '')) {
            setErrorMessage(payload.error ?? 'AI generation is not configured.')
            break
          }
          failed += 1
        } else {
          await setCardScript(supabase, card.id, payload.script as Parameters<typeof setCardScript>[2])
          ok += 1
        }
      } catch {
        failed += 1
      }
      setBatch({ done: i + 1, total: needs.length, ok, failed })
    }
    await refreshSelectedDeck(selectedDeck.id)
    setBatch(null)
    setIsWorking(false)
    setStatusMessage(`Generated ${ok} / ${needs.length}.${failed ? ` ${failed} need manual editing.` : ''}`)
  }

  // Copy the deck as importer-compatible text to the clipboard.
  const handleExport = async () => {
    if (!selectedDeck) return
    setErrorMessage(null)
    try {
      await navigator.clipboard.writeText(deckToText(selectedDeck))
      setStatusMessage('Decklist copied to clipboard.')
    } catch {
      setErrorMessage('Could not copy to clipboard.')
    }
  }

  // Clone the deck (round-trips through the importer, carrying the commander).
  const handleClone = async () => {
    if (!selectedDeck) return
    setErrorMessage(null)
    setStatusMessage(null)
    setIsWorking(true)
    try {
      const result = await importDeckFromText(supabase, `${selectedDeck.name ?? 'Deck'} (copy)`, deckToText(selectedDeck))
      await refreshDecks()
      if (result.id) {
        setSelectedDeckId(result.id)
        await refreshSelectedDeck(result.id)
      }
      setStatusMessage('Deck cloned.')
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    } finally {
      setIsWorking(false)
    }
  }

  // Close the behavior popup and refresh the deck so the badges reflect the new script.
  const closeBehavior = () => {
    setBehaviorCardId(null)
    void refreshSelectedDeck()
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-[250px_minmax(0,1fr)] items-start">
      <section className="leyline-glass-panel min-w-0 p-3.5">
        <div className="mb-1 flex items-center justify-between gap-2 px-1.5 pb-2 pt-1">
          <h2 className="font-display text-[11px] uppercase tracking-[0.28em] text-[var(--frame-gold)]">
            Your spellbook
          </h2>
          <button
            type="button"
            onClick={() => refreshDecks().catch((error) => setErrorMessage(getErrorMessage(error)))}
            disabled={isWorking}
            className="text-[11px] font-semibold text-[var(--text-faint)] hover:text-[var(--text-dim)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Refresh
          </button>
        </div>

        {decks.length === 0 ? (
          <p className="px-1.5 py-2 text-sm text-[var(--text-faint)]">No decks yet.</p>
        ) : (
          <div className="grid gap-2">
            {decks.map((deck) => (
              <button
                key={deck.id}
                type="button"
                onClick={() => setSelectedDeckId(deck.id)}
                disabled={isWorking}
                className={`rounded-xl border-l-4 px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  selectedDeckId === deck.id
                    ? 'border-l-[var(--frame-gold)] bg-[rgba(255,212,121,0.08)]'
                    : 'border-l-transparent bg-[rgba(255,255,255,0.03)] hover:bg-[rgba(255,255,255,0.05)]'
                }`}
              >
                <p className="text-[13.5px] font-semibold text-[var(--text)]">{deck.name || 'Untitled Deck'}</p>
                <p className="mt-0.5 text-[11px] text-[var(--text-faint)]">{deck.card_count} kaarten</p>
              </button>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={() => setForgeOpen(true)}
          className="mt-2 px-1.5 py-1 text-left text-[12.5px] font-semibold text-[var(--gold-bright)] hover:underline"
        >
          + Forge new deck (paste a list)
        </button>
      </section>

      {forgeOpen ? (
        <section className="leyline-glass-panel min-w-0 p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-display text-lg tracking-wide text-[var(--gold-bright)]">Forge new deck</h2>
            <button
              type="button"
              onClick={() => setForgeOpen(false)}
              className="text-xs font-semibold text-[var(--text-faint)] hover:text-[var(--text-dim)]"
            >
              Cancel
            </button>
          </div>
          <p className="mt-1 text-sm text-[var(--text-dim)]">
            Paste a plain text decklist. Lines can use counts such as 4 Lightning Bolt or 4x Counterspell.
          </p>

          <div className="mt-4 grid gap-3">
            <input
              value={deckNameInput}
              onChange={(event) => setDeckNameInput(event.target.value)}
              placeholder="Deck name"
              className="rounded-lg border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.05)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--frame-gold)]/60"
            />
            <textarea
              value={decklistInput}
              onChange={(event) => setDecklistInput(event.target.value)}
              placeholder={`4 Lightning Bolt\n4 Counterspell\n24 Island`}
              rows={16}
              className="min-h-96 rounded-lg border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.05)] px-3 py-2 font-mono text-sm text-[var(--text)] outline-none focus:border-[var(--frame-gold)]/60"
            />
            <button
              type="button"
              onClick={handleImportDeck}
              disabled={isWorking}
              className="rounded-lg bg-gradient-to-b from-[var(--gold-bright)] to-[var(--frame-gold)] px-4 py-2 text-sm font-semibold text-[#221a08] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isWorking ? 'Importing...' : 'Import Deck'}
            </button>
          </div>

          {missingLines?.length ? (
            <div className="mt-4 rounded-lg border border-[var(--warn)]/30 bg-[var(--warn)]/10 p-3 text-xs text-[var(--warn)]">
              <p className="font-semibold">Not accepted</p>
              <p className="mt-1 text-[var(--warn)]/90">
                These lines did not match a card in the catalog and were skipped.
              </p>
              <ul className="mt-2 space-y-1">
                {missingLines.slice(0, 12).map((item) => (
                  <li key={`${item.name}-${item.line}`}>{item.line}</li>
                ))}
              </ul>
              {missingLines.length > 12 ? (
                <p className="mt-2 text-[var(--warn)]/90">+{missingLines.length - 12} more</p>
              ) : null}
            </div>
          ) : null}

          {statusMessage ? <p className="mt-3 text-sm text-[var(--cast)]">{statusMessage}</p> : null}
          {errorMessage ? <p className="mt-3 text-sm text-[var(--danger)]">{errorMessage}</p> : null}
        </section>
      ) : selectedDeck ? (
        <section className="leyline-glass-panel min-w-0 p-0">
            {(() => {
              const statusCounts = selectedDeck.cards.reduce(
                (acc, line) => {
                  acc[getCardConfigStatus(line.card ?? {})] += line.quantity
                  return acc
                },
                { scripted: 0, vanilla: 0, needs: 0 } as Record<CardConfigStatus, number>,
              )
              return (
                <>
                  {/* Band 1: commander art + name + status counts + legality chip */}
                  <DeckHeaderBand deck={selectedDeck} statusCounts={statusCounts} legality={legality} />

                  {/* Band 2: collapsible insights strip (curve, types, colours, checks) */}
                  <DeckInsightsStrip
                    cards={selectedDeck.cards}
                    commanderCard={selectedDeck.cards.find((l) => l.card_id === selectedDeck.commander_card_id)?.card ?? null}
                  />

                  {/* Band 3: unified toolbar — deck tools left, Add Card right */}
                  <div className="flex flex-wrap items-center gap-2 border-t border-[rgba(255,255,255,0.06)] px-5 py-3">
                    <button
                      type="button"
                      onClick={handleBatchGenerate}
                      disabled={isWorking}
                      className="rounded-[10px] border border-[var(--gold-bright)]/40 px-[13px] py-2 text-[12.5px] font-semibold text-[var(--gold-bright)] disabled:opacity-50"
                    >
                      ✨ Generate behavior ({statusCounts.needs})
                    </button>
                    {batch && (
                      <span className="text-[12.5px] text-[var(--gold-bright)]">
                        {batch.done}/{batch.total} · {batch.ok} ok{batch.failed ? ` · ${batch.failed} failed` : ''}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => setSampleHand(sampleOpeningHand(selectedDeck))}
                      className="rounded-[10px] border border-[rgba(255,255,255,0.14)] px-[13px] py-2 text-[12.5px] font-semibold text-[var(--text-dim)] hover:bg-[rgba(255,255,255,0.05)]"
                    >
                      Sample hand
                    </button>
                    <button
                      type="button"
                      onClick={handleExport}
                      className="rounded-[10px] border border-[rgba(255,255,255,0.14)] px-[13px] py-2 text-[12.5px] font-semibold text-[var(--text-dim)] hover:bg-[rgba(255,255,255,0.05)]"
                    >
                      Copy as text
                    </button>
                    <button
                      type="button"
                      onClick={handleClone}
                      disabled={isWorking}
                      className="rounded-[10px] border border-[rgba(255,255,255,0.14)] px-[13px] py-2 text-[12.5px] font-semibold text-[var(--text-dim)] hover:bg-[rgba(255,255,255,0.05)] disabled:opacity-50"
                    >
                      Clone
                    </button>

                    <div className="ml-auto flex flex-wrap items-center gap-1.5">
                      <div className="min-w-[220px]">
                        <CardCatalogPicker value={selectedCardId} onChange={setSelectedCardId} disabled={isWorking} />
                      </div>
                      <input
                        type="number"
                        min={1}
                        max={99}
                        value={addQuantity}
                        onChange={(event) => setAddQuantity(Number(event.target.value))}
                        className="w-20 rounded-[10px] border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.05)] px-3 py-2 text-[12.5px] text-[var(--text)]"
                      />
                      <button
                        type="button"
                        onClick={handleAddCard}
                        disabled={isWorking || !selectedCardId}
                        className="rounded-[10px] px-4 py-2 text-[12.5px] font-semibold text-[#221a08] disabled:cursor-not-allowed disabled:opacity-50"
                        style={{ background: 'linear-gradient(160deg,#f2c96a,#d99a2b)' }}
                      >
                        + Add
                      </button>
                    </div>
                  </div>
                </>
              )
            })()}

            <div className="px-5 pb-5 pt-1.5">
            {/* List controls */}
            <div className="mt-4 flex flex-wrap items-center gap-1.5 text-xs text-[var(--text-faint)]">
              <div className="inline-flex overflow-hidden rounded-lg border border-[rgba(255,255,255,0.12)]">
                {(['grid', 'list'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setViewMode(mode)}
                    aria-pressed={viewMode === mode}
                    className={`px-[11px] py-[5px] text-[11.5px] font-semibold capitalize ${
                      viewMode === mode
                        ? 'bg-[rgba(255,212,121,0.14)] text-[var(--gold-bright)]'
                        : 'text-[var(--text-dim)] hover:bg-[rgba(255,255,255,0.05)]'
                    }`}
                  >
                    {mode}
                  </button>
                ))}
              </div>
              {viewMode === 'list' && (
                <div className="inline-flex overflow-hidden rounded-lg border border-[rgba(255,255,255,0.12)]">
                  {(
                    [
                      ['name', 'Name'],
                      ['cmc', 'MV'],
                      ['type', 'Type'],
                      ['behavior', 'Behavior'],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setSortKey(key)}
                      aria-pressed={sortKey === key}
                      className={`px-[11px] py-[5px] text-[11.5px] font-semibold ${
                        sortKey === key
                          ? 'bg-[rgba(255,212,121,0.14)] text-[var(--gold-bright)]'
                          : 'text-[var(--text-dim)] hover:bg-[rgba(255,255,255,0.05)]'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[var(--text-dim)]">
                <input
                  type="checkbox"
                  checked={showNeedsOnly}
                  onChange={(event) => setShowNeedsOnly(event.target.checked)}
                />
                Needs behavior only
              </label>
            </div>

            {viewMode === 'grid' ? (
              <DeckGrid
                deck={selectedDeck}
                showNeedsOnly={showNeedsOnly}
                isWorking={isWorking}
                onSetQuantity={handleSetQuantity}
                onSetCommander={handleSetCommander}
                onEditBehavior={setBehaviorCardId}
                onPreview={setPreview}
              />
            ) : (
            <div className="mt-2 grid gap-2 lg:grid-cols-2">
              {[...selectedDeck.cards]
                .filter((line) => !showNeedsOnly || getCardConfigStatus(line.card ?? {}) === 'needs')
                .sort((a, b) => {
                  if (sortKey === 'cmc') return manaValue(a.card?.mana_cost) - manaValue(b.card?.mana_cost)
                  if (sortKey === 'type') return (a.card?.type_line ?? '').localeCompare(b.card?.type_line ?? '')
                  if (sortKey === 'behavior') {
                    return BEHAVIOR_RANK[getCardConfigStatus(a.card ?? {})] - BEHAVIOR_RANK[getCardConfigStatus(b.card ?? {})]
                  }
                  return (a.card?.name ?? a.card_id).localeCompare(b.card?.name ?? b.card_id)
                })
                .map((line) => {
                const isCommander = selectedDeck.commander_card_id === line.card_id
                const badge = BEHAVIOR_BADGE[getCardConfigStatus(line.card ?? {})]
                return (
                  <div
                    key={line.card_id}
                    className={`grid grid-cols-[72px_1fr_auto] items-center gap-2 rounded-md bg-[#1c1e24] p-2 ${
                      isCommander
                        ? 'shadow-[inset_0_0_0_2px_var(--frame-gold),0_0_18px_rgba(232,180,76,0.25)]'
                        : 'shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]'
                    }`}
                  >
                    <input
                      type="number"
                      min={0}
                      max={99}
                      value={line.quantity}
                      onChange={(event) => handleSetQuantity(line.card_id, Number(event.target.value))}
                      disabled={isWorking}
                      className="rounded border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.05)] px-2 py-1 text-sm text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-50"
                    />
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 truncate text-sm font-semibold text-[var(--text)]">
                        <button
                          type="button"
                          onClick={() => line.card && setPreview(line.card)}
                          disabled={!line.card?.image_url}
                          className="truncate text-left hover:underline disabled:no-underline"
                          title={line.card?.image_url ? 'Preview card' : undefined}
                        >
                          {line.card?.name || line.card_id}
                        </button>
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${badge.cls}`}>
                          {badge.label}
                        </span>
                        {isCommander && <span className="shrink-0 text-xs font-bold text-[var(--gold-bright)]">★ Commander</span>}
                      </p>
                      <p className="truncate text-xs text-[var(--text-faint)]">
                        {[line.card?.mana_cost, line.card?.type_line].filter(Boolean).join(' - ')}
                      </p>
                    </div>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => setBehaviorCardId(line.card_id)}
                        title="Edit this card's behavior"
                        className="rounded border border-[rgba(255,255,255,0.14)] px-2 py-1 text-xs font-semibold text-[var(--text-dim)] hover:bg-[rgba(255,255,255,0.05)]"
                      >
                        Behavior
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSetCommander(isCommander ? null : line.card_id)}
                        disabled={isWorking}
                        title={isCommander ? 'Clear commander' : 'Set as commander'}
                        className={`rounded px-2 py-1 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
                          isCommander ? 'bg-[var(--gold-bright)] text-[#221a08]' : 'bg-[rgba(255,255,255,0.08)] text-[var(--text-dim)]'
                        }`}
                      >
                        ★
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSetQuantity(line.card_id, 0)}
                        disabled={isWorking}
                        className="rounded bg-[var(--danger)] px-2 py-1 text-xs font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
            )}
            </div>
        </section>
      ) : (
        <section className="leyline-glass-panel min-w-0 p-8 text-center">
          <p className="text-sm text-[var(--text-faint)]">Select a deck or forge a new one.</p>
        </section>
      )}
      </div>

      {/* Sample opening hand */}
      {sampleHand && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setSampleHand(null)}
        >
          <div className="w-full max-w-sm rounded-lg border border-[rgba(255,255,255,0.12)] bg-[#1c1e24] p-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-2 text-sm font-bold text-[var(--text)]">Sample opening hand</h3>
            <ul className="space-y-1 text-sm text-[var(--text)]">
              {sampleHand.map((name, i) => (
                <li key={i} className="rounded bg-[rgba(255,255,255,0.05)] px-2 py-1">{name}</li>
              ))}
            </ul>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => selectedDeck && setSampleHand(sampleOpeningHand(selectedDeck))}
                className="flex-1 rounded-md px-3 py-2 text-xs font-semibold text-[#221a08]"
                style={{ background: 'linear-gradient(160deg,#f2c96a,#d99a2b)' }}
              >
                Redraw
              </button>
              <button
                type="button"
                onClick={() => setSampleHand(null)}
                className="flex-1 rounded-md border border-[rgba(255,255,255,0.14)] px-3 py-2 text-xs font-semibold text-[var(--text-dim)] hover:bg-[rgba(255,255,255,0.05)]"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Card image preview */}
      {preview?.image_url && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setPreview(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={preview.image_url}
            alt={preview.name ?? 'Card'}
            className="max-h-[85vh] max-w-[90vw] rounded-xl shadow-2xl"
          />
        </div>
      )}

      {/* Card behavior editor (popup) — edit a deck card's script without leaving the page */}
      {behaviorCardId && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/80 p-4"
          onClick={closeBehavior}
        >
          <div
            className="my-4 w-full max-w-6xl rounded-lg border border-[rgba(255,255,255,0.12)] bg-[#1c1e24] p-4"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-bold text-[var(--text)]">Card behavior</h3>
              <button
                type="button"
                onClick={closeBehavior}
                className="rounded border border-[rgba(255,255,255,0.14)] px-3 py-1 text-xs font-semibold text-[var(--text-dim)] hover:bg-[rgba(255,255,255,0.05)]"
              >
                Close
              </button>
            </div>
            <CardBehaviorEditor initialCardId={behaviorCardId} />
          </div>
        </div>
      )}
    </div>
  )
}

const BEHAVIOR_BADGE: Record<CardConfigStatus, { label: string; cls: string }> = {
  scripted: { label: 'Behavior', cls: 'bg-[rgba(143,214,162,0.2)] text-[var(--cast)]' },
  vanilla: { label: 'Vanilla', cls: 'bg-[rgba(255,255,255,0.08)] text-[var(--text-dim)]' },
  needs: { label: 'Needs behavior', cls: 'bg-[rgba(233,161,120,0.25)] text-[var(--warn)]' },
}

const BEHAVIOR_RANK: Record<CardConfigStatus, number> = { needs: 0, vanilla: 1, scripted: 2 }

// Render a deck as importer-compatible text (round-trips import_deck_from_text).
// The commander goes under a "Commander" header so a re-import re-captures it.
function deckToText(deck: DeckDetail): string {
  const lines: string[] = []
  const commander = deck.cards.find((line) => line.card_id === deck.commander_card_id)
  if (commander) {
    lines.push('Commander', `1 ${commander.card?.name ?? commander.card_id}`, '', 'Deck')
  }
  for (const line of deck.cards) {
    const name = line.card?.name ?? line.card_id
    if (commander && line.card_id === commander.card_id) {
      if (line.quantity > 1) lines.push(`${line.quantity - 1} ${name}`)
      continue
    }
    lines.push(`${line.quantity} ${name}`)
  }
  return lines.join('\n')
}

// Draw 7 random card names from the deck (a sample opening hand).
function sampleOpeningHand(deck: DeckDetail): string[] {
  const pool: string[] = []
  for (const line of deck.cards) {
    const name = line.card?.name ?? line.card_id
    for (let i = 0; i < line.quantity; i += 1) pool.push(name)
  }
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j]!, pool[i]!]
  }
  return pool.slice(0, 7)
}

function expandDeckCardIds(deck: DeckDetail) {
  return deck.cards.flatMap((line) => Array.from({ length: line.quantity }, () => line.card_id))
}

// --- visual grid view -------------------------------------------------------
const GROUP_ORDER = [
  'Creatures', 'Planeswalkers', 'Instants', 'Sorceries',
  'Artifacts', 'Enchantments', 'Battles', 'Lands', 'Other',
] as const

/** Primary deck group for a type line. Order matters: a "Land Creature" is a
 *  Creature; an "Artifact Land" is a Land. */
function deckGroup(typeLine: string | null | undefined): string {
  const t = (typeLine ?? '').toLowerCase()
  if (t.includes('creature')) return 'Creatures'
  if (t.includes('planeswalker')) return 'Planeswalkers'
  if (t.includes('land')) return 'Lands'
  if (t.includes('artifact')) return 'Artifacts'
  if (t.includes('enchantment')) return 'Enchantments'
  if (t.includes('battle')) return 'Battles'
  if (t.includes('instant')) return 'Instants'
  if (t.includes('sorcery')) return 'Sorceries'
  return 'Other'
}

type TileHandlers = {
  isWorking: boolean
  onSetQuantity: (cardId: string, nextQuantity: number) => void
  onSetCommander: (cardId: string | null) => void
  onEditBehavior: (cardId: string) => void
  onPreview: (card: LinkedCard) => void
}

function DeckGrid({
  deck,
  showNeedsOnly,
  ...handlers
}: { deck: DeckDetail; showNeedsOnly: boolean } & TileHandlers) {
  const filtered = deck.cards.filter(
    (line) => !showNeedsOnly || getCardConfigStatus(line.card ?? {}) === 'needs',
  )
  const groups = new Map<string, DeckCardLine[]>()
  for (const line of filtered) {
    const g = deckGroup(line.card?.type_line)
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(line)
  }
  for (const arr of groups.values()) {
    arr.sort(
      (a, b) =>
        manaValue(a.card?.mana_cost) - manaValue(b.card?.mana_cost) ||
        (a.card?.name ?? a.card_id).localeCompare(b.card?.name ?? b.card_id),
    )
  }
  const ordered = GROUP_ORDER.filter((g) => groups.has(g))
  if (ordered.length === 0) {
    return <p className="mt-3 text-sm text-[var(--text-faint)]">No cards match.</p>
  }
  return (
    <div className="mt-2 space-y-5">
      {ordered.map((g) => {
        const lines = groups.get(g)!
        const total = lines.reduce((sum, l) => sum + l.quantity, 0)
        return (
          <div key={g}>
            <h4 className="mb-2 font-display text-[11px] uppercase tracking-[0.14em] text-[var(--text-faint)]">
              {g} <span className="text-[var(--text-dim)]">· {total}</span>
            </h4>
            <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              {lines.map((line) => (
                <DeckCardTile
                  key={line.card_id}
                  line={line}
                  isCommander={deck.commander_card_id === line.card_id}
                  status={getCardConfigStatus(line.card ?? {})}
                  {...handlers}
                />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function DeckCardTile({
  line,
  isCommander,
  status,
  isWorking,
  onSetQuantity,
  onSetCommander,
  onEditBehavior,
  onPreview,
}: { line: DeckCardLine; isCommander: boolean; status: CardConfigStatus } & TileHandlers) {
  const card = line.card
  const badge = BEHAVIOR_BADGE[status]
  return (
    <div
      className={`relative overflow-hidden rounded-[10px] bg-[#1c1e24] ${
        isCommander
          ? 'shadow-[inset_0_0_0_2px_var(--frame-gold),0_0_18px_rgba(232,180,76,0.25)]'
          : 'shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]'
      }`}
    >
      <button
        type="button"
        onClick={() => card && onPreview(card)}
        disabled={!card?.image_url}
        className="block w-full"
        title={card?.image_url ? 'Preview card' : undefined}
      >
        {card?.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={card.image_url}
            alt={card?.name ?? ''}
            loading="lazy"
            className="aspect-[2/3] w-full bg-[#1c1e24] object-cover"
          />
        ) : (
          <div className="flex aspect-[2/3] w-full items-center justify-center bg-[#1c1e24] p-2 text-center">
            <span className="line-clamp-4 text-[11px] font-semibold text-[var(--text-dim)]">
              {card?.name ?? line.card_id}
            </span>
          </div>
        )}
      </button>

      <span className="pointer-events-none absolute left-1 top-1 rounded-[6px] bg-[rgba(0,0,0,0.72)] px-1.5 py-0.5 text-[11px] font-extrabold text-[var(--gold-bright)]">
        ×{line.quantity}
      </span>

      <button
        type="button"
        onClick={() => onEditBehavior(line.card_id)}
        title="Edit behavior"
        className={`absolute right-1 top-1 rounded-[5px] px-1 py-0.5 text-[8.5px] font-extrabold uppercase ${badge.cls}`}
      >
        {status === 'scripted' ? '✓ beh' : status === 'needs' ? 'needs' : 'van'}
      </button>

      {isCommander && (
        <span className="pointer-events-none absolute bottom-[34px] left-1 rounded-[5px] bg-[var(--frame-gold)] px-1.5 py-px text-[9px] font-extrabold text-[#221a08]">
          ★ CMD
        </span>
      )}

      <div className="flex items-stretch gap-px bg-[rgba(255,255,255,0.07)] text-xs">
        <button
          type="button"
          onClick={() => onSetQuantity(line.card_id, line.quantity - 1)}
          disabled={isWorking}
          className="flex-1 bg-[rgba(255,255,255,0.05)] py-1 font-bold text-[var(--text-dim)] hover:bg-[rgba(255,212,121,0.12)] hover:text-[var(--gold-bright)] disabled:opacity-50"
        >
          −
        </button>
        <span className="flex-1 bg-[rgba(255,255,255,0.05)] py-1 text-center font-semibold text-[var(--text)]">{line.quantity}</span>
        <button
          type="button"
          onClick={() => onSetQuantity(line.card_id, line.quantity + 1)}
          disabled={isWorking}
          className="flex-1 bg-[rgba(255,255,255,0.05)] py-1 font-bold text-[var(--text-dim)] hover:bg-[rgba(255,212,121,0.12)] hover:text-[var(--gold-bright)] disabled:opacity-50"
        >
          ＋
        </button>
        <button
          type="button"
          onClick={() => onSetCommander(isCommander ? null : line.card_id)}
          disabled={isWorking}
          title={isCommander ? 'Clear commander' : 'Set as commander'}
          className={`flex-1 py-1 font-bold disabled:opacity-50 ${
            isCommander
              ? 'bg-[var(--gold-bright)] text-[#221a08]'
              : 'bg-[rgba(255,255,255,0.05)] text-[var(--text-dim)] hover:bg-[rgba(255,212,121,0.12)] hover:text-[var(--gold-bright)]'
          }`}
        >
          ★
        </button>
        <button
          type="button"
          onClick={() => onSetQuantity(line.card_id, 0)}
          disabled={isWorking}
          title="Remove"
          className="flex-1 bg-[var(--danger)]/80 py-1 font-bold text-white hover:bg-[var(--danger)] disabled:opacity-50"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
