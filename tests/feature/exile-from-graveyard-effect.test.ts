// "Exile target card from a graveyard" as a targeted EFFECT (mig 186). Withered
// Wretch: "{1}: Exile target card from a graveyard." Distinct from the
// exile_from_graveyard COST — here the graveyard card is the ability's target, the
// source is NOT consumed (repeatable), and any card type is a legal target.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// WW1 — pay {1}, target a card in an opponent's graveyard → it is exiled; the
// source stays untapped and on the battlefield (repeatable).
test('WW1 exiles the targeted graveyard card and leaves the source untapped', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const wretch = await s.spawn('A', 'Withered Wretch Test', 'battlefield')
    const target = await s.spawn('B', 'Divination Test', 'graveyard') // a Sorcery — any card is legal
    await s.setMana('A', { C: 1 }) // {1}

    await s.as('A').activate(wretch, 0, { targetCardId: target })
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(target), 'exile')
    assert.equal((await s.cardState(wretch)).is_tapped, false) // no tap cost — repeatable
  })
})

// WW2 — the effect requires a target that is actually in a graveyard.
test('WW2 a non-graveyard target is rejected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const wretch = await s.spawn('A', 'Withered Wretch Test', 'battlefield')
    const onField = await s.spawnCreature('B', 'Grave Shambler Test') // on the battlefield
    await s.setMana('A', { C: 1 })

    await assert.rejects(
      () => s.as('A').activate(wretch, 0, { targetCardId: onField }),
      /card in a graveyard/,
    )
  })
})

// WW3 — if the target leaves the graveyard before the ability resolves, the
// ability simply does nothing (it does not error).
test('WW3 resolves harmlessly if the target left the graveyard', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const wretch = await s.spawn('A', 'Withered Wretch Test', 'battlefield')
    const target = await s.spawn('A', 'Grave Shambler Test', 'graveyard')
    await s.setMana('A', { C: 1 })

    await s.as('A').activate(wretch, 0, { targetCardId: target })
    // The card is moved out of the graveyard (e.g. reanimated) before resolution.
    await client.query(
      `update public.game_cards set zone = 'hand' where id = $1 and session_id = $2`,
      [target, s.sessionId],
    )
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(target), 'hand') // untouched; the ability fizzled
  })
})
