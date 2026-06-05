// F3 — Protection (DEBT), slice 1: the "can't be Targeted" (T) gate (mig 131).
// A creature with protection from a colour can't be chosen as the target of a
// spell/ability of that colour. Colour is derived from the source's mana_cost.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// PT1 — a red spell can't target a creature with protection from red.
test('PT1 protection from red blocks a red spell from targeting it', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { R: 5 })
    const ward = await s.spawnCreature('B', 'Ember Ward Test') // protection from red
    const spear = await s.spawn('A', 'Searing Spear Test', 'hand') // {R} deal 3

    await assert.rejects(
      () => s.as('A').putOnStack('deal_damage_creature', { target_card_id: ward, amount: 3, target_controller: 'any' }, spear),
      /protection/i,
    )
  })
})

// PT2 — protection is colour-specific: a red spell CAN target protection-from-blue.
test('PT2 protection from blue does not block a red spell', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { R: 5 })
    const ward = await s.spawnCreature('B', 'Frost Ward Test') // protection from blue
    const spear = await s.spawn('A', 'Searing Spear Test', 'hand')

    await s.as('A').putOnStack('deal_damage_creature', { target_card_id: ward, amount: 3, target_controller: 'any' }, spear)
    assert.equal(await s.pendingCount(), 1) // the spell announced successfully
  })
})

// PT3 — regression: a red spell targets an ordinary creature as before.
test('PT3 a red spell still targets a creature without protection', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { R: 5 })
    const bear = await s.spawnCreature('B', 'Air Elemental Test')
    const spear = await s.spawn('A', 'Searing Spear Test', 'hand')

    await s.as('A').putOnStack('deal_damage_creature', { target_card_id: bear, amount: 3, target_controller: 'any' }, spear)
    assert.equal(await s.pendingCount(), 1)
  })
})

// PT4 — the trigger path: a red creature's ETB-damage trigger can't pick a
// protection-from-red target. (A rejected RPC aborts the tx, so the legal-target
// case is its own test, PT5.)
test('PT4 protection blocks a red trigger from choosing the target', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    await s.spawnCreature('B', 'Air Elemental Test') // ordinary, so the trigger enqueues
    const ward = await s.spawnCreature('B', 'Ember Ward Test') // protection from red
    await s.spawnCreature('A', 'Flame Mage Test') // {R} ETB: deal 2 to a creature you don't control

    const trigger = await s.topStackItem()
    assert.equal(trigger?.action_type, 'triggered_ability')

    await assert.rejects(
      () => s.as('A').chooseTriggerTarget(trigger!.id, ward),
      /protection/i,
    )
  })
})

// PT5 — the same red trigger CAN pick an ordinary creature.
test('PT5 a red trigger can choose an unprotected target', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const bear = await s.spawnCreature('B', 'Air Elemental Test') // ordinary
    await s.spawnCreature('A', 'Flame Mage Test')

    const trigger = await s.topStackItem()
    assert.equal(trigger?.action_type, 'triggered_ability')

    await s.as('A').chooseTriggerTarget(trigger!.id, bear)
  })
})

// ── D gate (can't be Damaged): COMBAT damage (mig 132) ─────────────────────

// Drive A's attacker into a single B blocker, landing on combat_damage with A on
// priority. Returns { attacker, blocker }.
async function block(s: Scenario, attackerName: string, blockerName: string) {
  const attacker = await s.spawnCreature('A', attackerName)
  const blocker = await s.spawnCreature('B', blockerName)

  await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
  await s.as('A').declareAttacker(attacker, 'B')
  await s.setTurn({ phase: 'combat', step: 'declare_blockers', active: 'A', priority: 'B' })
  await s.as('B').declareBlocker(blocker, attacker)
  await s.setTurn({ phase: 'combat', step: 'combat_damage', active: 'A', priority: 'A' })
  return { attacker, blocker }
}

async function damageOf(s: Scenario, card: string): Promise<number> {
  const st = await s.cardState(card)
  return Number((st as { damage_marked: number }).damage_marked)
}

// DG1 — a protection-from-red blocker takes no damage from a red attacker (but
// still deals its own damage back).
test('DG1 protection blocks combat damage from a red attacker', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const { attacker, blocker } = await block(s, 'Goblin Raider Test', 'Ember Ward Test') // {R} 2/2 vs prot-red 2/2

    await s.as('A').resolveCombat()

    assert.equal(await damageOf(s, blocker), 0) // protection prevented the red damage
    assert.equal(await s.zoneOf(blocker), 'battlefield')
    assert.equal(await s.zoneOf(attacker), 'graveyard') // colourless ward still dealt 2 back
  })
})

// DG2 — regression: protection from a DIFFERENT colour does not stop red combat
// damage; the blocker takes its 2 and dies.
test('DG2 protection from another colour does not stop red combat damage', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const { blocker } = await block(s, 'Goblin Raider Test', 'Frost Ward Test') // {R} 2/2 vs prot-blue 2/2

    await s.as('A').resolveCombat()

    // Took its 2 (red) damage → lethal → graveyard (damage_marked resets on death).
    assert.equal(await s.zoneOf(blocker), 'graveyard')
  })
})

// (The "attacker protected from its blocker's colour" case is unreachable in legal
// combat once the B gate exists — a creature of that colour can't block the
// protected attacker in the first place (see BG1). The blocker-side guard in
// resolve_combat_damage stays as defensive depth.)

// ── B gate (can't be Blocked): declare_blocker (mig 133) ───────────────────

// Declare A's attacker on B, advance to declare_blockers with B on priority, and
// return the attacker so a test can try a block. Returns { attacker, blocker }.
async function attackThen(s: Scenario, attackerName: string, blockerName: string) {
  const attacker = await s.spawnCreature('A', attackerName)
  const blocker = await s.spawnCreature('B', blockerName)
  await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
  await s.as('A').declareAttacker(attacker, 'B')
  await s.setTurn({ phase: 'combat', step: 'declare_blockers', active: 'A', priority: 'B' })
  return { attacker, blocker }
}

async function blockerCount(s: Scenario, attacker: string): Promise<number> {
  const res = await s.client.query<{ n: string }>(
    `select count(*)::int as n from public.game_combat_blockers
       where session_id = $1 and attacker_card_id = $2`,
    [s.sessionId, attacker],
  )
  return Number(res.rows[0]?.n ?? 0)
}

// BG1 — a red creature can't block an attacker with protection from red.
test('BG1 a red creature cannot block a protection-from-red attacker', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const { attacker, blocker } = await attackThen(s, 'Ember Ward Test', 'Goblin Raider Test') // prot-red vs {R}

    await assert.rejects(
      () => s.as('B').declareBlocker(blocker, attacker),
      /protection|cannot be blocked/i,
    )
  })
})

// BG2 — protection from a different colour does not stop a red blocker.
test('BG2 a red creature can block a protection-from-blue attacker', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const { attacker, blocker } = await attackThen(s, 'Frost Ward Test', 'Goblin Raider Test') // prot-blue vs {R}

    await s.as('B').declareBlocker(blocker, attacker)
    assert.equal(await blockerCount(s, attacker), 1) // block was allowed
  })
})
