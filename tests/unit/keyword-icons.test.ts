// normalizeKeywords — the pure mapper that turns a card's keyword strings into the
// icon keys the opponent view renders. Must accept BOTH the catalog form
// ("First strike") and the continuous-effect form ("first_strike"), because
// dynamically-granted keywords (auras/equipment/combat tricks) arrive as the
// underscored effect_type and are concatenated onto the printed list.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeKeywords } from '../../components/controller/KeywordIcon'

test('catalog form maps to icon keys', () => {
  assert.deepEqual(normalizeKeywords(['Flying', 'First strike']), ['flying', 'first_strike'])
})

test('granted form (underscored effect_type) maps too', () => {
  assert.deepEqual(normalizeKeywords(['first_strike', 'double_strike']), ['double_strike', 'first_strike'])
})

test('printed + granted dedupe (the merge case)', () => {
  // A creature printed with flying, then granted flying again by an aura.
  assert.deepEqual(normalizeKeywords(['Flying', 'flying']), ['flying'])
})

test('toxic aliases to the infect icon', () => {
  assert.deepEqual(normalizeKeywords(['toxic']), ['infect'])
})

test('unknown / icon-less keywords are dropped', () => {
  // wither has no icon; cycling is not combat-relevant — both silently dropped.
  assert.deepEqual(normalizeKeywords(['wither', 'cycling', 'Trample']), ['trample'])
})

test('null / empty input yields no keys', () => {
  assert.deepEqual(normalizeKeywords(null), [])
  assert.deepEqual(normalizeKeywords([]), [])
})

test('output follows the fixed display priority, not input order', () => {
  // reach comes after flying in PRIORITY regardless of input ordering.
  assert.deepEqual(normalizeKeywords(['reach', 'flying']), ['flying', 'reach'])
})
