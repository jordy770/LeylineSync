// grant_keyword_all (mig 202) + the player-hexproof gate (mig 203).
//   Lord of the Accursed — "Other Zombies you control get +1/+1. {1}{B}, {T}:
//     All Zombies gain menace until end of turn." (activated, scope all, typed)
//   Lazotep Plating — "Amass Zombies 1. You and permanents you control gain
//     hexproof until end of turn." (spell, scope controller, includes_player)

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx, asPlayer } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function hasKeyword(
  s: Scenario,
  seat: 'A' | 'B',
  fn: 'card_has_menace' | 'card_has_hexproof',
  cardId: string,
): Promise<boolean> {
  return asPlayer(s.client, s.players[seat], async () => {
    const r = await s.client.query<{ r: boolean }>(
      `select public.${fn}($1, $2) as r`,
      [s.sessionId, cardId],
    )
    return r.rows[0]!.r
  })
}

// MK1 — Lord of the Accursed's ability: ALL Zombies (yours, theirs, himself)
// gain menace until end of turn; non-Zombies don't.
test('MK1 Lord of the Accursed gives all Zombies menace', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const lord = await s.spawnCreature('A', 'Lord of the Accursed Test')
    const myZombie = await s.spawnCreature('A', 'Grave Shambler Test')
    const goblin = await s.spawnCreature('A', 'Goblin Raider Test')
    const theirZombie = await s.spawnCreature('B', 'Grave Shambler Test')
    await s.as('A').rebuild()

    // The static lord half still works (other Zombies +1/+1).
    assert.equal(await s.effectivePower(myZombie), 3)
    assert.equal(await s.effectivePower(lord), 2)

    assert.equal(await hasKeyword(s, 'A', 'card_has_menace', myZombie), false) // not yet

    await s.setMana('A', { B: 1, C: 1 }) // {1}{B}
    await s.as('A').activate(lord, 0)
    await s.as('A').resolveStack() // the routed spell_effect resolves the grant

    assert.equal(await hasKeyword(s, 'A', 'card_has_menace', myZombie), true)
    assert.equal(await hasKeyword(s, 'A', 'card_has_menace', lord), true) // "All Zombies" includes himself
    assert.equal(await hasKeyword(s, 'B', 'card_has_menace', theirZombie), true) // scope all
    assert.equal(await hasKeyword(s, 'A', 'card_has_menace', goblin), false) // wrong type
  })
})

// Cast Lazotep Plating's program as seat A and resolve it.
async function castPlating(s: Scenario): Promise<void> {
  await s.as('A').castSpellEffect([
    { type: 'amass', amount: 1 },
    { type: 'grant_keyword_all', keyword: 'hexproof', scope: 'controller', includes_player: true },
  ])
  await s.as('A').resolveStack()
}

// MK2 — Lazotep Plating: amass 1 + your permanents get hexproof (not the
// opponent's); you can still target your own protected creature.
test('MK2 Lazotep Plating covers your board, self-targeting stays legal', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const mine = await s.spawnCreature('A', 'Grave Shambler Test')
    const theirs = await s.spawnCreature('B', 'Goblin Raider Test')
    await castPlating(s)

    // Amass half: a 1/1 Army exists.
    const army = await s.client.query(
      `select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and gc.controller_player_id = $2 and gc.zone = 'battlefield'
         and c.type_line ilike '%Army%'`,
      [s.sessionId, s.players.A],
    )
    assert.equal(army.rows.length, 1)

    // Permanent half: your creature has hexproof, the opponent's doesn't.
    assert.equal(await hasKeyword(s, 'A', 'card_has_hexproof', mine), true)
    assert.equal(await hasKeyword(s, 'B', 'card_has_hexproof', theirs), false)

    // Hexproof doesn't stop YOU from targeting your own creature.
    await s.as('A').putOnStack('destroy_creature', { target_card_id: mine, target_controller: 'any' })
    await s.as('A').resolveStack()
    assert.equal(await s.zoneOf(mine), 'graveyard')
  })
})

// MK3 — an opponent can't target your hexproof creature. (The expected
// rejection aborts the harness tx, so it's this test's last statement.)
test('MK3 opponent cannot target a Plating-protected creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const mine = await s.spawnCreature('A', 'Grave Shambler Test')
    await castPlating(s)

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'B' })
    await assert.rejects(
      () => s.as('B').putOnStack('destroy_creature', { target_card_id: mine, target_controller: 'any' }),
      /hexproof/i,
    )
  })
})

// MK4 — the player gate (mig 203): an opponent can't target YOU either.
test('MK4 opponent cannot target the protected player', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await castPlating(s)

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'B' })
    await assert.rejects(
      () => s.as('B').putOnStack('deal_damage_player', { target_player_id: s.playerId('A'), amount: 3 }),
      /hexproof/i,
    )
  })
})
