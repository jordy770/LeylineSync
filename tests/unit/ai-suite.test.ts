// Pure cores of the premium AI suite: sample-hand drawing (mulligan trainer),
// combo grounding (combo detector), and trade-package grounding (trade
// builder). The model calls themselves are not tested — what matters is that
// hands are drawable, and that nothing survives grounding unless it's owned.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { groundCombos } from '../../lib/collection/ai-combos'
import { groundTradePackage } from '../../lib/collection/ai-trade'
import { drawSampleHand } from '../../lib/collection/mulligan'

function seededRand(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

test('drawSampleHand draws 7 from qty-expanded pool, never the commander', () => {
  const cards = [
    { name: 'Meren of Clan Nel Toth', qty: 1, isCommander: true },
    { name: 'Swamp', qty: 10, isCommander: false },
    { name: 'Forest', qty: 8, isCommander: false },
    { name: 'Sakura-Tribe Elder', qty: 1, isCommander: false },
  ]
  const hand = drawSampleHand(cards, seededRand(42))
  assert.equal(hand.length, 7)
  assert.ok(!hand.includes('Meren of Clan Nel Toth'), 'commander stays in the command zone')
  // Multiples can repeat, but never beyond their quantity.
  assert.ok(hand.filter((n) => n === 'Sakura-Tribe Elder').length <= 1)
})

test('drawSampleHand caps at pool size for tiny decks', () => {
  const hand = drawSampleHand([{ name: 'Sol Ring', qty: 3, isCommander: false }], seededRand(1))
  assert.equal(hand.length, 3)
})

test('groundCombos drops lines naming unowned cards and annotates where pieces live', () => {
  const combos = groundCombos(
    [
      { cards: ['Mikaeus, the Unhallowed', 'Triskelion'], result: 'infinite damage', steps: '…' },
      { cards: ['Mikaeus, the Unhallowed', 'Walking Ballista'], result: 'infinite damage', steps: '…' }, // Ballista unowned
      { cards: ['Gravecrawler', 'Phyrexian Altar'], result: 'loop', steps: '…', missing: 'Zulaport Cutthroat' },
    ],
    ['Mikaeus, the Unhallowed', 'Gravecrawler'],
    ['Triskelion', 'Phyrexian Altar', 'Zulaport Cutthroat'],
  )
  assert.equal(combos.length, 2)
  assert.deepEqual(
    combos[0].cards.map((c) => c.where),
    ['deck', 'binder'],
  )
  // "Missing" piece the player actually owns is not missing — flag cleared.
  assert.equal(combos[1].missing, null)
})

test('groundTradePackage keeps only real tradables, dedupes, and recomputes the total', () => {
  const tradables = [
    { name: 'Rhystic Study', priceEur: 38.5 },
    { name: 'Smothering Tithe', priceEur: 22.0 },
  ]
  const { cards, totalEur } = groundTradePackage(
    ['rhystic study', 'Rhystic Study', 'Black Lotus', 'Smothering Tithe'],
    tradables,
  )
  assert.deepEqual(cards.map((c) => c.name), ['Rhystic Study', 'Smothering Tithe'])
  assert.equal(totalEur, 60.5)
})

test('sanitizeCardLocks keeps only uuid-shaped ids and drops empty results', async () => {
  const { sanitizeCardLocks } = await import('../../lib/collection/deck-loader')
  const id = '0df4a143-c50d-47ce-a995-0fb77d02de03'
  assert.equal(sanitizeCardLocks(null), null)
  assert.equal(sanitizeCardLocks({ locked: ['not-a-uuid'], excluded: [] }), null)
  assert.deepEqual(sanitizeCardLocks({ locked: [id, id, 'junk'], excluded: [id] }), {
    locked: [id],
    excluded: [id],
  })
})

test('bracket helpers: game changers found (incl. split faces), allowance per bracket', async () => {
  const { estimateBracket, findGameChangers, gameChangerAllowance } = await import('../../lib/collection/brackets')
  assert.deepEqual(findGameChangers(['Sol Ring', 'Rhystic Study', 'Tergrid, God of Fright']), [
    'Rhystic Study',
    'Tergrid, God of Fright',
  ])
  assert.equal(gameChangerAllowance(2), 0)
  assert.equal(gameChangerAllowance(3), 3)
  assert.equal(gameChangerAllowance(4), Number.POSITIVE_INFINITY)
  assert.equal(gameChangerAllowance(null), Number.POSITIVE_INFINITY)

  assert.equal(estimateBracket(['Sol Ring'], 0).bracket, 2)
  assert.equal(estimateBracket(['Rhystic Study'], 0).bracket, 3)
  assert.equal(
    estimateBracket(['Rhystic Study', 'Demonic Tutor', 'Mana Vault', 'The One Ring'], 2).bracket,
    4,
  )
})
