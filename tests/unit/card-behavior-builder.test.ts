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
  { name: 'trigger may with targeted-add_counters inner → form', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'may', effects: [{ type: 'add_counters', amount: 1, target_type: 'creature' }] }] }] }, form: true },
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
  { name: 'trigger gain_control (until EOT)', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'gain_control', duration: 'end_of_turn', target_type: 'creature', target_controller: 'opponent' }] }] }, form: true },

  // Triggered abilities — NOT form-representable → JSON
  // add_counters now has a targeted variant (mig: dual-shape), so a targeted one is Form.
  { name: 'trigger add_counters target', script: { schema_version: 2, triggered_abilities: [{ event: 'enters_the_battlefield', effects: [{ type: 'add_counters', amount: 1, target_type: 'creature' }] }] }, form: true },

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
  { name: 'spell gain_control (Mind Control)', script: { schema_version: 2, spell_effect: { actions: [{ type: 'gain_control', duration: 'permanent', target_type: 'creature', target_controller: 'opponent' }] } }, form: true },
  { name: 'spell fight no controller (Pit Fight)', script: { schema_version: 2, spell_effect: { actions: [{ type: 'fight', target_type: 'creature' }] } }, form: true },

  // Removal targeting non-creature / nonland permanents (mig 113/150) — now form.
  { name: 'spell destroy artifact (Disenchant)', script: { schema_version: 2, spell_effect: { actions: [{ type: 'destroy', target_type: 'artifact' }] } }, form: true },
  { name: 'spell exile nonland permanent', script: { schema_version: 2, spell_effect: { actions: [{ type: 'exile', target_type: 'nonland_permanent' }] } }, form: true },
  // Anguished Unmaking — exile target nonland permanent, then you lose 3 life.
  { name: 'spell exile nonland + lose-3 rider (Anguished Unmaking)', script: { schema_version: 2, spell_effect: { actions: [{ type: 'exile', target_type: 'nonland_permanent', then: [{ type: 'lose_life', amount: 3 }] }] } }, form: true },
  { name: 'spell destroy creature + draw rider', script: { schema_version: 2, spell_effect: { actions: [{ type: 'destroy', target_type: 'creature', then: [{ type: 'draw', amount: 1 }] }] } }, form: true },
  // Assassin's Trophy — destroy opponent permanent + its controller searches a basic land.
  { name: 'spell Assassin\'s Trophy', script: { schema_version: 2, spell_effect: { actions: [{ type: 'destroy', target_type: 'permanent', target_controller: 'opponent', controller_searches_basic_land: true }] } }, form: true },

  // Spell effects — NOT form-representable → JSON
  { name: 'spell add_counters target (dual-shape)', script: { schema_version: 2, spell_effect: { actions: [{ type: 'add_counters', amount: 1, target_type: 'creature' }] } }, form: true },
  { name: 'spell deal_damage target (Lightning Bolt)', script: { schema_version: 2, spell_effect: { actions: [{ type: 'deal_damage', amount: 3, target_type: ['creature', 'player'] }] } }, form: true },
  { name: 'spell deal_damage target creature only', script: { schema_version: 2, spell_effect: { actions: [{ type: 'deal_damage', amount: 2, target_type: 'creature' }] } }, form: true },
  { name: 'spell deal_damage each_opponent stays recipient form', script: { schema_version: 2, spell_effect: { actions: [{ type: 'deal_damage', amount: 1, recipient: 'each_opponent' }] } }, form: false },
  // Modal spells are JSON/AI-authored (no guided-form modes editor) → JSON mode.
  { name: 'spell modal (Charm) → json', script: { schema_version: 2, spell_effect: { choose: 1, modes: [{ label: 'Gain 3 life', actions: [{ type: 'gain_life', amount: 3 }] }, { label: 'Destroy target creature', actions: [{ type: 'destroy', target_type: 'creature' }] }] } }, form: false },
  // target_ref (explicit targets[] wiring) isn't modeled → JSON.
  { name: 'spell destroy via target_ref', script: { schema_version: 2, spell_effect: { targets: [{ id: 't', type: 'creature' }], actions: [{ type: 'destroy', target_ref: 't' }] } }, form: false },
  // scry action with an extra field → JSON
  { name: 'spell scry +extra field', script: { schema_version: 2, spell_effect: { actions: [{ type: 'scry', amount: 1, foo: 1 }] } }, form: false },

  // Activated abilities — the form models bare tap/mana effects, but extra keys bail
  { name: 'activated deal_damage +timing', script: { schema_version: 2, activated_abilities: [{ costs: [{ type: 'tap_self' }], label: 'x', timing: 'instant', effects: [{ type: 'deal_damage', amount: 1, target_type: ['creature', 'player'] }], is_mana_ability: false }] }, form: false },
  { name: 'activated deal_damage bare', script: { schema_version: 2, activated_abilities: [{ costs: [{ type: 'tap_self' }], effects: [{ type: 'deal_damage', amount: 1, target_type: ['creature', 'player'] }] }] }, form: true },
  { name: 'activated mana', script: { schema_version: 2, activated_abilities: [{ is_mana_ability: true, costs: [{ type: 'tap_self' }], effects: [{ type: 'add_mana', color: 'G', amount: 1 }] }] }, form: true },
  { name: 'activated commander-identity mana (Command Tower)', script: { schema_version: 2, activated_abilities: [{ is_mana_ability: true, costs: [{ type: 'tap_self' }], effects: [{ type: 'add_mana', color: 'commander', amount: 1 }] }] }, form: true },

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

  // Spell create_token with tapped (Army of the Damned) — form-representable.
  { name: 'spell create_token tapped → form', script: { schema_version: 2, spell_effect: { actions: [{ type: 'create_token', count: 13, token: 'Zombie Token', tapped: true }] } }, form: true },
  // Flashback (top-level) round-trips through the form.
  { name: 'flashback spell → form', script: { schema_version: 2, flashback: '{7}{B}{B}{B}', spell_effect: { actions: [{ type: 'create_token', count: 13, token: 'Zombie Token', tapped: true }] } }, form: true },
  // A non-string flashback is not form-representable.
  { name: 'flashback non-string → json', script: { schema_version: 2, flashback: 7, spell_effect: { actions: [{ type: 'draw', amount: 1 }] } }, form: false },
  // Flashback with an extra "pay N life" cost (Deep Analysis) round-trips.
  { name: 'flashback + flashback_life → form', script: { schema_version: 2, flashback: '{1}{U}', flashback_life: 3, spell_effect: { actions: [{ type: 'choose_player', filter: 'any', effects: [{ type: 'draw', amount: 2 }] }] } }, form: true },
  // flashback_life must be a positive integer.
  { name: 'flashback_life zero → json', script: { schema_version: 2, flashback: '{1}{U}', flashback_life: 0, spell_effect: { actions: [{ type: 'draw', amount: 1 }] } }, form: false },
  { name: 'flashback_life non-integer → json', script: { schema_version: 2, flashback: '{1}{U}', flashback_life: 1.5, spell_effect: { actions: [{ type: 'draw', amount: 1 }] } }, form: false },
  // Cemetery Reaper: an activated ability with a graveyard-exile cost + create_token.
  { name: 'activated exile-from-graveyard + create_token → form', script: { schema_version: 2, activated_abilities: [{ costs: [{ type: 'mana', amount: '{2}{B}' }, { type: 'tap_self' }, { type: 'exile_from_graveyard', type_line: 'creature' }], effects: [{ type: 'create_token', token: 'Zombie Token', count: 1 }] }] }, form: true },
  // A non-creature graveyard-exile filter isn't form-representable (the checkbox is creature-only).
  { name: 'activated exile-from-graveyard non-creature filter → json', script: { schema_version: 2, activated_abilities: [{ costs: [{ type: 'tap_self' }, { type: 'exile_from_graveyard', type_line: 'land' }], effects: [{ type: 'draw', amount: 1 }] }] }, form: false },
  // An alternate flashback effect (do more/different from the graveyard) round-trips.
  { name: 'flashback_effect alternate program → form', script: { schema_version: 2, flashback: '{2}', spell_effect: { actions: [{ type: 'draw', amount: 1 }] }, flashback_effect: { actions: [{ type: 'draw', amount: 3 }] } }, form: true },

  // Static anthems / lords (pump on affected:'controller') — form-representable.
  { name: 'static other-Zombie lord → form', script: { continuous_effects: [{ type: 'pump', affected: 'controller', payload: { power: 1, toughness: 1, creature_type: 'Zombie', exclude_source: true } }] }, form: true },
  { name: 'static inclusive typed lord → form', script: { continuous_effects: [{ type: 'pump', affected: 'controller', payload: { power: 1, toughness: 1, creature_type: 'Zombie' } }] }, form: true },
  { name: 'static all-creatures anthem (no type) → form', script: { continuous_effects: [{ type: 'pump', affected: 'controller', payload: { power: 1, toughness: 1 } }] }, form: true },
  { name: 'static all-scope sliver lord → form', script: { continuous_effects: [{ type: 'pump', affected: 'all', payload: { power: 1, toughness: 1, creature_type: 'Sliver' } }] }, form: true },
  { name: 'static all-scope other-sliver lord → form', script: { continuous_effects: [{ type: 'pump', affected: 'all', payload: { power: 1, toughness: 1, creature_type: 'Sliver', exclude_source: true } }] }, form: true },
  { name: 'static lord + keyword together → form', script: { continuous_effects: [{ type: 'flying', affected: 'source', source_zone_required: 'battlefield' }, { type: 'pump', affected: 'controller', payload: { power: 1, toughness: 1, creature_type: 'Zombie', exclude_source: true } }] }, form: true },
  // Non-canonical anthems bail to JSON (the form would round-trip them differently).
  { name: 'static pump affected source (aura, not anthem) → json', script: { continuous_effects: [{ type: 'pump', affected: 'source', payload: { power: 1, toughness: 1 } }] }, form: false },
  { name: 'static pump empty creature_type → json', script: { continuous_effects: [{ type: 'pump', affected: 'controller', payload: { power: 1, toughness: 1, creature_type: '' } }] }, form: false },
  { name: 'static pump exclude_source false → json', script: { continuous_effects: [{ type: 'pump', affected: 'controller', payload: { power: 1, toughness: 1, exclude_source: false } }] }, form: false },
  { name: 'static pump extra payload key → json', script: { continuous_effects: [{ type: 'pump', affected: 'controller', payload: { power: 1, toughness: 1, foo: 1 } }] }, form: false },

  // Deep Analysis — "target player draws two" = choose_player(any) → draw, + flashback.
  { name: 'deep analysis choose_player draw + flashback → form', script: { schema_version: 2, flashback: '{1}{U}', spell_effect: { actions: [{ type: 'choose_player', filter: 'any', effects: [{ type: 'draw', amount: 2 }] }] } }, form: true },

  // Watcher triggers with a filter (Champion of the Perished) — now form-representable.
  { name: 'champion of the perished (watcher filter) → form', script: { schema_version: 2, triggered_abilities: [{ event: 'creature_entered', filter: { type_line: 'Zombie', controller: 'you', exclude_self: true }, effects: [{ type: 'add_counters', amount: 1 }] }] }, form: true },
  { name: 'watcher filter controller any → form', script: { schema_version: 2, triggered_abilities: [{ event: 'creature_died', filter: { controller: 'any' }, effects: [{ type: 'draw', amount: 1 }] }] }, form: true },
  { name: 'watcher filter type-only → form', script: { schema_version: 2, triggered_abilities: [{ event: 'creature_entered', filter: { type_line: 'Zombie', exclude_self: true }, effects: [{ type: 'add_counters', amount: 1 }] }] }, form: true },
  // Non-canonical filters bail to JSON.
  { name: 'watcher filter unknown key → json', script: { schema_version: 2, triggered_abilities: [{ event: 'creature_entered', filter: { foo: 1 }, effects: [{ type: 'add_counters', amount: 1 }] }] }, form: false },
  { name: 'watcher filter bad controller → json', script: { schema_version: 2, triggered_abilities: [{ event: 'creature_entered', filter: { controller: 'nobody' }, effects: [{ type: 'add_counters', amount: 1 }] }] }, form: false },

  // Crippling Fear: choose_creature_type wrapping a mass pump_all — now form-representable.
  { name: 'crippling fear (choose_creature_type + pump_all) → form', script: { schema_version: 2, spell_effect: { actions: [{ type: 'choose_creature_type', effects: [{ type: 'pump_all', power: -3, toughness: -3, scope: 'all', exclude_type: true }] }] } }, form: true },
  { name: 'fixed-type mass pump_all → form', script: { schema_version: 2, spell_effect: { actions: [{ type: 'pump_all', power: 1, toughness: 1, scope: 'controller', creature_type: 'Zombie' }] } }, form: true },

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
test('exact build: Army of the Damned (tapped tokens + flashback)', () => {
  const form = parseScriptToForm({ schema_version: 2, flashback: '{7}{B}{B}{B}', spell_effect: { actions: [{ type: 'create_token', count: 13, token: 'Zombie Token', tapped: true }] } })
  assert.deepEqual(buildScriptFromForm(form!), {
    schema_version: 2,
    spell_effect: { actions: [{ type: 'create_token', count: 13, token: 'Zombie Token', tapped: true }] },
    flashback: '{7}{B}{B}{B}',
  })
})

