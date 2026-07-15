// mig 409 — changeling / granted types now flow through the tribal ANTHEM P/T
// fold (card_layered_power/toughness) and the sacrifice-cost filter
// (activate_ability), via the reusable card_has_creature_type. A changeling
// gets a lord's bonus and can pay "sacrifice a Vampire or Zombie".

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function pt(s: Scenario, id: string): Promise<[number, number]> {
  const r = await s.client.query(
    'select public.card_layered_power($1,$2)::int as p, public.card_layered_toughness($1,$2)::int as t',
    [s.sessionId, id])
  return [r.rows[0].p, r.rows[0].t]
}

// AN1 — a Zombie lord pumps a changeling (it counts as a Zombie) but not a
// plain Goblin.
test('AN1 a tribal anthem pumps a changeling', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawnCreature('A', 'Zombie King Test') // Zombies you control get +1/+1
    const changeling = await s.spawnCreature('A', 'Changeling Test') // base 2/2
    const goblin = await s.spawnCreature('A', 'Goblin Raider Test') // base 2/2, not a Zombie
    await s.rebuild()

    assert.deepEqual(await pt(s, changeling), [3, 3]) // 2/2 + anthem
    assert.deepEqual(await pt(s, goblin), [2, 2]) // untouched
  })
})

// SC1 — a changeling can pay a "sacrifice another Vampire or Zombie" cost.
test('SC1 a changeling satisfies a tribal sacrifice cost', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const butcher = await s.spawnCreature('A', 'Tribal Butcher Test') // {sac another Vampire/Zombie}: +2/+2
    const changeling = await s.spawnCreature('A', 'Changeling Test')
    await s.rebuild()

    await s.as('A').activate(butcher, 0, { targetCardId: changeling })
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(changeling), 'graveyard') // accepted as a Zombie and sacrificed
    const r = await s.client.query('select plus_one_counters from public.game_cards where id = $1', [butcher])
    assert.equal(r.rows[0].plus_one_counters, 2)
  })
})
