// tap_self effect action (mig 335). "Tap it" taps the SOURCE permanent — the
// missing piece for Immersturm Predator's "Sacrifice another creature: this
// gains indestructible until end of turn. Tap it." Tapping via tap_self also
// fires the becomes_tapped event (AFTER-UPDATE is_tapped trigger), so the
// fixture's own "whenever this becomes tapped, put a +1/+1 counter on it"
// trigger fires off the self-tap.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// TS1 — sacrifice a creature → the source gains indestructible AND taps itself.
test('TS1 tap_self taps the source after the sacrifice ability', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const predator = await s.spawnCreature('A', 'Immersturm Test')
    const victim = await s.spawnCreature('A', 'Grave Shambler Test')

    assert.equal((await s.cardState(predator)).is_tapped, false)
    assert.equal(await s.continuousEffectCount(predator, 'indestructible'), 0)

    await s.as('A').activate(predator, 0, { targetCardId: victim })
    assert.equal(await s.zoneOf(victim), 'graveyard') // sacrificed as a cost

    await s.as('A').resolveStack() // the [grant_keyword, tap_self] program resolves

    const st = await s.cardState(predator)
    assert.equal(st.is_tapped, true, 'tap_self tapped the source')
    assert.equal(await s.continuousEffectCount(predator, 'indestructible'), 1, 'gained indestructible')
  })
})

// TS2 — tapping via tap_self fires becomes_tapped: the fixture's own trigger
// ("whenever this becomes tapped, put a +1/+1 counter on it") fires.
test('TS2 tap_self fires the becomes_tapped event', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const predator = await s.spawnCreature('A', 'Immersturm Test')
    const victim = await s.spawnCreature('A', 'Grave Shambler Test')

    assert.equal((await s.cardState(predator)).plus_one_counters, 0)

    await s.as('A').activate(predator, 0, { targetCardId: victim })
    await s.as('A').resolveStack() // ability resolves → tap_self → becomes_tapped
    await s.as('A').resolveStack() // the becomes_tapped trigger resolves

    assert.equal((await s.cardState(predator)).plus_one_counters, 1, 'becomes_tapped added a +1/+1 counter')
  })
})