test('exact build: Cemetery Reaper (other-Zombie anthem)', () => {
  const form = parseScriptToForm({ continuous_effects: [{ type: 'pump', affected: 'controller', payload: { power: 1, toughness: 1, creature_type: 'Zombie', exclude_source: true } }] })
  assert.deepEqual(buildScriptFromForm(form!), {
    schema_version: 2,
    continuous_effects: [{ type: 'pump', affected: 'controller', payload: { power: 1, toughness: 1, creature_type: 'Zombie', exclude_source: true } }],
  })
})

test('exact build: sliver lord (all Slivers +1/+1, affected:all)', () => {
  const form = parseScriptToForm({ continuous_effects: [{ type: 'pump', affected: 'all', payload: { power: 1, toughness: 1, creature_type: 'Sliver' } }] })
  assert.deepEqual(buildScriptFromForm(form!), {
    schema_version: 2,
    continuous_effects: [{ type: 'pump', affected: 'all', payload: { power: 1, toughness: 1, creature_type: 'Sliver' } }],
  })
})

test('exact build: Deep Analysis (target player draws two + flashback, pay 3 life)', () => {
  const form = parseScriptToForm({ schema_version: 2, flashback: '{1}{U}', flashback_life: 3, spell_effect: { actions: [{ type: 'choose_player', filter: 'any', effects: [{ type: 'draw', amount: 2 }] }] } })
  assert.deepEqual(buildScriptFromForm(form!), {
    schema_version: 2,
    spell_effect: { actions: [{ type: 'choose_player', filter: 'any', effects: [{ type: 'draw', amount: 2 }] }] },
    flashback: '{1}{U}',
    flashback_life: 3,
  })
})

