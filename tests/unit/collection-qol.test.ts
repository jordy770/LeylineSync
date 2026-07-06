// Collection QoL (2026-07-07) — the pure cores of the re-import diff and the
// pull-list builder.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { diffCollections } from '../../lib/collection/import-collection'
import { buildPullList } from '../../lib/collection/pull-list'

const entry = (name: string, qty: number) => ({ name, qty })

test('diffCollections reports added, removed and quantity deltas', () => {
  const before = new Map([
    ['o1', entry('Sol Ring', 2)],
    ['o2', entry('Counterspell', 4)],
    ['o3', entry('Sold Card', 1)],
  ])
  const after = new Map([
    ['o1', entry('Sol Ring', 3)], // +1
    ['o2', entry('Counterspell', 1)], // -3
    ['o4', entry('New Card', 2)], // brand new
  ])

  const diff = diffCollections(before, after)
  assert.equal(diff.addedUnique, 1)
  assert.equal(diff.removedUnique, 1)
  assert.equal(diff.qtyAdded, 3) // +1 Sol Ring, +2 New Card
  assert.equal(diff.qtyRemoved, 4) // -3 Counterspell, -1 Sold Card
  assert.deepEqual(diff.added[0], { name: 'New Card', qty: 2 }) // sorted by qty
  assert.deepEqual(diff.removed[0], { name: 'Counterspell', qty: 3 })
})

test('diffCollections on identical snapshots is all-zero', () => {
  const snap = new Map([['o1', entry('Sol Ring', 2)]])
  const diff = diffCollections(snap, new Map(snap))
  assert.equal(diff.qtyAdded + diff.qtyRemoved + diff.addedUnique + diff.removedUnique, 0)
  assert.equal(diff.added.length + diff.removed.length, 0)
})

test('buildPullList groups per binder, alphabetical, and drains stock greedily', () => {
  const deck = [
    { oracleId: 'a', name: 'Arcane Signet', quantity: 1 },
    { oracleId: 'b', name: 'Brainstorm', quantity: 3 },
    { oracleId: 'c', name: 'Craterhoof', quantity: 1 },
  ]
  const binders = [
    { oracleId: 'a', binder: 'Staples', quantity: 1 },
    { oracleId: 'b', binder: 'Blue box', quantity: 2 }, // 1 short
    { oracleId: 'b', binder: 'Staples', quantity: 5 },
  ]
  const elsewhere = new Map([['c', ['Y’shtola']]])

  const list = buildPullList(deck, binders, elsewhere)

  // Fullest stack first: all 3 Brainstorms come from Staples, not split.
  const staples = list.groups.find((g) => g.binder === 'Staples')
  assert.deepEqual(
    staples?.cards.map((c) => `${c.need}x ${c.name}`),
    ['1x Arcane Signet', '3x Brainstorm'],
  )
  assert.equal(list.groups.some((g) => g.binder === 'Blue box'), false)

  // Craterhoof can't be pulled — it lives in another deck.
  assert.equal(list.missing.length, 1)
  assert.deepEqual(list.missing[0], { name: 'Craterhoof', need: 1, inDecks: ['Y’shtola'] })
})

test('buildPullList splits across binders when one runs dry', () => {
  const deck = [{ oracleId: 'b', name: 'Brainstorm', quantity: 4 }]
  const binders = [
    { oracleId: 'b', binder: 'Blue box', quantity: 3 },
    { oracleId: 'b', binder: 'Staples', quantity: 1 },
  ]
  const list = buildPullList(deck, binders)
  assert.equal(list.groups.length, 2)
  assert.equal(list.missing.length, 0)
  const total = list.groups.flatMap((g) => g.cards).reduce((n, c) => n + c.need, 0)
  assert.equal(total, 4)
})
