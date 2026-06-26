// Copy-token end-step cleanup (mig 347). The copy_permanent action already makes
// a token copy of a target creature (with except.keywords:['haste']). Electroduplicate
// adds "Sacrifice it at the beginning of the next end step": create_copy_token now
// stamps a cleanup_at_end_step marker and advance_step removes such tokens when the
// end step is left.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

const ELECTRO = [{ type: 'copy_permanent', target_filter: { controller: 'you', type_line: 'Creature' }, except: { keywords: ['haste'], cleanup_at_end_step: true } }]

async function tokenCopies(s: Scenario): Promise<Array<{ id: string }>> {
  const r = await s.client.query<{ id: string }>(
    `select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.zone = 'battlefield' and gc.is_token = true and c.name = 'Vampire Bear Test'`,
    [s.sessionId])
  return r.rows
}

// CT1 — Electroduplicate makes a hasty token copy of your creature.
test('CT1 copy_permanent makes a hasty token copy', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bear = await s.spawnCreature('A', 'Vampire Bear Test')

    await s.as('A').castSpellEffect(ELECTRO)
    await s.as('A').resolveStack() // parks the copy pick
    const d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'copy_permanent')
    await s.as('A').submitDecision(d!.id, { chosen: [bear] })

    const toks = await tokenCopies(s)
    assert.equal(toks.length, 1, 'one token copy created')
    assert.equal(await s.continuousEffectCount(toks[0].id, 'haste'), 1, 'token has haste')
  })
})

// CT2 — the token is sacrificed at the next end step.
test('CT2 the copy token is removed at the end step', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bear = await s.spawnCreature('A', 'Vampire Bear Test')

    await s.as('A').castSpellEffect(ELECTRO)
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { chosen: [bear] })
    assert.equal((await tokenCopies(s)).length, 1)

    await s.setTurn({ phase: 'ending', step: 'end', active: 'A', priority: 'A' })
    await s.as('A').advanceStep() // leaving the end step runs the cleanup

    assert.equal((await tokenCopies(s)).length, 0, 'token sacrificed at end step')
    assert.equal(await s.zoneOf(bear), 'battlefield', 'the original is untouched')
  })
})
