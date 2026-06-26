// Quick-win re-scripts (no migration — reuse already-built engine features):
//   Sanctum Seeker      → creature_attacks watcher (Vampire) drain  (mig 340)
//   Etchings of the Chosen → choose_creature_type persistent anthem (mig 337)
//   Goldlust Triad      → myriad                                    (mig 355)

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// QW1 — Sanctum Seeker drains when a Vampire (not just itself) attacks.
test('QW1 Sanctum Seeker drains on any Vampire attack', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawnCreature('A', 'Sanctum Seeker Test')
    const vamp = await s.spawnCreature('A', 'Vampire Bear Test') // a different Vampire
    const lifeA = await s.lifeOf('A')
    const lifeB = await s.lifeOf('B')

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(vamp, 'B')
    while (await s.topStackItem()) await s.as('A').resolveStack()

    assert.equal(await s.lifeOf('B'), lifeB - 1, 'opponent lost 1')
    assert.equal(await s.lifeOf('A'), lifeA + 1, 'you gained 1')
  })
})

// QW2 — Etchings of the Chosen: choosing Vampire pumps your Vampires +1/+1.
test('QW2 Etchings anthem pumps the chosen type', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const vamp = await s.spawnCreature('A', 'Vampire Bear Test') // 2/2 Vampire
    await s.spawn('A', 'Etchings Test', 'battlefield')
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'choose_creature_type')
    await s.as('A').submitDecision(d!.id, { type: 'Vampire' })

    assert.equal(await s.effectivePower(vamp), 3, 'Vampire pumped +1')
    assert.equal(await s.effectiveToughness(vamp), 3)
  })
})

// QW3 — Goldlust Triad has myriad (tested with 3 players).
test('QW3 Goldlust Triad myriad copies for the other opponent', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 3)
    const g = await s.spawnCreature('A', 'Goldlust Test')

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(g, 'B')
    while (await s.topStackItem()) await s.as('A').resolveStack()

    const toks = await s.client.query<{ id: string }>(
      `select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and gc.zone = 'battlefield' and gc.is_token = true and c.name = 'Goldlust Test'`,
      [s.sessionId])
    assert.equal(toks.rows.length, 1, 'one myriad copy for C')
  })
})
