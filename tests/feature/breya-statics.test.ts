// mig 268 — Breya statics + sweepers: CDA artifacts count (Master of
// Etherium), count 'times' multiplier (Filigree Angel), deal_damage_all
// exclude_type (Whipflare), destroy_all types (Nevinyrral's Disk).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// BS1 — Master of Etherium: */* = artifacts you control (itself included),
// and other artifact creatures get +1/+1.
test('BS1 Master of Etherium star PT and artifact anthem', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const master = await s.spawnCreature('A', 'Master Etherium Test')
    await s.spawn('A', 'Ichor Wellspring Test', 'battlefield')
    const strixish = await s.spawnCreature('A', 'Counter Walker Test') // artifact creature 0/0
    await s.as('A').resolveStack() // flush Wellspring draw trigger (may be empty stack? it draws)

    // 3 artifacts: Master + Wellspring + Walker.
    assert.equal(await s.effectivePower(master), 3)
    // Walker: 0 base + 2 counters (enters with two) + 1 anthem = 3.
    assert.equal(await s.effectivePower(strixish), 3)
  })
})

// BS2 — Filigree Angel: 3 life per artifact.
test('BS2 Filigree Angel gains three per artifact', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Ichor Wellspring Test', 'battlefield')
    const before = await s.client.query<{ life_total: number }>(
      'select life_total from public.game_session_players where session_id = $1 and player_id = $2',
      [s.sessionId, s.players.A])

    await s.spawnCreature('A', 'Filigree Angel Test') // itself an artifact → 2 artifacts
    await s.as('A').resolveStack()

    const after = await s.client.query<{ life_total: number }>(
      'select life_total from public.game_session_players where session_id = $1 and player_id = $2',
      [s.sessionId, s.players.A])
    assert.equal(after.rows[0]!.life_total, before.rows[0]!.life_total + 6) // 2 × 3
  })
})

// BS3 — Whipflare: 2 to each NONARTIFACT creature.
test('BS3 Whipflare spares artifact creatures', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const flesh = await s.spawnCreature('B', 'Dino Grunt Test') // 3/3 nonartifact
    const metal = await s.spawnCreature('B', 'Master Etherium Test') // artifact creature

    await s.as('A').castSpellEffect([
      { type: 'deal_damage_all', amount: 2, filter: { exclude_type: 'artifact' } }])
    await s.as('A').resolveStack()

    const f = await s.client.query<{ damage_marked: number }>(
      'select damage_marked from public.game_cards where id = $1', [flesh])
    assert.equal(f.rows[0]!.damage_marked, 2)
    const m = await s.client.query<{ damage_marked: number }>(
      'select damage_marked from public.game_cards where id = $1', [metal])
    assert.equal(m.rows[0]!.damage_marked, 0) // artifact spared
  })
})

// BS4 — Nevinyrral's Disk: wipes artifacts, creatures, enchantments — and
// itself; an indestructible artifact land survives.
test('BS4 Nevinyrral Disk wipes the board including itself', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const disk = await s.spawn('A', 'Nevinyrral Disk Test', 'battlefield')
    await s.client.query('update public.game_cards set is_tapped = false where id = $1', [disk])
    const dino = await s.spawnCreature('B', 'Dino Grunt Test')
    const land = await s.spawn('A', 'Forest Test', 'battlefield') // land — untouched

    await s.setMana('A', { C: 1 })
    await s.as('A').activate(disk, 0)
    await s.as('A').resolveStack()

    for (const [id, zone] of [[disk, 'graveyard'], [dino, 'graveyard'], [land, 'battlefield']] as const) {
      const r = await s.client.query<{ zone: string }>(
        'select zone from public.game_cards where id = $1', [id])
      assert.equal(r.rows[0]!.zone, zone)
    }
  })
})
