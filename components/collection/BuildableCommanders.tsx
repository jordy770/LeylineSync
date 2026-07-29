'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

import { pluralizeSubtype, type CommanderSuggestion } from '@/lib/collection/commander-suggest'
import type { BasicName, DeckProposal, ProposalBucket } from '@/lib/collection/deck-generator'
import { ColorPips, Panel } from './ui'

// "Commanders you can build" — deterministic ranking, no LLM. The advisor page
// computes BOTH toggle variants server-side from one collection load; toggling
// here is a pure client switch over the two arrays (no refetch). The lookup
// (search any catalog commander, owned or not) is the one thing that DOES
// refetch — from /api/collection/commanders — including when the toggle
// changes while a lookup result is open.
// Spec: docs/superpowers/specs/2026-07-29-buildable-commanders-design.md

const TOP_N = 10
const DEBOUNCE_MS = 300

const BUCKET_LABEL: Record<CommanderSuggestion['buckets'][number]['bucket'], string> = {
  ramp: 'ramp',
  card_draw: 'card draw',
  removal: 'removal',
  board_wipe: 'board wipe',
  creatures: 'creatures',
  filler: 'filler',
}

interface LookupResult {
  oracleId: string
  name: string
  typeLine: string
  colorIdentity: string[]
}

// Response shape of POST .../commanders/generate: the pure DeckProposal plus
// the route's server-side gap-buy lookup (per shortfall bucket, up to 2 cheap
// in-identity cards the user doesn't own — priceEur is null when unknown).
type GapBuyCard = { oracleId: string; name: string; priceEur: number | null }
type ProposalGap = { bucket: ProposalBucket; shortfall: number; buys: GapBuyCard[] }
type Proposal = DeckProposal & { gaps: ProposalGap[] }

const BUCKET_ORDER: ProposalBucket[] = ['ramp', 'card_draw', 'removal', 'board_wipe', 'creatures', 'filler']
const BASIC_ORDER: BasicName[] = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes']
const BASIC_LETTER: Record<BasicName, string> = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G', Wastes: 'C' }

function groupByBucket(cards: Proposal['cards']): { bucket: ProposalBucket; cards: Proposal['cards'] }[] {
  return BUCKET_ORDER.map((bucket) => ({ bucket, cards: cards.filter((c) => c.bucket === bucket) })).filter(
    (g) => g.cards.length > 0,
  )
}

function landsLine(proposal: Proposal): string {
  const perColour = BASIC_ORDER.filter((n) => (proposal.basics[n] ?? 0) > 0)
    .map((n) => `${BASIC_LETTER[n]}${proposal.basics[n]}`)
    .join(' ')
  const base = `${proposal.totals.ownedLand} owned lands + ${proposal.totals.basicLand} basics`
  return perColour ? `${base} — ${perColour}` : base
}

