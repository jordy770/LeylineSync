// ManaBox CSV parser + oracle resolver — the pure core of the collection import.
// Covers header-tolerance, finish/binder mapping, quoted fields, and the
// scryfall-id → set+collector → name resolution priority.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseCsv, parseManaboxCsv } from '../../lib/collection/parsers/manabox'
import { resolveOracleId } from '../../lib/collection/resolve'
import type { ParsedCollectionRow, PrintingLookup } from '../../lib/collection/types'

test('parses a standard ManaBox export and maps columns by header name', () => {
  const csv = [
    'Name,Set code,Collector number,Foil,Quantity,Condition,Language,Scryfall ID',
    'Sol Ring,cmr,472,normal,2,near_mint,en,abc-123',
    'Esper Sentinel,mh2,12,foil,1,mint,en,def-456',
  ].join('\n')

  const { rows, errors } = parseManaboxCsv(csv)

  assert.equal(errors.length, 0)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], {
    name: 'Sol Ring',
    quantity: 2,
    setCode: 'cmr',
    collectorNum: '472',
    finish: 'nonfoil',
    language: 'en',
    condition: 'near_mint',
    binderType: 'binder',
    binderName: null,
    scryfallId: 'abc-123',
  } satisfies ParsedCollectionRow)
  assert.equal(rows[1].finish, 'foil')
})

test('captures Binder Name (where the card physically sits)', () => {
  const csv = ['Name,Quantity,Binder Name,Binder Type', 'Sol Ring,1,Trade binder,binder', 'Brainstorm,1,,deck'].join('\n')
  const { rows } = parseManaboxCsv(csv)
  assert.equal(rows[0].binderName, 'Trade binder')
  assert.equal(rows[1].binderName, null) // empty → null
})

test('maps Binder Type when present (deck/list/binder)', () => {
  const csv = [
    'Name,Quantity,Binder Type',
    'Counterspell,1,deck',
    'Brainstorm,1,list',
    'Ponder,1,binder',
  ].join('\n')

  const { rows } = parseManaboxCsv(csv)
  assert.deepEqual(
    rows.map((r) => r.binderType),
    ['deck', 'list', 'binder'],
  )
})

test('defaults: missing quantity → 1, missing language → en, missing binder → binder', () => {
  const { rows } = parseManaboxCsv('Name\nLightning Bolt\n')
  assert.equal(rows[0].quantity, 1)
  assert.equal(rows[0].language, 'en')
  assert.equal(rows[0].binderType, 'binder')
})

test('etched finish is recognised distinctly from foil', () => {
  const { rows } = parseManaboxCsv('Name,Foil\nGilded Lotus,etched\n')
  assert.equal(rows[0].finish, 'etched')
})

test('a missing Name column is a fatal, explained error', () => {
  const { rows, errors } = parseManaboxCsv('Quantity,Set code\n2,cmr\n')
  assert.equal(rows.length, 0)
  assert.match(errors[0], /name/i)
})

test('rows without a name are skipped with a per-line note, not fatal', () => {
  const { rows, errors } = parseManaboxCsv('Name,Quantity\nSol Ring,1\n,3\n')
  assert.equal(rows.length, 1)
  assert.equal(errors.length, 1)
})

test('CSV reader handles quoted commas and escaped quotes', () => {
  const records = parseCsv('Name,Note\n"Krenko, Mob Boss","he said ""go"""\n')
  assert.deepEqual(records[1], ['Krenko, Mob Boss', 'he said "go"'])
})

test('a UTF-8 BOM on the first header is stripped', () => {
  const { rows } = parseManaboxCsv('﻿Name,Quantity\nSol Ring,2\n')
  assert.equal(rows[0].name, 'Sol Ring')
  assert.equal(rows[0].quantity, 2)
})

// ── resolver priority ──

function lookup(partial: Partial<PrintingLookup>): PrintingLookup {
  return {
    byScryfallId: new Map(),
    bySetCollector: new Map(),
    byName: new Map(),
    colorIdentityByOracle: new Map(),
    ...partial,
  }
}

function row(overrides: Partial<ParsedCollectionRow>): ParsedCollectionRow {
  return {
    name: 'Sol Ring',
    quantity: 1,
    setCode: null,
    collectorNum: null,
    finish: 'nonfoil',
    language: 'en',
    condition: null,
    binderType: 'binder',
    binderName: null,
    scryfallId: null,
    ...overrides,
  }
}

test('resolver prefers scryfall id over set+collector and name', () => {
  const lk = lookup({
    byScryfallId: new Map([['abc', 'oracle-from-id']]),
    bySetCollector: new Map([['cmr|472', 'oracle-from-set']]),
    byName: new Map([['sol ring', 'oracle-from-name']]),
  })
  assert.equal(resolveOracleId(row({ scryfallId: 'ABC', setCode: 'cmr', collectorNum: '472' }), lk), 'oracle-from-id')
})

test('resolver falls back to set+collector, then to name', () => {
  const lk = lookup({
    bySetCollector: new Map([['cmr|472', 'oracle-from-set']]),
    byName: new Map([['sol ring', 'oracle-from-name']]),
  })
  assert.equal(resolveOracleId(row({ setCode: 'cmr', collectorNum: '472' }), lk), 'oracle-from-set')
  assert.equal(resolveOracleId(row({ name: 'Sol Ring' }), lk), 'oracle-from-name')
})

test('resolver returns null when nothing matches', () => {
  assert.equal(resolveOracleId(row({ name: 'Unknown Card' }), lookup({})), null)
})
