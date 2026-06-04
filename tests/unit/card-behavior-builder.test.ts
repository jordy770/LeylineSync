// Characterization tests for the guided-form ↔ script-JSON conversion in
// card-behavior-builder.ts. These pin the CURRENT behavior before the
// registry refactor (step 1): which scripts open in Form mode vs JSON mode,
// that a form round-trips stably, and the exact JSON a few forms emit.
//
// No DB — pure functions. Run via `node --import tsx --test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildScriptFromForm,
  parseScriptToForm,
  defaultEffect,
  defaultSpellEffect,
  defaultActivatedAbility,
  defaultTrigger,
  EMPTY_BUILDER_FORM,
} from '../../lib/game/card-behavior-builder'

// ─── Corpus ───────────────────────────────────────────────────────────────────
// `form: true`  → parseScriptToForm returns a BuilderForm (editor opens in Form mode)
// `form: false` → parseScriptToForm returns null  (editor stays in JSON mode)
//
// Classifications reflect what the code does TODAY (the refactor must preserve
// them). Notable JSON-mode cases are commented with WHY they bail.

type Case = { name: string; script: unknown; form: boolean }

const CASES: Case[] = [
  // Keywords (continuous_effects)
  { name: 'flying', script: { continuous_effects: [{ type: 'flying', affected: 'source', source_zone_required: 'battlefield' }] }, form: true },
  { name: 'deathtouch+trample', script: { continuous_effects: [{ type: 'deathtouch', affected: 'source', source_zone_required: 'battlefield' }, { type: 'trample', affected: 'source', source_zone_required: 'battlefield' }] }, form: true },
  { name: 'reach', script: { continuous_effects: [{ type: 'reach', affected: 'source', source_zone_required: 'battlefield' }] }, form: true },
  // unknown keyword → JSON
  { name: 'additional_land_plays', script: { continuous_effects: [{ type: 'additional_land_plays', amount: 1, affected: 'controller', source_zone_required: 'battlefield' }] }, form: false },
  { name: 'mana_does_not_empty', script: { continuous_effects: [{ type: 'mana_does_not_empty', colors: ['G'], affected: 'controller', source_zone_required: 'battlefield' }] }, form: false },

  // Triggered abilities — form-representable effects
  { name: 'etb gain_life', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'gain_life', amount: 1 }] }] }, form: true },
  { name: 'etb scry', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'scry', amount: 2 }] }] }, form: true },
  { name: 'etb surveil', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'surveil', amount: 2 }] }] }, form: true },
  { name: 'etb scry+gain', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'scry', amount: 1 }, { type: 'gain_life', amount: 2 }] }] }, form: true },
  { name: 'attack deal_damage each_opponent', script: { schema_version: 2, triggered_abilities: [{ event: 'attacks', effects: [{ type: 'deal_damage', amount: 1, recipient: 'each_opponent' }] }] }, form: true },
  { name: 'attack add_counters self', script: { schema_version: 2, triggered_abilities: [{ event: 'attacks', effects: [{ type: 'add_counters', amount: 1 }] }] }, form: true },
  { name: 'upkeep create_token', script: { schema_version: 2, triggered_abilities: [{ event: 'beginning_of_upkeep', effects: [{ type: 'create_token', count: 1, token: 'Saproling Token' }] }] }, form: true },
  { name: 'end_step gain_life', script: { schema_version: 2, triggered_abilities: [{ event: 'beginning_of_end_step', effects: [{ type: 'gain_life', amount: 1 }] }] }, form: true },
  { name: 'draw_step draw', script: { schema_version: 2, triggered_abilities: [{ event: 'beginning_of_draw_step', effects: [{ type: 'draw', amount: 1 }] }] }, form: true },
  { name: 'dies gain_life', script: { schema_version: 2, triggered_abilities: [{ event: 'dies', effects: [{ type: 'gain_life', amount: 2 }] }] }, form: true },
  { name: 'leaves gain_life', script: { schema_version: 2, triggered_abilities: [{ event: 'leaves_the_battlefield', effects: [{ type: 'gain_life', amount: 3 }] }] }, form: true },
  { name: 'blocks deal_damage', script: { schema_version: 2, triggered_abilities: [{ event: 'blocks', effects: [{ type: 'deal_damage', amount: 1, recipient: 'each_opponent' }] }] }, form: true },
  { name: 'becomes_targeted draw', script: { schema_version: 2, triggered_abilities: [{ event: 'becomes_targeted', effects: [{ type: 'draw', amount: 1 }] }] }, form: true },
  { name: 'lose_life + gain_life', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'lose_life', amount: 2, recipient: 'each_opponent' }, { type: 'gain_life', amount: 2 }] }] }, form: true },
  { name: 'trigger gain_life each_player', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'gain_life', amount: 2, recipient: 'each_player' }] }] }, form: true },
  { name: 'trigger lose_life all_players', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'lose_life', amount: 2, recipient: 'all_players' }] }] }, form: true },

  // Triggered abilities — step-2 effects now form-representable (registry entries
  // with nested `filter` object and recursive `effects` lists).
  { name: 'trigger search_library', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'search_library', count: 1, to: 'hand', filter: { type_line: 'creature' } }] }] }, form: true },
  { name: 'trigger discard', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'discard', count: 1 }] }] }, form: true },
  { name: 'trigger may', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'may', prompt: 'Gain 3 life?', effects: [{ type: 'gain_life', amount: 3 }] }] }] }, form: true },
  { name: 'trigger choose_player', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'choose_player', filter: 'opponent', effects: [{ type: 'lose_life', amount: 3 }] }] }] }, form: true },
  // search_library with no filter / no destination → optional defaults materialize, still Form.
  { name: 'trigger search_library minimal', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'search_library' }] }] }, form: true },
  // may whose inner effect is itself non-representable → whole thing bails to JSON.
  { name: 'trigger may with targeted-add_counters inner → json', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'may', effects: [{ type: 'add_counters', amount: 1, target_type: 'creature' }] }] }] }, form: false },
  // may with a representable targeted inner (destroy) → Form (recursion works).
  { name: 'trigger may with destroy inner → form', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'may', prompt: 'Destroy it?', effects: [{ type: 'destroy', target_type: 'creature' }] }] }] }, form: true },
  // may with an unknown sub-key in filter → json (strict nested keys).
  { name: 'trigger search_library bad filter key → json', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'search_library', filter: { color: 'R' } }] }] }, form: false },

  // mill is auto-resolve (recipient-based) — now a registry entry, so form-representable.
  { name: 'trigger mill', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'mill', amount: 3, recipient: 'each_opponent' }] }] }, form: true },
  { name: 'trigger add_counters_all', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'add_counters_all', amount: 1, target_controller: 'you' }] }] }, form: true },
  { name: 'trigger tap_all', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'tap_all', target_controller: 'you' }] }] }, form: true },
  { name: 'trigger untap_all', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'untap_all', target_controller: 'you' }] }] }, form: true },

  // Single-target creature effects — now form-representable (combined target).
  { name: 'trigger destroy target', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'destroy', target_type: 'creature', target_controller: 'opponent' }] }] }, form: true },
  { name: 'trigger exile target', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'exile', target_type: 'creature', target_controller: 'opponent' }] }] }, form: true },
  { name: 'trigger grant_keyword', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'grant_keyword', keyword: 'flying', target_type: 'creature', target_controller: 'you' }] }] }, form: true },
  { name: 'trigger grant_keyword no controller', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'grant_keyword', keyword: 'trample', target_type: 'creature' }] }] }, form: true },
  { name: 'trigger fight (Pit Brawler)', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'fight', target_type: 'creature', target_controller: 'opponent' }] }] }, form: true },

  // Triggered abilities — NOT form-representable → JSON
  // add_counters has no targeted registry variant (only on-self), so a targeted one bails.
  { name: 'trigger add_counters target', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'add_counters', amount: 1, target_type: 'creature' }] }] }, form: false },

  // Spell effects — form-representable (scry/surveil/draw/search_library)
  { name: 'spell draw 2', script: { schema_version: 2, spell_effect: { actions: [{ type: 'draw', amount: 2 }] } }, form: true },
  { name: 'spell scry+draw (Opt)', script: { schema_version: 2, spell_effect: { actions: [{ type: 'scry', amount: 1 }, { type: 'draw', amount: 1 }] } }, form: true },
  // Demonic Tutor — search_library as a sorcery (no filter = any card).
  { name: 'spell search_library no filter (Demonic Tutor)', script: { schema_version: 2, spell_effect: { actions: [{ type: 'search_library', count: 1, to: 'hand' }] } }, form: true },
  { name: 'spell search_library with filter', script: { schema_version: 2, spell_effect: { actions: [{ type: 'search_library', count: 1, to: 'battlefield', filter: { type_line: 'creature' } }] } }, form: true },
  // Other decision/auto-resolve effects now allowed as spell actions too.
  { name: 'spell mill', script: { schema_version: 2, spell_effect: { actions: [{ type: 'mill', amount: 3, recipient: 'each_opponent' }] } }, form: true },
  { name: 'spell discard', script: { schema_version: 2, spell_effect: { actions: [{ type: 'discard', count: 2 }] } }, form: true },
  { name: 'spell may (you may draw)', script: { schema_version: 2, spell_effect: { actions: [{ type: 'may', prompt: 'Draw a card?', effects: [{ type: 'draw', amount: 1 }] }] } }, form: true },
  { name: 'spell choose_player loses life', script: { schema_version: 2, spell_effect: { actions: [{ type: 'choose_player', filter: 'opponent', effects: [{ type: 'lose_life', amount: 3 }] }] } }, form: true },
  { name: 'spell gain_life all_players', script: { schema_version: 2, spell_effect: { actions: [{ type: 'gain_life', amount: 2, recipient: 'all_players' }] } }, form: true },
  { name: 'spell add_counters_all', script: { schema_version: 2, spell_effect: { actions: [{ type: 'add_counters_all', amount: 1, target_controller: 'you' }] } }, form: true },
  { name: 'spell tap_all', script: { schema_version: 2, spell_effect: { actions: [{ type: 'tap_all', target_controller: 'you' }] } }, form: true },
  { name: 'spell untap_all', script: { schema_version: 2, spell_effect: { actions: [{ type: 'untap_all', target_controller: 'you' }] } }, form: true },

  // Single-target creature spells — now form-representable.
  { name: 'spell destroy (Doom Blade)', script: { schema_version: 2, spell_effect: { actions: [{ type: 'destroy', target_type: 'creature' }] } }, form: true },
  { name: 'spell exile (Banishing Bolt)', script: { schema_version: 2, spell_effect: { actions: [{ type: 'exile', target_type: 'creature' }] } }, form: true },
  { name: 'spell bounce', script: { schema_version: 2, spell_effect: { actions: [{ type: 'bounce', target_type: 'creature' }] } }, form: true },
  { name: 'spell tap', script: { schema_version: 2, spell_effect: { actions: [{ type: 'tap', target_type: 'creature' }] } }, form: true },
  { name: 'spell untap', script: { schema_version: 2, spell_effect: { actions: [{ type: 'untap', target_type: 'creature' }] } }, form: true },
  { name: 'spell pump (Giant Growth)', script: { schema_version: 2, spell_effect: { actions: [{ type: 'pump', power: 3, toughness: 3, target_type: 'creature' }] } }, form: true },
  { name: 'spell grant_keyword (combat trick)', script: { schema_version: 2, spell_effect: { actions: [{ type: 'grant_keyword', keyword: 'flying', target_type: 'creature', target_controller: 'you' }] } }, form: true },
  { name: 'spell fight (Prey Upon)', script: { schema_version: 2, spell_effect: { actions: [{ type: 'fight', target_type: 'creature', target_controller: 'opponent' }] } }, form: true },
  { name: 'spell fight no controller (Pit Fight)', script: { schema_version: 2, spell_effect: { actions: [{ type: 'fight', target_type: 'creature' }] } }, form: true },

  // Spell effects — NOT form-representable → JSON
  { name: 'spell add_counters target', script: { schema_version: 2, spell_effect: { actions: [{ type: 'add_counters', amount: 1, target_type: 'creature' }] } }, form: false },
  // target_ref (explicit targets[] wiring) isn't modeled → JSON.
  { name: 'spell destroy via target_ref', script: { schema_version: 2, spell_effect: { targets: [{ id: 't', type: 'creature' }], actions: [{ type: 'destroy', target_ref: 't' }] } }, form: false },
  // scry action with an extra field → JSON
  { name: 'spell scry +extra field', script: { schema_version: 2, spell_effect: { actions: [{ type: 'scry', amount: 1, foo: 1 }] } }, form: false },

  // Activated abilities — the form models bare tap/mana effects, but extra keys bail
  { name: 'activated deal_damage +timing', script: { schema_version: 2, activated_abilities: [{ costs: [{ type: 'tap_self' }], label: 'x', timing: 'instant', effects: [{ type: 'deal_damage', amount: 1, target_type: ['creature', 'player'] }], is_mana_ability: false }] }, form: false },
  { name: 'activated deal_damage bare', script: { schema_version: 2, activated_abilities: [{ costs: [{ type: 'tap_self' }], effects: [{ type: 'deal_damage', amount: 1, target_type: ['creature', 'player'] }] }] }, form: true },
  { name: 'activated mana', script: { schema_version: 2, activated_abilities: [{ is_mana_ability: true, costs: [{ type: 'tap_self' }], effects: [{ type: 'add_mana', color: 'G', amount: 1 }] }] }, form: true },

  // V1 / top-level `actions` key → JSON (not in known top-level keys)
  { name: 'v1 actions pump', script: { actions: [{ type: 'pump', power: 3, toughness: 3, target_type: 'creature' }] }, form: false },
  { name: 'v1 actions deal_damage', script: { actions: [{ type: 'deal_damage', amount: 3, target_type: ['creature', 'player'] }] }, form: false },

  // Strict-parser contract (unified strict rule). These pin the post-refactor
  // behavior: the old lenient trigger parser would have opened the first three in
  // Form mode (silently dropping data); strict parsing sends them to JSON.
  { name: 'trigger gain_life + unknown key → json', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'gain_life', amount: 1, foo: true }] }] }, form: false },
  { name: 'trigger gain_life missing amount → json', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'gain_life' }] }] }, form: false },
  { name: 'trigger lose_life invalid recipient → json', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'lose_life', amount: 2, recipient: 'nobody' }] }] }, form: false },
  // Optional fields keep defaults → still Form.
  { name: 'trigger lose_life no recipient → form', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'lose_life', amount: 2 }] }] }, form: true },
  { name: 'trigger create_token no count → form', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'create_token', token: 'Goblin Token' }] }] }, form: true },

  // Edge cases
  { name: 'empty object', script: {}, form: true },
  { name: 'null script', script: null, form: true },
  { name: 'unknown top-level key', script: { schema_version: 2, foo: 1 }, form: false },
]

