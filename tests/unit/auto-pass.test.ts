// shouldAutoPass — the controller's pure "should I pass priority right now?"
// decision (lib/game/auto-pass). Covers every switch and the hard exemptions.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldAutoPass, type AutoPassDecisionInput, type AutoPassSettings } from '../../lib/game/auto-pass'

// All skips on, stops at their defaults (rsp off) — the fresh-session shape.
const SETTINGS: AutoPassSettings = { op: true, own: true, stk: true, rsp: false, atk: true, blk: true, mn: true, res: false }

// A neutral "your own empty step, nothing on the stack" input. Override per test.
function input(over: Partial<AutoPassDecisionInput> = {}, settings: Partial<AutoPassSettings> = {}): AutoPassDecisionInput {
  return {
    step: 'upkeep',
    isActivePlayer: true,
    hasPriority: true,
    isSessionFinished: false,
    passBlocked: false,
    isYielding: false,
    autoPass: { ...SETTINGS, ...settings },
    currentStackKey: '',
    ackStackKey: '',
    iHaveResponse: false,
    hasEligibleAttacker: false,
    hasBlockDecision: false,
    hasMainPhaseAction: false,
    openingHandPending: false,
    ...over,
  }
}

const decide = (over?: Partial<AutoPassDecisionInput>, settings?: Partial<AutoPassSettings>) =>
  shouldAutoPass(input(over, settings))

// ── Hard exemptions (win over everything, including yielding) ──────────────────

test('no priority → never pass', () => {
  assert.equal(decide({ hasPriority: false }), false)
})

test('finished session → never pass', () => {
  assert.equal(decide({ isSessionFinished: true }), false)
})

test('a pending decision blocks passing', () => {
  assert.equal(decide({ passBlocked: true }), false)
})

test('opening hand not kept → never pass (would draw before the keep)', () => {
  // Even on a normally-skipped empty step.
  assert.equal(decide({ step: 'draw', openingHandPending: true }), false)
})

test('declare_blockers with a real block to make → never auto-pass', () => {
  assert.equal(decide({ step: 'declare_blockers', isActivePlayer: false, hasBlockDecision: true }), false)
})

test('a real block beats "yield rest of turn"', () => {
  assert.equal(
    decide({ step: 'declare_blockers', isActivePlayer: false, hasBlockDecision: true, isYielding: true }),
    false,
  )
})

test('passBlocked beats yielding', () => {
  assert.equal(decide({ passBlocked: true, isYielding: true }), false)
})

// ── Yield rest of turn ─────────────────────────────────────────────────────────

test('yielding passes a step no switch would skip (main phase, all skips off)', () => {
  assert.equal(
    decide({ step: 'precombat_main', isYielding: true }, { own: false, mn: false }),
    true,
  )
})

// ── own: empty phases ──────────────────────────────────────────────────────────

for (const step of ['untap', 'upkeep', 'draw', 'beginning_of_combat', 'end_of_combat', 'end'] as const) {
  test(`own on → auto-pass your empty ${step}`, () => {
    assert.equal(decide({ step }), true)
  })
}

test('own off → hold your empty phases', () => {
  assert.equal(decide({ step: 'draw' }, { own: false }), false)
})

test('own does NOT cover your main phase (that is mn)', () => {
  assert.equal(decide({ step: 'precombat_main' }, { mn: false }), false)
})

// ── atk: declare attackers ─────────────────────────────────────────────────────

test('atk on + no eligible attacker → skip declare_attackers', () => {
  assert.equal(decide({ step: 'declare_attackers', hasEligibleAttacker: false }), true)
})

test('atk on but you HAVE an attacker → hold declare_attackers (a real choice)', () => {
  assert.equal(decide({ step: 'declare_attackers', hasEligibleAttacker: true }), false)
})

test('atk off → hold declare_attackers even with nothing to attack with', () => {
  assert.equal(decide({ step: 'declare_attackers', hasEligibleAttacker: false }, { atk: false }), false)
})

// ── mn: dead POSTCOMBAT main phase (precombat M1 always stops) ──────────────────

test('mn NEVER skips precombat main (M1) — your develop phase always stops', () => {
  assert.equal(decide({ step: 'precombat_main' }), false)
  // even with nothing playable + empty stack it holds
  assert.equal(decide({ step: 'precombat_main', hasMainPhaseAction: false, currentStackKey: '' }), false)
})

test('mn on + empty stack + nothing playable → skip postcombat_main', () => {
  assert.equal(decide({ step: 'postcombat_main' }), true)
})

test('mn on but something is playable → hold postcombat main', () => {
  assert.equal(decide({ step: 'postcombat_main', hasMainPhaseAction: true }), false)
})

