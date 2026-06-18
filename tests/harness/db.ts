// Low-level DB access for the rules-engine test harness.
//
// The harness talks to a LOCAL Supabase Postgres over a direct `pg` connection
// (NOT supabase-js). This is required because the rules-engine RPCs gate on
// `auth.uid()`, and the only way to satisfy that off a raw connection is to set
// `request.jwt.claims` on the *same* connection before calling the RPC — which
// PostgREST/supabase-js cannot do. A direct connection also lets every test run
// inside a transaction that is rolled back at the end, giving free isolation
// (no `supabase db reset` between tests).
//
// auth.uid() in Supabase resolves from `request.jwt.claims ->> 'sub'`. We set
// that GUC (transaction-local) and switch to the `authenticated` role around
// each RPC call, then reset to the session role (postgres) so assertions read
// tables with RLS bypassed.

import { Client } from 'pg'

// Tests run against their OWN database (`leyline_test`), NOT the play DB
// (`postgres`, what the Supabase API/app uses) — so running the suite never wipes
// the catalog/decks/games you play with. Override with TEST_DATABASE_URL only.
const DEFAULT_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/leyline_test'

export function connectionString(): string {
  return process.env.TEST_DATABASE_URL ?? DEFAULT_URL
}

export async function connect(): Promise<Client> {
  const client = new Client({ connectionString: connectionString() })
  await client.connect()
  return client
}

/**
 * Run `fn` inside a transaction and ALWAYS roll back, so a test leaves no trace.
 * A single dedicated Client is used so `set local` and the data stay consistent.
 */
export async function withRolledBackTx<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await connect()
  try {
    await client.query('begin')
    return await fn(client)
  } finally {
    try {
      await client.query('rollback')
    } finally {
      await client.end()
    }
  }
}

/**
 * Execute `fn` with `auth.uid()` resolving to `playerId` (role = authenticated),
 * then restore the postgres session role + clear the claim. Use for any RPC that
 * checks auth/session membership.
 */
export async function asPlayer<T>(
  client: Client,
  playerId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: playerId, role: 'authenticated' }),
  ])
  await client.query('set local role authenticated')
  try {
    return await fn()
  } finally {
    // Cleanup must not mask the real error: if fn() failed, the tx may be
    // aborted, and these statements would throw 25P02 and replace the original.
    try {
      await client.query('reset role')
      await client.query(`select set_config('request.jwt.claims', '', true)`)
    } catch {
      // ignore — the caller's transaction is being rolled back anyway
    }
  }
}

/** Call a Postgres function and return the single scalar/row result. */
export async function rpc<T = unknown>(
  client: Client,
  fnName: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const names = Object.keys(args)
  const params = names.map((_, i) => `$${i + 1}`)
  const named = names.map((n, i) => `${n} => ${params[i]}`)
  const values = names.map((n) => args[n])
  const sql = `select * from public.${fnName}(${named.join(', ')})`
  const res = await client.query(sql, values)
  // Most rules RPCs return a single row (or a scalar in a one-column row).
  if (res.rows.length === 1) {
    const row = res.rows[0] as Record<string, unknown>
    const keys = Object.keys(row)
    if (keys.length === 1 && keys[0] === fnName) {
      return row[keys[0]] as T // scalar-returning function
    }
    return row as T
  }
  return res.rows as unknown as T
}