test('exact build: Cemetery Reaper ability (mana+tap+exile-from-graveyard → create_token)', () => {
  const form = parseScriptToForm({ schema_version: 2, activated_abilities: [{ costs: [{ type: 'mana', amount: '{2}{B}' }, { type: 'tap_self' }, { type: 'exile_from_graveyard', type_line: 'creature' }], effects: [{ type: 'create_token', token: 'Zombie Token', count: 1 }] }] })
  assert.deepEqual(buildScriptFromForm(form!), {
    schema_version: 2,
    activated_abilities: [{ costs: [{ type: 'tap_self' }, { type: 'exile_from_graveyard', type_line: 'creature' }, { type: 'mana', amount: '{2}{B}' }], effects: [{ type: 'create_token', token: 'Zombie Token', count: 1 }] }],
  })
})

test('exact build: flashback alternate effect (draw 1, draw 3 on flashback)', () => {
  const form = parseScriptToForm({ schema_version: 2, flashback: '{2}', spell_effect: { actions: [{ type: 'draw', amount: 1 }] }, flashback_effect: { actions: [{ type: 'draw', amount: 3 }] } })
  assert.deepEqual(buildScriptFromForm(form!), {
    schema_version: 2,
    spell_effect: { actions: [{ type: 'draw', amount: 1 }] },
    flashback: '{2}',
    flashback_effect: { actions: [{ type: 'draw', amount: 3 }] },
  })
})

