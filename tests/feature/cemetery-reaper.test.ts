// Cemetery Reaper's activated ability (mig 178): "{2}{B}, {T}, Exile a creature
// card from a graveyard: Create a 2/2 black Zombie creature token." Exercises two
// new activated-ability capabilities — the `exile_from_graveyard` cost (the chosen
// graveyard card is passed as the target) and the `create_token` effect.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function battlefieldTokens(s: Scenario, seat: 'A' | 'B'): Promise<number> {
  const res = await s.client.query<{ n: string }>(
    `select count(*) as n from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.controller_player_id = $2 and gc.zone = 'battlefield' and c.is_token = true`,
    [s.sessionId, s.players[seat]],
  )
  return Number(res.rows[0]?.n ?? 0)
}

// CR1 — pay the cost (exile a creature card from a graveyard) → create a Zombie token.
test('CR1 exiles the chosen graveyard creature and creates a Zombie token', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const reaper = await s.spawn('A', 'Cemetery Reaper Test', 'battlefield')
    const fodder = await s.spawn('B', 'Air Elemental Test', 'graveyard') // a creature card in B's graveyard
    await s.setMana('A', { B: 1, C: 2 }) // {2}{B}
    const tokensBefore = await battlefieldTokens(s, 'A')

    await s.as('A').activate(reaper, 0, { targetCardId: fodder })
    assert.equal(await s.zoneOf(fodder), 'exile') // exiled as a cost, immediately
    assert.equal((await s.cardState(reaper)).is_tapped, true) // {T} paid

    await s.as('A').resolveStack()
    assert.equal(await battlefieldTokens(s, 'A'), tokensBefore + 1) // token created
  })
})

// CR2 — the cost requires a graveyard target.
test('CR2 activating without a graveyard card to exile is rejected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const reaper = await s.spawn('A', 'Cemetery Reaper Test', 'battlefield')
    await s.setMana('A', { B: 1, C: 2 })

    await assert.rejects(() => s.as('A').activate(reaper, 0), /Choose a card in a graveyard/)
  })
})

// CR3 — the exiled card must match the filter (a creature card).
test('CR3 a non-creature graveyard card is not a legal cost', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const reaper = await s.spawn('A', 'Cemetery Reaper Test', 'battlefield')
    const sorcery = await s.spawn('B', 'Divination Test', 'graveyard') // a Sorcery, not a creature
    await s.setMana('A', { B: 1, C: 2 })

    await client.query('savepoint sp_cr3')
    await assert.rejects(
      () => s.as('A').activate(reaper, 0, { targetCardId: sorcery }),
      /not a matching card in a graveyard/,
    )
    await client.query('rollback to savepoint sp_cr3')

    assert.equal(await s.zoneOf(sorcery), 'graveyard') // unmoved
  })
})
