// Heraldic Banner (mig 209) — "As this artifact enters, choose a color.
// Creatures you control of the chosen color get +1/+0. {T}: Add one mana of the
// chosen color." choose_color parks the pick; the colour-filtered anthem
// (payload.color in the mass-pump fold) is registered against the banner and
// goes inert when it leaves the battlefield.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// HB1 — the chosen colour's creatures (yours only) get +1/+0.
test('HB1 chosen-colour anthem buffs only your creatures of that colour', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const redMine = await s.spawnCreature('A', 'Goblin Raider Test') // {R} → red
    const colorless = await s.spawnCreature('A', 'Grave Shambler Test') // no cost
    const redTheirs = await s.spawnCreature('B', 'Goblin Raider Test')

    const banner = await s.spawn('A', 'Heraldic Banner Test', 'battlefield')
    await s.as('A').resolveStack() // ETB trigger → parks choose_color
    const d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'choose_color')
    await s.as('A').submitDecision(d!.id, { color: 'red' })

    assert.equal(await s.effectivePower(redMine), 3) // 2 +1
    assert.equal(await s.effectiveToughness(redMine), 2) // +0
    assert.equal(await s.effectivePower(colorless), 2) // wrong colour
    assert.equal(await s.effectivePower(redTheirs), 2) // not yours

    // The anthem dies with the banner.
    await s.client.query('select public.put_in_graveyard($1, $2)', [s.sessionId, banner])
    assert.equal(await s.effectivePower(redMine), 2)
  })
})
