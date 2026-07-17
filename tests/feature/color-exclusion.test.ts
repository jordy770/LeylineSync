// mig 414 — negative COLOUR restriction on removal ("Destroy target nonblack
// creature": Snuff Out, Bone Shredder, Executioner's Capsule, Shriekmaw). The
// exclude_color field is enforced at the apply_creature_effect choke point, so a
// black creature survives on every removal path; a nonblack (incl. colourless)
// creature is destroyed. Colours come from card_color_set (mana cost, mig 131).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function pendingTrigger(s: Scenario): Promise<string | null> {
  const r = await s.client.query<{ id: string }>(
    `select id from public.game_stack_items
     where session_id = $1 and status = 'pending' and action_type = 'triggered_ability'
     order by position desc limit 1`,
    [s.sessionId])
  return r.rows[0]?.id ?? null
}

// CE1 — triggered removal (Bone Shredder): a BLACK creature survives even though
// it can be chosen (the restriction is enforced on resolution, not selection).
test('CE1 triggered nonblack removal spares a black creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const black = await s.spawnCreature('B', 'Withered Wretch Test') // {1}{B} — black
    await s.spawnCreature('A', 'Bone Shred Test') // ETB destroy nonblack
    const trigger = await pendingTrigger(s)
    assert.ok(trigger)
    await s.as('A').chooseTriggerTarget(trigger!, black)
    await s.as('A').resolveStack()
    assert.equal(await s.zoneOf(black), 'battlefield') // black → not destroyed
  })
})

// CE2 — the same trigger destroys a NONBLACK creature.
test('CE2 triggered nonblack removal destroys a red creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const red = await s.spawnCreature('B', 'Red Wall Test') // {R} — nonblack
    await s.spawnCreature('A', 'Bone Shred Test')
    const trigger = await pendingTrigger(s)
    await s.as('A').chooseTriggerTarget(trigger!, red)
    await s.as('A').resolveStack()
    assert.equal(await s.zoneOf(red), 'graveyard') // nonblack → destroyed
  })
})

// CE3 — colourless is NOT black: a colourless creature is a legal victim.
test('CE3 nonblack removal destroys a colourless creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const colorless = await s.spawnCreature('B', 'Wall Test') // {1} — colourless
    await s.spawnCreature('A', 'Bone Shred Test')
    const trigger = await pendingTrigger(s)
    await s.as('A').chooseTriggerTarget(trigger!, colorless)
    await s.as('A').resolveStack()
    assert.equal(await s.zoneOf(colorless), 'graveyard') // colourless ≠ black → destroyed
  })
})

// CE4 — ACTIVATED removal (Executioner's Capsule): the exclusion survives the
// activate_ability → creature_simple builder → apply_creature_effect plumbing.
test('CE4 activated nonblack removal spares black, kills nonblack', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const black = await s.spawnCreature('B', 'Withered Wretch Test')
    const cap = await s.spawn('A', 'Capsule Test', 'battlefield')

    await s.as('A').activate(cap, 0, { targetCardId: black }) // sac Capsule, target black
    await s.as('A').resolveStack()
    assert.equal(await s.zoneOf(black), 'battlefield') // black spared
  })
})

test('CE5 activated nonblack removal destroys a nonblack creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const blue = await s.spawnCreature('B', 'Blue Wall Test') // {U} — nonblack, targetable
    const cap = await s.spawn('A', 'Capsule Test', 'battlefield')

    await s.as('A').activate(cap, 0, { targetCardId: blue })
    await s.as('A').resolveStack()
    assert.equal(await s.zoneOf(blue), 'graveyard') // nonblack → destroyed
  })
})
