// Mass damage `deal_damage_all` (mig 224) — Blasphemous Act / Storm's Wrath /
// Harbinger of the Hunt. N to every creature matching the filter; optionally
// planeswalkers; with/without-flying gates; exclude_source.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// DA1 — Blasphemous Act: 13 to each creature wipes the board (both players').
test('DA1 Blasphemous Act destroys every creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const mine = await s.spawnCreature('A', 'Grave Shambler Test') // 2/2
    const theirs = await s.spawnCreature('B', 'Air Elemental Test') // 4/4

    await s.as('A').castSpellEffect([{ type: 'deal_damage_all', amount: 13 }])
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(mine), 'graveyard')
    assert.equal(await s.zoneOf(theirs), 'graveyard')
  })
})

// DA2 — a small mass burn only kills what it's lethal to.
test('DA2 small mass damage kills only the fragile', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const small = await s.spawnCreature('A', 'Goblin Raider Test') // 2/2
    const big = await s.spawnCreature('B', 'Air Elemental Test') // 4/4

    await s.as('A').castSpellEffect([{ type: 'deal_damage_all', amount: 2 }])
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(small), 'graveyard') // 2 dmg ≥ 2 toughness
    assert.equal(await s.zoneOf(big), 'battlefield') // survives
  })
})

// DA3 — Harbinger's two halves: without-flying hits grounders, with-flying +
// exclude_source spares the Harbinger itself.
test('DA3 Harbinger of the Hunt filters by flying', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const harbinger = await s.spawnCreature('A', 'Harbinger of the Hunt Test') // 4/4 flier
    const grounder = await s.spawnCreature('B', 'Grave Shambler Test') // 2/2 no fly
    const flier = await s.spawnCreature('B', 'Air Elemental Test') // 4/4 flying
    await s.as('A').rebuild()
    await s.setMana('A', { R: 1, G: 1, C: 4 })

    // {2}{R}: 1 to each creature WITHOUT flying.
    await s.as('A').activate(harbinger, 0)
    await s.as('A').resolveStack()
    const g1 = await s.client.query<{ d: number }>('select damage_marked as d from public.game_cards where id = $1', [grounder])
    const h1 = await s.client.query<{ d: number }>('select damage_marked as d from public.game_cards where id = $1', [harbinger])
    const f1 = await s.client.query<{ d: number }>('select damage_marked as d from public.game_cards where id = $1', [flier])
    assert.equal(Number(g1.rows[0]!.d), 1) // grounder hit
    assert.equal(Number(h1.rows[0]!.d), 0) // Harbinger flies → not hit
    assert.equal(Number(f1.rows[0]!.d), 0) // flier → not hit

    // {2}{G}: 1 to each OTHER creature WITH flying (spares the Harbinger).
    await s.as('A').activate(harbinger, 1)
    await s.as('A').resolveStack()
    const f2 = await s.client.query<{ d: number }>('select damage_marked as d from public.game_cards where id = $1', [flier])
    const h2 = await s.client.query<{ d: number }>('select damage_marked as d from public.game_cards where id = $1', [harbinger])
    assert.equal(Number(f2.rows[0]!.d), 1) // the other flier hit
    assert.equal(Number(h2.rows[0]!.d), 0) // exclude_source → Harbinger spared
  })
})
