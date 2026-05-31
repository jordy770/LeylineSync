// Guided card-behavior form model: a structured representation of the subset of
// V2 card scripts the form editor can build, plus conversions to/from the raw
// script JSON. Scripts using features the form does not model round-trip to
// `null` from `parseScriptToForm`, signalling the editor to stay in JSON mode.

import type { CardScript } from './types'

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
  { value: 'beginning_of_upkeep', label: 'At the beginning of your upkeep' },
  { value: 'dies', label: 'When it dies' },
  { value: 'attacks', label: 'When it attacks' },
] as const
export type BuilderTriggerEvent = (typeof BUILDER_TRIGGER_EVENTS)[number]['value']

export const BUILDER_RECIPIENTS = [
  { value: 'each_opponent', label: 'each opponent' },
  { value: 'controller', label: 'you' },
] as const
export type BuilderRecipient = (typeof BUILDER_RECIPIENTS)[number]['value']

// Auto-resolved effect types resolve_top_of_stack applies for triggered abilities.
export type BuilderEffect =
  | { type: 'gain_life'; amount: number }
  | { type: 'lose_life'; amount: number; recipient: BuilderRecipient }
  | { type: 'deal_damage'; amount: number; recipient: BuilderRecipient }
  | { type: 'draw'; amount: number }

export const BUILDER_EFFECT_TYPES = [
  { value: 'gain_life', label: 'You gain life' },
  { value: 'lose_life', label: 'Players lose life' },
  { value: 'deal_damage', label: 'Deal damage to players' },
  { value: 'draw', label: 'You draw cards' },
] as const
export type BuilderEffectType = (typeof BUILDER_EFFECT_TYPES)[number]['value']

export type BuilderTrigger = {
  event: BuilderTriggerEvent
  effects: BuilderEffect[]
}

export type BuilderForm = {
  keywords: BuilderKeyword[]
  triggers: BuilderTrigger[]
}

export const EMPTY_BUILDER_FORM: BuilderForm = { keywords: [], triggers: [] }

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

  // Nothing authored → no script (clears behavior).
  if (continuousEffects.length === 0 && triggeredAbilities.length === 0) {
    return null
  }

  const script: Record<string, unknown> = { schema_version: 2 }
  if (continuousEffects.length > 0) {
    script.continuous_effects = continuousEffects
  }
  if (triggeredAbilities.length > 0) {
    script.triggered_abilities = triggeredAbilities
  }

  return script as CardScript
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
  const knownKeys = new Set(['schema_version', 'continuous_effects', 'triggered_abilities'])
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

  return { keywords, triggers }
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
