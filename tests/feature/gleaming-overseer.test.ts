// Gleaming Overseer (mig 200) — "When this creature enters, amass Zombies 1.
// Zombie tokens you control have hexproof and menace." Amass is mig 182; the
// token_only payload filter on keyword grants is the mig 200 addition: the grant
// reaches TOKEN Zombies (the amassed Army) but not nontoken Zombies — not even
// the Overseer itself.

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
  fn: 'card_has_hexproof' | 'card_has_menace',
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

// GO1 — ETB amass makes a 1/1 Army; the token-only grant covers it, not nontokens.
test('GO1 Gleaming Overseer grants hexproof+menace to Zombie tokens only', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const overseer = await s.spawnCreature('A', 'Gleaming Overseer Test')
    await s.as('A').resolveStack() // resolve the ETB amass trigger
    const zombie = await s.spawnCreature('A', 'Grave Shambler Test') // nontoken Zombie
    await s.as('A').rebuild()

    const army = await s.client.query<{ id: string; plus_one_counters: number }>(
      `select gc.id, gc.plus_one_counters from public.game_cards gc
       join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and gc.controller_player_id = $2 and gc.zone = 'battlefield'
         and c.type_line ilike '%Army%'`,
      [s.sessionId, s.players.A],
    )
    assert.equal(army.rows.length, 1) // amass 1 made one Army
    assert.equal(Number(army.rows[0]!.plus_one_counters), 1)
    const armyId = army.rows[0]!.id

    assert.equal(await hasKeyword(s, 'A', 'card_has_hexproof', armyId), true)
    assert.equal(await hasKeyword(s, 'A', 'card_has_menace', armyId), true)
    assert.equal(await hasKeyword(s, 'A', 'card_has_hexproof', zombie), false) // nontoken
    assert.equal(await hasKeyword(s, 'A', 'card_has_menace', zombie), false)
    assert.equal(await hasKeyword(s, 'A', 'card_has_hexproof', overseer), false) // itself nontoken
  })
})
