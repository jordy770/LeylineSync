// Verifies p_free skips the payment block: a {2}{R} instant cast from exile with
// an empty mana pool succeeds only when free, and raises otherwise.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx, asPlayer } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => { await ensureTestCards() })

// Scenario.as() only records the acting seat (used by Scenario's own helper
// methods, which route through the private run()/asPlayer()); it does not set
// the request.jwt.claims GUC that auth.uid() reads. A raw client.query call
// must set that context itself via asPlayer, or auth.uid() fails casting the
// unset claim to json.
async function castFromExile(s: Scenario, cardId: string, free: boolean) {
  return asPlayer(s.client, s.playerId('A'), () =>
    s.client.query(
      `select public.cast_spell_effect($1, $2::jsonb, $3, 0, null, false, $4)`,
      [s.sessionId, JSON.stringify([{ type: 'deal_damage', amount: 3, target_type: ['creature', 'player'] }]), cardId, free]))
}

test('FC1 free cast from exile skips payment; non-free raises on empty pool', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const probeFree = await s.spawn('A', 'Free Probe Bolt Test', 'exile')
    const probePaid = await s.spawn('A', 'Free Probe Bolt Test', 'exile')
    // cast_spell_effect gates any exile-zone cast on a play_from_exile permission
    // (checked unconditionally, before the payment block p_free guards) — grant it
    // for both cards, same as other exile-cast tests (e.g. urianger.test.ts).
    await client.query(
      `insert into public.game_continuous_effects (session_id, source_card_id, affected_player_id, effect_type, payload)
       values ($1, $2, $3, 'play_from_exile', $4::jsonb)`,
      [s.sessionId, probeFree, s.playerId('A'), JSON.stringify({ card_ids: [probeFree, probePaid], permanent: true })],
    )
    await s.setMana('A', {}) // empty pool

    // free = true → succeeds. cast_spell_effect moves a non-permanent (instant/
    // sorcery) source straight to the graveyard at cast time (no transient
    // "on the stack" zone for the source card — only game_stack_items represents
    // the stack), so a successful cast is observed via that zone move.
    await castFromExile(s, probeFree, true)
    assert.equal(await s.zoneOf(probeFree), 'graveyard')

    // free = false → cannot pay {2}{R} with empty pool
    await assert.rejects(() => castFromExile(s, probePaid, false) as Promise<unknown>)
  })
})
