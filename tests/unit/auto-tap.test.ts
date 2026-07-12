// planAutoTap — the controller's safe-greedy auto-pay planner. Picks which
// untapped single-colour, cost-free sources to tap so floating pool + taps
// covers a spell's cost; returns null when it can't be met unambiguously.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planAutoTap, planAutoTapFlex, type ManaSource } from '../../lib/game/auto-tap'
import { parseManaCost } from '../../lib/game/mana'

const EMPTY = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }
const land = (id: string, color: ManaSource['color'], amount = 1): ManaSource => ({ id, color, amount })

test('already affordable from pool — taps nothing', () => {
  const plan = planAutoTap(parseManaCost('{1}{R}'), { ...EMPTY, R: 1, G: 1 }, [land('m', 'R')])
  assert.deepEqual(plan, [])
})

test('taps a matching-colour source for a coloured pip', () => {
  const plan = planAutoTap(parseManaCost('{R}'), { ...EMPTY }, [land('mountain', 'R')])
  assert.deepEqual(plan, [land('mountain', 'R')])
})

test('coloured pips reserve their colour before generic is filled', () => {
  // {1}{R}: one Mountain must pay the {R}; a Forest covers the generic.
  const plan = planAutoTap(parseManaCost('{1}{R}'), { ...EMPTY }, [land('forest', 'G'), land('mountain', 'R')])
  assert.ok(plan)
  assert.equal(plan!.length, 2)
  assert.ok(plan!.some((s) => s.id === 'mountain'))
  assert.ok(plan!.some((s) => s.id === 'forest'))
})

test('does not strand a colour: one red source spent on the pip, not generic', () => {
  // {2}{R} with one Mountain + two Forests — must keep the Mountain for {R}.
  const plan = planAutoTap(
    parseManaCost('{2}{R}'),
    { ...EMPTY },
    [land('mountain', 'R'), land('f1', 'G'), land('f2', 'G')],
  )
  assert.ok(plan)
  assert.equal(plan!.length, 3)
  assert.ok(plan!.some((s) => s.id === 'mountain'))
})

test('returns null when a coloured pip cannot be met', () => {
  // Needs {R} but only green sources are available.
  const plan = planAutoTap(parseManaCost('{R}'), { ...EMPTY }, [land('forest', 'G'), land('f2', 'G')])
  assert.equal(plan, null)
})

test('returns null when not enough sources for generic', () => {
  const plan = planAutoTap(parseManaCost('{3}'), { ...EMPTY }, [land('a', 'C'), land('b', 'C')])
  assert.equal(plan, null)
})

test('multi-mana source counts its full amount', () => {
  // Sol Ring makes {C}{C}; covers a {2} cost in a single tap.
  const plan = planAutoTap(parseManaCost('{2}'), { ...EMPTY }, [land('solring', 'C', 2)])
  assert.deepEqual(plan, [land('solring', 'C', 2)])
})

test('pool partially covers, taps only the remainder', () => {
  // {2}{R}: pool has R + one generic; one more land covers the last generic.
  const plan = planAutoTap(parseManaCost('{2}{R}'), { ...EMPTY, R: 1, G: 1 }, [land('a', 'C'), land('b', 'C')])
  assert.ok(plan)
  assert.equal(plan!.length, 1)
})

// ── planAutoTapFlex (bug-1509) ────────────────────────────────────────────────
// Colour-choice sources: duals get a colour assigned, 'any'/'commander' sources
// cover coloured pips only (never the generic remainder — identity unknown).

test('flex: second B pip comes from a dual, most-constrained first', () => {
  // Swift End {1}{B}{B} with the exact board that surfaced the bug: one Swamp,
  // a dual Chapel, Command Tower, and fixed off-colour sources for generic.
  const plan = planAutoTapFlex(parseManaCost('{1}{B}{B}'), { ...EMPTY }, [
    { id: 'swamp', colors: ['B'], amount: 1 },
    { id: 'island', colors: ['U'], amount: 1 },
    { id: 'chapel', colors: ['W', 'B'], amount: 1 },
    { id: 'tower', colors: 'any', amount: 1, commander: true },
    { id: 'grounds', colors: ['C'], amount: 1 },
  ])
  assert.ok(plan, 'plan found')
  const black = plan!.filter((t) => t.color === 'B')
  assert.equal(black.length, 2, 'both B pips covered')
  assert.ok(black.some((t) => t.id === 'swamp'), 'fixed source used first')
  assert.ok(black.some((t) => t.id === 'chapel'), 'dual covers the second pip (not the any-source)')
  assert.ok(!plan!.some((t) => t.id === 'tower'), 'Command Tower saved when a dual suffices')
})

test('flex: commander source covers a pip and carries the flag', () => {
  const plan = planAutoTapFlex(parseManaCost('{1}{B}{B}'), { ...EMPTY }, [
    { id: 'swamp', colors: ['B'], amount: 1 },
    { id: 'tower', colors: 'any', amount: 1, commander: true },
    { id: 'island', colors: ['U'], amount: 1 },
  ])
  assert.ok(plan, 'plan found')
  const tower = plan!.find((t) => t.id === 'tower')
  assert.ok(tower, 'tower tapped for the second pip')
  assert.equal(tower!.color, 'B')
  assert.equal(tower!.commander, true)
})

test('flex: generic remainder never burns an any/commander source', () => {
  const plan = planAutoTapFlex(parseManaCost('{2}'), { ...EMPTY }, [
    { id: 'tower', colors: 'any', amount: 1, commander: true },
    { id: 'tower2', colors: 'any', amount: 1, commander: true },
  ])
  assert.equal(plan, null)
})

test('flex: unmeetable pip still fails cleanly', () => {
  const plan = planAutoTapFlex(parseManaCost('{G}{G}'), { ...EMPTY }, [
    { id: 'swamp', colors: ['B'], amount: 1 },
  ])
  assert.equal(plan, null)
})
