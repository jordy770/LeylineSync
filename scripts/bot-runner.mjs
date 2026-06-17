// AI CPU opponent — a LOCAL test bot that plays a seat so a solo human can run a
// full game. It talks to the LOCAL Supabase Postgres over a direct `pg`
// connection (same trick as tests/harness/db.ts): the rules RPCs gate on
// auth.uid(), which we satisfy by setting request.jwt.claims on the connection.
// Each gameplay call runs in its own committed transaction so it PERSISTS.
//
// It is a TEST bot, not a fair AI: it tops up its own mana pool directly so it
// can cast without solving colour-correct auto-tapping, and it plays a vanilla
// deck (basic land + a cheap script-free creature) so it almost never raises a
// blocking decision.
//
// ── Prerequisites ────────────────────────────────────────────────────────────
//   1. Local Supabase running (supabase start) on :54322.
//   2. The app's dev server pointed at LOCAL Supabase (not hosted), logged in
//      locally — so your browser seat lives in the same database.
//
// ── Usage ────────────────────────────────────────────────────────────────────
//   node scripts/bot-runner.mjs --watch
//     Drives EVERY CPU seat (added via the lobby's "Add CPU" button) across all
//     your local games. Leave it running; add/remove CPUs from the app freely.
//
//   node scripts/bot-runner.mjs --session <id>
//     Manual mode: seat one bot in a specific session + play it (no lobby button).
//
//   Options: --interval <ms> (poll cadence, default 1500)

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
const SESSION = typeof args.session === 'string' ? args.session : null
const INTERVAL = Number(args.interval ?? 1500)

if (!WATCH && !SESSION) {
  console.error('Usage: node scripts/bot-runner.mjs --watch   (or --session <id>)')
  process.exit(1)
}

const client = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? DEFAULT_URL })

// Last "turn:step" each bot developed in, keyed by `${session}:${bot}`, so a bot
// plays each main phase only once (priority bounces back repeatedly otherwise).
const lastMainKey = new Map()

/** Plain read as the postgres session role (RLS bypassed) — used for polling. */
async function q(sql, params = []) {
  return (await client.query(sql, params)).rows
}

/** Run an RPC AS `bot`, in its own committed transaction (persists). */
function rpc(bot, name, params = {}) {
  return (async () => {
    await client.query('begin')
    try {
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: bot, role: 'authenticated' })])
      await client.query('set local role authenticated')
      const keys = Object.keys(params)
      const sql = `select * from public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`
      const res = await client.query(sql, keys.map((k) => params[k]))
      await client.query('commit')
      if (res.rows.length === 1) {
        const row = res.rows[0]
        const cols = Object.keys(row)
        return cols.length === 1 && cols[0] === name ? row[cols[0]] : row
      }
      return res.rows
    } catch (e) {
      try { await client.query('rollback') } catch { /* tx already aborted */ }
      throw e
    }
  })()
}

// ── Decision auto-resolver: submit a safe, legal result so the game never stalls.
function decisionResult(d) {
  const options = Array.isArray(d.options) ? d.options : []
  const ids = options.map((o) => o.option_id ?? o.id ?? o.game_card_id ?? o.card_id).filter(Boolean)
  const min = d.min_choices ?? 0
  switch (d.decision_type) {
    case 'scry': return { top: ids, bottom: [] }
    case 'surveil': return { graveyard: [], top: ids }
    case 'choose_mode': return { chosen: Array.from({ length: Math.max(1, min) }, (_, i) => i) }
    case 'choose_player': return { player_id: options[0]?.player_id ?? ids[0] }
    case 'choose_color': return { color: options[0]?.color ?? 'W' }
    case 'choose_creature_type': return { type: options[0]?.type ?? 'Human' }
    case 'confirm': return { confirmed: false }
    default: return { chosen: ids.slice(0, min) }
  }
}

