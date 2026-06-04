/**
 * Audit script — validates all card scripts in the database against the Zod schema.
 *
 * Usage:
 *   npx tsx scripts/validate-card-scripts.ts
 *
 * Requires env vars (e.g. from .env.local):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   (preferred — can see all rows)
 *   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY  (fallback, anon access)
 */

import { createClient } from '@supabase/supabase-js'
import { validateCardScript } from '../lib/game/card-behavior-schema'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY

if (!url || !key) {
  console.error(
    'Missing env vars. Set NEXT_PUBLIC_SUPABASE_URL and either ' +
      'SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.',
  )
  process.exit(1)
}

const supabase = createClient(url, key)

const { data: cards, error } = await supabase
  .from('cards')
  .select('id, name, script')
  .not('script', 'is', null)

if (error) {
  console.error('Failed to fetch cards:', error.message)
  process.exit(1)
}

type Failure = { name: string; id: string; version: 1 | 2; errors: string[] }

let valid = 0
const failures: Failure[] = []

for (const card of cards ?? []) {
  const result = validateCardScript(card.script)
  if (result.success) {
    valid++
  } else {
    failures.push({
      name: card.name ?? card.id,
      id: card.id,
      version: result.version,
      errors: result.errors,
    })
  }
}

const total = valid + failures.length
console.log(`\nValidated ${total} card scripts — ${valid} valid, ${failures.length} invalid\n`)

for (const { name, id, version, errors } of failures) {
  console.log(`  FAIL  ${name}  [v${version}]`)
  console.log(`        ${id}`)
  for (const err of errors) {
    console.log(`        • ${err}`)
  }
  console.log()
}

if (failures.length > 0) {
  process.exit(1)
}

console.log('All card scripts are valid.')
