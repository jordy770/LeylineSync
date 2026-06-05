// Guided card-behavior form model: a structured representation of the subset of
// V2 card scripts the form editor can build, plus conversions to/from the raw
// script JSON. Scripts using features the form does not model round-trip to
// `null` from `parseScriptToForm`, signalling the editor to stay in JSON mode.

import type { CardScript, ManaColor } from './types'
import {
  EFFECT_RECIPIENTS,
  EFFECT_TOKEN_NAMES,
  effectDefault,
  effectFromJson,
  effectToJson as registryEffectToJson,
  effectsForContext,
  type RegistryEffect,
} from './card-behavior-registry'

// ─── Vocabulary ──────────────────────────────────────────────────────────────

// Keyword continuous effects the runtime registers (register_keyword_continuous_effects).
export const BUILDER_KEYWORDS = [
  'flying',
  'reach',
  'haste',
  'vigilance',
  'trample',
  'indestructible',
  'first_strike',
  'double_strike',
  'deathtouch',
] as const
export type BuilderKeyword = (typeof BUILDER_KEYWORDS)[number]

// Trigger events wired in migrations 076–077.
export const BUILDER_TRIGGER_EVENTS = [
  { value: 'enters_the_battlefield', label: 'When it enters the battlefield' },
  { value: 'leaves_the_battlefield', label: 'When it leaves the battlefield' },
  { value: 'dies', label: 'When it dies' },
  { value: 'attacks', label: 'When it attacks' },
  { value: 'blocks', label: 'When it blocks' },
  { value: 'becomes_targeted', label: 'When it becomes the target of a spell or ability' },
  { value: 'beginning_of_upkeep', label: 'At the beginning of your upkeep' },
  { value: 'beginning_of_draw_step', label: 'At the beginning of your draw step' },
  { value: 'beginning_of_end_step', label: 'At the beginning of your end step' },
] as const
export type BuilderTriggerEvent = (typeof BUILDER_TRIGGER_EVENTS)[number]['value']

// Recipient / token vocab now lives in the effect registry (single source of
// truth); re-exported here so existing form/guide imports keep working.
export const BUILDER_RECIPIENTS = EFFECT_RECIPIENTS
export type BuilderRecipient = (typeof BUILDER_RECIPIENTS)[number]['value']

// Token names available to the create_token effect (matches the seeded catalog).
export const BUILDER_TOKEN_NAMES = EFFECT_TOKEN_NAMES
export type BuilderTokenName = (typeof BUILDER_TOKEN_NAMES)[number]

// Auto-resolved effect types apply_triggered_ability_effects applies for triggers.
export type BuilderEffect =
  | { type: 'gain_life'; amount: number; recipient?: BuilderRecipient }
  | { type: 'lose_life'; amount: number; recipient: BuilderRecipient }
  | { type: 'deal_damage'; amount: number; recipient: BuilderRecipient }
  | { type: 'draw'; amount: number }
  | { type: 'create_token'; token: string; count: number }
  | { type: 'add_counters'; amount: number }
  | { type: 'add_counters_all'; amount: number; target_controller: string }
  | { type: 'tap_all'; target_controller: string }
  | { type: 'untap_all'; target_controller: string }
  | { type: 'scry'; amount: number }
  | { type: 'surveil'; amount: number }
  | { type: 'mill'; amount: number; recipient: BuilderRecipient }
  | { type: 'search_library'; count: number; to: string; filter: { type_line: string } }
  | { type: 'discard'; count: number }
  | { type: 'may'; prompt: string; effects: BuilderEffect[] }
  | { type: 'choose_player'; filter: string; effects: BuilderEffect[] }
  | { type: 'destroy'; target: string }
  | { type: 'exile'; target: string }
  | { type: 'bounce'; target: string }
  | { type: 'tap'; target: string }
  | { type: 'untap'; target: string }
  | { type: 'pump'; power: number; toughness: number; target: string }
  | { type: 'grant_keyword'; keyword: string; target: string }
  | { type: 'fight'; target: string }
  | { type: 'gain_control'; duration: string; target: string }

// Trigger-context effect options, derived from the registry.
export const BUILDER_EFFECT_TYPES = effectsForContext('trigger')
export type BuilderEffectType = BuilderEffect['type']

export type BuilderTrigger = {
  event: BuilderTriggerEvent
  effects: BuilderEffect[]
}

// ─── Spell effect (instant / sorcery) ───────────────────────────────────────────
//
// The form currently models the untargeted self-library spell effects (scry /
// surveil). A spell using anything else (targeted destroy/exile, damage, …)
// round-trips to null so the editor stays in JSON mode.

