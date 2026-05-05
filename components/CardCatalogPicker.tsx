'use client'

import Image from 'next/image'
import { useEffect, useMemo, useState } from 'react'
import { getCardCatalog } from '@/lib/game/data'
import { createClient } from '@/lib/supabase/client'
import type { CardCatalogFilters, LinkedCard } from '@/lib/game/types'

const cardTypeFilters: Array<{ label: string; value: NonNullable<CardCatalogFilters['type']> }> = [
  { label: 'All types', value: 'all' },
  { label: 'Creature', value: 'creature' },
  { label: 'Instant', value: 'instant' },
  { label: 'Sorcery', value: 'sorcery' },
  { label: 'Land', value: 'land' },
  { label: 'Artifact', value: 'artifact' },
  { label: 'Enchantment', value: 'enchantment' },
  { label: 'Planeswalker', value: 'planeswalker' },
]

const colorFilters: Array<{ label: string; value: NonNullable<CardCatalogFilters['color']> }> = [
  { label: 'All colors', value: 'all' },
  { label: 'White', value: 'W' },
  { label: 'Blue', value: 'U' },
  { label: 'Black', value: 'B' },
  { label: 'Red', value: 'R' },
  { label: 'Green', value: 'G' },
  { label: 'Colorless', value: 'C' },
]

const keywordFilters = [
  'Flying',
  'Reach',
  'Haste',
  'Vigilance',
  'Trample',
  'Indestructible',
  'First strike',
  'Double strike',
]

export default function CardCatalogPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: string
  onChange: (cardId: string) => void
  disabled?: boolean
}) {
  const supabase = useMemo(() => createClient(), [])
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<NonNullable<CardCatalogFilters['type']>>('all')
  const [colorFilter, setColorFilter] = useState<NonNullable<CardCatalogFilters['color']>>('all')
  const [keywordFilter, setKeywordFilter] = useState('all')
  const [cards, setCards] = useState<LinkedCard[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true

    const timeoutId = window.setTimeout(async () => {
      setIsLoading(true)
      setErrorMessage(null)

      try {
        const nextCards = await getCardCatalog(supabase, {
          search,
          type: typeFilter,
          color: colorFilter,
          keyword: keywordFilter === 'all' ? undefined : keywordFilter,
          limit: 80,
        })

        if (!isMounted) {
          return
        }

        setCards(nextCards)

        if (!nextCards.some((card) => card.id === value)) {
          onChange(nextCards[0]?.id ?? '')
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not load card catalog'
        console.error('Failed to load card catalog:', message, error)

        if (isMounted) {
          setErrorMessage(message)
        }
      } finally {
        if (isMounted) {
          setIsLoading(false)
        }
      }
    }, 250)

    return () => {
      isMounted = false
      window.clearTimeout(timeoutId)
    }
  }, [colorFilter, keywordFilter, onChange, search, supabase, typeFilter, value])

  const selectedCard = cards.find((card) => card.id === value) ?? null

  return (
    <div className="grid min-w-0 gap-2">
      <input
        type="search"
        value={search}
        disabled={disabled}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search card name"
        className="w-full min-w-0 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-60"
      />

      <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <select
          value={typeFilter}
          disabled={disabled}
          onChange={(event) =>
            setTypeFilter(event.target.value as NonNullable<CardCatalogFilters['type']>)
          }
          className="w-full min-w-0 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {cardTypeFilters.map((filter) => (
            <option key={filter.value} value={filter.value}>
              {filter.label}
            </option>
          ))}
        </select>

        <select
          value={colorFilter}
          disabled={disabled}
          onChange={(event) =>
            setColorFilter(event.target.value as NonNullable<CardCatalogFilters['color']>)
          }
          className="w-full min-w-0 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {colorFilters.map((filter) => (
            <option key={filter.value} value={filter.value}>
              {filter.label}
            </option>
          ))}
        </select>

        <select
          value={keywordFilter}
          disabled={disabled}
          onChange={(event) => setKeywordFilter(event.target.value)}
          className="w-full min-w-0 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          <option value="all">All keywords</option>
          {keywordFilters.map((keyword) => (
            <option key={keyword} value={keyword}>
              {keyword}
            </option>
          ))}
        </select>
      </div>

      <select
        value={value}
        disabled={disabled || cards.length === 0}
        onChange={(event) => onChange(event.target.value)}
        className="w-full min-w-0 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-60"
      >
        {cards.length === 0 ? (
          <option value="">No cards found</option>
        ) : (
          cards.map((card) => (
            <option key={card.id} value={card.id}>
              {formatCardOption(card)}
            </option>
          ))
        )}
      </select>

      <div className="flex items-center justify-between gap-3 text-xs text-slate-400">
        <span>{isLoading ? 'Loading cards...' : `${cards.length} results`}</span>
        {errorMessage ? <span className="text-red-300">{errorMessage}</span> : null}
      </div>

      {selectedCard ? (
        <div className="grid min-w-0 grid-cols-[56px_minmax(0,1fr)] gap-3 rounded-md border border-slate-800 bg-slate-900/70 p-2">
          {selectedCard.image_url ? (
            <Image
              src={selectedCard.image_url}
              alt={selectedCard.name || 'Selected card'}
              width={56}
              height={78}
              className="rounded object-cover"
            />
          ) : (
            <div className="h-[78px] rounded bg-slate-800" />
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-white">{selectedCard.name || selectedCard.id}</p>
            <p className="truncate text-xs text-slate-300">
              {[selectedCard.mana_cost, selectedCard.type_line].filter(Boolean).join(' - ')}
            </p>
            {formatPowerToughness(selectedCard) ? (
              <p className="text-xs text-slate-400">P/T {formatPowerToughness(selectedCard)}</p>
            ) : null}
            {selectedCard.keywords?.length ? (
              <p className="truncate text-xs text-slate-400">{selectedCard.keywords.join(', ')}</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function formatCardOption(card: LinkedCard) {
  const parts = [
    card.name || card.id,
    card.mana_cost,
    card.type_line,
    formatPowerToughness(card),
  ].filter(Boolean)

  return parts.join(' - ')
}

function formatPowerToughness(card: LinkedCard) {
  if (card.power_toughness) {
    return card.power_toughness
  }

  if (card.power != null && card.toughness != null) {
    return `${card.power}/${card.toughness}`
  }

  return null
}
