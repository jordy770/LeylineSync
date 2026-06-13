// mig 239 — token-copy primitive (Will of the Temur + Reflections of Littjara).
//   • copy_permanent: token copy of a picked battlefield permanent (parked
//     decision) or of the triggering card (Littjara copying a cast spell).
//     The copy points at the copied card's catalog row + is_token on the GAME
//     card; `except` becomes a set_pt override + keyword grants.
//   • choose_one modes may now park (trigger_modal splices the chosen modes'
//     actions into the program); may_choose_both_if_commander raises the
//     ceiling when the caster controls a commander.
//   • greatest_mana_value_you_control count source (Will's draw mode).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { asPlayer, withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

const WILL_ACTIONS = [
  {
    type: 'choose_one',
    prompt: 'Choose one',
    may_choose_both_if_commander: true,
    modes: [
      {
        label: 'Copy',
        actions: [
          {
            type: 'copy_permanent',
            target_filter: { controller: 'any' },
            except: { power: 4, toughness: 4, keywords: ['flying'] },
          },
        ],
      },
      {
        label: 'Draw',
        actions: [{ type: 'draw', amount: { count: 'greatest_mana_value_you_control' } }],
      },
    ],
  },
]

async function battlefieldByName(s: Scenario, name: string): Promise<{ id: string; is_token: boolean }[]> {
  const r = await s.client.query<{ id: string; is_token: boolean }>(
    `select gc.id, gc.is_token from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.zone = 'battlefield' and c.name = $2 order by gc.zone_position`,
    [s.sessionId, name])
  return r.rows
}

async function handCount(s: Scenario, seat: 'A' | 'B'): Promise<number> {
  const r = await s.client.query<{ n: string }>(
    `select count(*)::int as n from public.game_cards
     where session_id = $1 and owner_id = $2 and zone = 'hand'`,
    [s.sessionId, s.players[seat]])
  return Number(r.rows[0]!.n)
}

// CP1 — Will copy mode: token copy of a 5/5 Dragon Token enters as a 4/4 with flying.
test('CP1 copy_permanent makes a token copy with the except overrides', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const original = await s.spawnCreature('A', 'Dragon Token')

    await s.as('A').castSpellEffect(WILL_ACTIONS)
    await s.as('A').resolveStack()

    // No commander: exactly one mode may be chosen.
    let d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'choose_mode')
    assert.equal(d!.max_choices, 1)
    await s.as('A').submitDecision(d!.id, { chosen: [0] })

    // The copy mode parks a pick over battlefield permanents.
    d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'copy_permanent')
    await s.as('A').submitDecision(d!.id, { chosen: [original] })

    const dragons = await battlefieldByName(s, 'Dragon Token')
    assert.equal(dragons.length, 2)
    const copy = dragons.find((g) => g.id !== original)!
    assert.equal(copy.is_token, true)
    // except: base P/T overridden to 4/4 (the original stays 5/5) + flying.
    assert.equal(await s.effectivePower(copy.id), 4)
    assert.equal(await s.effectivePower(original), 5)
    const fly = await s.client.query(
      `select 1 from public.game_continuous_effects
       where session_id = $1 and affected_card_id = $2 and effect_type = 'flying'`,
      [s.sessionId, copy.id])
    assert.ok(fly.rows.length >= 1)
  })
})

// CP2 — Will draw mode: draw cards equal to the greatest mana value you control.
test('CP2 draw mode counts the greatest mana value among your permanents', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Rapacious Dragon Test') // {4}{R} -> mana value 5
    await s.as('A').resolveStack() // its ETB (two Treasures, mana value 0)
    for (let i = 0; i < 6; i++) await s.spawn('A', 'Wastes Test', 'library')

    const before = await handCount(s, 'A')
    await s.as('A').castSpellEffect(WILL_ACTIONS)
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { chosen: [1] })

    assert.equal(await handCount(s, 'A'), before + 5)
  })
})

