// Bucket-6 slice (mig 439) — planeswalker-eligible effects:
// - Edicts with filter {type_line_any: ['creature','planeswalker']} (Demon's
//   Disciple / Plaguecrafter): a player with only a planeswalker sacrifices it
//   instead of being skipped (park_edict_sacrifice's mig-417 OR-types).
// - nonland_permanents_on_battlefield count for cost_reduction.if (Hour of
//   Revelation's "{3} less with ten or more nonland permanents").
// - add_counters if_target_type_line (Sorin's +1 rider: "if it's a Vampire,
//   put a +1/+1 counter on it") — the counter lands only on a matching target.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// PW1 — an opponent with only a planeswalker sacrifices it under the OR-edict.
test('PW1 the creature-or-planeswalker edict reaches a walker-only board', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Walker Edict Test', 'hand')
    const walker = await s.spawn('B', 'Test Walker', 'battlefield')
    await s.setMana('A', { B: 1, C: 2 })

    await s.as('A').castSpellEffect([{ type: 'sacrifice', who: 'each_opponent', count: 1, filter: { type_line_any: ['creature', 'planeswalker'] } }], spell)
    await s.as('A').resolveStack()

    const decision = await s.pendingDecision()
    assert.ok(decision, 'B gets a sacrifice pick instead of being skipped')
    assert.equal(decision.deciding_player_id, s.playerId('B'))
    const offered = (decision.options as Array<{ game_card_id: string }>).map((o) => o.game_card_id)
    assert.deepEqual(offered, [walker])

    await s.as('B').submitDecision(decision.id, { chosen: [walker] })
    assert.equal(await s.zoneOf(walker), 'graveyard')
  })
})

// PW2 — ten nonland permanents make the revelation {3} cheaper.
test('PW2 nonland_permanents_on_battlefield gates the reduction', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Revelation Test', 'hand')
    for (let i = 0; i < 5; i++) await s.spawn('A', 'Goblin Raider Test', 'battlefield')
    for (let i = 0; i < 5; i++) await s.spawn('B', 'Air Elemental Test', 'battlefield')
    await s.setMana('A', { W: 3 }) // covers only the reduced {W}{W}{W}

    await s.as('A').castSpellEffect([{ type: 'destroy_all', types: ['creature', 'artifact', 'enchantment', 'planeswalker'] }], spell)
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(spell), 'graveyard')
    assert.equal(await s.zoneCount('A', 'battlefield'), 0) // the wipe resolved
  })
})

// PW3 — the Vampire rider lands on a Vampire target...
test('PW3 if_target_type_line adds the counter to a matching target', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const vampire = await s.spawn('A', 'Vampire Bear Test', 'battlefield')

    await s.as('A').putOnStack('add_counters_creature', { target_card_id: vampire, amount: 1, if_target_type_line: 'Vampire', target_controller: 'you' })
    await s.as('A').resolveStack()

    const state = await s.cardState(vampire)
    assert.equal(state.plus_one_counters, 1)
  })
})

// PW3b — ...and skips a non-Vampire without failing the rest of the ability.
test('PW3b if_target_type_line skips a non-matching target', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const raider = await s.spawn('A', 'Goblin Raider Test', 'battlefield')

    await s.as('A').putOnStack('add_counters_creature', { target_card_id: raider, amount: 1, if_target_type_line: 'Vampire', target_controller: 'you' })
    await s.as('A').resolveStack()

    const state = await s.cardState(raider)
    assert.equal(state.plus_one_counters, 0) // rider declined, no error
  })
})
