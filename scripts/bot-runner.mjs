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
// Play decisions come from the pure heuristic brain (lib/game/bot-brain.ts). This
// runner is just the I/O shell: it snapshots state, asks the brain, executes the
// answer via RPCs. Because it imports a .ts module, run it through tsx:
//
// ── Usage ────────────────────────────────────────────────────────────────────
//   node --import tsx scripts/bot-runner.mjs --watch
//     Drives EVERY CPU seat (added via the lobby's "Add CPU" button) across all
//     your local games. Leave it running; add/remove CPUs from the app freely.
//
//   node --import tsx scripts/bot-runner.mjs --session <id>
//     Manual mode: seat one bot in a specific session + play it (no lobby button).
//
//   Options: --interval <ms> (poll cadence, default 1500)

import { Client } from 'pg'
import { shouldMulligan, chooseBottom, decideMainPlays, decideAttacks, decideBlocks } from '../lib/game/bot-brain.ts'

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
// A real auth-user id for the bot (required on HOSTED, where a bare UUID fails the
// profiles/auth FK). Provision one with scripts/create-bot-user.mjs. Omitted →
// local bare-UUID seating via add_bot_to_session (relaxed FKs only).
const BOT_ID = typeof args.bot === 'string' ? args.bot : null
const INTERVAL = Number(args.interval ?? 1500)

if (!WATCH && !SESSION) {
  console.error('Usage: node --import tsx scripts/bot-runner.mjs --watch   (or --session <id>)')
  process.exit(1)
}

const client = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? DEFAULT_URL })

// Priority bounces back to a bot many times within one step, so each "play once
// per X" action is fenced: `did(action, session, bot, scope)` returns true the
// first time and false thereafter for that scope (e.g. a turn number + step).
const doneOnce = new Set()
function did(action, session, bot, scope) {
  const key = `${session}:${bot}:${action}:${scope}`
  if (doneOnce.has(key)) return false
  doneOnce.add(key)
  return true
}

// Parse the engine's effective power/toughness (numeric/text) to a safe integer.
const pt = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

// Combat keyword columns for a game_cards row `gc`, against session $1. Folded
// into the brain's Creature.keywords so attack/block heuristics see evasion,
// menace, trample, deathtouch and strike order — not just raw P/T.
const KEYWORD_COLS = `
  public.card_has_flying($1, gc.id) as flying,
  public.card_has_reach($1, gc.id) as reach,
  public.card_has_trample($1, gc.id) as trample,
  public.card_has_menace($1, gc.id) as menace,
  public.card_has_deathtouch($1, gc.id) as deathtouch,
  public.card_has_first_strike($1, gc.id) as first_strike,
  public.card_has_double_strike($1, gc.id) as double_strike`