test('mn on but the stack is not empty → hold postcombat main (resolve window)', () => {
  assert.equal(decide({ step: 'postcombat_main', currentStackKey: 'a' }), false)
})

test('mn off → hold a dead postcombat main phase', () => {
  assert.equal(decide({ step: 'postcombat_main' }, { mn: false }), false)
})

// ── res: auto-resolve your own stack ───────────────────────────────────────────
test('res on + something on your stack + no response → auto-pass to resolve', () => {
  assert.equal(decide({ step: 'precombat_main', currentStackKey: 'a' }, { res: true }), true)
})

test('res off → hold a non-empty stack on your turn (manual resolve)', () => {
  assert.equal(decide({ step: 'precombat_main', currentStackKey: 'a' }, { res: false }), false)
})

test('res on but empty stack → nothing to resolve (falls through to other switches)', () => {
  assert.equal(decide({ step: 'precombat_main', currentStackKey: '' }, { res: true }), false)
})

test('res on + rsp on + you hold a response → stop (let me act)', () => {
  assert.equal(decide({ step: 'precombat_main', currentStackKey: 'a', iHaveResponse: true }, { res: true, rsp: true }), false)
})

test('res on + rsp OFF + you hold a response → still auto-resolve', () => {
  assert.equal(decide({ step: 'precombat_main', currentStackKey: 'a', iHaveResponse: true }, { res: true, rsp: false }), true)
})

test('res does not act on opponents’ turns (op handles those)', () => {
  assert.equal(decide({ step: 'precombat_main', currentStackKey: 'a', isActivePlayer: false }, { res: true, op: false }), false)
})

// ── blk: declare blockers, no block to make (both sides) ───────────────────────

test('blk on + defender with no block + no response → skip', () => {
  assert.equal(decide({ step: 'declare_blockers', isActivePlayer: false }), true)
})

test('blk on + attacker passive priority + no response → skip', () => {
  assert.equal(decide({ step: 'declare_blockers', isActivePlayer: true }), true)
})

test('blk on but you hold a response → hold declare_blockers', () => {
  assert.equal(decide({ step: 'declare_blockers', isActivePlayer: false, iHaveResponse: true }), false)
})

test('blk off → hold declare_blockers even with no block', () => {
  assert.equal(decide({ step: 'declare_blockers', isActivePlayer: false }, { blk: false }), false)
})

test('blk + stk: a new (unacked) stack object stops the blockers skip', () => {
  assert.equal(decide({ step: 'declare_blockers', isActivePlayer: false, currentStackKey: 'x', ackStackKey: '' }), false)
})

test('blk + stk: an already-acknowledged stack does not stop it', () => {
  assert.equal(decide({ step: 'declare_blockers', isActivePlayer: false, currentStackKey: 'x', ackStackKey: 'x' }), true)
})

test('blk with stk off: a stack object does not stop the skip', () => {
  assert.equal(
    decide({ step: 'declare_blockers', isActivePlayer: false, currentStackKey: 'x', ackStackKey: '' }, { stk: false }),
    true,
  )
})

test('declare_blockers branch wins over the own-turn branch', () => {
  // Active player, own on, but blk off → the dedicated blockers branch holds.
  assert.equal(decide({ step: 'declare_blockers', isActivePlayer: true }, { blk: false, own: true }), false)
})

// ── Opponents' turns: op / stk / rsp ───────────────────────────────────────────

test('op on → pass an opponent\'s step with an empty stack', () => {
  assert.equal(decide({ step: 'upkeep', isActivePlayer: false }), true)
})

test('op off → hold on opponents\' turns', () => {
  assert.equal(decide({ step: 'upkeep', isActivePlayer: false }, { op: false }), false)
})

test('op + stk: a new object on the opponent\'s stack stops the pass', () => {
  assert.equal(decide({ step: 'upkeep', isActivePlayer: false, currentStackKey: 's', ackStackKey: '' }), false)
})

test('op + stk: an acknowledged stack does not stop the pass', () => {
  assert.equal(decide({ step: 'upkeep', isActivePlayer: false, currentStackKey: 's', ackStackKey: 's' }), true)
})

test('op + stk with no stack at all → pass (nothing to stop on)', () => {
  assert.equal(decide({ step: 'upkeep', isActivePlayer: false, currentStackKey: '' }), true)
})

test('op + rsp: holding a castable response stops the pass', () => {
  assert.equal(decide({ step: 'upkeep', isActivePlayer: false, iHaveResponse: true }, { rsp: true }), false)
})

test('op + rsp off: a held response does not stop the pass', () => {
  assert.equal(decide({ step: 'upkeep', isActivePlayer: false, iHaveResponse: true }, { rsp: false }), true)
})
