'use client'

import { useEffect, useMemo, useState } from 'react'
import CardCatalogPicker from '@/components/CardCatalogPicker'
import { importDeckFromText, getErrorMessage, updateDeckList } from '@/lib/game/actions'
import { getDeckDetail, getUserDecks } from '@/lib/game/data'
import { createClient } from '@/lib/supabase/client'
import type { DeckDetail, DeckSummary } from '@/lib/game/types'

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

  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(360px,420px)]">
      <section className="min-w-0 rounded-lg border border-slate-800 bg-slate-950 p-5 text-white">
        <h2 className="text-lg font-semibold">Create Deck</h2>
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
            className="rounded-md bg-sky-400 px-4 py-2 text-sm font-semibold text-sky-950 disabled:cursor-not-allowed disabled:opacity-50"
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
          <h2 className="text-lg font-semibold">Your Decks</h2>
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
                    ? 'border-sky-500 bg-sky-950/40'
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

        {selectedDeck ? (
          <div className="mt-5 border-t border-slate-800 pt-5">
            <h3 className="text-sm font-semibold text-slate-200">Edit Deck</h3>
            <p className="mt-1 text-xs text-slate-400">
              {selectedDeck.name || 'Untitled Deck'} - {selectedDeck.card_count} cards
            </p>

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
                  className="rounded-md bg-sky-400 px-4 py-2 text-sm font-semibold text-sky-950 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Add to Deck
                </button>
              </div>
            </div>

            <div className="mt-4 grid gap-2">
              {selectedDeck.cards.map((line) => (
                <div
                  key={line.card_id}
                  className="grid grid-cols-[72px_1fr_auto] items-center gap-2 rounded-md border border-slate-800 bg-slate-900 p-2"
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
                    <p className="truncate text-sm font-semibold text-white">
                      {line.card?.name || line.card_id}
                    </p>
                    <p className="truncate text-xs text-slate-400">
                      {[line.card?.mana_cost, line.card?.type_line].filter(Boolean).join(' - ')}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleSetQuantity(line.card_id, 0)}
                    disabled={isWorking}
                    className="rounded bg-red-500 px-2 py-1 text-xs font-semibold text-red-950 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  )
}

function expandDeckCardIds(deck: DeckDetail) {
  return deck.cards.flatMap((line) => Array.from({ length: line.quantity }, () => line.card_id))
}