const toCreature = (r) => ({
  id: r.id,
  power: pt(r.power),
  toughness: pt(r.toughness),
  keywords: {
    flying: r.flying, reach: r.reach, trample: r.trample, menace: r.menace,
    deathtouch: r.deathtouch, firstStrike: r.first_strike, doubleStrike: r.double_strike,
  },
})

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
    `select gc.id, c.type_line, public.mana_value(c.mana_cost) as cmc
     from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.owner_id = $2 and gc.zone = 'hand' order by gc.zone_position`,
    [session, bot],
  )
  // REAL mana the brain may spend (untapped lands the bot already controls), so it
  // sequences on-curve instead of dumping. The runner still cheats the actual
  // payment below (topUpMana), but the *choice* respects this budget.
  const untappedLands = (await q(
    `select count(*)::int as n from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.owner_id = $2 and gc.zone = 'battlefield'
       and c.type_line ilike '%land%' and gc.is_tapped = false`,
    [session, bot],
  ))[0].n
  const canPlayLand = (turn.lands_played_this_turn ?? 0) < (turn.land_play_limit ?? 1)

  // Commander in the command zone, with its CURRENT cost incl. the {2}-per-prior-cast
  // tax — so the brain weighs it against real mana like any other spell.
  const cmdr = (await q(
    `select gc.id, public.mana_value(c.mana_cost) + 2 * coalesce(gc.command_zone_casts, 0) as cost
     from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.owner_id = $2 and gc.zone = 'command' and gc.is_commander = true
     limit 1`,
    [session, bot],
  ))[0]

  const plan = decideMainPlays(
    hand.map((c) => ({ id: c.id, typeLine: c.type_line ?? '', manaValue: c.cmc })),
    untappedLands,
    canPlayLand,
    cmdr ? { id: cmdr.id, manaValue: Number(cmdr.cost) } : null,
  )

  if (plan.playLandId) {
    try { await rpc(bot, 'cast_card_from_hand', { p_session_id: session, p_game_card_id: plan.playLandId }); console.log('  ↳ played a land') }
    catch (e) { console.warn(`  ⚠ land play failed: ${e.message}`) }
  }

  await topUpMana(session, bot)
  if (plan.castCommanderId) {
    try { await rpc(bot, 'cast_commander', { p_session_id: session, p_game_card_id: plan.castCommanderId }); console.log('  ↳ cast its commander') }
    catch (e) { console.warn(`  ⚠ commander cast failed: ${e.message}`) }
  }
  for (const id of plan.castIds) {
    try { await rpc(bot, 'cast_card_from_hand', { p_session_id: session, p_game_card_id: id }); console.log('  ↳ cast a spell') }
    catch (e) { console.warn(`  ⚠ cast failed: ${e.message}`) }
  }
}

async function declareAttacks(session, bot, turn) {
  const opp = (await q('select player_id, life_total from public.game_session_players where session_id = $1 and player_id <> $2 order by seat_number limit 1', [session, bot]))[0]
  if (!opp) return
  // Eligible attackers: untapped, not-summoning-sick (entered a prior turn —
  // mirrors the engine's declare_attacker check; mig 314 stamps entered on cast).
  const eligible = await q(
    `select gc.id,
            public.card_effective_power($1, gc.id) as power,
            public.card_effective_toughness($1, gc.id) as toughness,${KEYWORD_COLS}
     from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.owner_id = $2 and gc.zone = 'battlefield'
       and c.type_line ilike '%creature%' and gc.is_tapped = false
       and gc.entered_battlefield_turn_number is not null
       and gc.entered_battlefield_turn_number < $3`,
    [session, bot, turn.turn_number],
  )
  // Potential blockers: the opponent's untapped creatures (summoning-sick ones can
  // still block, so no entered-turn filter here).
  const oppBlockers = await q(
    `select gc.id,
            public.card_effective_power($1, gc.id) as power,
            public.card_effective_toughness($1, gc.id) as toughness,${KEYWORD_COLS}
     from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and coalesce(gc.controller_player_id, gc.owner_id) = $2
       and gc.zone = 'battlefield' and c.type_line ilike '%creature%' and gc.is_tapped = false`,
    [session, opp.player_id],
  )
  // Our own life — lets the brain hold back defensive reserves against a lethal swing-back.
  const myLife = pt((await q('select life_total from public.game_session_players where session_id = $1 and player_id = $2', [session, bot]))[0]?.life_total)

  const chosen = decideAttacks(
    eligible.map(toCreature),
    oppBlockers.map(toCreature),
    pt(opp.life_total),
    { myLife },
  )
  let declared = 0
  for (const id of chosen) {
    try { await rpc(bot, 'declare_attacker', { p_session_id: session, p_attacker_card_id: id, p_defending_player_id: opp.player_id }); declared += 1 }
    catch (e) { console.warn(`  ⚠ declare_attacker failed: ${e.message}`) }
  }
  if (declared) console.log(`  ↳ attacking with ${declared}/${eligible.length}`)
}

