// Planeswalkers — core framework (roadmap Tribal #4, slice 1). A planeswalker enters
// with a starting loyalty (a 'loyalty' bag counter); its +N/−N/0 loyalty abilities are
// sorcery-speed, once per turn, pay loyalty as the cost, and the planeswalker dies at 0.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function loyalty(s: Scenario, card: string): Promise<number> {
  const r = await s.client.query<{ l: string | null }>(
    "select (counters ->> 'loyalty') as l from public.game_cards where id = $1",
    [card],
  )
  return r.rows[0]?.l == null ? 0 : Number(r.rows[0]!.l)
}

// PW1 — enters with starting loyalty; +1 raises loyalty and resolves its effect.
test('PW1 enters with loyalty; a + ability raises it and draws', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const pw = await s.spawn('A', 'Test Walker', 'battlefield')
    assert.equal(await loyalty(s, pw), 4) // starting loyalty
    await s.spawn('A', 'Air Elemental Test', 'library')
    const handBefore = await s.zoneCount('A', 'hand')

    await s.as('A').activateLoyalty(pw, 0) // +1: draw
    assert.equal(await loyalty(s, pw), 5)
    await s.as('A').resolveStack()

    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 1)
  })
})

// PW2 — only one loyalty ability per planeswalker per turn.
test('PW2 only one loyalty ability per turn', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const pw = await s.spawn('A', 'Test Walker', 'battlefield')
    await s.spawn('A', 'Air Elemental Test', 'library')

    await s.as('A').activateLoyalty(pw, 0)
    await s.as('A').resolveStack() // clear the stack so the 2nd attempt fails on once-per-turn, not stack-empty
    await assert.rejects(() => s.as('A').activateLoyalty(pw, 0), /already activated a loyalty ability this turn/)
  })
})

// PW3 — a −N ability pays loyalty and resolves; loyalty drops.
test('PW3 a minus ability pays loyalty and drains opponents', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const pw = await s.spawn('A', 'Test Walker', 'battlefield')
    const bBefore = await s.lifeOf('B')

    await s.as('A').activateLoyalty(pw, 1) // -2: each opponent loses 2
    assert.equal(await loyalty(s, pw), 2)
    await s.as('A').resolveStack()

    assert.equal(await s.lifeOf('B'), bBefore - 2)
  })
})

// PW4 — a −N ability with insufficient loyalty is rejected.
test('PW4 insufficient loyalty is rejected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const pw = await s.spawn('A', 'Test Walker', 'battlefield') // loyalty 4
    await s.client.query("update public.game_cards set counters = '{\"loyalty\":1}'::jsonb where id = $1", [pw])

    // The raising RPC aborts the tx; a savepoint lets us read state afterwards.
    await s.client.query('savepoint pw4')
    await assert.rejects(() => s.as('A').activateLoyalty(pw, 1), /[Nn]ot enough loyalty/) // -2 needs 2
    await s.client.query('rollback to savepoint pw4')
    assert.equal(await loyalty(s, pw), 1) // unchanged
  })
})

// PW5 — paying loyalty to 0 (an ultimate) sends the planeswalker to the graveyard,
// but its ability still resolves.
test('PW5 zero loyalty dies; the ability still resolves', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const pw = await s.spawn('A', 'Test Walker', 'battlefield') // loyalty 4
    const aBefore = await s.lifeOf('A')

    await s.as('A').activateLoyalty(pw, 2) // -4: gain 5 (loyalty 4 → 0)
    assert.equal(await s.zoneOf(pw), 'graveyard') // 0 loyalty SBA
    await s.as('A').resolveStack()

    assert.equal(await s.lifeOf('A'), aBefore + 5) // ability still resolved
  })
})