async function resolveDecisions(session, bot) {
  const decisions = await q(
    `select id, decision_type, options, min_choices, max_choices from public.game_pending_decisions
     where session_id = $1 and deciding_player_id = $2 and status = 'pending'`,
    [session, bot],
  )
  for (const d of decisions) {
    try {
      await rpc(bot, 'submit_decision', { p_decision_id: d.id, p_result: JSON.stringify(decisionResult(d)) })
      console.log(`  ↳ resolved decision ${d.decision_type}`)
    } catch (e) {
      console.warn(`  ⚠ could not auto-resolve decision '${d.decision_type}' — needs a handler. ${e.message}`)
    }
  }
}

async function topUpMana(session, bot) {
  await client.query(
    `insert into public.game_players (session_id, player_id, mana_pool) values ($1, $2, $3::jsonb)
     on conflict (session_id, player_id) do update set mana_pool = excluded.mana_pool`,
    [session, bot, JSON.stringify({ W: 20, U: 20, B: 20, R: 20, G: 20, C: 20 })],
  )
}

async function playMainPhase(session, bot, turn) {
  const hand = await q(
    `select gc.id, c.type_line from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.owner_id = $2 and gc.zone = 'hand' order by gc.zone_position`,
    [session, bot],
  )
  const isLand = (t) => (t.type_line ?? '').toLowerCase().includes('land')
  const isCreature = (t) => (t.type_line ?? '').toLowerCase().includes('creature') && !isLand(t)

  if ((turn.lands_played_this_turn ?? 0) < (turn.land_play_limit ?? 1)) {
    const land = hand.find(isLand)
    if (land) {
      try { await rpc(bot, 'cast_card_from_hand', { p_session_id: session, p_game_card_id: land.id }); console.log('  ↳ played a land') }
      catch (e) { console.warn(`  ⚠ land play failed: ${e.message}`) }
    }
  }

  await topUpMana(session, bot)
  for (const c of hand.filter(isCreature).slice(0, 2)) {
    try { await rpc(bot, 'cast_card_from_hand', { p_session_id: session, p_game_card_id: c.id }); console.log('  ↳ cast a creature') }
    catch (e) { console.warn(`  ⚠ cast failed: ${e.message}`) }
  }
}

async function declareAttacks(session, bot, turn) {
  const opp = (await q('select player_id from public.game_session_players where session_id = $1 and player_id <> $2 order by seat_number limit 1', [session, bot]))[0]
  if (!opp) return
  // Untapped, not-summoning-sick creatures (entered a prior turn). Mirrors the
  // engine's declare_attacker check (mig 314 stamps entered on cast).
  const attackers = await q(
    `select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.owner_id = $2 and gc.zone = 'battlefield'
       and c.type_line ilike '%creature%' and gc.is_tapped = false
       and gc.entered_battlefield_turn_number is not null
       and gc.entered_battlefield_turn_number < $3`,
    [session, bot, turn.turn_number],
  )
  let declared = 0
  for (const a of attackers) {
    try { await rpc(bot, 'declare_attacker', { p_session_id: session, p_attacker_card_id: a.id, p_defending_player_id: opp.player_id }); declared += 1 }
    catch (e) { console.warn(`  ⚠ declare_attacker failed: ${e.message}`) }
  }
  if (declared) console.log(`  ↳ attacking with ${declared}`)
}

