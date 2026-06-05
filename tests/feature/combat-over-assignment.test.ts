// Phase 4 — player-chosen combat damage OVER-ASSIGNMENT (mig 122). The attacker
// may distribute combat damage across blockers (and trample to the player) as it
// chooses, as long as each earlier blocker in order is assigned lethal before a
// later one (CR 510.1c). resolve_combat_damage now takes an optional assignments
// map; omitting it keeps the engine's auto minimum-lethal distribution.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// Declare A's attacker into two of B's blockers (declared in order b1, b2), land
// on the combat-damage step with A holding priority. Returns the ids.
async function twoBlockerCombat(s: Scenario, attackerName: string) {
  const attacker = await s.spawnCreature('A', attackerName)
  const b1 = await s.spawnCreature('B', 'Parting Gift Test') // 2/2
  const b2 = await s.spawnCreature('B', 'Parting Gift Test') // 2/2

  await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
  await s.as('A').declareAttacker(attacker, 'B')

  await s.setTurn({ phase: 'combat', step: 'declare_blockers', active: 'A', priority: 'B' })
  await s.as('B').declareBlocker(b1, attacker)
  await s.as('B').declareBlocker(b2, attacker)

  await s.setTurn({ phase: 'combat', step: 'combat_damage', active: 'A', priority: 'A' })
  return { attacker, b1, b2 }
}

// Blockers in the engine's resolution order (damage_assignment_order, created_at,
// id). Declaration order alone is not stable — equal order/created_at ties break
// on the random uuid — so over-assignment tests must read the real order.
async function blockerOrder(s: Scenario, attacker: string): Promise<string[]> {
  const res = await s.client.query<{ blocker_card_id: string }>(
    `select b.blocker_card_id
       from public.game_combat_blockers b
       join public.game_combat_assignments a on a.id = b.assignment_id
      where a.session_id = $1 and a.attacker_card_id = $2
      order by b.damage_assignment_order, b.created_at, b.id`,
    [s.sessionId, attacker],
  )
  return res.rows.map((r) => r.blocker_card_id)
}

// CO1 — over-assignment concentrates damage: a 4/4 dumps all 4 on the FIRST 2/2
// (lethal is 2), assigning 0 to the second. First dies, second survives.
test('CO1 attacker over-assigns all damage to the first blocker', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const { attacker } = await twoBlockerCombat(s, 'Pit Brawler Test') // 4/4
    const [first, second] = await blockerOrder(s, attacker)

    await s.as('A').resolveCombat({
      [attacker]: { blockers: [{ blocker_card_id: first, amount: 4 }, { blocker_card_id: second, amount: 0 }] },
    })

    assert.equal(await s.zoneOf(first), 'graveyard') // took 4, lethal
    assert.equal(await s.zoneOf(second), 'battlefield') // took 0, survives
  })
})

// CO2 — illegal: assigning the second blocker while the first has less than lethal
// is rejected (must assign lethal in order). Rejection is the last action so the
// aborted tx is never read afterwards (bug-236).
test('CO2 skipping an earlier blocker is rejected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const { attacker } = await twoBlockerCombat(s, 'Pit Brawler Test')
    const [first, second] = await blockerOrder(s, attacker)

    await assert.rejects(() =>
      s.as('A').resolveCombat({
        [attacker]: { blockers: [{ blocker_card_id: first, amount: 0 }, { blocker_card_id: second, amount: 4 }] },
      }),
    )
  })
})

// CO3 — no assignments => unchanged auto behavior: each 2/2 takes its lethal 2,
// both die. Guards against a regression in the default path.
test('CO3 auto-assignment (no input) is unchanged', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const { b1, b2 } = await twoBlockerCombat(s, 'Pit Brawler Test')

    await s.as('A').resolveCombat()

    assert.equal(await s.zoneOf(b1), 'graveyard')
    assert.equal(await s.zoneOf(b2), 'graveyard')
  })
})

// CO4 — player-chosen trample split: a 2/2 deathtouch trampler assigns 1 (lethal,
// via deathtouch) to its lone blocker and tramples the other 1 to the player.
test('CO4 trample remainder is assigned to the defending player as chosen', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const attacker = await s.spawnCreature('A', 'Deathtouch Trampler Test') // 2/2, deathtouch + trample
    const blocker = await s.spawnCreature('B', 'Parting Gift Test') // 2/2
    const startLife = await s.lifeOf('B')

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(attacker, 'B')
    await s.setTurn({ phase: 'combat', step: 'declare_blockers', active: 'A', priority: 'B' })
    await s.as('B').declareBlocker(blocker, attacker)
    await s.setTurn({ phase: 'combat', step: 'combat_damage', active: 'A', priority: 'A' })

    await s.as('A').resolveCombat({
      [attacker]: { blockers: [{ blocker_card_id: blocker, amount: 1 }], trample: 1 },
    })

    assert.equal(await s.lifeOf('B'), startLife - 1) // 1 trampled over
    assert.equal(await s.zoneOf(blocker), 'graveyard') // 1 deathtouch damage is lethal
  })
})
