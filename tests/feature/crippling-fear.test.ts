// Crippling Fear (mig 179) — "Choose a creature type. Each creature that isn't of
// the chosen type gets -3/-3 until end of turn." A choose_creature_type wrapping a
// `pump_all` (a temporary mass P/T pump with a type EXCLUSION). The chosen type is
// injected into the pump's creature_type; the debuff hits every non-matching
// creature regardless of controller, and a -3/-3 can be lethal.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

const CF_ACTIONS = [
  { type: 'choose_creature_type', effects: [{ type: 'pump_all', power: -3, toughness: -3, scope: 'all', exclude_type: true }] },
]

// CF1 — non-chosen-type creatures get -3/-3 (any controller); the chosen type is
// unaffected; a 2/2 dropped to -1/-1 dies.
test('CF1 debuffs every creature that is not the chosen type', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const myZombie = await s.spawnCreature('A', 'Grave Shambler Test') // 2/2 Zombie
    const myBig = await s.spawnCreature('A', 'Air Elemental Test') // 4/4 Elemental (non-Zombie)
    const theirSmall = await s.spawnCreature('B', 'Goblin Raider Test') // 2/2 Goblin (non-Zombie)

    await s.as('A').castSpellEffect(CF_ACTIONS)
    await s.as('A').resolveStack()
    const decision = await s.pendingDecision()
    assert.equal(decision?.decision_type, 'choose_creature_type')
    await s.as('A').submitDecision(decision!.id, { type: 'Zombie' })

    // The Zombie is the chosen type → unaffected.
    assert.equal(await s.effectivePower(myZombie), 2)
    assert.equal(await s.effectiveToughness(myZombie), 2)
    // The 4/4 non-Zombie gets -3/-3 → 1/1 and survives.
    assert.equal(await s.effectivePower(myBig), 1)
    assert.equal(await s.effectiveToughness(myBig), 1)
    // The opponent's 2/2 non-Zombie drops to -1/-1 → dies.
    assert.equal(await s.zoneOf(theirSmall), 'graveyard')
  })
})

// CF2 — the debuff is "until end of turn": it carries the end-of-turn expiry, so
// the existing cleanup sweep removes it (shared with other until-EOT pumps).
test('CF2 the mass debuff is registered as until-end-of-turn', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Air Elemental Test')

    await s.as('A').castSpellEffect(CF_ACTIONS)
    await s.as('A').resolveStack()
    const decision = await s.pendingDecision()
    await s.as('A').submitDecision(decision!.id, { type: 'Zombie' })

    const eff = await s.client.query<{ expires_at_phase: string; expires_at_step: string }>(
      `select expires_at_phase, expires_at_step from public.game_continuous_effects
       where session_id = $1 and effect_type = 'pump' and affected_card_id is null`,
      [s.sessionId],
    )
    assert.equal(eff.rows[0]?.expires_at_phase, 'ending')
    assert.equal(eff.rows[0]?.expires_at_step, 'cleanup')
  })
})
