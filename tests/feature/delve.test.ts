// Delve (mig 431, Treasure Cruise / Dig Through Time) — "Each card you exile
// from your graveyard while casting this spell pays for {1}." Both cast RPCs
// (cast_spell_effect and put_action_on_stack) gain p_delve_card_ids: the
// chosen cards must be distinct cards in the caster's graveyard, their count
// may not exceed the generic part of the cost, they move to exile at cast, and
// the generic cost drops by one per card (reduce_generic_cost).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

const DRAW3 = [{ type: 'draw', amount: 3 }]

async function graveyardFodder(s: Scenario, n: number): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < n; i++) ids.push(await s.spawn('A', 'Goblin Raider Test', 'graveyard'))
  return ids
}

// DV1 — cast_spell_effect path: three delved cards knock {7}{U} down to
// {4}{U}; the delved cards are exiled and the spell resolves normally.
test('DV1 delve exiles the chosen cards and reduces the generic cost', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Delve Draw Test', 'hand')
    const fodder = await graveyardFodder(s, 3)
    for (let i = 0; i < 3; i++) await s.spawn('A', 'Island Test', 'library')
    const handBefore = await s.zoneCount('A', 'hand') // the spell itself
    await s.setMana('A', { U: 1, C: 4 }) // exactly {4}{U}

    await s.as('A').castSpellEffect(DRAW3, spell, null, null, false, false, false, fodder)
    await s.as('A').resolveStack()

    for (const id of fodder) assert.equal(await s.zoneOf(id), 'exile')
    assert.equal(await s.zoneOf(spell), 'graveyard')
    assert.equal(await s.zoneCount('A', 'hand'), handBefore - 1 + 3) // cast, then drew 3
  })
})

// DV2 — a card without delve in its script cannot delve.
test('DV2 delve on a card without delve is rejected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Opt Test', 'hand')
    const fodder = await graveyardFodder(s, 1)
    await s.setMana('A', { U: 5 })
    await assert.rejects(
      () => s.as('A').castSpellEffect([{ type: 'draw_cards', amount: 1 }], spell, null, null, false, false, false, fodder),
      /delve/i,
    )
  })
})

// DV3 — delve only pays what was exiled: two cards leave {5}{U} due.
test('DV3 the remaining cost after delve is still charged', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Delve Draw Test', 'hand')
    const fodder = await graveyardFodder(s, 2)
    await s.setMana('A', { U: 1, C: 4 }) // {4}{U} available, {5}{U} due
    await assert.rejects(
      () => s.as('A').castSpellEffect(DRAW3, spell, null, null, false, false, false, fodder),
      /not enough .*mana/i,
    )
  })
})

// DV4 — you cannot exile more cards than the generic part of the cost.
test('DV4 delving more cards than the generic cost is rejected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Delve Draw Test', 'hand')
    const fodder = await graveyardFodder(s, 8) // generic part is {7}
    await s.setMana('A', { U: 1 })
    await assert.rejects(
      () => s.as('A').castSpellEffect(DRAW3, spell, null, null, false, false, false, fodder),
      /generic/i,
    )
  })
})

// DV5 — delve cards must be in the CASTER's graveyard.
test('DV5 delving a card outside your graveyard is rejected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Delve Draw Test', 'hand')
    const foeCard = await s.spawn('B', 'Goblin Raider Test', 'graveyard')
    await s.setMana('A', { U: 1, C: 6 })
    await assert.rejects(
      () => s.as('A').castSpellEffect(DRAW3, spell, null, null, false, false, false, [foeCard]),
      /graveyard/i,
    )
  })
})

// DV6 — put_action_on_stack path (Treasure Cruise's draw_cards shape).
test('DV6 delve works on the put_action_on_stack path', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Delve Draw Test', 'hand')
    const fodder = await graveyardFodder(s, 3)
    for (let i = 0; i < 3; i++) await s.spawn('A', 'Island Test', 'library')
    const handBefore = await s.zoneCount('A', 'hand')
    await s.setMana('A', { U: 1, C: 4 })

    await s.as('A').putOnStack('draw_cards', { amount: 3, timing: 'sorcery' }, spell, false, false, fodder)
    await s.as('A').resolveStack()

    for (const id of fodder) assert.equal(await s.zoneOf(id), 'exile')
    assert.equal(await s.zoneCount('A', 'hand'), handBefore - 1 + 3)
  })
})