test('exact build: Champion of the Perished (watcher filter, controller you omitted)', () => {
  const form = parseScriptToForm({ schema_version: 2, triggered_abilities: [{ event: 'creature_entered', filter: { type_line: 'Zombie', controller: 'you', exclude_self: true }, effects: [{ type: 'add_counters', amount: 1 }] }] })
  // 'you' is the engine default, so it's omitted from the canonical JSON.
  assert.deepEqual(buildScriptFromForm(form!), {
    schema_version: 2,
    triggered_abilities: [{ event: 'creature_entered', filter: { type_line: 'Zombie', exclude_self: true }, effects: [{ type: 'add_counters', amount: 1 }] }],
  })
})

test('exact build: watcher filter controller opponent', () => {
  const form = parseScriptToForm({ schema_version: 2, triggered_abilities: [{ event: 'creature_died', filter: { controller: 'opponent' }, effects: [{ type: 'draw', amount: 1 }] }] })
  assert.deepEqual(buildScriptFromForm(form!), {
    schema_version: 2,
    triggered_abilities: [{ event: 'creature_died', filter: { controller: 'opponent' }, effects: [{ type: 'draw', amount: 1 }] }],
  })
})

test('exact build: Crippling Fear (choose_creature_type → mass -3/-3 to non-chosen-type)', () => {
  const form = parseScriptToForm({ schema_version: 2, spell_effect: { actions: [{ type: 'choose_creature_type', effects: [{ type: 'pump_all', power: -3, toughness: -3, scope: 'all', exclude_type: true }] }] } })
  assert.deepEqual(buildScriptFromForm(form!), {
    schema_version: 2,
    spell_effect: { actions: [{ type: 'choose_creature_type', effects: [{ type: 'pump_all', power: -3, toughness: -3, scope: 'all', exclude_type: true }] }] },
  })
})

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

