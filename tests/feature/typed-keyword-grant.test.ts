// Typed keyword grants (mig 184) — "Zombies you control have flying" (Eternal
// Skylord), "the Army has deathtouch" (Vizier). A keyword continuous effect with
// affected:'controller' + payload.creature_type now grants the keyword only to
// the matching creatures (the right player, the right subtype) — not everyone.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { asPlayer } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function hasFlying(s: Scenario, seat: 'A' | 'B', cardId: string): Promise<boolean> {
  return asPlayer(s.client, s.players[seat], async () => {
    const r = await s.client.query<{ r: boolean }>(
      'select public.card_has_flying($1, $2) as r',
      [s.sessionId, cardId],
    )
    return r.rows[0]!.r
  })
}

// TK1 — the grant applies to your matching-type creatures only.
test('TK1 typed keyword grant flies only your Zombies', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Skylord Test') // "Zombies you control have flying"
    const myZombie = await s.spawnCreature('A', 'Grave Shambler Test') // 2/2 Zombie
    const myGoblin = await s.spawnCreature('A', 'Goblin Raider Test') // non-Zombie
    const theirZombie = await s.spawnCreature('B', 'Grave Shambler Test') // opponent's Zombie
    await s.as('A').rebuild()

    assert.equal(await hasFlying(s, 'A', myZombie), true) // your Zombie → flies
    assert.equal(await hasFlying(s, 'A', myGoblin), false) // wrong type
    assert.equal(await hasFlying(s, 'A', theirZombie), false) // not your control
  })
})

// TK2 — with no grant in play, nothing has flying (the mass branch is filtered).
test('TK2 no spurious flying without a grant', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const z = await s.spawnCreature('A', 'Grave Shambler Test')
    await s.as('A').rebuild()
    assert.equal(await hasFlying(s, 'A', z), false)
  })
})
