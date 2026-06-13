// getCardConfigStatus — the deck editor's "scripted / vanilla / needs behaviour"
// badge. Regression for the bug where scripts consisting ONLY of top-level
// engine props (loyalty_abilities, enters_with_counters, undying, …) classified
// as 'needs' (Liliana, Untouched by Death & Unbreathing Horde, 2026-06-10).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getCardConfigStatus, normalizeCardBehaviorToV2 } from '../../lib/game/card-behavior'

test('loyalty-only script (Liliana) classifies as scripted', () => {
  const card = {
    oracle_text: '+1: Mill three cards.',
    type_line: 'Legendary Planeswalker — Liliana',
    script: {
      schema_version: 2,
      loyalty: 4,
      loyalty_abilities: [{ cost: 1, effects: [{ type: 'mill', amount: 3, recipient: 'controller' }] }],
    },
  }
  assert.equal(getCardConfigStatus(card as never), 'scripted')
})

test('top-level-flags-only script (Unbreathing Horde) classifies as scripted', () => {
  const card = {
    oracle_text: 'This creature enters with a +1/+1 counter on it for each other Zombie you control.',
    type_line: 'Creature — Zombie',
    script: {
      schema_version: 2,
      enters_with_counters: { amount: [{ count: 'creatures_you_control', type_line: 'Zombie' }] },
      damage_removes_counters: true,
    },
  }
  assert.equal(getCardConfigStatus(card as never), 'scripted')
})

test('every behavior-bearing top-level prop counts as scripted', () => {
  const shapes: Record<string, unknown>[] = [
    { undying: true },
    { kicker: '{5}{B}' },
    { graveyard_cast_cost: { mana: '{B}{B}', sacrifice_creatures: 2 } },
    { enters_tapped: true },
    { enters_tapped: { unless: { count: 'basic_lands_you_control', at_least: 2 } } },
    { flashback: '{1}{U}' },
    { cant_be_countered: true },
    { doubles_counters: true },
    { cda: { power: { count: 'creatures_you_control' } } },
  ]
  for (const extra of shapes) {
    const card = { oracle_text: 'Some rules text.', type_line: 'Creature', script: { schema_version: 2, ...extra } }
    assert.equal(getCardConfigStatus(card as never), 'scripted', JSON.stringify(extra))
  }
})

test('rules text with no script still classifies as needs', () => {
  const card = { oracle_text: 'When this creature enters, draw a card.', type_line: 'Creature', script: { schema_version: 2 } }
  assert.equal(getCardConfigStatus(card as never), 'needs')
})

test('normalize round-trip preserves the top-level props', () => {
  const script = {
    schema_version: 2 as const,
    undying: true,
    kicker: '{5}{B}',
    enters_with_counters: { amount: 2 },
    damage_removes_counters: true,
    enters_tapped: true as const,
    cant_be_countered: true,
    doubles_counters: true,
    graveyard_cast_cost: { mana: '{B}{B}' },
    cda: { power: { count: 'creatures_you_control' } },
  }
  const normalized = normalizeCardBehaviorToV2(script)
  for (const key of Object.keys(script)) {
    assert.deepEqual(
      (normalized as Record<string, unknown>)[key],
      (script as Record<string, unknown>)[key],
      `normalize dropped ${key}`,
    )
  }
})
