// Decklist parser — the pure core of the deck import. Covers the quantity/set/
// foil/category grammar plus commander detection via section header and via an
// Archidekt inline category, and skipping of sideboard-style sections.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseDecklist } from '../../lib/collection/parsers/decklist'

test('parses bare "qty name" lines, defaulting a missing qty to 1', () => {
  const { cards } = parseDecklist('1 Sol Ring\nArcane Signet\n3 Forest\n')
  assert.deepEqual(
    cards.map((c) => [c.name, c.quantity]),
    [
      ['Sol Ring', 1],
      ['Arcane Signet', 1],
      ['Forest', 3],
    ],
  )
})

test('strips (SET) collector and foil markers, keeping the clean name', () => {
  const { cards } = parseDecklist('1 Sol Ring (C21) 263 *F*\n1x Brainstorm (MH2) 42\n')
  assert.deepEqual(cards[0], {
    name: 'Sol Ring',
    quantity: 1,
    setCode: 'C21',
    collectorNum: '263',
    isCommander: false,
    category: null,
  })
  assert.equal(cards[1].name, 'Brainstorm')
  assert.equal(cards[1].quantity, 1) // "1x" quantity form
})

test('a Commander section header marks its cards as commander', () => {
  const list = ['Commander', '1 Atraxa, Praetors\' Voice', '', 'Deck', '1 Sol Ring'].join('\n')
  const { cards } = parseDecklist(list)
  const atraxa = cards.find((c) => c.name.startsWith('Atraxa'))
  const solRing = cards.find((c) => c.name === 'Sol Ring')
  assert.equal(atraxa?.isCommander, true)
  assert.equal(solRing?.isCommander, false)
})

test('Archidekt inline [Commander] category marks the commander', () => {
  const { cards } = parseDecklist('1x Krenko, Mob Boss (CMR) 1 [Commander{top}]\n1x Goblin Matron (M19) 145 [Ramp]\n')
  const krenko = cards.find((c) => c.name.startsWith('Krenko'))
  assert.equal(krenko?.isCommander, true)
  assert.equal(krenko?.category, 'Commander{top}')
  assert.equal(cards.find((c) => c.name === 'Goblin Matron')?.category, 'Ramp')
})

test('a "Commander:" header with colon (and "Commanders") also marks the section', () => {
  const list = ['Commander:', '1 Atraxa, Praetors\' Voice', 'Deck', '1 Sol Ring'].join('\n')
  const { cards } = parseDecklist(list)
  assert.equal(cards.find((c) => c.name.startsWith('Atraxa'))?.isCommander, true)
  assert.equal(cards.find((c) => c.name === 'Sol Ring')?.isCommander, false)

  const plural = parseDecklist(['Commanders (2)', '1 Thrasios, Triton Hero', '1 Tymna the Weaver', 'Deck', '1 Sol Ring'].join('\n'))
  assert.equal(plural.cards.filter((c) => c.isCommander).length, 2)
})

test('a *CMDR* line marker marks the commander without a section header', () => {
  const { cards } = parseDecklist('1 Atraxa, Praetors\' Voice *CMDR*\n1 Sol Ring\n')
  const atraxa = cards.find((c) => c.name.startsWith('Atraxa'))
  assert.equal(atraxa?.isCommander, true)
  assert.equal(atraxa?.name, 'Atraxa, Praetors\' Voice')
  assert.equal(cards.find((c) => c.name === 'Sol Ring')?.isCommander, false)
})

test('sideboard / maybeboard sections are skipped', () => {
  const list = ['Deck', '1 Sol Ring', 'Sideboard', '1 Pyroblast', 'Maybeboard', '1 Wheel of Fortune'].join('\n')
  const { cards } = parseDecklist(list)
  assert.deepEqual(cards.map((c) => c.name), ['Sol Ring'])
})

test('Moxfield "Deck (99)" header with a count is recognised', () => {
  const { cards } = parseDecklist('Deck (99)\n1 Sol Ring\n')
  assert.equal(cards.length, 1)
  assert.equal(cards[0].name, 'Sol Ring')
})

test('comment and SB: lines are ignored', () => {
  const { cards } = parseDecklist('// my deck\n# notes\n1 Sol Ring\nSB: 1 Pyroblast\n')
  assert.deepEqual(cards.map((c) => c.name), ['Sol Ring'])
})

test('commas in card names survive the grammar', () => {
  const { cards } = parseDecklist('1 Krenko, Mob Boss (CMR) 1\n')
  assert.equal(cards[0].name, 'Krenko, Mob Boss')
})
