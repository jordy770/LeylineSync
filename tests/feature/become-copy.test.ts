// mig 240 — become_copy: an EXISTING card becomes a copy of another.
//   • Deceptive Frostkite: "you may have this enter as a copy of a creature
//     you control with power 4 or greater" (+ flying via except).
//   • Sarkhan, Soul Aflame: "whenever a Dragon you control enters, you may
//     have Sarkhan become a copy of it until end of turn, except it has
//     haste" — reverts when the end step is left.
//   • Leaving the battlefield reverts to the printed card (the graveyard card
//     is the original).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function cardName(s: Scenario, gameCardId: string): Promise<string> {
  const r = await s.client.query<{ name: string }>(
    `select c.name from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.id = $1`, [gameCardId])
  return r.rows[0]!.name
}

async function keywordRows(s: Scenario, gameCardId: string, kind: string): Promise<number> {
  const r = await s.client.query(
    `select 1 from public.game_continuous_effects
     where session_id = $1 and affected_card_id = $2 and effect_type = $3`,
    [s.sessionId, gameCardId, kind])
  return r.rows.length
}

// BC1 — Frostkite enters as a copy of a power-4+ creature you control.
test('BC1 Frostkite enter-as-copy offers only power-4+ creatures and copies the pick', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const big = await s.spawnCreature('A', 'Dragon Token') // 5/5
    await s.spawnCreature('A', 'Rapacious Dragon Test') // 3/3 — below min_power
    const kite = await s.spawnCreature('A', 'Deceptive Frostkite Test')

    await s.as('A').resolveStack() // Frostkite's own ETB (top of stack)
    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'become_copy')
    assert.equal(d!.min_choices, 0) // "you may"
    const offered = (d!.options as { game_card_id: string }[]).map((o) => o.game_card_id)
    assert.deepEqual(offered, [big]) // not the 3/3, not Frostkite itself
    await s.as('A').submitDecision(d!.id, { chosen: [big] })

    assert.equal(await cardName(s, kite), 'Dragon Token')
    assert.equal(await s.effectivePower(kite), 5)
    assert.ok((await keywordRows(s, kite, 'flying')) >= 1) // except-keyword grant
    const cols = await s.client.query<{ o: string | null }>(
      'select copy_original_card_id as o from public.game_cards where id = $1', [kite])
    assert.ok(cols.rows[0]!.o)
  })
})

// BC2 — a dead copy reverts: the graveyard card is the printed Frostkite.
test('BC2 dying as a copy reverts to the printed card in the graveyard', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const big = await s.spawnCreature('A', 'Dragon Token')
    const kite = await s.spawnCreature('A', 'Deceptive Frostkite Test')
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { chosen: [big] })
    assert.equal(await cardName(s, kite), 'Dragon Token')

    await s.putInGraveyard(kite)
    const row = await s.client.query<{ zone: string; o: string | null }>(
      'select zone, copy_original_card_id as o from public.game_cards where id = $1', [kite])
    assert.equal(row.rows[0]!.zone, 'graveyard') // nontoken: it persists
    assert.equal(row.rows[0]!.o, null)
    assert.equal(await cardName(s, kite), 'Deceptive Frostkite Test')
    assert.equal(await keywordRows(s, kite, 'flying'), 0) // sourced rows dropped
  })
})

// BC3 — Sarkhan copies an entering Dragon until end of turn, with haste.
test('BC3 Sarkhan becomes the entering Dragon until end of turn', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const sarkhan = await s.spawnCreature('A', 'Sarkhan, Soul Aflame Test') // 5/5 Human
    await s.spawnCreature('A', 'Dragon Token') // fires Sarkhan's watcher

    await s.as('A').resolveStack() // watcher trigger -> become_copy pick
    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'become_copy')
    const offered = (d!.options as { game_card_id: string }[]).map((o) => o.game_card_id)
    assert.equal(offered.length, 1)
    await s.as('A').submitDecision(d!.id, { chosen: offered })

    assert.equal(await cardName(s, sarkhan), 'Dragon Token')
    assert.ok((await keywordRows(s, sarkhan, 'haste')) >= 1)

    // Leaving the end step reverts him.
    await s.setTurn({ phase: 'ending', step: 'end', active: 'A', priority: 'A' })
    await s.as('A').advanceStep('A')
    assert.equal(await cardName(s, sarkhan), 'Sarkhan, Soul Aflame Test')
    assert.equal(await keywordRows(s, sarkhan, 'haste'), 0)
    const cols = await s.client.query<{ t: number | null }>(
      'select copy_revert_at_turn as t from public.game_cards where id = $1', [sarkhan])
    assert.equal(cols.rows[0]!.t, null)
  })
})

// BC4 — the pick is a "may": an empty submit declines and nothing changes.
test('BC4 declining the become-copy pick leaves the card unchanged', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const sarkhan = await s.spawnCreature('A', 'Sarkhan, Soul Aflame Test')
    await s.spawnCreature('A', 'Dragon Token')

    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { chosen: [] })

    assert.equal(await cardName(s, sarkhan), 'Sarkhan, Soul Aflame Test')
    assert.equal(await keywordRows(s, sarkhan, 'haste'), 0)
  })
})
