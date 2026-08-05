// Evoke / blitz / spectacle (mig 433) — three one-card alternative-cost
// mechanics sharing the cast plumbing:
// - Evoke (Mulldrifter): cast_card_from_hand p_alt_cost='evoke' pays the
//   script's `evoke` cost; on resolution the permanent is sacrificed right
//   after its ETB triggers are enqueued (the ETB still resolves).
// - Blitz (Mayhem Patrol): p_alt_cost='blitz' pays `blitz`; on resolution the
//   permanent gains haste + a granted dies-draw, and is marked for the
//   existing cleanup_at_end_step sweep (advance_step → put_in_graveyard).
// - Spectacle (Light Up the Stage): cast_spell_effect p_spectacle pays the
//   script's `spectacle` cost instead of the printed cost, allowed only while
//   an opponent has lost life this turn (game_session_players tracker).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

const IMPULSE2 = [{ type: 'impulse', count: 2 }]

// EV1 — evoke pays the evoke cost; the creature's ETB fires and it is then
// sacrificed.
test('EV1 evoked permanent resolves its ETB and is sacrificed', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const drake = await s.spawn('A', 'Evoke Drake Test', 'hand')
    await s.spawn('A', 'Island Test', 'library')
    await s.spawn('A', 'Island Test', 'library')
    await s.setMana('A', { U: 1, C: 2 }) // evoke {2}{U}, not the printed {4}{U}

    await s.as('A').castPermanent(drake, { altCost: 'evoke' })
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(drake), 'graveyard') // sacrificed on entry
    assert.equal(await s.zoneCount('A', 'hand'), 2) // the ETB draw still resolved
  })
})

// EV2 — a card without an evoke cost cannot be cast evoked.
test('EV2 evoke on a card without evoke is rejected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const wall = await s.spawn('A', 'Wall Test', 'hand')
    await s.setMana('A', { C: 3 })
    await assert.rejects(() => s.as('A').castPermanent(wall, { altCost: 'evoke' }), /evoke/i)
  })
})

// EV3 — the evoke cost is still a real cost.
test('EV3 evoke still requires its mana', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const drake = await s.spawn('A', 'Evoke Drake Test', 'hand')
    await assert.rejects(
      () => s.as('A').castPermanent(drake, { altCost: 'evoke' }),
      /not enough .*mana/i,
    )
  })
})

// BL1 — blitz pays the blitz cost; the permanent arrives with haste, a
// granted dies-draw, and the end-step cleanup mark; dying draws a card.
test('BL1 blitzed permanent gains haste, dies-draw, and the end-step mark', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const devil = await s.spawn('A', 'Blitz Devil Test', 'hand')
    await s.spawn('A', 'Island Test', 'library')
    await s.setMana('A', { R: 1 }) // blitz {R}, not the printed {2}{R}

    await s.as('A').castPermanent(devil, { altCost: 'blitz' })
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(devil), 'battlefield')
    assert.equal(await s.continuousEffectCount(devil, 'haste'), 1)
    assert.equal(await s.continuousEffectCount(devil, 'granted_dies_effect'), 1)
    const { rows } = await client.query<{ counters: Record<string, unknown> | null }>(
      'select counters from public.game_cards where id = $1',
      [devil],
    )
    assert.ok(rows[0]?.counters?.cleanup_at_end_step != null, 'marked for end-step sacrifice')

    const handBefore = await s.zoneCount('A', 'hand')
    await s.putInGraveyard(devil) // the end-step sweep uses this same path
    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 1) // dies-draw fired
  })
})

// SP1 — spectacle is live once an opponent lost life this turn.
test('SP1 spectacle pays the spectacle cost after an opponent lost life', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Spectacle Impulse Test', 'hand')
    await s.spawn('A', 'Island Test', 'library')
    await s.spawn('A', 'Island Test', 'library')
    await s.as('A').applyDamageToPlayer('B', 2, null)
    await s.setMana('A', { R: 1 }) // spectacle {R}, not the printed {2}{R}

    await s.as('A').castSpellEffect(IMPULSE2, spell, null, null, false, false, false, null, null, true)
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(spell), 'graveyard')
    assert.equal(await s.zoneCount('A', 'exile'), 2) // impulse-exiled cards
  })
})

// SP2 — without any opponent life loss this turn the spectacle cast is refused.
test('SP2 spectacle without opponent life loss is rejected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Spectacle Impulse Test', 'hand')
    await s.setMana('A', { R: 1 })
    await assert.rejects(
      () => s.as('A').castSpellEffect(IMPULSE2, spell, null, null, false, false, false, null, null, true),
      /spectacle/i,
    )
  })
})
