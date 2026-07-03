// Deck-URL import — the pure URL detection + JSON→text mappers, plus the fetch
// wrapper with an injected fetch (no real network). Site JSON shapes are pinned via
// fixtures and round-tripped through the real decklist parser.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  archidektJsonToText,
  fetchDecklistFromUrl,
  moxfieldJsonToText,
  parseDeckUrl,
} from '../../lib/collection/fetch-decklist'
import { parseDecklist } from '../../lib/collection/parsers/decklist'

test('parseDeckUrl detects Moxfield and Archidekt and rejects others', () => {
  assert.deepEqual(parseDeckUrl('https://www.moxfield.com/decks/abc123XYZ'), { source: 'moxfield', id: 'abc123XYZ' })
  assert.deepEqual(parseDeckUrl('https://archidekt.com/decks/987654-my-deck'), { source: 'archidekt', id: '987654' })
  assert.equal(parseDeckUrl('https://example.com/decks/1'), null)
  assert.equal(parseDeckUrl('not a url'), null)
})

test('moxfieldJsonToText handles the v2 flat shape and flags the commander', () => {
  const json = {
    name: 'Atraxa Superfriends',
    commanders: { x: { quantity: 1, card: { name: "Atraxa, Praetors' Voice" } } },
    mainboard: { a: { quantity: 1, card: { name: 'Sol Ring' } }, b: { quantity: 1, card: { name: 'Arcane Signet' } } },
  }
  const { name, text } = moxfieldJsonToText(json)
  assert.equal(name, 'Atraxa Superfriends')
  const { cards } = parseDecklist(text)
  assert.equal(cards.find((c) => c.name.startsWith('Atraxa'))?.isCommander, true)
  assert.equal(cards.find((c) => c.name === 'Sol Ring')?.isCommander, false)
  assert.equal(cards.length, 3)
})

test('moxfieldJsonToText handles the v3 boards shape', () => {
  const json = {
    name: 'Krenko',
    boards: {
      commanders: { cards: { x: { quantity: 1, card: { name: 'Krenko, Mob Boss' } } } },
      mainboard: { cards: { a: { quantity: 1, card: { name: 'Goblin Matron' } } } },
    },
  }
  const { cards } = parseDecklist(moxfieldJsonToText(json).text)
  assert.equal(cards.find((c) => c.name.startsWith('Krenko'))?.isCommander, true)
  assert.equal(cards.length, 2)
})

test('archidektJsonToText flags Commander category and skips maybeboard', () => {
  const json = {
    name: 'Edgar',
    cards: [
      { quantity: 1, categories: ['Commander'], card: { oracleCard: { name: 'Edgar Markov' } } },
      { quantity: 1, categories: ['Ramp'], card: { oracleCard: { name: 'Sol Ring' } } },
      { quantity: 1, categories: ['Maybeboard'], card: { oracleCard: { name: 'Wheel of Fortune' } } },
    ],
  }
  const { cards } = parseDecklist(archidektJsonToText(json).text)
  assert.equal(cards.find((c) => c.name === 'Edgar Markov')?.isCommander, true)
  assert.ok(cards.find((c) => c.name === 'Sol Ring'))
  assert.ok(!cards.find((c) => c.name === 'Wheel of Fortune'), 'maybeboard card should be skipped')
})

test('fetchDecklistFromUrl uses the fixed API host and maps the body', async () => {
  let calledUrl = ''
  const fakeFetch = async (url: string) => {
    calledUrl = url
    return new Response(JSON.stringify({ name: 'D', cards: [{ quantity: 1, categories: ['Commander'], card: { oracleCard: { name: 'Krenko, Mob Boss' } } }] }), { status: 200 })
  }
  const out = await fetchDecklistFromUrl('https://archidekt.com/decks/42-foo', fakeFetch)
  assert.equal(out.source, 'archidekt')
  assert.equal(calledUrl, 'https://archidekt.com/api/decks/42/') // id-only, fixed host
  assert.match(out.text, /Krenko/)
})

test('fetchDecklistFromUrl surfaces a clear error on a non-OK response', async () => {
  const fakeFetch = async () => new Response('nope', { status: 403 })
  await assert.rejects(() => fetchDecklistFromUrl('https://moxfield.com/decks/abc', fakeFetch), /private|blocking|403/i)
})

test('fetchDecklistFromUrl rejects unsupported URLs without fetching', async () => {
  let called = false
  const fakeFetch = async () => {
    called = true
    return new Response('{}')
  }
  await assert.rejects(() => fetchDecklistFromUrl('https://example.com/x', fakeFetch), /Unsupported/i)
  assert.equal(called, false)
})
