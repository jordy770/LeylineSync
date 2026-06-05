// Commander (EDH) slice 1 — the in-game command zone (mig 136). A commander is
// cast from the command zone at sorcery speed paying commander tax (+{2} per prior
// cast), is returned to the command zone instead of the graveyard on death, and a
// Commander game starts at 40 life.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function commanderCasts(s: Scenario, card: string): Promise<number> {
  const res = await s.client.query<{ command_zone_casts: number }>(
    'select command_zone_casts from public.game_cards where id = $1',
    [card],
  )
  return Number(res.rows[0]?.command_zone_casts ?? 0)
}

// CM1 — first cast from the command zone (tax 0) resolves to the battlefield and
// bumps the cast counter.
test('CM1 a commander is cast from the command zone (no tax first time)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { R: 1 })
    const cmdr = await s.spawnCommander('A', 'Goblin Raider Test') // {R} creature

    await s.as('A').castCommander(cmdr)
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(cmdr), 'battlefield')
    assert.equal(await commanderCasts(s, cmdr), 1)
    assert.equal((await s.manaOf('A')).R, 0) // {R} paid
  })
})

// CM2 — a commander returns to the command zone instead of the graveyard on death.
test('CM2 a dying commander returns to the command zone', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const cmdr = await s.spawnCommander('A', 'Goblin Raider Test')
    // Put it on the battlefield (as if already cast), then destroy it.
    await s.client.query("update public.game_cards set zone = 'battlefield' where id = $1", [cmdr])

    await s.as('A').putInGraveyard(cmdr)

    assert.equal(await s.zoneOf(cmdr), 'command') // not 'graveyard'
  })
})

// CM3 — commander tax is required: a second cast costs +{2} and fails without it.
test('CM3 the second cast requires commander tax', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { R: 1 }) // base only, no tax
    const cmdr = await s.spawnCommander('A', 'Goblin Raider Test')
    await s.client.query('update public.game_cards set command_zone_casts = 1 where id = $1', [cmdr])

    await assert.rejects(() => s.as('A').castCommander(cmdr), /not enough mana/i)
  })
})

// CM4 — with the tax paid, the second cast succeeds and the counter climbs.
test('CM4 the second cast succeeds when the tax is paid', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { R: 1, C: 2 }) // {R} + {2} tax
    const cmdr = await s.spawnCommander('A', 'Goblin Raider Test')
    await s.client.query('update public.game_cards set command_zone_casts = 1 where id = $1', [cmdr])

    await s.as('A').castCommander(cmdr)
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(cmdr), 'battlefield')
    assert.equal(await commanderCasts(s, cmdr), 2)
    const mana = await s.manaOf('A')
    assert.equal(mana.R, 0)
    assert.equal(mana.C, 0)
  })
})

// CM5 — a Commander game starts at 40 life.
test('CM5 set_commander_format sets the format and 40 life', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    assert.equal(await s.lifeOf('A'), 20) // default before
    await s.as('A').setCommanderFormat()
    assert.equal(await s.lifeOf('A'), 40)
    assert.equal(await s.lifeOf('B'), 40)
  })
})