async function declareBlocks(session, bot, turn) {
  // Attackers swinging at this bot this turn.
  const attackers = await q(
    `select ca.attacker_card_id as id,
            public.card_effective_power($1, ca.attacker_card_id) as power,
            public.card_effective_toughness($1, ca.attacker_card_id) as toughness,
            public.card_has_flying($1, ca.attacker_card_id) as flying,
            public.card_has_reach($1, ca.attacker_card_id) as reach,
            public.card_has_trample($1, ca.attacker_card_id) as trample,
            public.card_has_menace($1, ca.attacker_card_id) as menace,
            public.card_has_deathtouch($1, ca.attacker_card_id) as deathtouch,
            public.card_has_first_strike($1, ca.attacker_card_id) as first_strike,
            public.card_has_double_strike($1, ca.attacker_card_id) as double_strike
     from public.game_combat_assignments ca
     where ca.session_id = $1 and ca.turn_number = $2 and ca.defending_player_id = $3`,
    [session, turn.turn_number, bot],
  )
  if (attackers.length === 0) return
  // My untapped creatures not already committed to a block this turn.
  const blockers = await q(
    `select gc.id,
            public.card_effective_power($1, gc.id) as power,
            public.card_effective_toughness($1, gc.id) as toughness,${KEYWORD_COLS}
     from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and coalesce(gc.controller_player_id, gc.owner_id) = $2
       and gc.zone = 'battlefield' and c.type_line ilike '%creature%' and gc.is_tapped = false
       and gc.id not in (select blocker_card_id from public.game_combat_blockers where session_id = $1 and turn_number = $3)`,
    [session, bot, turn.turn_number],
  )
  const myLife = pt((await q('select life_total from public.game_session_players where session_id = $1 and player_id = $2', [session, bot]))[0]?.life_total)

  const assign = decideBlocks(
    attackers.map(toCreature),
    blockers.map(toCreature),
    myLife,
  )
  let blocked = 0
  for (const [blockerId, attackerId] of Object.entries(assign)) {
    try { await rpc(bot, 'declare_blocker', { p_session_id: session, p_blocker_card_id: blockerId, p_attacker_card_id: attackerId }); blocked += 1 }
    catch (e) { console.warn(`  ⚠ declare_blocker failed: ${e.message}`) }
  }
  if (blocked) console.log(`  ↳ blocking with ${blocked}`)
}

// When the bot is the ACTIVE player in the combat damage step it must call
// resolve_combat_damage itself — advance_step does NOT auto-resolve damage
// (bug-601), so without this an attacking bot deals no combat damage and nothing
// dies. Call up to twice to cover the first-strike → regular two-pass flow.
async function resolveCombatDamage(session, bot) {
  for (let pass = 0; pass < 2; pass++) {
    let res
    try {
      res = await rpc(bot, 'resolve_combat_damage', { p_session_id: session, p_assignments: null })
    } catch (e) {
      console.warn(`  ⚠ resolve_combat_damage failed: ${e.message}`)
      return
    }
    if (!res || res.damage_stage !== 'first_strike') break // regular pass done
  }
  console.log('  ↳ resolved combat damage')
}

// Opening hand: the brain decides keep vs mulligan; on a keep it chooses which
// cards to bottom (London = one per mulligan; Commander's first mulligan is free).
async function resolveMulligan(session, bot, mulligans) {
  const hand = await q(
    `select gc.id, c.type_line, public.mana_value(c.mana_cost) as cmc
     from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.owner_id = $2 and gc.zone = 'hand'`,
    [session, bot],
  )
  if (shouldMulligan(hand.map((h) => h.type_line ?? ''), mulligans)) {
    try { await rpc(bot, 'mulligan_hand', { p_session_id: session }); console.log(`↻ CPU mulligans (had ${mulligans})`) }
    catch (e) { console.warn(`⚠ mulligan_hand: ${e.message}`) }
    return
  }
  const format = (await q('select format from public.game_sessions where id = $1', [session]))[0]?.format
  const required = format === 'commander' ? Math.max(mulligans - 1, 0) : mulligans
  const bottom = chooseBottom(hand.map((h) => ({ id: h.id, typeLine: h.type_line ?? '', manaValue: h.cmc })), required)
  try { await rpc(bot, 'keep_opening_hand', { p_session_id: session, p_bottom_card_ids: bottom }); console.log(`✓ CPU kept opening hand (bottomed ${bottom.length})`) }
  catch (e) { console.warn(`⚠ keep_opening_hand: ${e.message}`) }
}

