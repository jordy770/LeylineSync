// One-off: copy your HOSTED decks into the LOCAL Supabase so they're selectable
// for solo CPU-bot testing. Card ids are remapped hosted→local via oracle_id
// (the dedup import may keep a different printing locally), and the decks are
// inserted as shared precons (owner null, is_precon=true) so they show in the
// lobby's "Precons" group for any local login.
//
// Run AFTER `npm run import:cards` has populated the local catalog:
//   HOSTED_SUPABASE_URL=https://<ref>.supabase.co \
//   HOSTED_SERVICE_ROLE_KEY=<hosted service role> \
//   node scripts/copy-decks-to-local.mjs
//
// (LOCAL pg defaults to 127.0.0.1:54322; override with DATABASE_URL.)

import pg from 'pg'

const HOSTED_URL = process.env.HOSTED_SUPABASE_URL
const SR = process.env.HOSTED_SERVICE_ROLE_KEY
const LOCAL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
if (!HOSTED_URL || !SR) {
  console.error('Set HOSTED_SUPABASE_URL and HOSTED_SERVICE_ROLE_KEY env vars.')
  process.exit(1)
}

async function rest(path) {
  const res = await fetch(`${HOSTED_URL}${path}`, { headers: { apikey: SR, Authorization: `Bearer ${SR}` } })
  if (!res.ok) throw new Error(`hosted ${path} -> ${res.status} ${await res.text()}`)
  return res.json()
}
const uniq = (a) => [...new Set(a)]
const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n))

async function main() {
  const c = new pg.Client({ connectionString: LOCAL })
  await c.connect()
  try {
    // 1. All hosted decks (user-owned + any).
    const decks = await rest(`/rest/v1/decks?select=id,name,list_data,commander_card_id`)
    console.log(`hosted decks: ${decks.length}`)

    // 2. Every referenced card id.
    const cardIds = uniq(decks.flatMap((d) => [
      ...(Array.isArray(d.list_data) ? d.list_data : []),
      ...(d.commander_card_id ? [d.commander_card_id] : []),
    ]).filter(Boolean))

    // 3. hosted id -> oracle_id (batched GETs).
    const idToOracle = new Map()
    for (const batch of chunk(cardIds, 60)) {
      const rows = await rest(`/rest/v1/cards?id=in.(${batch.join(',')})&select=id,oracle_id`)
      for (const r of rows) idToOracle.set(r.id, r.oracle_id)
    }

    // 4. oracle_id -> local card id.
    const oracleIds = uniq([...idToOracle.values()].filter(Boolean))
    const localRows = (await c.query('select id, oracle_id from public.cards where oracle_id = any($1)', [oracleIds])).rows
    const oracleToLocal = new Map(localRows.map((r) => [r.oracle_id, r.id]))
    const remap = (hostedId) => {
      const o = idToOracle.get(hostedId)
      return o ? oracleToLocal.get(o) ?? null : null
    }

    // 5. Insert each deck locally as a shared precon, remapped.
    let copied = 0
    for (const d of decks) {
      const src = Array.isArray(d.list_data) ? d.list_data : []
      const localList = src.map(remap).filter(Boolean)
      const dropped = src.length - localList.length
      const cmd = d.commander_card_id ? remap(d.commander_card_id) : null
      if (localList.length === 0) { console.warn(`  skip "${d.name}" — no cards resolved locally`); continue }
      // Skip if a precon with this name already exists locally (idempotent re-run).
      const exists = (await c.query(`select 1 from public.decks where name = $1 and is_precon = true`, [d.name])).rows.length
      if (exists) { console.log(`  exists, skip "${d.name}"`); continue }
      await c.query(
        `insert into public.decks (owner_id, name, list_data, commander_card_id, is_precon, created_by)
         values (null, $1, $2::jsonb, $3, true, null)`,
        [d.name, JSON.stringify(localList), cmd],
      )
      copied += 1
      console.log(`  copied "${d.name}" — ${localList.length} cards${dropped ? ` (${dropped} unresolved, dropped)` : ''}${cmd ? ' + commander' : ''}`)
    }
    console.log(`\nDone. Copied ${copied} deck(s) as local shared precons.`)
  } finally {
    await c.end()
  }
}
main().catch((e) => { console.error(e.message); process.exit(1) })
