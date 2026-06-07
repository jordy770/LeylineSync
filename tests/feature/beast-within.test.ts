// Beast Within (card request) — "Destroy target permanent. Its controller creates a
// 3/3 green Beast creature token." The token goes to the DESTROYED permanent's
// controller (captured before destroy), not the caster. Exercises: multi-action
// targeted spell program (cast_spell_effect p_target_card_id) + create_token
// recipient:"target_controller".

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function beastCount(s: Scenario, seat: 'A' | 'B'): Promise<number> {
  const r = await s.client.query<{ n: string }>(
    `select count(*) as n
       from public.game_cards gc join public.cards c on c.id = gc.card_id
      where gc.session_id = $1 and gc.controller_player_id = $2
        and gc.zone = 'battlefield' and c.name = 'Beast Token'`,
    [s.sessionId, s.playerId(seat)],
  )
  return Number(r.rows[0]!.n)
}

// BW1 — A destroys B's permanent; B (its controller) gets the 3/3 Beast.
test('BW1 the destroyed permanent\'s controller gets the Beast', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const victim = await s.spawnCreature('B', 'Air Elemental Test')

    await s.as('A').castSpellEffect(
      [
        { type: 'destroy', target_type: 'permanent' },
        { type: 'create_token', token: 'Beast Token', count: 1, recipient: 'target_controller' },
      ],
      null,
      null,
      victim,
    )
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(victim), 'graveyard') // destroyed
    assert.equal(await beastCount(s, 'B'), 1) // B (its controller) got the token
    assert.equal(await beastCount(s, 'A'), 0) // NOT the caster
  })
})

// BW2 — the Beast is a real 3/3 on the controller's battlefield.
test('BW2 the token is a 3/3 Beast', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const victim = await s.spawnCreature('B', 'Air Elemental Test')

    await s.as('A').castSpellEffect(
      [
        { type: 'destroy', target_type: 'permanent' },
        { type: 'create_token', token: 'Beast Token', count: 1, recipient: 'target_controller' },
      ],
      null,
      null,
      victim,
    )
    await s.as('A').resolveStack()

    const r = await s.client.query<{ id: string; p: number; t: number }>(
      `select gc.id, public.card_effective_power($1, gc.id) as p, public.card_effective_toughness($1, gc.id) as t
         from public.game_cards gc join public.cards c on c.id = gc.card_id
        where gc.session_id = $1 and gc.controller_player_id = $2 and c.name = 'Beast Token'`,
      [s.sessionId, s.playerId('B')],
    )
    assert.equal(r.rows.length, 1)
    assert.equal(Number(r.rows[0]!.p), 3)
    assert.equal(Number(r.rows[0]!.t), 3)
  })
})

// BW3 — destroying YOUR OWN permanent gives YOU the Beast (recipient = controller).
test('BW3 destroying your own permanent gives you the Beast', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const own = await s.spawnCreature('A', 'Air Elemental Test')

    await s.as('A').castSpellEffect(
      [
        { type: 'destroy', target_type: 'permanent' },
        { type: 'create_token', token: 'Beast Token', count: 1, recipient: 'target_controller' },
      ],
      null,
      null,
      own,
    )
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(own), 'graveyard')
    assert.equal(await beastCount(s, 'A'), 1)
  })
})
