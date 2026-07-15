// mig 410 — Imprisoned in the Moon: an Aura that turns the enchanted permanent
// into a colorless land with "{T}: Add {C}" and strips its other types and
// abilities. Uses the type-changing layer's granted_type override (mig 407),
// a strip flag folded by effective_script, a granted mana ability (mig 357),
// and the combat gates now reading effective_type_line.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function effType(s: Scenario, id: string): Promise<string> {
  const r = await s.client.query('select public.effective_type_line($1,$2) as t', [s.sessionId, id])
  return r.rows[0].t
}

// IM1 — the enchanted creature becomes a Land and cannot attack.
test('IM1 an imprisoned creature is a land and cannot attack', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const victim = await s.spawnCreature('A', 'Air Elemental Test') // 4/4 flier
    const aura = await s.spawn('A', 'Imprisoned Aura Test', 'hand')
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { U: 1, C: 2 })
    await s.as('A').castPermanent(aura, { target: victim })
    await s.as('A').resolveStack() // Aura attaches; granted effects register

    assert.match(await effType(s, victim), /Land/)
    assert.doesNotMatch(await effType(s, victim), /Creature/)

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await assert.rejects(s.as('A').declareAttacker(victim, 'B'), /Only creatures can be declared as attackers/)
  })
})

// IM2 — the imprisoned permanent taps for {C} (its granted ability) and has
// lost its own abilities (the base flying is gone from its effective script).
test('IM2 an imprisoned permanent taps for C and loses its own abilities', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const victim = await s.spawnCreature('A', 'Air Elemental Test')
    const aura = await s.spawn('A', 'Imprisoned Aura Test', 'hand')
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { U: 1, C: 2 })
    await s.as('A').castPermanent(aura, { target: victim })
    await s.as('A').resolveStack()

    const pool = await s.as('A').activateMana(victim, 0)
    assert.equal(pool.C, 1)

    // Its effective script is blanked to just the granted mana ability.
    const r = await s.client.query('select public.effective_script($1,$2) as sc', [s.sessionId, victim])
    const script = r.rows[0].sc as { activated_abilities?: unknown[]; continuous_effects?: unknown[] }
    assert.equal(script.activated_abilities?.length, 1) // only the granted {T}: Add {C}
    assert.ok(!script.continuous_effects || script.continuous_effects.length === 0) // base flying stripped
  })
})

// IM3 — an imprisoned creature cannot block either.
test('IM3 an imprisoned creature cannot block', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const victim = await s.spawnCreature('B', 'Air Elemental Test')
    const attacker = await s.spawnCreature('A', 'Air Elemental Test')
    const aura = await s.spawn('A', 'Imprisoned Aura Test', 'hand')
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { U: 1, C: 2 })
    await s.as('A').castPermanent(aura, { target: victim })
    await s.as('A').resolveStack()

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(attacker, 'B')
    await s.setTurn({ phase: 'combat', step: 'declare_blockers', active: 'A', priority: 'B' })
    await assert.rejects(s.as('B').declareBlocker(victim, attacker), /can|creature/i)
  })
})
