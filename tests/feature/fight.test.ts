// Tier-2 effect: fight (migration 101) — the first multi-target effect. A
// creature you control and another creature each deal damage equal to their power
// to the other, simultaneously; lethal damage sends a creature to the graveyard.
// Reuses card_effective_power + apply_creature_effect('deal_damage') (lethal SBA).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// F1 — asymmetric: a 4/4 fights a non-deathtouch 1/1. The 1/1 dies; the 4/4
// survives with 1 damage marked (it took the 1/1's power). Uses Silhana
// Ledgewalker (1/1, reach, no deathtouch) — a deathtouch 1/1 would kill the 4/4
// too (see F9).
test('F1 fight: lethal to the smaller creature, damage marked on the survivor', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const elemental = await s.spawnCreature('A', 'Air Elemental Test') // 4/4, you control
    const ledgewalker = await s.spawnCreature('B', 'Silhana Ledgewalker Test') // 1/1, no deathtouch

    await s.as('A').castFight(elemental, ledgewalker)
    await s.resolveStack()

    const ledgewalkerAfter = await s.cardState(ledgewalker)
    const elementalAfter = await s.cardState(elemental)
    assert.equal(ledgewalkerAfter.zone, 'graveyard') // 4 damage to a 1-toughness creature
    assert.equal(elementalAfter.zone, 'battlefield')
    assert.equal(elementalAfter.damage_marked, 1) // took the 1/1's power (1)
  })
})

// F2 — mutual kill: two 2/2s fight, each deals 2 to the other → both die.
test('F2 fight: two equal creatures kill each other', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const mine = await s.spawnCreature('A', 'Welcome Drain Test') // 2/2
    const theirs = await s.spawnCreature('B', 'Ravenous Chupacabra Test') // 2/2

    await s.as('A').castFight(mine, theirs)
    await s.resolveStack()

    assert.equal((await s.cardState(mine)).zone, 'graveyard')
    assert.equal((await s.cardState(theirs)).zone, 'graveyard')
  })
})

// F3 — validation: the fighting creature must be one you control.
test('F3 fight rejects a fighter you do not control', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const oppCreature = await s.spawnCreature('B', 'Air Elemental Test') // not controlled by A
    const mine = await s.spawnCreature('A', 'Welcome Drain Test')

    await assert.rejects(() => s.as('A').castFight(oppCreature, mine))
  })
})

// F4 — fought controller restriction ("you don't control"): can't fight your own
// creature when foughtController is 'opponent'.
test('F4 fight with fought_controller=opponent rejects your own creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const mine = await s.spawnCreature('A', 'Air Elemental Test')
    const alsoMine = await s.spawnCreature('A', 'Welcome Drain Test')

    await assert.rejects(() => s.as('A').castFight(mine, alsoMine, null, 'opponent'))
  })
})

// F5 — Prey Upon cast from hand (Sorcery, fight target_controller=opponent): the
// 4/4 fighter kills the opponent's 1/1, the spell goes to the graveyard.
test('F5 Prey Upon cast from hand: fights and moves to the graveyard', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const mine = await s.spawnCreature('A', 'Air Elemental Test') // 4/4
    const theirs = await s.spawnCreature('B', 'Silhana Ledgewalker Test') // 1/1, no deathtouch
    const preyUpon = await s.spawn('A', 'Prey Upon Test', 'hand')

    await s.as('A').castFight(mine, theirs, preyUpon, 'opponent')
    await s.resolveStack()

    assert.equal((await s.cardState(theirs)).zone, 'graveyard') // took 4
    assert.equal((await s.cardState(mine)).zone, 'battlefield')
    assert.equal((await s.cardState(preyUpon)).zone, 'graveyard') // spell resolved
  })
})

// F6 — trigger path: Pit Brawler's ETB "it fights target creature you don't
// control". The SOURCE creature is the fighter; the player picks the fought
// creature through the standard trigger target picker (no cast_fight).
test('F6 fight trigger: ETB source fights the chosen creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const prey = await s.spawnCreature('B', 'Silhana Ledgewalker Test') // 1/1, no deathtouch
    const brawler = await s.spawnCreature('A', 'Pit Brawler Test') // 4/4, fighter (ETB fight)

    const trigger = await s.topStackItem()
    assert.equal(trigger?.action_type, 'triggered_ability')

    await s.as('A').chooseTriggerTarget(trigger!.id, prey)
    await s.resolveStack()

    assert.equal((await s.cardState(prey)).zone, 'graveyard') // took the 4/4's power
    const brawlerAfter = await s.cardState(brawler)
    assert.equal(brawlerAfter.zone, 'battlefield')
    assert.equal(brawlerAfter.damage_marked, 1) // took the 1/1's power (1)
  })
})

// F7 — trigger controller restriction ("you don't control"): can't pick your own
// creature as the fought target.
test('F7 fight trigger rejects targeting your own creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const alsoMine = await s.spawnCreature('A', 'Welcome Drain Test') // illegal target (yours)
    await s.spawnCreature('B', 'Air Elemental Test') // a legal target exists, so it won't fizzle
    const brawler = await s.spawnCreature('A', 'Pit Brawler Test')

    const trigger = await s.topStackItem()
    assert.equal(trigger?.action_type, 'triggered_ability')

    await assert.rejects(() => s.as('A').chooseTriggerTarget(trigger!.id, alsoMine))
    void brawler
  })
})

// F8 — trigger fizzles harmlessly when the controller has no legal fought target
// (no opponent creature → no softlock, source survives).
test('F8 fight trigger fizzles with no legal target (no softlock)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const brawler = await s.spawnCreature('A', 'Pit Brawler Test') // B controls no creatures

    const trigger = await s.topStackItem()
    if (trigger?.action_type === 'triggered_ability') {
      await s.resolveStack() // must not throw
    }
    assert.equal((await s.cardState(brawler)).zone, 'battlefield')
  })
})

// F9 — deathtouch: a 1/1 deathtouch creature fights a 0/4 wall. Its 1 damage is
// lethal (CR 702.2) so the wall dies despite 4 toughness; the wall deals 0 power
// back, so the viper survives unscathed.
test('F9 fight: deathtouch makes 1 damage lethal regardless of toughness', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const viper = await s.spawnCreature('A', 'Deathtouch Viper Test') // 1/1 deathtouch
    const wall = await s.spawnCreature('B', 'Vengeful Wall Test') // 0/4

    await s.as('A').castFight(viper, wall)
    await s.resolveStack()

    assert.equal((await s.cardState(wall)).zone, 'graveyard') // 1 deathtouch dmg = lethal
    const viperAfter = await s.cardState(viper)
    assert.equal(viperAfter.zone, 'battlefield') // wall has 0 power
    assert.equal(viperAfter.damage_marked, 0)
  })
})

// F10 — mutual deathtouch trade: a 4/4 fights a 1/1 deathtouch creature. The 1/1
// dies to 4 damage; the 4/4 also dies because the 1 damage it took came from a
// deathtouch source. (This is the rules-correct outcome F1 used to assert wrong.)
test('F10 fight: a deathtouch defender kills the bigger attacker too', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const elemental = await s.spawnCreature('A', 'Air Elemental Test') // 4/4
    const viper = await s.spawnCreature('B', 'Deathtouch Viper Test') // 1/1 deathtouch

    await s.as('A').castFight(elemental, viper)
    await s.resolveStack()

    assert.equal((await s.cardState(viper)).zone, 'graveyard')
    assert.equal((await s.cardState(elemental)).zone, 'graveyard') // 1 deathtouch dmg = lethal
  })
})
