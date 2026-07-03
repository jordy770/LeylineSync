// Dashboard — pure "free staples" ranking (strong unused binder cards).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { rankStaples } from '../../lib/collection/dashboard'
import type { SynergyTag } from '../../lib/collection/synergy/tagger'

function card(name: string, tags: [SynergyTag, number][], opts: { typeLine?: string; priceEur?: number | null } = {}) {
  return {
    oracleId: `o-${name}`,
    name,
    typeLine: opts.typeLine ?? 'Artifact',
    priceEur: opts.priceEur ?? null,
    tags: tags.map(([tag, weight]) => ({ tag, weight })),
  }
}

test('rankStaples keeps only genuine staples (best tag weight >= 3), sorted by weight', () => {
  const out = rankStaples([
    card('Strong Rock', [['ramp', 4]]),
    card('Filler', [['ramp', 2]]), // weight < 3 → dropped
    card('Decent', [['removal', 3]]),
  ])
  assert.deepEqual(
    out.map((s) => s.name),
    ['Strong Rock', 'Decent'],
  )
  assert.equal(out[0].tag, 'ramp')
})

test('rankStaples uses the card\'s strongest tag', () => {
  const out = rankStaples([card('Multi', [['lifegain', 2], ['removal', 4]])])
  assert.equal(out[0].tag, 'removal')
  assert.equal(out[0].weight, 4)
})

test('rankStaples excludes basic lands and ties-break by price', () => {
  const out = rankStaples([
    card('Swamp', [['land', 4]], { typeLine: 'Basic Land — Swamp' }),
    card('Cheap', [['ramp', 3]], { priceEur: 0.5 }),
    card('Pricey', [['ramp', 3]], { priceEur: 12 }),
  ])
  assert.ok(!out.find((s) => s.name === 'Swamp'))
  assert.deepEqual(out.map((s) => s.name), ['Pricey', 'Cheap']) // same weight → higher price first
})

test('rankStaples honours the limit', () => {
  const many = Array.from({ length: 20 }, (_, i) => card(`c${i}`, [['ramp', 4]]))
  assert.equal(rankStaples(many, 5).length, 5)
})
