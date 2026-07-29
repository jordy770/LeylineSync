// Save-deck proposal revalidation (lib/collection/proposal-validate) — pure,
// server-side re-check of a save-deck payload before any DB write. The client
// proposal is untrusted (collection may have changed, payload may be hand-
// crafted); every rule below re-derives the ok/error verdict from a fresh
// CardMeta snapshot rather than trusting anything the client asserts.
// Task brief: .superpowers/sdd/2026-07-29-deck-generation/task-3-brief.md
//
// Each rule gets its own isolated test: exactly one violation is present per
// fixture so a failing assertion points at the rule that actually broke,
// not an earlier rule shadowing it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateProposal } from '../../lib/collection/proposal-validate'
import type { CardMeta, SavePayloadBasics, SavePayloadCard } from '../../lib/collection/proposal-validate'

const IDENTITY = ['G', 'U']

function meta(over: Partial<CardMeta> = {}): CardMeta {
  return {
    oracleId: 'card-1',
    colorIdentity: ['G'],
    typeLine: 'Creature — Bear',
    ownedQty: 1,
    ...over,
  }
}

function metaMap(entries: CardMeta[]): Map<string, CardMeta> {
  return new Map(entries.map((m) => [m.oracleId, m]))
}

test('happy path: well-formed cards + basics under the cap → ok', () => {
  const cards: SavePayloadCard[] = [
    { oracleId: 'card-1', quantity: 1 },
    { oracleId: 'card-2', quantity: 1 },
  ]
  const basics: SavePayloadBasics = [{ name: 'Forest', quantity: 10 }, { name: 'Island', quantity: 10 }]
  const metaByOracle = metaMap([
    meta({ oracleId: 'card-1', colorIdentity: ['G'] }),
    meta({ oracleId: 'card-2', colorIdentity: ['U'] }),
  ])
  const result = validateProposal(cards, basics, IDENTITY, metaByOracle)
  assert.deepEqual(result, { ok: true })
})

test('duplicate oracleId across the cards list → error', () => {
  const cards: SavePayloadCard[] = [
    { oracleId: 'card-1', quantity: 1 },
    { oracleId: 'card-1', quantity: 1 },
  ]
  const metaByOracle = metaMap([meta({ oracleId: 'card-1' })])
  const result = validateProposal(cards, [], IDENTITY, metaByOracle)
  assert.equal(result.ok, false)
  assert.match((result as { error: string }).error, /duplicate/i)
})

test('quantity !== 1 on a nonbasic card → error', () => {
  const cards: SavePayloadCard[] = [{ oracleId: 'card-1', quantity: 2 }]
  const metaByOracle = metaMap([meta({ oracleId: 'card-1' })])
  const result = validateProposal(cards, [], IDENTITY, metaByOracle)
  assert.equal(result.ok, false)
  assert.match((result as { error: string }).error, /quantity/i)
})

test('card oracleId missing from the meta map (unknown card) → error', () => {
  const cards: SavePayloadCard[] = [{ oracleId: 'ghost-card', quantity: 1 }]
  const metaByOracle = metaMap([]) // nothing resolves
  const result = validateProposal(cards, [], IDENTITY, metaByOracle)
  assert.equal(result.ok, false)
  assert.match((result as { error: string }).error, /unknown/i)
})

test('ownedQty < 1 on a submitted card → error', () => {
  const cards: SavePayloadCard[] = [{ oracleId: 'card-1', quantity: 1 }]
  const metaByOracle = metaMap([meta({ oracleId: 'card-1', ownedQty: 0 })])
  const result = validateProposal(cards, [], IDENTITY, metaByOracle)
  assert.equal(result.ok, false)
  assert.match((result as { error: string }).error, /own/i)
})

