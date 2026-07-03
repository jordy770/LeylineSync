// Orthion, Hero of Lavabrink (mig 348). Copy a creature you control from an
// ACTIVATED ability (now routed through the spell_effect resolver) with a count
// (5 copies for the big ability). Each copy gets haste + end-step cleanup
// (reusing mig 347). "Activate only as a sorcery" timing is not enforced.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function copies(s: Scenario): Promise<number> {
  const r = await s.client.query<{ n: string }>(
    `select count(*)::int as n from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.zone = 'battlefield' and gc.is_token = true and c.name = 'Vampire Bear Test'`,
    [s.sessionId])
  return Number(r.rows[0].n)
}

// OR1 — the {1}{R} ability copies a creature you control once, with haste.
test('OR1 the small ability makes one hasty copy', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const orthion = await s.spawnCreature('A', 'Orthion Test')
    const bear = await s.spawnCreature('A', 'Vampire Bear Test')
    await s.setMana('A', { R: 1, C: 1 }) // {1}{R}

    await s.as('A').activate(orthion, 0)
    await s.as('A').resolveStack() // parks the copy pick
    const d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'copy_permanent')
    await s.as('A').submitDecision(d!.id, { chosen: [bear] })

    assert.equal(await copies(s), 1, 'one copy')
  })
})

// OR2 — the big ability makes five copies.
test('OR2 the big ability makes five copies', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const orthion = await s.spawnCreature('A', 'Orthion Test')
    const bear = await s.spawnCreature('A', 'Vampire Bear Test')
    await s.setMana('A', { R: 3, C: 6 }) // {6}{R}{R}{R}

    await s.as('A').activate(orthion, 1)
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { chosen: [bear] })

    assert.equal(await copies(s), 5, 'five copies')
  })
})
