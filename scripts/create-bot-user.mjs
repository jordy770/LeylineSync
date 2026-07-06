// Provision a real Supabase auth user for the AI CPU bot, so it can occupy a
// seat on HOSTED (where game_cards/game_session_players FK to profiles → auth.users
// and a bare UUID is rejected). One-time per environment.
//
// Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local
// (so it targets whatever that file points at — set it to HOSTED first).
//
//   node scripts/create-bot-user.mjs [email]
//
// Prints the bot's user id (pass it to the runner as --bot <uuid>). Idempotent:
// re-running with the same email returns the existing user.

import { createClient } from '@supabase/supabase-js'
import { readFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

function loadEnv(file) {
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
loadEnv('.env')
loadEnv('.env.local')

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
const SR = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE
if (!URL || !SR) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (in .env.local).')
  process.exit(1)
}

const email = process.argv[2] ?? 'cpu-bot@leyline.internal'
// Optional display name — provision a FLEET for multi-bot games by running e.g.
//   node scripts/create-bot-user.mjs cpu-bot-2@leyline.internal "CPU 🤖 2"
// add_bot_to_session (mig 376) seats any free profile matching 'CPU 🤖%'.
const username = process.argv[3] ?? 'CPU 🤖'
const password = randomUUID()
const sb = createClient(URL, SR, { auth: { persistSession: false, autoRefreshToken: false } })

async function main() {
  console.log(`Target: ${URL}`)
  let uid
  const { data, error } = await sb.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) {
    // Already exists → look it up by listing (admin.getUserById needs an id).
    if (/already.*regist|exists/i.test(error.message)) {
      const { data: list, error: listErr } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 })
      if (listErr) throw listErr
      uid = list.users.find((u) => u.email === email)?.id
      if (!uid) throw new Error(`User ${email} reported existing but not found in listUsers.`)
      console.log('✓ bot user already existed')
    } else {
      throw error
    }
  } else {
    uid = data.user.id
    console.log('✓ created bot auth user')
  }

  // Ensure a profile row (the FK target). The signup trigger normally makes one;
  // upsert is a belt-and-suspenders for environments without it.
  const { error: profErr } = await sb.from('profiles').upsert({ id: uid, username }, { onConflict: 'id' })
  if (profErr) console.warn(`(profile upsert warning: ${profErr.message})`)

  console.log('\nBot user id:', uid)
  console.log('Run the bot against this seat with:')
  console.log(`  DATABASE_URL=<hosted direct connection string> node --import tsx scripts/bot-runner.mjs --session <session-id> --bot ${uid}`)
}

main().catch((e) => { console.error(e.message); process.exit(1) })
