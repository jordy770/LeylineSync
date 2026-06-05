// F3 slice 4a — Auras + attachment (mig 134). An Aura is cast targeting a creature,
// enters attached, and grants its continuous effect to the host. The E protection
// gate rejects enchanting a creature with protection from the Aura's colour, and an
// Aura goes to the graveyard when its host leaves the battlefield.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function attachedTo(s: Scenario, card: string): Promise<string | null> {
  const res = await s.client.query<{ attached_to: string | null }>(
    'select attached_to from public.game_cards where id = $1',
    [card],
  )
  return res.rows[0]?.attached_to ?? null
}

// EA1 — a +2/+2 Aura attaches to its target and pumps it.
test('EA1 an Aura attaches and grants its effect to the host', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { R: 5 })
    const host = await s.spawnCreature('A', 'Air Elemental Test') // 4/4
    const aura = await s.spawn('A', 'Flame Bond Test', 'hand') // {R} Aura, +2/+2

    await s.as('A').castPermanent(aura, { target: host })
    await s.as('A').resolveStack()

    assert.equal(await attachedTo(s, aura), host)
    assert.equal(await s.zoneOf(aura), 'battlefield')
    assert.equal(await s.effectivePower(host), 6) // 4 + 2
    assert.equal(await s.effectiveToughness(host), 6)
  })
})

// EA2 — E gate: a red Aura can't enchant a creature with protection from red.
test('EA2 protection from red stops a red Aura from enchanting', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { R: 5 })
    const ward = await s.spawnCreature('A', 'Ember Ward Test') // protection from red
    const aura = await s.spawn('A', 'Flame Bond Test', 'hand')

    await assert.rejects(
      () => s.as('A').castPermanent(aura, { target: ward }),
      /protection/i,
    )
  })
})

// EA3 — when the enchanted creature leaves, the Aura goes to the graveyard and its
// effect stops applying.
test('EA3 an Aura dies when its host leaves the battlefield', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { R: 5 })
    const host = await s.spawnCreature('A', 'Air Elemental Test')
    const aura = await s.spawn('A', 'Flame Bond Test', 'hand')

    await s.as('A').castPermanent(aura, { target: host })
    await s.as('A').resolveStack()
    assert.equal(await s.zoneOf(aura), 'battlefield')

    // Host leaves the battlefield → the attachment-cleanup trigger fires.
    await s.client.query(
      "update public.game_cards set zone = 'graveyard' where id = $1",
      [host],
    )

    assert.equal(await s.zoneOf(aura), 'graveyard')
    assert.equal(await attachedTo(s, aura), null)
  })
})

// ── Equipment + equip (mig 135) ────────────────────────────────────────────

// EQ1 — equip an Equipment onto a creature you control; it pumps the host.
test('EQ1 equip attaches and grants its effect', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { R: 5 })
    const host = await s.spawnCreature('A', 'Air Elemental Test') // 4/4
    const equip = await s.spawn('A', 'Bloodforged Blade Test', 'hand') // {R}, equip {1}, +1/+1

    await s.as('A').castPermanent(equip) // resolves to battlefield, unattached
    await s.as('A').resolveStack()
    assert.equal(await attachedTo(s, equip), null)

    await s.as('A').equip(equip, host)
    assert.equal(await attachedTo(s, equip), host)
    assert.equal(await s.effectivePower(host), 5) // 4 + 1
    assert.equal(await s.effectiveToughness(host), 5)
  })
})

// EQ2 — E gate: a red Equipment can't be equipped onto a protection-from-red creature.
test('EQ2 protection from red stops a red Equipment from equipping', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { R: 5 })
    const ward = await s.spawnCreature('A', 'Ember Ward Test') // protection from red
    const equip = await s.spawn('A', 'Bloodforged Blade Test', 'hand')

    await s.as('A').castPermanent(equip)
    await s.as('A').resolveStack()

    await assert.rejects(() => s.as('A').equip(equip, ward), /protection/i)
  })
})

// EQ3 — when the equipped creature leaves, the Equipment falls off but stays on the
// battlefield (unlike an Aura, which dies).
test('EQ3 Equipment falls off but survives when its host leaves', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { R: 5 })
    const host = await s.spawnCreature('A', 'Air Elemental Test')
    const equip = await s.spawn('A', 'Bloodforged Blade Test', 'hand')

    await s.as('A').castPermanent(equip)
    await s.as('A').resolveStack()
    await s.as('A').equip(equip, host)
    assert.equal(await attachedTo(s, equip), host)

    await s.client.query("update public.game_cards set zone = 'graveyard' where id = $1", [host])

    assert.equal(await s.zoneOf(equip), 'battlefield') // survives
    assert.equal(await attachedTo(s, equip), null) // but fell off
  })
})
