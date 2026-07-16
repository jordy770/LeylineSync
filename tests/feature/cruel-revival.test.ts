// Cruel Revival (mig 220) — "Destroy target non-Zombie creature. Return up to
// one target Zombie card from your graveyard to your hand." The first NEGATIVE
// type restriction (exclude_type_line, validated at cast) + a caster
// graveyard-return rider parked by handle_permanent_effect.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// CR1 — destroy the non-Zombie, then pick a Zombie back from the graveyard.
test('CR1 destroy a non-Zombie, return a Zombie to hand', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const goblin = await s.spawnCreature('B', 'Goblin Raider Test') // non-Zombie target
    const deadZombie = await s.spawn('A', 'Grave Shambler Test', 'graveyard')

    await s.as('A').putOnStack('permanent_effect', {
      kind: 'destroy',
      target_card_id: goblin,
      target_type: 'creature',
      target_controller: 'any',
      then_return_from_graveyard: { filter: { type_line: 'Zombie' }, to: 'hand', count: 1 },
    })
    const res = (await s.as('A').resolveStack()) as Record<string, unknown>

    assert.equal(await s.zoneOf(goblin), 'graveyard') // destroyed
    assert.equal(res.awaiting_decision, true) // the return parks for the caster

    const d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'return_from_graveyard')
    await s.as('A').submitDecision(d!.id, { chosen: [deadZombie] })
    assert.equal(await s.zoneOf(deadZombie), 'hand')
  })
})

// CR2 — "up to one": declining leaves the graveyard untouched.
test('CR2 the return is optional', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const goblin = await s.spawnCreature('B', 'Goblin Raider Test')
    const deadZombie = await s.spawn('A', 'Grave Shambler Test', 'graveyard')

    await s.as('A').putOnStack('permanent_effect', {
      kind: 'destroy',
      target_card_id: goblin,
      target_type: 'creature',
      target_controller: 'any',
      then_return_from_graveyard: { filter: { type_line: 'Zombie' }, to: 'hand', count: 1 },
    })
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { chosen: [] })
    assert.equal(await s.zoneOf(deadZombie), 'graveyard')
  })
})

// CR3 — the negative restriction: a Zombie is not a legal target.
test('CR3 a Zombie cannot be targeted', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const zombie = await s.spawnCreature('B', 'Grave Shambler Test')

    await assert.rejects(
      () => s.as('A').putOnStack('permanent_effect', {
        kind: 'destroy',
        target_card_id: zombie,
        target_type: 'creature',
        target_controller: 'any',
        exclude_type_line: 'Zombie',
      }),
      /excluded type/i,
    )
  })
})

// CR4 (mig 413) — array exclude_type_line: a creature matching none of the listed
// types is a legal target (Victim of Night: "that isn't a Vampire, Werewolf, or Zombie").
test('CR4 multi-type exclusion allows a non-listed creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const goblin = await s.spawnCreature('B', 'Goblin Raider Test') // not V/W/Z
    await s.as('A').putOnStack('permanent_effect', {
      kind: 'destroy', target_card_id: goblin, target_type: 'creature', target_controller: 'any',
      exclude_type_line: ['Vampire', 'Werewolf', 'Zombie'],
    })
    await s.as('A').resolveStack()
    assert.equal(await s.zoneOf(goblin), 'graveyard')
  })
})

// CR5 — a creature matching ANY listed type (Zombie) is rejected.
test('CR5 multi-type exclusion rejects a listed type', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const zombie = await s.spawnCreature('B', 'Grave Shambler Test') // Zombie
    await assert.rejects(
      () => s.as('A').putOnStack('permanent_effect', {
        kind: 'destroy', target_card_id: zombie, target_type: 'creature', target_controller: 'any',
        exclude_type_line: ['Vampire', 'Werewolf', 'Zombie'],
      }),
      /excluded type/i,
    )
  })
})
