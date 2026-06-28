// Flameshadow Conjuring (mig 352). "Whenever a nontoken creature you control
// enters, you may pay {R}: create a token copy of that creature with haste, exile
// it at the next end step." The may now preserves the triggering creature through
// its program path (params.triggering_card_id), so the reflexive
// copy_permanent target:'triggering_creature' still has its subject after the may.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function copyCount(s: Scenario): Promise<number> {
  const r = await s.client.query<{ n: string }>(
    `select count(*)::int as n from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.zone = 'battlefield' and gc.is_token = true and c.name = 'Vampire Bear Test'`,
    [s.sessionId])
  return Number(r.rows[0].n)
}

// FC1 — paying {R} copies the creature that entered (with haste).
test('FC1 paying the cost copies the entering creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Flameshadow Test', 'battlefield')
    await s.setMana('A', { R: 1 })

    await s.spawnCreature('A', 'Vampire Bear Test') // a nontoken creature enters
    await s.as('A').resolveStack() // parks the may (pay {R}?)
    const d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'confirm')
    await s.as('A').submitDecision(d!.id, { confirmed: true }) // pay {R} → enqueue the copy
    while (await s.topStackItem()) await s.as('A').resolveStack()

    assert.equal(await copyCount(s), 1, 'a copy of the entering creature was made')
  })
})

// FC2 — declining makes no copy.
test('FC2 declining the cost makes no copy', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Flameshadow Test', 'battlefield')
    await s.setMana('A', { R: 1 })

    await s.spawnCreature('A', 'Vampire Bear Test')
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { confirmed: false })

    assert.equal(await copyCount(s), 0, 'no copy when declined')
  })
})
