// mig 260 — Veloci-Ramp-Tor combat batch. Engine touches:
//   • trample combat-damage tally + 'trample_combat_damage' broadcast
//     (Quartzwood Crasher: X/X token via create_token set_pt:'event_amount')
//   • fire_watcher_triggers p_extra + 'creature_damaged' broadcast from
//     apply_damage_to_creature (Wrathful Raptors redirect)
//   • From the Rubble and Itzquinth are script-only ($chosen end-step
//     reanimation; greatest-Dino-power targeted damage).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// DC1 — Quartzwood: unblocked trample damage makes an X/X token.
test('DC1 Quartzwood Crasher creates an X/X token on trample damage', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const crasher = await s.spawnCreature('A', 'Quartzwood Crasher Test') // 6/6 trample
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(crasher, 'B')
    await s.setTurn({ phase: 'combat', step: 'combat_damage', active: 'A', priority: 'A' })
    await s.resolveCombat()
    await s.as('A').resolveStack() // the trample_combat_damage trigger

    const token = await s.client.query<{ id: string }>(
      `select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and gc.zone = 'battlefield' and c.name = 'Dinosaur Beast Token'`,
      [s.sessionId])
    assert.equal(token.rows.length, 1)
    assert.equal(await s.effectivePower(token.rows[0]!.id), 6) // X = 6 damage dealt
    assert.equal(await s.effectiveToughness(token.rows[0]!.id), 6)
  })
})

// DC2 — Wrathful Raptors: a damaged Dinosaur you control redirects that much
// damage to the chosen (non-Dinosaur) target.
test('DC2 Wrathful Raptors redirects damage dealt to your Dinosaur', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Wrathful Raptors Test')
    const grunt = await s.spawnCreature('A', 'Dino Grunt Test') // 3/3
    const victim = await s.spawnCreature('B', 'Air Elemental Test') // 4/4

    await s.as('A').castSpellEffect(
      [{ type: 'deal_damage', amount: 2, target_type: 'creature' }], null, null, grunt)
    await s.as('A').resolveStack() // damage lands → Raptors watcher enqueues

    const item = await s.topStackItem()
    assert.equal(item?.action_type, 'triggered_ability')
    await s.as('A').chooseTriggerTarget(item!.id, victim)
    await s.as('A').resolveStack()

    const hit = await s.client.query<{ damage_marked: number }>(
      'select damage_marked from public.game_cards where id = $1', [victim])
    assert.equal(hit.rows[0]!.damage_marked, 2) // exactly the event amount
  })
})

// DC3 — From the Rubble: choose Dinosaur on entry, end step reanimates one.
test('DC3 From the Rubble returns a chosen-type creature at end step', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const corpse = await s.spawnCreature('A', 'Dino Grunt Test')
    await s.putInGraveyard(corpse)

    await s.spawn('A', 'From the Rubble Test', 'battlefield')
    await s.as('A').resolveStack() // ETB → choose_creature_type parks
    const pick = await s.pendingDecision()
    assert.equal(pick!.decision_type, 'choose_creature_type')
    await s.as('A').submitDecision(pick!.id, { type: 'Dinosaur' })

    await s.setTurn({ phase: 'ending', step: 'end', active: 'A', priority: 'A' })
    await s.as('A').resolveStack() // the end-step trigger → graveyard pick
    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'return_from_graveyard')
    await s.as('A').submitDecision(d!.id, { chosen: [corpse] })

    const row = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [corpse])
    assert.equal(row.rows[0]!.zone, 'battlefield')
  })
})

// DC4 — Itzquinth: ETB damage equal to your greatest Dinosaur power.
test('DC4 Itzquinth burns the target for the biggest Dino power', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Rampaging Brontodon Test') // 7/6 Dinosaur
    const victim = await s.spawnCreature('B', 'Air Elemental Test') // 4/4

    await s.spawnCreature('A', 'Itzquinth Firstborn Test')
    const item = await s.topStackItem()
    assert.equal(item?.action_type, 'triggered_ability')
    await s.as('A').chooseTriggerTarget(item!.id, victim)
    await s.as('A').resolveStack()

    const row = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [victim])
    assert.equal(row.rows[0]!.zone, 'graveyard') // 7 damage kills the 4/4
  })
})
