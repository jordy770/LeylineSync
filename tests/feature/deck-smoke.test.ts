// Deck smoke test: every curated script in docs/commander-decks/card-scripts.json
// is exercised at RUNTIME — the gap left after schema validation (bug-688).
//
// Coverage per card, in a fresh rolled-back transaction with a stocked board
// (creatures both sides, libraries, graveyards, a full mana pool):
//   • permanents: spawned onto the battlefield (fires registers + ETB
//     triggers), then killed (fires dies triggers)
//   • instants/sorceries: cast via the spell_effect program (X = 2, a legal
//     target supplied when any action is targeted)
//   • every parked decision is answered generically; targeted triggers get a
//     target on demand
// NOT covered: activated abilities (cost setup per ability) and step-gated
// triggers (upkeep/combat) — ETB, dies and cast resolution are the paths
// where runtime script errors have actually occurred.
//
// Card identities come from the oracle dump (type line decides spawn vs cast).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

const ROOT = join(__dirname, '..', '..')
const scripts: Record<string, unknown> = JSON.parse(
  readFileSync(join(ROOT, 'docs', 'commander-decks', 'card-scripts.json'), 'utf8'))

type OracleCard = { name: string; type_line?: string; mana_cost?: string; power?: string; toughness?: string }
const oracle = new Map<string, OracleCard>()
for (const c of JSON.parse(readFileSync(join(ROOT, 'lib', 'oracle-cards-20260531210653.json'), 'utf8')) as OracleCard[]) {
  if (!oracle.has(c.name)) oracle.set(c.name, c)
  // Adventure/split cards ("Beanstalk Giant // Fertile Footsteps"): index the
  // front face under its own name too.
  if (c.name.includes(' // ')) {
    const front = c.name.split(' // ')[0]!
    if (!oracle.has(front)) oracle.set(front, { ...c, type_line: c.type_line?.split(' // ')[0] })
  }
}

// Spells that need an opposing spell on the stack — out of scope here.
const SKIP: Record<string, string> = {
  'Arcane Denial': 'counterspell needs a spell on the stack',
  'Trial // Error': 'counterspell needs a spell on the stack',
}

before(async () => {
  await ensureTestCards()
})

type Decision = { id: string; deciding_player_id: string; decision_type: string; options: unknown; min_choices: number; max_choices: number; params: Record<string, unknown> }

async function answer(s: Scenario, d: Decision): Promise<void> {
  const opts = (Array.isArray(d.options) ? d.options : []) as Array<Record<string, unknown>>
  // Decisions belong to their DECIDING player (edicts, votes go to opponents).
  const seat = (['A', 'B', 'C', 'D'] as const).find((x) => s.players[x] === d.deciding_player_id) ?? 'A'
  const submit = (result: unknown) => s.as(seat).submitDecision(d.id, result)
  switch (d.decision_type) {
    case 'scry':
      return void (await submit({ top: opts.map((o) => o.game_card_id), bottom: [] }))
    case 'surveil':
      return void (await submit({ top: opts.map((o) => o.game_card_id), graveyard: [] }))
    case 'choose_mode': {
      // "Choose three" repeats the first mode (Fiery Confluence allows repeats).
      const n = Math.max(d.min_choices ?? 1, 1)
      return void (await submit({ chosen: Array(n).fill(0) }))
    }
    case 'choose_creature_type':
      return void (await submit({ type: (opts[0]?.type as string) ?? 'Dinosaur' }))
    case 'choose_color':
      return void (await submit({ color: 'white' }))
    case 'choose_player':
      return void (await submit({ player_id: opts[0]?.player_id }))
    case 'vote':
      return void (await submit({ value: (opts[0]?.value as string) ?? 'wild' }))
    case 'divide_damage':
      return void (await submit({
        allocations: [{ ...(opts[0]?.game_card_id ? { game_card_id: opts[0].game_card_id } : { player_id: opts[0]?.player_id }), amount: Math.max(1, Number(d.params?.amount ?? 1)) }],
      }))
    default: {
      // The choose-cards family: pick the minimum (or one, to exercise the path).
      const ids = opts.map((o) => o.game_card_id as string).filter(Boolean)
      const n = Math.max(d.min_choices ?? 0, Math.min(1, d.max_choices ?? 1, ids.length))
      return void (await submit({ chosen: ids.slice(0, Math.min(n, ids.length)) }))
    }
  }
}

