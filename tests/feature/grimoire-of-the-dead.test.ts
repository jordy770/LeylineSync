// Grimoire of the Dead (mig 214) — "{1}, {T}, Discard a card: put a study
// counter on ~." / "{T}, Remove three study counters and sacrifice it: put ALL
// creature cards from ALL graveyards onto the battlefield under your control."
// New discard + remove_counters activation costs; untargeted add_counters via
// the spell_effect route; return_all_from_graveyard from:'all_graveyards'.
// (The "black Zombies in addition" type change is not modelled.)

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function bag(s: Scenario, id: string, key: string): Promise<number> {
  const r = await s.client.query<{ n: string | null }>(
    `select counters ->> $2 as n from public.game_cards where id = $1`, [id, key])
  return Number(r.rows[0]?.n ?? 0)
}

// GD1 — ability 1: pay {1}, tap, discard → a study counter lands on the Grimoire.
test('GD1 study counters accumulate via the discard ability', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const grimoire = await s.spawn('A', 'Grimoire of the Dead Test', 'battlefield')
    const fodder = await s.spawn('A', 'Goblin Raider Test', 'hand')
    await s.setMana('A', { C: 1 })

    await s.as('A').activate(grimoire, 0, { targetCardId: fodder })
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(fodder), 'graveyard') // discarded
    assert.equal(await bag(s, grimoire, 'study'), 1)
  })
})

// GD2 — ability 2: with three study counters, the Grimoire sacrifices itself and
// every creature card in every graveyard comes back under YOUR control.
test('GD2 mass reanimation from all graveyards under your control', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const grimoire = await s.spawn('A', 'Grimoire of the Dead Test', 'battlefield')
    await s.client.query(
      `update public.game_cards set counters = '{"study": 3}'::jsonb where id = $1`, [grimoire])
    const mine = await s.spawn('A', 'Goblin Raider Test', 'graveyard')
    const theirs = await s.spawn('B', 'Grave Shambler Test', 'graveyard')
    const theirSorcery = await s.spawn('B', 'Opt Test', 'graveyard') // not a creature

    await s.as('A').activate(grimoire, 1)
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(grimoire), 'graveyard') // sacrificed as a cost
    assert.equal(await s.zoneOf(mine), 'battlefield')
    assert.equal(await s.zoneOf(theirs), 'battlefield')
    assert.equal(await s.zoneOf(theirSorcery), 'graveyard') // creatures only
    const ctrl = await s.client.query<{ c: string }>(
      'select controller_player_id as c from public.game_cards where id = $1', [theirs])
    assert.equal(ctrl.rows[0]!.c, s.playerId('A')) // under YOUR control
  })
})

// GD3 — without three study counters, ability 2 is refused.
test('GD3 needs three study counters', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const grimoire = await s.spawn('A', 'Grimoire of the Dead Test', 'battlefield')
    await s.client.query(
      `update public.game_cards set counters = '{"study": 2}'::jsonb where id = $1`, [grimoire])

    await assert.rejects(() => s.as('A').activate(grimoire, 1), /study counters/i)
  })
})