export type BuilderSpellEffect =
  | { type: 'gain_life'; amount: number; recipient?: BuilderRecipient }
  | { type: 'lose_life'; amount: number; recipient: BuilderRecipient }
  | { type: 'scry'; amount: number }
  | { type: 'surveil'; amount: number }
  | { type: 'draw'; amount: number }
  | { type: 'mill'; amount: number; recipient: BuilderRecipient }
  | { type: 'add_counters_all'; amount: number; target_controller: string }
  | { type: 'tap_all'; target_controller: string }
  | { type: 'untap_all'; target_controller: string }
  | { type: 'search_library'; count: number; to: string; filter: { type_line: string } }
  | { type: 'discard'; count: number }
  | { type: 'may'; prompt: string; effects: BuilderEffect[] }
  | { type: 'choose_player'; filter: string; effects: BuilderEffect[] }
  | { type: 'destroy'; target: string }
  | { type: 'exile'; target: string }
  | { type: 'bounce'; target: string }
  | { type: 'tap'; target: string }
  | { type: 'untap'; target: string }
  | { type: 'pump'; power: number; toughness: number; target: string }
  | { type: 'grant_keyword'; keyword: string; target: string }
  | { type: 'fight'; target: string }
  | { type: 'gain_control'; duration: string; target: string }
export type BuilderSpellEffectType = BuilderSpellEffect['type']

// Spell-context effect options, derived from the registry.
export const BUILDER_SPELL_EFFECT_TYPES = effectsForContext('spell')

// `key` is a form-list value: a bare type or a variant key (e.g. 'deal_damage_target').
export function defaultSpellEffect(key: BuilderSpellEffectType | string): BuilderSpellEffect {
  return effectDefault(key) as BuilderSpellEffect
}

// ─── Activated abilities ───────────────────────────────────────────────────────
//
// Two runtime-supported shapes:
//   * mana    — a mana ability (is_mana_ability) that taps for one color. The V4
//               controller executes it via tap-for-mana, not the stack.
//   * damage  — a {tap}/{mana} cost that deals damage to a chosen target via
//               activate_ability and the stack.

export const BUILDER_MANA_COLORS: { value: ManaColor; label: string }[] = [
  { value: 'W', label: 'White {W}' },
  { value: 'U', label: 'Blue {U}' },
  { value: 'B', label: 'Black {B}' },
  { value: 'R', label: 'Red {R}' },
  { value: 'G', label: 'Green {G}' },
  { value: 'C', label: 'Colorless {C}' },
]

export const BUILDER_DAMAGE_TARGETS = [
  { value: 'any', label: 'any target' },
  { value: 'creature', label: 'target creature' },
  { value: 'player', label: 'target player' },
] as const
export type BuilderDamageTarget = (typeof BUILDER_DAMAGE_TARGETS)[number]['value']

export const BUILDER_ABILITY_KINDS = [
  { value: 'mana', label: 'Tap for mana' },
  { value: 'effect', label: 'Effect' },
] as const
export type BuilderAbilityKind = (typeof BUILDER_ABILITY_KINDS)[number]['value']

// `effect` is the generic "{cost}: <effect>" ability — the effect is any registry
// effect (deal_damage / destroy / draw / pump / …), edited via the shared effect
// editor. (Replaces the old bespoke `damage` kind; deal_damage is now just an effect.)
export type BuilderActivatedAbility =
  | { kind: 'mana'; tapSelf: boolean; color: ManaColor; amount: number }
  | { kind: 'effect'; tapSelf: boolean; mana: string; effect: RegistryEffect }

export function defaultActivatedAbility(kind: BuilderAbilityKind): BuilderActivatedAbility {
  if (kind === 'mana') {
    return { kind: 'mana', tapSelf: true, color: 'C', amount: 1 }
  }
  return { kind: 'effect', tapSelf: true, mana: '', effect: effectDefault('deal_damage_target') }
}

export type BuilderForm = {
  keywords: BuilderKeyword[]
  triggers: BuilderTrigger[]
  activatedAbilities: BuilderActivatedAbility[]
  // An ordered list of untargeted spell actions (instant/sorcery resolution),
  // e.g. Opt = [scry 1, draw 1]. Empty = no spell effect.
  spellEffect: BuilderSpellEffect[]
}

export const EMPTY_BUILDER_FORM: BuilderForm = {
  keywords: [],
  triggers: [],
  activatedAbilities: [],
  spellEffect: [],
}

// ─── Defaults / factories ──────────────────────────────────────────────────────

// `key` is a form-list value: a bare type or a variant key (e.g. 'add_counters_target').
export function defaultEffect(key: BuilderEffectType | string): BuilderEffect {
  return effectDefault(key) as BuilderEffect
}

