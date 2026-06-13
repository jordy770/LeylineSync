// Circle of Power (no migration): the spell makes a 0/1 black Wizard token whose
// own catalog script carries "whenever you cast a noncreature spell, this token
// deals 1 damage to each opponent" (a spell_cast + exclude_type:'Creature'
// trigger — mig 292). The token's ability fires straight from the watcher.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// CIRC1 — a Wizard token on the battlefield pings each opponent when its
// controller casts a noncreature spell.
test('CIRC1 the Wizard token pings each opponent on a noncreature cast', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawnCreature('A', 'Wizard Token')
    const spark = await s.spawn('A', 'Spellcraft Spark Test', 'hand') // Sorcery (noncreature)

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { R: 1 })
    const bLife = await s.lifeOf('B')

    await s.as('A').castSpellEffect([{ type: 'draw', amount: 1, recipient: 'controller' }], spark)
    await s.as('A').resolveStack()

    assert.equal(await s.lifeOf('B'), bLife - 1) // token dealt 1 to the opponent
  })
})

// CIRC2 — casting Circle draws 2, loses 2, and creates the Wizard token.
test('CIRC2 Circle draws two, loses two, and makes a Wizard token', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const circle = await s.spawn('A', 'Circle Test', 'hand')
    await s.spawn('A', 'Air Elemental Test', 'library')
    await s.spawn('A', 'Air Elemental Test', 'library')

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { U: 1, B: 1, C: 2 })
    const aLife = await s.lifeOf('A')

    await s.as('A').castSpellEffect(
      [
        { type: 'draw', amount: 2, recipient: 'controller' },
        { type: 'lose_life', amount: 2, recipient: 'controller' },
        { type: 'create_token', token: 'Wizard Token', count: 1 },
      ],
      circle,
    )
    await s.as('A').resolveStack()

    assert.equal(await s.lifeOf('A'), aLife - 2) // lost 2
    const wiz = await client.query(
      `select count(*)::int n from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and c.name = 'Wizard Token' and gc.zone = 'battlefield'`,
      [s.sessionId],
    )
    assert.equal(wiz.rows[0].n, 1) // a Wizard token was created
  })
})
