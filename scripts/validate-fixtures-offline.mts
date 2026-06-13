// Offline fixture validation — no DB, no credentials (unlike validate:scripts,
// which audits the hosted catalog). Runs validateCardScript over every script
// in tests/fixtures/test-cards.json so a schema regression or a malformed
// fixture fails fast in CI / locally.
//
//   npm run validate:fixtures
//
// Exit code 1 on any invalid script.

import { readFileSync } from 'node:fs'
import { validateCardScript } from '../lib/game/card-behavior-schema'

type Fixture = { name: string; script: unknown }

const fixtures: Fixture[] = JSON.parse(
  readFileSync(new URL('../tests/fixtures/test-cards.json', import.meta.url), 'utf8'),
)

let checked = 0
let failed = 0
for (const card of fixtures) {
  // null / {} = intentionally script-less (vanilla creatures, lands, tokens).
  if (card.script == null || (typeof card.script === 'object' && Object.keys(card.script).length === 0)) {
    continue
  }
  checked++
  const result = validateCardScript(card.script)
  if (!result.success) {
    failed++
    console.error(`INVALID (v${result.version}) ${card.name}`)
    for (const err of result.errors) console.error(`  - ${err}`)
  }
}

console.log(`${checked} scripted fixtures checked, ${failed} invalid`)
process.exit(failed > 0 ? 1 : 0)