/** One decision step for a single bot in a started ('locked') session. */
async function tick(session, bot) {
  const sp = (await q('select opening_hand_kept, mulligans from public.game_session_players where session_id = $1 and player_id = $2', [session, bot]))[0]
  if (sp && sp.opening_hand_kept === false) {
    await resolveMulligan(session, bot, sp.mulligans ?? 0)
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
    if (did('main', session, bot, `${turn.turn_number}:${turn.step}`)) await playMainPhase(session, bot, turn)
  } else if (myTurn && turn.step === 'declare_attackers') {
    if (did('attack', session, bot, turn.turn_number)) await declareAttacks(session, bot, turn)
  } else if (myTurn && turn.step === 'combat_damage') {
    // Bot is attacking — it must resolve its own combat damage (see helper).
    if (did('damage', session, bot, turn.turn_number)) await resolveCombatDamage(session, bot)
  } else if (!myTurn && turn.step === 'declare_blockers') {
    if (did('block', session, bot, turn.turn_number)) await declareBlocks(session, bot, turn)
  }

  try { await rpc(bot, 'pass_priority', { p_session_id: session }) }
  catch (e) { /* lost a race to the server / state moved on */ void e }
}

// ── Manual mode (--session): seat + deck a bot, then play it. ──────────────────
async function setupManualBot(session) {
  if (BOT_ID) return seatRealBot(session, BOT_ID)
  // LOCAL only: bare-UUID seat via add_bot_to_session (needs relaxed FKs). The RPC
  // requires the caller to be a session member, so we impersonate the creator.
  const s = (await q('select status from public.game_sessions where id = $1', [session]))[0]
  if (!s) throw new Error(`Session ${session} not found (is the dev server on LOCAL Supabase?)`)
  if (s.status !== 'open') throw new Error(`Session is '${s.status}', not 'open' — add the bot before starting.`)
  const creator = (await q('select player_id from public.game_session_players where session_id = $1 order by seat_number limit 1', [session]))[0]?.player_id
  if (!creator) throw new Error('No players in the session yet — create/join it in the app first.')
  const bot = await rpc(creator, 'add_bot_to_session', { p_session_id: session })
  console.log(`✓ seated CPU ${bot} in session ${session}`)
  return bot
}

// HOSTED-capable: seat a REAL bot auth user (FKs pass) by joining normally,
// spawning a vanilla deck it owns, and flagging the seat is_bot. Idempotent.
async function seatRealBot(session, bot) {
  const s = (await q('select status from public.game_sessions where id = $1', [session]))[0]
  if (!s) throw new Error(`Session ${session} not found.`)

  const seated = await q('select 1 from public.game_session_players where session_id = $1 and player_id = $2', [session, bot])
  if (seated.length === 0) {
    if (s.status !== 'open') throw new Error(`Session is '${s.status}', not 'open' — add the bot before starting.`)
    await rpc(bot, 'join_game_session', { p_session_id: session })
    console.log(`✓ bot ${bot} joined ${session}`)
  }

  const hasDeck = await q('select 1 from public.game_cards where session_id = $1 and owner_id = $2 limit 1', [session, bot])
  if (hasDeck.length === 0) {
    const { land, creature } = await pickDeckCards()
    const list = [...Array(22).fill(land), ...Array(18).fill(creature)]
    const deck = (await q(
      `insert into public.decks (owner_id, name, list_data, created_by) values ($1, 'CPU Vanilla', $2::jsonb, $1) returning id`,
      [bot, JSON.stringify(list)],
    ))[0]
    await rpc(bot, 'spawn_deck_for_session', { p_session_id: session, p_deck_id: deck.id, p_enforce_legality: false })
    console.log(`✓ spawned bot deck (${list.length} cards)`)
  }

  // Flag the seat + let the server chain its empty passes.
  await client.query('update public.game_session_players set is_bot = true where session_id = $1 and player_id = $2', [session, bot])
  await rpc(bot, 'set_autopass_settings', { p_session_id: session, p_settings: JSON.stringify({ op: true, own: true }) })
  console.log(`✓ CPU (real user ${bot.slice(0, 8)}) ready in ${session}`)
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