for (const c of CASES) {
  test(`classify: ${c.name} → ${c.form ? 'form' : 'json'}`, () => {
    const parsed = parseScriptToForm(c.script)
    if (c.form) {
      assert.notEqual(parsed, null, 'expected a BuilderForm (Form mode)')
    } else {
      assert.equal(parsed, null, 'expected null (JSON mode)')
    }
  })
}

// Form-stability: for every form-representable script, re-parsing the rebuilt
// script yields an identical form. This is the invariant the editor relies on
// (form → text → form must be a fixed point).
for (const c of CASES.filter((x) => x.form)) {
  test(`round-trip stable: ${c.name}`, () => {
    const form = parseScriptToForm(c.script)
    assert.notEqual(form, null)
    const rebuilt = parseScriptToForm(buildScriptFromForm(form!))
    assert.deepEqual(rebuilt, form)
  })
}

// Exact-shape pins — lock the JSON a couple of representative forms emit.
test('exact build: Opt (scry+draw)', () => {
  const form = parseScriptToForm({ schema_version: 2, spell_effect: { actions: [{ type: 'scry', amount: 1 }, { type: 'draw', amount: 1 }] } })
  assert.deepEqual(buildScriptFromForm(form!), {
    schema_version: 2,
    spell_effect: { actions: [{ type: 'scry', amount: 1 }, { type: 'draw', amount: 1 }] },
  })
})

