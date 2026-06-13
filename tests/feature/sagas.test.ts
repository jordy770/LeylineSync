// Saga subsystem (mig 305, Summon: Good King Mog XII): a lore counter is added on
// ETB (chapter I) and after each draw step (II, III, IV); each chapter's effects
// resolve as its number is reached; the saga is sacrificed after the final
// chapter. Chapters II/III ("whenever you cast a noncreature spell this turn,
// copy a token") are a no-op here — delayed-trigger grants aren't modelled.
//
// Saga Test: I — create two 1/2 Moogle tokens; IV — +2/+2 to each other Moogle.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function moogles(client: Awaited<ReturnType<typeof Scenario.create>>['client'], session: string) {
  const r = await client.query(
    `select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and c.name = 'Moogle Token' and gc.zone = 'battlefield'`,
    [session],
  )
  return r.rows.map((x) => x.id as string)
}

// SAGA1 — chapter I on ETB makes two Moogle tokens; the saga has 1 lore counter.
test('SAGA1 chapter I creates two Moogle tokens on enter', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const saga = await s.spawn('A', 'Saga Test', 'battlefield') // ETB advance_saga
    await s.as('A').resolveStack()

    assert.equal((await moogles(client, s.sessionId)).length, 2)
    const lore = await client.query("select counters ->> 'lore' l from public.game_cards where id=$1", [saga])
    assert.equal(lore.rows[0].l, '1')
  })
})

// SAGA2 — advancing through draw steps reaches chapter IV (+2/+2 to other
// Moogles) and then the saga is sacrificed.
test('SAGA2 reaching chapter IV pumps the Moogles and sacrifices the saga', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const saga = await s.spawn('A', 'Saga Test', 'battlefield')
    await s.as('A').resolveStack() // chapter I, lore 1

    // Three draw steps -> lore 2, 3, 4. The step must change each time to re-fire.
    for (let i = 0; i < 3; i++) {
      await s.setTurn({ phase: 'beginning', step: 'draw', active: 'A', priority: 'A' })
      await s.as('A').resolveStack()
      await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    }

    const ms = await moogles(client, s.sessionId)
    assert.equal(ms.length, 2)
    assert.equal(await s.effectivePower(ms[0]), 3)              // 1/2 + two +1/+1
    assert.equal((await s.cardState(saga)).zone, 'graveyard')   // sacrificed after IV
  })
})
