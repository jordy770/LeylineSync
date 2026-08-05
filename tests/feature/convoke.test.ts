// Convoke (mig 432, Hour of Reckoning / Triplicate Spirits / Markov Baron /
// Chief Engineer) — "Each creature you tap while casting this spell pays for
// {1} or one mana of that creature's color." cast_spell_effect and
// cast_card_from_hand gain p_convoke_card_ids; apply_convoke validates the
// creatures (distinct, untapped, yours, on the battlefield), taps them, and
// per creature removes a matching coloured pip when it can, else {1} generic
// (creature colour = card_color_set of its mana cost; tokens without a mana
// cost pay generic only — documented approximation). Chief Engineer's
// "artifact spells you cast have convoke" is a grants_convoke continuous
// effect checked by cast_card_from_hand.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

const TOKENS3 = [{ type: 'create_token', token: 'Spirit Token', count: 3 }]

// CV1 — white creatures pay the {W} pips, an off-colour creature pays generic:
// {4}{W}{W} with two whites + one red leaves exactly {3}.
test('CV1 convoke pays coloured pips by creature colour and generic otherwise', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Convoke Tokens Test', 'hand')
    const cat1 = await s.spawn('A', 'Lifelink Cat Test', 'battlefield')
    const cat2 = await s.spawn('A', 'Lifelink Cat Test', 'battlefield')
    const raider = await s.spawn('A', 'Goblin Raider Test', 'battlefield')
    await s.setMana('A', { C: 3 }) // exactly the remaining {3}

    await s.as('A').castSpellEffect(TOKENS3, spell, null, null, false, false, false, null, [cat1, cat2, raider])
    await s.as('A').resolveStack()

    for (const id of [cat1, cat2, raider]) {
      const state = await s.cardState(id)
      assert.equal(state.is_tapped, true, 'convoked creature is tapped')
    }
    assert.equal(await s.zoneOf(spell), 'graveyard')
    const tokens = await s.zoneCount('A', 'battlefield')
    assert.equal(tokens, 3 + 3) // 3 convokers + 3 Spirit tokens
  })
})

// CV2 — a card without convoke in its script cannot convoke.
test('CV2 convoke on a card without convoke is rejected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Opt Test', 'hand')
    const cat = await s.spawn('A', 'Lifelink Cat Test', 'battlefield')
    await s.setMana('A', { U: 3 })
    await assert.rejects(
      () => s.as('A').castSpellEffect([{ type: 'draw_cards', amount: 1 }], spell, null, null, false, false, false, null, [cat]),
      /convoke/i,
    )
  })
})

// CV3 — an already-tapped creature cannot help convoke.
test('CV3 a tapped creature cannot convoke', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Convoke Tokens Test', 'hand')
    const tappedCat = await s.spawn('A', 'Lifelink Cat Test', 'battlefield', true)
    await s.setMana('A', { W: 2, C: 4 })
    await assert.rejects(
      () => s.as('A').castSpellEffect(TOKENS3, spell, null, null, false, false, false, null, [tappedCat]),
      /untapped/i,
    )
  })
})

// CV4 — the remaining cost is still charged after convoke.
test('CV4 the remaining cost after convoke is still charged', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Convoke Tokens Test', 'hand')
    const cat = await s.spawn('A', 'Lifelink Cat Test', 'battlefield')
    await s.setMana('A', { C: 2 }) // {4}{W} remains after one white convoker
    await assert.rejects(
      () => s.as('A').castSpellEffect(TOKENS3, spell, null, null, false, false, false, null, [cat]),
      /not enough .*mana/i,
    )
  })
})

// CV5 — more convokers than the cost has pips is rejected.
test('CV5 convoking more creatures than the cost can absorb is rejected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Convoke Tokens Test', 'hand') // {4}{W}{W}: 6 pips max
    const cats: string[] = []
    for (let i = 0; i < 7; i++) cats.push(await s.spawn('A', 'Lifelink Cat Test', 'battlefield'))
    await assert.rejects(
      () => s.as('A').castSpellEffect(TOKENS3, spell, null, null, false, false, false, null, cats),
      /convoke/i,
    )
  })
})

// CV6 — cast_card_from_hand path (Markov Baron shape): a black creature pays
// the {B} pip of {2}{B}; the permanent still resolves onto the battlefield.
test('CV6 convoke works when casting a permanent', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const vampire = await s.spawn('A', 'Convoke Vampire Test', 'hand')
    const beast = await s.spawn('A', 'Costly Beast Test', 'battlefield') // {2}{B}{B} — black
    await s.setMana('A', { C: 2 }) // exactly the remaining {2}

    await s.as('A').castPermanent(vampire, { convokeCardIds: [beast] })
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(vampire), 'battlefield')
    const state = await s.cardState(beast)
    assert.equal(state.is_tapped, true)
  })
})

// CV7 — grants_convoke (Chief Engineer): artifact casts may convoke while the
// granter is on the battlefield...
test('CV7 grants_convoke lets an artifact cast convoke', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Convoke Granter Test', 'battlefield')
    const obelisk = await s.spawn('A', 'Unstable Obelisk Test', 'hand') // {3}, artifact
    const cat = await s.spawn('A', 'Lifelink Cat Test', 'battlefield')
    await s.setMana('A', { C: 2 }) // cat pays generic (no coloured pip to match)

    await s.as('A').castPermanent(obelisk, { convokeCardIds: [cat] })
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(obelisk), 'battlefield')
  })
})

// CV8 — ...and without the granter the same artifact cast cannot convoke.
test('CV8 without a granter an artifact cast cannot convoke', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const obelisk = await s.spawn('A', 'Unstable Obelisk Test', 'hand')
    const cat = await s.spawn('A', 'Lifelink Cat Test', 'battlefield')
    await s.setMana('A', { C: 3 })
    await assert.rejects(
      () => s.as('A').castPermanent(obelisk, { convokeCardIds: [cat] }),
      /convoke/i,
    )
  })
})