test('exact build: lose_life each_opponent + gain_life', () => {
  const form = parseScriptToForm({ schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'lose_life', amount: 2, recipient: 'each_opponent' }, { type: 'gain_life', amount: 2 }] }] })
  assert.deepEqual(buildScriptFromForm(form!), {
    schema_version: 2,
    triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'lose_life', amount: 2, recipient: 'each_opponent' }, { type: 'gain_life', amount: 2 }] }],
  })
})

test('exact build: gain_life each_player', () => {
  const form = parseScriptToForm({ schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'gain_life', amount: 2, recipient: 'each_player' }] }] })
  assert.deepEqual(buildScriptFromForm(form!), {
    schema_version: 2,
    triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'gain_life', amount: 2, recipient: 'each_player' }] }],
  })
})

// Demonic Tutor: a no-filter tutor sorcery. Pins that a blank `filter` is OMITTED
// from the saved JSON (so the in-game prompt is clean, not "search for a ").
test('exact build: Demonic Tutor (search_library spell, blank filter dropped)', () => {
  const form = parseScriptToForm({ schema_version: 2, spell_effect: { actions: [{ type: 'search_library', count: 1, to: 'hand' }] } })
  assert.deepEqual(buildScriptFromForm(form!), {
    schema_version: 2,
    spell_effect: { actions: [{ type: 'search_library', count: 1, to: 'hand' }] },
  })
})

