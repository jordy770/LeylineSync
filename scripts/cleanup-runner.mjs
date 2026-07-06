// Cleanup runner — operational janitor for FINISHED games (mig 144).
//
// Finds sessions with status='finished' whose bulky runtime rows (game_cards,
// stack, effects, log, …) still linger and that finished more than --age hours
// ago, then calls cleanup_finished_session(id) for each. The RPC keeps
// game_sessions + game_session_players (winner / seats / final life), so game
// history survives. Connecting as the postgres role means auth.uid() is null,
// which the RPC treats as a service job (may clean any session).
//
// Usage:
//   node scripts/cleanup-runner.mjs                # one pass (age 24h)
//   node scripts/cleanup-runner.mjs --watch        # loop every 6h (compose service)
//   node scripts/cleanup-runner.mjs --dry-run      # report only, delete nothing
//   --age <hours>       minimum hours since finished_at (default 24)
//   --interval <hours>  watch-loop sleep (default 6)
import { Client } from 'pg'

const DEFAULT_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i]
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const WATCH = Boolean(args.watch)
const DRY_RUN = Boolean(args['dry-run'])
const AGE_HOURS = Number(args.age ?? 24)
const INTERVAL_HOURS = Number(args.interval ?? 6)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function pass(client) {
  const { rows } = await client.query(
    `select s.id, s.finished_at
     from public.game_sessions s
     where s.status = 'finished'
       and s.finished_at is not null
       and s.finished_at < now() - make_interval(hours => $1)
       and exists (select 1 from public.game_cards gc where gc.session_id = s.id)
     order by s.finished_at`,
    [AGE_HOURS],
  )
  if (rows.length === 0) {
    console.log(`[cleanup] nothing to clean (no finished sessions older than ${AGE_HOURS}h with runtime rows)`)
    return
  }
  for (const row of rows) {
    if (DRY_RUN) {
      console.log(`[cleanup] DRY RUN — would clean ${row.id} (finished ${row.finished_at.toISOString()})`)
      continue
    }
    try {
      const { rows: [res] } = await client.query('select public.cleanup_finished_session($1) as result', [row.id])
      console.log(`[cleanup] cleaned ${row.id}: ${JSON.stringify(res.result)}`)
    } catch (err) {
      console.error(`[cleanup] FAILED for ${row.id}: ${err.message}`)
    }
  }
}

const client = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? DEFAULT_URL })
await client.connect()
try {
  do {
    await pass(client)
    if (WATCH) await sleep(INTERVAL_HOURS * 3600 * 1000)
  } while (WATCH)
} finally {
  await client.end()
}
