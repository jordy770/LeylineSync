// Vampire Nocturnus (mig 342). Conditional tribal anthem: "as long as the top
// card of your library is black, this and other Vampires you control get +2/+1
// and have flying." New library_top_is_color predicate, wired into card_layered_
// power / card_layered_toughness (the pump) and card_has_flying (the keyword).
// "Play with the top card revealed" is a UI concern and is not modelled here.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx, asPlayer } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function hasFlying(s: Scenario, cardId: string): Promise<boolean> {
  return asPlayer(s.client, s.playerId('A'), async () => {
    const r = await s.client.query<{ v: boolean }>(
      'select public.card_has_flying($1, $2) as v', [s.sessionId, cardId])
    return r.rows[0]?.v ?? false
  })
}

// VN1 — top card black: Vampires get +2/+1 and flying.
test('VN1 black top card switches the anthem on', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const nocturnus = await s.spawnCreature('A', 'Vampire Nocturnus Test') // 3/3 Vampire
    const vamp = await s.spawnCreature('A', 'Vampire Bear Test') // 2/2 Vampire
    await s.spawn('A', 'Black Wall Test', 'library') // {B} — the only library card → top

    assert.equal(await s.effectivePower(nocturnus), 5, '3 +2')
    assert.equal(await s.effectiveToughness(nocturnus), 4, '3 +1')
    assert.equal(await s.effectivePower(vamp), 4, '2 +2')
    assert.equal(await hasFlying(s, nocturnus), true)
    assert.equal(await hasFlying(s, vamp), true)
  })
})

// VN2 — top card NOT black: no pump, no flying.
test('VN2 non-black top card leaves the anthem off', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const nocturnus = await s.spawnCreature('A', 'Vampire Nocturnus Test')
    const vamp = await s.spawnCreature('A', 'Vampire Bear Test')
    await s.spawn('A', 'Red Wall Test', 'library') // {R} — non-black top

    assert.equal(await s.effectivePower(nocturnus), 3, 'no pump')
    assert.equal(await s.effectivePower(vamp), 2, 'no pump')
    assert.equal(await hasFlying(s, nocturnus), false)
    assert.equal(await hasFlying(s, vamp), false)
  })
})

// VN3 — the anthem is Vampire-scoped: a non-Vampire is never pumped even when on.
test('VN3 only Vampires get the anthem', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawnCreature('A', 'Vampire Nocturnus Test')
    const zombie = await s.spawnCreature('A', 'Grave Shambler Test') // Zombie
    await s.spawn('A', 'Black Wall Test', 'library')

    assert.equal(await s.effectivePower(zombie), 2, 'non-Vampire unaffected')
    assert.equal(await hasFlying(s, zombie), false)
  })
})