test('exact build: search_library tutor (nested filter)', () => {
  const form = parseScriptToForm({ schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'search_library', count: 1, to: 'hand', filter: { type_line: 'creature' } }] }] })
  assert.deepEqual(buildScriptFromForm(form!), {
    schema_version: 2,
    triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'search_library', count: 1, to: 'hand', filter: { type_line: 'creature' } }] }],
  })
})

test('exact build: may (recursive inner effect)', () => {
  const form = parseScriptToForm({ schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'may', prompt: 'Gain 3 life?', effects: [{ type: 'gain_life', amount: 3 }] }] }] })
  assert.deepEqual(buildScriptFromForm(form!), {
    schema_version: 2,
    triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'may', prompt: 'Gain 3 life?', effects: [{ type: 'gain_life', amount: 3 }] }] }],
  })
})

test('exact build: destroy a creature an opponent controls', () => {
  const form = parseScriptToForm({ schema_version: 2, spell_effect: { actions: [{ type: 'destroy', target_type: 'creature', target_controller: 'opponent' }] } })
  assert.deepEqual(buildScriptFromForm(form!), {
    schema_version: 2,
    spell_effect: { actions: [{ type: 'destroy', target_type: 'creature', target_controller: 'opponent' }] },
  })
})

test('exact build: Doom Blade (plain target creature omits target_controller)', () => {
  const form = parseScriptToForm({ schema_version: 2, spell_effect: { actions: [{ type: 'destroy', target_type: 'creature' }] } })
  assert.deepEqual(buildScriptFromForm(form!), {
    schema_version: 2,
    spell_effect: { actions: [{ type: 'destroy', target_type: 'creature' }] },
  })
})

