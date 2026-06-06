// Seeds the `% Test` cards into public.cards for the local test DB.
//
// The local schema is built from a schema-only dump (see tests/README.md), so
// the card catalog is empty. These cards are normally inserted by the (archived)
// incremental migrations; here we load them from the fixture so the harness can
// reference them by name. Idempotent and committed once (outside any test's
// rolled-back transaction) so every test sees them.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { connect } from './db'

type TestCard = {
  name: string
  type_line: string | null
  oracle_text: string | null
  power_toughness: string | null
  mana_cost?: string | null
  script: unknown
}

let seeded = false

export async function ensureTestCards(): Promise<void> {
  if (seeded) return
  const fixturePath = fileURLToPath(new URL('../fixtures/test-cards.json', import.meta.url))
  const cards = JSON.parse(await readFile(fixturePath, 'utf8')) as TestCard[]

  const client = await connect()
  try {
    // `node --test` runs each test file in its OWN worker process, so this seed runs
    // concurrently across ~30 workers against the shared DB. The `where not exists`
    // guard races (many workers pass the check before any insert commits), producing
    // duplicate rows — and a duplicate name makes `... where name = ? limit 1`
    // non-deterministic (DK5 compares the importer's pick vs cardId()'s pick). A
    // transaction-scoped advisory lock serialises seeding so exactly one worker fills
    // the catalog; the rest wait, then find the rows present and insert nothing.
    await client.query('begin')
    await client.query('select pg_advisory_xact_lock(8675309)')
    for (const c of cards) {
      await client.query(
        `insert into public.cards (id, name, type_line, oracle_text, power_toughness, mana_cost, script)
         select gen_random_uuid(), $1, $2, $3, $4, $5, $6::jsonb
         where not exists (select 1 from public.cards where name = $1)`,
        [c.name, c.type_line, c.oracle_text, c.power_toughness, c.mana_cost ?? null, JSON.stringify(c.script)],
      )
    }
    await client.query('commit')
  } finally {
    await client.end()
  }
  seeded = true
}
