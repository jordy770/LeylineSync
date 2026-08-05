// Bucket 9 — reflexive/conditional riders (mig 442). Four gaps:
//   • Firebreathing (Stormshriek Feral): pump with target_type 'self' — the
//     activated ability pumps its own source, no target required.
//   • Oblation: shuffle_into_library gets an owner_draws rider — the target's
//     OWNER draws after the shuffle.
//   • Not Dead After All: grant_dies_effect gets expires 'end_of_turn' — the
//     granted return lapses at cleanup. (Wicked Role approximated as the
//     existing plus_one_counters return-rider.)
//   • Daretti ultimate: create_emblem 'artifact_return' — a player-scoped
//     emblem row; artifacts dying while it stands are stamped and returned to
//     the battlefield when the end step is processed. Survives the source.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// RR1 — self-pump: activating firebreathing without a target pumps the source.
test('RR1 pump target_type self pumps the source without a target', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const dragon = await s.spawnCreature('A', 'Firebreathing Dragon Test') // 4/4
    await s.setMana('A', { C: 1, R: 1 })

    await s.as('A').activate(dragon, 0) // geen target
    await s.as('A').resolveStack()

    assert.equal(await s.effectivePower(dragon), 5, 'source kreeg +1/+0')
  })
})

// RR2 — Oblation: the target's OWNER draws two after the shuffle.
test('RR2 shuffle_into_library owner_draws lets the owner draw', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const victim = await s.spawnCreature('B', 'Vampire Bear Test')
    // B heeft bibliotheekkaarten nodig om te kunnen trekken.
    await s.spawn('B', 'Vampire Bear Test', 'library')
    await s.spawn('B', 'Vampire Bear Test', 'library')
    await s.spawn('B', 'Vampire Bear Test', 'library')
    const handBefore = await client.query(
      `select count(*)::int as n from public.game_cards where session_id = $1 and owner_id = $2 and zone = 'hand'`,
      [s.sessionId, s.players.B])

    await s.as('A').castSpellEffect(
      [{ type: 'shuffle_into_library', target_type: 'permanent', owner_draws: 2 }],
      null, null, victim)
    await s.as('A').resolveStack()

    // De shuffle is random: het slachtoffer kan door de draw meteen weer in
    // B's hand belanden — dat is correct Oblation-gedrag. Vast staat: niet
    // meer op het slagveld, en B (de eigenaar) trok er twee.
    const victimZone = await s.zoneOf(victim)
    assert.ok(['library', 'hand'].includes(victimZone), `van het slagveld af (zone: ${victimZone})`)
    const handAfter = await client.query(
      `select count(*)::int as n from public.game_cards where session_id = $1 and owner_id = $2 and zone = 'hand'`,
      [s.sessionId, s.players.B])
    assert.equal(handAfter.rows[0].n, handBefore.rows[0].n + 2, 'de EIGENAAR trok twee kaarten')
  })
})

// RR3 — Not Dead: the grant with expires still fires within the turn.
test('RR3 grant_dies_effect with expires fires within the turn', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bear = await s.spawnCreature('A', 'Vampire Bear Test')

    await s.as('A').castSpellEffect(
      [{ type: 'grant_dies_effect', target_type: 'creature', expires: 'end_of_turn',
         effects: [{ type: 'return_self_to_battlefield', tapped: true, plus_one_counters: 1 }] }],
      null, null, bear)
    await s.as('A').resolveStack()

    await s.as('A').putInGraveyard(bear)
    while (await s.topStackItem()) await s.as('A').resolveStack()

    const st = await s.cardState(bear)
    assert.equal(st.zone, 'battlefield', 'terug op het slagveld')
    assert.equal(st.is_tapped, true, 'getapt terug')
    assert.equal(st.plus_one_counters, 1, 'Wicked-Role-benadering: +1/+1 counter')
  })
})

// RR4 — Not Dead: the grant LAPSES once cleanup passes.
test('RR4 grant_dies_effect expires at end of turn', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bear = await s.spawnCreature('A', 'Vampire Bear Test')

    await s.as('A').castSpellEffect(
      [{ type: 'grant_dies_effect', target_type: 'creature', expires: 'end_of_turn',
         effects: [{ type: 'return_self_to_battlefield', tapped: true }] }],
      null, null, bear)
    await s.as('A').resolveStack()

    // Door het einde van de beurt heen: end → cleanup → volgende beurt. De
    // expiry-sweep draait bij het VERLATEN van een step, dus pas de tweede
    // advance (vanuit cleanup) ruimt de ending/cleanup-grant op.
    await s.setTurn({ phase: 'ending', step: 'end', active: 'A', priority: 'A' })
    await s.as('A').advanceStep()
    await s.as('A').advanceStep()
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    await s.as('A').putInGraveyard(bear)
    while (await s.topStackItem()) await s.as('A').resolveStack()
    assert.equal((await s.cardState(bear)).zone, 'graveyard', 'grant verlopen: blijft dood')
  })
})

// RR5 — Daretti-emblem: dying artifact is returned when the end step is
// processed; the emblem survives the planeswalker's own death (the -10 kills
// him via the 0-loyalty SBA).
test('RR5 artifact_return emblem returns dead artifacts at end step', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const walker = await s.spawn('A', 'Scrap Emblem Walker Test', 'battlefield')
    const relic = await s.spawn('A', 'Unstable Obelisk Test', 'battlefield')
    await client.query(
      `update public.game_cards set counters = coalesce(counters, '{}'::jsonb) || '{"loyalty": 10}'::jsonb where id = $1`,
      [walker])

    await s.as('A').activateLoyalty(walker, 0) // -10 → loyalty 0 → SBA sloopt de walker
    while (await s.topStackItem()) await s.as('A').resolveStack()
    assert.equal(await s.zoneOf(walker), 'graveyard', 'walker stierf aan de ultimate')

    const emblems = await client.query(
      `select count(*)::int as n from public.game_continuous_effects
       where session_id = $1 and effect_type = 'artifact_return_emblem' and affected_player_id = $2`,
      [s.sessionId, s.players.A])
    assert.equal(emblems.rows[0].n, 1, 'emblem-rij staat er (en overleefde de walker)')

    await s.as('A').putInGraveyard(relic)
    assert.equal(await s.zoneOf(relic), 'graveyard', 'artifact ligt eerst gewoon in het kerkhof')

    // De end-step-sweep haalt hem terug.
    await s.setTurn({ phase: 'ending', step: 'end', active: 'A', priority: 'A' })
    await s.as('A').advanceStep()
    assert.equal(await s.zoneOf(relic), 'battlefield', 'artifact terug op het slagveld na de end step')
  })
})

// RR6 — the emblem only stamps ARTIFACTS: a dying creature stays dead.
test('RR6 the emblem ignores non-artifacts', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const walker = await s.spawn('A', 'Scrap Emblem Walker Test', 'battlefield')
    const bear = await s.spawnCreature('A', 'Vampire Bear Test')
    await client.query(
      `update public.game_cards set counters = coalesce(counters, '{}'::jsonb) || '{"loyalty": 10}'::jsonb where id = $1`,
      [walker])
    await s.as('A').activateLoyalty(walker, 0)
    while (await s.topStackItem()) await s.as('A').resolveStack()

    await s.as('A').putInGraveyard(bear)
    await s.setTurn({ phase: 'ending', step: 'end', active: 'A', priority: 'A' })
    await s.as('A').advanceStep()
    assert.equal(await s.zoneOf(bear), 'graveyard', 'creature blijft in het kerkhof')
  })
})
