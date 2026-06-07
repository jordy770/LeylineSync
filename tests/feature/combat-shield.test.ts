// Phase 4 / F2.1e — creature shields in COMBAT (mig 148). resolve_combat_damage now
// routes both creature-damage sites through apply_damage_to_creature, so a "prevent
// the next N damage to my creature" shield works as a combat trick. The single
// end-of-step lethal sweep is preserved (combat passes run_sweep=false).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// A attacks B; B blocks with `blockerName`. Lands on combat_damage with A priority.
async function block(s: Scenario, attackerName: string, blockerName: string) {
  const attacker = await s.spawnCreature('A', attackerName)
  const blocker = await s.spawnCreature('B', blockerName)
  await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
  await s.as('A').declareAttacker(attacker, 'B')
  await s.setTurn({ phase: 'combat', step: 'declare_blockers', active: 'A', priority: 'B' })
  await s.as('B').declareBlocker(blocker, attacker)
  await s.setTurn({ phase: 'combat', step: 'combat_damage', active: 'A', priority: 'A' })
  return { attacker, blocker }
}

// CB1 — a prevent-all shield on the blocker stops all combat damage; it survives.
test('CB1 a prevent-all shield saves a blocker in combat', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const { blocker } = await block(s, 'Pit Brawler Test', 'Parting Gift Test') // 4/4 vs 2/2
    await s.as('B').addCreaturePrevention(blocker, null) // prevent all

    await s.as('A').resolveCombat()

    assert.equal(await s.zoneOf(blocker), 'battlefield') // would normally die to 4
    assert.equal(Number((await s.cardState(blocker)).damage_marked), 0)
  })
})

// CB2 — a numeric shield saves a blocker that would otherwise die.
test('CB2 a numeric shield saves a blocker from lethal combat damage', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const { blocker } = await block(s, 'Parting Gift Test', 'Parting Gift Test') // 2/2 vs 2/2
    await s.as('B').addCreaturePrevention(blocker, 1) // prevents 1 of the 2

    await s.as('A').resolveCombat()

    assert.equal(await s.zoneOf(blocker), 'battlefield') // 1 marked < 2 toughness
    assert.equal(Number((await s.cardState(blocker)).damage_marked), 1)
  })
})

// CB3 — a combat_only shield DOES apply in combat (contrast with the spell case).
test('CB3 a combat-only shield applies to combat damage', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const { blocker } = await block(s, 'Parting Gift Test', 'Pit Brawler Test') // 2/2 vs 4/4
    await s.as('B').addCreaturePrevention(blocker, 1, true) // combat only

    await s.as('A').resolveCombat()

    assert.equal(Number((await s.cardState(blocker)).damage_marked), 1) // 2 dealt, 1 prevented
  })
})

// CB4 — without a shield, combat is unchanged (the blocker dies). Guards the reroute.
test('CB4 unshielded combat is unchanged', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const { blocker } = await block(s, 'Pit Brawler Test', 'Parting Gift Test') // 4/4 vs 2/2

    await s.as('A').resolveCombat()

    assert.equal(await s.zoneOf(blocker), 'graveyard')
  })
})