async function drive(s: Scenario, victims: { theirs: string; mine: string }, label: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const d = (await s.pendingDecision()) as Decision | null
    if (d) {
      await answer(s, d)
      continue
    }
    const top = await s.topStackItem() // pending items only
    if (!top) return
    // PROACTIVE target supply: a failed resolve aborts the whole rolled-back
    // transaction (no savepoints), so targeted triggers must be detected from
    // the payload before resolving — never by catch-and-retry.
    const payload = top.payload as Record<string, any>
    const fx = (payload.effects ?? []) as Array<Record<string, any>>
    const TARGETED = new Set(['deal_damage', 'destroy', 'exile', 'bounce', 'tap', 'untap', 'add_counters',
      'grant_keyword', 'fight', 'gain_control', 'set_pt', 'pump', 'goad', 'exile_and_manifest',
      'ignition', 'exile_until_leaves', 'animate', 'shuffle_into_library'])
    // Mirror trigger_effect_target_type: only single-kind targets count —
    // mixed lists like ['creature','player'] resolve untargeted server-side.
    const singleKind = (t: unknown) =>
      typeof t === 'string' || (Array.isArray(t) && new Set(t).size === 1)
    const targetedFx = fx.find((e) => e.target_type && singleKind(e.target_type) && TARGETED.has(e.type as string))
    if (top.action_type === 'triggered_ability' && targetedFx
        && !payload.target_card_id && !payload.target_card_ids) {
      await s.as('A').chooseTriggerTarget(
        top.id, targetedFx.target_controller === 'you' ? victims.mine : victims.theirs)
      continue
    }
    try {
      await s.as('A').resolveStack()
    } catch (e) {
      throw new Error(`${label}: ${String(e)}`)
    }
  }
  throw new Error(`${label}: did not settle within 30 rounds`)
}

const entries = Object.entries(scripts).filter(([name]) => !name.startsWith('_') && !(name in SKIP))

test(`smoke: all ${entries.length} curated scripts run at ETB/dies/cast time`, async (t) => {
  for (const [name, script] of entries) {
    await t.test(name, async () => {
      const info = oracle.get(name)
      assert.ok(info, `${name}: not in the oracle dump`)
      const typeLine = info!.type_line ?? 'Artifact'
      const pt = info!.power && info!.toughness ? `${info!.power}/${info!.toughness}`.replace(/\*/g, '0') : null

      await withRolledBackTx(async (client) => {
        const s = await Scenario.create(client)
        await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
        // A stocked board so options exist for most picks.
        const mine = await s.spawnCreature('A', 'Dino Grunt Test')
        const theirs = await s.spawnCreature('B', 'Air Elemental Test')
        for (let i = 0; i < 3; i++) await s.spawn('A', 'Wastes Test', 'library')
        for (let i = 0; i < 3; i++) await s.spawn('B', 'Wastes Test', 'library')
        await s.spawn('A', 'Forest Test', 'battlefield')
        const corpse = await s.spawnCreature('A', 'Myr Retriever Test')
        await s.putInGraveyard(corpse)
        await drive(s, { theirs, mine }, `${name} (board prep)`)
        await s.setMana('A', { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 })

        // Register the card under test inside this transaction only.
        await client.query(
          `insert into public.cards (id, name, type_line, oracle_text, power_toughness, mana_cost, is_token, script)
           values (gen_random_uuid(), $1, $2, null, $3, $4, false, $5::jsonb)`,
          [name, typeLine, pt, info!.mana_cost ?? null, JSON.stringify(script)])

        const isSpell = /Instant|Sorcery/.test(typeLine) && !/Land|Creature|Artifact|Enchantment|Planeswalker/.test(typeLine)
        if (isSpell) {
          const actions = ((script as Record<string, any>).spell_effect?.actions ?? []) as Array<Record<string, unknown>>
          if (actions.length === 0) return // cycling-only or inert spells
          const targeted = actions.find((a) => a.target_type)
          const usesX = JSON.stringify(actions).includes('"X"')
          const target = targeted
            ? (targeted.target_controller === 'you' ? mine : theirs)
            : undefined
          await s.as('A').castSpellEffect(actions, null, usesX ? 2 : null, target)
          await drive(s, { theirs, mine }, `${name} (cast)`)
        } else {
          const id = await s.spawn('A', name, 'battlefield')
          await drive(s, { theirs, mine }, `${name} (enters)`)
          await s.putInGraveyard(id)
          await drive(s, { theirs, mine }, `${name} (dies)`)
        }
      })
    })
  }
})
