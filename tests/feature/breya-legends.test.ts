// mig 269 — Breya legends + big spells: conditional anthems (Jor Kadeen),
// self pump per artifact (Akiri), gain_control_all (Hellkite Tyrant),
// return-all with types under owners (Open the Vaults),
// destroy_all_creatures_token (Phyrexian Rebirth).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// BL1 — Akiri counts artifacts; Jor Kadeen's anthem needs metalcraft.
test('BL1 Akiri pump and Jor Kadeen metalcraft gate', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const akiri = await s.spawnCreature('A', 'Akiri Slinger Test') // 0/3
    const jor = await s.spawnCreature('A', 'Jor Kadeen Test') // 5/4
    await s.spawn('A', 'Ichor Wellspring Test', 'battlefield')
    await s.spawn('A', 'Skullclamp Test', 'battlefield')

    // 2 artifacts → Akiri +2; metalcraft (needs 3) OFF.
    assert.equal(await s.effectivePower(akiri), 2)
    assert.equal(await s.effectivePower(jor), 5)

    await s.spawn('A', 'Cranial Plating Test', 'battlefield') // third artifact
    assert.equal(await s.effectivePower(akiri), 3 + 3) // +3 artifacts, +3 anthem
    assert.equal(await s.effectivePower(jor), 8) // metalcraft ON
  })
})

// BL2 — Hellkite Tyrant steals all the defender's artifacts on connect.
test('BL2 Hellkite Tyrant takes the artifacts', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const tyrant = await s.spawnCreature('A', 'Hellkite Tyrant Test')
    const loot = await s.spawn('B', 'Ichor Wellspring Test', 'battlefield')
    await s.as('B').resolveStack() // flush the Wellspring ETB draw first
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(tyrant, 'B')
    await s.setTurn({ phase: 'combat', step: 'combat_damage', active: 'A', priority: 'A' })
    await s.resolveCombat()
    await s.as('A').resolveStack() // the connect trigger

    const r = await s.client.query<{ controller_player_id: string }>(
      'select controller_player_id from public.game_cards where id = $1', [loot])
    assert.equal(r.rows[0]!.controller_player_id, s.players.A)
  })
})

// BL3 — Open the Vaults: artifacts AND enchantments, from BOTH graveyards,
// each under its OWNER.
test('BL3 Open the Vaults returns under owners', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const mine = await s.spawn('A', 'Ichor Wellspring Test', 'graveyard')
    const theirs = await s.spawn('B', 'Skullclamp Test', 'graveyard')
    const corpse = await s.spawn('B', 'Dino Grunt Test', 'graveyard') // creature — stays

    await s.as('A').castSpellEffect([
      { type: 'return_all_from_graveyard', to: 'battlefield', from: 'all_graveyards',
        under: 'owner', types: ['artifact', 'enchantment'] }])
    await s.as('A').resolveStack()

    const rows = await s.client.query<{ id: string; zone: string; controller_player_id: string }>(
      'select id, zone, controller_player_id from public.game_cards where id = any($1::uuid[])',
      [[mine, theirs, corpse]])
    const byId = new Map(rows.rows.map((r) => [r.id, r]))
    assert.equal(byId.get(mine)!.zone, 'battlefield')
    assert.equal(byId.get(theirs)!.zone, 'battlefield')
    assert.equal(byId.get(theirs)!.controller_player_id, s.players.B) // owner keeps it
    assert.equal(byId.get(corpse)!.zone, 'graveyard') // creatures untouched
  })
})

// BL4 — Phyrexian Rebirth: board wipe makes an X/X Horror.
test('BL4 Phyrexian Rebirth counts its victims', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Dino Grunt Test')
    await s.spawnCreature('B', 'Air Elemental Test')
    await s.spawnCreature('B', 'Dino Grunt Test')

    await s.as('A').castSpellEffect([
      { type: 'destroy_all_creatures_token', token: 'Horror Token' }])
    await s.as('A').resolveStack()

    const horror = await s.client.query<{ id: string }>(
      `select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and gc.zone = 'battlefield' and c.name = 'Horror Token'`,
      [s.sessionId])
    assert.equal(horror.rows.length, 1)
    assert.equal(await s.effectivePower(horror.rows[0]!.id), 3) // three destroyed
  })
})
