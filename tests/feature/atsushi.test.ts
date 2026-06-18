// Atsushi, the Blazing Sky (mig 230) — a MODAL dies trigger ("choose one"):
//   • impulse: exile the top two library cards; play them until the end of your
//     next turn (a play_from_exile permission honoured by cast_card_from_hand,
//     expired by advance_step at the end of the controller's next turn), or
//   • create three Treasure tokens.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function countZone(s: Scenario, seat: 'A' | 'B', zone: string, name?: string): Promise<number> {
  const r = await s.client.query<{ n: string }>(
    `select count(*)::int as n from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.owner_id = $2 and gc.zone = $3 ${name ? 'and c.name = $4' : ''}`,
    name ? [s.sessionId, s.players[seat], zone, name] : [s.sessionId, s.players[seat], zone])
  return Number(r.rows[0]!.n)
}

async function exilePerms(s: Scenario, seat: 'A' | 'B'): Promise<number> {
  const r = await s.client.query<{ n: string }>(
    `select count(*)::int as n from public.game_continuous_effects
     where session_id = $1 and effect_type = 'play_from_exile' and affected_player_id = $2`,
    [s.sessionId, s.players[seat]])
  return Number(r.rows[0]!.n)
}

async function manaC(s: Scenario, seat: 'A' | 'B'): Promise<number> {
  const r = await s.client.query<{ c: number }>(
    `select coalesce((mana_pool ->> 'C')::int, 0) as c from public.game_players
     where session_id = $1 and player_id = $2`,
    [s.sessionId, s.players[seat]])
  return Number(r.rows[0]?.c ?? 0)
}

// AT1 — the Treasures mode makes three Treasures.
test('AT1 Atsushi dies, choosing three Treasures', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A', turnNumber: 1 })
    const atsushi = await s.spawnCreature('A', 'Atsushi Test')

    await s.fireTriggers('A', atsushi, ['dies'])
    await s.as('A').resolveStack() // dies trigger → choose_mode parked

    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'choose_mode')
    await s.as('A').submitDecision(d!.id, { chosen: [1] }) // mode 1 = Treasures

    assert.equal(await countZone(s, 'A', 'battlefield', 'Treasure Token'), 3)
  })
})

// AT2 — the impulse mode exiles the top two cards, grants a play permission, and
// one of them can then be played from exile.
test('AT2 Atsushi impulse exiles two and lets you play them', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A', turnNumber: 1 })
    const atsushi = await s.spawnCreature('A', 'Atsushi Test')
    const top = await s.spawn('A', 'Red Wall Test', 'library')
    await s.spawn('A', 'Red Wall Test', 'library')
    await s.spawn('A', 'Red Wall Test', 'library')

    await s.fireTriggers('A', atsushi, ['dies'])
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { chosen: [0] }) // mode 0 = impulse

    assert.equal(await countZone(s, 'A', 'exile'), 2)
    assert.equal(await exilePerms(s, 'A'), 1)

    // Play one exiled card from exile (needs the play_from_exile permission).
    await s.setMana('A', { R: 1 })
    await s.as('A').castPermanent(top)
    await s.as('A').resolveStack()
    assert.equal(await countZone(s, 'A', 'battlefield', 'Red Wall Test'), 1)
  })
})

// AT3 — the play window closes at the end of the controller's NEXT turn: a card
// still in exile can no longer be played once the permission expires.
test('AT3 the impulse play window expires after your next turn', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A', turnNumber: 1 })
    const atsushi = await s.spawnCreature('A', 'Atsushi Test')
    await s.spawn('A', 'Red Wall Test', 'library')
    await s.spawn('A', 'Red Wall Test', 'library')

    await s.fireTriggers('A', atsushi, ['dies'])
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { chosen: [0] })
    assert.equal(await exilePerms(s, 'A'), 1)

    // Leaving the end step of a LATER turn (A's next turn) expires the window.
    await s.setTurn({ phase: 'ending', step: 'end', active: 'A', priority: 'A', turnNumber: 3 })
    await s.as('A').advanceStep()

    assert.equal(await exilePerms(s, 'A'), 0)
  })
})

// AT4 — a NON-PERMANENT spell (sorcery) impulse-exiled can be cast from exile:
//   it pays its printed cost (impulse is not free) and goes to the graveyard.
//   (mig 321 — cast_spell_effect honours an exile source.)
test('AT4 a sorcery played from exile pays its cost and goes to the graveyard', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A', turnNumber: 1 })
    const atsushi = await s.spawnCreature('A', 'Atsushi Test')
    // Top two of A's library: the sorcery + a filler — both get impulse-exiled.
    const spell = await s.spawn('A', 'Increasing Insight Test', 'library') // cost {2}
    await s.spawn('A', 'Red Wall Test', 'library')

    await s.fireTriggers('A', atsushi, ['dies'])
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { chosen: [0] }) // impulse
    assert.equal(await countZone(s, 'A', 'exile', 'Increasing Insight Test'), 1)

    // Cast it from exile. {2} is paid from the pool — impulse is NOT free.
    await s.setMana('A', { C: 2 })
    await s.as('A').castSpellEffect(
      [{ type: 'create_token', token: 'Treasure Token', count: 1 }], spell)
    await s.as('A').resolveStack()

    assert.equal(await manaC(s, 'A'), 0, 'the {2} cost was charged from exile')
    assert.equal(await countZone(s, 'A', 'graveyard', 'Increasing Insight Test'), 1, 'spent spell → graveyard')
    assert.equal(await countZone(s, 'A', 'exile', 'Increasing Insight Test'), 0, 'left exile')
    assert.equal(await countZone(s, 'A', 'battlefield', 'Treasure Token'), 1, 'effect resolved')
  })
})

// AT5 — without a play_from_exile permission, a card in exile cannot be cast.
test('AT5 casting from exile is refused without a permission', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A', turnNumber: 1 })
    const spell = await s.spawn('A', 'Increasing Insight Test', 'exile')
    await s.setMana('A', { C: 2 })

    await assert.rejects(
      () => s.as('A').castSpellEffect(
        [{ type: 'create_token', token: 'Treasure Token', count: 1 }], spell),
      /permission to play that card from exile/)
  })
})