/** One decision step for a single bot in a started ('locked') session. */
async function tick(session, bot) {
  // Opening hand — keep all 7.
  const sp = (await q('select opening_hand_kept from public.game_session_players where session_id = $1 and player_id = $2', [session, bot]))[0]
  if (sp && sp.opening_hand_kept === false) {
    try { await rpc(bot, 'keep_opening_hand', { p_session_id: session, p_bottom_card_ids: [] }); console.log('✓ CPU kept opening hand') }
    catch (e) { console.warn(`⚠ keep_opening_hand: ${e.message}`) }
    return
  }

  // A pending decision the bot owns would hard-stall the game — resolve first.
  await resolveDecisions(session, bot)

  // land_play_limit isn't a column on game_turn_state (it's computed) — playMainPhase
  // defaults it to 1, which is right for the bot's vanilla deck.
  const turn = (await q(
    `select active_player_id, priority_player_id, step, turn_number, lands_played_this_turn
     from public.game_turn_state where session_id = $1`, [session],
  ))[0]
  if (!turn || turn.priority_player_id !== bot) return

  const myTurn = turn.active_player_id === bot
  const stackEmpty = (await q(`select 1 from public.game_stack_items where session_id = $1 and status = 'pending' limit 1`, [session])).length === 0

  if (myTurn && stackEmpty && (turn.step === 'precombat_main' || turn.step === 'postcombat_main')) {
    const key = `${turn.turn_number}:${turn.step}`
    const mapKey = `${session}:${bot}`
    if (lastMainKey.get(mapKey) !== key) { lastMainKey.set(mapKey, key); await playMainPhase(session, bot, turn) }
  } else if (myTurn && turn.step === 'declare_attackers') {
    await declareAttacks(session, bot, turn)
  }

  try { await rpc(bot, 'pass_priority', { p_session_id: session }) }
  catch (e) { /* lost a race to the server / state moved on */ void e }
}

// ── Manual mode (--session): seat + deck a fresh bot, then play it. ────────────
async function setupManualBot(session) {
  const s = (await q('select status from public.game_sessions where id = $1', [session]))[0]
  if (!s) throw new Error(`Session ${session} not found (is the dev server on LOCAL Supabase?)`)
  if (s.status !== 'open') throw new Error(`Session is '${s.status}', not 'open' — add the bot before starting.`)
  // add_bot_to_session requires the caller to be a session member, so we
  // impersonate the session creator (seat 1) to seat the bot.
  const creator = (await q('select player_id from public.game_session_players where session_id = $1 order by seat_number limit 1', [session]))[0]?.player_id
  if (!creator) throw new Error('No players in the session yet — create/join it in the app first.')
  const bot = await rpc(creator, 'add_bot_to_session', { p_session_id: session })
  console.log(`✓ seated CPU ${bot} in session ${session}`)
  return bot
}

async function main() {
  await client.connect()
  let stop = false
  process.on('SIGINT', () => { stop = true })

  if (SESSION) {
    const bot = await setupManualBot(SESSION).catch((e) => { console.error(e.message); process.exit(1) })
    console.log('CPU ready. Start the game from the app lobby.  (Ctrl-C to stop)')
    while (!stop) {
      const st = (await q('select status from public.game_sessions where id = $1', [SESSION]))[0]?.status
      if (st === 'finished' || !st) { console.log('Game over — stopping.'); break }
      if (st === 'locked') { try { await tick(SESSION, bot) } catch (e) { console.warn(`tick: ${e.message}`) } }
      await new Promise((r) => setTimeout(r, INTERVAL))
    }
  } else {
    console.log('Watching for CPU seats in your local games…  (Ctrl-C to stop)')
    const seen = new Set()
    while (!stop) {
      try {
        const bots = await q(
          `select gsp.session_id, gsp.player_id from public.game_session_players gsp
           join public.game_sessions s on s.id = gsp.session_id
           where gsp.is_bot = true and s.status = 'locked'`,
        )
        for (const b of bots) {
          const tag = `${b.session_id}:${b.player_id}`
          if (!seen.has(tag)) { seen.add(tag); console.log(`▶ driving CPU ${b.player_id.slice(0, 8)} in session ${b.session_id.slice(0, 8)}`) }
          try { await tick(b.session_id, b.player_id) } catch (e) { console.warn(`tick ${tag.slice(0, 17)}: ${e.message}`) }
        }
      } catch (e) {
        console.warn(`watch error: ${e.message}`)
      }
      await new Promise((r) => setTimeout(r, INTERVAL))
    }
  }
  await client.end()
}

main().catch((e) => { console.error(e); process.exit(1) })
