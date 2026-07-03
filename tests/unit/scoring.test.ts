// Recommendation scoring — commander synergy, theme impact, curve fit, confidence.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildDeckContext,
  commanderSynergy,
  confidence,
  curveFit,
  deckThemeTags,
  themeImpact,
} from '../../lib/collection/scoring'
import type { ConfidenceSignals } from '../../lib/collection/scoring'
import type { DeckCardForScore } from '../../lib/collection/power-score'
import type { SynergyTag } from '../../lib/collection/synergy/tagger'

let n = 0
function deckCard(tags: SynergyTag[], opts: { qty?: number; commander?: boolean; cmc?: number } = {}): DeckCardForScore {
  n += 1
  return {
    oracleId: `o-${n}`,
    quantity: opts.qty ?? 1,
    cmc: opts.cmc ?? 2,
    typeLine: 'Creature',
    isCommander: opts.commander ?? false,
    tags: tags.map((t) => ({ tag: t, weight: 2 })),
  }
}
const ct = (tags: SynergyTag[]) => tags.map((t) => ({ tag: t, weight: 2 }))

test('deckThemeTags surfaces archetype tags above threshold, excluding staples', () => {
  // 6 sacrifice cards + lots of removal (a staple). Theme = sacrifice, not removal.
  const cards = [
    ...Array.from({ length: 6 }, () => deckCard(['sacrifice'])),
    ...Array.from({ length: 9 }, () => deckCard(['removal'])),
  ]
  const theme = deckThemeTags(cards)
  assert.ok(theme.has('sacrifice'))
  assert.ok(!theme.has('removal'), 'removal is a universal staple, not a theme')
})

test('commanderSynergy is the weighted overlap with the commander tags', () => {
  const commander = ct(['spellslinger', 'card_draw']) // weights 2 + 2 = 4
  assert.equal(commanderSynergy(ct(['spellslinger']), commander), 0.5) // matched 2 / 4
  assert.equal(commanderSynergy(ct(['spellslinger', 'card_draw']), commander), 1)
  assert.equal(commanderSynergy(ct(['token']), commander), 0)
  assert.equal(commanderSynergy(ct(['anything' as SynergyTag]), []), 0) // no commander
})

test('themeImpact: keeps / weakens / neutral', () => {
  const theme = new Set<SynergyTag>(['sacrifice'])
  assert.equal(themeImpact(ct(['sacrifice', 'removal']), theme), 'Keeps Theme')
  assert.equal(themeImpact(ct(['artifact']), theme), 'Weakens Theme') // off-theme archetype tag
  assert.equal(themeImpact(ct(['removal']), theme), 'Neutral') // pure staple, doesn't fight theme
  assert.equal(themeImpact(ct(['artifact']), new Set()), 'Neutral') // deck has no theme
})

test('curveFit rewards cards at/below the average MV', () => {
  assert.equal(curveFit(2, 3), 1)
  assert.ok(curveFit(7, 3) < curveFit(4, 3))
})

function sig(overrides: Partial<ConfidenceSignals>): ConfidenceSignals {
  return {
    needGap: 5,
    target: 10,
    roleWeight: 3,
    replacementDelta: 2,
    commanderSynergy: 0.5,
    themeImpact: 'Neutral',
    curveFit: 1,
    availability: 'free',
    hasCommander: true,
    ...overrides,
  }
}

test('confidence rewards commander synergy and on-theme cards', () => {
  const base = confidence(sig({ commanderSynergy: 0, themeImpact: 'Neutral' }))
  const synergistic = confidence(sig({ commanderSynergy: 1, themeImpact: 'Keeps Theme' }))
  assert.ok(synergistic > base)
})

test('confidence prefers owned over buy, and is 0-100', () => {
  const free = confidence(sig({ availability: 'free' }))
  const buy = confidence(sig({ availability: 'buy' }))
  assert.ok(free > buy)
  assert.ok(free >= 0 && free <= 100)
})

test('a Weakens-Theme card scores below an equivalent Keeps-Theme card', () => {
  const keeps = confidence(sig({ themeImpact: 'Keeps Theme' }))
  const weakens = confidence(sig({ themeImpact: 'Weakens Theme' }))
  assert.ok(keeps > weakens)
})

test('buildDeckContext flags the commander and its tags', () => {
  const ctx = buildDeckContext([deckCard(['lifegain', 'card_draw'], { commander: true }), deckCard(['removal'])], 2.5)
  assert.equal(ctx.hasCommander, true)
  assert.equal(ctx.commanderTags.length, 2)
})
