// Deck conflicts (pure detection) + buy-suggestion link building.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { computeConflicts } from '../../lib/collection/conflicts'
import { buildScryfallUrl } from '../../lib/collection/buy-suggestions'

test('computeConflicts flags oracles committed beyond owned copies', () => {
  // Esper Sentinel: 1 owned, in 3 decks → conflict. Sol Ring: 2 owned, in 1 deck → fine.
  const usage = new Map([
    ['esper', { committed: 3, decks: [{ id: 'a', name: 'Cloud' }, { id: 'b', name: 'Urza' }, { id: 'c', name: 'Yshtola' }] }],
    ['sol', { committed: 1, decks: [{ id: 'a', name: 'Cloud' }] }],
  ])
  const owned = new Map([['esper', 1], ['sol', 2]])
  const names = new Map([['esper', 'Esper Sentinel'], ['sol', 'Sol Ring']])

  const conflicts = computeConflicts(usage, owned, names)
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].name, 'Esper Sentinel')
  assert.equal(conflicts[0].ownedQty, 1)
  assert.equal(conflicts[0].committedQty, 3)
  assert.equal(conflicts[0].decks.length, 3)
})

test('a card in a deck but not owned (owned 0) is a conflict', () => {
  const usage = new Map([['x', { committed: 1, decks: [{ id: 'a', name: 'A' }] }]])
  const conflicts = computeConflicts(usage, new Map(), new Map([['x', 'Proxy Card']]))
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].ownedQty, 0)
})

test('conflicts are sorted by worst shortfall first', () => {
  const usage = new Map([
    ['small', { committed: 2, decks: [{ id: '1', name: 'D1' }, { id: '2', name: 'D2' }] }], // shortfall 1
    ['big', { committed: 4, decks: [{ id: '1', name: 'D1' }] }], // shortfall 4
  ])
  const owned = new Map([['small', 1], ['big', 0]])
  const names = new Map([['small', 'Small'], ['big', 'Big']])
  assert.deepEqual(
    computeConflicts(usage, owned, names).map((c) => c.name),
    ['Big', 'Small'],
  )
})

test('buildScryfallUrl makes an exact-name search link', () => {
  assert.equal(buildScryfallUrl('Sol Ring'), 'https://scryfall.com/search?q=' + encodeURIComponent('!"Sol Ring"'))
  // commas / quotes in names survive encoding
  assert.match(buildScryfallUrl('Krenko, Mob Boss'), /Krenko/)
})
