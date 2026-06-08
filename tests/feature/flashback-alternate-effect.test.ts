// Flashback that does a DIFFERENT/extra effect than the hand cast (the
// "Increasing" cycle: "If this was cast from a graveyard, do more/instead", mig
// 177). The script's optional `flashback_effect` REPLACES `spell_effect` when the
// card is cast from the graveyard, and the ENGINE selects it by cast zone — it
// does not trust the client's actions for the flashback effect.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// The normal program (draw 1) — what the client passes for both casts. The engine
// substitutes the flashback program (draw 3) on a graveyard cast on its own.
const NORMAL_ACTIONS = [{ type: 'draw', amount: 1 }]

async function fillLibrary(s: Scenario, seat: 'A' | 'B', n: number) {
  for (let i = 0; i < n; i++) {
    await s.spawn(seat, 'Air Elemental Test', 'library')
  }
}

// FAE1 — flashback runs the flashback_effect (draw 3), not the passed actions.
test('FAE1 flashback runs the alternate flashback effect, not the normal one', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const card = await s.spawn('A', 'Increasing Insight Test', 'graveyard')
    await fillLibrary(s, 'A', 3)
    await s.setMana('A', { C: 2 }) // flashback {2}
    const handBefore = await s.zoneCount('A', 'hand')

    // The client passes the NORMAL (draw 1) actions; the engine must override with
    // the script's flashback_effect (draw 3) because the cast is from the graveyard.
    await s.as('A').castSpellEffect(NORMAL_ACTIONS, card)
    await s.as('A').resolveStack()

    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 3) // flashback effect ran
    assert.equal(await s.zoneOf(card), 'exile')
  })
})

// FAE2 — a HAND cast runs the normal spell effect (draw 1), unaffected.
test('FAE2 a hand cast runs the normal effect, not the flashback effect', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const card = await s.spawn('A', 'Increasing Insight Test', 'hand')
    await fillLibrary(s, 'A', 3)
    await s.setMana('A', { C: 2 }) // printed {2}
    const handBefore = await s.zoneCount('A', 'hand')

    await s.as('A').castSpellEffect(NORMAL_ACTIONS, card)
    await s.as('A').resolveStack()

    // +1 from the draw, but the card itself left hand → graveyard, so net hand is
    // handBefore (started in hand) - 1 (cast) + 1 (draw) = handBefore.
    assert.equal(await s.zoneCount('A', 'hand'), handBefore)
    assert.equal(await s.zoneOf(card), 'graveyard')
  })
})
