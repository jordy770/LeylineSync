// Overload (mig 428) — "You may cast this spell for its overload cost. If you
// do, change 'target' in its text to 'each.'" cast_spell_effect(p_overload =>
// true) pays the script's `overload` mana cost instead of the printed cost and
// runs the engine-selected `overload_effect` actions (mass, untargeted) instead
// of the client-supplied program — mirroring the flashback_effect precedent.
// Cards: Cyclonic Rift ({6}{U}: bounce each nonland permanent you don't
// control), Vandalblast ({4}{R}: destroy each artifact you don't control).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

const BOUNCE_BASE = [{ type: 'bounce', target_type: 'nonland_permanent', target_controller: 'opponent' }]
const SHATTER_BASE = [{ type: 'destroy', target_type: 'artifact', target_controller: 'opponent' }]

// OV1 — overloaded bounce hits each opposing nonland permanent; own board and
// opposing lands stay put.
test('OV1 overloaded bounce returns all opposing nonland permanents to hand', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Overload Bounce Test', 'hand')
    const ownCreature = await s.spawn('A', 'Goblin Raider Test', 'battlefield')
    const foeCreature = await s.spawn('B', 'Air Elemental Test', 'battlefield')
    const foeArtifact = await s.spawn('B', 'Dimir Signet Test', 'battlefield')
    const foeLand = await s.spawn('B', 'Island Test', 'battlefield')
    await s.setMana('A', { U: 7 })

    await s.as('A').castSpellEffect(BOUNCE_BASE, spell, null, null, false, true)
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(foeCreature), 'hand')
    assert.equal(await s.zoneOf(foeArtifact), 'hand')
    assert.equal(await s.zoneOf(foeLand), 'battlefield') // nonland only
    assert.equal(await s.zoneOf(ownCreature), 'battlefield') // "you don't control"
    assert.equal(await s.zoneOf(spell), 'graveyard')
  })
})

// OV2 — a card without an overload cost cannot be cast overloaded.
test('OV2 overload cast on a card without overload is rejected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Opt Test', 'hand')
    await s.setMana('A', { U: 7 })
    await assert.rejects(
      () => s.as('A').castSpellEffect([{ type: 'draw_cards', amount: 1 }], spell, null, null, false, true),
      /overload/i,
    )
  })
})

// OV3 — the overload cost is real: printed-cost mana is not enough.
test('OV3 overload pays the overload cost, not the printed cost', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Overload Bounce Test', 'hand')
    await s.setMana('A', { U: 2 }) // covers printed {1}{U}, not overload {6}{U}
    await assert.rejects(() => s.as('A').castSpellEffect(BOUNCE_BASE, spell, null, null, false, true))
  })
})

// OV4 — overloaded destroy sweeps each opposing artifact; your own artifacts
// survive (the whole point of casting Vandalblast overloaded).
test('OV4 overloaded destroy hits each opposing artifact only', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Overload Shatter Test', 'hand')
    const ownArtifact = await s.spawn('A', 'Talisman of Dominance Test', 'battlefield')
    const foeArtifact1 = await s.spawn('B', 'Dimir Signet Test', 'battlefield')
    const foeArtifact2 = await s.spawn('B', 'Unstable Obelisk Test', 'battlefield')
    const foeCreature = await s.spawn('B', 'Air Elemental Test', 'battlefield')
    await s.setMana('A', { R: 5 })

    await s.as('A').castSpellEffect(SHATTER_BASE, spell, null, null, false, true)
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(foeArtifact1), 'graveyard')
    assert.equal(await s.zoneOf(foeArtifact2), 'graveyard')
    assert.equal(await s.zoneOf(ownArtifact), 'battlefield')
    assert.equal(await s.zoneOf(foeCreature), 'battlefield')
    assert.equal(await s.zoneOf(spell), 'graveyard')
  })
})

// OV5 — the base (targeted) mode still works on a card that carries overload.
test('OV5 base targeted cast is unaffected by the overload fields', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Overload Bounce Test', 'hand')
    const foeCreature = await s.spawn('B', 'Air Elemental Test', 'battlefield')
    const foeArtifact = await s.spawn('B', 'Dimir Signet Test', 'battlefield')
    await s.setMana('A', { U: 2 })

    await s.as('A').castSpellEffect(BOUNCE_BASE, spell, null, foeCreature)
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(foeCreature), 'hand')
    assert.equal(await s.zoneOf(foeArtifact), 'battlefield')
    assert.equal(await s.zoneOf(spell), 'graveyard')
  })
})
