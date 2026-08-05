// Bucket-3 rest (mig 436) —
// - recipient_filter {poison_at_least} (Feed the Infection / Phyrexian Atlas):
//   "each opponent WHO HAS three or more poison counters" filters the
//   each_opponent recipients per player instead of gating on the table max.
// - corrupted_summons (Geth's Summons): per corrupted opponent a stack-less
//   pick over THAT player's graveyard creatures; the chosen card enters the
//   battlefield under the caster's control.
// - goad_all (Geode Rager): choose_player + goad_all goads every creature the
//   chosen player controls, with the SOURCE's controller as the goader.
// - destroy_up_to required:true (Fiery Confluence's third mode): the parked
//   destroy pick demands exactly one choice instead of being declinable.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

import type { Client } from 'pg'

async function setPoison(client: Client, s: Scenario, seat: 'B' | 'C', amount: number) {
  await client.query(
    `update public.game_session_players
     set counters = coalesce(counters, '{}'::jsonb) || jsonb_build_object('poison', $3::int)
     where session_id = $1 and player_id = $2`,
    [s.sessionId, s.playerId(seat), amount],
  )
}

// CG1 — only the poisoned opponent loses life.
test('CG1 recipient_filter poison_at_least drains only corrupted opponents', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 3)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Corrupted Drain Test', 'hand')
    await setPoison(client, s, 'B', 3)
    const lifeB = await s.lifeOf('B')
    const lifeC = await s.lifeOf('C')
    await s.setMana('A', { B: 1, C: 3 })

    await s.as('A').castSpellEffect([{ type: 'lose_life', amount: 3, recipient: 'each_opponent', recipient_filter: { poison_at_least: 3 } }], spell)
    await s.as('A').resolveStack()

    assert.equal(await s.lifeOf('B'), lifeB - 3)
    assert.equal(await s.lifeOf('C'), lifeC) // 0 poison — unaffected
  })
})

// CG2 — one pick per corrupted opponent, over THAT player's graveyard, and the
// chosen creature enters under the caster's control.
test('CG2 corrupted_summons reanimates from the corrupted opponent graveyard', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 3)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Corrupted Summons Test', 'hand')
    const bCreature = await s.spawn('B', 'Air Elemental Test', 'graveyard')
    const cCreature = await s.spawn('C', 'Goblin Raider Test', 'graveyard')
    await setPoison(client, s, 'B', 4)
    await s.setMana('A', { B: 2, C: 2 })

    await s.as('A').castSpellEffect([{ type: 'corrupted_summons' }], spell)
    await s.as('A').resolveStack()

    assert.equal(await s.pendingCount(), 0) // stack is done; picks are stack-less
    const decision = await s.pendingDecision()
    assert.ok(decision, 'one pick for the single corrupted opponent')
    assert.equal(decision.decision_type, 'corrupted_summons_pick')
    const offered = (decision.options as Array<{ game_card_id: string }>).map((o) => o.game_card_id)
    assert.deepEqual(offered, [bCreature]) // B's graveyard only

    await s.as('A').submitDecision(decision.id, { chosen: [bCreature] })
    assert.equal(await s.zoneOf(bCreature), 'battlefield')
    const state = await s.cardState(bCreature)
    assert.equal(state.controller_player_id, s.playerId('A')) // under caster's control
    assert.equal(await s.zoneOf(cCreature), 'graveyard') // C not corrupted
  })
})

// CG3 — goad_all goads every creature the chosen player controls, with the
// source's controller as goader.
test('CG3 goad_all goads each creature the chosen player controls', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 3)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const rager = await s.spawn('A', 'Goad Field Test', 'battlefield')
    const own = await s.spawn('A', 'Goblin Raider Test', 'battlefield')
    const b1 = await s.spawn('B', 'Air Elemental Test', 'battlefield')
    const b2 = await s.spawn('B', 'Goblin Raider Test', 'battlefield')

    await s.as('A').fireTriggers('A', rager, ['end_step'])
    await s.as('A').resolveStack()
    const decision = await s.pendingDecision()
    assert.equal(decision?.decision_type, 'choose_player')
    await s.as('A').submitDecision(decision!.id, { player_id: s.playerId('B') })

    const goadedCount = async (cardId: string) => {
      const { rows } = await client.query<{ n: string }>(
        `select count(*) as n from public.game_continuous_effects
         where session_id = $1 and affected_card_id = $2 and effect_type = 'goaded'`,
        [s.sessionId, cardId],
      )
      return Number(rows[0]?.n ?? 0)
    }
    assert.equal(await goadedCount(b1), 1)
    assert.equal(await goadedCount(b2), 1)
    assert.equal(await goadedCount(own), 0)
    const { rows } = await client.query<{ payload: { goaded_by: string } }>(
      `select payload from public.game_continuous_effects
       where session_id = $1 and affected_card_id = $2 and effect_type = 'goaded'`,
      [s.sessionId, b1],
    )
    assert.equal(rows[0]?.payload?.goaded_by, s.playerId('A')) // goader = source's controller
  })
})

// CG4a — a required destroy pick refuses an empty choice. (Separate test from
// the happy path: a rejected RPC aborts the shared rolled-back transaction.)
test('CG4a destroy_up_to required refuses an empty pick', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Confluence Destroy Test', 'hand')
    await s.spawn('B', 'Dimir Signet Test', 'battlefield')
    await s.setMana('A', { R: 1, C: 1 })

    await s.as('A').castSpellEffect([{ type: 'destroy_up_to', count: 1, required: true, target_filter: { controller: 'any', type_line: 'artifact' } }], spell)
    await s.as('A').resolveStack()
    const decision = await s.pendingDecision()
    assert.equal(decision?.decision_type, 'destroy_pick')
    assert.equal(decision?.min_choices, 1)

    await assert.rejects(() => s.as('A').submitDecision(decision!.id, { chosen: [] }), /between/i)
  })
})

// CG4b — ...and destroys the picked artifact on a proper choice.
test('CG4b destroy_up_to required destroys the picked artifact', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Confluence Destroy Test', 'hand')
    const artifact = await s.spawn('B', 'Dimir Signet Test', 'battlefield')
    await s.setMana('A', { R: 1, C: 1 })

    await s.as('A').castSpellEffect([{ type: 'destroy_up_to', count: 1, required: true, target_filter: { controller: 'any', type_line: 'artifact' } }], spell)
    await s.as('A').resolveStack()
    const decision = await s.pendingDecision()
    assert.ok(decision)

    await s.as('A').submitDecision(decision.id, { chosen: [artifact] })
    assert.equal(await s.zoneOf(artifact), 'graveyard')
  })
})
