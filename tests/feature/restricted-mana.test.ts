// mig 320 — restricted ("spend only") mana. An add_mana effect with a
// `restriction` produces mana into game_players.restricted_mana; pay_mana_cost
// spends it (restricted-first) only when the pay context matches the restriction
// (cast type_line / ability-source type_line / commander). Cards: Haven of the
// Spirit Dragon (Dragon casts), Ixalli's Lorekeeper (Dinosaur), Unclaimed
// Territory / Secluded Courtyard (chosen type), Vedalken Engineer (artifact).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// ── Direct pay_mana_cost eligibility (covers every restriction branch) ──────────

// RC1 — a Dragon-restricted mana pays a Dragon creature spell.
test('RC1 restricted mana pays a matching cast', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setRestrictedMana('A', [{ color: 'R', amount: 1, spell_type_line: 'Dragon' }])
    const pool = await s.payMana('A', '{R}', { context: { kind: 'cast', type_line: 'Legendary Creature — Dragon' } })
    assert.equal(pool.R, 0)
    assert.equal((await s.getRestrictedMana('A')).length, 0) // consumed
  })
})

// RC2 — the same mana can NOT pay a non-Dragon spell.
test('RC2 restricted mana rejected for a non-matching cast', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setRestrictedMana('A', [{ color: 'R', amount: 1, spell_type_line: 'Dragon' }])
    await assert.rejects(
      () => s.payMana('A', '{R}', { context: { kind: 'cast', type_line: 'Creature — Ogre' } }),
      /Not enough/i,
    )
  })
})

// RC3 — an ability-source restriction pays an ability activation of a matching source.
test('RC3 restricted mana pays a matching ability activation', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setRestrictedMana('A', [
      { color: 'G', amount: 1, spell_type_line: 'Dinosaur', ability_source_type_line: 'Dinosaur' },
    ])
    const pool = await s.payMana('A', '{G}', { context: { kind: 'ability', type_line: 'Creature — Dinosaur' } })
    assert.equal(pool.G, 0)
    assert.equal((await s.getRestrictedMana('A')).length, 0)
  })
})

// RC4 — an ability of a non-matching source can't spend it.
test('RC4 restricted mana rejected for a non-matching ability', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setRestrictedMana('A', [
      { color: 'G', amount: 1, spell_type_line: 'Dinosaur', ability_source_type_line: 'Dinosaur' },
    ])
    await assert.rejects(
      () => s.payMana('A', '{G}', { context: { kind: 'ability', type_line: 'Artifact' } }),
      /Not enough/i,
    )
  })
})

// RC5 — commander-restricted mana pays a commander spell, but not a normal one.
test('RC5 commander-restricted mana pays only commander spells', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setRestrictedMana('A', [{ color: 'R', amount: 1, commander: true }])
    const pool = await s.payMana('A', '{R}', { context: { kind: 'cast', is_commander: true } })
    assert.equal(pool.R, 0)
    assert.equal((await s.getRestrictedMana('A')).length, 0)
  })
})

test('RC6 commander-restricted mana rejected for a non-commander spell', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setRestrictedMana('A', [{ color: 'R', amount: 1, commander: true }])
    await assert.rejects(
      () => s.payMana('A', '{R}', { context: { kind: 'cast', is_commander: false } }),
      /Not enough/i,
    )
  })
})

// RC7 — restricted mana is spent BEFORE open mana (use-it-or-lose-it).
test('RC7 restricted mana is spent before open mana', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setRestrictedMana('A', [{ color: 'R', amount: 1, spell_type_line: 'Dragon' }])
    await s.setMana('A', { R: 1 }) // one open R alongside the restricted R
    const pool = await s.payMana('A', '{R}', { context: { kind: 'cast', type_line: 'Creature — Dragon' } })
    assert.equal(pool.R, 1) // the OPEN R survives; the restricted one was spent
    assert.equal((await s.getRestrictedMana('A')).length, 0)
  })
})

// RC8 — with no pay context (cycling, manifest face-up, …) restricted mana is unusable.
test('RC8 restricted mana is unusable without a pay context', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setRestrictedMana('A', [{ color: 'R', amount: 1, spell_type_line: 'Dragon' }])
    await assert.rejects(() => s.payMana('A', '{R}'), /Not enough/i)
  })
})

// ── Haven of the Spirit Dragon end-to-end (production + routing + clearing) ──────

// RM1 — Haven taps for restricted mana, which then casts a Dragon creature.
test('RM1 Haven restricted mana casts a Dragon creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const haven = await s.spawn('A', 'Haven of the Spirit Dragon Test', 'battlefield')
    await s.as('A').activateMana(haven, 1, null, 'R') // ability 1 = any colour (restricted)
    const restricted = await s.getRestrictedMana('A')
    assert.equal(restricted.length, 1)
    assert.equal(restricted[0]!.color, 'R')

    await s.setMana('A', { C: 3 }) // cover the {3} generic of Gadrak's {3}{R}
    const dragon = await s.spawn('A', 'Gadrak Test', 'hand')
    await s.as('A').castPermanent(dragon) // pays {R} from restricted, {3} from C
    assert.equal((await s.getRestrictedMana('A')).length, 0) // restricted R consumed
  })
})

// RM2 — that same restricted mana can't cast a non-Dragon creature.
test('RM2 Haven restricted mana cannot cast a non-Dragon', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const haven = await s.spawn('A', 'Haven of the Spirit Dragon Test', 'battlefield')
    await s.as('A').activateMana(haven, 1, null, 'R')
    await s.setMana('A', { C: 2 }) // cover the {2} generic of Menace Brute's {2}{R}
    const ogre = await s.spawn('A', 'Menace Brute Test', 'hand') // Creature - Ogre
    await assert.rejects(() => s.as('A').castPermanent(ogre), /Not enough/i)
  })
})

// RM3 — restricted mana empties at end of step like open mana.
test('RM3 restricted mana clears on step advance', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const haven = await s.spawn('A', 'Haven of the Spirit Dragon Test', 'battlefield')
    await s.as('A').activateMana(haven, 1, null, 'R')
    assert.equal((await s.getRestrictedMana('A')).length, 1)

    await s.as('A').advanceStep()
    assert.equal((await s.getRestrictedMana('A')).length, 0)
  })
})
