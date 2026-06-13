// mig 236 — three cards:
//   • Glorybringer — exert: declaring it as an attacker with exert deals 4 to a
//     target opposing creature, and it won't untap on your next untap step.
//   • Nogi, Draco-Zealot — attacks while you control 3+ Dragons → becomes 5/5
//     with flying until end of turn (the type change to Dragon is cosmetic/TBD).
//   • Steel Hellkite — firebreathing {2}: +1/+0 (the X-destroy is deferred).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function hasFlying(s: Scenario, id: string): Promise<boolean> {
  // Query the effect row directly (card_has_flying is auth-gated; the harness
  // client runs as postgres with no auth.uid()).
  const r = await s.client.query<{ f: boolean }>(
    `select exists (select 1 from public.game_continuous_effects
       where session_id = $1 and affected_card_id = $2 and effect_type = 'flying') as f`,
    [s.sessionId, id])
  return r.rows[0]!.f
}

// EX1 — Glorybringer exerts: 4 damage to a chosen opposing creature.
test('EX1 Glorybringer exerts to deal 4 to an opposing creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    const glory = await s.spawnCreature('A', 'Glorybringer Test')
    const victim = await s.spawnCreature('B', 'Air Elemental Test') // 4/4

    await s.as('A').declareAttacker(glory, 'B', true) // exert
    const trig = await s.topStackItem()
    assert.equal(trig?.payload?.target_required, true)
    await s.as('A').chooseTriggerTarget(trig!.id, victim)
    await s.resolveStack()

    assert.equal((await s.cardState(victim)).zone, 'graveyard') // 4 >= 4 toughness
  })
})

// EX2 — an exerted creature does not untap on its controller's next untap step.
test('EX2 an exerted attacker stays tapped through its next untap', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A', turnNumber: 1 })
    const glory = await s.spawnCreature('A', 'Glorybringer Test')
    const victim = await s.spawnCreature('B', 'Air Elemental Test')
    await s.as('A').declareAttacker(glory, 'B', true)
    const trig = await s.topStackItem()
    await s.as('A').chooseTriggerTarget(trig!.id, victim)
    await s.resolveStack()

    assert.equal((await s.cardState(glory)).is_tapped, true) // tapped from attacking
    // A's next untap step: exerted → stays tapped, then the marker clears.
    await s.setTurn({ phase: 'beginning', step: 'untap', active: 'A', priority: 'A', turnNumber: 3 })
    await s.as('A').advanceStep()
    assert.equal((await s.cardState(glory)).is_tapped, true)
  })
})

// EX3 — Nogi transforms into a 5/5 flyer while you control three or more Dragons.
test('EX3 Nogi becomes a 5/5 flyer with three Dragons', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    const nogi = await s.spawnCreature('A', 'Nogi Test')
    for (let i = 0; i < 3; i++) await s.spawnCreature('A', 'Dragon Token') // three Dragons

    await s.as('A').declareAttacker(nogi, 'B')
    await s.resolveStack() // attacks trigger → conditional transform

    assert.equal(await s.effectivePower(nogi), 5)
    assert.equal(await s.effectiveToughness(nogi), 5)
    assert.equal(await hasFlying(s, nogi), true)
  })
})

// EX4 — Steel Hellkite firebreathes for +1/+0.
test('EX4 Steel Hellkite pumps itself +1/+0', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const steel = await s.spawnCreature('A', 'Steel Hellkite Test') // 5/5
    await s.setMana('A', { C: 2 })
    await s.as('A').activate(steel, 0, { targetCardId: steel })
    await s.resolveStack()
    assert.equal(await s.effectivePower(steel), 6)
  })
})
