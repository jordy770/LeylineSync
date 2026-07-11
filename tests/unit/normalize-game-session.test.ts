// normalizeGameSession rebuilds the session object field by field — a column
// added to the SELECT but not to the normalizer silently vanishes client-side
// (bug-1506: tv_code was fetched everywhere and shown nowhere).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeGameSession } from '../../lib/game/data'

test('normalizeGameSession preserves tv_code', () => {
  const session = normalizeGameSession({
    id: 'abc',
    status: 'open',
    created_by: 'u1',
    tv_code: '1A7D',
  })
  assert.equal(session.tv_code, '1A7D')
})

test('normalizeGameSession defaults tv_code to null', () => {
  const session = normalizeGameSession({ id: 'abc', status: 'open', created_by: 'u1' })
  assert.equal(session.tv_code, null)
})
