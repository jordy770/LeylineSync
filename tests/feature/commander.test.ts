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

// CM6 — creating with format 'commander' starts BOTH the host and a late joiner at
// 40 (the late-joiner life fix: join reads the session format).
test('CM6 a commander game starts every player at 40, including joiners', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 2, { format: 'commander' })
    assert.equal(await s.lifeOf('A'), 40) // host
    assert.equal(await s.lifeOf('B'), 40) // joined after create
  })
})

// CD1 — 21 combat damage from one commander loses the game for that player.
test('CD1 21 commander combat damage is lethal', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 2, { format: 'commander' })
    const cmdr = await s.spawnCommander('A', 'Goblin Raider Test')

    await s.as('A').applyDamageToPlayer('B', 21, cmdr, true)

    assert.equal(await s.commanderDamage('B', cmdr), 21)
    assert.equal(await s.lifeOf('B'), 0) // loses despite starting at 40
  })
})

// CD2 — commander damage accumulates; it only becomes lethal once it reaches 21.
test('CD2 commander damage accumulates to the lethal threshold', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 2, { format: 'commander' })
    const cmdr = await s.spawnCommander('A', 'Goblin Raider Test')

    await s.as('A').applyDamageToPlayer('B', 20, cmdr, true)
    assert.equal(await s.commanderDamage('B', cmdr), 20)
    assert.equal(await s.lifeOf('B'), 20) // 40 - 20, still alive

    await s.as('A').applyDamageToPlayer('B', 1, cmdr, true) // → 21
    assert.equal(await s.lifeOf('B'), 0)
  })
})

// CD3 — only COMBAT damage from a COMMANDER counts toward commander damage.
test('CD3 non-combat and non-commander damage is not tracked', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 2, { format: 'commander' })
    const cmdr = await s.spawnCommander('A', 'Goblin Raider Test')
    const plain = await s.spawnCreature('A', 'Air Elemental Test') // not a commander

    await s.as('A').applyDamageToPlayer('B', 5, cmdr, false) // commander, but NOT combat
    await s.as('A').applyDamageToPlayer('B', 5, plain, true) // combat, but NOT a commander

    assert.equal(await s.commanderDamage('B', cmdr), 0)
    assert.equal(await s.commanderDamage('B', plain), 0)
    assert.equal(await s.lifeOf('B'), 30) // 40 - 5 - 5, just normal life loss
  })
})
