// Bucket-4 slice (mig 437) — situational cost reduction + riders:
// - CR1 verifies the EXISTING nth_spell static (mig 369) actually reduces the
//   second spell each turn (Alisaie — the backlog flag was stale).
// - opponent_graveyard_cards count for cost_reduction.if (Into the Story).
// - exclude_type_line on static cost_reduction rows (Lyse Hext: "noncreature
//   spells you cast cost {1} less").
// - spell_countered watcher event fired by handle_counter_spell (Baral's
//   "whenever a spell or ability you control counters a spell, you may draw a
//   card; if you do, discard a card").
// - grant_type effect: an until-end-of-turn granted_type 'add' on the source
//   (Nogi: "until end of turn, Nogi becomes a Dragon...").

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// CR1 — the second spell this turn is {2} cheaper (nth_spell static).
test('CR1 nth_spell reduces the second spell of the turn', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Dualcast Sage Test', 'battlefield')
    const first = await s.spawn('A', 'Blue Ideas Test', 'hand') // {2}{U}
    const second = await s.spawn('A', 'Blue Ideas Test', 'hand') // {2}{U} → {U} as 2nd spell
    await s.spawn('A', 'Island Test', 'library')
    await s.spawn('A', 'Island Test', 'library')
    await s.setMana('A', { U: 2, C: 2 }) // full first cast + reduced second

    await s.as('A').castSpellEffect([{ type: 'draw', amount: 1 }], first)
    await s.as('A').resolveStack()
    await s.as('A').castSpellEffect([{ type: 'draw', amount: 1 }], second)
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(second), 'graveyard') // second cast succeeded on {U} alone
  })
})

// CR2 — {3} cheaper once an opponent has seven or more graveyard cards.
test('CR2 opponent_graveyard_cards gates the self reduction', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Story Draw Test', 'hand') // {5}{U}{U} → {2}{U}{U}
    for (let i = 0; i < 7; i++) await s.spawn('B', 'Island Test', 'graveyard')
    for (let i = 0; i < 4; i++) await s.spawn('A', 'Island Test', 'library')
    await s.setMana('A', { U: 2, C: 2 }) // covers only the reduced cost

    await s.as('A').castSpellEffect([{ type: 'draw', amount: 4 }], spell)
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(spell), 'graveyard')
    assert.equal(await s.zoneCount('A', 'hand'), 4)
  })
})

// CR2b — six graveyard cards is not enough: full price applies.
test('CR2b below the graveyard bar the full cost is charged', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Story Draw Test', 'hand')
    for (let i = 0; i < 6; i++) await s.spawn('B', 'Island Test', 'graveyard')
    await s.setMana('A', { U: 2, C: 2 })
    await assert.rejects(
      () => s.as('A').castSpellEffect([{ type: 'draw', amount: 4 }], spell),
      /not enough .*mana/i,
    )
  })
})

// CR3 — the noncreature discount skips creature spells.
test('CR3 exclude_type_line discounts noncreature spells only', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Noncreature Discount Test', 'battlefield')
    const sorcery = await s.spawn('A', 'Blue Ideas Test', 'hand') // {2}{U} → {1}{U}
    await s.spawn('A', 'Island Test', 'library')
    await s.setMana('A', { U: 1, C: 1 })

    await s.as('A').castSpellEffect([{ type: 'draw', amount: 1 }], sorcery)
    await s.as('A').resolveStack()
    assert.equal(await s.zoneOf(sorcery), 'graveyard') // discounted cast succeeded
  })
})

// CR3b — a creature spell gets no discount from the noncreature static.
test('CR3b creature spells pay full price under the noncreature static', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Noncreature Discount Test', 'battlefield')
    const brute = await s.spawn('A', 'Menace Brute Test', 'hand') // {2}{R}
    await s.setMana('A', { R: 1, C: 1 }) // one generic short of full price
    await assert.rejects(() => s.as('A').castPermanent(brute), /not enough .*mana/i)
  })
})

// CR4 — countering a spell fires the spell_countered watcher; the may-program
// draws then parks the discard.
test('CR4 spell_countered watcher loots after a counter', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Counter Scholar Test', 'battlefield')
    await s.spawn('A', 'Island Test', 'library')

    // B casts a spell; A counters it.
    const opt = await s.spawn('B', 'Opt Test', 'hand')
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'B', priority: 'B' })
    const cast = await s.as('B').castSpellEffect([{ type: 'draw', amount: 1 }], opt)
    const counterSource = await s.spawn('A', 'Doom Blade Test', 'hand')
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'B', priority: 'A' })
    await s.as('A').putOnStack('counter_spell', { target_stack_item_id: cast.id }, counterSource)
    await s.resolveStack() // counter resolves → cancels + fires spell_countered

    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack() // the scholar trigger
    const may = await s.pendingDecision()
    assert.ok(may, 'the may-loot decision parked')
    await s.as('A').submitDecision(may.id, { confirmed: true })
    // program:true runs the inner effects as a fresh stack item — resolve it.
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()

    const discard = await s.pendingDecision()
    assert.ok(discard, 'the discard chooser parked after the draw')
    const offered = (discard.options as Array<{ game_card_id: string }>).map((o) => o.game_card_id)
    assert.ok(offered.length >= 1)
    await s.as('A').submitDecision(discard.id, { chosen: [offered[0]] })
    assert.equal(await s.pendingCount(), 0)
  })
})

// CR5 — grant_type adds the type until end of turn.
test('CR5 grant_type adds Dragon to the effective type line', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const zealot = await s.spawn('A', 'Draco Zealot Test', 'battlefield')

    await s.as('A').fireTriggers('A', zealot, ['attacks'])
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()

    const { rows } = await client.query<{ tl: string }>(
      'select public.effective_type_line($1, $2) as tl',
      [s.sessionId, zealot],
    )
    assert.match(rows[0]?.tl ?? '', /dragon/i)
  })
})
