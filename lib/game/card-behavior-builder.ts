// Guided card-behavior form model: a structured representation of the subset of
// V2 card scripts the form editor can build, plus conversions to/from the raw
// script JSON. Scripts using features the form does not model round-trip to
// `null` from `parseScriptToForm`, signalling the editor to stay in JSON mode.

import type { CardScript, ManaColor } from './types'

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

export const BUILDER_RECIPIENTS = [
  { value: 'each_opponent', label: 'each opponent' },
  { value: 'controller', label: 'you' },
] as const
export type BuilderRecipient = (typeof BUILDER_RECIPIENTS)[number]['value']

// Token names available to the create_token effect (matches the seeded catalog).
export const BUILDER_TOKEN_NAMES = [
  'Soldier Token',
  'Saproling Token',
  'Zombie Token',
  'Goblin Token',
  'Beast Token',
  'Spirit Token',
] as const
export type BuilderTokenName = (typeof BUILDER_TOKEN_NAMES)[number]

// Auto-resolved effect types apply_triggered_ability_effects applies for triggers.
export type BuilderEffect =
  | { type: 'gain_life'; amount: number }
  | { type: 'lose_life'; amount: number; recipient: BuilderRecipient }
  | { type: 'deal_damage'; amount: number; recipient: BuilderRecipient }
  | { type: 'draw'; amount: number }
  | { type: 'create_token'; token: string; count: number }
  | { type: 'add_counters'; amount: number }
  | { type: 'scry'; amount: number }
  | { type: 'surveil'; amount: number }

export const BUILDER_EFFECT_TYPES = [
  { value: 'gain_life', label: 'You gain life' },
  { value: 'lose_life', label: 'Players lose life' },
  { value: 'deal_damage', label: 'Deal damage to players' },
  { value: 'draw', label: 'You draw cards' },
  { value: 'create_token', label: 'Create token(s)' },
  { value: 'add_counters', label: '+1/+1 counters on this' },
  { value: 'scry', label: 'Scry N' },
  { value: 'surveil', label: 'Surveil N' },
] as const
export type BuilderEffectType = (typeof BUILDER_EFFECT_TYPES)[number]['value']

export type BuilderTrigger = {
  event: BuilderTriggerEvent
  effects: BuilderEffect[]
}

// ─── Spell effect (instant / sorcery) ───────────────────────────────────────────
//
// The form currently models the untargeted self-library spell effects (scry /
// surveil). A spell using anything else (targeted destroy/exile, damage, …)
// round-trips to null so the editor stays in JSON mode.

export type BuilderSpellEffectType = 'scry' | 'surveil' | 'draw'
export type BuilderSpellEffect = { type: BuilderSpellEffectType; amount: number }

export const BUILDER_SPELL_EFFECT_TYPES = [
  { value: 'scry', label: 'Scry N' },
  { value: 'surveil', label: 'Surveil N' },
  { value: 'draw', label: 'Draw N' },
] as const

export function defaultSpellEffect(type: BuilderSpellEffectType): BuilderSpellEffect {
  return { type, amount: 1 }
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
  { value: 'damage', label: 'Deal damage' },
] as const
export type BuilderAbilityKind = (typeof BUILDER_ABILITY_KINDS)[number]['value']

export type BuilderActivatedAbility =
  | { kind: 'mana'; tapSelf: boolean; color: ManaColor; amount: number }
  | { kind: 'damage'; tapSelf: boolean; mana: string; amount: number; target: BuilderDamageTarget }

