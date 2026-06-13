// Sublime Epiphany (mig 306): "choose one or more" via choose_up_to. The chosen
// modes splice into the program and run through the full resolver, so a targeted
// mode (return target nonland permanent to hand) parks its own pick. The two
// counter modes (counter spell / counter ability) are not modelled.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// SUB1 — choosing the bounce mode returns the targeted permanent to hand.
test('SUB1 Sublime Epiphany bounce mode returns a permanent to hand', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const epi = await s.spawn('A', 'Epiphany Test', 'hand')
    const victim = await s.spawnCreature('B', 'Air Elemental Test')

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { U: 2, C: 3 })

    await s.as('A').castSpellEffect(
      [{ type: 'choose_one', choose: 1, choose_up_to: 3, modes: [
        { label: 'Bounce', actions: [{ type: 'bounce_up_to', count: 1, target_filter: { nonland: true } }] },
        { label: 'Copy', actions: [{ type: 'copy_permanent', target_filter: { controller: 'you', type_line: 'Creature' } }] },
        { label: 'Draw', actions: [{ type: 'choose_player', filter: 'any', effects: [{ type: 'draw', amount: 1 }] }] },
      ] }],
      epi,
    )
    await s.as('A').resolveStack() // parks the choose_mode

    const mode = await s.pendingDecision()
    assert.equal(mode!.decision_type, 'choose_mode')
    await s.as('A').submitDecision(mode!.id, { chosen: [0] }) // bounce

    const pick = await s.pendingDecision()
    await s.as('A').submitDecision(pick!.id, { chosen: [victim] })

    assert.equal((await s.cardState(victim)).zone, 'hand') // bounced to B's hand
  })
})
