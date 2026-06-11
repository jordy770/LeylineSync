// Drift guard for the card-behavior authoring stack's two type vocabularies:
//
//   lib/game/card-behavior-schema.ts  KNOWN_V2_ACTION_TYPES — what the Zod
//     validator recognises (JSON / AI authoring).
//   lib/game/card-behavior-registry.ts EFFECT_REGISTRY — what the guided form
//     can author.
//
// The cerebrum's most-repeated mistake is wiring an effect into the engine +
// schema but forgetting the registry (the card then only authors via JSON, and
// nobody notices). This test makes that divergence explicit: every schema type
// must either have a registry entry or appear in JSON_ONLY with a stated
// reason. Adding an effect type now fails CI until you make that choice
// deliberately — and a JSON_ONLY entry that later GAINS a registry def must be
// removed from the allowlist (also enforced).
//
// No DB — pure vocabulary comparison. Run via the standard test runner.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EFFECT_REGISTRY } from '../../lib/game/card-behavior-registry'
import { KNOWN_V2_ACTION_TYPES } from '../../lib/game/card-behavior-schema'

// Schema types that intentionally have NO guided-form registry entry. Each
// needs a reason; "haven't gotten to it" is a valid reason as long as it is
// written down here on purpose.
const JSON_ONLY: Record<string, string> = {
  add_mana: 'mana abilities are authored via the dedicated mana-variant form path, not the effect registry',
  counter: 'counterspells are JSON/AI-authored; the cast path (counter_spell stack action) has no form surface (mig 190)',
  set_pt: '"becomes X/Y" is engine-complete (migs 128-130) but was never given a registry entry — JSON-only by precedent',
  sacrifice: 'edict decisions (who/count/filter) predate the registry; form support is an open follow-up (mig 108/110)',
  return_from_graveyard: 'pick-from-graveyard decision effect; form support is an open follow-up (mig 108)',
  prevent_damage: 'Fog-style shields (mig 126) are JSON-only; no form demand yet',
  grant_cast_from_graveyard: 'permission grant (Liliana -3 / Havengul Lich); loyalty + targeted-activated surfaces are not form-modelled',
  curse_attack_zombie: 'bespoke Curse of Disturbance composition (mig 199); intentionally not a general-purpose form effect',
  look_top: 'impulse-dig + put-onto-battlefield (Ureni, mig 223); JSON/AI-authored, no guided-form widget yet',
  deal_damage_all: 'mass damage with keyword filters (Blasphemous Act / Storm Wrath / Harbinger, mig 224); JSON/AI-authored',
  impulse: 'exile-top-N + play-until-end-of-next-turn (Atsushi, mig 230); JSON/AI-authored, no guided-form widget yet',
  choose_one: 'modal trigger ("choose one —", Atsushi, mig 230); JSON/AI-authored, no guided-form widget yet',
  monstrosity: 'become-monstrous once + on_monstrous rider (Stormbreath, mig 232); JSON/AI-authored',
  damage_each_opponent_by_hand: 'per-opponent hand-size damage (Stormbreath monstrosity rider, mig 232); JSON/AI-authored',
  divide_damage: 'divided damage among targets via a parked decision (Dragonlord Atarka / Skarrgan, mig 233); JSON/AI-authored',
  return_self_to_hand: 'return this permanent to its owner\'s hand (Encroaching Dragonstorm, mig 234); JSON/AI-authored',
}

const registryTypes = new Set(EFFECT_REGISTRY.map((def) => def.type))
const schemaTypes = new Set<string>(KNOWN_V2_ACTION_TYPES)

// 1 — every schema action type is form-authorable OR deliberately JSON-only.
test('every KNOWN_V2 action type has a registry entry or a JSON_ONLY reason', () => {
  const unaccounted = [...schemaTypes].filter(
    (t) => !registryTypes.has(t) && !(t in JSON_ONLY),
  )
  assert.deepEqual(
    unaccounted,
    [],
    `These schema action types have no registry entry and no JSON_ONLY reason — ` +
      `either add a registry entry (guided-form support) or add them to JSON_ONLY ` +
      `in this test with a reason: ${unaccounted.join(', ')}`,
  )
})

// 2 — the allowlist stays honest: an entry that gained a registry def must go.
test('JSON_ONLY entries do not shadow real registry entries', () => {
  const shadowed = Object.keys(JSON_ONLY).filter((t) => registryTypes.has(t))
  assert.deepEqual(
    shadowed,
    [],
    `These types are in JSON_ONLY but now HAVE registry entries — remove them ` +
      `from the allowlist: ${shadowed.join(', ')}`,
  )
})

// 3 — the registry never invents a type the validator would reject: a form-built
// script must always pass validateCardScript.
test('every registry effect type is schema-known', () => {
  const unknown = [...registryTypes].filter((t) => !schemaTypes.has(t))
  assert.deepEqual(
    unknown,
    [],
    `These registry effect types are missing from KNOWN_V2_ACTION_TYPES (the ` +
      `form can author scripts the validator rejects): ${unknown.join(', ')}`,
  )
})

// 4 — stale-allowlist sweep: a JSON_ONLY key that is no longer even a schema
// type means the effect was removed/renamed; clean it up.
test('JSON_ONLY entries are all real schema types', () => {
  const stale = Object.keys(JSON_ONLY).filter((t) => !schemaTypes.has(t))
  assert.deepEqual(stale, [], `Stale JSON_ONLY entries: ${stale.join(', ')}`)
})
