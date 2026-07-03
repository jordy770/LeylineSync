// Collection Insights — pure per-deck fit ranking.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { rankDeckFits } from '../../lib/collection/insights'
import type { FitCandidate } from '../../lib/collection/insights'
import { buildDeckContext } from '../../lib/collection/scoring'
import type { DeckNeed } from '../../lib/collection/power-score'
import type { DeckCardForScore } from '../../lib/collection/power-score'
import type { SynergyTag } from '../../lib/collection/synergy/tagger'

const needs: DeckNeed[] = [
  { tag: 'removal', have: 0, target: 8, gap: 8 },
  { tag: 'card_draw', have: 2, target: 10, gap: 8 },
]

function cand(name: string, tags: [SynergyTag, number][], opts: { ci?: string[]; cmc?: number } = {}): FitCandidate {
  return {
    oracleId: `o-${name}`,
    name,
    cmc: opts.cmc ?? 2,
    colorIdentity: opts.ci ?? ['B'],
    priceEur: 1,
    typeLine: 'Instant',
    tags: tags.map(([tag, weight]) => ({ tag, weight })),
  }
}

function ctxWith(commanderTags: SynergyTag[]): ReturnType<typeof buildDeckContext> {
  const cmd: DeckCardForScore = {
    oracleId: 'cmd',
    quantity: 1,
    cmc: 3,
    typeLine: 'Legendary Creature',
    isCommander: true,
    tags: commanderTags.map((t) => ({ tag: t, weight: 2 })),
  }
  return buildDeckContext([cmd], 2.5)
}

const deckB = ['B']
const noneInDeck = new Set<string>()

test('rankDeckFits returns colour-legal candidates that fill a need', () => {
  const fits = rankDeckFits(needs, ctxWith([]), deckB, noneInDeck, [
    cand('Doom Blade', [['removal', 3]]),
    cand('Lightning Bolt', [['removal', 3]], { ci: ['R'] }), // off-colour → excluded
    cand('Grizzly Bears', [['protection', 1]]), // no needed role → excluded
  ])
  assert.deepEqual(fits.map((f) => f.name), ['Doom Blade'])
})

test('rankDeckFits excludes cards already in the deck', () => {
  const inDeck = new Set(['o-Doom Blade'])
  const fits = rankDeckFits(needs, ctxWith([]), deckB, inDeck, [cand('Doom Blade', [['removal', 3]])])
  assert.equal(fits.length, 0)
})

test('commander synergy lifts a fit above an equally-strong but off-synergy fit', () => {
  // Commander rewards card_draw; two equal-weight cards, one matching that role.
  const fits = rankDeckFits(needs, ctxWith(['card_draw']), deckB, noneInDeck, [
    cand('Sign in Blood', [['card_draw', 3]]),
    cand('Doom Blade', [['removal', 3]]),
  ])
  assert.equal(fits[0].name, 'Sign in Blood') // commander synergy breaks the tie
})

test('each candidate is scored at its best-fitting need', () => {
  const fits = rankDeckFits(needs, ctxWith([]), deckB, noneInDeck, [cand('Versatile', [['removal', 2], ['card_draw', 4]])])
  assert.equal(fits[0].tag, 'card_draw') // higher weight role chosen
})
