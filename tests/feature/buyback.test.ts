// Buyback (mig 430, Disturbed Burial / Mind Games) — "You may pay an
// additional {N} as you cast this spell. If you do, put this card into your
// hand as it resolves." cast_spell_effect and put_action_on_stack gain a
// p_buyback flag: the script's `buyback` cost is paid ON TOP of the printed
// cost and the item payload is stamped; finalize_stack_resolution then pulls
// the card back from the graveyard (where the cast put it) into its owner's
// hand. A countered spell is cancelled (handle_counter_spell) and never
// reaches finalize, so it stays in the graveyard.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

const RECALL_ACTIONS = [{ type: 'return_from_graveyard', to: 'hand', count: 1, filter: { type_line: 'creature' } }]

// BB1 — the full cast_spell_effect path, including a parked decision: pay
// printed + buyback, resolve, pick, and the spell ends in hand, not graveyard.
test('BB1 buyback spell returns to hand as it resolves (decision path)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Buyback Recall Test', 'hand')
    const raider = await s.spawn('A', 'Goblin Raider Test', 'graveyard')
    await s.setMana('A', { B: 2, C: 3 }) // printed {1}{B} + buyback {3}

    await s.as('A').castSpellEffect(RECALL_ACTIONS, spell, null, null, false, false, true)
    await s.as('A').resolveStack()

    const decision = await s.pendingDecision()
    assert.ok(decision, 'return_from_graveyard parks a pick decision')
    await s.as('A').submitDecision(decision.id, { chosen: [raider] })

    assert.equal(await s.zoneOf(raider), 'hand')
    assert.equal(await s.zoneOf(spell), 'hand') // buyback: back to hand, not graveyard
    assert.equal(await s.pendingCount(), 0)
  })
})

// BB2 — a card without a buyback cost cannot be cast with buyback.
test('BB2 buyback cast on a card without buyback is rejected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Opt Test', 'hand')
    await s.setMana('A', { U: 5 })
    await assert.rejects(
      () => s.as('A').castSpellEffect([{ type: 'draw_cards', amount: 1 }], spell, null, null, false, false, true),
      /buyback/i,
    )
  })
})

// BB3 — the buyback surcharge is real: printed-cost mana alone is not enough.
test('BB3 buyback pays printed plus buyback', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Buyback Recall Test', 'hand')
    await s.setMana('A', { B: 1, C: 1 }) // covers only the printed {1}{B}
    await assert.rejects(
      () => s.as('A').castSpellEffect(RECALL_ACTIONS, spell, null, null, false, false, true),
      /not enough .*mana/i,
    )
  })
})

// BB4 — the put_action_on_stack path (Mind Games shape): buyback rides a
// targeted stack action and still returns the spell to hand on resolution.
test('BB4 buyback works on the put_action_on_stack path', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Buyback Tapper Test', 'hand')
    const foeCreature = await s.spawn('B', 'Air Elemental Test', 'battlefield')
    await s.setMana('A', { U: 2, C: 2 }) // printed {U} + buyback {2}{U}

    await s.as('A').putOnStack('tap_creature', { target_card_id: foeCreature, target_controller: 'any' }, spell, false, true)
    await s.as('A').resolveStack()

    const state = await s.cardState(foeCreature)
    assert.equal(state.is_tapped, true)
    assert.equal(await s.zoneOf(spell), 'hand')
  })
})

// BB5 — a countered buyback spell stays in the graveyard (buyback only
// applies "as it resolves"; a cancelled item never reaches finalize).
test('BB5 countered buyback spell does not return to hand', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Buyback Recall Test', 'hand')
    await s.spawn('A', 'Goblin Raider Test', 'graveyard')
    await s.setMana('A', { B: 2, C: 3 })

    const cast = await s.as('A').castSpellEffect(RECALL_ACTIONS, spell, null, null, false, false, true)

    const counterSource = await s.spawn('B', 'Doom Blade Test', 'hand')
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'B' })
    await s.as('B').putOnStack('counter_spell', { target_stack_item_id: cast.id }, counterSource)
    await s.resolveStack() // resolves the counter — cancels the buyback spell

    assert.equal(await s.stackStatus(cast.id), 'cancelled')
    assert.equal(await s.zoneOf(spell), 'graveyard') // no buyback return
  })
})