export function BuildableCommanders({
  freeSuggestions,
  allSuggestions,
  hasCollection,
}: {
  freeSuggestions: CommanderSuggestion[]
  allSuggestions: CommanderSuggestion[]
  hasCollection: boolean
}) {
  const router = useRouter()
  const [freeOnly, setFreeOnly] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  const [query, setQuery] = useState('')
  const [lookupResults, setLookupResults] = useState<LookupResult[]>([])
  const [lookupOpen, setLookupOpen] = useState(false)
  const [lookupBusy, setLookupBusy] = useState(false)
  const [lookupError, setLookupError] = useState<string | null>(null)

  const [picked, setPicked] = useState<{ oracleId: string; name: string } | null>(null)
  const [pickedSuggestion, setPickedSuggestion] = useState<CommanderSuggestion | null>(null)
  const [pickedBusy, setPickedBusy] = useState(false)
  const [pickedError, setPickedError] = useState<string | null>(null)

  const [startBusy, setStartBusy] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)

  const list = freeOnly ? freeSuggestions : allSuggestions
  const visible = showAll ? list : list.slice(0, TOP_N)

  // Debounced catalog search (name → candidates) as the user types. Skipped
  // when the query is exactly the just-picked name — pickCommander sets query
  // to r.name to show the selection in the box, which would otherwise
  // retrigger this effect and pop the dropdown back open over the detail
  // panel ~300ms after the user picked something from it.
  useEffect(() => {
    const q = query.trim()
    if (picked && q === picked.name) return
    if (q.length < 2) {
      setLookupResults([])
      setLookupOpen(false)
      setLookupBusy(false)
      return
    }
    setLookupBusy(true)
    setLookupError(null)
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/collection/commanders?q=${encodeURIComponent(q)}`)
        const bodyJson = await res.json()
        if (!res.ok) {
          setLookupError(bodyJson.error ?? 'Search failed.')
          return
        }
        setLookupResults(bodyJson.results ?? [])
        setLookupOpen(true)
      } catch {
        setLookupError('Network error while searching.')
      } finally {
        setLookupBusy(false)
      }
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query, picked])

  // Dismiss the lookup dropdown on an outside tap/click (same convention as
  // CardName's touch-preview: document pointerdown, not blur, so a click on a
  // dropdown row isn't swallowed by a blur firing first).
  const lookupBoxRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (lookupBoxRef.current && !lookupBoxRef.current.contains(e.target as Node)) {
        setLookupOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  // Scored lookup — re-fetches on pick AND whenever the toggle changes while a
  // lookup result is open (the ranked list never refetches; this does).
  useEffect(() => {
    if (!picked) return
    let cancelled = false
    setPickedBusy(true)
    setPickedError(null)
    fetch(`/api/collection/commanders?oracleId=${encodeURIComponent(picked.oracleId)}&freeOnly=${freeOnly}`)
      .then(async (res) => {
        const bodyJson = await res.json()
        if (cancelled) return
        if (!res.ok) {
          setPickedError(bodyJson.error ?? 'Lookup failed.')
          setPickedSuggestion(null)
          return
        }
        setPickedSuggestion(bodyJson.suggestion)
      })
      .catch(() => {
        if (!cancelled) setPickedError('Network error during lookup.')
      })
      .finally(() => {
        if (!cancelled) setPickedBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [picked, freeOnly])

  function pickCommander(r: LookupResult) {
    setLookupOpen(false)
    setQuery(r.name)
    setPicked({ oracleId: r.oracleId, name: r.name })
  }

  async function startDeck(commander: { oracleId: string; name: string }) {
    setStartBusy(commander.oracleId)
    setStartError(null)
    try {
      const res = await fetch('/api/collection/commanders/start-deck', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ oracleId: commander.oracleId, name: `${commander.name} (draft)` }),
      })
      const bodyJson = await res.json()
      if (!res.ok) {
        setStartError(bodyJson.error ?? 'Could not start the deck.')
        return
      }
      router.push(`/collection/decks/${bodyJson.deckId}`)
    } catch {
      setStartError('Network error while starting the deck.')
    } finally {
      setStartBusy(null)
    }
  }

  return (
    <section>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
          Commanders you can build
        </h2>
        <div className="flex items-center gap-1.5">
          <ToggleChip active={freeOnly} onClick={() => setFreeOnly(true)}>
            Only free cards
          </ToggleChip>
          <ToggleChip active={!freeOnly} onClick={() => setFreeOnly(false)}>
            Whole collection
          </ToggleChip>
        </div>
      </div>
      <p className="font-rules mb-3 text-sm" style={{ color: 'var(--text-dim)' }}>
        Deterministic scoring of which commander decks your binder already supports — no AI involved.
      </p>

      {startError ? (
        <p className="mb-2 text-sm" style={{ color: 'var(--danger)' }}>
          {startError}
        </p>
      ) : null}

      {!hasCollection ? (
        <Panel className="p-5">
          <p className="font-rules text-sm" style={{ color: 'var(--text-dim)' }}>
            Import your collection first —{' '}
            <Link href="/collection/import" className="underline-offset-2 hover:underline" style={{ color: 'var(--gold-bright)' }}>
              import a ManaBox CSV
            </Link>{' '}
            and this section will rank the commanders it can build.
          </p>
        </Panel>
      ) : allSuggestions.length === 0 ? (
        <Panel className="p-5">
          <p className="font-rules text-sm" style={{ color: 'var(--text-dim)' }}>
            None of your owned cards are commander-eligible yet — a legendary creature (or a card that says &quot;can be
            your commander&quot;) unlocks this section.
          </p>
        </Panel>
      ) : list.length === 0 ? (
        <Panel className="p-5">
          <p className="font-rules text-sm" style={{ color: 'var(--text-dim)' }}>
            None of your eligible commanders have free copies right now — toggle to Whole collection to see them.
          </p>
        </Panel>
      ) : (
        <div className="space-y-2">
          {visible.map((s) => (
            <CommanderRow
              key={s.commander.oracleId}
              suggestion={s}
              freeOnly={freeOnly}
              expanded={expandedId === s.commander.oracleId}
              onToggle={() => setExpandedId(expandedId === s.commander.oracleId ? null : s.commander.oracleId)}
              onStart={() => startDeck(s.commander)}
              starting={startBusy === s.commander.oracleId}
            />
          ))}
          {!showAll && list.length > TOP_N ? (
            <button
              onClick={() => setShowAll(true)}
              className="w-full rounded-lg py-2 text-center text-xs"
              style={{ border: '1px solid rgba(201,154,58,0.25)', color: 'var(--text-dim)' }}
            >
              Show {list.length - TOP_N} more
            </button>
          ) : null}
        </div>
      )}

      {/* Lookup — check any catalog commander, owned or not. Always visible. */}
      <div ref={lookupBoxRef} className="relative mt-4 max-w-md">
        <input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setPicked(null)
            setPickedSuggestion(null)
            setPickedError(null)
          }}
          placeholder="Check a specific commander…"
          className="w-full rounded-lg px-3 py-2 text-sm outline-none"
          style={{ border: '1px solid rgba(201,154,58,0.3)', background: 'var(--ink-2)', color: 'var(--text)' }}
        />
        {lookupBusy ? (
          <span className="absolute right-3 top-2.5 animate-pulse text-xs" style={{ color: 'var(--text-faint)' }}>
            …
          </span>
        ) : null}
        {lookupOpen && lookupResults.length > 0 ? (
          <div
            className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg"
            style={{ background: 'var(--ink-2)', border: '1px solid rgba(201,154,58,0.3)' }}
          >
            {lookupResults.map((r) => (
              <button
                key={r.oracleId}
                onClick={() => pickCommander(r)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-[rgba(201,154,58,0.08)]"
                style={{ color: 'var(--text)' }}
              >
                <span className="min-w-0 flex-1 truncate">
                  {r.name}
                  {r.typeLine ? (
                    <span className="ml-2 text-xs" style={{ color: 'var(--text-faint)' }}>
                      {r.typeLine}
                    </span>
                  ) : null}
                </span>
                <ColorPips colors={r.colorIdentity} />
              </button>
            ))}
          </div>
        ) : null}
        {lookupError ? (
          <p className="mt-1 text-xs" style={{ color: 'var(--danger)' }}>
            {lookupError}
          </p>
        ) : null}
      </div>

      {picked ? (
        <div className="mt-3 max-w-2xl">
          {pickedBusy && !pickedSuggestion ? (
            <p className="font-rules text-sm" style={{ color: 'var(--text-dim)' }}>
              Scoring {picked.name}…
            </p>
          ) : pickedError ? (
            <p className="text-sm" style={{ color: 'var(--danger)' }}>
              {pickedError}
            </p>
          ) : pickedSuggestion ? (
            <Panel className="p-4">
              <SuggestionDetail
                suggestion={pickedSuggestion}
                freeOnly={freeOnly}
                onStart={() => startDeck(pickedSuggestion.commander)}
                starting={startBusy === pickedSuggestion.commander.oracleId}
              />
            </Panel>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function CommanderRow({
  suggestion,
  freeOnly,
  expanded,
  onToggle,
  onStart,
  starting,
}: {
  suggestion: CommanderSuggestion
  freeOnly: boolean
  expanded: boolean
  onToggle: () => void
  onStart: () => void
  starting: boolean
}) {
  return (
    <Panel className="p-0">
      <button onClick={onToggle} className="flex w-full items-center justify-between gap-3 p-4 text-left">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-display text-base" style={{ color: 'var(--text-bright)' }}>
              {suggestion.commander.name}
            </span>
            <ColorPips colors={suggestion.commander.colorIdentity} />
            {!freeOnly && !suggestion.commanderIsFree ? <Tag>commander in a deck</Tag> : null}
          </div>
          <p className="font-rules mt-0.5 text-xs" style={{ color: 'var(--text-dim)' }}>
            {explanationLine(suggestion, freeOnly)}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-display text-lg" style={{ color: 'var(--gold-bright)' }}>
            {suggestion.score}
          </div>
          <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
            score
          </div>
        </div>
      </button>
      {expanded ? (
        <div className="border-t p-4" style={{ borderColor: 'rgba(201,154,58,0.15)' }}>
          <SuggestionDetail suggestion={suggestion} freeOnly={freeOnly} onStart={onStart} starting={starting} />
        </div>
      ) : null}
    </Panel>
  )
}

/** Shared inline detail: bucket coverage (biggest gaps first), theme facts,
 *  Start empty / Generate decklist. Generate replaces the bucket-bars block
 *  with a full 99-card proposal preview (fetched from the generate route);
 *  Back returns to the bars. Each mounted instance (ranked-list row or the
 *  lookup panel) owns its own preview state — suggestion identity is stable
 *  per instance, so there's no cross-talk between rows. */
function SuggestionDetail({
  suggestion,
  freeOnly,
  onStart,
  starting,
}: {
  suggestion: CommanderSuggestion
  freeOnly: boolean
  onStart: () => void
  starting: boolean
}) {
  const router = useRouter()
  const sortedBuckets = [...suggestion.buckets].sort((a, b) => a.owned / a.ideal - b.owned / b.ideal)
  const { tribal, keywordOverlap } = suggestion.themeFacts

  const [preview, setPreview] = useState<Proposal | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [saveBusy, setSaveBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  async function generate(nextFreeOnly: boolean) {
    setPreviewBusy(true)
    setPreviewError(null)
    try {
      const res = await fetch('/api/collection/commanders/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ oracleId: suggestion.commander.oracleId, freeOnly: nextFreeOnly }),
      })
      const bodyJson = await res.json()
      if (!res.ok) {
        setPreviewError(bodyJson.error ?? 'Could not generate the deck.')
        setPreview(null)
        return
      }
      setPreview(bodyJson.proposal)
    } catch {
      setPreviewError('Network error while generating the deck.')
    } finally {
      setPreviewBusy(false)
    }
  }

  // Refetch when the toggle flips while a preview is open — skip the mount
  // run (nothing to refetch yet) so this never races the initial "Generate
  // decklist" click's own fetch.
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    if (!preview) return
    generate(freeOnly)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freeOnly])

  async function saveDeck() {
    if (!preview) return
    setSaveBusy(true)
    setSaveError(null)
    try {
      const cards = [
        ...preview.cards.map((c) => ({ oracleId: c.oracleId, quantity: 1 })),
        ...preview.ownedLands.map((l) => ({ oracleId: l.oracleId, quantity: 1 })),
      ]
      const basics = BASIC_ORDER.filter((n) => (preview.basics[n] ?? 0) > 0).map((n) => ({
        name: n,
        quantity: preview.basics[n] as number,
      }))
      const res = await fetch('/api/collection/commanders/save-deck', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          oracleId: suggestion.commander.oracleId,
          name: `${suggestion.commander.name} (generated)`,
          cards,
          basics,
        }),
      })
      const bodyJson = await res.json()
      if (!res.ok) {
        setSaveError(bodyJson.error ?? 'Could not save the deck.')
        return
      }
      router.push(`/collection/decks/${bodyJson.deckId}`)
    } catch {
      setSaveError('Network error while saving the deck.')
    } finally {
      setSaveBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      {!suggestion.ownsCommander ? (
        <p className="font-rules text-sm" style={{ color: 'var(--warn)' }}>
          You don&apos;t own this commander yet — {suggestion.ownedPlayable} playable cards are waiting for it.
        </p>
      ) : null}

      {!preview ? (
        <>
          <div className="space-y-1.5">
            {sortedBuckets.map((b) => {
              const pct = Math.min(100, Math.round((b.owned / b.ideal) * 100))
              return (
                <div key={b.bucket}>
                  <div className="flex items-center justify-between text-xs" style={{ color: 'var(--text-dim)' }}>
                    <span>{BUCKET_LABEL[b.bucket]}</span>
                    <span>
                      {b.owned}/{b.ideal}
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'rgba(201,154,58,0.12)' }}>
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${pct}%`,
                        background: pct >= 80 ? 'var(--cast)' : pct >= 40 ? 'var(--frame-gold)' : 'var(--danger)',
                      }}
                    />
                  </div>
                </div>
              )
            })}
          </div>

          {tribal || keywordOverlap.length > 0 ? (
            <p className="font-rules text-xs" style={{ color: 'var(--text-dim)' }}>
              {tribal ? `${tribal.count} ${pluralizeSubtype(tribal.type)} tie into this commander's tribal theme. ` : ''}
              {keywordOverlap.length > 0 ? `Keyword overlap: ${keywordOverlap.join(', ')}.` : ''}
            </p>
          ) : null}

          {previewError ? (
            <p className="text-sm" style={{ color: 'var(--danger)' }}>
              {previewError}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <button
              onClick={onStart}
              disabled={starting}
              className="rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-40"
              style={{ border: '1px solid rgba(201,154,58,0.45)', color: 'var(--gold-bright)' }}
            >
              {starting ? '…' : 'Start empty'}
            </button>
            <button
              onClick={() => generate(freeOnly)}
              disabled={previewBusy}
              className="rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-40"
              style={{ background: 'var(--frame-gold)', color: '#1c1407' }}
            >
              {previewBusy ? '…' : 'Generate decklist'}
            </button>
          </div>
        </>
      ) : (
        <div className="space-y-3">
          {previewBusy ? (
            <p className="font-rules text-xs" style={{ color: 'var(--text-faint)' }}>
              Refreshing for the new toggle…
            </p>
          ) : null}
          {previewError ? (
            <p className="text-sm" style={{ color: 'var(--danger)' }}>
              {previewError}
            </p>
          ) : null}
          <div className="space-y-2.5">
            {groupByBucket(preview.cards).map((g) => (
              <div key={g.bucket}>
                <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
                  {BUCKET_LABEL[g.bucket]} ({g.cards.length})
                </p>
                <ul className="mt-1 space-y-1">
                  {g.cards.map((c) => (
                    <li key={c.oracleId} className="flex flex-wrap items-center gap-1.5 text-sm" style={{ color: 'var(--text)' }}>
                      <span>{c.name}</span>
                      {c.reasons.map((r) => (
                        <Tag key={r}>{r}</Tag>
                      ))}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <p className="font-rules text-xs" style={{ color: 'var(--text-dim)' }}>
            {landsLine(preview)}
          </p>

          {preview.gaps.length > 0 ? (
            <div className="space-y-1.5 rounded-lg p-2.5" style={{ border: '1px solid rgba(201,154,58,0.2)' }}>
              <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
                Gaps
              </p>
              {preview.gaps.map((g) => (
                <p key={g.bucket} className="font-rules text-xs" style={{ color: 'var(--text-dim)' }}>
                  {BUCKET_LABEL[g.bucket]}: short {g.shortfall}
                  {g.buys.length > 0
                    ? ' — ' +
                      g.buys
                        .slice(0, 2)
                        .map((b) => (b.priceEur != null ? `${b.name} (€${b.priceEur.toFixed(2)})` : b.name))
                        .join(', ')
                    : ''}
                </p>
              ))}
            </div>
          ) : null}

          {saveError ? (
            <p className="text-sm" style={{ color: 'var(--danger)' }}>
              {saveError}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <button
              onClick={saveDeck}
              disabled={saveBusy}
              className="rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-40"
              style={{ background: 'var(--frame-gold)', color: '#1c1407' }}
            >
              {saveBusy
                ? '…'
                : `Save deck (${preview.totals.nonland + preview.totals.ownedLand + preview.totals.basicLand + 1})`}
            </button>
            <button
              onClick={() => {
                setPreview(null)
                setSaveError(null)
              }}
              disabled={saveBusy}
              className="rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-40"
              style={{ border: '1px solid rgba(201,154,58,0.45)', color: 'var(--text-dim)' }}
            >
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** "{ownedPlayable} free playable cards · strong in {bucket, bucket} · {n} {type}s [· {locked} in decks]"
 *  In whole-collection mode ownedPlayable includes locked cards, so drop "free". */
function explanationLine(s: CommanderSuggestion, freeOnly: boolean): string {
  const parts: string[] = [`${s.ownedPlayable} ${freeOnly ? 'free ' : ''}playable cards`]

  const strongBuckets = [...s.buckets]
    .filter((b) => b.owned > 0)
    .sort((a, b) => b.owned / b.ideal - a.owned / a.ideal)
    .slice(0, 2)
    .map((b) => BUCKET_LABEL[b.bucket])
  if (strongBuckets.length > 0) parts.push(`strong in ${strongBuckets.join(', ')}`)

  if (s.themeFacts.tribal) parts.push(`${s.themeFacts.tribal.count} ${pluralizeSubtype(s.themeFacts.tribal.type)}`)

  if (!freeOnly && s.lockedCount > 0) parts.push(`${s.lockedCount} in decks`)

  return parts.join(' · ')
}

function ToggleChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="rounded-full px-3 py-1 text-xs"
      style={active ? { background: 'var(--frame-gold)', color: '#1c1407' } : { border: '1px solid rgba(201,154,58,0.3)', color: 'var(--text-dim)' }}
    >
      {children}
    </button>
  )
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
      style={{ color: 'var(--warn)', border: '1px solid rgba(201,154,58,0.25)' }}
    >
      {children}
    </span>
  )
}