// Dual-shape: a single `type` (deal_damage / add_counters) has both an untargeted
// (recipient/self) form and a targeted form, resolved by the fields present.
test('exact build: Lightning Bolt (targeted deal_damage, any target) round-trips', () => {
  const form = parseScriptToForm({ schema_version: 2, spell_effect: { actions: [{ type: 'deal_damage', amount: 3, target_type: ['creature', 'player'] }] } })
  assert.deepEqual(buildScriptFromForm(form!), {
    schema_version: 2,
    spell_effect: { actions: [{ type: 'deal_damage', amount: 3, target_type: ['creature', 'player'] }] },
  })
})

test('exact build: targeted add_counters round-trips (not the on-self shape)', () => {
  const form = parseScriptToForm({ schema_version: 2, spell_effect: { actions: [{ type: 'add_counters', amount: 2, target_type: 'creature', target_controller: 'opponent' }] } })
  assert.deepEqual(buildScriptFromForm(form!), {
    schema_version: 2,
    spell_effect: { actions: [{ type: 'add_counters', amount: 2, target_type: 'creature', target_controller: 'opponent' }] },
  })
})

test('dual-shape defaults: the targeted variants build their target field', () => {
  assert.deepEqual(defaultEffect('deal_damage_target'), { type: 'deal_damage', amount: 1, target: 'any' })
  assert.deepEqual(defaultEffect('add_counters_target'), { type: 'add_counters', amount: 1, target: 'creature_any' })
  // The bare type still yields the untargeted (recipient / on-self) shape.
  assert.deepEqual(defaultEffect('deal_damage'), { type: 'deal_damage', amount: 1, recipient: 'each_opponent' })
  assert.deepEqual(defaultEffect('add_counters'), { type: 'add_counters', amount: 1 })
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
  assert.deepEqual(defaultEffect('gain_control'), { type: 'gain_control', duration: 'permanent', target: 'creature_any' })
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
  // The generic 'effect' kind defaults to a targeted deal_damage (the old 'damage' kind).
  assert.deepEqual(defaultActivatedAbility('effect'), { kind: 'effect', tapSelf: true, sacSelf: false, exileFromGraveyard: false, mana: '', effect: { type: 'deal_damage', amount: 1, target: 'any' } })
})

// An activated ability of a non-damage effect (a new capability) is Form-representable.
test('activated destroy ability round-trips through the form', () => {
  const form = parseScriptToForm({ schema_version: 2, activated_abilities: [{ costs: [{ type: 'tap_self' }], effects: [{ type: 'destroy', target_type: 'creature' }] }] })
  assert.notEqual(form, null)
  assert.deepEqual(buildScriptFromForm(form!), {
    schema_version: 2,
    activated_abilities: [{ costs: [{ type: 'tap_self' }], effects: [{ type: 'destroy', target_type: 'creature' }] }],
  })
})

test('activated draw ability ({2}: draw) round-trips through the form', () => {
  const form = parseScriptToForm({ schema_version: 2, activated_abilities: [{ costs: [{ type: 'mana', amount: '{2}' }], effects: [{ type: 'draw', amount: 1 }] }] })
  assert.notEqual(form, null)
  assert.deepEqual(buildScriptFromForm(form!), {
    schema_version: 2,
    activated_abilities: [{ costs: [{ type: 'mana', amount: '{2}' }], effects: [{ type: 'draw', amount: 1 }] }],
  })
})

test('defaultTrigger shape', () => {
  assert.deepEqual(defaultTrigger(), { event: 'enters_the_battlefield', filter: { typeLine: '', controller: 'you', excludeSelf: false }, effects: [{ type: 'gain_life', amount: 1 }] })
})