test('exact build: Giant Growth (pump +3/+3 on target creature)', () => {
  const form = parseScriptToForm({ schema_version: 2, spell_effect: { actions: [{ type: 'pump', power: 3, toughness: 3, target_type: 'creature' }] } })
  assert.deepEqual(buildScriptFromForm(form!), {
    schema_version: 2,
    spell_effect: { actions: [{ type: 'pump', power: 3, toughness: 3, target_type: 'creature' }] },
  })
})

test('exact build: flying keyword (adds schema_version)', () => {
  const form = parseScriptToForm({ continuous_effects: [{ type: 'flying', affected: 'source', source_zone_required: 'battlefield' }] })
  assert.deepEqual(buildScriptFromForm(form!), {
    schema_version: 2,
    continuous_effects: [{ type: 'flying', affected: 'source', source_zone_required: 'battlefield' }],
  })
})

test('empty form builds null', () => {
  assert.equal(buildScriptFromForm(EMPTY_BUILDER_FORM), null)
})

// Default factories — pin shapes so the registry refactor reproduces them.
test('defaultEffect shapes', () => {
  assert.deepEqual(defaultEffect('gain_life'), { type: 'gain_life', amount: 1 })
  assert.deepEqual(defaultEffect('lose_life'), { type: 'lose_life', amount: 1, recipient: 'each_opponent' })
  assert.deepEqual(defaultEffect('deal_damage'), { type: 'deal_damage', amount: 1, recipient: 'each_opponent' })
  assert.deepEqual(defaultEffect('draw'), { type: 'draw', amount: 1 })
  assert.deepEqual(defaultEffect('create_token'), { type: 'create_token', token: 'Soldier Token', count: 1 })
  assert.deepEqual(defaultEffect('add_counters'), { type: 'add_counters', amount: 1 })
  assert.deepEqual(defaultEffect('add_counters_all'), { type: 'add_counters_all', amount: 1, target_controller: 'you' })
  assert.deepEqual(defaultEffect('tap_all'), { type: 'tap_all', target_controller: 'you' })
  assert.deepEqual(defaultEffect('untap_all'), { type: 'untap_all', target_controller: 'you' })
  assert.deepEqual(defaultEffect('scry'), { type: 'scry', amount: 1 })
  assert.deepEqual(defaultEffect('surveil'), { type: 'surveil', amount: 1 })
  assert.deepEqual(defaultEffect('mill'), { type: 'mill', amount: 1, recipient: 'each_opponent' })
  assert.deepEqual(defaultEffect('search_library'), { type: 'search_library', count: 1, to: 'hand', filter: { type_line: '' } })
  assert.deepEqual(defaultEffect('discard'), { type: 'discard', count: 1 })
  assert.deepEqual(defaultEffect('may'), { type: 'may', prompt: '', effects: [] })
  assert.deepEqual(defaultEffect('choose_player'), { type: 'choose_player', filter: 'opponent', effects: [] })
  assert.deepEqual(defaultEffect('destroy'), { type: 'destroy', target: 'creature_any' })
  assert.deepEqual(defaultEffect('exile'), { type: 'exile', target: 'creature_any' })
  assert.deepEqual(defaultEffect('pump'), { type: 'pump', power: 1, toughness: 1, target: 'creature_any' })
  assert.deepEqual(defaultEffect('grant_keyword'), { type: 'grant_keyword', keyword: 'flying', target: 'creature_any' })
  assert.deepEqual(defaultEffect('fight'), { type: 'fight', target: 'creature_any' })
})

