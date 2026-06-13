// Emet-Selch (mig 304): "Spells you cast from your graveyard cost {2} less."
// A cost_reduction continuous effect with payload.from_zone='graveyard' — applies
// only when the card being cast is in the graveyard. (His lose-life recast
// trigger is not modelled.)

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function reduced(client: Awaited<ReturnType<typeof Scenario.create>>['client'], session: string, caster: string, cardId: string, cost: string) {
  const r = await client.query('select public.reduced_mana_cost($1,$2,$3,$4) c', [session, caster, cardId, cost])
  return r.rows[0].c as string
}

// EMET1 — a graveyard card's cost is reduced by {2}; a hand card's is not.
test('EMET1 graveyard casts cost {2} less, hand casts unchanged', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawnCreature('A', 'Emet Test')
    const gyCard = await s.spawn('A', 'Air Elemental Test', 'graveyard')
    const handCard = await s.spawn('A', 'Air Elemental Test', 'hand')

    assert.equal(await reduced(client, s.sessionId, s.players.A, gyCard, '{4}{B}'), '{2}{B}')   // -2 from graveyard
    assert.equal(await reduced(client, s.sessionId, s.players.A, handCard, '{4}{B}'), '{4}{B}') // hand: no reduction
  })
})
