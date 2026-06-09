// Intimidate + hexproof enforcement (mig 195).
//   Intimidate — a {U}{B} attacker can be blocked only by artifact creatures or
//     creatures sharing blue/black; an off-colour non-artifact blocker is illegal.
//   Hexproof — an opponent can't target the creature; its controller still can.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function setUpAttack(s: Scenario, attacker: string) {
  await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
  await s.as('A').declareAttacker(attacker, 'B')
  await s.setTurn({ phase: 'combat', step: 'declare_blockers', active: 'A', priority: 'B' })
}

// IN1 — a blocker sharing a colour (blue) with the intimidate attacker is legal.
test('IN1 a colour-sharing blocker may block an intimidator', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const attacker = await s.spawnCreature('A', 'Intimidator Test') // {U}{B}
    const blocker = await s.spawnCreature('B', 'Blue Wall Test') // shares blue
    await s.as('A').rebuild()
    await setUpAttack(s, attacker)
    await s.as('B').declareBlocker(blocker, attacker) // allowed
  })
})

// IN2 — an off-colour, non-artifact blocker (red) cannot block an intimidator.
test('IN2 an off-colour non-artifact blocker is rejected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const attacker = await s.spawnCreature('A', 'Intimidator Test')
    const blocker = await s.spawnCreature('B', 'Red Wall Test') // no shared colour
    await s.as('A').rebuild()
    await setUpAttack(s, attacker)
    await assert.rejects(() => s.as('B').declareBlocker(blocker, attacker), /intimidating/)
  })
})

// IN3 — an artifact creature may always block an intimidator.
test('IN3 an artifact creature may block an intimidator', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const attacker = await s.spawnCreature('A', 'Intimidator Test')
    const blocker = await s.spawnCreature('B', 'Artifact Wall Test') // artifact
    await s.as('A').rebuild()
    await setUpAttack(s, attacker)
    await s.as('B').declareBlocker(blocker, attacker) // allowed
  })
})

// HX1 — an opponent's targeted ability can't target a hexproof creature.
test('HX1 an opponent cannot target a hexproof creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bear = await s.spawnCreature('A', 'Hexproof Bear Test')
    const exec = await s.spawn('B', 'Executioner Test', 'battlefield') // {T}: destroy target creature
    await s.as('A').rebuild()
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'B' })

    await assert.rejects(() => s.as('B').activate(exec, 0, { targetCardId: bear }), /hexproof/)
  })
})

// HX2 — the controller can still target their own hexproof creature.
test('HX2 the controller may target their own hexproof creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bear = await s.spawnCreature('A', 'Hexproof Bear Test')
    const exec = await s.spawn('A', 'Executioner Test', 'battlefield')
    await s.as('A').rebuild()

    await s.as('A').activate(exec, 0, { targetCardId: bear }) // allowed (own permanent)
    await s.as('A').resolveStack()
    assert.equal(await s.zoneOf(bear), 'graveyard')
  })
})
