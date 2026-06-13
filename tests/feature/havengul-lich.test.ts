// Havengul Lich (mig 215, partial) — "{1}: You may cast target creature card in
// a graveyard this turn." A card-specific until-EOT cast-from-graveyard
// permission. (The gains-activated-abilities rider is not modelled.)

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// HL1 — activate on a graveyard creature, then cast THAT card.
test('HL1 the chosen card becomes castable this turn', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const lich = await s.spawnCreature('A', 'Havengul Lich Test')
    const chosen = await s.spawn('A', 'Goblin Raider Test', 'graveyard')
    await s.setMana('A', { C: 1, R: 1 }) // {1} for the ability + {R} for the Goblin

    await s.as('A').activate(lich, 0, { targetCardId: chosen })
    await s.as('A').resolveStack() // the grant resolves

    await s.as('A').castPermanent(chosen)
    await s.as('A').resolveStack()
    assert.equal(await s.zoneOf(chosen), 'battlefield')
  })
})

// HL3 — the permission is card-specific: another graveyard card stays locked.
test('HL3 other graveyard cards stay locked', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const lich = await s.spawnCreature('A', 'Havengul Lich Test')
    const chosen = await s.spawn('A', 'Goblin Raider Test', 'graveyard')
    const other = await s.spawn('A', 'Grave Shambler Test', 'graveyard')
    await s.setMana('A', { C: 1 })

    await s.as('A').activate(lich, 0, { targetCardId: chosen })
    await s.as('A').resolveStack()

    await assert.rejects(
      () => s.as('A').castPermanent(other),
      /permission to cast that card from your graveyard/i,
    )
  })
})

// HL2 — a non-creature graveyard card is not a legal target.
test('HL2 only creature cards are legal targets', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const lich = await s.spawnCreature('A', 'Havengul Lich Test')
    const sorcery = await s.spawn('A', 'Opt Test', 'graveyard')
    await s.setMana('A', { C: 1 })

    await assert.rejects(
      () => s.as('A').activate(lich, 0, { targetCardId: sorcery }),
      /creature card in a graveyard/i,
    )
  })
})
