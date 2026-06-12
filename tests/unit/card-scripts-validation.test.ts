// Every curated entry in docs/commander-decks/card-scripts.json must pass
// validateCardScript — the same gate the hosted upsert applies.
//
// Why this exists (bug-687): the upsert script was the ONLY place these
// scripts were validated, so schema drift surfaced months late, at sync
// time. Two latent gaps (count.times lost to a CRLF-regex no-op, hexproof
// missing from grant_keyword) shipped through dozens of green local runs
// before the hosted validator rejected them. This test closes that gap:
// schema drift in the curated catalog now fails `npm test` immediately.
//
// No DB — pure schema validation. Run via the standard test runner.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateCardScript } from '../../lib/game/card-behavior-schema'

const SCRIPTS_PATH = join(__dirname, '..', '..', 'docs', 'commander-decks', 'card-scripts.json')

test('every curated card script passes validateCardScript', () => {
  const scripts: Record<string, unknown> = JSON.parse(readFileSync(SCRIPTS_PATH, 'utf8'))
  const failures: string[] = []
  for (const [name, script] of Object.entries(scripts)) {
    if (name.startsWith('_')) continue // _readme and friends

    const result = validateCardScript(script) as { success: boolean; errors?: string[] }
    if (!result.success) {
      failures.push(`${name}: ${(result.errors ?? []).join('; ')}`)
    }
  }
  assert.deepEqual(
    failures,
    [],
    `These card-scripts.json entries fail schema validation (the hosted upsert ` +
      `would reject them):\n${failures.join('\n')}`,
  )
})
