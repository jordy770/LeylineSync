// Dragons deck — proving tests for the Tier-0 compositions (cards authored
// from already-tested primitives; this confirms each actually RESOLVES, not
// just validates). No new engine code beyond the `gold` counter enum.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function isTapped(s: Scenario, id: string): Promise<boolean> {
  const r = await s.client.query<{ t: boolean }>('select is_tapped as t from public.game_cards where id = $1', [id])
  return r.rows[0]!.t
}
async function controllerOf(s: Scenario, id: string): Promise<string> {
  const r = await s.client.query<{ c: string }>(
    'select coalesce(controller_player_id, owner_id) as c from public.game_cards where id = $1', [id])
  return r.rows[0]!.c
}
async function tokens(s: Scenario, seat: 'A' | 'B', name: string): Promise<string[]> {
  const r = await s.client.query<{ id: string }>(
    `select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.controller_player_id = $2 and gc.zone = 'battlefield' and c.name = $3`,
    [s.sessionId, s.players[seat], name])
  return r.rows.map((x) => x.id)
}

// DR1 — Migration Path: search two basics onto the battlefield tapped.
test('DR1 Migration Path puts two basics onto the battlefield tapped', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const b1 = await s.spawn('A', 'Wastes Test', 'library')
    const b2 = await s.spawn('A', 'Island Test', 'library')
    await s.spawn('A', 'Air Elemental Test', 'library') // a nonland in the library

    await s.as('A').castSpellEffect([{ type: 'search_library', count: 2, to: 'battlefield', tapped: true, filter: { type_line: 'Basic Land' } }])
    const res = (await s.as('A').resolveStack()) as Record<string, unknown>
    assert.equal(res.awaiting_decision, true)
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { chosen: [b1, b2] })

    assert.equal(await s.zoneOf(b1), 'battlefield')
    assert.equal(await s.zoneOf(b2), 'battlefield')
    assert.equal(await isTapped(s, b1), true)
    assert.equal(await isTapped(s, b2), true)
  })
})

// DR2 — Evolving Wilds: tap + sacrifice, fetch one basic onto the field tapped.
test('DR2 Evolving Wilds fetches a basic, sacrificing itself', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const wilds = await s.spawn('A', 'Evolving Wilds Test', 'battlefield')
    const basic = await s.spawn('A', 'Wastes Test', 'library')

    await s.as('A').activate(wilds, 0)
    const res = (await s.as('A').resolveStack()) as Record<string, unknown>
    assert.equal(res.awaiting_decision, true)
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { chosen: [basic] })

    assert.equal(await s.zoneOf(wilds), 'graveyard') // sacrificed
    assert.equal(await s.zoneOf(basic), 'battlefield')
    assert.equal(await isTapped(s, basic), true)
  })
})

// DR3 — Verix Bladewing kicked makes Karox Bladewing.
test('DR3 Verix Bladewing kicked creates Karox', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const verix = await s.spawn('A', 'Verix Bladewing Test', 'hand')
    await s.setMana('A', { R: 2, C: 7 }) // {4}{R} + {3} kicker

    await s.as('A').castPermanent(verix, { kicked: true })
    await s.as('A').resolveStack() // permanent
    await s.as('A').resolveStack() // ETB conditional → Karox

    assert.equal((await tokens(s, 'A', 'Karox Bladewing')).length, 1)
  })
})

// DR4 — Keiga dies → gain control of a target creature.
test('DR4 Keiga steals a creature when it dies', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const keiga = await s.spawnCreature('A', 'Keiga Test')
    const prey = await s.spawnCreature('B', 'Air Elemental Test')

    await s.as('A').putOnStack('destroy_creature', { target_card_id: keiga, target_controller: 'any' })
    await s.as('A').resolveStack() // Keiga dies → targeted gain_control trigger enqueued

    const item = await s.topStackItem()
    assert.equal(item?.action_type, 'triggered_ability')
    await s.as('A').chooseTriggerTarget(item!.id, prey)
    await s.as('A').resolveStack()

    assert.equal(await controllerOf(s, prey), s.playerId('A')) // stolen
  })
})

// DR5 — Lathliss: another nontoken Dragon entering makes a Dragon token.
test('DR5 Lathliss spawns a Dragon when another Dragon enters', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Lathliss Test')
    await s.as('A').rebuild()
    assert.equal((await tokens(s, 'A', 'Dragon Token')).length, 0) // Lathliss itself doesn't trigger

    await s.spawnCreature('A', 'Keiga Test') // another nontoken Dragon
    await s.as('A').resolveStack() // the watcher's create-token trigger

    assert.equal((await tokens(s, 'A', 'Dragon Token')).length, 1)
  })
})

// DR6 — Dragonmaster Outcast: upkeep with six lands makes a Dragon.
test('DR6 Dragonmaster Outcast makes a Dragon with six lands', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'beginning', step: 'untap', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Dragonmaster Outcast Test')
    for (let i = 0; i < 6; i++) await s.spawn('A', 'Wastes Test', 'battlefield')

    await s.as('A').advanceStep() // untap → upkeep fires beginning_of_upkeep
    await s.as('A').resolveStack() // conditional (6 lands) → Dragon token

    assert.equal((await tokens(s, 'A', 'Dragon Token')).length, 1)
  })
})

// DR7 — Dragon's Hoard: a Dragon entering adds a gold counter; remove it to draw.
test('DR7 Dragon\'s Hoard banks gold counters and cashes one for a card', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const hoard = await s.spawn('A', "Dragon's Hoard Test", 'battlefield')
    await s.as('A').rebuild()
    await s.spawn('A', 'Air Elemental Test', 'library') // a card to draw

    await s.spawnCreature('A', 'Keiga Test') // a Dragon enters
    await s.as('A').resolveStack() // gold-counter trigger

    const gold = await s.client.query<{ n: string | null }>(
      `select counters ->> 'gold' as n from public.game_cards where id = $1`, [hoard])
    assert.equal(Number(gold.rows[0]?.n ?? 0), 1)

    const handBefore = await s.zoneCount('A', 'hand')
    await s.as('A').activate(hoard, 0) // {T}, remove a gold: draw
    await s.as('A').resolveStack()
    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 1)
    const gold2 = await s.client.query<{ n: string | null }>(
      `select counters ->> 'gold' as n from public.game_cards where id = $1`, [hoard])
    assert.equal(Number(gold2.rows[0]?.n ?? 0), 0)
  })
})

// DR8 — Rapid Hybridization: destroy a creature, its controller gets a Frog Lizard.
test('DR8 Rapid Hybridization trades a creature for a Frog Lizard', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const victim = await s.spawnCreature('B', 'Air Elemental Test')

    await s.as('A').castSpellEffect(
      [
        { type: 'destroy', target_type: 'creature' },
        { type: 'create_token', token: 'Frog Lizard Token', count: 1, recipient: 'target_controller' },
      ],
      null, null, victim,
    )
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(victim), 'graveyard')
    assert.equal((await tokens(s, 'B', 'Frog Lizard Token')).length, 1) // B (controller) gets it
  })
})