// CP3 — controlling a commander allows choosing BOTH modes; the spliced
// program parks the copy pick first, then the draw runs after it resolves.
test('CP3 with a commander both modes can be chosen and both apply', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const cmd = await s.spawnCreature('A', 'Rapacious Dragon Test') // mana value 5
    await s.as('A').resolveStack() // ETB Treasures
    await s.client.query('update public.game_cards set is_commander = true where id = $1', [cmd])
    for (let i = 0; i < 6; i++) await s.spawn('A', 'Wastes Test', 'library')

    const before = await handCount(s, 'A')
    await s.as('A').castSpellEffect(WILL_ACTIONS)
    await s.as('A').resolveStack()

    let d = await s.pendingDecision()
    assert.equal(d!.max_choices, 2)
    await s.as('A').submitDecision(d!.id, { chosen: [0, 1] })

    // Copy pick parks; the draw is spliced after it and runs on resume.
    d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'copy_permanent')
    await s.as('A').submitDecision(d!.id, { chosen: [cmd] })

    assert.equal((await battlefieldByName(s, 'Rapacious Dragon Test')).length, 2)
    assert.equal(await handCount(s, 'A'), before + 5)
  })
})

// CP4 — Reflections of Littjara: choose Dragon at ETB; casting a Dragon spell
// creates a token copy of it (the copy enters before the original resolves).
test('CP4 Littjara copies a cast spell of the chosen type', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const littjara = await s.spawn('A', 'Reflections of Littjara Test', 'hand')
    await s.setMana('A', { U: 1, C: 4 })
    await s.as('A').castPermanent(littjara)
    await s.as('A').resolveStack() // cast resolves; ETB trigger enqueued
    await s.as('A').resolveStack() // ETB trigger -> choose a creature type
    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'choose_creature_type')
    await s.as('A').submitDecision(d!.id, { type: 'Dragon' })

    // The chosen type is baked into the card's own script.
    const baked = await s.client.query<{ s: string }>(
      `select copied_script::text as s from public.game_cards where id = $1`, [littjara])
    assert.match(baked.rows[0]!.s, /"Dragon"/)
    assert.doesNotMatch(baked.rows[0]!.s, /\$chosen/)

    // Cast a Dragon: the spell_cast watcher copies it onto the battlefield.
    const dragon = await s.spawn('A', 'Rapacious Dragon Test', 'hand')
    await s.setMana('A', { R: 1, C: 4 })
    await s.as('A').castPermanent(dragon)
    await s.as('A').resolveStack() // Littjara trigger -> token copy enters
    let rows = await battlefieldByName(s, 'Rapacious Dragon Test')
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.is_token, true)

    await s.as('A').resolveStack() // the copy's own ETB trigger (two Treasures)
    await s.as('A').resolveStack() // the cast itself resolves
    rows = await battlefieldByName(s, 'Rapacious Dragon Test')
    assert.equal(rows.length, 2)
  })
})

// CP5 — a copy token ceases to exist when it dies, and does NOT bump the
// nontoken death tally (it is a game-level token of a nontoken catalog row).
test('CP5 a dying copy token ceases and stays out of the nontoken tally', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const original = await s.spawnCreature('A', 'Dragon Token')

    // create_copy_token re-registers continuous effects, which is auth-gated.
    const made = await asPlayer(s.client, s.players.A, () =>
      s.client.query<{ id: string }>(
        'select public.create_copy_token($1, $2, $3, null) as id',
        [s.sessionId, s.players.A, original]))
    const copy = made.rows[0]!.id

    await s.putInGraveyard(copy)
    const gone = await s.client.query('select 1 from public.game_cards where id = $1', [copy])
    assert.equal(gone.rows.length, 0)
    const tally = await s.client.query<{ n: number }>(
      `select turn_nontoken_creatures_died as n from public.game_session_players
       where session_id = $1 and player_id = $2`,
      [s.sessionId, s.players.A])
    assert.equal(Number(tally.rows[0]!.n), 0)
  })
})
