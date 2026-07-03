// Upgrade scanner — the pure selection core (free swaps/additions, occupied,
// color-identity fit). Synthetic candidates keep it independent of the card pool.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildFreeUpgrades, buildOccupiedUpgrades, fitsColorIdentity } from '../../lib/collection/upgrade-scanner'
import type { InDeckCard, UpgradeCandidate } from '../../lib/collection/upgrade-scanner'
import type { DeckNeed } from '../../lib/collection/power-score'

const drawNeed: DeckNeed = { tag: 'card_draw', have: 3, target: 10, gap: 7 }

function cand(name: string, tag: 'card_draw' | 'removal', weight: number, price: number | null = null): UpgradeCandidate {
  return { oracleId: `c-${name}`, name, cmc: 3, priceEur: price, tags: [{ tag, weight }] }
}

test('fitsColorIdentity: subset passes, superset fails', () => {
  assert.equal(fitsColorIdentity(['B'], ['W', 'B']), true)
  assert.equal(fitsColorIdentity([], ['G']), true) // colorless fits anything
  assert.equal(fitsColorIdentity(['R'], ['W', 'B']), false)
})

test('free upgrade pairs a stronger card with a weaker same-role card to cut', () => {
  const inDeck: InDeckCard[] = [{ oracleId: 'curiosity', name: 'Curiosity', tags: [{ tag: 'card_draw', weight: 1 }] }]
  const candidates = [cand('Phyrexian Arena', 'card_draw', 3)]

  const out = buildFreeUpgrades([drawNeed], candidates, inDeck)
  assert.equal(out.length, 1)
  assert.equal(out[0].in.name, 'Phyrexian Arena')
  assert.equal(out[0].out?.name, 'Curiosity')
  assert.equal(out[0].delta, 2)
  assert.match(out[0].reason, /Over Curiosity/)
})

test('with no weaker same-role card, it is an addition (no out)', () => {
  const out = buildFreeUpgrades([drawNeed], [cand('Phyrexian Arena', 'card_draw', 3)], [])
  assert.equal(out[0].out, null)
  assert.match(out[0].reason, /Fills card draw/)
})

test('the same in-deck card is not cut twice', () => {
  const inDeck: InDeckCard[] = [{ oracleId: 'curiosity', name: 'Curiosity', tags: [{ tag: 'card_draw', weight: 1 }] }]
  const candidates = [cand('Phyrexian Arena', 'card_draw', 3), cand('Rhystic Study', 'card_draw', 3)]

  const out = buildFreeUpgrades([drawNeed], candidates, inDeck)
  const cuts = out.filter((u) => u.out !== null)
  assert.equal(cuts.length, 1, 'only one card can replace Curiosity; the other is an addition')
})

test('stronger candidates are preferred (sorted by weight desc)', () => {
  const candidates = [cand('Weak Draw', 'card_draw', 1), cand('Strong Draw', 'card_draw', 3)]
  const out = buildFreeUpgrades([drawNeed], candidates, [])
  assert.equal(out[0].in.name, 'Strong Draw')
})

test('occupied upgrade reports the deck it is locked in and a move action', () => {
  const c: UpgradeCandidate = { ...cand('Esper Sentinel', 'card_draw', 3), usedBy: [{ id: 'd1', name: 'Cloud Equipment' }] }
  const out = buildOccupiedUpgrades([drawNeed], [c])
  assert.equal(out[0].action, 'move')
  assert.deepEqual(out[0].usedBy, [{ id: 'd1', name: 'Cloud Equipment' }])
  assert.match(out[0].reason, /Cloud Equipment/)
})

test('occupied with multiple owning decks is a buy (move is ambiguous)', () => {
  const c: UpgradeCandidate = {
    ...cand('Esper Sentinel', 'card_draw', 3),
    usedBy: [{ id: 'd1', name: 'Cloud' }, { id: 'd2', name: 'Urza' }],
  }
  assert.equal(buildOccupiedUpgrades([drawNeed], [c])[0].action, 'buy')
})

test('a candidate that fills no need is ignored', () => {
  // Need is card_draw; candidate only has removal.
  const out = buildFreeUpgrades([drawNeed], [cand('Doom Blade', 'removal', 2)], [])
  assert.equal(out.length, 0)
})