export function defaultActivatedAbility(kind: BuilderAbilityKind): BuilderActivatedAbility {
  if (kind === 'mana') {
    return { kind: 'mana', tapSelf: true, color: 'C', amount: 1 }
  }
  return { kind: 'damage', tapSelf: true, mana: '', amount: 1, target: 'any' }
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

export function defaultEffect(type: BuilderEffectType): BuilderEffect {
  switch (type) {
    case 'gain_life':
      return { type: 'gain_life', amount: 1 }
    case 'lose_life':
      return { type: 'lose_life', amount: 1, recipient: 'each_opponent' }
    case 'deal_damage':
      return { type: 'deal_damage', amount: 1, recipient: 'each_opponent' }
    case 'draw':
      return { type: 'draw', amount: 1 }
    case 'create_token':
      return { type: 'create_token', token: BUILDER_TOKEN_NAMES[0], count: 1 }
    case 'add_counters':
      return { type: 'add_counters', amount: 1 }
    case 'scry':
      return { type: 'scry', amount: 1 }
    case 'surveil':
      return { type: 'surveil', amount: 1 }
  }
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

  const spellEffectActions = form.spellEffect.map((a) => ({ type: a.type, amount: a.amount }))

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

  const targetType =
    ability.target === 'any' ? ['creature', 'player'] : ability.target

  return {
    costs,
    effects: [{ type: 'deal_damage', amount: ability.amount, target_type: targetType }],
  }
}

function effectToJson(effect: BuilderEffect): Record<string, unknown> {
  switch (effect.type) {
    case 'gain_life':
      return { type: 'gain_life', amount: effect.amount }
    case 'draw':
      return { type: 'draw', amount: effect.amount }
    case 'lose_life':
    case 'deal_damage':
      return { type: effect.type, amount: effect.amount, recipient: effect.recipient }
    case 'create_token':
      return { type: 'create_token', token: effect.token, count: effect.count }
    case 'add_counters':
      return { type: 'add_counters', amount: effect.amount }
    case 'scry':
    case 'surveil':
      return { type: effect.type, amount: effect.amount }
  }
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
    if (typeof entry !== 'object' || entry === null) {
      return null
    }
    const a = entry as Record<string, unknown>
    if (Object.keys(a).some((key) => key !== 'type' && key !== 'amount')) {
      return null
    }
    if (
      (a.type === 'scry' || a.type === 'surveil' || a.type === 'draw') &&
      typeof a.amount === 'number'
    ) {
      result.push({ type: a.type, amount: a.amount })
    } else {
      return null
    }
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
      if (effect?.type !== 'deal_damage' || effect.target_ref !== undefined) {
        return null
      }
      const target = parseDamageTarget(effect.target_type)
      if (target === null) {
        return null
      }
      abilities.push({
        kind: 'damage',
        tapSelf,
        mana,
        amount: typeof effect.amount === 'number' ? effect.amount : 1,
        target,
      })
    }
  }
  return abilities
}

function parseDamageTarget(value: unknown): BuilderDamageTarget | null {
  if (value === 'creature' || value === 'player') {
    return value
  }
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    value.includes('creature') &&
    value.includes('player')
  ) {
    return 'any'
  }
  return null
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
    if (typeof entry !== 'object' || entry === null) {
      return null
    }
    const e = entry as Record<string, unknown>
    const type = e.type as string | undefined
    const amount = typeof e.amount === 'number' ? e.amount : 0
    const recipient = e.recipient === 'controller' ? 'controller' : 'each_opponent'

    if (type === 'gain_life') {
      effects.push({ type: 'gain_life', amount })
    } else if (type === 'draw') {
      effects.push({ type: 'draw', amount })
    } else if (type === 'lose_life') {
      effects.push({ type: 'lose_life', amount, recipient })
    } else if (type === 'deal_damage') {
      // Only the recipient form (no chosen target) is representable in the form.
      if (e.target_type !== undefined || e.target_ref !== undefined) {
        return null
      }
      effects.push({ type: 'deal_damage', amount, recipient })
    } else if (type === 'create_token') {
      if (typeof e.token !== 'string') {
        return null
      }
      effects.push({
        type: 'create_token',
        token: e.token,
        count: typeof e.count === 'number' ? e.count : 1,
      })
    } else if (type === 'add_counters') {
      if (e.target_type !== undefined || e.target_ref !== undefined) {
        return null
      }
      effects.push({ type: 'add_counters', amount })
    } else if (type === 'scry') {
      effects.push({ type: 'scry', amount })
    } else if (type === 'surveil') {
      effects.push({ type: 'surveil', amount })
    } else {
      return null
    }
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