test('exact build: grant_keyword (Windcaller — flying to a creature you control)', () => {
  const form = parseScriptToForm({ schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'grant_keyword', keyword: 'flying', target_type: 'creature', target_controller: 'you' }] }] })
  assert.deepEqual(buildScriptFromForm(form!), {
    schema_version: 2,
    triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'grant_keyword', keyword: 'flying', target_type: 'creature', target_controller: 'you' }] }],
  })
})

test('defaultSpellEffect shapes', () => {
  assert.deepEqual(defaultSpellEffect('scry'), { type: 'scry', amount: 1 })
  assert.deepEqual(defaultSpellEffect('surveil'), { type: 'surveil', amount: 1 })
  assert.deepEqual(defaultSpellEffect('draw'), { type: 'draw', amount: 1 })
  assert.deepEqual(defaultSpellEffect('add_counters_all'), { type: 'add_counters_all', amount: 1, target_controller: 'you' })
  assert.deepEqual(defaultSpellEffect('tap_all'), { type: 'tap_all', target_controller: 'you' })
  assert.deepEqual(defaultSpellEffect('untap_all'), { type: 'untap_all', target_controller: 'you' })
  assert.deepEqual(defaultSpellEffect('fight'), { type: 'fight', target: 'creature_any' })
})

test('defaultActivatedAbility shapes', () => {
  assert.deepEqual(defaultActivatedAbility('mana'), { kind: 'mana', tapSelf: true, color: 'C', amount: 1 })
  assert.deepEqual(defaultActivatedAbility('damage'), { kind: 'damage', tapSelf: true, mana: '', amount: 1, target: 'any' })
})

test('defaultTrigger shape', () => {
  assert.deepEqual(defaultTrigger(), { event: 'enters_the_battlefield', effects: [{ type: 'gain_life', amount: 1 }] })
})
