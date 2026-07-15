// mig 408 — changeling (Mirror Entity): "is every creature type". Since ~250
// subtypes can't live in a type-line string, fire_watcher_triggers matches a
// changeling against ANY creature-type filter (a granted_type {changeling:true}
// or the catalog Changeling keyword). A changeling therefore sets off every
// tribal trigger; a plain creature only its own type's.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function life(s: Scenario, seat: 'A' | 'B'): Promise<number> {
  const r = await s.client.query(
    `select life_total from public.game_session_players where session_id = $1 and player_id = $2`,
    [s.sessionId, s.players[seat]])
  return r.rows[0].life_total
}

// CH1 — a changeling attacker triggers BOTH the Elf and the Zombie watcher
// (it counts as every creature type), gaining 2 life.
test('CH1 a changeling satisfies every tribal trigger', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const changeling = await s.spawnCreature('A', 'Changeling Test') // base Shapeshifter
    await s.spawnCreature('A', 'Elf Attack Watcher Test')
    await s.spawnCreature('A', 'Zombie Attack Watcher Test')
    await s.rebuild() // register the changeling continuous effect

    const before = await life(s, 'A')
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(changeling, 'B')
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()

    assert.equal(await life(s, 'A'), before + 2) // Elf watcher + Zombie watcher both fired
  })
})

// CH2 — a NON-changeling creature only fires the trigger for its actual type:
// a base Goblin does not set off the Elf watcher.
test('CH2 a non-changeling only triggers its own type', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const goblin = await s.spawnCreature('A', 'Goblin Raider Test') // a Goblin, not an Elf
    await s.spawnCreature('A', 'Elf Attack Watcher Test')

    const before = await life(s, 'A')
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(goblin, 'B')
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()

    assert.equal(await life(s, 'A'), before) // Elf watcher did NOT fire
  })
})