test('card color identity not a subset of the commander identity → error', () => {
  const cards: SavePayloadCard[] = [{ oracleId: 'card-1', quantity: 1 }]
  // Commander identity is ['G','U']; this card carries R, which the commander
  // can't cast.
  const metaByOracle = metaMap([meta({ oracleId: 'card-1', colorIdentity: ['R'] })])
  const result = validateProposal(cards, [], IDENTITY, metaByOracle)
  assert.equal(result.ok, false)
  assert.match((result as { error: string }).error, /identity/i)
})

test('basics name outside the whitelist → error', () => {
  const basics = [{ name: 'Not A Basic', quantity: 1 }] as unknown as SavePayloadBasics
  const result = validateProposal([], basics, IDENTITY, metaMap([]))
  assert.equal(result.ok, false)
  assert.match((result as { error: string }).error, /basic/i)
})

test('basics quantity < 1 → error', () => {
  const basics: SavePayloadBasics = [{ name: 'Forest', quantity: 0 }]
  const result = validateProposal([], basics, IDENTITY, metaMap([]))
  assert.equal(result.ok, false)
  assert.match((result as { error: string }).error, /quantity/i)
})

test('total commander + cards + basics > 100 → error', () => {
  // 1 commander + 60 cards + 40 basics = 101, one over the cap. Every card and
  // basic here is individually well-formed so only the totals rule can fire.
  const cards: SavePayloadCard[] = Array.from({ length: 60 }, (_, i) => ({ oracleId: `card-${i}`, quantity: 1 }))
  const metaByOracle = metaMap(cards.map((c) => meta({ oracleId: c.oracleId, colorIdentity: ['G'] })))
  const basics: SavePayloadBasics = [{ name: 'Forest', quantity: 40 }]
  const result = validateProposal(cards, basics, IDENTITY, metaByOracle)
  assert.equal(result.ok, false)
  assert.match((result as { error: string }).error, /100/)
})

// ── review fix round 1: basics quantity must be a real positive integer ──
// (undefined/NaN/string quantities silently defeated both the per-item check
// and the aggregate cap — `undefined < 1` and `NaN > 100` are both `false`).

test('basics with a missing quantity field → error (not silently 0/undefined)', () => {
  const basics = [{ name: 'Forest' }] as unknown as SavePayloadBasics
  const result = validateProposal([], basics, IDENTITY, metaMap([]))
  assert.equal(result.ok, false)
  assert.match((result as { error: string }).error, /quantity/i)
})

test('basics quantity as a non-numeric string → error', () => {
  const basics = [{ name: 'Forest', quantity: 'lots' }] as unknown as SavePayloadBasics
  const result = validateProposal([], basics, IDENTITY, metaMap([]))
  assert.equal(result.ok, false)
  assert.match((result as { error: string }).error, /quantity/i)
})

test('reachable exploit: 90 owned cards + 200-quantity Forest + missing-quantity Island → rejected, nothing persists', () => {
  // Before the fix: NaN math from the missing-quantity Island made totalBasics
  // NaN, and `NaN > 100` is false, so the 100-card cap silently no-op'd on the
  // whole request — a ~292-card deck would have made it past validateProposal.
  const cards: SavePayloadCard[] = Array.from({ length: 90 }, (_, i) => ({ oracleId: `card-${i}`, quantity: 1 }))
  const metaByOracle = metaMap(cards.map((c) => meta({ oracleId: c.oracleId, colorIdentity: ['G'] })))
  const basics = [
    { name: 'Forest', quantity: 200 },
    { name: 'Island' },
  ] as unknown as SavePayloadBasics
  const result = validateProposal(cards, basics, IDENTITY, metaByOracle)
  assert.equal(result.ok, false)
})

test('duplicate basic land name across the basics list → error', () => {
  const basics: SavePayloadBasics = [
    { name: 'Forest', quantity: 5 },
    { name: 'Forest', quantity: 5 },
  ]
  const result = validateProposal([], basics, IDENTITY, metaMap([]))
  assert.equal(result.ok, false)
  assert.match((result as { error: string }).error, /duplicate/i)
})
