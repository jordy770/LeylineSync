// mig 259 — Veloci-Ramp-Tor triggers batch. Engine touches:
//   • 'damage_cap' continuous (Temple Altisaur: prevent all but 1 to OTHER
//     Dinosaurs you control)
//   • pump {power_of:'target'} (Xenagos: haste + +X/+X at combat start)
//   • reveal_top_cast_shared (Descendants' Path upkeep reveal)
//   • exile_from_any_graveyard + graveyard_exile_pick (Deathgorge Scavenger)
//   • Akroma's Will is script-only (choose_one over grant_keyword_all).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// DG1 — Temple Altisaur caps damage to ANOTHER Dinosaur at 1, but not to itself.
test('DG1 Temple Altisaur prevents all but 1 to other Dinosaurs', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const temple = await s.spawnCreature('A', 'Temple Altisaur Test') // 2/4
    const grunt = await s.spawnCreature('A', 'Dino Grunt Test') // 3/3

    await s.as('A').castSpellEffect(
      [{ type: 'deal_damage', amount: 5, target_type: 'creature' }], null, null, grunt)
    await s.as('A').resolveStack()
    const hit = await s.client.query<{ zone: string; damage_marked: number }>(
      'select zone, damage_marked from public.game_cards where id = $1', [grunt])
    assert.equal(hit.rows[0]!.zone, 'battlefield') // 5 became 1 — survives
    assert.equal(hit.rows[0]!.damage_marked, 1)

    await s.as('A').castSpellEffect(
      [{ type: 'deal_damage', amount: 3, target_type: 'creature' }], null, null, temple)
    await s.as('A').resolveStack()
    const self = await s.client.query<{ damage_marked: number }>(
      'select damage_marked from public.game_cards where id = $1', [temple])
    assert.equal(self.rows[0]!.damage_marked, 3) // never caps damage to itself
  })
})

// DG2 — Xenagos at combat start: the target gains haste and +X/+X = its power.
test('DG2 Xenagos pumps the chosen creature by its own power', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Xenagos Revels Test')
    const grunt = await s.spawnCreature('A', 'Dino Grunt Test') // 3/3

    await s.setTurn({ phase: 'combat', step: 'beginning_of_combat', active: 'A', priority: 'A' })
    const item = await s.topStackItem()
    assert.equal(item?.action_type, 'triggered_ability')
    await s.as('A').chooseTriggerTarget(item!.id, grunt)
    await s.as('A').resolveStack()

    assert.equal(await s.effectivePower(grunt), 6) // 3 + its own power 3
    assert.equal(await s.effectiveToughness(grunt), 6)
    const haste = await s.client.query(
      `select 1 from public.game_continuous_effects
       where session_id = $1 and affected_card_id = $2 and effect_type = 'haste'`,
      [s.sessionId, grunt])
    assert.ok(haste.rows.length >= 1)
  })
})

// DG3 — Descendants' Path: a top card sharing a creature type enters free.
test('DG3 Descendants Path casts a type-sharing top card', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Descendants Path Test', 'battlefield')
    await s.spawnCreature('A', 'Dino Grunt Test') // the shared Dinosaur type
    const top = await s.spawn('A', 'Earthshaker Dreadmaw Test', 'library')

    await s.setTurn({ phase: 'beginning', step: 'upkeep', active: 'A', priority: 'A' })
    await s.as('A').resolveStack() // the Path trigger

    const row = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [top])
    assert.equal(row.rows[0]!.zone, 'battlefield')
  })
})

// DG4 — Descendants' Path bottoms a top card that shares nothing.
test('DG4 Descendants Path bottoms a non-sharing top card', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Descendants Path Test', 'battlefield')
    await s.spawnCreature('A', 'Dino Grunt Test') // Dinosaur
    const top = await s.spawn('A', 'Air Elemental Test', 'library') // Elemental — no share

    await s.setTurn({ phase: 'beginning', step: 'upkeep', active: 'A', priority: 'A' })
    await s.as('A').resolveStack()

    const row = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [top])
    assert.equal(row.rows[0]!.zone, 'library') // bottomed, not cast
  })
})

// DG5 — Deathgorge Scavenger: exiling a creature card gains 2 life.
test('DG5 Deathgorge exiles a creature card for 2 life', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const corpse = await s.spawnCreature('B', 'Dino Grunt Test')
    await s.putInGraveyard(corpse)
    const before = await s.client.query<{ life_total: number }>(
      'select life_total from public.game_session_players where session_id = $1 and player_id = $2',
      [s.sessionId, s.players.A])

    await s.spawnCreature('A', 'Deathgorge Scavenger Test')
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'graveyard_exile_pick')
    await s.as('A').submitDecision(d!.id, { chosen: [corpse] })

    const gone = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [corpse])
    assert.equal(gone.rows[0]!.zone, 'exile')
    const after = await s.client.query<{ life_total: number }>(
      'select life_total from public.game_session_players where session_id = $1 and player_id = $2',
      [s.sessionId, s.players.A])
    assert.equal(after.rows[0]!.life_total, before.rows[0]!.life_total + 2)
  })
})

// DG6 — Deathgorge Scavenger: exiling a NONcreature card pumps it +1/+1 EOT.
test('DG6 Deathgorge exiles a noncreature card and pumps itself', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const land = await s.spawn('B', 'Wastes Test', 'graveyard')

    const scav = await s.spawnCreature('A', 'Deathgorge Scavenger Test') // 3/2
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { chosen: [land] })

    const gone = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [land])
    assert.equal(gone.rows[0]!.zone, 'exile')
    assert.equal(await s.effectivePower(scav), 4) // 3 + 1
  })
})

// DG7 — Akroma's Will (no commander): one mode, mass keyword grants land.
test('DG7 Akromas Will grants the chosen mode to your creatures', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Dino Grunt Test')

    await s.as('A').castSpellEffect([
      { type: 'choose_one', prompt: 'Akroma', may_choose_both_if_commander: true, modes: [
        { label: 'Flying, vigilance, double strike', actions: [
          { type: 'grant_keyword_all', keyword: 'flying', scope: 'controller' },
          { type: 'grant_keyword_all', keyword: 'vigilance', scope: 'controller' },
          { type: 'grant_keyword_all', keyword: 'double_strike', scope: 'controller' } ] },
        { label: 'Indestructible', actions: [
          { type: 'grant_keyword_all', keyword: 'indestructible', scope: 'controller' },
          { type: 'grant_keyword_all', keyword: 'hexproof', scope: 'controller' } ] },
      ] },
    ])
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'choose_mode')
    await s.as('A').submitDecision(d!.id, { chosen: [0] })

    const rows = await s.client.query<{ effect_type: string }>(
      `select effect_type from public.game_continuous_effects
       where session_id = $1 and affected_player_id = $2
         and effect_type in ('flying','vigilance','double_strike')`,
      [s.sessionId, s.players.A])
    assert.equal(rows.rows.length, 3)
  })
})
