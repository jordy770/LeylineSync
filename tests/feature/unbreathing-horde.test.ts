// Unbreathing Horde (mig 210) — "Enters with a +1/+1 counter for each other
// Zombie you control and each Zombie card in your graveyard. If it would be
// dealt damage, prevent that damage and remove a +1/+1 counter from it."
// Dynamic enters_with_counters (array of count specs summed) + the
// damage_removes_counters replacement in apply_damage_to_creature.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function counters(s: Scenario, id: string): Promise<number> {
  const r = await s.client.query<{ n: number }>(
    'select plus_one_counters as n from public.game_cards where id = $1', [id])
  return Number(r.rows[0]!.n)
}

// UH1 — counts other battlefield Zombies + graveyard Zombie cards (not itself,
// not other types, not opponents').
test('UH1 enters with a counter per other Zombie and graveyard Zombie', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Grave Shambler Test') // Zombie on battlefield
    await s.spawnCreature('A', 'Goblin Raider Test') // not a Zombie
    await s.spawn('A', 'Grave Shambler Test', 'graveyard') // Zombie card in GY
    await s.spawn('A', 'Goblin Raider Test', 'graveyard') // ignored
    await s.spawnCreature('B', 'Grave Shambler Test') // opponent's — ignored

    const horde = await s.spawnCreature('A', 'Unbreathing Horde Test')
    assert.equal(await counters(s, horde), 2) // 1 battlefield + 1 graveyard
    assert.equal(await s.effectivePower(horde), 2) // 0/0 + 2 counters
  })
})

// UH2 — damage is prevented; one counter is removed per damage event.
test('UH2 damage removes a counter instead', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Grave Shambler Test')
    await s.spawn('A', 'Grave Shambler Test', 'graveyard')
    const horde = await s.spawnCreature('A', 'Unbreathing Horde Test') // 2 counters

    await s.as('A').putOnStack('deal_damage_creature', { target_card_id: horde, amount: 5, target_controller: 'any' })
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(horde), 'battlefield') // survived 5 damage
    assert.equal(await counters(s, horde), 1) // one counter gone, regardless of amount
    const dmg = await s.client.query<{ d: number }>(
      'select damage_marked as d from public.game_cards where id = $1', [horde])
    assert.equal(Number(dmg.rows[0]!.d), 0) // nothing marked
  })
})

// UH3 — losing the last counter leaves a 0/0: the SBA finishes it.
test('UH3 the last counter falls and the 0/0 dies', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Grave Shambler Test', 'graveyard')
    const horde = await s.spawnCreature('A', 'Unbreathing Horde Test') // 1 counter
    assert.equal(await counters(s, horde), 1)

    await s.as('A').putOnStack('deal_damage_creature', { target_card_id: horde, amount: 1, target_controller: 'any' })
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(horde), 'graveyard') // 0/0 swept
  })
})
