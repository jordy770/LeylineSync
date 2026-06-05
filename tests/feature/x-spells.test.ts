// Phase 1, slice 12 — X spells (variable amount paid as {X} generic mana).
// The caster chooses X at cast; the engine charges {X} generic mana and the
// SERVER substitutes the chosen value into the effect amount (script writes the
// literal "X"). Covers both cast paths: targeted Fireball (put_action_on_stack)
// and untargeted Mind Spring (cast_spell_effect, which now also pays mana).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// X1 — targeted Fireball deals X to a creature; {X}{R} is actually charged.
test('X1 Fireball deals X damage to a creature and pays {X} mana', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { R: 1, C: 5 })
    const fireball = await s.spawn('A', 'Fireball Test', 'hand')
    const target = await s.spawn('B', 'Air Elemental Test', 'battlefield') // 4/4

    await s.as('A').putOnStack('deal_damage_creature', { target_card_id: target, amount: 'X', x_value: 2 }, fireball)
    await s.as('A').resolveStack()

    const st = await s.cardState(target)
    assert.equal(st.damage_marked, 2) // X resolved to 2, not a fixed number
    assert.equal(st.zone, 'battlefield') // 2 < 4 toughness, survives

    const mana = await s.manaOf('A')
    assert.equal(mana.R, 0) // colored {R} paid
    assert.equal(mana.C, 3) // {X}=2 generic paid from C (5 -> 3)
  })
})

// X2 — targeted Fireball to a player, charged the same way.
test('X2 Fireball deals X damage to a player', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { R: 1, C: 4 })
    const fireball = await s.spawn('A', 'Fireball Test', 'hand')

    await s.as('A').putOnStack('deal_damage_player', { target_player_id: s.playerId('B'), amount: 'X', x_value: 3 }, fireball)
    await s.as('A').resolveStack()

    assert.equal(await s.lifeOf('B'), 17) // 20 - X(3)
    const mana = await s.manaOf('A')
    assert.equal(mana.R, 0)
    assert.equal(mana.C, 1) // 4 - 3 generic
  })
})

// X3 — {X} is real gating: not enough generic mana for the chosen X rejects.
test('X3 Fireball rejects when X cannot be paid', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { R: 1 }) // no generic mana for {X}
    const fireball = await s.spawn('A', 'Fireball Test', 'hand')
    const target = await s.spawn('B', 'Air Elemental Test', 'battlefield')

    await assert.rejects(
      () => s.as('A').putOnStack('deal_damage_creature', { target_card_id: target, amount: 'X', x_value: 3 }, fireball),
      /generic cost/,
    )
  })
})

// X4 — untargeted Mind Spring draws X via the program path; {X}{U} is charged.
test('X4 Mind Spring draws X cards and pays {X} mana', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { U: 1, C: 3 })
    for (let i = 0; i < 3; i++) await s.spawn('A', 'Air Elemental Test', 'library')
    const mindSpring = await s.spawn('A', 'Mind Spring Test', 'hand')

    await s.as('A').castSpellEffect([{ type: 'draw', amount: 'X' }], mindSpring, 3)
    await s.as('A').resolveStack()

    assert.equal(await s.zoneCount('A', 'hand'), 3) // drew 3 (Mind Spring left to graveyard)
    assert.equal(await s.zoneCount('A', 'library'), 0)
    const mana = await s.manaOf('A')
    assert.equal(mana.U, 0)
    assert.equal(mana.C, 0) // 3 - X(3)
  })
})

// X5 — the untargeted path gates on {X} too (cast_spell_effect now pays mana).
test('X5 Mind Spring rejects when X cannot be paid', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { U: 1 }) // no generic mana for {X}
    const mindSpring = await s.spawn('A', 'Mind Spring Test', 'hand')

    await assert.rejects(
      () => s.as('A').castSpellEffect([{ type: 'draw', amount: 'X' }], mindSpring, 3),
      /generic cost/,
    )
  })
})
