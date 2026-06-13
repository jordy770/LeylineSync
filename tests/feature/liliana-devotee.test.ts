// Liliana's Devotee (mig 197) — "At the beginning of your end step, if a creature
// died this turn, you may pay {1}{B}. If you do, create a 2/2 black Zombie." The
// `may` effect now supports an optional condition gate (creatures_died_this_turn)
// and an optional mana cost paid on confirm.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function zombieTokens(s: Scenario): Promise<number> {
  const r = await s.client.query<{ n: string }>(
    `select count(*) as n from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.controller_player_id = $2 and gc.zone = 'battlefield' and c.name = 'Zombie Token'`,
    [s.sessionId, s.players.A],
  )
  return Number(r.rows[0]?.n ?? 0)
}

async function killACreature(s: Scenario): Promise<void> {
  const v = await s.spawnCreature('A', 'Grave Shambler Test')
  await s.as('A').putOnStack('destroy_creature', { target_card_id: v, target_controller: 'any' })
  await s.as('A').resolveStack()
}

// LD1 — a creature died, and the player pays {1}{B): a Zombie token is created.
test('LD1 pays the optional cost to make a Zombie after a death', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', "Liliana's Devotee Test", 'battlefield')
    await killACreature(s) // creatures_died_this_turn = 1
    await s.setMana('A', { C: 1, B: 1 }) // {1}{B}

    await s.setTurn({ phase: 'ending', step: 'end', active: 'A', priority: 'A' })
    await s.as('A').resolveStack() // end-step trigger → may offered

    const d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'confirm')
    await s.as('A').submitDecision(d!.id, { confirmed: true })

    assert.equal(await zombieTokens(s), 1)
    assert.equal((await s.manaOf('A')).B, 0) // {1}{B} was paid
  })
})

// LD2 — no creature died: the may is not even offered (condition gate).
test('LD2 the may is not offered when no creature died this turn', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawn('A', "Liliana's Devotee Test", 'battlefield')

    await s.setTurn({ phase: 'ending', step: 'end', active: 'A', priority: 'A' })
    await s.as('A').resolveStack()

    assert.equal(await s.pendingDecision(), null) // no decision parked
    assert.equal(await zombieTokens(s), 0)
  })
})

// LD3 — a creature died but the player declines: no token, no mana spent.
test('LD3 declining the may makes no token', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', "Liliana's Devotee Test", 'battlefield')
    await killACreature(s)
    await s.setMana('A', { C: 1, B: 1 })

    await s.setTurn({ phase: 'ending', step: 'end', active: 'A', priority: 'A' })
    await s.as('A').resolveStack()

    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { confirmed: false })

    assert.equal(await zombieTokens(s), 0)
    assert.equal((await s.manaOf('A')).B, 1) // mana untouched
  })
})