export function defaultTrigger(): BuilderTrigger {
  return { event: 'enters_the_battlefield', effects: [defaultEffect('gain_life')] }
}

// ─── Form → script JSON ────────────────────────────────────────────────────────

export function buildScriptFromForm(form: BuilderForm): CardScript | null {
  const continuousEffects = form.keywords.map((keyword) => ({
    type: keyword,
    affected: 'source',
    source_zone_required: 'battlefield',
  }))

  const triggeredAbilities = form.triggers.map((trigger) => ({
    event: trigger.event,
    effects: trigger.effects.map(effectToJson),
  }))

  const activatedAbilities = form.activatedAbilities.map(activatedAbilityToJson)

  // Serialize spell actions through the registry so multi-field effects
  // (e.g. search_library's count/to/filter) keep all their data, not just amount.
  const spellEffectActions = form.spellEffect.map((a) => registryEffectToJson(a))

  // Nothing authored → no script (clears behavior).
  if (
    continuousEffects.length === 0 &&
    triggeredAbilities.length === 0 &&
    activatedAbilities.length === 0 &&
    spellEffectActions.length === 0
  ) {
    return null
  }

  const script: Record<string, unknown> = { schema_version: 2 }
  if (continuousEffects.length > 0) {
    script.continuous_effects = continuousEffects
  }
  if (triggeredAbilities.length > 0) {
    script.triggered_abilities = triggeredAbilities
  }
  if (activatedAbilities.length > 0) {
    script.activated_abilities = activatedAbilities
  }
  if (spellEffectActions.length > 0) {
    script.spell_effect = { actions: spellEffectActions }
  }

  return script as CardScript
}

function activatedAbilityToJson(ability: BuilderActivatedAbility): Record<string, unknown> {
  if (ability.kind === 'mana') {
    return {
      is_mana_ability: true,
      costs: ability.tapSelf ? [{ type: 'tap_self' }] : [],
      effects: [{ type: 'add_mana', color: ability.color, amount: ability.amount }],
    }
  }

  const costs: Record<string, unknown>[] = []
  if (ability.tapSelf) {
    costs.push({ type: 'tap_self' })
  }
  if (ability.mana.trim()) {
    costs.push({ type: 'mana', amount: ability.mana.trim() })
  }

  return {
    costs,
    effects: [registryEffectToJson(ability.effect)],
  }
}

function effectToJson(effect: BuilderEffect): Record<string, unknown> {
  return registryEffectToJson(effect)
}

// ─── Script JSON → form (best-effort) ──────────────────────────────────────────

// Returns null when the script uses anything the form cannot represent, so the
// editor can keep the user in raw-JSON mode rather than silently dropping data.
export function parseScriptToForm(script: unknown): BuilderForm | null {
  if (script == null) {
    return EMPTY_BUILDER_FORM
  }
  if (typeof script !== 'object') {
    return null
  }

  const s = script as Record<string, unknown>
  const knownKeys = new Set([
    'schema_version',
    'continuous_effects',
    'triggered_abilities',
    'activated_abilities',
    'spell_effect',
  ])
  if (Object.keys(s).some((key) => !knownKeys.has(key))) {
    return null
  }

  const keywords = parseKeywords(s.continuous_effects)
  if (keywords === null) {
    return null
  }

  const triggers = parseTriggers(s.triggered_abilities)
  if (triggers === null) {
    return null
  }

  const activatedAbilities = parseActivatedAbilities(s.activated_abilities)
  if (activatedAbilities === null) {
    return null
  }

  // A spell_effect the form can't represent (any action that isn't a plain
  // scry/surveil/draw) bails to JSON mode.
  let spellEffect: BuilderSpellEffect[] = []
  if (s.spell_effect !== undefined) {
    const parsed = parseSpellEffect(s.spell_effect)
    if (parsed === null) {
      return null
    }
    spellEffect = parsed
  }

  return { keywords, triggers, activatedAbilities, spellEffect }
}

// Returns the form model for a spell_effect built from plain scry/surveil/draw
// actions, or null for anything the form cannot represent (so the editor stays in
// JSON mode — e.g. targeted destroy/exile, recipient draws, unknown fields).
function parseSpellEffect(value: unknown): BuilderSpellEffect[] | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const e = value as Record<string, unknown>
  if (Object.keys(e).some((key) => key !== 'actions')) {
    return null
  }
  if (!Array.isArray(e.actions)) {
    return null
  }

  const result: BuilderSpellEffect[] = []
  for (const entry of e.actions) {
    const parsed = effectFromJson(entry, 'spell')
    if (parsed === null) {
      return null
    }
    result.push(parsed as BuilderSpellEffect)
  }
  return result
}

