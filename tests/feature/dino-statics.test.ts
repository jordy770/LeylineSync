// mig 258 — Veloci-Ramp-Tor statics batch. Engine touches:
//   • untap_all card_type (Zacama: "untap all lands you control")
//   • untargeted pump in the triggered resolver (Rampaging Brontodon:
//     +1/+1 per land on attack)
//   • 'ability_activated' watcher event from activate_ability (Runic
//     Armasaur; mana abilities never fire it)
//   • 'creatures_enter_tapped' continuous (Kinjalli's Sunwing)
//   • gain_life joins the activated→spell_effect routing (Zacama {2}{W})
// Atzocan Seer is script-only (sac-self cost + filtered graveyard return).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// ST1 — Zacama's ETB untaps A's lands (and only lands you control).
test('ST1 Zacama untaps your lands on entry', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const l1 = await s.spawn('A', 'Forest Test', 'battlefield')
    const l2 = await s.spawn('A', 'Forest Test', 'battlefield')
    const foe = await s.spawn('B', 'Forest Test', 'battlefield')
    await s.client.query(
      'update public.game_cards set is_tapped = true where id = any($1::uuid[])',
      [[l1, l2, foe]])

    await s.spawnCreature('A', 'Zacama Primal Test')
    await s.as('A').resolveStack()

    const mine = await s.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_cards
       where id = any($1::uuid[]) and is_tapped = false`, [[l1, l2]])
    assert.equal(Number(mine.rows[0]!.n), 2)
    const theirs = await s.client.query<{ is_tapped: boolean }>(
      'select is_tapped from public.game_cards where id = $1', [foe])
    assert.equal(theirs.rows[0]!.is_tapped, true) // only YOUR lands
  })
})

// ST2 — Zacama {2}{W}: gain 3 life (the gain_life activated routing).
test('ST2 Zacama white ability gains 3 life', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const z = await s.spawnCreature('A', 'Zacama Primal Test')
    await s.as('A').resolveStack() // flush the ETB untap trigger
    await s.setMana('A', { W: 1, C: 2 })
    const before = await s.client.query<{ life_total: number }>(
      'select life_total from public.game_session_players where session_id = $1 and player_id = $2',
      [s.sessionId, s.players.A])

    await s.as('A').activate(z, 2) // index 2 = {2}{W}: gain 3 life
    await s.as('A').resolveStack()

    const after = await s.client.query<{ life_total: number }>(
      'select life_total from public.game_session_players where session_id = $1 and player_id = $2',
      [s.sessionId, s.players.A])
    assert.equal(after.rows[0]!.life_total, before.rows[0]!.life_total + 3)
  })
})

// ST3 — Kinjalli's Sunwing: opponents' creatures enter tapped, yours don't.
test('ST3 Kinjalli Sunwing taps creatures entering under opponents', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Kinjalli Sunwing Test') // no ETB trigger — statics only

    const foe = await s.spawnCreature('B', 'Dino Grunt Test')
    const own = await s.spawnCreature('A', 'Dino Grunt Test')

    const rows = await s.client.query<{ id: string; is_tapped: boolean }>(
      'select id, is_tapped from public.game_cards where id = any($1::uuid[])', [[foe, own]])
    const byId = new Map(rows.rows.map((r) => [r.id, r.is_tapped]))
    assert.equal(byId.get(foe), true) // B's creature entered tapped
    assert.equal(byId.get(own), false) // the Sunwing controller's didn't
  })
})

// ST4 — Runic Armasaur: an OPPONENT's non-mana activation draws B a card;
// B's own activations don't (controller filter).
test('ST4 Runic Armasaur draws on opponent ability activation', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('B', 'Runic Armasaur Test')
    await s.spawn('B', 'Wastes Test', 'library')
    await s.spawn('B', 'Wastes Test', 'library')
    const z = await s.spawnCreature('A', 'Zacama Primal Test')
    await s.as('A').resolveStack() // flush ETBs

    await s.setMana('A', { W: 1, C: 2 })
    await s.as('A').activate(z, 2) // non-mana ability → watcher fires
    await s.as('A').resolveStack() // the gain_life spell_effect (top)
    await s.as('B').resolveStack() // then B's Armasaur draw trigger

    const hand = await s.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_cards
       where session_id = $1 and owner_id = $2 and zone = 'hand'`,
      [s.sessionId, s.players.B])
    assert.equal(Number(hand.rows[0]!.n), 1) // exactly one draw, for B
  })
})

// ST5 — Rampaging Brontodon: +1/+1 per land you control when it attacks.
test('ST5 Rampaging Brontodon pumps by land count on attack', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    for (let i = 0; i < 3; i++) await s.spawn('A', 'Forest Test', 'battlefield')
    const bronto = await s.spawnCreature('A', 'Rampaging Brontodon Test') // 7/6, no ETB
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })

    await s.as('A').declareAttacker(bronto, 'B')
    await s.as('A').resolveStack()

    assert.equal(await s.effectivePower(bronto), 10) // 7 + 3 lands
    assert.equal(await s.effectiveToughness(bronto), 9) // 6 + 3 lands
  })
})

// ST6 — Atzocan Seer: sacrifice returns a Dinosaur card from the graveyard
// to hand (and the Seer itself ends up in the graveyard).
test('ST6 Atzocan Seer sac returns a graveyard Dinosaur to hand', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const dino = await s.spawnCreature('A', 'Dino Grunt Test')
    await s.putInGraveyard(dino)
    const seer = await s.spawnCreature('A', 'Atzocan Seer Test') // no ETB

    await s.as('A').activate(seer, 1) // index 1 = the sacrifice ability
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'return_from_graveyard')
    await s.as('A').submitDecision(d!.id, { chosen: [dino] })

    const back = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [dino])
    assert.equal(back.rows[0]!.zone, 'hand')
    const gone = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [seer])
    assert.equal(gone.rows[0]!.zone, 'graveyard')
  })
})
