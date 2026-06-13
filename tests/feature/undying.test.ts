// Undying (mig 219) — "When this creature dies, if it had no +1/+1 counters on
// it, return it to the battlefield under its owner's control with a +1/+1
// counter on it." Handled in put_in_graveyard: the death completes (dies
// triggers + tally fire), then the card returns with one counter. With a
// counter already on it, death is final.

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

// UN1 — counterless death: it comes back with one +1/+1 counter, and the ETB
// fires again (Geralf's Mindcrusher re-parks its mill choice).
test('UN1 a counterless undying creature returns with a counter', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const crusher = await s.spawnCreature('A', "Geralf's Mindcrusher Test")
    // Resolve the spawn ETB (choose_player mill) so the stack is clean.
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { player_id: s.playerId('B') })

    await s.as('A').putOnStack('destroy_creature', { target_card_id: crusher, target_controller: 'any' })
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(crusher), 'battlefield') // it came back
    assert.equal(await counters(s, crusher), 1) // with one counter

    // The undying return is a fresh ETB: the mill trigger re-enqueued.
    const item = await s.topStackItem()
    assert.equal(item?.action_type, 'triggered_ability')
  })
})

// UN2 — with a counter on it, the death is final.
test('UN2 a countered undying creature stays dead', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const crusher = await s.spawnCreature('A', "Geralf's Mindcrusher Test")
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { player_id: s.playerId('B') })
    await s.client.query(
      'update public.game_cards set plus_one_counters = 1 where id = $1', [crusher])

    await s.as('A').putOnStack('destroy_creature', { target_card_id: crusher, target_controller: 'any' })
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(crusher), 'graveyard') // final
  })
})
