// Tier-2 effect: grant_keyword spell/combat-trick path (migration 100). A
// non-permanent spell whose effect is "target creature gains <keyword> until end
// of turn" — cast via put_action_on_stack ('grant_keyword_creature'), resolved by
// apply_creature_effect (same until-EOT continuous effect as the trigger path).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// GK3 — cast as an instant: the chosen creature gains the keyword, and the grant
// lapses at end-of-turn cleanup (the same lifecycle as the trigger path).
test('GK3 grant_keyword_creature spell grants a keyword until end of turn', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const bear = await s.spawnCreature('A', 'Deathtouch Viper Test') // vanilla target (no reach)
    assert.equal(await s.continuousEffectCount(bear, 'reach'), 0)

    await s.as('A').putOnStack('grant_keyword_creature', { target_card_id: bear, keyword: 'reach' })
    await s.resolveStack()

    assert.equal(await s.continuousEffectCount(bear, 'reach'), 1)

    await s.as('A').expireEffects('ending', 'cleanup')
    assert.equal(await s.continuousEffectCount(bear, 'reach'), 0)
  })
})

// GK4 — keyword validation: an unsupported keyword is rejected at cast time.
test('GK4 grant_keyword_creature rejects an unsupported keyword', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const bear = await s.spawnCreature('A', 'Deathtouch Viper Test')
    await assert.rejects(
      () => s.as('A').putOnStack('grant_keyword_creature', { target_card_id: bear, keyword: 'menace' }),
    )
  })
})

// GK5 — controller restriction flows through the shared creature-target check:
// a "you control" grant cannot target an opponent's creature.
test('GK5 grant_keyword_creature honors target_controller', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const oppCreature = await s.spawnCreature('B', 'Air Elemental Test')
    await assert.rejects(
      () => s.as('A').putOnStack('grant_keyword_creature', {
        target_card_id: oppCreature,
        keyword: 'flying',
        target_controller: 'you',
      }),
    )
  })
})
