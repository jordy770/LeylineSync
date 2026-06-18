'use client'

import { useEffect, useMemo, useState } from 'react'
import CardCatalogPicker from '@/components/CardCatalogPicker'
import CardBehaviorEditor from '@/components/CardBehaviorEditor'
import DeckInsights from '@/components/DeckInsights'
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
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)]">
      <section className="min-w-0 rounded-lg border border-slate-800 bg-slate-950 p-5 text-white">
        <h2 className="font-display text-lg tracking-wide text-amber-200/90">Create Deck</h2>
        <p className="mt-1 text-sm text-slate-400">
          Paste a plain text decklist. Lines can use counts such as 4 Lightning Bolt or 4x Counterspell.
        </p>

        <div className="mt-4 grid gap-3">
          <input
            value={deckNameInput}
            onChange={(event) => setDeckNameInput(event.target.value)}
            placeholder="Deck name"
            className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-slate-400"
          />
          <textarea
            value={decklistInput}
            onChange={(event) => setDecklistInput(event.target.value)}
            placeholder={`4 Lightning Bolt\n4 Counterspell\n24 Island`}
            rows={16}
            className="min-h-96 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-sm text-white outline-none focus:border-slate-400"
          />
          <button
            type="button"
            onClick={handleImportDeck}
            disabled={isWorking}
            className="rounded-md bg-amber-400 px-4 py-2 text-sm font-semibold text-amber-950 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isWorking ? 'Importing...' : 'Import Deck'}
          </button>
        </div>

        {missingLines?.length ? (
          <div className="mt-4 rounded border border-amber-900 bg-amber-950/40 p-3 text-xs text-amber-200">
            <p className="font-semibold">Not accepted</p>
            <p className="mt-1 text-amber-300">
              These lines did not match a card in the catalog and were skipped.
            </p>
            <ul className="mt-2 space-y-1">
              {missingLines.slice(0, 12).map((item) => (
                <li key={`${item.name}-${item.line}`}>{item.line}</li>
              ))}
            </ul>
            {missingLines.length > 12 ? (
              <p className="mt-2 text-amber-300">+{missingLines.length - 12} more</p>
            ) : null}
          </div>
        ) : null}

        {statusMessage ? <p className="mt-3 text-sm text-emerald-300">{statusMessage}</p> : null}
        {errorMessage ? <p className="mt-3 text-sm text-red-300">{errorMessage}</p> : null}
      </section>

      <section className="min-w-0 rounded-lg border border-slate-800 bg-slate-950 p-5 text-white">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="font-display text-lg tracking-wide text-amber-200/90">Your Decks</h2>
          <button
            type="button"
            onClick={() => refreshDecks().catch((error) => setErrorMessage(getErrorMessage(error)))}
            disabled={isWorking}
            className="rounded bg-slate-800 px-3 py-1 text-xs font-semibold text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Refresh
          </button>
        </div>

        {decks.length === 0 ? (
          <p className="text-sm text-slate-400">No decks yet.</p>
        ) : (
          <div className="grid gap-2">
            {decks.map((deck) => (
              <button
                key={deck.id}
                type="button"
                onClick={() => setSelectedDeckId(deck.id)}
                disabled={isWorking}
                className={`rounded-md border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  selectedDeckId === deck.id
                    ? 'border-amber-500 bg-amber-950/40'
                    : 'border-slate-800 bg-slate-900 hover:border-slate-600'
                }`}
              >
                <p className="text-sm font-semibold text-white">{deck.name || 'Untitled Deck'}</p>
                <p className="mt-1 text-xs text-slate-400">{deck.card_count} cards</p>
                <p className="mt-2 break-all font-mono text-[11px] text-slate-500">{deck.id}</p>
              </button>
            ))}
          </div>
        )}
      </section>
      </div>

      {selectedDeck ? (
        <section className="min-w-0 rounded-lg border border-slate-800 bg-slate-950 p-5 text-white">
            <h3 className="font-display text-base tracking-wide text-amber-200/90">Edit Deck</h3>
            <p className="mt-1 text-xs text-slate-400">
              {selectedDeck.name || 'Untitled Deck'} - {selectedDeck.card_count} cards
            </p>
            {(() => {
              const counts = selectedDeck.cards.reduce(
                (acc, line) => {
                  acc[getCardConfigStatus(line.card ?? {})] += line.quantity
                  return acc
                },
                { scripted: 0, vanilla: 0, needs: 0 } as Record<CardConfigStatus, number>,
              )
              return (
                <p className="mt-1 text-xs text-slate-500">
                  <span className="font-semibold text-emerald-300">{counts.scripted}</span> scripted ·{' '}
                  <span className="font-semibold text-slate-300">{counts.vanilla}</span> vanilla ·{' '}
                  <span className="font-semibold text-amber-300">{counts.needs}</span> need behavior
                </p>
              )
            })()}

            {/* Deck insights: curve, types, colours, singleton + colour-identity checks */}
            <DeckInsights
              cards={selectedDeck.cards}
              commanderCard={selectedDeck.cards.find((l) => l.card_id === selectedDeck.commander_card_id)?.card ?? null}
            />

            {/* Commander legality (server-authoritative; only when a commander is set) */}
            {legality && (
              legality.legal ? (
                <p className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-300">
                  ✓ Commander-legal ({legality.card_count} cards)
                </p>
              ) : (
                <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                  <p className="font-semibold text-amber-300">⚠ Not Commander-legal</p>
                  <ul className="mt-1 list-disc pl-4 text-amber-200/90">
                    {legality.issues.map((issue, i) => (
                      <li key={i}>{issue}</li>
                    ))}
                  </ul>
                </div>
              )
            )}

            {/* Deck-level tools */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleBatchGenerate}
                disabled={isWorking}
                className="rounded-md bg-violet-500 px-3 py-1.5 text-xs font-semibold text-violet-950 hover:bg-violet-400 disabled:opacity-50"
              >
                ✨ Generate behavior (needs)
              </button>
              {batch && (
                <span className="text-xs text-violet-300">
                  {batch.done}/{batch.total} · {batch.ok} ok{batch.failed ? ` · ${batch.failed} failed` : ''}
                </span>
              )}
              <button
                type="button"
                onClick={() => setSampleHand(sampleOpeningHand(selectedDeck))}
                className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-800"
              >
                Sample hand
              </button>
              <button
                type="button"
                onClick={handleExport}
                className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-800"
              >
                Copy as text
              </button>
              <button
                type="button"
                onClick={handleClone}
                disabled={isWorking}
                className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-50"
              >
                Clone deck
              </button>
            </div>

            <div className="mt-4 min-w-0 rounded-md border border-slate-800 bg-slate-900 p-3">
              <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Add Card</h4>
              <CardCatalogPicker value={selectedCardId} onChange={setSelectedCardId} disabled={isWorking} />
              <div className="mt-3 grid grid-cols-[96px_1fr] gap-2">
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={addQuantity}
                  onChange={(event) => setAddQuantity(Number(event.target.value))}
                  className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
                />
                <button
                  type="button"
                  onClick={handleAddCard}
                  disabled={isWorking || !selectedCardId}
                  className="rounded-md bg-amber-400 px-4 py-2 text-sm font-semibold text-amber-950 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Add to Deck
                </button>
              </div>
            </div>

            {/* List controls */}
            <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
              <div className="flex overflow-hidden rounded border border-slate-700">
                {(['grid', 'list'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setViewMode(mode)}
                    className={`px-2.5 py-1 font-semibold capitalize ${
                      viewMode === mode ? 'bg-amber-400 text-amber-950' : 'text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    {mode}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-1.5 text-slate-300">
                <input
                  type="checkbox"
                  checked={showNeedsOnly}
                  onChange={(event) => setShowNeedsOnly(event.target.checked)}
                />
                Needs behavior only
              </label>
              {viewMode === 'list' && (
                <>
                  <span className="ml-auto text-slate-500">Sort</span>
                  <select
                    value={sortKey}
                    onChange={(event) => setSortKey(event.target.value as typeof sortKey)}
                    className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200"
                  >
                    <option value="name">Name</option>
                    <option value="cmc">Mana value</option>
                    <option value="type">Type</option>
                    <option value="behavior">Behavior</option>
                  </select>
                </>
              )}
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
                    className={`grid grid-cols-[72px_1fr_auto] items-center gap-2 rounded-md border p-2 ${
                      isCommander ? 'border-amber-500 bg-amber-500/10' : 'border-slate-800 bg-slate-900'
                    }`}
                  >
                    <input
                      type="number"
                      min={0}
                      max={99}
                      value={line.quantity}
                      onChange={(event) => handleSetQuantity(line.card_id, Number(event.target.value))}
                      disabled={isWorking}
                      className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
                    />
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 truncate text-sm font-semibold text-white">
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
                        {isCommander && <span className="shrink-0 text-xs font-bold text-amber-400">★ Commander</span>}
                      </p>
                      <p className="truncate text-xs text-slate-400">
                        {[line.card?.mana_cost, line.card?.type_line].filter(Boolean).join(' - ')}
                      </p>
                    </div>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => setBehaviorCardId(line.card_id)}
                        title="Edit this card's behavior"
                        className="rounded bg-amber-700 px-2 py-1 text-xs font-semibold text-amber-100 hover:bg-amber-600"
                      >
                        Behavior
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSetCommander(isCommander ? null : line.card_id)}
                        disabled={isWorking}
                        title={isCommander ? 'Clear commander' : 'Set as commander'}
                        className={`rounded px-2 py-1 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
                          isCommander ? 'bg-amber-500 text-amber-950' : 'bg-slate-700 text-slate-200'
                        }`}
                      >
                        ★
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSetQuantity(line.card_id, 0)}
                        disabled={isWorking}
                        className="rounded bg-red-500 px-2 py-1 text-xs font-semibold text-red-950 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
            )}
        </section>
      ) : null}

      {/* Sample opening hand */}
      {sampleHand && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setSampleHand(null)}
        >
          <div className="w-full max-w-sm rounded-lg border border-slate-700 bg-slate-950 p-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-2 text-sm font-bold text-white">Sample opening hand</h3>
            <ul className="space-y-1 text-sm text-slate-200">
              {sampleHand.map((name, i) => (
                <li key={i} className="rounded bg-slate-900 px-2 py-1">{name}</li>
              ))}
            </ul>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => selectedDeck && setSampleHand(sampleOpeningHand(selectedDeck))}
                className="flex-1 rounded-md bg-amber-500 px-3 py-2 text-xs font-semibold text-amber-950"
              >
                Redraw
              </button>
              <button
                type="button"
                onClick={() => setSampleHand(null)}
                className="flex-1 rounded-md border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-200"
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
            className="my-4 w-full max-w-6xl rounded-lg border border-slate-700 bg-slate-950 p-4"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-bold text-white">Card behavior</h3>
              <button
                type="button"
                onClick={closeBehavior}
                className="rounded border border-slate-700 px-3 py-1 text-xs font-semibold text-slate-200 hover:bg-slate-800"
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
  scripted: { label: 'Behavior', cls: 'bg-emerald-500/20 text-emerald-300' },
  vanilla: { label: 'Vanilla', cls: 'bg-slate-600/40 text-slate-300' },
  needs: { label: 'Needs behavior', cls: 'bg-amber-500/20 text-amber-300' },
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
    return <p className="mt-3 text-sm text-slate-500">No cards match.</p>
  }
  return (
    <div className="mt-2 space-y-5">
      {ordered.map((g) => {
        const lines = groups.get(g)!
        const total = lines.reduce((sum, l) => sum + l.quantity, 0)
        return (
          <div key={g}>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              {g} <span className="text-slate-600">· {total}</span>
            </h4>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
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
      className={`relative overflow-hidden rounded-lg border ${
        isCommander ? 'border-amber-500 ring-1 ring-amber-500/40' : 'border-slate-800'
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
            className="aspect-[2/3] w-full bg-slate-900 object-cover"
          />
        ) : (
          <div className="flex aspect-[2/3] w-full items-center justify-center bg-slate-900 p-2 text-center">
            <span className="line-clamp-4 text-[11px] font-semibold text-slate-300">
              {card?.name ?? line.card_id}
            </span>
          </div>
        )}
      </button>

      <span className="pointer-events-none absolute left-1 top-1 rounded bg-black/80 px-1.5 py-0.5 text-[11px] font-black text-white">
        ×{line.quantity}
      </span>

      <button
        type="button"
        onClick={() => onEditBehavior(line.card_id)}
        title="Edit behavior"
        className={`absolute right-1 top-1 rounded px-1 py-0.5 text-[8px] font-bold uppercase ${badge.cls}`}
      >
        {status === 'scripted' ? '✓ beh' : status === 'needs' ? 'needs' : 'van'}
      </button>

      {isCommander && (
        <span className="pointer-events-none absolute bottom-[30px] left-1 rounded bg-amber-500 px-1 text-[9px] font-black text-amber-950">
          ★ CMD
        </span>
      )}

      <div className="flex items-stretch gap-px bg-slate-950 text-xs">
        <button
          type="button"
          onClick={() => onSetQuantity(line.card_id, line.quantity - 1)}
          disabled={isWorking}
          className="flex-1 bg-slate-800 py-1 font-bold text-slate-200 hover:bg-slate-700 disabled:opacity-50"
        >
          −
        </button>
        <span className="flex-1 py-1 text-center font-semibold text-white">{line.quantity}</span>
        <button
          type="button"
          onClick={() => onSetQuantity(line.card_id, line.quantity + 1)}
          disabled={isWorking}
          className="flex-1 bg-slate-800 py-1 font-bold text-slate-200 hover:bg-slate-700 disabled:opacity-50"
        >
          ＋
        </button>
        <button
          type="button"
          onClick={() => onSetCommander(isCommander ? null : line.card_id)}
          disabled={isWorking}
          title={isCommander ? 'Clear commander' : 'Set as commander'}
          className={`flex-1 py-1 font-bold disabled:opacity-50 ${
            isCommander ? 'bg-amber-500 text-amber-950' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
          }`}
        >
          ★
        </button>
        <button
          type="button"
          onClick={() => onSetQuantity(line.card_id, 0)}
          disabled={isWorking}
          title="Remove"
          className="flex-1 bg-red-600/80 py-1 font-bold text-white hover:bg-red-600 disabled:opacity-50"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