function parseActivatedAbilities(value: unknown): BuilderActivatedAbility[] | null {
  if (value == null) {
    return []
  }
  if (!Array.isArray(value)) {
    return null
  }

  const abilities: BuilderActivatedAbility[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      return null
    }
    const e = entry as Record<string, unknown>

    // Only event-free, default-zone abilities are form-representable. id/label are
    // cosmetic and dropped; anything else (timing, source_zone_required, ...) → JSON.
    if (
      Object.keys(e).some(
        (key) => !['id', 'label', 'costs', 'effects', 'is_mana_ability'].includes(key),
      )
    ) {
      return null
    }

    const costs = Array.isArray(e.costs) ? (e.costs as Record<string, unknown>[]) : []
    const effects = Array.isArray(e.effects) ? (e.effects as Record<string, unknown>[]) : []

    // Costs must only be tap_self and/or a mana string.
    let tapSelf = false
    let mana = ''
    for (const cost of costs) {
      if (cost?.type === 'tap_self') {
        tapSelf = true
      } else if (cost?.type === 'mana' && typeof cost.amount === 'string') {
        mana = cost.amount
      } else {
        return null
      }
    }

    if (effects.length !== 1) {
      return null
    }
    const effect = effects[0]

    if (e.is_mana_ability === true) {
      if (effect?.type !== 'add_mana' || mana) {
        return null
      }
      const color = effect.color
      if (typeof color !== 'string' || !['W', 'U', 'B', 'R', 'G', 'C'].includes(color)) {
        return null
      }
      abilities.push({
        kind: 'mana',
        tapSelf,
        color: color as ManaColor,
        amount: typeof effect.amount === 'number' ? effect.amount : 1,
      })
    } else {
      // Generic "{cost}: <effect>" — the single effect must be a registry effect
      // the form can represent (parsed in spell context, where the targeted
      // creature effects + draw live). Otherwise the whole script stays in JSON mode.
      const parsed = effectFromJson(effect, 'spell')
      if (parsed === null) {
        return null
      }
      abilities.push({ kind: 'effect', tapSelf, mana, effect: parsed })
    }
  }
  return abilities
}

function parseKeywords(value: unknown): BuilderKeyword[] | null {
  if (value == null) {
    return []
  }
  if (!Array.isArray(value)) {
    return null
  }

  const keywords: BuilderKeyword[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      return null
    }
    const e = entry as Record<string, unknown>
    const type = (e.type ?? e.effect_type) as string | undefined
    // Only plain keyword effects on the source permanent are form-representable.
    if (
      !type ||
      !(BUILDER_KEYWORDS as readonly string[]).includes(type) ||
      (e.affected !== undefined && e.affected !== 'source') ||
      (e.source_zone_required !== undefined && e.source_zone_required !== 'battlefield') ||
      Object.keys(e).some((key) => !['type', 'effect_type', 'affected', 'source_zone_required'].includes(key))
    ) {
      return null
    }
    keywords.push(type as BuilderKeyword)
  }
  return keywords
}

function parseTriggers(value: unknown): BuilderTrigger[] | null {
  if (value == null) {
    return []
  }
  if (!Array.isArray(value)) {
    return null
  }

  const triggers: BuilderTrigger[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      return null
    }
    const e = entry as Record<string, unknown>
    const event = e.event as string | undefined
    if (!event || !(BUILDER_TRIGGER_EVENTS.map((t) => t.value) as string[]).includes(event)) {
      return null
    }
    // Reject anything beyond event + effects (e.g. targets, conditions).
    if (Object.keys(e).some((key) => key !== 'event' && key !== 'effects' && key !== 'id')) {
      return null
    }

    const effects = parseEffects(e.effects)
    if (effects === null) {
      return null
    }

    triggers.push({ event: event as BuilderTriggerEvent, effects })
  }
  return triggers
}

function parseEffects(value: unknown): BuilderEffect[] | null {
  if (!Array.isArray(value)) {
    return null
  }

  const effects: BuilderEffect[] = []
  for (const entry of value) {
    const parsed = effectFromJson(entry, 'trigger')
    if (parsed === null) {
      return null
    }
    effects.push(parsed as BuilderEffect)
  }
  return effects
}

export const KEYWORD_LABELS: Record<BuilderKeyword, string> = {
  flying: 'Flying',
  reach: 'Reach',
  haste: 'Haste',
  vigilance: 'Vigilance',
  trample: 'Trample',
  indestructible: 'Indestructible',
  first_strike: 'First strike',
  double_strike: 'Double strike',
  deathtouch: 'Deathtouch',
}
